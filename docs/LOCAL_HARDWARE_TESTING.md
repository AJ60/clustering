# ClusterLab — Testing & Verification Runbook

**Project:** ClusterLab v2.0 (React + TypeScript + Vite)  
**Author:** AJ60

This guide covers automated verification and manual UI QA for the **1-Hop Star GGUF Cluster** dashboard and the Developer-gated **2D Lab (Dev)** workbench.

---

## 1. Automated Pre-Flight Verification

Run these commands from the project root:

```bash
# 1. Install dependencies
npm install

# 2. Strict TypeScript type check (noUnusedLocals + noUnusedParameters)
npm run lint

# 3. Production TypeScript + Vite bundle
npm run build

# 4. Start local dev server on port 3000
npm run dev
```

Expected results:
- `npm run lint` exits `0` with zero TypeScript errors.
- `npm run build` emits `dist/index.html` and hashed CSS/JS assets cleanly.
- `http://localhost:3000/` returns `HTTP 200 OK` with title `ClusterLab — 1-Hop Star GGUF Cluster`.

---

## 2. Default 1-Hop Star GGUF Cluster Checklist (Developer Mode OFF)

- [ ] **Clean Default Home View:** Verify the app opens directly to the **1-Hop Star GGUF Cluster** dashboard with no 2D canvas, no bottom tab bar, and no 2D onboarding coach-mark modal.
- [ ] **Model Presets & Topology Switch:** Switch between `Qwen3-30B-A3B MoE`, `BitNet b1.58 Ternary`, `Qwen2.5-32B Dense`, and `Llama-3.3-70B Dense`, and toggle `This Device` vs `4-Node Cluster Test`. Confirm KPI strip (Cluster Tier, Safe RAM Pool, Layer Allocation, Thermal Guard), Star SVG topology, and table rows update immediately.
- [ ] **Connect Card:**
  - Click **Auto-Connect** (or **Auto-Discover** in the top bar) and confirm Master endpoint populates.
  - Open **Scan QR**, verify the deterministic 21×21 QR matrix renders, and test webcam/manual QR payload pairing.
  - Click **Start Sharing** and **Stop Sharing**; confirm state updates and allocated worker RAM frees cleanly.
- [ ] **Health Card:** Verify calibrated compute speed, Safe RAM Cap (`<= 50%`), WebGL/WASM backend label, and battery/thermal headroom display properly, and test **Re-Tune Speed**.
- [ ] **Troubleshooter Card:** Click **Run Auto-Diagnosis** and verify all 6 checks run and offer working 1-click fixes for any warning/action items.
- [ ] **Theme Persistence:** Open Settings, switch between **Dark Studio** and **Light Studio**, refresh the page, and confirm the selected theme persists.

---

## 3. Developer Mode & `2D Lab (Dev)` Checklist

- [ ] **Unlock Gate:** Open Settings (`⚙`), enable **Developer Mode (2D Lab & Telemetry)**, and confirm:
  - The `Star Cluster` / `2D Lab (Dev)` mode switcher appears.
  - Developer Node Controls, Thermal Stress Simulator (`Cool`, `Test SHED_25`, `Test Emergency Offload`, `SHED_LAYERS`), and the Raw Node Event Log appear on the Star Cluster view.
- [ ] **Thermal Guard Stress Test:** Trigger `Test SHED_25` and `Test Emergency Offload` in Dev controls and verify layer allocation drops (`-25%` or `0` layers on the warming node) and shifts layers cleanly across healthy workers.
- [ ] **2D Lab Workbench:** Switch to **2D Lab (Dev)** and verify:
  - K-Means++ Voronoi/trails & DBSCAN `ε`/MinPts clustering animate smoothly.
  - 10-slot rolling Session History highlights `BEST` inertia and restores snapshots cleanly.
  - Batch Processing queue runs sequentially and opens the inline Vector PDF 1.4 preview modal.
  - CSV/JSON import, local CSV storage manager, and cluster annotations work end-to-end.
- [ ] **Clean Lock-Back:** Open Settings, toggle **Developer Mode** OFF, and confirm the app immediately returns to the 1-Hop Star GGUF Cluster view and hides the `2D Lab (Dev)` tab.
