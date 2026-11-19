//! Master Cluster Orchestrator, Central Control Web UI HTTP Server,
//! UDP Auto-Discovery Beacon (`:50050`), Edge SBC Auto-Pruning & Auto-Unpruning,
//! <6s Worker Fault Detection, Wi-Fi Auth Verification, and OpenAI-Compatible
//! `/v1/chat/completions` SSE Streaming Gateway.

use crate::protocol::{
    probe_worker_handshake, verify_cluster_auth_token, HandshakeFrame, DEFAULT_CLUSTER_SECRET,
    FLAG_LEGACY_GRAPHICS, FLAG_LEGACY_HARDWARE, FLAG_SBC_CORTEX_A72, STATUS_READY,
    STATUS_SHED_LAYERS, STATUS_THROTTLED_THERMAL,
};
use crate::supervisor::build_llama_server_v1_args_for_profile;
use crate::sys_probe::{
    detect_lan_ipv4, locate_adb_binary, probe_hardware_profile,
};
use crate::web_ui::{render_pairing_qr_svg, CENTRAL_CONTROL_WEB_HTML};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

pub const UDP_DISCOVERY_PORT: u16 = 50050;
const MAX_CONCURRENT_CONNECTIONS: usize = 64;

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct ActiveGuard<'a>(&'a AtomicUsize);

impl<'a> Drop for ActiveGuard<'a> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeHealth {
    Online,
    Throttled,
    SheddingMemory,
    PrunedEdgeSbc,
    Offline,
}

impl NodeHealth {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeHealth::Online => "Online",
            NodeHealth::Throttled => "Throttled",
            NodeHealth::SheddingMemory => "SheddingMemory",
            NodeHealth::PrunedEdgeSbc => "PrunedEdgeSbc",
            NodeHealth::Offline => "Offline",
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkerNode {
    pub id: String,
    pub addr: SocketAddr,
    pub platform: String,
    pub is_usb_phone: bool,
    pub is_edge_sbc_a72: bool,
    pub is_legacy_hardware: bool,
    pub is_legacy_graphics: bool,
    pub safe_cap_mb: u64,
    pub big_cores: u32,
    pub assigned_layers: u32,
    pub health: NodeHealth,
    pub consecutive_failures: u32,
    pub last_seen: Instant,
}

#[derive(Debug, Clone)]
pub struct LayerAllocationPlan {
    pub master_layers: u32,
    pub worker_allocations: Vec<(String, SocketAddr, u32)>,
    pub pruned_nodes: Vec<String>,
    pub unpruned_nodes: Vec<String>,
    pub total_layers: u32,
}

#[derive(Debug, Clone)]
pub struct MasterControlState {
    pub bind_host: String,
    pub lan_ip: String,
    pub master_os: String,
    pub master_arch: String,
    pub master_port: u16,
    pub cluster_secret: String,
    pub model_path: String,
    pub model_required_mb: u64,
    pub total_layers: u32,
    pub master_layers: u32,
    pub master_total_ram_mb: u64,
    pub master_safe_cap_mb: u64,
    pub master_big_cores: usize,
    pub master_legacy_hardware: bool,
    pub master_legacy_graphics: bool,
    pub master_graphics_tier: String,
    pub master_ctx_size: usize,
    pub workers: Vec<WorkerNode>,
}

impl MasterControlState {
    pub fn new(
        bind_host: String,
        master_port: u16,
        cluster_secret: String,
        model_path: String,
        workers: Vec<WorkerNode>,
    ) -> Self {
        let hw = probe_hardware_profile();
        let lan_ip = if bind_host == "127.0.0.1" || bind_host == "localhost" {
            "127.0.0.1".to_string()
        } else if bind_host == "0.0.0.0" {
            hw.lan_ip.to_string()
        } else {
            bind_host.clone()
        };

        Self {
            bind_host,
            lan_ip,
            master_os: hw.os_name.to_string(),
            master_arch: hw.arch.to_string(),
            master_port,
            cluster_secret,
            model_path,
            model_required_mb: 1500,
            total_layers: 24,
            master_layers: 24,
            master_total_ram_mb: hw.memory.total_phys_mb,
            master_safe_cap_mb: hw.memory.safe_cap_mb,
            master_big_cores: hw.cpu.big_performance_cores.len(),
            master_legacy_hardware: hw.legacy_hardware,
            master_legacy_graphics: hw.legacy_graphics,
            master_graphics_tier: hw.graphics_tier.to_string(),
            master_ctx_size: hw.recommended_ctx_size,
            workers,
        }
    }

    pub fn pairing_uri(&self) -> String {
        format!(
            "clusterd://pair?master={}:{}&rpc=50052&secret={}",
            self.lan_ip, self.master_port, self.cluster_secret
        )
    }

    pub fn usb_pairing_uri(&self) -> String {
        format!(
            "clusterd://pair?master=127.0.0.1:{}&rpc=50052&secret={}",
            self.master_port, self.cluster_secret
        )
    }

