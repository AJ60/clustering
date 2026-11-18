use crate::hw_probe::log_event;
use crate::learner::{ClusterLearner, LearnedNodeProfile};
use crate::ngram_drafter::propose_ngram_draft;
use crate::serving::{check_context_budget, estimate_prompt_tokens, RadixPrefixRouter};
use crate::thermal_balancer::ThermalBalancer;
use crate::tier_planner::{
    compute_cluster_plan_with_state, score_node, ClusterConfig, ClusterPlan, GgufInspection,
    SpokeTelemetry,
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DASHBOARD_HTML: &str = include_str!("../dashboard.html");

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Clone, Serialize)]
pub struct ClusterState {
    pub cluster_id: String,
    pub version: String,
    pub rpc_version: u32,
    pub mode: String,
    pub llama_running: bool,
    pub cluster_tok_s: f64,
    pub model: GgufInspection,
    pub discovered_models: Vec<GgufInspection>,
    pub config: ClusterConfig,
    pub plan: ClusterPlan,
    pub nodes: Vec<SpokeTelemetry>,
    pub learned_profiles: Vec<LearnedNodeProfile>,
}

#[derive(Deserialize)]
struct ConfigUpdatePayload {
    config: Option<ClusterConfig>,
    model: Option<GgufInspection>,
}

pub fn serve_http(
    port: u16,
    state: Arc<Mutex<ClusterState>>,
    thermal_balancer: Arc<Mutex<ThermalBalancer>>,
    learner: Arc<Mutex<ClusterLearner>>,
    running: Arc<AtomicBool>,
) {
    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr).expect("bind web_ui TcpListener");
    let _ = listener.set_nonblocking(true);
    let prefix_router = Arc::new(Mutex::new(RadixPrefixRouter::new(4)));

    log_event(
        "INFO",
        "master-hub",
        "WEB_UI",
        "LISTENING",
        "Embedded dashboard, SSE telemetry stream & real llama-server proxy ready",
        &format!("url=http://{addr}"),
    );

    while running.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let st = Arc::clone(&state);
                let tb = Arc::clone(&thermal_balancer);
                let lr = Arc::clone(&learner);
                let pr = Arc::clone(&prefix_router);
                let rn = Arc::clone(&running);
                thread::spawn(move || handle_http_conn(stream, st, tb, lr, pr, rn));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => break,
        }
    }
}

