# ClusterLab (React + TypeScript + Vite)

ClusterLab is an interactive 2D machine learning clustering studio and hardware-calibrated compute node pairing web application, rewritten in React, TypeScript, Vite, and Tailwind CSS.

## Core Features

### 1. 2D Clustering Studio (`2D Lab`)
- **Interactive 2D Canvas (`[0, 1]` world space):** Tap/click to plot points, drag to brush-paint or erase points, mouse-wheel zoom & drag pan, and right-click or hold (`500ms`) on any cluster to attach PDF-ready annotations.
- **K-Means & DBSCAN Engines:**
  - **K-Means:** Configurable `K` (`2..10`), K-Means++ or random seeding, animated centroid gliding (`requestAnimationFrame`), Voronoi cell regions, centroid movement trails with directional arrowheads, spider lines, WCSS inertia, and Silhouette evaluation.
  - **DBSCAN:** Configurable neighborhood radius `ε` (`0.025..0.22`) and `MinPts` (`2..15`), BFS density wave frames, ε-neighborhood core rings, and Core / Border / Noise outlier markers.
- **6 Benchmark Presets:** Two Moons, Gaussian Blobs, Concentric Rings, Anisotropic Streaks, Twin Spirals, and Dense + Outliers (with configurable Sample Points & Scatter Noise in Developer Mode).
- **Rolling 10-Run Session History:** Automatically records distinct runs with lowest-inertia `BEST` highlight and 1-tap restore.
- **Vector PDF 1.4 Reports & Sequential Batch Runner:** Export single-page A4 vector PDF reports or queue multiple presets/snapshots in Batch Processing to build a multi-page Executive Comparison PDF with an inline preview modal.
- **Developer Mode:** Unlocks Brush & Pan/Zoom tools, step-by-step iteration playback, Cluster Breakdown Metrics Inspector, CSV/JSON paste & file import/export, snapshots (`localStorage`), and local CSV file manager.
- **Dark & Light Studio Themes + Walkthrough:** Persisted theme preference, interactive 7-step User Guide, and 3-step spotlight Coach-Mark tour.

### 2. Connect Phone / Worker Node Dashboard (`Connect Phone`)
- **Hardware Calibration & Probes:** Runs a deterministic float dot-product micro-benchmark paired with browser `hardwareConcurrency`, `deviceMemory`, WebGL renderer, and Battery Status probes to enforce a safe RAM cap (`<= 50%`).
- **6-Check Connection Troubleshooter:** Validates calibration, USB/LAN transport, master reachability, sharing state, battery/thermal headroom, and free RAM with 1-click fixes.
- **21×21 CRC-8 QR Pairing & Camera Scanner:** Renders deterministic pairing QR matrices, decodes QR frames via `getUserMedia` webcam ROI sampling or instant frame verification, and derives the 32-byte keyed auth token (`computeClusterAuthTokenHex`).

## Development

```bash
npm install
npm run dev      # Starts Vite on http://0.0.0.0:3000
npm run lint     # Runs TypeScript type checking (tsc --noEmit)
npm run build    # Builds production bundle to dist/
```
