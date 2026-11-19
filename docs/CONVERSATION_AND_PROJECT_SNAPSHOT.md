# ClusterLab — Conversation & Project Snapshot

- **Project Name**: `ClusterLab`
- **Author**: AJ60 (`MIT License`)
- **Snapshot Date**: `2026-11-19`

---

## 1. Conversation Milestones Completed

1. **Core Android App (`app/`)**:
   - Interactive 2D Clustering Canvas (Jetpack Compose + Material 3) supporting K-Means (with K-Means++ initialization) and DBSCAN, tap/brush/erase tools, pan/zoom, and benchmark presets (`Two Moons`, `Concentric Rings`, `Gaussian Blobs`, `Anisotropic Clusters`, `Noisy Outliers`).
   - Live Silhouette & Inertia (WCSS) overlay with tap-to-cycle display modes.
   - **Smooth K-Means Centroid Transition Animation**: Ease-out iteration transition animation showing convergence trails, departure ghost rings, directional shift arrowheads, Voronoi/spider-line morphing, and an iteration convergence pill.
   - **Long-Press Cluster Annotations**: Long-pressing a cluster area or pin lets users add, edit, or delete custom text annotations that appear on the canvas, persist in Session History & Batch runs, and render on both plot snapshots and Section 4 of exported PDF reports.
   - **Batch Processing Queue & Multi-Page PDF Summary Reports**: Allows queuing multiple datasets for sequential clustering and automatically generates a combined multi-page PDF summary report with an executive comparison table, per-run pages, plot snapshots, metrics, and cluster annotations.
   - **Legacy Hardware & Graphics Survival (Android)**: Added `arm64-v8a`, `armeabi-v7a`, and `x86_64` ABI support; reduced Canvas Voronoi/ring overdraw on legacy GPUs; replaced `BlendMode.Clear` offscreen compositing in `CoachMarkOverlay` with 4-rect surround scrims; added `<= 40%` physical RAM safety capping on `<= 2 GB` devices.

2. **Pure-Ruby Zero-Config Auto-Cluster (`clusterd_ruby/`)**:
   - Standard-library-only Ruby implementation (`clusterlab/protocol.rb`, `hardware_probe.rb`, `worker.rb`, `orchestrator.rb`, `web_ui.rb`, `bin/clusterd`, `install.rb`).
   - Zero-config `clusterd auto` command that discovers a LAN Master via UDP `:50050` (with HTTP fallback) or promotes to Master if none exists.
   - Supports 12+ mixed nodes, automatic slow/legacy node pruning/un-pruning, `< 3s` failover rebalancing, legacy CPU/GPU (`-ngl 0`) protection, and a zero-WebGL ES5 Web Dashboard.

3. **Rust Distributed Orchestrator (`clusterd/`)**:
   - Fixed Windows FFI and dead-code lints (`MEMORYSTATUSEX`, `IO_COUNTERS`, `JOBOBJECT_*`, `snake_case` `extern "system"` params, re-exported `check_windows_firewall_ports()`), gated BSD `Command` import, and guarded Unix `killpg` shutdown against recycled PIDs.
   - Eliminated production `.lock().unwrap()`, `.parse().unwrap()`, and `.expect()` panic paths.
   - Parallelized multi-node health polling using bounded `std::thread::scope` waves (`<= 32` workers per wave), offloaded UDP `:50050` worker registration from the receiver loop, bounded concurrent socket handler threads (`MAX_CONCURRENT_CONNECTIONS = 64`), disambiguated same-host LAN worker IDs (`ip:port`), and preserved `>= 1` layer on the Master at 12+ node scale.
   - Added zero-config `clusterd auto` mode, `FLAG_LEGACY_HARDWARE` / `FLAG_LEGACY_GRAPHICS` protocol flags, `<= 40%` RAM capping for `<= 2 GB` hardware, `-ngl 0` and software-rendering child env vars, ES5 `XMLHttpRequest` + `escHtml()` XSS-safe dashboard scripting, and `DEFAULT_CLUSTER_SECRET` alignment in `render_pairing_qr_svg`.

---

## 2. Project Layout

- `app/` — Android Jetpack Compose application (`MainActivity`, ViewModel, Canvas, Batch & PDF exporters, Room DB, DataStore, `RpcService`)
- `clusterd/` — Rust cross-platform Master/Worker daemon & Web UI crate (`Cargo.toml`, `src/*.rs`)
- `clusterd_ruby/` — Pure-Ruby standard-library `clusterd` implementation and installer
- `installers/` — Windows (`install_windows.ps1` / `.cmd`) and Linux (`install_linux.sh`) setup scripts
- `scripts/` — Mixed-cluster verification harness (`verify_mixed_cluster.py`) and NDK/Termux build scripts
- `docs/` — Hardware testing notes and session documentation
- `.github/workflows/` — 3-OS native & emulator CI matrix (`native-matrix-ci.yml`)

---

## 3. Verification Status at Snapshot Time

- **Mixed-Cluster Verification (`python3 scripts/verify_mixed_cluster.py`)**: Passed (`7/7`).
- **Rust Static Delimiter & Panic Audit**: Passed (balanced delimiters across all `.rs` files; zero `.lock().unwrap()` / `.expect()` in production paths).
- **Android Build (`compile_applet`)**: Succeeded.
- *Note*: `cargo` / `rustc` is unavailable inside the Android cloud build container; run `cargo test --all-targets` locally or via GitHub Actions (`native-matrix-ci.yml`).
