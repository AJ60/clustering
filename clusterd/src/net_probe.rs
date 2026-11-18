use crate::hw_probe::log_event;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
use std::process::Command;
use std::time::{Duration, Instant};

pub const RPC_VERSION_PIN: u32 = 9;
pub const LLAMA_TAG_PIN: &str = "v1.0.0";
pub const MULTICAST_ADDR: &str = "239.255.77.88:50050";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkerTelemetrySnapshot {
    pub node_id: String,
    pub os: String,
    pub isa: String,
    pub silicon: String,
    pub perf_cores: u32,
    pub ram_total_mb: u64,
    pub ram_avail_mb: u64,
    pub safe_cap_mb: u64,
    pub compute_tflops: f64,
    pub mem_bw_gbps: f64,
    pub disk_mbps: f64,
    pub cpu_temp_c: f64,
    pub cpu_util_pct: f64,
    pub thermal_headroom: f64,
    pub vulkan_active: bool,
    pub execution_backend: String,
    pub rpc_port: u16,
    #[serde(default)]
    pub rpc_bind: String,
}

#[derive(Debug, Clone)]
pub struct DiscoveredLanPeer {
    pub probe_endpoint: String,
    pub rpc_endpoint: String,
    pub node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkProbeResult {
    pub endpoint: String,
    pub rpc_endpoint: String,
    pub p95_rtt_ms: f64,
    pub jitter_ms: f64,
    pub pkt_loss_pct: f64,
    pub bandwidth_mbps: f64,
    pub handshake_ok: bool,
    pub telemetry: Option<WorkerTelemetrySnapshot>,
}

/// 32-byte pre-flight TCP handshake:
/// [0..4] magic="GGUF", [4..8] rpc_ver=9 (BE u32), [8..24] git_tag="v1.0.0" (zero-padded), [24..32] reserved
pub fn encode_preflight_handshake(rpc_ver: u32, git_tag: &str) -> [u8; 32] {
    let mut buf = [0u8; 32];
    buf[0..4].copy_from_slice(b"GGUF");
    buf[4..8].copy_from_slice(&rpc_ver.to_be_bytes());
    let tag_bytes = git_tag.as_bytes();
    let copy_len = tag_bytes.len().min(16);
    buf[8..8 + copy_len].copy_from_slice(&tag_bytes[..copy_len]);
    buf
}

pub fn decode_preflight_handshake(buf: &[u8; 32]) -> Result<(u32, String), String> {
    if &buf[0..4] != b"GGUF" {
        return Err("Invalid pre-flight magic (expected GGUF)".into());
    }
    let rpc_ver = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let tag_raw = &buf[8..24];
    let end = tag_raw.iter().position(|&b| b == 0).unwrap_or(16);
    let git_tag = String::from_utf8_lossy(&tag_raw[..end]).to_string();
    if rpc_ver != RPC_VERSION_PIN || git_tag != LLAMA_TAG_PIN {
        return Err(format!(
            "Version mismatch: peer rpc_ver={rpc_ver} tag={git_tag}, expected rpc_ver={RPC_VERSION_PIN} tag={LLAMA_TAG_PIN}"
        ));
    }
    Ok((rpc_ver, git_tag))
}

/// Length-prefixed JSON telemetry frame sent immediately after the 32-byte handshake ACK.
/// Wire format: [u32 BE byte_len][UTF-8 JSON]
pub fn encode_telemetry_frame(snapshot: &WorkerTelemetrySnapshot) -> Vec<u8> {
    let json = serde_json::to_vec(snapshot).unwrap_or_default();
    let len = (json.len().min(65536)) as u32;
    let mut frame = Vec::with_capacity(4 + len as usize);
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&json[..len as usize]);
    frame
}

pub fn read_telemetry_frame<R: Read>(reader: &mut R) -> Option<WorkerTelemetrySnapshot> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).ok()?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > 65536 {
        return None;
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).ok()?;
    serde_json::from_slice::<WorkerTelemetrySnapshot>(&payload).ok()
}

pub fn verify_llama_binary_version(bin_name: &str) -> Result<String, String> {
    let out = Command::new(bin_name)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to execute {bin_name} --version: {e}"))?;
    let stdout = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !stdout.contains("v1.0.0") && !stdout.contains("1.0.0") {
        return Err(format!(
            "Strict llama.cpp v1.0.0 (RPC v9) pin failed for {bin_name}: got '{stdout}'"
        ));
    }
    Ok(stdout.trim().to_string())
}