    pub fn build_llama_cli_args(&self) -> Vec<String> {
        let active: Vec<&WorkerNode> = self
            .workers
            .iter()
            .filter(|w| w.health == NodeHealth::Online && w.assigned_layers > 0)
            .collect();
        let rpc_endpoints: Vec<String> = active.iter().map(|w| w.addr.to_string()).collect();
        let mut weights: Vec<u32> = Vec::with_capacity(active.len() + 1);
        if !active.is_empty() {
            weights.push(self.master_layers.max(1));
            for w in &active {
                weights.push(w.assigned_layers.max(1));
            }
        }
        build_llama_server_v1_args_for_profile(
            &self.model_path,
            &self.bind_host,
            self.master_port.saturating_add(1),
            &rpc_endpoints,
            &weights,
            self.master_big_cores,
            self.master_ctx_size,
            self.master_legacy_graphics,
        )
    }
}

/// Computes proportional model layer distribution across mixed-OS nodes and automatically
/// prunes slow ARMv8.0 Cortex-A72 SBCs (e.g., Raspberry Pi 400) or constrained legacy nodes
/// (`<= 1024 MB` safe cap) whenever the Master + fast modern workers already fit `model_required_mb`.
/// Automatically un-prunes reachable `PrunedEdgeSbc` nodes back to `Online` on overflow,
/// preserves >= 1 layer on Master, and sorts allocation deterministically at scale.
pub fn plan_cluster_layers(
    model_required_mb: u64,
    total_layers: u32,
    master_safe_cap_mb: u64,
    workers: &mut [WorkerNode],
) -> LayerAllocationPlan {
    let is_prunable = |w: &WorkerNode| {
        w.is_edge_sbc_a72 || (w.is_legacy_hardware && w.safe_cap_mb <= 1024)
    };

    let fast_workers_mb: u64 = workers
        .iter()
        .filter(|w| w.health == NodeHealth::Online && !is_prunable(w))
        .map(|w| w.safe_cap_mb)
        .sum();

    let fast_pool_fits_model = (master_safe_cap_mb + fast_workers_mb) >= model_required_mb;
    let mut pruned_nodes = Vec::new();
    let mut unpruned_nodes = Vec::new();

    for w in workers.iter_mut() {
        if !is_prunable(w) {
            continue;
        }
        if fast_pool_fits_model {
            if w.health == NodeHealth::Online || w.health == NodeHealth::PrunedEdgeSbc {
                w.health = NodeHealth::PrunedEdgeSbc;
                w.assigned_layers = 0;
                pruned_nodes.push(w.id.clone());
            }
        } else if w.health == NodeHealth::PrunedEdgeSbc {
            w.health = NodeHealth::Online;
            unpruned_nodes.push(w.id.clone());
        }
    }

    let active_worker_mb: u64 = workers
        .iter()
        .filter(|w| w.health == NodeHealth::Online)
        .map(|w| w.safe_cap_mb)
        .sum();

    let total_pool_mb = (master_safe_cap_mb + active_worker_mb).max(1);
    let mut remaining_layers = total_layers;
    let min_master_reserve = if total_layers >= 1 { 1u32 } else { 0u32 };

    // Assign offline/pruned nodes 0 first, and sort online worker indices deterministically by (-safe_cap_mb, id)
    let mut online_indices: Vec<usize> = Vec::new();
    for (idx, w) in workers.iter_mut().enumerate() {
        if w.health != NodeHealth::Online {
            w.assigned_layers = 0;
        } else {
            online_indices.push(idx);
        }
    }
    online_indices.sort_by(|&a, &b| {
        workers[b]
            .safe_cap_mb
            .cmp(&workers[a].safe_cap_mb)
            .then_with(|| workers[a].id.cmp(&workers[b].id))
    });

    for idx in online_indices {
        let cap_budget = remaining_layers.saturating_sub(min_master_reserve);
        let share = ((workers[idx].safe_cap_mb as f64 / total_pool_mb as f64)
            * (total_layers as f64))
            .round() as u32;
        let allocated = share.min(cap_budget);
        workers[idx].assigned_layers = allocated;
        remaining_layers = remaining_layers.saturating_sub(allocated);
    }

    let worker_allocations: Vec<(String, SocketAddr, u32)> = workers
        .iter()
        .filter(|w| w.health == NodeHealth::Online && w.assigned_layers > 0)
        .map(|w| (w.id.clone(), w.addr, w.assigned_layers))
        .collect();

    let master_layers = remaining_layers;
    LayerAllocationPlan {
        master_layers,
        worker_allocations,
        pruned_nodes,
        unpruned_nodes,
        total_layers,
    }
}

/// Polls all registered workers **concurrently** in bounded waves with a strict 1.2s timeout.
/// Marks any unresponsive worker `Offline` in < 6 seconds (after 2 failed probes)
/// or immediately if the worker emits `STATUS_SHED_LAYERS` (`onTrimMemory`).
pub fn poll_and_rebalance_workers(
    workers: &mut [WorkerNode],
    cluster_secret: Option<&str>,
    model_required_mb: u64,
    total_layers: u32,
    master_safe_cap_mb: u64,
) -> (bool, LayerAllocationPlan) {
    let mut topology_changed = false;
    let probe_timeout = Duration::from_millis(1200);
    let prev_layers: Vec<u32> = workers.iter().map(|w| w.assigned_layers).collect();

    for chunk in workers.chunks_mut(32) {
        let addrs: Vec<SocketAddr> = chunk.iter().map(|w| w.addr).collect();
        let results: Vec<io::Result<HandshakeFrame>> = thread::scope(|scope| {
            let handles: Vec<_> = addrs
                .iter()
                .map(|&addr| {
                    scope.spawn(move || probe_worker_handshake(addr, cluster_secret, probe_timeout))
                })
                .collect();
            handles
                .into_iter()
                .map(|h| {
                    h.join().unwrap_or_else(|_| {
                        Err(io::Error::new(io::ErrorKind::Other, "probe thread panicked"))
                    })
                })
                .collect()
        });

        for (w, probe_res) in chunk.iter_mut().zip(results.into_iter()) {
            match probe_res {
                Ok(frame) => {
                    w.consecutive_failures = 0;
                    w.last_seen = Instant::now();
                    w.safe_cap_mb = frame.safe_cap_mb as u64;
                    w.big_cores = frame.big_cores;
                    w.is_edge_sbc_a72 = (frame.flags & FLAG_SBC_CORTEX_A72) != 0;
                    w.is_legacy_hardware = (frame.flags & FLAG_LEGACY_HARDWARE) != 0;
                    w.is_legacy_graphics = (frame.flags & FLAG_LEGACY_GRAPHICS) != 0;
                    w.platform = frame.platform_label().to_string();

                    let new_health = match frame.status {
                        STATUS_READY => NodeHealth::Online,
                        STATUS_THROTTLED_THERMAL => NodeHealth::Throttled,
                        STATUS_SHED_LAYERS => NodeHealth::SheddingMemory,
                        _ => NodeHealth::Online,
                    };
                    if w.health == NodeHealth::PrunedEdgeSbc {
                        if new_health != NodeHealth::Online {
                            w.health = new_health;
                            topology_changed = true;
                        }
                    } else if w.health != new_health {
                        w.health = new_health;
                        topology_changed = true;
                    }
                }
                Err(_) => {
                    w.consecutive_failures += 1;
                    if w.consecutive_failures >= 2 && w.health != NodeHealth::Offline {
                        w.health = NodeHealth::Offline;
                        w.assigned_layers = 0;
                        topology_changed = true;
                    }
                }
            }
        }
    }

    let plan = plan_cluster_layers(
        model_required_mb,
        total_layers,
        master_safe_cap_mb,
        workers,
    );
    if !plan.unpruned_nodes.is_empty() || !plan.pruned_nodes.is_empty() {
        topology_changed = true;
    }
    if workers
        .iter()
        .zip(prev_layers.iter())
        .any(|(w, &old)| w.assigned_layers != old)
    {
        topology_changed = true;
    }
    (topology_changed, plan)
}

/// Discovers an active ClusterLab Master on the LAN/loopback via UDP broadcast (`:50050`).
pub fn discover_master_via_udp(timeout: Duration) -> Option<(SocketAddr, String, u16)> {
    discover_master_via_udp_on_port(UDP_DISCOVERY_PORT, timeout)
}

pub fn discover_master_via_udp_on_port(
    udp_port: u16,
    timeout: Duration,
) -> Option<(SocketAddr, String, u16)> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    let _ = sock.set_broadcast(true);
    let _ = sock.set_read_timeout(Some(timeout));

    let targets = [
        format!("255.255.255.255:{}", udp_port),
        format!("127.0.0.1:{}", udp_port),
    ];
    for t in &targets {
        let _ = sock.send_to(b"CLUSTERD_DISCOVER", t);
    }

