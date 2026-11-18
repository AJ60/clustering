use crate::hw_probe::log_event;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct AdbForward {
    pub serial: String,
    pub local_probe_port: u16,
    pub local_rpc_port: u16,
}

#[derive(Debug, Clone)]
pub struct AdbDiscoveredSpoke {
    pub serial: String,
    pub probe_endpoint: String,
    pub rpc_endpoint: String,
}

pub fn deterministic_adb_ports(index: usize, base_rpc_port: u16, base_probe_port: u16) -> (u16, u16) {
    (
        base_probe_port.saturating_add(index as u16),
        base_rpc_port.saturating_add(index as u16),
    )
}

pub struct AdbTunnelManager {
    node_id: String,
    forwards: Vec<AdbForward>,
}

impl AdbTunnelManager {
    pub fn new(node_id: &str) -> Self {
        Self {
            node_id: node_id.to_string(),
            forwards: Vec::new(),
        }
    }

    pub fn active_serials(&self) -> Vec<String> {
        self.forwards.iter().map(|f| f.serial.clone()).collect()
    }

    /// Queries `adb devices`, assigns deterministic dual local ports:
    /// - probe port: (51051 + i) -> remote tcp:50051 (32-byte GGUF handshake + JSON telemetry + RTT probe)
    /// - rpc port:   (base_rpc_port + i) -> remote tcp:50052 (stock llama.cpp rpc-server -c)
    pub fn setup_usb_forwards(&mut self, base_rpc_port: u16) -> Vec<AdbDiscoveredSpoke> {
        self.cleanup();
        let mut discovered = Vec::new();
        let base_probe_port = base_rpc_port.saturating_add(999); // 50052 + 999 = 51051

        let serials = Self::poll_attached_serials();
        for (i, serial) in serials.into_iter().enumerate() {
            let (local_probe_port, local_rpc_port) =
                deterministic_adb_ports(i, base_rpc_port, base_probe_port);

            let probe_local = format!("tcp:{local_probe_port}");
            let rpc_local = format!("tcp:{local_rpc_port}");

            let rpc_ok = Command::new("adb")
                .args(["-s", &serial, "forward", &rpc_local, "tcp:50052"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

            let probe_ok = Command::new("adb")
                .args(["-s", &serial, "forward", &probe_local, "tcp:50051"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

            if rpc_ok && probe_ok {
                let probe_endpoint = format!("127.0.0.1:{local_probe_port}");
                let rpc_endpoint = format!("127.0.0.1:{local_rpc_port}");
                log_event(
                    "INFO",
                    &self.node_id,
                    "ADB",
                    "FORWARD_OK",
                    "Mapped USB Android spoke dual-port tunnels via adb forward",
                    &format!("serial={serial} probe={probe_local}->50051 rpc={rpc_local}->50052"),
                );
                self.forwards.push(AdbForward {
                    serial: serial.clone(),
                    local_probe_port,
                    local_rpc_port,
                });
                discovered.push(AdbDiscoveredSpoke {
                    serial,
                    probe_endpoint,
                    rpc_endpoint,
                });
            } else {
                let _ = Command::new("adb")
                    .args(["-s", &serial, "forward", "--remove", &rpc_local])
                    .status();
                let _ = Command::new("adb")
                    .args(["-s", &serial, "forward", "--remove", &probe_local])
                    .status();
                log_event(
                    "WARNING",
                    &self.node_id,
                    "ADB",
                    "FORWARD_FAIL",
                    "Failed dual-port adb forward for USB device",
                    &format!("serial={serial} probe_ok={probe_ok} rpc_ok={rpc_ok}"),
                );
            }
        }

        discovered
    }

    pub fn poll_attached_serials() -> Vec<String> {
        let Ok(out) = Command::new("adb").arg("devices").output() else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut serials = Vec::new();
        for line in stdout.lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 && parts[1] == "device" {
                serials.push(parts[0].to_string());
            }
        }
        serials.sort();
        serials
    }

    /// Background watcher polling `adb devices` every 3s for hot-plugged Android phones.
    pub fn spawn_usb_watcher<F>(
        node_id: String,
        base_rpc_port: u16,
        running: Arc<AtomicBool>,
        mut on_change: F,
    ) where
        F: FnMut(Vec<AdbDiscoveredSpoke>) + Send + 'static,
    {
        thread::spawn(move || {
            let mut mgr = AdbTunnelManager::new(&node_id);
            let mut last_serials = mgr.active_serials();
            while running.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(3));
                let cur_serials = Self::poll_attached_serials();
                if cur_serials != last_serials {
                    let endpoints = mgr.setup_usb_forwards(base_rpc_port);
                    last_serials = cur_serials;
                    on_change(endpoints);
                }
            }
        });
    }

    pub fn cleanup(&mut self) {
        for fwd in self.forwards.drain(..) {
            for port in [fwd.local_probe_port, fwd.local_rpc_port] {
                let local_spec = format!("tcp:{port}");
                let _ = Command::new("adb")
                    .args(["-s", &fwd.serial, "forward", "--remove", &local_spec])
                    .status();
            }
            log_event(
                "INFO",
                &self.node_id,
                "ADB",
                "FORWARD_REMOVED",
                "Cleaned up dual-port adb forward tunnels",
                &format!(
                    "serial={} probe=tcp:{} rpc=tcp:{}",
                    fwd.serial, fwd.local_probe_port, fwd.local_rpc_port
                ),
            );
        }
    }
}

impl Drop for AdbTunnelManager {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_deterministic_non_overlapping_probe_and_rpc_ports() {
        assert_eq!(deterministic_adb_ports(0, 50052, 51051), (51051, 50052));
        assert_eq!(deterministic_adb_ports(1, 50052, 51051), (51052, 50053));
        assert_eq!(deterministic_adb_ports(2, 50052, 51051), (51053, 50054));
    }
}
