# ClusterLab

**Author:** AJ60  
**License:** MIT  
**Platforms:** Android (API 28–36, arm64-v8a / armeabi-v7a / x86_64), Windows, Linux, macOS, Raspberry Pi / Legacy PCs (Pure Ruby stdlib)

ClusterLab is a two-part toolkit:

1. **2D Clustering Workbench (Android):** An interactive Jetpack Compose studio for experimenting with **K-Means** and **DBSCAN** clustering in real time, evaluating cluster quality with live **Silhouette** and **Inertia (WCSS)** overlays, comparing the last **10 Session History** runs, running sequential **Batch Processing** queues, and exporting printable **PDF summary reports**.
2. **Zero-Config Pure-Ruby Auto-Cluster (`clusterd_ruby/` + Android Worker):** A zero-gem, pure-Ruby standard-library orchestrator and worker daemon that scales effortlessly across mixed devices (Windows, Linux, macOS, Android, Raspberry Pi, and older low-RAM / legacy-GPU machines) with one command (`ruby clusterd_ruby/bin/clusterd auto`), plus an optional native Rust supervisor (`clusterd/`).

---

## Key Features

### 2D Clustering Studio (Android)
- **Live Interactive Canvas:** Tap or drag to add, brush, or erase 2D points and watch K-Means centroids or DBSCAN density clusters update immediately.
- **Real-Time Quality Overlay:** Floating HUD on the canvas displays live Silhouette (`-1` to `1`) and Inertia (WCSS) scores. Tap the badge to cycle between `Both`, `Silhouette`, and `Inertia`.
- **Session History (Last 10 Runs):** Tracks your 10 most recent runs with relative inertia bars, highlights the lowest-inertia run, and lets you jump back to any previous configuration in one tap without polluting history.
- **First-Launch Interactive Tour & User Guide:** Spotlight walkthrough introduces the canvas, gesture tools, and Run button on first launch and can be replayed anytime from the built-in 7-step User Guide.
- **PDF Summary Reports:** Generates local A4 PDF reports containing a rendered snapshot of the current plot, quality KPIs, and a per-cluster centroid breakdown. Supports local storage management, system sharing, and zero-permission Storage Access Framework (SAF) folder export.
- **Batch Processing & Combined PDF:** Queue multiple datasets (current canvas, benchmark presets, or saved snapshots) for sequential clustering and automatically generate a combined multi-page PDF summary (executive comparison page plus individual run snapshots).
- **Dark & Light Comfort Modes:** Persistent Dark Studio (default) and Light Studio themes backed by Jetpack DataStore, with edge-to-edge system bar styling.
- **Clean Default UI + Developer Mode:** Everyday controls stay focused and uncluttered. Toggling **Developer Mode** inside Settings unlocks step-by-step playback controls, Voronoi/trails/MinPts tuning, CSV/JSON import-export, saved Room snapshots, and raw worker telemetry.

### Multi-Device Auto-Scaling Cluster (`clusterd_ruby/` + Android)
- **One-Command Pure-Ruby Zero-Config Auto-Mode:** Run `ruby clusterd_ruby/bin/clusterd auto` on any machine with Ruby (zero gems, zero compilers). The first device automatically becomes the Master Orchestrator with UDP `:50050` discovery and a lightweight Web Dashboard; every additional machine automatically discovers the Master, calibrates itself, and joins the pool.
- **Survives Old Hardware & Old Graphics Everywhere:**
  - **Ruby Cluster & Web UI:** Auto-detects legacy CPUs (1–2 cores, 32-bit, Pentium/Core 2/ARMv7/Pi) and legacy/software GPUs (Intel GMA/HD 2000–4000, `llvmpipe`, Microsoft Basic Display, Mali-400, VideoCore IV). Automatically enforces `--n-gpu-layers 0`, `GGML_VK_VISIBLE_DEVICES=""`, conservative `<= 40%` RAM ceilings on `<= 2 GB` machines, and a zero-WebGL / zero-blur ES5-safe Web Dashboard.
  - **Android App (API 28–36, 32-bit & 64-bit):** Ships `arm64-v8a`, `armeabi-v7a`, and `x86_64` ABIs, auto-detects low-RAM and OpenGL ES `< 3.1` / legacy GPUs (Adreno 3xx–5xx, Mali-400/T-series/G51–G72, PowerVR, Tegra), cuts canvas Voronoi/ring overdraw by >4×, and uses 4-rect spotlight scrims (zero `BlendMode.Clear` offscreen glitches).
- **Dynamic Multi-Node Scaling & Failover:** Proven across 12+ heterogeneous nodes with automatic pruning of slow/legacy nodes on small models, automatic un-pruning on large models, and `< 3s` fault rebalancing on node crash, thermal throttle, or memory shedding.
- **1-Tap Auto-Connect & QR Pairing:** Scan the 21x21 CRC-8 QR code from the Web Dashboard or tap **Auto-Connect** in the Android app to pair automatically over LAN.