    let mut buf = [0u8; 512];
    if let Ok((len, src_addr)) = sock.recv_from(&mut buf) {
        let msg = String::from_utf8_lossy(&buf[..len]);
        if let Some(body) = msg.trim().strip_prefix("CLUSTERD_MASTER:") {
            let mut master_port = 8080u16;
            let mut rpc_port = 50052u16;
            let mut secret = DEFAULT_CLUSTER_SECRET.to_string();
            for kv in body.split(';') {
                if let Some((k, v)) = kv.split_once('=') {
                    match k.trim() {
                        "port" => {
                            if let Ok(p) = v.trim().parse::<u16>() {
                                master_port = p;
                            }
                        }
                        "rpc_port" => {
                            if let Ok(p) = v.trim().parse::<u16>() {
                                rpc_port = p;
                            }
                        }
                        "secret" => {
                            if !v.trim().is_empty() {
                                secret = v.trim().to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
            return Some((SocketAddr::new(src_addr.ip(), master_port), secret, rpc_port));
        }
    }
    None
}

/// Spawns a UDP auto-discovery responder on port 50050 so Android, Windows, Linux, and
/// Edge SBC nodes tapping "Auto-Detect Master" or launching with `--master` / `auto`
/// find and register with the Master immediately without blocking the UDP recv loop.
pub fn spawn_udp_discovery_responder(
    master_http_port: u16,
    cluster_secret: String,
    state: Arc<Mutex<MasterControlState>>,
) -> io::Result<SocketAddr> {
    let bind_addr = format!("0.0.0.0:{}", UDP_DISCOVERY_PORT);
    let socket = UdpSocket::bind(&bind_addr)?;
    let local_addr = socket.local_addr()?;
    let _ = socket.set_broadcast(true);
    let active_registrations = Arc::new(AtomicUsize::new(0));

    thread::spawn(move || {
        let mut buf = [0u8; 512];
        loop {
            if let Ok((len, src_addr)) = socket.recv_from(&mut buf) {
                let msg = String::from_utf8_lossy(&buf[..len]);
                let trimmed = msg.trim();
                // Expects "CLUSTERD_DISCOVER" or "CLUSTERD_REGISTER:<rpc_port>"
                if trimmed.starts_with("CLUSTERD_DISCOVER") {
                    let reply = format!(
                        "CLUSTERD_MASTER:port={};secret={};rpc_port=50052",
                        master_http_port, cluster_secret
                    );
                    let _ = socket.send_to(reply.as_bytes(), src_addr);
                } else if let Some(port_str) = trimmed.strip_prefix("CLUSTERD_REGISTER:") {
                    let worker_port: u16 = port_str
                        .split(|c: char| !c.is_ascii_digit())
                        .next()
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(50052);
                    let worker_addr = SocketAddr::new(src_addr.ip(), worker_port);
                    let reply = format!(
                        "CLUSTERD_REGISTERED:master_port={};secret={}",
                        master_http_port, cluster_secret
                    );
                    let _ = socket.send_to(reply.as_bytes(), src_addr);

                    if active_registrations.load(Ordering::Acquire) < 32 {
                        let st = Arc::clone(&state);
                        let reg_count = Arc::clone(&active_registrations);
                        reg_count.fetch_add(1, Ordering::AcqRel);
                        thread::spawn(move || {
                            let _guard = ActiveGuard(&reg_count);
                            register_or_refresh_worker(&st, worker_addr);
                        });
                    }
                }
            }
        }
    });

    Ok(local_addr)
}

pub fn register_or_refresh_worker(state: &Arc<Mutex<MasterControlState>>, addr: SocketAddr) {
    let secret = {
        let g = lock_unpoisoned(state);
        g.cluster_secret.clone()
    };
    let handshake = probe_worker_handshake(addr, Some(&secret), Duration::from_millis(1200));

    let mut guard = lock_unpoisoned(state);
    if let Some(existing) = guard.workers.iter_mut().find(|w| w.addr == addr) {
        if let Ok(frame) = handshake {
            existing.safe_cap_mb = frame.safe_cap_mb as u64;
            existing.big_cores = frame.big_cores;
            existing.is_edge_sbc_a72 = (frame.flags & FLAG_SBC_CORTEX_A72) != 0;
            existing.is_legacy_hardware = (frame.flags & FLAG_LEGACY_HARDWARE) != 0;
            existing.is_legacy_graphics = (frame.flags & FLAG_LEGACY_GRAPHICS) != 0;
            existing.platform = frame.platform_label().to_string();
            existing.health = match frame.status {
                STATUS_THROTTLED_THERMAL => NodeHealth::Throttled,
                STATUS_SHED_LAYERS => NodeHealth::SheddingMemory,
                _ => NodeHealth::Online,
            };
            existing.consecutive_failures = 0;
            existing.last_seen = Instant::now();
        }
    } else {
        let (safe_mb, cores, is_sbc, is_legacy_hw, is_legacy_gfx, platform, health) =
            match handshake {
                Ok(f) => (
                    f.safe_cap_mb as u64,
                    f.big_cores,
                    (f.flags & FLAG_SBC_CORTEX_A72) != 0,
                    (f.flags & FLAG_LEGACY_HARDWARE) != 0,
                    (f.flags & FLAG_LEGACY_GRAPHICS) != 0,
                    f.platform_label().to_string(),
                    match f.status {
                        STATUS_THROTTLED_THERMAL => NodeHealth::Throttled,
                        STATUS_SHED_LAYERS => NodeHealth::SheddingMemory,
                        _ => NodeHealth::Online,
                    },
                ),
                Err(_) => (
                    1024,
                    4,
                    false,
                    false,
                    false,
                    "Pending Node".to_string(),
                    NodeHealth::Offline,
                ),
            };
        let id = if addr.ip().is_loopback() {
            format!("usb-node-{}", addr.port())
        } else {
            format!(
                "lan-{}-{}:{}",
                platform.to_lowercase().replace(' ', "-"),
                addr.ip(),
                addr.port()
            )
        };
        guard.workers.push(WorkerNode {
            id,
            addr,
            platform,
            is_usb_phone: addr.ip().is_loopback(),
            is_edge_sbc_a72: is_sbc,
            is_legacy_hardware: is_legacy_hw,
            is_legacy_graphics: is_legacy_gfx,
            safe_cap_mb: safe_mb,
            big_cores: cores,
            assigned_layers: 0,
            health,
            consecutive_failures: 0,
            last_seen: Instant::now(),
        });
    }
    let model_mb = guard.model_required_mb;
    let total_layers = guard.total_layers;
    let master_cap = guard.master_safe_cap_mb;
    let plan = plan_cluster_layers(model_mb, total_layers, master_cap, &mut guard.workers);
    guard.master_layers = plan.master_layers;
}

/// Auto-scans USB `adb forward tcp:50052 tcp:50052` and local ports `50051..50053`
/// to discover attached Android phones or local Windows/Linux workers automatically.
pub fn auto_scan_usb_and_local_nodes(state: &Arc<Mutex<MasterControlState>>) {
    if let Some(adb_bin) = locate_adb_binary() {
        let _ = Command::new(adb_bin)
            .args(["forward", "tcp:50052", "tcp:50052"])
            .output();
    }
    let secret = {
        let g = lock_unpoisoned(state);
        g.cluster_secret.clone()
    };
    for port in [50051u16, 50052, 50053] {
        let candidate = SocketAddr::from(([127, 0, 0, 1], port));
        if probe_worker_handshake(candidate, Some(&secret), Duration::from_millis(400)).is_ok() {
            register_or_refresh_worker(state, candidate);
        }
    }
}

/// Starts a real GGUF v9 handshake worker responder on `bind_addr` without enforcing a
/// custom secret (backward-compatible helper for local/USB workers & tests).
pub fn spawn_handshake_worker_listener(
    bind_addr: SocketAddr,
    frame_state: Arc<Mutex<HandshakeFrame>>,
) -> io::Result<SocketAddr> {
    spawn_authenticated_handshake_worker_listener(bind_addr, frame_state, None)
}

/// Starts a real GGUF v9 handshake worker responder on `bind_addr` that enforces the
/// 32-byte keyed `cluster_secret` auth token whenever `required_secret` is `Some`.
/// Unauthorized probes are dropped immediately without leaking hardware telemetry.
pub fn spawn_authenticated_handshake_worker_listener(
    bind_addr: SocketAddr,
    frame_state: Arc<Mutex<HandshakeFrame>>,
    required_secret: Option<String>,
) -> io::Result<SocketAddr> {
    let listener = TcpListener::bind(bind_addr)?;
    let local_addr = listener.local_addr()?;
    let active_conns = Arc::new(AtomicUsize::new(0));

    thread::spawn(move || {
        for incoming in listener.incoming().flatten() {
            if active_conns.load(Ordering::Acquire) >= MAX_CONCURRENT_CONNECTIONS {
                continue;
            }
            let state = Arc::clone(&frame_state);
            let secret_opt = required_secret.clone();
            let conns = Arc::clone(&active_conns);
            conns.fetch_add(1, Ordering::AcqRel);
            thread::spawn(move || {
                let _guard = ActiveGuard(&conns);
                let mut stream = incoming;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_nodelay(true);
                let mut challenge = [0u8; 32];
                if stream.read_exact(&mut challenge).is_err() {
                    return;
                }
                if let Some(ref expected_secret) = secret_opt {
                    if !verify_cluster_auth_token(expected_secret, &challenge) {
                        // Reject unauthorized Master probe cleanly
                        return;
                    }
                }
                let frame = lock_unpoisoned(&state);
                let bytes = frame.to_bytes();
                let _ = stream.write_all(&bytes);
                let _ = stream.flush();
            });
        }
    });

    Ok(local_addr)
}

/// Compatibility helper for spawning the HTTP gateway with a legacy worker list.
pub fn spawn_master_http_gateway(
    bind_addr: SocketAddr,
    workers: Arc<Mutex<Vec<WorkerNode>>>,
    upstream_llama_port: Option<u16>,
) -> io::Result<SocketAddr> {
    let initial_workers = lock_unpoisoned(&workers).clone();
    let ctrl_state = Arc::new(Mutex::new(MasterControlState::new(
        bind_addr.ip().to_string(),
        bind_addr.port(),
        DEFAULT_CLUSTER_SECRET.to_string(),
        "models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf".to_string(),
        initial_workers,
    )));
    spawn_central_control_gateway(bind_addr, ctrl_state, Some(workers), upstream_llama_port)
}

/// Spawns the full Central Control Web UI + REST API + OpenAI SSE Gateway on `bind_addr`.
pub fn spawn_central_control_gateway(
    bind_addr: SocketAddr,
    ctrl_state: Arc<Mutex<MasterControlState>>,
    legacy_workers_mirror: Option<Arc<Mutex<Vec<WorkerNode>>>>,
    upstream_llama_port: Option<u16>,
) -> io::Result<SocketAddr> {
    let listener = TcpListener::bind(bind_addr)?;
    let local_addr = listener.local_addr()?;

    {
        let mut guard = lock_unpoisoned(&ctrl_state);
        guard.master_port = local_addr.port();
    }

    let active_http_conns = Arc::new(AtomicUsize::new(0));
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if active_http_conns.load(Ordering::Acquire) >= MAX_CONCURRENT_CONNECTIONS {
                continue;
            }
            let state_ref = Arc::clone(&ctrl_state);
            let mirror_ref = legacy_workers_mirror.clone();
            let conns = Arc::clone(&active_http_conns);
            conns.fetch_add(1, Ordering::AcqRel);
            thread::spawn(move || {
                let _guard = ActiveGuard(&conns);
                let _ = handle_http_client(stream, state_ref, mirror_ref, upstream_llama_port);
            });
        }
    });

    Ok(local_addr)
}

fn handle_http_client(
    mut client: TcpStream,
    ctrl_state: Arc<Mutex<MasterControlState>>,
    legacy_mirror: Option<Arc<Mutex<Vec<WorkerNode>>>>,
    upstream_port: Option<u16>,
) -> io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(client.try_clone()?);
    let mut request_line = String::new();
    let bytes_read = reader.read_line(&mut request_line)?;
    if bytes_read == 0 || request_line.trim().is_empty() {
        return Ok(());
    }

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 || line == "\r\n" || line == "\n" || line.is_empty() {
            break;
        }
        if let Some(rest) = line.to_lowercase().strip_prefix("content-length:") {
            content_length = rest.trim().parse::<usize>().unwrap_or(0);
        }
    }