fn handle_http_conn(
    mut stream: TcpStream,
    state: Arc<Mutex<ClusterState>>,
    thermal_balancer: Arc<Mutex<ThermalBalancer>>,
    learner: Arc<Mutex<ClusterLearner>>,
    prefix_router: Arc<Mutex<RadixPrefixRouter>>,
    running: Arc<AtomicBool>,
) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = [0u8; 65536];
    let Ok(n) = stream.read(&mut buf) else {
        return;
    };
    if n == 0 {
        return;
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");

    match (method, path) {
        ("GET", "/") | ("GET", "/dashboard.html") | ("GET", "/index.html") => {
            write_http(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                DASHBOARD_HTML.as_bytes(),
            );
        }
        ("GET", "/api/status") => {
            let json = {
                let guard = state.lock().unwrap();
                serde_json::to_string(&*guard).unwrap_or_else(|_| "{}".into())
            };
            write_http(&mut stream, "200 OK", "application/json", json.as_bytes());
        }
        ("GET", "/api/events") => {
            let hdr = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
            if stream.write_all(hdr.as_bytes()).is_err() {
                return;
            }
            while running.load(Ordering::Relaxed) {
                let json = {
                    let guard = state.lock().unwrap();
                    serde_json::to_string(&*guard).unwrap_or_else(|_| "{}".into())
                };
                let frame = format!("data: {json}\n\n");
                if stream.write_all(frame.as_bytes()).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(1500));
            }
        }
        ("GET", "/api/nodes") => {
            let json = {
                let guard = state.lock().unwrap();
                serde_json::to_string(&guard.nodes).unwrap_or_else(|_| "[]".into())
            };
            write_http(&mut stream, "200 OK", "application/json", json.as_bytes());
        }
        ("GET", "/api/models") => {
            let json = {
                let guard = state.lock().unwrap();
                serde_json::to_string(&guard.discovered_models).unwrap_or_else(|_| "[]".into())
            };
            write_http(&mut stream, "200 OK", "application/json", json.as_bytes());
        }
        ("GET", "/api/history") => {
            let profiles = {
                let lr = learner.lock().unwrap();
                lr.all_profiles()
            };
            let json = serde_json::json!({ "profiles": profiles }).to_string();
            write_http(&mut stream, "200 OK", "application/json", json.as_bytes());
        }
        ("POST", "/api/history/reset") => {
            {
                let mut lr = learner.lock().unwrap();
                let _ = lr.reset();
            }
            let json = {
                let mut guard = state.lock().unwrap();
                guard.learned_profiles = Vec::new();
                let mut tb = thermal_balancer.lock().unwrap();
                let lr = learner.lock().unwrap();
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
                serde_json::json!({ "ok": true, "profiles": [], "plan": guard.plan }).to_string()
            };
            write_http(&mut stream, "200 OK", "application/json", json.as_bytes());
        }
        ("POST", "/api/config") => {
            let body = req.split("\r\n\r\n").nth(1).unwrap_or("{}");
            if let Ok(payload) = serde_json::from_str::<ConfigUpdatePayload>(body) {
                let mut guard = state.lock().unwrap();
                if let Some(m) = payload.model {
                    guard.model = m;
                }
                if let Some(c) = payload.config {
                    guard.config = c;
                    let _ = guard.config.save_atomic("cluster_config.json");
                }
                let mut tb = thermal_balancer.lock().unwrap();
                let lr = learner.lock().unwrap();
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
                let json = serde_json::to_string(&*guard).unwrap_or_else(|_| "{}".into());
                write_http(&mut stream, "200 OK", "application/json", json.as_bytes());
            } else {
                write_http(
                    &mut stream,
                    "400 Bad Request",
                    "application/json",
                    br#"{"error":"invalid JSON payload"}"#,
                );
            }
        }
        ("GET", "/api/logs") => {
            let text = std::fs::read_to_string("logs/cluster.log").unwrap_or_default();
            let tail: Vec<&str> = text.lines().rev().take(45).collect();
            let ordered: Vec<&str> = tail.into_iter().rev().collect();
            write_http(
                &mut stream,
                "200 OK",
                "text/plain; charset=utf-8",
                ordered.join("\n").as_bytes(),
            );
        }
        ("POST", "/v1/chat/completions") => {
            let body = req.split("\r\n\r\n").nth(1).unwrap_or("{}");
            let auto_ctx = state.lock().unwrap().plan.auto_ctx_size;
            let est_toks = estimate_prompt_tokens(body);
            if let Some(warn) = check_context_budget(est_toks, auto_ctx) {
                log_event("WARNING", "master-hub", "SERVING", "CTX_BUDGET_WARN", &warn, "");
            }
            let _slot = prefix_router.lock().unwrap().route_slot(body);
            if let Some(draft) = propose_ngram_draft(body, 6) {
                log_event(
                    "INFO",
                    "master-hub",
                    "NGRAM",
                    "DRAFT_HIT",
                    "Proposed Prompt-Lookup N-gram draft",
                    &format!("tokens={}", draft.len()),
                );
            }
            proxy_to_llama_server(&mut stream, body, &state, &thermal_balancer, &learner);
        }
        _ => {
            write_http(&mut stream, "404 Not Found", "text/plain", b"Not Found");
        }
    }
}