/// Parses a `CLUSTERD_SPOKE` UDP multicast announcement using the real sender IP (`src_ip`)
/// instead of trusting self-reported or echoed Master IPs.
pub fn parse_multicast_spoke_reply(src_ip: IpAddr, msg: &str) -> Option<DiscoveredLanPeer> {
    let rest = msg.strip_prefix("CLUSTERD_SPOKE ")?.trim();
    let parts: Vec<&str> = rest.split_whitespace().collect();
    if parts.len() >= 2 {
        if let (Ok(probe_port), Ok(rpc_port)) = (parts[0].parse::<u16>(), parts[1].parse::<u16>()) {
            let node_id = parts.get(2).copied().unwrap_or("lan-spoke").to_string();
            return Some(DiscoveredLanPeer {
                probe_endpoint: format!("{src_ip}:{probe_port}"),
                rpc_endpoint: format!("{src_ip}:{rpc_port}"),
                node_id,
            });
        }
    }
    // Legacy format fallback: `CLUSTERD_SPOKE <ip>:<rpc_port>` -> assume probe on 50051
    if let Ok(sock) = rest.parse::<SocketAddr>() {
        return Some(DiscoveredLanPeer {
            probe_endpoint: format!("{src_ip}:50051"),
            rpc_endpoint: format!("{src_ip}:{}", sock.port()),
            node_id: "lan-spoke".to_string(),
        });
    }
    None
}