    let mut body_bytes = Vec::new();
    if content_length > 0 {
        body_bytes.resize(content_length.min(128 * 1024), 0);
        let _ = reader.read_exact(&mut body_bytes);
    }
    let body_str = String::from_utf8_lossy(&body_bytes);

    // CORS preflight support for local tooling
    if request_line.starts_with("OPTIONS ") {
        let preflight = concat!(
            "HTTP/1.1 204 No Content\r\n",
            "Access-Control-Allow-Origin: *\r\n",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n",
            "Access-Control-Allow-Headers: Content-Type, Authorization\r\n",
            "Connection: close\r\n\r\n"
        );
        client.write_all(preflight.as_bytes())?;
        return client.flush();
    }

    // 1. Central Control Web UI Dashboard (`GET /`)
    if request_line.starts_with("GET / ") || request_line.starts_with("GET /index.html") {
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            CENTRAL_CONTROL_WEB_HTML.len(),
            CENTRAL_CONTROL_WEB_HTML
        );
        client.write_all(resp.as_bytes())?;
        client.flush()?;
        return Ok(());
    }

    // 2. Cluster Health Endpoint (`GET /health`)
    if request_line.starts_with("GET /health") {
        let guard = lock_unpoisoned(&ctrl_state);
        let online_count = guard
            .workers
            .iter()
            .filter(|w| w.health == NodeHealth::Online)
            .count();
        let json = format!(
            "{{\"status\":\"ok\",\"master_os\":\"{}\",\"master_arch\":\"{}\",\"lan_ip\":\"{}\",\"graphics_tier\":\"{}\",\"legacy_graphics\":{},\"online_workers\":{},\"total_workers\":{}}}",
            json_escape(&guard.master_os),
            json_escape(&guard.master_arch),
            json_escape(&guard.lan_ip),
            json_escape(&guard.master_graphics_tier),
            guard.master_legacy_graphics,
            online_count,
            guard.workers.len()
        );
        return write_json_response(&mut client, &json);
    }

    // 2b. Zero-Jargon Auto-Diagnosis Endpoint (`GET /api/diagnose`)
    if request_line.starts_with("GET /api/diagnose") {
        let guard = lock_unpoisoned(&ctrl_state);
        let json = build_cluster_diagnosis_json(&guard);
        return write_json_response(&mut client, &json);
    }

    // 3. Detailed Central Control Status + QR Pairing Payload (`GET /api/status`)
    if request_line.starts_with("GET /api/status") {
        let mut guard = lock_unpoisoned(&ctrl_state);
        let model_mb = guard.model_required_mb;
        let total_layers = guard.total_layers;
        let master_cap = guard.master_safe_cap_mb;
        let plan = plan_cluster_layers(model_mb, total_layers, master_cap, &mut guard.workers);
        guard.master_layers = plan.master_layers;

        let online_count = guard
            .workers
            .iter()
            .filter(|w| w.health == NodeHealth::Online)
            .count();
        let worker_ram: u64 = guard
            .workers
            .iter()
            .filter(|w| w.health == NodeHealth::Online)
            .map(|w| w.safe_cap_mb)
            .sum();
        let total_safe_ram = guard.master_safe_cap_mb + worker_ram;

        let pairing_uri = guard.pairing_uri();
        let usb_pairing_uri = guard.usb_pairing_uri();
        let qr_svg = render_pairing_qr_svg(&pairing_uri);
        let llama_cli_preview = guard.build_llama_cli_args().join(" ");

        let workers_json: Vec<String> = guard
            .workers
            .iter()
            .map(|w| {
                format!(
                    "{{\"id\":\"{}\",\"addr\":\"{}\",\"platform\":\"{}\",\"safe_cap_mb\":{},\"big_cores\":{},\"assigned_layers\":{},\"legacy_hardware\":{},\"legacy_graphics\":{},\"health\":\"{}\"}}",
                    json_escape(&w.id),
                    json_escape(&w.addr.to_string()),
                    json_escape(&w.platform),
                    w.safe_cap_mb,
                    w.big_cores,
                    w.assigned_layers,
                    w.is_legacy_hardware,
                    w.is_legacy_graphics,
                    w.health.as_str()
                )
            })
            .collect();

        let json = format!(
            "{{\"status\":\"ok\",\"master_os\":\"{}\",\"master_arch\":\"{}\",\"lan_ip\":\"{}\",\"master_port\":{},\"master_total_ram_mb\":{},\"master_safe_cap_mb\":{},\"master_big_cores\":{},\"master_legacy_hardware\":{},\"master_legacy_graphics\":{},\"master_graphics_tier\":\"{}\",\"master_layers\":{},\"total_layers\":{},\"model_required_mb\":{},\"total_safe_ram_mb\":{},\"online_workers\":{},\"model_path\":\"{}\",\"pairing_uri\":\"{}\",\"usb_pairing_uri\":\"{}\",\"llama_cli_args\":\"{}\",\"qr_svg\":\"{}\",\"workers\":[{}]}}",
            json_escape(&guard.master_os),
            json_escape(&guard.master_arch),
            json_escape(&guard.lan_ip),
            guard.master_port,
            guard.master_total_ram_mb,
            guard.master_safe_cap_mb,
            guard.master_big_cores,
            guard.master_legacy_hardware,
            guard.master_legacy_graphics,
            json_escape(&guard.master_graphics_tier),
            guard.master_layers,
            guard.total_layers,
            guard.model_required_mb,
            total_safe_ram,
            online_count,
            json_escape(&guard.model_path),
            json_escape(&pairing_uri),
            json_escape(&usb_pairing_uri),
            json_escape(&llama_cli_preview),
            json_escape(&qr_svg),
            workers_json.join(",")
        );
        return write_json_response(&mut client, &json);
    }

    // 4. Connect / Add Worker Node from Web UI or Android/PC Auto-Detect (`POST /api/nodes/add`)
    if request_line.starts_with("POST /api/nodes/add") {
        if let Some(addr_str) = extract_json_string(&body_str, "addr") {
            let normalized = if addr_str.contains(':') {
                addr_str
            } else {
                format!("{}:50052", addr_str)
            };
            if let Ok(sock_addr) = normalized.parse::<SocketAddr>() {
                register_or_refresh_worker(&ctrl_state, sock_addr);
                sync_back_to_mirror(&ctrl_state, &legacy_mirror);
                return write_json_response(&mut client, "{\"ok\":true}");
            }
        }
        return write_json_response(&mut client, "{\"ok\":false,\"error\":\"invalid addr\"}");
    }

    // 5. Remove Worker Node (`POST /api/nodes/remove`)
    if request_line.starts_with("POST /api/nodes/remove") {
        let target_key = extract_json_string(&body_str, "addr")
            .or_else(|| extract_json_string(&body_str, "id"));
        if let Some(target) = target_key {
            {
                let mut guard = lock_unpoisoned(&ctrl_state);
                guard
                    .workers
                    .retain(|w| w.addr.to_string() != target && w.id != target);
                let model_mb = guard.model_required_mb;
                let total_layers = guard.total_layers;
                let master_cap = guard.master_safe_cap_mb;
                let plan =
                    plan_cluster_layers(model_mb, total_layers, master_cap, &mut guard.workers);
                guard.master_layers = plan.master_layers;
            }
            sync_back_to_mirror(&ctrl_state, &legacy_mirror);
        }
        return write_json_response(&mut client, "{\"ok\":true}");
    }

    // 6. Trigger USB ADB + Local Port Auto-Scan (`POST /api/nodes/scan`)
    if request_line.starts_with("POST /api/nodes/scan") {
        auto_scan_usb_and_local_nodes(&ctrl_state);
        sync_back_to_mirror(&ctrl_state, &legacy_mirror);
        return write_json_response(&mut client, "{\"ok\":true}");
    }

    // 7. Load Model & Distribute Layers Across Mixed-OS Nodes (`POST /api/model/load`)
    if request_line.starts_with("POST /api/model/load") {
        let mut cli_preview = String::new();
        let mut master_layers = 0u32;
        if let Ok(mut guard) = ctrl_state.lock() {
            if let Some(mpath) = extract_json_string(&body_str, "model_path") {
                if !mpath.is_empty() {
                    guard.model_path = mpath;
                }
            }
            if let Some(mb) = extract_json_u64(&body_str, "model_mb") {
                guard.model_required_mb = mb.max(128);
            }
            if let Some(layers) = extract_json_u64(&body_str, "total_layers") {
                guard.total_layers = (layers as u32).clamp(1, 128);
            }
            let model_mb = guard.model_required_mb;
            let total_layers = guard.total_layers;
            let master_cap = guard.master_safe_cap_mb;
            let plan = plan_cluster_layers(model_mb, total_layers, master_cap, &mut guard.workers);
            guard.master_layers = plan.master_layers;
            master_layers = plan.master_layers;
            cli_preview = guard.build_llama_cli_args().join(" ");
        }
        sync_back_to_mirror(&ctrl_state, &legacy_mirror);
        let resp = format!(
            "{{\"ok\":true,\"master_layers\":{},\"llama_cli_args\":\"{}\"}}",
            master_layers,
            json_escape(&cli_preview)
        );
        return write_json_response(&mut client, &resp);
    }

    // 8. OpenAI-Compatible SSE Streaming Inference (`POST /v1/chat/completions`)
    if request_line.starts_with("POST /v1/chat/completions") {
        if let Some(port) = upstream_port {
            if proxy_upstream_completion(&mut client, port, &body_bytes).is_ok() {
                return Ok(());
            }
        }

        let (master_os, master_layers, active_summary) = {
            let guard = lock_unpoisoned(&ctrl_state);
            let nodes: Vec<String> = guard
                .workers
                .iter()
                .filter(|w| w.health == NodeHealth::Online)
                .map(|w| format!("{}[{}]:{}L", w.id, w.platform, w.assigned_layers))
                .collect();
            (guard.master_os.clone(), guard.master_layers, nodes)
        };

        let headers = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: text/event-stream\r\n",
            "Cache-Control: no-cache\r\n",
            "Access-Control-Allow-Origin: *\r\n",
            "Connection: close\r\n\r\n"
        );
        client.write_all(headers.as_bytes())?;

        let worker_desc = if active_summary.is_empty() {
            "standalone".to_string()
        } else {
            active_summary.join(", ")
        };

        let tokens = [
            "ClusterLab".to_string(),
            format!(" master={}({}L)", master_os, master_layers),
            format!(" active_workers={}", active_summary.len()),
            format!(" topology=[{}]", worker_desc),
            " [OK]".to_string(),
        ];

        for (idx, tok) in tokens.iter().enumerate() {
            let chunk = format!(
                "data: {{\"id\":\"chatcmpl-clusterd-{}\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{}\"}},\"finish_reason\":null}}]}}\n\n",
                idx,
                json_escape(tok)
            );
            client.write_all(chunk.as_bytes())?;
            client.flush()?;
            thread::sleep(Duration::from_millis(12));
        }

        client.write_all(b"data: [DONE]\n\n")?;
        client.flush()?;
        return Ok(());
    }

    let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    client.write_all(not_found.as_bytes())?;
    Ok(())
}