/// Strictly proxies /v1/chat/completions to real llama-server on 127.0.0.1:8080.
/// Never fabricates LLM responses; returns HTTP 503 if llama-server is offline.
fn proxy_to_llama_server(
    client: &mut TcpStream,
    body: &str,
    state: &Arc<Mutex<ClusterState>>,
    thermal_balancer: &Arc<Mutex<ThermalBalancer>>,
    learner: &Arc<Mutex<ClusterLearner>>,
) {
    let Ok(mut upstream) = TcpStream::connect_timeout(
        &"127.0.0.1:8080".parse().unwrap(),
        Duration::from_millis(500),
    ) else {
        let err = br#"{"error":"llama-server offline on port 8080"}"#;
        write_http(client, "503 Service Unavailable", "application/json", err);
        return;
    };

    let started = Instant::now();
    let _ = upstream.set_read_timeout(Some(Duration::from_secs(60)));
    let req = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    if upstream.write_all(req.as_bytes()).is_err() {
        let err = br#"{"error":"llama-server offline on port 8080"}"#;
        write_http(client, "503 Service Unavailable", "application/json", err);
        return;
    }

    let mut captured: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(n) = upstream.read(&mut chunk) {
        if n == 0 {
            break;
        }
        if captured.len() < 262_144 {
            captured.extend_from_slice(&chunk[..n]);
        }
        if client.write_all(&chunk[..n]).is_err() {
            break;
        }
    }

    let elapsed_s = started.elapsed().as_secs_f64().max(0.05);
    let raw_str = String::from_utf8_lossy(&captured);
    if let Some(http_body) = raw_str.split("\r\n\r\n").nth(1) {
        let mut parsed_val: Option<serde_json::Value> =
            serde_json::from_str::<serde_json::Value>(http_body.trim()).ok();
        if parsed_val.is_none() {
            // Parse final SSE data chunk carrying llama.cpp timings / usage
            for line in http_body.lines().rev() {
                if let Some(payload) = line.strip_prefix("data: ") {
                    let trimmed = payload.trim();
                    if trimmed == "[DONE]" || trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        if v.get("timings").is_some() || v.get("usage").is_some() {
                            parsed_val = Some(v);
                            break;
                        }
                    }
                }
            }
        }

        if let Some(val) = parsed_val {
            let predicted = val
                .get("timings")
                .and_then(|t| t.get("predicted_n"))
                .and_then(|v| v.as_u64())
                .or_else(|| {
                    val.get("usage")
                        .and_then(|u| u.get("completion_tokens"))
                        .and_then(|v| v.as_u64())
                })
                .unwrap_or(0) as u32;
            let predicted_per_sec = val
                .get("timings")
                .and_then(|t| t.get("predicted_per_second"))
                .and_then(|v| v.as_f64())
                .unwrap_or_else(|| (predicted as f64) / elapsed_s);

            if predicted >= 1 {
                let now = epoch_secs();
                let mut guard = state.lock().unwrap();
                guard.cluster_tok_s = (predicted_per_sec * 100.0).round() / 100.0;
                if predicted >= 50 {
                    let nodes_snapshot = guard.nodes.clone();
                    let active_snapshot = guard.plan.active_nodes.clone();
                    let arch = guard.model.arch.clone();
                    let quant = guard.model.quant.clone();
                    let mut lr = learner.lock().unwrap();
                    for act in &active_snapshot {
                        if let Some(tel) = nodes_snapshot.iter().find(|n| n.node_id == act.node_id) {
                            let alloc_gb = ((act.alloc_mb as f64) / 1024.0).max(0.25);
                            let obs_tok_gb =
                                (guard.cluster_tok_s * (act.compute_share_pct / 100.0)) / alloc_gb;
                            let base_sc = score_node(tel);
                            let ratio = (guard.cluster_tok_s / 18.0).clamp(0.4, 1.5);
                            let throttled = act.thermal_state == "SHED_25"
                                || act.thermal_state == "EMERGENCY_OFFLOAD"
                                || act.thermal_state == "WARN";
                            lr.record_completed_session(
                                &tel.node_id,
                                &tel.silicon,
                                &arch,
                                &quant,
                                &tel.link_type,
                                predicted,
                                base_sc * ratio,
                                obs_tok_gb,
                                if throttled { 4.2 } else { 0.8 },
                                6.0,
                                0.78,
                                throttled,
                                now,
                            );
                        }
                    }
                    guard.learned_profiles = lr.all_profiles();
                    let mut tb = thermal_balancer.lock().unwrap();
                    let tok_s = guard.cluster_tok_s;
                    guard.plan = compute_cluster_plan_with_state(
                        &guard.nodes,
                        &guard.model,
                        &guard.config,
                        &mut tb,
                        &lr,
                        tok_s,
                        now,
                    );
                }
            }
        }
    }
}

fn write_http(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}
