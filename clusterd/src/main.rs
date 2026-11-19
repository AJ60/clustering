use clusterd::orchestrator::{
    discover_master_via_udp, poll_and_rebalance_workers,
    spawn_authenticated_handshake_worker_listener, spawn_central_control_gateway,
    spawn_udp_discovery_responder, MasterControlState, NodeHealth, WorkerNode, UDP_DISCOVERY_PORT,
};
use clusterd::protocol::{
    probe_worker_handshake, HandshakeFrame, DEFAULT_CLUSTER_SECRET, FLAG_ARM_DOTPROD,
    FLAG_ELF_16KB_ALIGNED, FLAG_LEGACY_GRAPHICS, FLAG_LEGACY_HARDWARE, FLAG_SBC_CORTEX_A72,
    STATUS_READY,
};
use clusterd::supervisor::ManagedProcessGroup;
use clusterd::sys_probe::{
    check_windows_firewall_ports, locate_adb_binary, probe_hardware_profile, recommended_child_env,
};
use std::env;
use std::io::Write;
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn parse_sock_addr(raw: &str, label: &str) -> SocketAddr {
    match raw.parse::<SocketAddr>() {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!("[clusterd] Invalid {} '{}': {}", label, raw, e);
            std::process::exit(1);
        }
    }
}

fn print_usage() {
    println!("ClusterLab clusterd v{} (MIT, Author: AJ60)", env!("CARGO_PKG_VERSION"));
    println!("Usage: clusterd <auto | probe | worker | master | verify-handshake> [options]");
    println!("  auto              Zero-config: auto-join LAN Master via UDP :50050, or promote to Master");
    println!("  probe             Inspect hardware, legacy RAM/GPU safeguards, and LAN IP");
    println!("  worker            Start GGUF RPC v9 worker listener (--host, --port, --master, --threads, --max-mem-mb, --secret, --rpc-bin)");
    println!("  master            Start Master orchestrator + Web UI (--host, --port, --workers, --model, --secret, --llama-bin, --dry-run)");
    println!("  verify-handshake  Probe a worker endpoint and verify the 32-byte GGUF v9 handshake");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let subcmd = args.first().map(|s| s.as_str()).unwrap_or("probe");

    match subcmd {
        "--help" | "-h" | "help" => print_usage(),
        "--version" | "-V" => println!("clusterd {}", env!("CARGO_PKG_VERSION")),
        "auto" => run_auto_cmd(&args[1..]),
        "probe" => run_probe_cmd(),
        "worker" => run_worker_cmd(&args[1..]),
        "master" => run_master_cmd(&args[1..]),
        "verify-handshake" => run_verify_handshake_cmd(&args[1..]),
        _ => {
            print_usage();
            std::process::exit(1);
        }
    }
}

fn run_probe_cmd() {
    let hw = probe_hardware_profile();
    let adb = locate_adb_binary();

    println!("=== clusterd Hardware & Safety Probe ===");
    println!(
        "Platform OS  : {} / {} (32-bit={}, LAN IP: {})",
        hw.os_name, hw.arch, hw.is_32_bit, hw.lan_ip
    );
    println!(
        "Physical RAM : Total={} MB, Available={} MB -> SafeCap={} MB ({})",
        hw.memory.total_phys_mb,
        hw.memory.avail_phys_mb,
        hw.memory.safe_cap_mb,
        if hw.memory.total_phys_mb <= 2048 {
            "<= 40% Legacy Cap"
        } else {
            "<= 50% Cap"
        }
    );
    println!(
        "CPU Topology : {} | TotalCores={}, BigPerformanceCores={:?}",
        hw.cpu_model, hw.cpu.total_logical_cores, hw.cpu.big_performance_cores
    );
    println!(
        "Graphics     : {} | Vulkan={} | Tier={} | Backend={}",
        hw.gpu_name, hw.has_vulkan, hw.graphics_tier, hw.recommended_backend
    );
    println!(
        "Legacy Guard : LegacyHW={}, LegacyGfx={}, ngl={}, ctx={}",
        hw.legacy_hardware, hw.legacy_graphics, hw.recommended_ngl, hw.recommended_ctx_size
    );
    println!(
        "ISA Features : ARM_DotProd={}, ARM_I8MM={}, Pi400_CortexA72={}",
        hw.cpu.has_arm_dotprod, hw.cpu.has_arm_i8mm, hw.cpu.is_raspberry_pi_400_cortex_a72
    );
    if let Some(temp) = hw.cpu.sbc_temp_celsius {
        println!(
            "Thermal Info : {:.1} C (throttled_bits=0x{:x})",
            temp, hw.cpu.sbc_throttled_bits
        );
    }
    if cfg!(target_os = "windows") {
        match check_windows_firewall_ports() {
            Ok(open) => println!("Win Firewall : ClusterLab rules present={}", open),
            Err(e) => println!("Win Firewall : Check skipped ({})", e),
        }
    }
    if let Some(adb_path) = adb {
        println!("ADB Binary   : {}", adb_path.display());
    }
}