---

## Repository Structure

```text
.
├── app/                         # Android Kotlin + Jetpack Compose application (API 28–36)
│   ├── src/main/java/com/example/
│   │   ├── data/                # Room DB, DataStore prefs, Local CSV & PDF report generators
│   │   ├── domain/              # K-Means, DBSCAN, Silhouette/WCSS engine & dataset presets
│   │   ├── model/               # Immutable state, config, and Session History models
│   │   ├── service/             # Zero-root RpcService, HardwareProbe & NodeAutoCalibrator
│   │   └── ui/                  # ViewModel, adaptive layouts, Canvas, Coach-Marks & dialogs
│   └── src/test/                # Robolectric JVM test suite (API 29 & 36)
├── clusterd/                    # Zero-dependency Rust Master/Worker daemon & embedded Web UI
│   └── src/                     # protocol.rs, orchestrator.rs, supervisor.rs, sys_probe.rs, web_ui.rs
├── installers/                  # One-command desktop installers
│   ├── install_windows.ps1      # Windows 10/11 PowerShell installer + Firewall + launchers
│   ├── install_windows.cmd      # Double-click Windows wrapper
│   └── install_linux.sh         # Linux / Ubuntu / Raspberry Pi installer + systemd unit
├── scripts/
│   ├── build_android_ndk28.sh   # 16 KB ELF page-aligned Android arm64-v8a native build
│   ├── build_termux_nonroot.sh  # Optional non-root Termux setup on Android devices
│   └── verify_mixed_cluster.py  # Automated end-to-end mixed-OS cluster verification suite
├── docs/
│   └── LOCAL_HARDWARE_TESTING.md # Hardware test runbook & Play Store release checklist
└── .github/workflows/           # Cross-OS CI verification matrix (Linux, Windows, Android)
```

---

## Quick Start

### 1. Build & Test the Android App
Requires JDK 17+ (JDK 21 recommended) and Android SDK (API 36).

```bash
# Run the Robolectric unit test suite across Android API 29 & 36
gradle :app:testDebugUnitTest

# Build a debug APK for sideloading to a local phone
gradle :app:assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk

# Build a signed release AAB for Google Play (requires signing env vars)
gradle :app:bundleRelease
```

### 2. Zero-Config Multi-Node Cluster (Pure Ruby — Zero Gems, Zero Compilation)
Works on Windows, Linux, macOS, Raspberry Pi, Android/Termux, and older PCs with Ruby 2.7+:

```bash
# Run on Device 1 (automatically becomes Master + Web Dashboard on :8080):
ruby clusterd_ruby/bin/clusterd auto

# Run the exact same command on Device 2, 3, ... N (auto-discovers Master & joins!):
ruby clusterd_ruby/bin/clusterd auto

# Optional: install 1-click desktop/CLI launchers
ruby clusterd_ruby/install.rb

# Run the built-in 12-node mixed-OS scaling & failover self-test:
ruby clusterd_ruby/bin/clusterd self-test
```

### 3. Optional Native Rust Installers (Windows / Linux)
If you prefer the compiled Rust daemon in `clusterd/`:
- **Windows:** `powershell -ExecutionPolicy Bypass -File .\installers\install_windows.ps1`
- **Linux / Raspberry Pi:** `chmod +x installers/install_linux.sh && ./installers/install_linux.sh`

### 4. Run Automated Mixed-OS & Legacy-Hardware Verification
```bash
python3 scripts/verify_mixed_cluster.py
```

For full physical hardware test steps (Pure-Ruby zero-config LAN scaling, legacy hardware checks, USB ADB, Wi-Fi QR pairing, and Play Store release signing), see [`docs/LOCAL_HARDWARE_TESTING.md`](docs/LOCAL_HARDWARE_TESTING.md).

---

## Privacy, Permissions & Google Play Readiness
- **Minimal Permissions:** Uses Android's zero-permission Storage Access Framework (`OpenDocument` / `CreateDocument`) for CSV and PDF file access—no broad external storage permissions requested.
- **Runtime Camera Consent:** `CAMERA` is requested strictly on demand when opening the QR scanner, with graceful fallback to manual pairing or Auto-Connect.
- **Security Hygiene:** `RpcService` is declared `android:exported="false"` with explicit `foregroundServiceType="dataSync"`, and all files shared via `FileProvider` use scoped temporary URI permissions.
- **No Dynamic Code Loading:** All executable code is bundled cleanly inside the signed APK/AAB.

---

## Author & License

Created by **AJ60**. Released under the [MIT License](LICENSE).