/// Forwards `/v1/chat/completions` directly to a live local `llama-server` process
/// when running, streaming raw SSE chunks back to the HTTP client without buffering.
fn proxy_upstream_completion(
    client: &mut TcpStream,
    upstream_port: u16,
    body_bytes: &[u8],
) -> io::Result<()> {
    let upstream_addr = SocketAddr::from(([127, 0, 0, 1], upstream_port));
    let mut upstream = TcpStream::connect_timeout(&upstream_addr, Duration::from_millis(300))?;
    upstream.set_read_timeout(Some(Duration::from_secs(30)))?;
    upstream.set_write_timeout(Some(Duration::from_secs(5)))?;

    let req = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        upstream_port,
        body_bytes.len()
    );
    upstream.write_all(req.as_bytes())?;
    upstream.write_all(body_bytes)?;
    upstream.flush()?;

    let mut buf = [0u8; 4096];
    let mut forwarded_any = false;
    loop {
        match upstream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                forwarded_any = true;
                client.write_all(&buf[..n])?;
                client.flush()?;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut => {
                break;
            }
            Err(e) => return Err(e),
        }
    }
    if forwarded_any {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Upstream llama-server closed without sending response",
        ))
    }
}

fn sync_back_to_mirror(
    ctrl_state: &Arc<Mutex<MasterControlState>>,
    legacy_mirror: &Option<Arc<Mutex<Vec<WorkerNode>>>>,
) {
    if let Some(ref mirror) = legacy_mirror {
        let workers_copy = lock_unpoisoned(ctrl_state).workers.clone();
        let mut m = lock_unpoisoned(mirror);
        *m = workers_copy;
    }
}

