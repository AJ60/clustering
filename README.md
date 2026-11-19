# ClusterLab — 1-Hop Star GGUF Cluster (React + TypeScript + Express + Vite)

ClusterLab is a simplified **1-Hop Star GGUF Cluster** coordinator, Hugging Face GGUF browser, live OpenAI-compatible inference server, and node-brain inspector built with React 19, TypeScript, Express, Vite, and Tailwind CSS v4.

The default interface centers on clean cluster orchestration, Windows/Linux backend tuning, model compatibility cards, chat + active-parameter inspection, and 1-step agent harness setup. Advanced 2D machine learning visualization (**2D K-Means & DBSCAN Lab**) remains gated behind **Developer Mode**.

---

## Core Features

### 1. 1-Hop Star GGUF Cluster & Tuned Windows / Linux Backends (`Cluster`)
- **Model-Aware Backend Tuning (`src/domain/backendTuner.ts`):**
  - **Windows 10/11:** Supports `CUDA 12.6`, `Vulkan 1.3`, `DirectML`, and `CPU AVX2 / BitNet LUT`; reserves WDDM compositor VRAM (`-450 MB` safety floor on `<= 8 GB` GPUs), sets `HIGH_PRIORITY_CLASS`, configures `OMP_WAIT_POLICY=PASSIVE` & `GGML_CUDA_NO_PINNED`, provisions Windows Firewall rules (`:8080`, `:50052`, UDP `:50050`), and exports `run-cluster-win.ps1`.
  - **Linux Kernel / NUMA:** Supports `CUDA 12.6`, `ROCm 6.3`, `Vulkan 1.3`, and `CPU OpenBLAS`; enforces `MemAvailable - 1024 MB`, disables silent PCIe unified-memory thrashing (`GGML_CUDA_ENABLE_UNIFIED_MEMORY=0`), configures Transparent HugePages (`madvise`), `--mlock`, `numactl --interleave=all`, and exports `run-cluster-linux.sh`.
  - **Architecture-Adaptive Flags:** Enables `-ot ".ffn_.*_exps.=CPU"` (`--cpu-moe`) for sparse MoE models, `q8_0`/`q4_0` KV cache quantization, `--flash-attn on`, contiguous `--tensor-split`, and `--n-gpu-layers`.
- **1-Hop Star Topology & Three Operational Cards:** Interactive Star SVG + node table alongside **Connect Device** (Auto-Connect, 21×21 CRC-8 QR pairing, Start/Stop Sharing), **Device Health**, and **Troubleshooter** (6-check Auto-Diagnosis with 1-click fixes).

### 2. Models & Hugging Face GGUF Browser (`Models`)
- Syncs live with Hugging Face Hub (`GET /api/hf/models` -> `https://huggingface.co/api/models?filter=gguf`) with curated offline fallback (`src/data/hfModelsCatalog.ts`).
- Ranks and scores every model card against your active nodes' Safe RAM + VRAM pool (`Fast`, `Best Fit`, `Streaming`, `Too Large`), shows `activeParamsB / totalParamsB` and estimated `tok/s`, supports quantization selection (`IQ4_XS`, `Q4_K_M`, `Q5_K_M`, `Q8_0`, `TQ1_0`), and loads models directly into the Cluster & Chat views.

### 3. Chat Window & Cluster Brain Inspector (`Chat & Brain`)
- Streaming SSE chat UI wired to `POST /v1/chat/completions` (supporting optional live forwarding to any local `llama-server` / `clusterd` OpenAI URL).
- Side-by-side **Cluster Brain & Active Parameters** panel showing active parameters per token (e.g., `3.3B active / 30.5B total`), KV cache size, per-node layer spans (`L0–L23`), active parameter distribution, GPU vs CPU layers, thermal guard state, and live tuning flags.

### 4. OpenAI-Compatible Endpoints & 1-Step Harness Connect (`API & Harness`)
- Full-stack Express server (`server.ts`) exposing `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (JSON + SSE `chat.completion.chunk`), `GET/POST /api/cluster/state`, `GET /api/hf/models`, and `GET /api/backends/script`.
- **1-Step Connect** commands and downloadable configs for **Hermes Agent**, **OpenCode**, **Claude Code Bridge**, **Codex CLI**, **Cline / Roo Code**, **Continue.dev**, **Aider**, and **Python OpenAI SDK / cURL**, plus a live `/v1` endpoint tester.

### 5. Developer Mode (`2D Lab (Dev)`)
- Toggling **Developer Mode** ON in Settings unlocks the interactive 2D K-Means++ & DBSCAN clustering workbench (10-run Session History, Batch Queue, CSV Manager, Vector PDF 1.4 export) plus thermal/memory stress simulators and raw node logs.

---

## Development & Testing

```bash
# 1. Install dependencies
npm install

# 2. Start Express + Vite development environment with live HMR
npm run dev      # http://localhost:3000

# 3. Run static type checking
npm run lint     # tsc --noEmit

# 4. Run automated test suite (Node.js test runner)
npm test         # 17 tests covering planners, tuners, catalogs & API

# 5. Build production bundle (client assets + standalone server bundle)
npm run build    # Compiles client to dist/ and server to dist/server.js

# 6. Run production server
npm start        # Starts production Express server on port 3000 (or $PORT)
```

---

## Deployment & Production

### 1. Docker / Container Deployment

A production-ready, multi-stage `Dockerfile` is included:

```bash
# Build Docker image
docker build -t clusterlab:latest .

# Run container (mapping port 3000)
docker run -d --name clusterlab -p 3000:3000 clusterlab:latest

# Health check
curl -s http://localhost:3000/health
```

### 2. Cloud Platforms (Google Cloud Run / Railway / Render / Heroku)

ClusterLab is fully compliant with 12-factor cloud deployment:
- **Port Binding:** Automatically reads `PORT` (or `PORT_APP`), defaulting to `3000`.
- **Health Check:** `GET /health` returns JSON `{"status":"ok"}` for container readiness and liveness probes.
- **Graceful Shutdown:** Intercepts `SIGINT` and `SIGTERM` to cleanly drain active SSE streams and connections.
- **Non-Root Execution:** The Dockerfile runs as unprivileged user `node` for enterprise security.

### 3. Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP port to bind the server | `3000` |
| `NODE_ENV` | Environment mode (`development`, `production`, `test`) | `production` |
| `UPSTREAM_LLAMA_URL` | Optional upstream `llama-server` / `clusterd` OpenAI endpoint | `""` |
| `VITE_APP_NAME` | Public client application title | `ClusterLab` |

---

## OpenAI-Compatible API Endpoints

ClusterLab exposes standard OpenAI `/v1` endpoints:

- `GET /health` — Service status, active model, and node telemetry
- `GET /v1/models` — List active model and available GGUF presets with cluster fit metadata
- `POST /v1/chat/completions` — Streaming (`stream: true`) SSE & JSON chat completions with per-node `x_cluster_trace`
- `GET /api/cluster/state` — Live telemetry and layer allocation plan
- `GET /api/hf/models?q=<search>` — Hugging Face Hub GGUF model explorer
- `GET /api/backends/script?os=windows|linux` — Downloadable tuned hardware runner script