pub fn discover_wifi_multicast(node_id: &str, timeout_ms: u64) -> Vec<DiscoveredLanPeer> {
    let mut peers: Vec<DiscoveredLanPeer> = Vec::new();
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else {
        return peers;
    };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(timeout_ms)));
    let _ = sock.send_to(b"CLUSTERD_DISCOVER_V1", MULTICAST_ADDR);
    let mut buf = [0u8; 512];
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        match sock.recv_from(&mut buf) {
            Ok((n, src)) => {
                if let Ok(msg) = std::str::from_utf8(&buf[..n]) {
                    if let Some(peer) = parse_multicast_spoke_reply(src.ip(), msg) {
                        if !peers.iter().any(|p| p.rpc_endpoint == peer.rpc_endpoint) {
                            log_event(
                                "INFO",
                                node_id,
                                "DISCOVERY",
                                "MULTICAST_PEER",
                                "Discovered Wi-Fi/LAN spoke via real source IP",
                                &format!(
                                    "node_id={} probe={} rpc={}",
                                    peer.node_id, peer.probe_endpoint, peer.rpc_endpoint
                                ),
                            );
                            peers.push(peer);
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }
    peers
}

/// 500ms pre-flight network probe against worker's probe port (`50051` or ADB forwarded `51051+i`):
/// - 32-byte GGUF v1.0.0 / RPC v9 handshake
/// - Length-prefixed JSON `WorkerTelemetrySnapshot` (real peer `/proc/meminfo`, SoC, thermal sensors)
/// - 16 KB ping-pong frames for p95_rtt_ms, jitter_ms & pkt_loss_pct
/// - 4 MB burst for bandwidth_mbps
pub fn probe_spoke_link(node_id: &str, probe_addr_str: &str, rpc_addr_str: &str) -> LinkProbeResult {
    let Ok(addr) = probe_addr_str.parse::<SocketAddr>() else {
        return LinkProbeResult {
            endpoint: probe_addr_str.to_string(),
            rpc_endpoint: rpc_addr_str.to_string(),
            p95_rtt_ms: 999.0,
            jitter_ms: 0.0,
            pkt_loss_pct: 100.0,
            bandwidth_mbps: 0.0,
            handshake_ok: false,
            telemetry: None,
        };
    };

    let mut rtts = Vec::with_capacity(8);
    let mut dropped = 0u32;
    let total_pings = 8u32;
    let ping_frame = vec![0xA5u8; 16 * 1024];
    let mut pong_buf = vec![0u8; 16 * 1024];
    let mut handshake_ok = false;
    let mut telemetry: Option<WorkerTelemetrySnapshot> = None;

    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));

        let hs = encode_preflight_handshake(RPC_VERSION_PIN, LLAMA_TAG_PIN);
        if stream.write_all(&hs).is_ok() {
            let mut peer_hs = [0u8; 32];
            if stream.read_exact(&mut peer_hs).is_ok() {
                handshake_ok = decode_preflight_handshake(&peer_hs).is_ok();
            }
        }

        if handshake_ok {
            telemetry = read_telemetry_frame(&mut stream);
            for _ in 0..total_pings {
                let t0 = Instant::now();
                if stream.write_all(&ping_frame).is_ok() && stream.read_exact(&mut pong_buf).is_ok() {
                    rtts.push(t0.elapsed().as_secs_f64() * 1000.0);
                } else {
                    dropped += 1;
                }
            }
        } else {
            dropped = total_pings;
        }
    } else {
        dropped = total_pings;
    }

    rtts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let (p95_rtt_ms, jitter_ms) = if rtts.is_empty() {
        (999.0, 0.0)
    } else {
        let idx = ((rtts.len() as f64) * 0.95).ceil() as usize;
        let p95 = rtts[idx.saturating_sub(1).min(rtts.len() - 1)];
        let spread = rtts.last().unwrap_or(&0.0) - rtts.first().unwrap_or(&0.0);
        (p95, spread)
    };
    let pkt_loss_pct = (dropped as f64 / total_pings as f64) * 100.0;

    let mut bandwidth_mbps = 0.0;
    if handshake_ok {
        if let Ok(mut burst_stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
            let _ = burst_stream.set_nodelay(true);
            let burst_buf = vec![0x5Au8; 4 * 1024 * 1024];
            let t0 = Instant::now();
            if burst_stream.write_all(&burst_buf).is_ok() {
                let secs = t0.elapsed().as_secs_f64().max(0.0001);
                bandwidth_mbps = (4.0 * 8.0) / secs;
            }
        }
    }

    log_event(
        "INFO",
        node_id,
        "NET_PROBE",
        "LINK_PROBED",
        "Completed 500ms pre-flight probe",
        &format!(
            "probe={probe_addr_str} rpc={rpc_addr_str} p95_rtt_ms={p95_rtt_ms:.2} pkt_loss_pct={pkt_loss_pct:.1} bw_mbps={bandwidth_mbps:.1} handshake={handshake_ok} telemetry={}",
            telemetry.is_some()
        ),
    );

    LinkProbeResult {
        endpoint: probe_addr_str.to_string(),
        rpc_endpoint: rpc_addr_str.to_string(),
        p95_rtt_ms,
        jitter_ms,
        pkt_loss_pct,
        bandwidth_mbps,
        handshake_ok,
        telemetry,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};
    use std::thread;

    #[test]
    fn preflight_handshake_roundtrip_and_version_pin() {
        let bytes = encode_preflight_handshake(9, "v1.0.0");
        assert_eq!(&bytes[0..4], b"GGUF");
        let (ver, tag) = decode_preflight_handshake(&bytes).expect("valid v1.0.0 handshake");
        assert_eq!(ver, 9);
        assert_eq!(tag, "v1.0.0");

        let bad_bytes = encode_preflight_handshake(8, "b11429");
        assert!(decode_preflight_handshake(&bad_bytes).is_err());
    }

    #[test]
    fn multicast_parser_uses_real_source_ip() {
        let peer = parse_multicast_spoke_reply(
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 77)),
            "CLUSTERD_SPOKE 50051 50052 pixel-9-pro",
        )
        .expect("parse multicast reply");
        assert_eq!(peer.probe_endpoint, "192.168.1.77:50051");
        assert_eq!(peer.rpc_endpoint, "192.168.1.77:50052");
        assert_eq!(peer.node_id, "pixel-9-pro");
    }

    #[test]
    fn real_tcp_probe_reads_handshake_telemetry_and_rtts() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().unwrap().port();
        let sample_tel = WorkerTelemetrySnapshot {
            node_id: "android-pixel-8".into(),
            os: "android_apk".into(),
            isa: "ARMv8.2+ DotProd".into(),
            silicon: "Google Tensor/Mali".into(),
            perf_cores: 4,
            ram_total_mb: 12288,
            ram_avail_mb: 8800,
            safe_cap_mb: 6144,
            compute_tflops: 2.2,
            mem_bw_gbps: 64.0,
            disk_mbps: 900.0,
            cpu_temp_c: 37.5,
            cpu_util_pct: 14.0,
            thermal_headroom: 0.42,
            vulkan_active: true,
            execution_backend: "Vulkan 1.4 (16KB ELF)".into(),
            rpc_port: 50052,
            rpc_bind: "127.0.0.1".into(),
        };
        let tel_clone = sample_tel.clone();

        thread::spawn(move || {
            for conn in listener.incoming().take(2) {
                let Ok(mut s) = conn else { break };
                let mut hs = [0u8; 32];
                if s.read_exact(&mut hs).is_ok() {
                    if &hs[0..4] == b"GGUF" {
                        let ack = encode_preflight_handshake(RPC_VERSION_PIN, LLAMA_TAG_PIN);
                        let _ = s.write_all(&ack);
                        let frame = encode_telemetry_frame(&tel_clone);
                        let _ = s.write_all(&frame);
                        let mut echo = vec![0u8; 16 * 1024];
                        while s.read_exact(&mut echo).is_ok() {
                            if s.write_all(&echo).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });

        let addr = format!("127.0.0.1:{port}");
        let res = probe_spoke_link("test-master", &addr, "127.0.0.1:50052");
        assert!(res.handshake_ok);
        assert_eq!(res.pkt_loss_pct, 0.0);
        assert_eq!(res.telemetry.as_ref(), Some(&sample_tel));
    }
}
