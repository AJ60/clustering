mod adb_tunnel;
mod backend;
mod hw_probe;
mod learner;
mod net_probe;
mod ngram_drafter;
mod serving;
mod speculation;
mod strength_profiler;
mod thermal_balancer;
mod tier_planner;
mod topology;
mod web_ui;
mod worker;

use adb_tunnel::AdbTunnelManager;
use backend::{AutoDetectedBackend, ComputeBackend};
use hw_probe::log_event;
use learner::ClusterLearner;
use net_probe::{
    discover_wifi_multicast, probe_spoke_link, LLAMA_TAG_PIN, RPC_VERSION_PIN,
};
use serving::spawn_llama_server;
use strength_profiler::{elect_master_node_id, run_startup_strength_profiler};
use thermal_balancer::{read_local_sensors, ThermalBalancer};
use tier_planner::{
    compute_cluster_plan_with_state, inspect_gguf_header, scan_models_directory, ClusterConfig,
    NodeStatus, SpokeTelemetry,
};
use topology::{check_drop_resilient_health, deduplicate_by_link_priority};
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use web_ui::{serve_http, ClusterState};
use worker::{ChildGuard, WorkerDaemon};

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cfg = ClusterConfig::load_or_default("cluster_config.json");
    let local_id = env::var("CLUSTER_NODE_ID").unwrap_or_else(|_| "master-hub".to_string());
    let bench = run_startup_strength_profiler(
        &local_id,
        cfg.android_ram_cap_pct,
        cfg.desktop_ram_cap_pct,
        cfg.vram_cap_pct,
        cfg.os_reserve_mb,
        cfg.experimental_fork_enabled && cfg.allow_android_over_50,
    );

    // Zero-config mode resolution: if no args passed, auto-elect (Android APK defaults to Worker unless forced)
    let cli_mode = args.get(1).map(|s| s.as_str());
    let auto_mode = if cfg.role_override == "worker" || (cfg.role_override == "auto" && bench.is_android) {
        "worker"
    } else {
        "master"
    };
    let mode = cli_mode.unwrap_or(auto_mode);
    let running = Arc::new(AtomicBool::new(true));

    match mode {
        "worker" => {
            let node_id = args.get(2).cloned().unwrap_or(local_id);
            let rpc_port: u16 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(50052);
            // Loopback default (127.0.0.1) blocks unauthenticated ggml-rpc exposure (CVE-2026-118375/119052);
            // pass --lan or CLUSTER_RPC_BIND=0.0.0.0 only on trusted LAN/Hotspot links.
            let rpc_bind = if args.iter().any(|a| a == "--lan") {
                "0.0.0.0".to_string()
            } else {
                env::var("CLUSTER_RPC_BIND").unwrap_or_else(|_| "127.0.0.1".to_string())
            };
            let mut daemon = WorkerDaemon::new(
                node_id.clone(),
                rpc_port,
                rpc_bind,
                cfg.android_ram_cap_pct,
            );
            let backend =
                AutoDetectedBackend::detect_with_preference(&cfg.backend_preference).capability();
            let rpc_bin = env::var("RPC_SERVER_BIN").unwrap_or(backend.rpc_bin);
            if let Err(err) = daemon.start_rpc_server(&rpc_bin) {
                log_event("WARNING", &node_id, "WORKER", "RPC_SKIP", &err, "");
            }
            daemon.run_probe_responder(50051, Arc::clone(&running));
        }
        _ => {
            let mut adb_mgr = AdbTunnelManager::new(&local_id);
            let usb_spokes = adb_mgr.setup_usb_forwards(50052);
            let wifi_spokes = discover_wifi_multicast(&local_id, 300);
            let local_sensors = read_local_sensors(bench.is_android);

            let now = epoch_secs();
            let mut raw_nodes = vec![SpokeTelemetry {
                node_id: local_id.clone(),
                is_master: true,
                is_android: bench.is_android,
                os: bench.os.clone(),
                isa: bench.isa.clone(),
                silicon: bench.silicon.clone(),
                endpoint: "127.0.0.1:50052".into(),
                link_type: "local".into(),
                perf_cores: bench.perf_cores,
                ram_total_mb: bench.ram_total_mb,
                ram_avail_mb: bench.ram_avail_mb,
                safe_cap_mb: bench.safe_cap_mb,
                vram_total_free_mb: bench.vram_total_free_mb,
                vram_safe_mb: bench.vram_safe_mb,
                compute_tflops: bench.compute_tflops,
                mem_bw_gbps: bench.mem_bw_gbps,
                disk_mbps: bench.disk_mbps,
                p95_rtt_ms: 0.0,
                jitter_ms: 0.0,
                pkt_loss_pct: 0.0,
                bandwidth_mbps: 10000.0,
                cpu_temp_c: local_sensors.cpu_temp_c,
                gpu_temp_c: local_sensors.gpu_temp_c,
                cpu_util_pct: local_sensors.cpu_util_pct,
                gpu_util_pct: local_sensors.gpu_util_pct,
                thermal_headroom: local_sensors.thermal_headroom,
                strength_score: bench.strength_score,
                vulkan_active: true,
                execution_backend: if bench.vram_safe_mb > 0 {
                    "CUDA0 + Host CPU".into()
                } else {
                    "Host CPU (Master)".into()
                },
                handshake_ok: true,
                status: NodeStatus::Connected,
                last_seen_epoch_s: now,
            }];

            for spoke in usb_spokes {
                let probe = probe_spoke_link(&local_id, &spoke.probe_endpoint, &spoke.rpc_endpoint);
                if probe.handshake_ok {
                    let tel = probe.telemetry;
                    let is_android = tel
                        .as_ref()
                        .map(|t| t.os.to_lowercase().contains("android"))
                        .unwrap_or(true);
                    let ram_total = tel.as_ref().map(|t| t.ram_total_mb).unwrap_or(4096);
                    let ram_avail = tel.as_ref().map(|t| t.ram_avail_mb).unwrap_or(2048);
                    let raw_cap = tel.as_ref().map(|t| t.safe_cap_mb).unwrap_or(1536);
                    let capped = if is_android {
                        raw_cap.min((ram_total * cfg.android_ram_cap_pct.min(50)) / 100)
                    } else {
                        raw_cap
                    };
                    let tflops = tel.as_ref().map(|t| t.compute_tflops).unwrap_or(1.5);
                    let bw = tel.as_ref().map(|t| t.mem_bw_gbps).unwrap_or(34.0);
                    let score = strength_profiler::compute_node_strength_score(bw, tflops, 0);
                    raw_nodes.push(SpokeTelemetry {
                        node_id: tel
                            .as_ref()
                            .map(|t| t.node_id.clone())
                            .unwrap_or_else(|| format!("adb-usb-{}", spoke.serial)),
                        is_master: false,
                        is_android,
                        os: tel.as_ref().map(|t| t.os.clone()).unwrap_or_else(|| "android_apk".into()),
                        isa: tel
                            .as_ref()
                            .map(|t| t.isa.clone())
                            .unwrap_or_else(|| "ARMv8.2+ DotProd".into()),
                        silicon: tel
                            .as_ref()
                            .map(|t| t.silicon.clone())
                            .unwrap_or_else(|| "Android USB SoC".into()),
                        endpoint: spoke.rpc_endpoint,
                        link_type: "adb_usb".into(),
                        perf_cores: tel.as_ref().map(|t| t.perf_cores).unwrap_or(4),
                        ram_total_mb: ram_total,
                        ram_avail_mb: ram_avail,
                        safe_cap_mb: capped,
                        vram_total_free_mb: 0,
                        vram_safe_mb: 0,
                        compute_tflops: tflops,
                        mem_bw_gbps: bw,
                        disk_mbps: tel.as_ref().map(|t| t.disk_mbps).unwrap_or(500.0),
                        p95_rtt_ms: probe.p95_rtt_ms,
                        jitter_ms: probe.jitter_ms,
                        pkt_loss_pct: probe.pkt_loss_pct,
                        bandwidth_mbps: probe.bandwidth_mbps,
                        cpu_temp_c: tel.as_ref().map(|t| t.cpu_temp_c).unwrap_or(36.0),
                        gpu_temp_c: 0.0,
                        cpu_util_pct: tel.as_ref().map(|t| t.cpu_util_pct).unwrap_or(10.0),
                        gpu_util_pct: 0.0,
                        thermal_headroom: tel.as_ref().map(|t| t.thermal_headroom).unwrap_or(0.35),
                        strength_score: score,
                        vulkan_active: tel.as_ref().map(|t| t.vulkan_active).unwrap_or(false),
                        execution_backend: tel
                            .as_ref()
                            .map(|t| t.execution_backend.clone())
                            .unwrap_or_else(|| "ARM64/Vulkan (RPC v9)".into()),
                        handshake_ok: true,
                        status: NodeStatus::Connected,
                        last_seen_epoch_s: epoch_secs(),
                    });
                }
            }

            for (i, peer) in wifi_spokes.into_iter().enumerate() {
                let probe = probe_spoke_link(&local_id, &peer.probe_endpoint, &peer.rpc_endpoint);
                if probe.handshake_ok {
                    let link_type = if probe.p95_rtt_ms < 2.0 {
                        "usb_rndis"
                    } else {
                        "wifi_lan"
                    };
                    let tel = probe.telemetry;
                    let is_android = tel
                        .as_ref()
                        .map(|t| t.os.to_lowercase().contains("android"))
                        .unwrap_or(false);
                    let ram_total = tel.as_ref().map(|t| t.ram_total_mb).unwrap_or(4096);
                    let ram_avail = tel.as_ref().map(|t| t.ram_avail_mb).unwrap_or(2048);
                    let raw_cap = tel.as_ref().map(|t| t.safe_cap_mb).unwrap_or(1536);
                    let tflops = tel.as_ref().map(|t| t.compute_tflops).unwrap_or(1.5);
                    let bw = tel.as_ref().map(|t| t.mem_bw_gbps).unwrap_or(34.0);
                    let score = strength_profiler::compute_node_strength_score(bw, tflops, 0);
                    raw_nodes.push(SpokeTelemetry {
                        node_id: tel
                            .as_ref()
                            .map(|t| t.node_id.clone())
                            .unwrap_or_else(|| format!("{}-{i}", peer.node_id)),
                        is_master: false,
                        is_android,
                        os: tel.as_ref().map(|t| t.os.clone()).unwrap_or_else(|| "linux".into()),
                        isa: tel.as_ref().map(|t| t.isa.clone()).unwrap_or_else(|| "Generic".into()),
                        silicon: tel
                            .as_ref()
                            .map(|t| t.silicon.clone())
                            .unwrap_or_else(|| "LAN Compute Node".into()),
                        endpoint: peer.rpc_endpoint,
                        link_type: link_type.into(),
                        perf_cores: tel.as_ref().map(|t| t.perf_cores).unwrap_or(4),
                        ram_total_mb: ram_total,
                        ram_avail_mb: ram_avail,
                        safe_cap_mb: raw_cap,
                        vram_total_free_mb: 0,
                        vram_safe_mb: 0,
                        compute_tflops: tflops,
                        mem_bw_gbps: bw,
                        disk_mbps: tel.as_ref().map(|t| t.disk_mbps).unwrap_or(450.0),
                        p95_rtt_ms: probe.p95_rtt_ms,
                        jitter_ms: probe.jitter_ms,
                        pkt_loss_pct: probe.pkt_loss_pct,
                        bandwidth_mbps: probe.bandwidth_mbps,
                        cpu_temp_c: tel.as_ref().map(|t| t.cpu_temp_c).unwrap_or(42.0),
                        gpu_temp_c: 0.0,
                        cpu_util_pct: tel.as_ref().map(|t| t.cpu_util_pct).unwrap_or(10.0),
                        gpu_util_pct: 0.0,
                        thermal_headroom: tel.as_ref().map(|t| t.thermal_headroom).unwrap_or(0.4),
                        strength_score: score,
                        vulkan_active: tel.as_ref().map(|t| t.vulkan_active).unwrap_or(false),
                        execution_backend: tel
                            .as_ref()
                            .map(|t| t.execution_backend.clone())
                            .unwrap_or_else(|| "Host CPU (RPC v9)".into()),
                        handshake_ok: true,
                        status: NodeStatus::Connected,
                        last_seen_epoch_s: epoch_secs(),
                    });
                }
            }

            let mut nodes = deduplicate_by_link_priority(raw_nodes);
            let candidates: Vec<(String, f64)> = nodes
                .iter()
                .map(|n| (n.node_id.clone(), n.strength_score))
                .collect();
            let forced = if cfg.role_override == "master" {
                Some(local_id.as_str())
            } else {
                None
            };
            if let Some(winner) = elect_master_node_id(&candidates, forced) {
                for n in &mut nodes {
                    n.is_master = n.node_id == winner;
                }
            }

            let safe_sum: u64 = nodes.iter().map(|n| n.safe_cap_mb + n.vram_safe_mb).sum();
            let discovered_models = scan_models_directory("models", safe_sum);
            let model_path = env::var("GGUF_MODEL").unwrap_or_else(|_| {
                discovered_models
                    .first()
                    .map(|m| m.model_path.clone())
                    .unwrap_or_else(|| "models/Qwen3-30B-A3B-Q4_K_M.gguf".into())
            });
            let gguf = inspect_gguf_header(&model_path, 18500, safe_sum);

            let thermal_balancer = Arc::new(Mutex::new(ThermalBalancer::new()));
            let learner = Arc::new(Mutex::new(ClusterLearner::load_or_empty("cluster_history.json")));
            let learned_profiles = learner.lock().unwrap().all_profiles();
            let plan = {
                let mut tb = thermal_balancer.lock().unwrap();
                let lr = learner.lock().unwrap();
                compute_cluster_plan_with_state(&nodes, &gguf, &cfg, &mut tb, &lr, 0.0, epoch_secs())
            };

            for d in &plan.decisions {
                log_event(
                    "INFO",
                    &local_id,
                    "AUTOTUNE",
                    &d.status,
                    &format!("{} ({}): {}", d.mechanism, d.category, d.reason),
                    "",
                );
            }

            let backend = AutoDetectedBackend::detect_with_preference(&cfg.backend_preference).capability();
            let mut llama_guard: Option<ChildGuard> = None;
            let llama_running = if std::path::Path::new(&gguf.model_path).is_file() {
                match spawn_llama_server(
                    &backend.server_bin,
                    &gguf.model_path,
                    &plan.flags,
                    &plan.rpc_arg,
                    &plan.tensor_split,
                    plan.active_nodes.len(),
                ) {
                    Ok(child) => {
                        llama_guard = Some(ChildGuard::new("llama-server", child));
                        true
                    }
                    Err(err) => {
                        log_event("WARNING", &local_id, "SERVING", "SPAWN_SKIP", &err, "");
                        false
                    }
                }
            } else {
                false
            };

            let state = Arc::new(Mutex::new(ClusterState {
                cluster_id: local_id.clone(),
                version: LLAMA_TAG_PIN.into(),
                rpc_version: RPC_VERSION_PIN,
                mode: "live".into(),
                llama_running,
                cluster_tok_s: 0.0,
                model: gguf,
                discovered_models,
                config: cfg,
                plan,
                nodes,
                learned_profiles,
            }));

            // Plug-and-play USB hot-plug watcher
            let adb_state = Arc::clone(&state);
            let adb_tb = Arc::clone(&thermal_balancer);
            let adb_lr = Arc::clone(&learner);
            let adb_nid = local_id.clone();
            AdbTunnelManager::spawn_usb_watcher(local_id.clone(), 50052, Arc::clone(&running), move |spokes| {
                let mut guard = adb_state.lock().unwrap();
                for spoke in spokes {
                    let probe = probe_spoke_link(&adb_nid, &spoke.probe_endpoint, &spoke.rpc_endpoint);
                    if probe.handshake_ok {
                        let tel = probe.telemetry;
                        let nid = tel
                            .as_ref()
                            .map(|t| t.node_id.clone())
                            .unwrap_or_else(|| format!("adb-usb-{}", spoke.serial));
                        let ram_total = tel.as_ref().map(|t| t.ram_total_mb).unwrap_or(4096);
                        let ram_avail = tel.as_ref().map(|t| t.ram_avail_mb).unwrap_or(2048);
                        let safe_cap = tel.as_ref().map(|t| t.safe_cap_mb).unwrap_or(1536)
                            .min((ram_total * guard.config.android_ram_cap_pct.min(50)) / 100);
                        let tflops = tel.as_ref().map(|t| t.compute_tflops).unwrap_or(1.5);
                        let bw = tel.as_ref().map(|t| t.mem_bw_gbps).unwrap_or(34.0);
                        let score = strength_profiler::compute_node_strength_score(bw, tflops, 0);
                        guard.nodes.retain(|n| n.node_id != nid);
                        guard.nodes.push(SpokeTelemetry {
                            node_id: nid,
                            is_master: false,
                            is_android: true,
                            os: tel.as_ref().map(|t| t.os.clone()).unwrap_or_else(|| "android_apk".into()),
                            isa: tel.as_ref().map(|t| t.isa.clone()).unwrap_or_else(|| "ARMv8.2+ DotProd".into()),
                            silicon: tel.as_ref().map(|t| t.silicon.clone()).unwrap_or_else(|| "Android USB SoC".into()),
                            endpoint: spoke.rpc_endpoint,
                            link_type: "adb_usb".into(),
                            perf_cores: tel.as_ref().map(|t| t.perf_cores).unwrap_or(4),
                            ram_total_mb: ram_total,
                            ram_avail_mb: ram_avail,
                            safe_cap_mb: safe_cap,
                            vram_total_free_mb: 0,
                            vram_safe_mb: 0,
                            compute_tflops: tflops,
                            mem_bw_gbps: bw,
                            disk_mbps: tel.as_ref().map(|t| t.disk_mbps).unwrap_or(500.0),
                            p95_rtt_ms: probe.p95_rtt_ms,
                            jitter_ms: probe.jitter_ms,
                            pkt_loss_pct: probe.pkt_loss_pct,
                            bandwidth_mbps: probe.bandwidth_mbps,
                            cpu_temp_c: tel.as_ref().map(|t| t.cpu_temp_c).unwrap_or(36.0),
                            gpu_temp_c: 0.0,
                            cpu_util_pct: tel.as_ref().map(|t| t.cpu_util_pct).unwrap_or(10.0),
                            gpu_util_pct: 0.0,
                            thermal_headroom: tel.as_ref().map(|t| t.thermal_headroom).unwrap_or(0.35),
                            strength_score: score,
                            vulkan_active: tel.as_ref().map(|t| t.vulkan_active).unwrap_or(false),
                            execution_backend: tel.as_ref().map(|t| t.execution_backend.clone()).unwrap_or_else(|| "ARM64/Vulkan (RPC v9)".into()),
                            handshake_ok: true,
                            status: NodeStatus::Connected,
                            last_seen_epoch_s: epoch_secs(),
                        });
                    }
                }
                let mut tb = adb_tb.lock().unwrap();
                let lr = adb_lr.lock().unwrap();
                let tok_s = guard.cluster_tok_s;
                guard.plan = compute_cluster_plan_with_state(
                    &guard.nodes,
                    &guard.model,
                    &guard.config,
                    &mut tb,
                    &lr,
                    tok_s,
                    epoch_secs(),
                );
            });

            // Drop-resilient 2s heartbeat & proactive thermal rebalance watchdog
            let wd_state = Arc::clone(&state);
            let wd_tb = Arc::clone(&thermal_balancer);
            let wd_lr = Arc::clone(&learner);
            let wd_running = Arc::clone(&running);
            let wd_nid = local_id.clone();
            thread::spawn(move || {
                while wd_running.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(2));
                    let sensors = read_local_sensors(bench.is_android);
                    let mut guard = wd_state.lock().unwrap();
                    let now_s = epoch_secs();
                    let mut thermal_transition = false;
                    for n in &mut guard.nodes {
                        if n.node_id == wd_nid {
                            n.cpu_temp_c = sensors.cpu_temp_c;
                            n.gpu_temp_c = sensors.gpu_temp_c;
                            n.cpu_util_pct = sensors.cpu_util_pct;
                            n.gpu_util_pct = sensors.gpu_util_pct;
                            n.thermal_headroom = sensors.thermal_headroom;
                            n.last_seen_epoch_s = now_s;
                        }
                    }
                    let thermal_thresh = guard.config.thermal_threshold;
                    let max_loss = guard.config.max_pkt_loss_pct;
                    let drop_changed = check_drop_resilient_health(
                        &mut guard.nodes,
                        now_s,
                        thermal_thresh,
                        max_loss,
                    );

                    let prev_states: Vec<(String, String)> = guard
                        .plan
                        .active_nodes
                        .iter()
                        .chain(guard.plan.pruned_nodes.iter())
                        .map(|p| (p.node_id.clone(), p.thermal_state.clone()))
                        .collect();

                    let new_plan = {
                        let mut tb = wd_tb.lock().unwrap();
                        let lr = wd_lr.lock().unwrap();
                        compute_cluster_plan_with_state(
                            &guard.nodes,
                            &guard.model,
                            &guard.config,
                            &mut tb,
                            &lr,
                            guard.cluster_tok_s,
                            now_s,
                        )
                    };
                    for p in new_plan.active_nodes.iter().chain(new_plan.pruned_nodes.iter()) {
                        if let Some((_, old_st)) = prev_states.iter().find(|(id, _)| id == &p.node_id) {
                            if old_st != &p.thermal_state {
                                thermal_transition = true;
                            }
                        }
                    }
                    guard.plan = new_plan;
                    if drop_changed || thermal_transition {
                        log_event(
                            "INFO",
                            &wd_nid,
                            "PLAN",
                            "REBALANCED",
                            "Cluster rebalanced after link/thermal transition",
                            &format!("split={} tier={}", guard.plan.tensor_split, guard.plan.cluster_tier),
                        );
                    }
                }
            });

            let port: u16 = env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8081);
            serve_http(
                port,
                state,
                Arc::clone(&thermal_balancer),
                Arc::clone(&learner),
                Arc::clone(&running),
            );
            drop(llama_guard);
            adb_mgr.cleanup();
        }
    }
}
