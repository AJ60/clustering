use crate::hw_probe::log_event;
use crate::net_probe::{
    decode_preflight_handshake, encode_preflight_handshake, encode_telemetry_frame,
    verify_llama_binary_version, WorkerTelemetrySnapshot, LLAMA_TAG_PIN, MULTICAST_ADDR,
    RPC_VERSION_PIN,
};
use crate::strength_profiler::run_startup_strength_profiler;
use crate::thermal_balancer::read_local_sensors;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, UdpSocket};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub struct ChildGuard {
    pub child: Option<Child>,
    pub name: String,
}

impl ChildGuard {
    pub fn new(name: &str, child: Child) -> Self {
        Self {
            child: Some(child),
            name: name.to_string(),
        }
    }

    pub fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            log_event(
                "INFO",
                "supervisor",
                "PROCESS",
                "CHILD_TERMINATED",
                "Terminated managed child process cleanly",
                &format!("name={} pid={pid}", self.name),
            );
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub struct WorkerDaemon {
    pub node_id: String,
    pub rpc_port: u16,
    pub rpc_bind: String,
    pub ram_cap_pct: u64,
    pub vulkan_active: bool,
    pub rpc_guard: Option<ChildGuard>,
}

impl WorkerDaemon {
    pub fn new(node_id: String, rpc_port: u16, rpc_bind: String, ram_cap_pct: u64) -> Self {
        Self {
            node_id,
            rpc_port,
            rpc_bind,
            ram_cap_pct,
            vulkan_active: false,
            rpc_guard: None,
        }
    }

    /// 50ms Vulkan warmup check: tests GGML_VULKAN_DEVICE=0.
    /// Falls back to ARM NEON/DotProd CPU (GGML_VK_VISIBLE_DEVICES="") on SPIR-V quirks.
    pub fn run_vulkan_warmup_check(&self, rpc_bin: &str) -> bool {
        let t0 = Instant::now();
        let output = Command::new(rpc_bin)
            .arg("--version")
            .env("GGML_VULKAN_DEVICE", "0")
            .output();

        let elapsed_ms = t0.elapsed().as_millis();
        match output {
            Ok(out) if out.status.success() => {
                let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
                if stderr.contains("spir-v")
                    || stderr.contains("vulkan error")
                    || stderr.contains("vk_error")
                {
                    log_event(
                        "WARNING",
                        &self.node_id,
                        "VULKAN_CHECK",
                        "SPIRV_FALLBACK",
                        "Detected SPIR-V driver quirk; falling back to ARM NEON/DotProd CPU",
                        &format!("elapsed_ms={elapsed_ms}"),
                    );
                    false
                } else {
                    log_event(
                        "INFO",
                        &self.node_id,
                        "VULKAN_CHECK",
                        "VULKAN_OK",
                        "Vulkan SDK 1.4 pre-flight check passed",
                        &format!("elapsed_ms={elapsed_ms}"),
                    );
                    true
                }
            }
            _ => {
                log_event(
                    "WARNING",
                    &self.node_id,
                    "VULKAN_CHECK",
                    "CPU_FALLBACK",
                    "Vulkan check unavailable; defaulting to ARM NEON/DotProd CPU",
                    &format!("elapsed_ms={elapsed_ms}"),
                );
                false
            }
        }
    }

