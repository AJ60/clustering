# Local Hardware Testing & Publication Runbook

**Project:** ClusterLab v1.0  
**Author:** AJ60

This guide walks through testing ClusterLab on physical Android, Windows, Linux, and ARM64 edge hardware before shipping a release build.

---

## 1. Pre-Flight Automated Verification

Run these checks locally before flashing devices:

```bash
# 1. Android unit & Robolectric tests (API 29 + API 36)
gradle :app:testDebugUnitTest

# 2. Mixed-OS wire protocol, QR codec, UDP discovery & rebalancing proof
python3 scripts/verify_mixed_cluster.py

# 3. Rust daemon unit tests (Windows or Linux host with Rust installed)
cd clusterd && cargo test --all-targets
```

Expected results:
- All Robolectric tests pass on both SDK 29 and SDK 36.
- `verify_mixed_cluster.py` reports **6/6 PASS**.
- `cargo test` passes with zero warnings or failures.

---

## 2. Testing on a Physical Android Phone

### Install the Debug APK via USB
1. Enable **Developer Options** and **USB Debugging** on the Android device (Android 9 / API 28 or newer).
2. Connect via USB and build/install:
   ```bash
   gradle :app:assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

### On-Device Functional Checklist
- [ ] **First-Launch Coach-Mark Tour:** Verify the 3-step spotlight highlights the Canvas, Gesture Controls, and **Run** button without clipping on your screen aspect ratio. Tap **Skip** or **Run & Start**, force-close the app, relaunch, and confirm the tour does not repeat automatically.
- [ ] **Interactive Canvas & Quality HUD:** Tap and drag to add/erase points. Confirm the top-left Silhouette & Inertia badge updates immediately and cycles modes (`Both` -> `Silhouette` -> `Inertia`) on tap.
- [ ] **Session History:** Change `K`, switch to DBSCAN, and load 2–3 presets (at least 11 runs total). Confirm the Session History strip caps at `10/10`, highlights the lowest-inertia run, and jumps back cleanly when tapping an older run without creating duplicate entries.
- [ ] **PDF Summary Report:** Save a local PDF from the PDF card and test **Open**, **Share**, and **Save to Folder (SAF)**. Confirm the plot snapshot, metrics grid, and `ClusterLab v1.0 (AJ60)` footer render crisply.
- [ ] **Dark / Light Theme Persistence:** Open Settings, switch to Light Studio mode, close and relaunch the app, and confirm Light mode persists via DataStore.
- [ ] **Developer Mode Gate:** Confirm advanced CSV tools, step-by-step playback controls, Voronoi/MinPts sliders, and raw node controls stay hidden until **Developer Mode** is toggled ON in Settings.
- [ ] **User Guide & Tour Replay:** Open the `?` button in the top bar, review the 7-step guide, and tap **Replay Interactive Tour**.

---

## 3. Testing Mixed-OS & Legacy-Hardware Clustering (Pure Ruby + Android)

### A. Zero-Config Pure-Ruby Auto-Cluster (Recommended — Zero Compilation)
1. **First Device (Any Windows, Linux, macOS, or Legacy Laptop with Ruby 2.7+):**
   ```bash
   ruby clusterd_ruby/bin/clusterd auto
   ```
   Wait 1.5 seconds — with no other Master on the LAN, it automatically promotes to Master, starts UDP `:50050` discovery, and serves the zero-WebGL Web Dashboard at `http://<LAN_IP>:8080`.
2. **Every Additional Device (PCs, Raspberry Pi, Old Laptops, Termux):**
   Run the exact same command:
   ```bash
   ruby clusterd_ruby/bin/clusterd auto
   ```
   Each device auto-detects its RAM/CPU/GPU, applies legacy CPU/RAM guards automatically if needed, discovers the Master on LAN, registers itself, and receives proportional layers immediately.
3. **Run the Built-in 12-Node Scaling Self-Test:**
   ```bash
   ruby clusterd_ruby/bin/clusterd self-test
   ```
4. *(Optional)* If you prefer the compiled Rust daemon in `clusterd/`, run `installers\install_windows.cmd` (Windows) or `./installers/install_linux.sh` (Linux).

### B. Pair an Android Phone Over Wi-Fi
1. Ensure the Android phone and Master PC are on the same local Wi-Fi network (AP client isolation disabled).
2. Open **ClusterLab** -> **Connect Phone** tab.
3. Confirm **Auto-Optimized** finishes automatically and locks Memory Cap to `<= 50%` of physical RAM.
4. Tap **Auto-Connect** (uses UDP `:50050` discovery) or **Scan QR** and scan the QR code on your PC screen.
5. Verify the phone appears as **Active & Helping** in the Master Web UI.

### C. Pair an Android Phone Over USB Cable (Zero Wi-Fi)
1. Connect the phone via USB and run:
   ```bash
   adb forward tcp:50052 tcp:50052
   ```
2. On the phone, enable **Developer Mode** in Settings, switch bind mode to **USB Cable (127.0.0.1)**, and start the worker.
3. On the Master PC, click **Scan Nodes** or add `127.0.0.1:50052`.

### D. Optional: Add a Secondary PC or Raspberry Pi 400 Worker
```bash
# On Linux / Raspberry Pi:
~/.local/bin/clusterlab-worker --master <MASTER_LAN_IP>:8080

# On Windows:
Start-ClusterLab-Worker.cmd --master <MASTER_LAN_IP>:8080
```
Click **Run Quick Test** in the Master Web Dashboard and confirm tokens stream cleanly across all online nodes.

### E. Optional: Build 16 KB Page-Aligned Native Binaries (Android 15/16)
If bundling native `rpc-server` binaries into `app/src/main/jniLibs/arm64-v8a/`:
```bash
export ANDROID_NDK_HOME=/path/to/android-ndk-r28
./scripts/build_android_ndk28.sh
```
The script verifies `0x4000` (16 KB) ELF `LOAD` segment alignment and Bionic-only linking automatically.

---

## 4. Release Build & Google Play Publication Checklist

1. **Generate an Upload Keystore** (keep it outside git—`*.jks` is ignored in `.gitignore`):
   ```bash
   keytool -genkeypair -v -keystore my-upload-key.jks \
     -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```
2. **Set Signing Environment Variables** and build the Play Store App Bundle (`.aab`):
   ```bash
   export KEYSTORE_PATH="$(pwd)/my-upload-key.jks"
   export STORE_PASSWORD="<your-store-password>"
   export KEY_PASSWORD="<your-key-password>"
   gradle :app:bundleRelease
   ```
   Output: `app/build/outputs/bundle/release/app-release.aab`
3. **Final Play Console Checks:**
   - App title is `ClusterLab` (10 characters, <= 30 char limit, no emojis or buzzwords).
   - Adaptive launcher icon (`mipmap-anydpi-v26`) verified on both circular and squircle launchers.
   - `RpcService` declares `android:foregroundServiceType="dataSync"` and `android:exported="false"`.
   - Zero broad storage permissions (`READ_EXTERNAL_STORAGE` / `READ_MEDIA_*` are never requested).
   - Privacy policy note: All clustering datasets, PDF reports, Room snapshots, and DataStore preferences remain strictly on-device; optional LAN worker traffic stays on the user's local network.