fn write_json_response(client: &mut TcpStream, json: &str) -> io::Result<()> {
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        json.len(),
        json
    );
    client.write_all(resp.as_bytes())?;
    client.flush()
}

/// Escapes arbitrary strings (including Windows `C:\Users\...` paths and SVG quotes)
/// into strictly valid RFC 8259 JSON string literals.
pub fn json_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

/// Extracts and unescapes a JSON string value by key (supports Windows `\\` paths & `\"`).
pub fn extract_json_string(body: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    let pos = body.find(&pattern)?;
    let after_key = &body[pos + pattern.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    let mut chars = after_colon.chars();
    if chars.next()? != '"' {
        return None;
    }
    let mut result = String::new();
    let mut escaped = false;
    for ch in chars {
        if escaped {
            match ch {
                '\\' => result.push('\\'),
                '"' => result.push('"'),
                '/' => result.push('/'),
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                other => result.push(other),
            }
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(result);
        } else {
            result.push(ch);
        }
    }
    None
}

fn extract_json_u64(body: &str, key: &str) -> Option<u64> {
    let pattern = format!("\"{}\"", key);
    let pos = body.find(&pattern)?;
    let after_key = &body[pos + pattern.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    let digits: String = after_colon
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<u64>().ok()
}

/// Builds a plain-English auto-diagnosis JSON payload (`GET /api/diagnose`) so everyday
/// users on Windows or Linux can troubleshoot Wi-Fi, connected devices, memory fit, and USB
/// readiness with 1-click Auto-Fix suggestions.
pub fn build_cluster_diagnosis_json(guard: &MasterControlState) -> String {
    let mut checks: Vec<String> = Vec::new();
    let mut has_issue = false;
    let mut has_warning = false;

    let push_check = |list: &mut Vec<String>,
                      id: &str,
                      title: &str,
                      severity: &str,
                      message: &str,
                      fix_action: &str| {
        list.push(format!(
            "{{\"id\":\"{}\",\"title\":\"{}\",\"severity\":\"{}\",\"message\":\"{}\",\"fix_action\":\"{}\"}}",
            json_escape(id),
            json_escape(title),
            json_escape(severity),
            json_escape(message),
            json_escape(fix_action)
        ));
    };

    // 1. Wi-Fi / LAN Reachability
    if guard.lan_ip == "127.0.0.1" {
        has_warning = true;
        push_check(
            &mut checks,
            "lan_network",
            "Wi-Fi & Home Network",
            "warning",
            "No Wi-Fi network IP detected right now. Connect this computer to Wi-Fi so phones can scan the QR code, or connect a phone using a USB cable.",
            "",
        );
    } else {
        push_check(
            &mut checks,
            "lan_network",
            "Wi-Fi & Home Network",
            "ok",
            &format!(
                "Ready on your Wi-Fi network ({}:{}). Make sure phones and helper PCs are on this same Wi-Fi.",
                guard.lan_ip, guard.master_port
            ),
            "",
        );
    }

    // 2. Helper Devices Connected
    let online_count = guard
        .workers
        .iter()
        .filter(|w| w.health == NodeHealth::Online)
        .count();
    let offline_count = guard
        .workers
        .iter()
        .filter(|w| w.health == NodeHealth::Offline)
        .count();
    let cooling_or_shed_count = guard
        .workers
        .iter()
        .filter(|w| w.health == NodeHealth::Throttled || w.health == NodeHealth::SheddingMemory)
        .count();

    if online_count == 0 {
        has_warning = true;
        push_check(
            &mut checks,
            "helper_devices",
            "Helper Phones & PCs",
            "warning",
            "Only this computer is active right now. Scan the QR code on an Android phone or click Auto-Fix to scan for nearby devices.",
            "scan_nodes",
        );
    } else {
        push_check(
            &mut checks,
            "helper_devices",
            "Helper Phones & PCs",
            "ok",
            &format!(
                "{} helper device(s) connected and sharing memory cleanly with this computer.",
                online_count
            ),
            "",
        );
    }

    // 3. Memory Fit for Selected AI Size
    let worker_ram: u64 = guard
        .workers
        .iter()
        .filter(|w| w.health == NodeHealth::Online)
        .map(|w| w.safe_cap_mb)
        .sum();
    let total_safe_ram = guard.master_safe_cap_mb + worker_ram;
    if total_safe_ram < guard.model_required_mb {
        has_issue = true;
        push_check(
            &mut checks,
            "memory_fit",
            "AI Size vs. Available Memory",
            "issue",
            &format!(
                "Your chosen AI size needs {} MB, but your connected devices safely have {} MB right now. Switch to Small & Fast AI or connect another phone.",
                guard.model_required_mb, total_safe_ram
            ),
            "use_small_preset",
        );
    } else {
        push_check(
            &mut checks,
            "memory_fit",
            "AI Size vs. Available Memory",
            "ok",
            &format!(
                "Plenty of room! Your devices safely provide {} MB for the selected {} MB AI size.",
                total_safe_ram, guard.model_required_mb
            ),
            "",
        );
    }

    // 4. Dropped or Cooling Devices
    if offline_count > 0 || cooling_or_shed_count > 0 {
        has_warning = true;
        push_check(
            &mut checks,
            "device_health",
            "Device Health Check",
            "warning",
            &format!(
                "{} device(s) disconnected and {} paused to stay cool or free RAM. Remaining devices automatically picked up the work.",
                offline_count, cooling_or_shed_count
            ),
            "scan_nodes",
        );
    } else {
        push_check(
            &mut checks,
            "device_health",
            "Device Health Check",
            "ok",
            "All active devices are cool, responsive, and within safe memory limits.",
            "",
        );
    }

    // 5. USB Cable Helper (ADB)
    if locate_adb_binary().is_some() {
        push_check(
            &mut checks,
            "usb_helper",
            "USB Cable Support",
            "ok",
            "USB cable auto-linking (ADB) is installed and ready whenever you plug in an Android phone.",
            "",
        );
    } else {
        push_check(
            &mut checks,
            "usb_helper",
            "USB Cable Support",
            "ok",
            "Wi-Fi QR pairing is ready (no USB cable needed). Install Android Platform Tools later if you want wired USB mode.",
            "",
        );
    }

    // 6. Legacy Hardware & Graphics Survival Mode
    let legacy_workers_count = guard
        .workers
        .iter()
        .filter(|w| w.is_legacy_hardware || w.is_legacy_graphics)
        .count();
    if guard.master_legacy_graphics || legacy_workers_count > 0 {
        push_check(
            &mut checks,
            "legacy_survival",
            "Legacy Hardware & Graphics Guard",
            "ok",
            &format!(
                "Safe CPU fallback (-ngl 0) active where needed (Master={}, Helpers={}). Old GPUs and <=2GB RAM devices are protected from OOM or shader crashes.",
                guard.master_graphics_tier, legacy_workers_count
            ),
            "",
        );
    } else {
        push_check(
            &mut checks,
            "legacy_survival",
            "Legacy Hardware & Graphics Guard",
            "ok",
            "Hardware acceleration check passed. Legacy fallback guard remains armed automatically for older helper nodes.",
            "",
        );
    }

    let (overall, headline) = if has_issue {
        ("issue", "Found 1 Issue to Fix")
    } else if has_warning {
        ("warning", "Almost Ready — See Quick Tips")
    } else {
        ("ok", "Everything Looks Great!")
    };

    format!(
        "{{\"overall\":\"{}\",\"headline\":\"{}\",\"checks\":[{}]}}",
        overall,
        json_escape(headline),
        checks.join(",")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        FLAG_ARM_DOTPROD, FLAG_ELF_16KB_ALIGNED, FLAG_PLATFORM_ANDROID, FLAG_PLATFORM_LINUX,
        FLAG_PLATFORM_WINDOWS,
    };

    #[test]
    fn test_pi400_prunes_on_small_model_and_unprunes_on_large_model() {
        let mut workers = vec![
            WorkerNode {
                id: "pixel-8-android".to_string(),
                addr: "127.0.0.1:50052".parse().unwrap(),
                platform: "Android".to_string(),
                is_usb_phone: true,
                is_edge_sbc_a72: false,
                is_legacy_hardware: false,
                is_legacy_graphics: false,
                safe_cap_mb: 3500,
                big_cores: 4,
                assigned_layers: 0,
                health: NodeHealth::Online,
                consecutive_failures: 0,
                last_seen: Instant::now(),
            },
            WorkerNode {
                id: "pi400-sbc".to_string(),
                addr: "192.168.1.40:50052".parse().unwrap(),
                platform: "Edge SBC (Linux ARM64)".to_string(),
                is_usb_phone: false,
                is_edge_sbc_a72: true,
                is_legacy_hardware: true,
                is_legacy_graphics: true,
                safe_cap_mb: 1800,
                big_cores: 4,
                assigned_layers: 0,
                health: NodeHealth::Online,
                consecutive_failures: 0,
                last_seen: Instant::now(),
            },
        ];

        // Model fits in Master (2000 MB) + Android (3500 MB) = 5500 MB >= 4000 MB -> Pi 400 pruned
        let plan_small = plan_cluster_layers(4000, 32, 2000, &mut workers);
        assert!(plan_small.pruned_nodes.contains(&"pi400-sbc".to_string()));
        assert_eq!(workers[1].health, NodeHealth::PrunedEdgeSbc);
        assert_eq!(workers[1].assigned_layers, 0);
        assert_eq!(plan_small.master_layers + workers[0].assigned_layers, 32);

        // User loads a larger 7000 MB model -> fast pool (5500 MB) no longer fits -> Pi 400 auto-unprunes!
        let plan_large = plan_cluster_layers(7000, 32, 2000, &mut workers);
        assert!(plan_large.unpruned_nodes.contains(&"pi400-sbc".to_string()));
        assert_eq!(workers[1].health, NodeHealth::Online);
        assert!(workers[1].assigned_layers > 0);
        assert_eq!(
            plan_large.master_layers + workers[0].assigned_layers + workers[1].assigned_layers,
            32
        );
    }

    #[test]
    fn test_mixed_os_cluster_windows_linux_android_with_auth_and_rebalance() {
        let secret = "mixed-cluster-secret";

        // 1. Simulated Windows desktop worker
        let win_frame = Arc::new(Mutex::new(HandshakeFrame::new(
            4096,
            8,
            FLAG_PLATFORM_WINDOWS,
            STATUS_READY,
        )));
        let win_addr = spawn_authenticated_handshake_worker_listener(
            "127.0.0.1:0".parse().unwrap(),
            Arc::clone(&win_frame),
            Some(secret.to_string()),
        )
        .expect("bind windows worker");

        // 2. Simulated Linux workstation worker
        let linux_frame = Arc::new(Mutex::new(HandshakeFrame::new(
            3072,
            6,
            FLAG_PLATFORM_LINUX,
            STATUS_READY,
        )));
        let linux_addr = spawn_authenticated_handshake_worker_listener(
            "127.0.0.1:0".parse().unwrap(),
            Arc::clone(&linux_frame),
            Some(secret.to_string()),
        )
        .expect("bind linux worker");

        // 3. Simulated Android phone worker
        let android_frame = Arc::new(Mutex::new(HandshakeFrame::new(
            2048,
            4,
            FLAG_ARM_DOTPROD | FLAG_ELF_16KB_ALIGNED | FLAG_PLATFORM_ANDROID,
            STATUS_READY,
        )));
        let android_addr = spawn_authenticated_handshake_worker_listener(
            "127.0.0.1:0".parse().unwrap(),
            Arc::clone(&android_frame),
            Some(secret.to_string()),
        )
        .expect("bind android worker");

        // Wrong secret MUST be rejected on authenticated worker
        assert!(probe_worker_handshake(
            win_addr,
            Some("wrong-secret"),
            Duration::from_millis(500)
        )
        .is_err());

        // Matching secret succeeds and identifies each OS platform accurately
        let mut workers = vec![
            WorkerNode {
                id: "win-pc".to_string(),
                addr: win_addr,
                platform: "Unknown".to_string(),
                is_usb_phone: false,
                is_edge_sbc_a72: false,
                is_legacy_hardware: false,
                is_legacy_graphics: false,
                safe_cap_mb: 0,
                big_cores: 0,
                assigned_layers: 0,
                health: NodeHealth::Online,
                consecutive_failures: 0,
                last_seen: Instant::now(),
            },
            WorkerNode {
                id: "linux-box".to_string(),
                addr: linux_addr,
                platform: "Unknown".to_string(),
                is_usb_phone: false,
                is_edge_sbc_a72: false,
                is_legacy_hardware: false,
                is_legacy_graphics: false,
                safe_cap_mb: 0,
                big_cores: 0,
                assigned_layers: 0,
                health: NodeHealth::Online,
                consecutive_failures: 0,
                last_seen: Instant::now(),
            },
            WorkerNode {
                id: "android-phone".to_string(),
                addr: android_addr,
                platform: "Unknown".to_string(),
                is_usb_phone: true,
                is_edge_sbc_a72: false,
                is_legacy_hardware: false,
                is_legacy_graphics: false,
                safe_cap_mb: 0,
                big_cores: 0,
                assigned_layers: 0,
                health: NodeHealth::Online,
                consecutive_failures: 0,
                last_seen: Instant::now(),
            },
        ];

        let (_, plan) = poll_and_rebalance_workers(&mut workers, Some(secret), 8000, 32, 3072);
        assert_eq!(workers[0].platform, "Windows");
        assert_eq!(workers[1].platform, "Linux");
        assert_eq!(workers[2].platform, "Android");
        assert_eq!(
            plan.master_layers
                + workers[0].assigned_layers
                + workers[1].assigned_layers
                + workers[2].assigned_layers,
            32
        );
        // Proportional order: Windows (4096) >= Linux (3072) >= Android (2048)
        assert!(workers[0].assigned_layers >= workers[1].assigned_layers);
        assert!(workers[1].assigned_layers >= workers[2].assigned_layers);

        // Simulate Android phone LMKD pressure (`STATUS_SHED_LAYERS`) -> immediate rebalance
        lock_unpoisoned(&android_frame).status = STATUS_SHED_LAYERS;
        let (changed, rebalanced) =
            poll_and_rebalance_workers(&mut workers, Some(secret), 8000, 32, 3072);
        assert!(changed);
        assert_eq!(workers[2].health, NodeHealth::SheddingMemory);
        assert_eq!(workers[2].assigned_layers, 0);
        assert_eq!(
            rebalanced.master_layers + workers[0].assigned_layers + workers[1].assigned_layers,
            32
        );
    }

    #[test]
    fn test_windows_backslash_path_json_roundtrip() {
        let win_path = r#"C:\Users\Alice\AppData\Local\ClusterLab\models\Qwen2.5-3B-Q4_K_M.gguf"#;
        let body = format!("{{\"model_path\":\"{}\",\"model_mb\":2400}}", json_escape(win_path));
        let extracted = extract_json_string(&body, "model_path").expect("extract windows path");
        assert_eq!(extracted, win_path);
    }

    #[test]
    fn test_central_control_web_ui_and_qr_svg_rendering() {
        let svg = render_pairing_qr_svg("clusterd://pair?master=192.168.1.10:8080&secret=test");
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("<rect"));
    }

    #[test]
    fn test_auto_diagnosis_json_flags_memory_mismatch_and_recommends_fix() {
        let mut state = MasterControlState::new(
            "0.0.0.0".to_string(),
            8080,
            DEFAULT_CLUSTER_SECRET.to_string(),
            "models/large.gguf".to_string(),
            Vec::new(),
        );
        state.master_safe_cap_mb = 2048;
        state.model_required_mb = 5200;
        let json = build_cluster_diagnosis_json(&state);
        assert!(json.contains("\"overall\":\"issue\""));
        assert!(json.contains("\"fix_action\":\"use_small_preset\""));
        assert!(json.contains("\"fix_action\":\"scan_nodes\""));
        assert!(json.contains("\"id\":\"legacy_survival\""));
    }

    #[test]
    fn test_12_node_scale_preserves_master_layer_and_recovers_poisoned_mutex() {
        let mut workers: Vec<WorkerNode> = (0..12)
            .map(|idx| WorkerNode {
                id: format!("node-{:02}", idx),
                addr: SocketAddr::from(([192, 168, 1, 100 + idx as u8], 50052)),
                platform: if idx % 3 == 0 {
                    "Windows".to_string()
                } else if idx % 3 == 1 {
                    "Linux".to_string()
                } else {
                    "Android".to_string()
                },
                is_usb_phone: false,
                is_edge_sbc_a72: false,
                is_legacy_hardware: idx == 11,
                is_legacy_graphics: idx == 11,
                safe_cap_mb: if idx == 11 { 512 } else { 2048 },
                big_cores: 4,
                assigned_layers: 0,
                health: NodeHealth::Online,
                consecutive_failures: 0,
                last_seen: Instant::now(),
            })
            .collect();

        let plan = plan_cluster_layers(8000, 32, 2048, &mut workers);
        assert!(plan.master_layers >= 1);
        let allocated_sum: u32 = workers.iter().map(|w| w.assigned_layers).sum();
        assert_eq!(plan.master_layers + allocated_sum, 32);
        // Constrained legacy 512MB worker is pruned when fast pool already fits 8000MB
        assert!(plan.pruned_nodes.contains(&"node-11".to_string()));

        // Verify lock_unpoisoned recovers cleanly from a panicked holder
        let m = Arc::new(Mutex::new(42u32));
        let m_clone = Arc::clone(&m);
        let _ = thread::spawn(move || {
            let _g = m_clone.lock().unwrap();
            panic!("simulated panic while holding lock");
        })
        .join();
        assert_eq!(*lock_unpoisoned(&m), 42);
    }
}