fn run_auto_cmd(args: &[String]) {
    let mut role = "auto".to_string();
    let mut forward_args: Vec<String> = Vec::new();
    let mut explicit_secret: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--role" if i + 1 < args.len() => {
                role = args[i + 1].to_lowercase();
                i += 2;
            }
            "--secret" if i + 1 < args.len() => {
                explicit_secret = Some(args[i + 1].clone());
                forward_args.push(args[i].clone());
                forward_args.push(args[i + 1].clone());
                i += 2;
            }
            other => {
                forward_args.push(other.to_string());
                i += 1;
            }
        }
    }

    match role.as_str() {
        "master" => {
            println!("[clusterd auto] Role forced to MASTER.");
            run_master_cmd(&forward_args);
        }
        "worker" => {
            if !forward_args.iter().any(|a| a == "--master") {
                if let Some((master_sock, discovered_secret, _)) =
                    discover_master_via_udp(Duration::from_millis(1500))
                {
                    println!(
                        "[clusterd auto] Discovered Master at {} via UDP :{}",
                        master_sock, UDP_DISCOVERY_PORT
                    );
                    forward_args.push("--master".to_string());
                    forward_args.push(master_sock.to_string());
                    if explicit_secret.is_none() {
                        forward_args.push("--secret".to_string());
                        forward_args.push(discovered_secret);
                    }
                } else {
                    println!(
                        "[clusterd auto] No Master replied on UDP :{}; starting standalone worker listener.",
                        UDP_DISCOVERY_PORT
                    );
                }
            }
            run_worker_cmd(&forward_args);
        }
        _ => {
            println!(
                "[clusterd auto] Probing LAN UDP :{} for an existing ClusterLab Master...",
                UDP_DISCOVERY_PORT
            );
            if let Some((master_sock, discovered_secret, _)) =
                discover_master_via_udp(Duration::from_millis(1500))
            {
                println!(
                    "[clusterd auto] Found active Master at {} -> joining automatically as WORKER.",
                    master_sock
                );
                forward_args.push("--master".to_string());
                forward_args.push(master_sock.to_string());
                if explicit_secret.is_none() {
                    forward_args.push("--secret".to_string());
                    forward_args.push(discovered_secret);
                }
                run_worker_cmd(&forward_args);
            } else {
                println!("[clusterd auto] No Master detected -> promoting this node to MASTER.");
                run_master_cmd(&forward_args);
            }
        }
    }
}

