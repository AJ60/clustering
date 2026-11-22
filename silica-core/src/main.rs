//! Silica Cluster (`clusterd`) — Pure-Rust Symmetric Multi-OS Master & Worker Coordinator.
//!
//! Modes:
//!   `clusterd` / `clusterd master`  -> Master HTTP/SSE server (:3000) + embedded Web UI + llama-server supervisor
//!   `clusterd worker`               -> Dedicated Windows/Linux/ARM64 SBC worker (UDP discovery + 8s heartbeat + rpc-server -c)
//!   `clusterd --auto`               -> Probes UDP :50050 for an existing Master; joins as worker if found, else promotes to master

mod discovery;
mod engine;
mod gguf;
mod hardware;
mod history;
mod planner;
mod protocol;
mod speculative;
mod tools;
mod worker;

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use discovery::{
    discover_master_udp, setup_adb_usb_tunnels, spawn_udp_discovery_responder, WorkerRegisterRequest,
    WorkerRegistry,
};
use engine::EngineSupervisor;
use futures_util::StreamExt;
use gguf::{inspect_gguf_file, GgufModelCard};
use hardware::probe_real_host_hardware;
use history::{ClusterHistoryStore, RunObservation};
use planner::{compute_cluster_plan, LinkTransport, LiveNodeInput, ModelLoadConfig, NodeOs};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

#[derive(RustEmbed)]
#[folder = "../dist/"]
#[exclude = "server.js"]
struct EmbeddedWebAssets;

#[derive(Clone)]
struct AppState {
    registry: WorkerRegistry,
    engine: Arc<EngineSupervisor>,
    history: Arc<RwLock<ClusterHistoryStore>>,
    active_card: Arc<RwLock<Option<GgufModelCard>>>,
    load_config: Arc<RwLock<ModelLoadConfig>>,
    http_client: reqwest::Client,
    cluster_secret: String,
    port: u16,
}

#[derive(Deserialize)]
struct InspectRequest {
    path: String,
    context_length: Option<u32>,
    kv_cache_quant: Option<String>,
}

#[derive(Deserialize)]
struct UnregisterRequest {
    id: String,
}

#[derive(Deserialize)]
struct ReloadModelRequest {
    model_path: String,
    binary: Option<String>,
    config: Option<ModelLoadConfig>,
}

#[derive(Deserialize)]
struct FetchUrlRequest {
    url: String,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
    code: String,
    recovery: String,
}

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let eng = state.engine.status().await;
    Json(serde_json::json!({
        "status": "ok",
        "service": "Silica Cluster",
        "runtime": "rust-clusterd",
        "engineRunning": eng.running,
        "draining": eng.draining,
        "activeTurns": eng.active_turns,
    }))
}

async fn beacon_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "service": "Silica-Cluster-Master",
        "port": state.port,
        "rpcPort": 50052,
        "secret": state.cluster_secret,
        "protocolVersion": 9,
    }))
}

async fn hardware_handler(State(state): State<AppState>) -> impl IntoResponse {
    let hw = probe_real_host_hardware();
    let workers = state.registry.active_verified_workers().await;
    let adb_serials = tokio::task::spawn_blocking(setup_adb_usb_tunnels)
        .await
        .unwrap_or_default();
    Json(serde_json::json!({
        "host": hw,
        "verifiedWorkers": workers,
        "adbDevices": adb_serials,
    }))
}

async fn register_worker_handler(
    State(state): State<AppState>,
    Json(req): Json<WorkerRegisterRequest>,
) -> impl IntoResponse {
    match state.registry.register_and_verify(req).await {
        Ok(node) => (StatusCode::OK, Json(serde_json::json!({ "ok": true, "node": node }))),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "ok": false, "error": e })),
        ),
    }
}

async fn unregister_worker_handler(
    State(state): State<AppState>,
    Json(req): Json<UnregisterRequest>,
) -> impl IntoResponse {
    let removed = state.registry.unregister(&req.id).await;
    Json(serde_json::json!({ "ok": true, "removed": removed }))
}

