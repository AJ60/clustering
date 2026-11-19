# ClusterLab — 1-Hop Star GGUF Cluster (React + TypeScript + Vite)

ClusterLab is a simplified **1-Hop Star GGUF Cluster** coordinator and device-pairing dashboard built with React 19, TypeScript, Vite, and Tailwind CSS v4, aligned with the `AJ60/clustering` planner & thermal guard model.

The default home screen focuses on cluster readiness and simplicity. Advanced 2D machine learning visualization (**2D K-Means & DBSCAN Lab**) and raw telemetry controls are cleanly tucked behind **Developer Mode**.

---

## Core Features

### 1. 1-Hop Star GGUF Cluster Dashboard (Default Home View)
- **Model Presets & Topology Mode:**
  - Built-in quantized GGUF presets: `Qwen3-30B-A3B MoE` (Q4_K_M, 18.5 GB, 48L), `BitNet b1.58 Ternary` (TQ1_0, 6.4 GB, 36L), `Qwen2.5-32B Dense` (Q4_K_M, 19.8 GB, 64L), and `Llama-3.3-70B Dense` (Q4_K_M, 40.5 GB, 80L).
  - Switch seamlessly between **This Device** and **4-Node Cluster Test** (Master + Edge/Desktop/Mobile workers).
- **Safe RAM Pool & Cap-Bounded Layer Allocation:**
  - Enforces hard platform safety caps: Android `<= 50%` physical RAM (`computeAndroidSafeCap`), Desktop `MemAvailable - 1024 MB` (`computeDesktopSafeCap`), and `90%` VRAM (`computeVramSafeCap`).
  - Scores each node, evaluates overall fit verdict (`Fast`, `Best Fit`, `Streaming`), renders an interactive **1-Hop Star SVG Topology**, and provides a clickable layer-allocation table.
- **Thermal Guard (`ThermalBalancer`):**
  - Tracks 4 thermal states (`COOL`, `WARN`, `SHED_25`, `EMERGENCY_OFFLOAD`) with anti-flapping hysteresis (`30s` minimum hold / `5.0°C` margin).

### 2. Three Simple Operational Cards (Connect, Health, Troubleshooter)
- **Connect:** Auto-discover Master (`Auto-Connect` / `Auto-Discover`), pair via deterministic **21×21 CRC-8 QR code** or camera scanner (`getUserMedia`), and `Start` / `Stop Sharing` with immediate RAM release.
- **Health:** Displays calibrated compute speed, Safe RAM Cap, WebGL/WASM backend probe, battery/thermal headroom, and `Re-Tune Speed`.
- **Troubleshooter:** Runs the 6-check `Run Auto-Diagnosis` suite (calibration, transport bind, master reachability, sharing state, battery/thermal headroom, free RAM) with 1-click auto-fixes.

### 3. Developer Mode & 2D Clustering Lab (`2D Lab (Dev)`)
Enabling **Developer Mode** in Settings unlocks:
- **2D Lab (Dev) Workbench:**
  - Interactive `[0, 1]` 2D canvas with K-Means (K-Means++, Voronoi cells, animated convergence trails, spider lines) and DBSCAN (`ε` / `MinPts`, BFS waves, Core/Border/Noise markers).
  - 6 benchmark presets (Two Moons, Gaussian Blobs, Concentric Rings, Anisotropic Streaks, Twin Spirals, Dense + Outliers), long-press/right-click cluster annotations, 10-run Session History with `BEST` inertia badge, Sequential Batch Queue, CSV/JSON Storage Manager, and Vector PDF 1.4 export + preview.
- **Developer Node & Thermal Controls:** USB vs Wi-Fi LAN bind switch, cluster secret & 32-byte auth token inspection, interactive `SHED_25` / `EMERGENCY_OFFLOAD` / `SHED_LAYERS` stress-test buttons, and raw node event log.

---

## Project Structure

```text
src/
├── components/
│   ├── StarClusterDashboard.tsx     # Main 1-Hop Star GGUF dashboard & Connect/Health/Troubleshooter cards
│   ├── HardenedNodeDashboard.tsx    # Shared QR matrix/camera scanner modal & worker controls
│   ├── InteractiveClusterCanvas.tsx # Dev-gated 2D K-Means & DBSCAN canvas
│   ├── ControlAndMetricsPanels.tsx  # Dev-gated hyperparameters, presets & breakdown metrics
│   ├── SessionHistorySection.tsx    # 10-run rolling session history strip & modal
│   ├── BatchProcessingSection.tsx   # Multi-dataset batch runner & executive PDF export
│   ├── PdfReportSection.tsx         # Single/batch vector PDF preview & manager
│   ├── LocalCsvStorageSection.tsx   # Dev-gated CSV storage manager
│   ├── SettingsMenuDialog.tsx       # Dark/Light theme & Developer Mode gate
│   ├── UserGuideDialog.tsx          # 6-step interactive quick guide
│   └── CoachMarkOverlay.tsx         # Dev-gated 2D Lab 3-step spotlight walkthrough
├── domain/
│   ├── starClusterPlanner.ts        # Safe RAM caps, node scoring, layer allocation, thermal guard
│   ├── clusteringEngine.ts          # K-Means++ & DBSCAN iterative engines + Silhouette/WCSS
│   ├── datasetGenerators.ts         # 6 benchmark presets & CSV/JSON parser
│   ├── qrCodec.ts                   # Deterministic 21×21 CRC-8 pairing QR matrix & auth hash
│   └── pdfGenerator.ts              # Zero-dependency Vector PDF 1.4 generator
├── hooks/
│   ├── useNodeWorkerStore.ts        # Hardware calibration, diagnostics, sharing & telemetry store
│   └── useClusterLabStore.ts        # 2D Lab, session history, batch queue & settings store
├── service/
│   ├── hardwareProbe.ts             # Browser dot-product benchmark, RAM/WebGL/Battery probes
│   └── nodeClusterService.ts        # 6-check auto-diagnosis engine & auto-fix handlers
├── data/
│   └── storage.ts                   # Versioned localStorage state persistence
└── types/
    ├── starCluster.ts               # GGUF presets, thermal states, star topology & plan types
    └── clustering.ts                # 2D clustering, worker telemetry & studio state types
```

---

## Development

```bash
npm install
npm run dev      # Starts Vite dev server on http://0.0.0.0:3000
npm run lint     # Runs TypeScript type checking (tsc --noEmit)
npm run build    # Type-checks (tsc -b) and builds production bundle to dist/
npm run preview  # Previews production bundle on http://0.0.0.0:3000
```