fn run_worker_cmd(args: &[String]) {
    let mut host = "0.0.0.0".to_string();
    let mut port: u16 = 50052;
    let mut rpc_bin: Option<String> = None;
    let mut duration_secs: Option<u64> = None;
    let mut threads_override: Option<usize> = None;
    let mut max_mem_mb_override: Option<u64> = None;
    let mut secret: Option<String> = None;
    let mut master_addr: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--host" | "-H" if i + 1 < args.len() => {
                host = args[i + 1].clone();
                i += 2;
            }
            "--port" | "-p" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(50052);
                i += 2;
            }
            "--rpc-bin" if i + 1 < args.len() => {
                rpc_bin = Some(args[i + 1].clone());
                i += 2;
            }
            "--threads" | "-t" if i + 1 < args.len() => {
                threads_override = args[i + 1].parse().ok();
                i += 2;
            }
            "--max-mem-mb" | "-m" if i + 1 < args.len() => {
                max_mem_mb_override = args[i + 1].parse().ok();
                i += 2;
            }
            "--secret" if i + 1 < args.len() => {
                secret = Some(args[i + 1].clone());
                i += 2;
            }
            "--master" if i + 1 < args.len() => {
                master_addr = Some(args[i + 1].clone());
                i += 2;
            }
            "--duration-secs" if i + 1 < args.len() => {
                duration_secs = args[i + 1].parse().ok();
                i += 2;
            }
            _ => i += 1,
        }
    }

    let hw = probe_hardware_profile();

    // Never allow --max-mem-mb to exceed the strict <=50% (<=40% legacy) physical RAM safety cap
    let effective_safe_cap_mb = match max_mem_mb_override {
        Some(req) => req.min(hw.memory.safe_cap_mb).max(128),
        None => hw.memory.safe_cap_mb,
    };
    let effective_threads = match threads_override {
        Some(req) => req.clamp(1, hw.cpu.total_logical_cores.max(1)),
        None => hw.cpu.big_performance_cores.len().max(1),
    };

    let mut flags = FLAG_ELF_16KB_ALIGNED | HandshakeFrame::current_os_platform_flag();
    if hw.cpu.has_arm_dotprod {
        flags |= FLAG_ARM_DOTPROD;
    }
    if hw.cpu.is_raspberry_pi_400_cortex_a72 {
        flags |= FLAG_SBC_CORTEX_A72;
    }
    if hw.legacy_hardware {
        flags |= FLAG_LEGACY_HARDWARE;
    }
    if hw.legacy_graphics {
        flags |= FLAG_LEGACY_GRAPHICS;
    }

    let frame = Arc::new(Mutex::new(HandshakeFrame::new(
        effective_safe_cap_mb as u32,
        effective_threads as u32,
        flags,
        STATUS_READY,
    )));

    let mut supervisor = match ManagedProcessGroup::new() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[clusterd worker] Failed to initialize process supervisor: {}", e);
            std::process::exit(1);
        }
    };

    if let Some(bin) = rpc_bin {
        let rpc_port = port.saturating_add(100);
        let child_args = vec![
            "-H".to_string(),
            host.clone(),
            "-p".to_string(),
            rpc_port.to_string(),
            "-t".to_string(),
            effective_threads.to_string(),
            "-c".to_string(),
        ];
        let child_envs = recommended_child_env(hw.legacy_graphics);
        match supervisor.spawn_managed_with_env(&bin, &child_args, &child_envs) {
            Ok(pid) => println!(
                "[clusterd worker] Spawned managed rpc-server (PID {}) on {}:{} (-t {}, tier={})",
                pid, host, rpc_port, effective_threads, hw.graphics_tier
            ),
            Err(e) => eprintln!(
                "[clusterd worker] Warning: failed to spawn '{}' ({}); handshake listener still active.",
                bin, e
            ),
        }
    }

    let bind_addr = parse_sock_addr(&format!("{}:{}", host, port), "worker bind address");
    let required_secret = if bind_addr.ip().is_loopback() && secret.is_none() {
        None
    } else {
        Some(secret.unwrap_or_else(|| DEFAULT_CLUSTER_SECRET.to_string()))
    };

    let actual_addr = match spawn_authenticated_handshake_worker_listener(
        bind_addr,
        Arc::clone(&frame),
        required_secret.clone(),
    ) {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!("[clusterd worker] Failed to bind handshake listener on {}: {}", bind_addr, e);
            std::process::exit(1);
        }
    };

    println!(
        "[clusterd worker] Platform={}/{} | Listening on {} (LAN {}:{}) | SafeCap={} MB | Threads={} | Tier={} | Auth={}",
        hw.os_name,
        hw.arch,
        actual_addr,
        hw.lan_ip,
        actual_addr.port(),
        effective_safe_cap_mb,
        effective_threads,
        hw.graphics_tier,
        if required_secret.is_some() {
            "32-byte Keyed Token"
        } else {
            "USB Loopback"
        }
    );

    // Register with remote Master AFTER binding the TCP listener so Master's immediate
    // handshake probe succeeds on the very first attempt (works across Windows <-> Linux).
    if let Some(ref master) = master_addr {
        register_worker_with_master(master, hw.lan_ip, actual_addr.port());
    }

    if let Some(secs) = duration_secs {
        thread::sleep(Duration::from_secs(secs));
    } else {
        loop {
            thread::sleep(Duration::from_secs(2));
        }
    }
}