async fn inspect_gguf_handler(
    State(state): State<AppState>,
    Json(req): Json<InspectRequest>,
) -> impl IntoResponse {
    let path = PathBuf::from(&req.path);
    if path.extension().and_then(|s| s.to_str()) != Some("gguf") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Only .gguf model files are supported" })),
        );
    }
    let ctx = req.context_length.unwrap_or(16384);
    let kvq = req.kv_cache_quant.unwrap_or_else(|| "q8_0".to_string());
    match inspect_gguf_file(&path, ctx, &kvq) {
        Ok(card) => {
            *state.active_card.write().await = Some(card.clone());
            (StatusCode::OK, Json(serde_json::json!({ "ok": true, "modelCard": card })))
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        ),
    }
}

async fn reload_model_handler(
    State(state): State<AppState>,
    Json(req): Json<ReloadModelRequest>,
) -> impl IntoResponse {
    let cfg = req.config.unwrap_or_default();
    let card = match inspect_gguf_file(PathBuf::from(&req.model_path).as_path(), cfg.context_length, &cfg.kv_cache_quant) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            );
        }
    };

    let hw = probe_real_host_hardware();
    let master_os = match hw.os_name.as_str() {
        "windows" => NodeOs::Windows,
        _ => NodeOs::Linux,
    };
    let mut nodes = vec![LiveNodeInput {
        node_id: "master-host".to_string(),
        label: format!("{} (Master)", hw.hostname),
        is_master: true,
        os: master_os,
        ip: "127.0.0.1".to_string(),
        rpc_port: 50052,
        transport: LinkTransport::Local,
        total_ram_mb: hw.total_ram_mb,
        available_ram_mb: hw.available_ram_mb,
        vram_total_mb: hw.vram_total_mb,
        vram_free_mb: hw.vram_free_mb,
        mem_bw_gbps: if hw.vram_total_mb > 0.0 { 240.0 } else { 52.0 },
        big_cores: hw.big_cores,
        rtt_p95_ms: 0.2,
        bandwidth_mbps: 10000.0,
        pkt_loss_pct: 0.0,
        temp_c: hw.gpu_temp_c.max(hw.cpu_temp_c),
        thermal_headroom: 0.2,
        handshake_verified: true,
        heartbeat_age_s: 0,
    }];
    nodes.extend(state.registry.active_verified_workers().await);

    let history_guard = state.history.read().await;
    let profile_key = format!("{}:{}nodes", card.architecture, nodes.len());
    let learned = history_guard.profiles.get(&profile_key).cloned();
    drop(history_guard);

    let plan = compute_cluster_plan(&card, &nodes, &cfg, learned.as_ref());
    *state.active_card.write().await = Some(card.clone());
    *state.load_config.write().await = cfg;

    let binary = req.binary.unwrap_or_else(|| "llama-server".to_string());
    match state
        .engine
        .hot_reload_llama_server(
            &binary,
            plan.cli_args.clone(),
            card.name.clone(),
            card.mmproj_path.is_some(),
            Duration::from_secs(15),
        )
        .await
    {
        Ok(status) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "status": status, "plan": plan, "modelCard": card })),
        ),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "ok": false, "error": e, "plan": plan, "modelCard": card })),
        ),
    }
}

async fn history_record_handler(
    State(state): State<AppState>,
    Json(obs): Json<RunObservation>,
) -> impl IntoResponse {
    let mut store = state.history.write().await;
    let updated = store.record_run(obs);
    let _ = store.save(&ClusterHistoryStore::default_path());
    Json(serde_json::json!({ "ok": true, "profile": updated }))
}

async fn fetch_url_tool_handler(
    State(state): State<AppState>,
    Json(req): Json<FetchUrlRequest>,
) -> impl IntoResponse {
    let valid_url = match tools::validate_public_http_url(&req.url) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            );
        }
    };

    match state
        .http_client
        .get(valid_url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let truncated: String = text.chars().take(12000).collect();
            (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "status": status, "content": truncated })),
            )
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "ok": false, "error": format!("Fetch failed: {}", e) })),
        ),
    }
}