    pub fn start_rpc_server(&mut self, rpc_bin: &str) -> Result<(), String> {
        verify_llama_binary_version(rpc_bin)?;
        let bench = run_startup_strength_profiler(
            &self.node_id,
            self.ram_cap_pct,
            100,
            90,
            1024,
            false,
        );
        self.vulkan_active = self.run_vulkan_warmup_check(rpc_bin);

        let mut cmd = Command::new(rpc_bin);
        cmd.args([
            "-H",
            &self.rpc_bind,
            "-p",
            &self.rpc_port.to_string(),
            "-c",
            "-m",
            &bench.safe_cap_mb.to_string(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        if !self.vulkan_active {
            cmd.env("GGML_VK_VISIBLE_DEVICES", "");
        } else {
            cmd.env("GGML_VULKAN_DEVICE", "0");
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn {rpc_bin}: {e}"))?;
        let pid = child.id();
        self.rpc_guard = Some(ChildGuard::new("rpc-server", child));
        log_event(
            "INFO",
            &self.node_id,
            "WORKER",
            "RPC_STARTED",
            "Spawned stock rpc-server (RPC v9)",
            &format!(
                "pid={pid} bind={} port={} safe_cap_mb={} vulkan={}",
                self.rpc_bind, self.rpc_port, bench.safe_cap_mb, self.vulkan_active
            ),
        );
        Ok(())
    }

    pub fn collect_snapshot(&self) -> WorkerTelemetrySnapshot {
        let bench = run_startup_strength_profiler(
            &self.node_id,
            self.ram_cap_pct,
            100,
            90,
            1024,
            false,
        );
        let sensors = read_local_sensors(bench.is_android);
        WorkerTelemetrySnapshot {
            node_id: self.node_id.clone(),
            os: bench.os,
            isa: bench.isa,
            silicon: bench.silicon,
            perf_cores: bench.perf_cores,
            ram_total_mb: bench.ram_total_mb,
            ram_avail_mb: bench.ram_avail_mb,
            safe_cap_mb: bench.safe_cap_mb,
            compute_tflops: bench.compute_tflops,
            mem_bw_gbps: bench.mem_bw_gbps,
            disk_mbps: bench.disk_mbps,
            cpu_temp_c: sensors.cpu_temp_c,
            cpu_util_pct: sensors.cpu_util_pct,
            thermal_headroom: sensors.thermal_headroom,
            vulkan_active: self.vulkan_active,
            execution_backend: if self.vulkan_active {
                "Vulkan 1.4 (RPC v9)".to_string()
            } else {
                "ARM/Host CPU (RPC v9)".to_string()
            },
            rpc_port: self.rpc_port,
            rpc_bind: self.rpc_bind.clone(),
        }
    }

    pub fn run_probe_responder(&self, probe_port: u16, running: Arc<AtomicBool>) {
        let rpc_port = self.rpc_port;
        let node_id_udp = self.node_id.clone();
        let udp_running = Arc::clone(&running);

        thread::spawn(move || {
            if let Ok(udp) = UdpSocket::bind("0.0.0.0:50050") {
                if let Ok(mcast_ip) = "239.255.77.88".parse::<Ipv4Addr>() {
                    let _ = udp.join_multicast_v4(&mcast_ip, &Ipv4Addr::UNSPECIFIED);
                }
                let _ = udp.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buf = [0u8; 128];
                while udp_running.load(Ordering::Relaxed) {
                    if let Ok((n, src)) = udp.recv_from(&mut buf) {
                        if &buf[..n] == b"CLUSTERD_DISCOVER_V1" {
                            // Send ports & node_id so Master reads true `src.ip()` instead of echoing its own IP
                            let reply = format!("CLUSTERD_SPOKE {probe_port} {rpc_port} {node_id_udp}");
                            let _ = udp.send_to(reply.as_bytes(), src);
                        }
                    }
                }
            }
        });

        let bind_addr = format!("{}:{probe_port}", self.rpc_bind);
        if let Ok(listener) = TcpListener::bind(&bind_addr) {
            let _ = listener.set_nonblocking(true);
            log_event(
                "INFO",
                &self.node_id,
                "WORKER",
                "PROBE_LISTENER",
                "Listening for Master 32-byte handshake, real telemetry & 500ms probes",
                &format!("addr={bind_addr} rpc_port={rpc_port} multicast={MULTICAST_ADDR}"),
            );
            while running.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let nid = self.node_id.clone();
                        let snap = self.collect_snapshot();
                        thread::spawn(move || {
                            let mut s = stream;
                            let _ = s.set_nonblocking(false);
                            let _ = s.set_nodelay(true);
                            let mut hs = [0u8; 32];
                            if s.read_exact(&mut hs).is_ok() {
                                match decode_preflight_handshake(&hs) {
                                    Ok(_) => {
                                        let ack = encode_preflight_handshake(
                                            RPC_VERSION_PIN,
                                            LLAMA_TAG_PIN,
                                        );
                                        if s.write_all(&ack).is_ok() {
                                            let frame = encode_telemetry_frame(&snap);
                                            let _ = s.write_all(&frame);
                                        }
                                        let mut buf = vec![0u8; 16 * 1024];
                                        while s.read_exact(&mut buf).is_ok() {
                                            if s.write_all(&buf).is_err() {
                                                break;
                                            }
                                        }
                                    }
                                    Err(err) => {
                                        log_event(
                                            "ERROR",
                                            &nid,
                                            "HANDSHAKE",
                                            "VERSION_MISMATCH",
                                            &err,
                                            "",
                                        );
                                    }
                                }
                            }
                        });
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        }
    }
}