/// Registers a Windows/Linux/macOS worker with a remote Master node via both UDP :50050
/// and HTTP `POST /api/nodes/add` fallback so mixed-OS clusters pair reliably across subnets.
fn register_worker_with_master(
    master_arg: &str,
    local_lan_ip: std::net::Ipv4Addr,
    worker_port: u16,
) {
    let master_host = master_arg.split(':').next().unwrap_or(master_arg);
    let master_http_port: u16 = master_arg
        .split(':')
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    // 1. Send UDP registration beacon to Master :50050
    if let Ok(udp) = UdpSocket::bind("0.0.0.0:0") {
        let _ = udp.set_broadcast(true);
        let msg = format!("CLUSTERD_REGISTER:{}", worker_port);
        let target = format!("{}:{}", master_host, UDP_DISCOVERY_PORT);
        let _ = udp.send_to(msg.as_bytes(), &target);
    }

    // 2. Also send HTTP POST /api/nodes/add fallback (works even if UDP 50050 is filtered)
    if let Ok(master_sock) = format!("{}:{}", master_host, master_http_port).parse::<SocketAddr>() {
        if let Ok(mut stream) = TcpStream::connect_timeout(&master_sock, Duration::from_secs(2)) {
            let advertise_ip = if master_sock.ip().is_loopback() {
                "127.0.0.1".to_string()
            } else {
                local_lan_ip.to_string()
            };
            let body = format!("{{\"addr\":\"{}:{}\"}}", advertise_ip, worker_port);
            let req = format!(
                "POST /api/nodes/add HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                master_host,
                master_http_port,
                body.len(),
                body
            );
            let _ = stream.write_all(req.as_bytes());
            let _ = stream.flush();
            println!(
                "[clusterd worker] Registered {}:{} with Master {}:{}",
                advertise_ip, worker_port, master_host, master_http_port
            );
        }
    }
}

