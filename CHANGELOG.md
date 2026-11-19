# Changelog

All notable changes to **ClusterLab** are documented in this file.

## [1.0.0] - 2026-11-19

**Author:** AJ60

### Added
- **Interactive 2D Clustering Lab (Android, Jetpack Compose + Material 3)**:
  - Real-time K-Means (with K-Means++ initialization) and DBSCAN clustering on an interactive 2D coordinate canvas with tap, brush, erase, and pan/zoom tools.
  - Smooth ease-out K-Means centroid transition animation between iterations with real-time Voronoi & spider-line morphing, animated convergence trails, departure ghost rings, directional shift arrowheads, and an on-canvas iteration convergence pill.
  - Benchmark dataset presets (Two Moons, Concentric Rings, Gaussian Blobs, Anisotropic Clusters, Noisy Outliers).
  - Live translucent canvas quality overlay showing real-time Silhouette and Inertia (WCSS) scores with tap-to-cycle modes (`Both`, `Silhouette`, `Inertia`).
  - **Session History** tracking the last 10 clustering runs, relative Inertia comparison bars, lowest-inertia highlight, and one-tap jump-back restoration without duplicating history.
  - Interactive first-launch 3-step Coach-Mark spotlight tour covering the canvas, gesture controls, and Run button, with one-tap replay from the built-in User Guide.
  - Persistent Dark and Light Studio themes (via Jetpack DataStore) tuned for visual comfort during extended sessions.
  - Printable PDF summary report generator exporting a visualization snapshot, convergence metrics, per-cluster breakdown, and user-authored cluster annotations directly to local storage or any user-chosen folder via SAF.
  - **Long-Press Cluster Annotations**: Long-press any cluster area on the 2D canvas (or an existing note pin) to attach, edit, or delete custom text annotations that render directly on the canvas, persist across Session History & Batch runs, and appear on both the plot snapshot and Section 4 of exported PDF reports.
  - **Batch Processing** queue allowing multiple datasets to be clustered sequentially with automatic combined multi-page PDF summary report generation (executive comparison table + individual visualization snapshot pages).
  - Local Room persistence for dataset snapshots and zero-permission SAF CSV/JSON import and export.
  - Beginner-first simplified UI with an opt-in **Developer Mode** toggle (persisted in DataStore) that keeps advanced knobs, raw telemetry, and CSV tooling out of the way until needed.
- **Cross-Device Worker Orchestration (`clusterd` + Android `RpcService`)**:
  - Zero-root Android worker service supporting API 28–36 with automatic hardware calibration, thermal throttling, battery awareness, and a strict `<= 50%` physical RAM cap.
  - One-tap Auto-Diagnosis and Auto-Fix troubleshooter for both the Android app and the embedded desktop Web Dashboard.
  - Mixed-OS clustering across Windows, Linux, Android, and ARM64 edge boards (e.g., Raspberry Pi 400) with 32-byte keyed handshake authentication, UDP auto-discovery (`:50050`), CameraX 21x21 CRC-8 QR pairing, and `< 6s` fault rebalancing.
  - **Pure-Ruby Zero-Config Auto-Cluster (`clusterd_ruby/`)**:
    - 100% Ruby standard-library orchestrator, worker node daemon, hardware prober, zero-WebGL ES5-safe Web Dashboard, and cross-platform installer (`install.rb`) with zero external gems and zero compilation.
    - One-command `clusterd auto` mode automatically elects Master on the first node and auto-joins subsequent heterogeneous devices (Windows, Linux, macOS, Android, Raspberry Pi, legacy laptops) over UDP `:50050` with HTTP fallback.
    - Scales across 12+ mixed nodes with dynamic proportional layer splitting, automatic slow/legacy-node pruning and un-pruning, and `< 3s` multi-node failover rebalancing.
  - **Legacy Hardware & Old Graphics Survival (Rust + Ruby + Android)**:
    - Automatic detection of low-RAM (`<= 2–3 GB`), 32-bit ARMv7/x86, OpenGL ES `< 3.1`, and legacy/software GPUs (Adreno 3xx–5xx, Mali-400/T/G51–G72, PowerVR, Intel GMA/HD 2000–4000, `llvmpipe`, VideoCore IV).
    - Android APK expanded to `arm64-v8a`, `armeabi-v7a`, and `x86_64`; Canvas Voronoi/ring overdraw cut >4× in legacy graphics mode; `CoachMarkOverlay` switched to universal 4-rect surround scrims (zero `BlendMode.Clear` offscreen driver artifacts); `<= 40%` physical RAM guard on `<= 2 GB` devices.
  - **Rust `clusterd` Production & Scaling Hardening**:
    - Resolved Windows FFI/dead-code warnings (`MEMORYSTATUSEX`, `IO_COUNTERS`, `JOBOBJECT_*`, `snake_case` `extern "system"` params, re-exported `check_windows_firewall_ports`), gated BSD `Command` import, and hardened Unix `killpg` against recycled PIDs.
    - Eliminated `Mutex::lock().unwrap()` and address-parse panics, parallelized multi-node health polling via bounded `std::thread::scope` waves, offloaded UDP `:50050` registrations with bounded connection concurrency (`MAX_CONCURRENT_CONNECTIONS`), disambiguated same-host LAN worker IDs (`ip:port`), and preserved Master `>= 1` layer under 12+ node scaling.
    - Added zero-config `clusterd auto` mode (`discover_master_via_udp`), `FLAG_LEGACY_HARDWARE` / `FLAG_LEGACY_GRAPHICS` handshake bits, `-ngl 0` + `GGML_VK_VISIBLE_DEVICES=""` child env guards, ES5 `XMLHttpRequest` + `escHtml()` XSS-safe Web UI updates, and fixed QR `DEFAULT_CLUSTER_SECRET` alignment.
  - One-command installers for Windows (`install_windows.ps1` / `install_windows.cmd`) and Linux (`install_linux.sh`), plus Android NDK r28 16 KB page-aligned and non-root Termux build scripts.