/// OpenAI-compatible `/v1/chat/completions` proxy with:
/// - Honest HTTP 503 when no live `llama-server` / upstream engine is active
/// - Turn-boundary guard so reloads never sever active generation turns
/// - Full `image_url`, `tools`, `tool_choice`, `delta.tool_calls`, and `reasoning_content` passthrough
/// - 10-second SSE `: keepalive\n\n` heartbeats during long prompt prefills
async fn chat_completions_handler(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    let status = state.engine.status().await;
    let Some(upstream) = status.upstream_url else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                error: "No live inference engine is loaded. Load a GGUF model or connect an upstream llama-server / Ollama endpoint.".to_string(),
                code: "ENGINE_OFFLINE".to_string(),
                recovery: "Open Models to load a local .gguf or click Connect Local Server in Chat.".to_string(),
            }),
        )
            .into_response();
    };

    let Some(_turn_guard) = state.engine.turns.try_acquire() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                error: "Cluster engine is draining active turns for a hot-reload. Retry in a moment.".to_string(),
                code: "ENGINE_DRAINING".to_string(),
                recovery: "Wait for model reload progress to finish.".to_string(),
            }),
        )
            .into_response();
    };

    let is_stream = payload
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let target = format!("{}/v1/chat/completions", upstream.trim_end_matches('/'));

    let req_builder = state
        .http_client
        .post(&target)
        .header(header::CONTENT_TYPE, "application/json")
        .json(&payload);

    if !is_stream {
        return match req_builder.send().await {
            Ok(resp) => {
                let code = StatusCode::from_u16(resp.status().as_u16())
                    .unwrap_or(StatusCode::BAD_GATEWAY);
                let body = resp.text().await.unwrap_or_default();
                (code, [(header::CONTENT_TYPE, "application/json")], body).into_response()
            }
            Err(e) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorBody {
                    error: format!("Upstream engine unreachable: {}", e),
                    code: "UPSTREAM_UNREACHABLE".to_string(),
                    recovery: "Verify llama-server is running or reload the model.".to_string(),
                }),
            )
                .into_response(),
        };
    }

    // Streaming SSE response with 10-second `: keepalive\n\n` heartbeat during long prefills.
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(32);
    let turns = state.engine.turns.clone();
    tokio::spawn(async move {
        let _active_turn = turns.try_acquire();
        let mut keepalive = tokio::time::interval(Duration::from_secs(10));
        keepalive.tick().await; // skip immediate tick

        let send_fut = req_builder.send();
        tokio::pin!(send_fut);

        let resp = loop {
            tokio::select! {
                res = &mut send_fut => {
                    match res {
                        Ok(r) => break r,
                        Err(e) => {
                            let err_chunk = format!(
                                "data: {{\"error\":{{\"message\":\"Upstream stream error: {}\"}}}}\n\n",
                                e
                            );
                            let _ = tx.send(Ok(bytes::Bytes::from(err_chunk))).await;
                            return;
                        }
                    }
                }
                _ = keepalive.tick() => {
                    if tx.send(Ok(bytes::Bytes::from_static(b": keepalive\n\n"))).await.is_err() {
                        return;
                    }
                }
            }
        };

        let mut byte_stream = resp.bytes_stream();
        loop {
            tokio::select! {
                item = byte_stream.next() => {
                    match item {
                        Some(Ok(chunk)) => {
                            if tx.send(Ok(chunk)).await.is_err() {
                                break;
                            }
                        }
                        Some(Err(_)) | None => break,
                    }
                }
                _ = keepalive.tick() => {
                    if tx.send(Ok(bytes::Bytes::from_static(b": keepalive\n\n"))).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap()
}

async fn engine_events_sse(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.engine.events_tx.subscribe();
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|msg| async move {
        match msg {
            Ok(line) => Some(Ok(Event::default().data(line))),
            Err(_) => None,
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}

async fn static_asset_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let key = if path.is_empty() { "index.html" } else { path };

    if let Some(asset) = EmbeddedWebAssets::get(key).or_else(|| EmbeddedWebAssets::get("index.html")) {
        let mime = mime_guess::from_path(key).first_or_octet_stream();
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, mime.as_ref().to_string())],
            asset.data.into_owned(),
        )
            .into_response();
    }

    (
        StatusCode::NOT_FOUND,
        "Run `npm run build` before building `clusterd` to embed the Silica Cluster Web UI.",
    )
        .into_response()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();
    let mut mode = "master".to_string();
    let mut master_override: Option<String> = None;
    let mut bind_host = "0.0.0.0".to_string();
    let mut port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "master" | "worker" => mode = args[i].clone(),
            "--auto" => mode = "auto".to_string(),
            "--master" if i + 1 < args.len() => {
                i += 1;
                master_override = Some(args[i].clone());
            }
            "--bind" if i + 1 < args.len() => {
                i += 1;
                bind_host = args[i].clone();
            }
            "--port" if i + 1 < args.len() => {
                i += 1;
                if let Ok(p) = args[i].parse::<u16>() {
                    port = p;
                }
            }
            _ => {}
        }
        i += 1;
    }

    if mode == "auto" {
        if let Some((ip, mport, _)) = discover_master_udp(900) {
            tracing::info!("--auto detected live Master at {}:{} -> joining as worker", ip, mport);
            mode = "worker".to_string();
            master_override = Some(format!("{}:{}", ip, mport));
        } else {
            tracing::info!("--auto found no Master on LAN -> promoting this host to Master");
            mode = "master".to_string();
        }
    }

    if mode == "worker" {
        if let Err(e) = worker::run_worker_mode(worker::WorkerCliOptions {
            master_override,
            bind_host,
            rpc_port: 50052,
            rpc_binary: "rpc-server".to_string(),
        })
        .await
        {
            tracing::error!("Worker error: {}", e);
            std::process::exit(1);
        }
        return;
    }

    let cluster_secret = std::env::var("CLUSTER_SECRET")
        .unwrap_or_else(|_| "clusterd-default-hmac-key".to_string());
    spawn_udp_discovery_responder(port, cluster_secret.clone());

    let history_store = ClusterHistoryStore::load_or_default(&ClusterHistoryStore::default_path());
    let state = AppState {
        registry: WorkerRegistry::new(cluster_secret.clone()),
        engine: Arc::new(EngineSupervisor::new()),
        history: Arc::new(RwLock::new(history_store)),
        active_card: Arc::new(RwLock::new(None)),
        load_config: Arc::new(RwLock::new(ModelLoadConfig::default())),
        http_client: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("reqwest client"),
        cluster_secret,
        port,
    };

    if let Ok(up) = std::env::var("UPSTREAM_LLAMA_URL") {
        if !up.trim().is_empty() {
            state.engine.set_external_upstream(Some(up), None).await;
        }
    }

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/cluster/beacon", get(beacon_handler))
        .route("/api/cluster/hardware", get(hardware_handler))
        .route("/api/cluster/nodes/register", post(register_worker_handler))
        .route("/api/cluster/nodes/unregister", post(unregister_worker_handler))
        .route("/api/models/inspect", post(inspect_gguf_handler))
        .route("/api/engine/reload", post(reload_model_handler))
        .route("/api/engine/events", get(engine_events_sse))
        .route("/api/history/record", post(history_record_handler))
        .route("/api/tools/fetch-url", post(fetch_url_tool_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .fallback(get(static_asset_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("Failed to bind clusterd HTTP listener");
    tracing::info!("Silica Cluster pure-Rust Master running on http://0.0.0.0:{}", port);
    axum::serve(listener, app).await.expect("clusterd server error");
}