fn run_master_cmd(args: &[String]) {
    let mut host = "0.0.0.0".to_string();
    let mut port: u16 = 8080;
    let mut workers_csv = String::new();
    let mut model_path = "models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf".to_string();
    let mut cluster_secret = DEFAULT_CLUSTER_SECRET.to_string();
    let mut llama_bin: Option<String> = None;
    let mut duration_secs: Option<u64> = None;
    let mut dry_run = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--host" | "-H" if i + 1 < args.len() => {
                host = args[i + 1].clone();
                i += 2;
            }
            "--port" | "-p" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(8080);
                i += 2;
            }
            "--workers" if i + 1 < args.len() => {
                workers_csv = args[i + 1].clone();
                i += 2;
            }
            "--model" | "-m" if i + 1 < args.len() => {
                model_path = args[i + 1].clone();
                i += 2;
            }
            "--secret" if i + 1 < args.len() => {
                cluster_secret = args[i + 1].clone();
                i += 2;
            }
            "--llama-bin" if i + 1 < args.len() => {
                llama_bin = Some(args[i + 1].clone());
                i += 2;
            }
            "--duration-secs" if i + 1 < args.len() => {
                duration_secs = args[i + 1].parse().ok();
                i += 2;
            }
            "--dry-run" => {
                dry_run = true;
                i += 1;
            }
            _ => i += 1,
        }
    }

    let hw = probe_hardware_profile();
    let initial_workers: Vec<WorkerNode> = workers_csv
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .enumerate()
        .filter_map(|(idx, raw)| {
            raw.trim().parse::<SocketAddr>().ok().map(|addr| WorkerNode {
                id: format!("worker-{}", idx + 1),
                addr,
                platform: "Mixed Node".to_string(),
                is_usb_phone: addr.ip().is_loopback(),
                is_edge_sbc_a72: false,
                is_legacy_hardware: false,
                is_legacy_graphics: false,
                safe_cap_mb: 1024,
                big_cores: 4,
                assigned_layers: 0,
                health: NodeHealth::Online,
                consecutive_failures: 0,
                last_seen: Instant::now(),
            })
        })
        .collect();

    let mut state = MasterControlState::new(
        host.clone(),
        port,
        cluster_secret.clone(),
        model_path.clone(),
        initial_workers,
    );

    let (_, initial_plan) = poll_and_rebalance_workers(
        &mut state.workers,
        Some(&cluster_secret),
        state.model_required_mb,
        state.total_layers,
        state.master_safe_cap_mb,
    );
    state.master_layers = initial_plan.master_layers;

    let cli_args = state.build_llama_cli_args();
    println!(
        "[clusterd master] Platform={}/{} | LAN IP={} | SafeCap={} MB | Graphics={}",
        state.master_os,
        state.master_arch,
        state.lan_ip,
        state.master_safe_cap_mb,
        state.master_graphics_tier
    );
    println!(
        "[clusterd master] Validated llama-server v1.0.0 CLI flags: {}",
        cli_args.join(" ")
    );

    if dry_run {
        return;
    }

    let mut supervisor = match ManagedProcessGroup::new() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[clusterd master] Failed to initialize process supervisor: {}", e);
            std::process::exit(1);
        }
    };
    let mut upstream_port = None;
    if let Some(bin) = llama_bin {
        if std::path::Path::new(&bin).is_file() && std::path::Path::new(&model_path).is_file() {
            let child_envs = recommended_child_env(hw.legacy_graphics);
            if let Ok(pid) = supervisor.spawn_managed_with_env(&bin, &cli_args, &child_envs) {
                println!(
                    "[clusterd master] Spawned llama-server (PID {}, tier={})",
                    pid, hw.graphics_tier
                );
                upstream_port = Some(port.saturating_add(1));
            }
        }
    }

    let shared_state = Arc::new(Mutex::new(state));

    // Start UDP :50050 Auto-Discovery Beacon for Android, Windows, Linux & Pi 400 nodes
    match spawn_udp_discovery_responder(port, cluster_secret.clone(), Arc::clone(&shared_state)) {
        Ok(udp_addr) => {
            println!(
                "[clusterd master] UDP Auto-Discovery Beacon active on {}",
                udp_addr
            );
        }
        Err(e) => {
            eprintln!(
                "[clusterd master] Warning: UDP :{} discovery bind skipped ({}). HTTP QR/manual pairing still active.",
                UDP_DISCOVERY_PORT, e
            );
        }
    }

    let bind_addr = parse_sock_addr(&format!("{}:{}", host, port), "master bind address");
    let gw_addr = match spawn_central_control_gateway(
        bind_addr,
        Arc::clone(&shared_state),
        None,
        upstream_port,
    ) {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!("[clusterd master] Failed to start HTTP/SSE gateway on {}: {}", bind_addr, e);
            std::process::exit(1);
        }
    };

    let pairing_uri = lock_unpoisoned(&shared_state).pairing_uri();
    println!(
        "[clusterd master] Central Control Web UI & OpenAI SSE Gateway listening on http://{}",
        gw_addr
    );
    println!("[clusterd master] QR Pairing URI: {}", pairing_uri);

    let start = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(1500));
        {
            let mut guard = lock_unpoisoned(&shared_state);
            let model_mb = guard.model_required_mb;
            let total_layers = guard.total_layers;
            let master_cap = guard.master_safe_cap_mb;
            let secret = guard.cluster_secret.clone();
            let (changed, plan) = poll_and_rebalance_workers(
                &mut guard.workers,
                Some(&secret),
                model_mb,
                total_layers,
                master_cap,
            );
            guard.master_layers = plan.master_layers;
            if changed {
                println!(
                    "[clusterd master] Rebalanced cluster in <6s: master_layers={}, active_workers={}",
                    plan.master_layers,
                    plan.worker_allocations.len()
                );
            }
        }
        if let Some(max_secs) = duration_secs {
            if start.elapsed() >= Duration::from_secs(max_secs) {
                break;
            }
        }
    }
}

fn run_verify_handshake_cmd(args: &[String]) {
    let mut target = "127.0.0.1:50052".to_string();
    let mut secret: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--secret" if i + 1 < args.len() => {
                secret = Some(args[i + 1].clone());
                i += 2;
            }
            arg if !arg.starts_with('-') => {
                target = arg.to_string();
                i += 1;
            }
            _ => i += 1,
        }
    }

    let addr = parse_sock_addr(&target, "verify-handshake target");
    match probe_worker_handshake(addr, secret.as_deref(), Duration::from_secs(3)) {
        Ok(frame) => {
            println!(
                "[VERIFY OK] 32-Byte GGUF RPC v{} ({}) • Platform={} • SafeCap={} MB • BigCores={} • LegacyHW={} • LegacyGfx={} • Flags=0x{:x} • Status={}",
                frame.protocol_version,
                frame.llama_version,
                frame.platform_label(),
                frame.safe_cap_mb,
                frame.big_cores,
                frame.is_legacy_hardware(),
                frame.is_legacy_graphics(),
                frame.flags,
                frame.status
            );
            if frame.safe_cap_mb == 0 {
                eprintln!("[VERIFY FAILED] Worker safe_cap_mb must be strictly positive");
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!(
                "[VERIFY FAILED] Could not complete 32-byte GGUF handshake with {}: {}",
                addr, e
            );
            std::process::exit(1);
        }
    }
}
