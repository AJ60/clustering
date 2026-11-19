# Changelog

All notable changes to **ClusterLab** are documented in this file.

## [2.0.0] - 2026-11-19

**Author:** AJ60

### Changed & Added (React + TypeScript + Vite Rewrite & 1-Hop Star Simplification)
- **Simplified 1-Hop Star GGUF Cluster Home Dashboard (`StarClusterDashboard`):**
  - Replaced the complex 2D graph landing screen with a user-friendly **1-Hop Star GGUF Cluster** dashboard aligned with `AJ60/clustering`.
  - Added 4 quantized GGUF model presets (`Qwen3-30B-A3B MoE`, `BitNet b1.58 Ternary`, `Qwen2.5-32B Dense`, `Llama-3.3-70B Dense`) and a `This Device` vs `4-Node Cluster Test` segmented switch.
  - Implemented cap-bounded layer allocation (`computeAndroidSafeCap` `<= 50%`, `computeDesktopSafeCap`, `computeVramSafeCap`), proportional node scoring, fit verdicts (`Fast`, `Best Fit`, `Streaming`), interactive SVG Star Topology, and clickable allocation table (`src/domain/starClusterPlanner.ts`).
  - Integrated **Thermal Guard** (`COOL`, `WARN`, `SHED_25`, `EMERGENCY_OFFLOAD`) with anti-flapping hysteresis.
- **3-Card Streamlined Default Layout:** Organized everyday controls into **Connect** (Auto-Connect, 21×21 QR scanner, Start/Stop Sharing), **Health** (calibrated speed, Safe RAM Cap, WebGL/WASM backend, battery/thermal check, Re-Tune Speed), and **Troubleshooter** (6-check Auto-Diagnosis with 1-click auto-fixes).
- **Developer Mode Gate (`2D Lab (Dev)`):** Moved the entire interactive 2D K-Means & DBSCAN Lab (canvas, Voronoi/trails, 6 presets, Session History, Batch Queue, CSV Manager, Vector PDF 1.4 export, and Coach-Mark tour) plus USB/LAN bind switches, thermal/memory stress buttons, and raw event logs behind **Developer Mode** in Settings.
- **Cross-Platform Web Stack:** Built on React 19, TypeScript 5.8 (`strict`, `noUnusedLocals`, `noUnusedParameters`), Vite 6, Tailwind CSS v4, and `Plus Jakarta Sans` + `JetBrains Mono` typography.

---

## [1.0.0] - 2026-11-19 (Prior Native Release)

**Author:** AJ60

### Added
- Original Android Jetpack Compose + Material 3 2D Clustering Lab, Room/DataStore persistence, vector PDF export, `clusterd` Rust orchestrator, `clusterd_ruby` zero-config daemon, and legacy hardware survival safeguards.
