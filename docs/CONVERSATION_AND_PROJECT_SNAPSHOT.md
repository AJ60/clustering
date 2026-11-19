# ClusterLab — Project Snapshot

- **Project Name**: `ClusterLab`
- **Author**: `AJ60` (`MIT License`)
- **Stack**: React 19 · TypeScript · Vite 6 · Tailwind CSS v4
- **Updated**: `2026-11-19`

---

## 1. Architecture & Implemented Milestones

1. **1-Hop Star GGUF Cluster Dashboard (Default Home Screen)**:
   - Model preset selector (`Qwen3-30B-A3B MoE`, `BitNet b1.58 Ternary`, `Qwen2.5-32B Dense`, `Llama-3.3-70B Dense`) paired with `This Device` and `4-Node Cluster Test` topology modes.
   - `starClusterPlanner.ts` enforces cap-bounded safe memory allocation (Android `<= 50%` RAM, Desktop `MemAvailable - 1024 MB`, 90% VRAM), node scoring, proportional layer distribution, and 4-state `ThermalBalancer` hysteresis (`COOL`, `WARN`, `SHED_25`, `EMERGENCY_OFFLOAD`).
   - Interactive 1-Hop Star SVG topology diagram and per-node layer allocation breakdown table.

2. **Three Simple Non-Developer Cards**:
   - **Connect**: Master endpoint auto-detection, deterministic **21×21 CRC-8 QR code** modal & webcam scanner (`CameraQrScannerDialog`), and `Start` / `Stop Sharing`.
   - **Health**: Calibrated float dot-product speed, Safe RAM Cap, WebGL/WASM backend probe, battery/thermal headroom, and `Re-Tune Speed`.
   - **Troubleshooter**: 6-check `Run Auto-Diagnosis` engine (`calibration`, `transport`, `reachability`, `sharing`, `battery/thermal`, `free RAM`) with 1-click auto-fixes.

3. **Developer-Gated `2D Lab (Dev)` & Telemetry**:
   - Toggling **Developer Mode** ON in `SettingsMenuDialog` unlocks the `Star Cluster` / `2D Lab (Dev)` switcher and reveals USB vs LAN bind controls, 32-byte auth token view, `SHED_25` / `EMERGENCY_OFFLOAD` / `SHED_LAYERS` stress-test triggers, and raw node event logs.
   - Inside `2D Lab (Dev)`: Interactive `[0, 1]` K-Means++ & DBSCAN canvas, 6 benchmark presets, rolling 10-run Session History with `BEST` badge, Sequential Batch Processing, CSV storage manager, interactive 3-step Coach-Mark spotlight tour, and zero-dependency Vector PDF 1.4 report exporter with inline modal preview.

---

## 2. Current Directory Layout

- `src/components/` — UI dashboards, canvas renderer, dialogs, and controls (`StarClusterDashboard.tsx`, `HardenedNodeDashboard.tsx`, `InteractiveClusterCanvas.tsx`, `SettingsMenuDialog.tsx`, `UserGuideDialog.tsx`, etc.)
- `src/domain/` — Pure TypeScript engines (`starClusterPlanner.ts`, `clusteringEngine.ts`, `datasetGenerators.ts`, `qrCodec.ts`, `pdfGenerator.ts`)
- `src/service/` — Browser hardware calibration & probe (`hardwareProbe.ts`) and 6-check auto-diagnosis (`nodeClusterService.ts`)
- `src/hooks/` — React state stores (`useNodeWorkerStore.ts`, `useClusterLabStore.ts`)
- `src/data/` — Versioned `localStorage` persistence (`storage.ts`)
- `src/types/` — Strict TypeScript interfaces (`starCluster.ts`, `clustering.ts`)
- `public/` — App icon and bundled fonts
- `docs/` — Project snapshot & testing runbook

---

## 3. Verification Status

- `npm run lint` (`tsc --noEmit`): Passes cleanly (`0` errors, strict mode with `noUnusedLocals` & `noUnusedParameters`).
- `npm run build` (`tsc -b && vite build`): Builds production bundle (`dist/`) cleanly.
- `npm run dev` (`vite --host 0.0.0.0 --port 3000`): Serves HTTP `200 OK` on port `3000`.
