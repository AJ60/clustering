import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlgorithmType,
  CLUSTER_COLORS,
  CANVAS_TOOL_LABELS,
  CanvasToolMode,
  CentroidState,
  ClusterAnnotation,
  ClusteringStepFrame,
  DataPoint,
  DbscanConfig,
  KMeansConfig,
  NOISE_POINT_COLOR,
} from '../types/clustering';
import { Grid3X3, Maximize2, MessageSquarePlus, Network } from 'lucide-react';

type QualityMetricMode = 'BOTH' | 'SILHOUETTE' | 'INERTIA';

interface InteractiveClusterCanvasProps {
  containerRef?: React.RefObject<HTMLDivElement | null>;
  algorithm: AlgorithmType;
  kMeansConfig: KMeansConfig;
  dbscanConfig: DbscanConfig;
  rawPoints: DataPoint[];
  currentFrame: ClusteringStepFrame | null;
  totalFrames: number;
  currentFrameIndex: number;
  toolMode: CanvasToolMode;
  showGrid: boolean;
  showSpiderLines: boolean;
  isDarkTheme: boolean;
  developerModeEnabled: boolean;
  annotations: ClusterAnnotation[];
  lastAddedPointId: number | null;
  onAddPoint: (wx: number, wy: number) => void;
  onErasePointsNear: (wx: number, wy: number) => void;
  onToggleGrid: () => void;
  onToggleSpiderLines: () => void;
  onOpenAnnotation: (
    clusterId: number,
    wx: number,
    wy: number,
    existing?: ClusterAnnotation
  ) => void;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clusterColor(clusterId: number): string {
  if (clusterId < 0) return NOISE_POINT_COLOR;
  return CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export const InteractiveClusterCanvas: React.FC<InteractiveClusterCanvasProps> = ({
  containerRef,
  algorithm,
  kMeansConfig,
  dbscanConfig,
  rawPoints,
  currentFrame,
  totalFrames,
  currentFrameIndex,
  toolMode,
  showGrid,
  showSpiderLines,
  isDarkTheme,
  developerModeEnabled,
  annotations,
  lastAddedPointId,
  onAddPoint,
  onErasePointsNear,
  onToggleGrid,
  onToggleSpiderLines,
  onOpenAnnotation,
}) => {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = containerRef ?? internalRef;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [canvasSize, setCanvasSize] = useState({ width: 640, height: 420 });
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [qualityMode, setQualityMode] = useState<QualityMetricMode>('BOTH');

  // Smooth centroid interpolation refs
  const displayedCentroidsRef = useRef<CentroidState[]>([]);
  const animFromCentroidsRef = useRef<CentroidState[]>([]);
  const targetCentroidsRef = useRef<CentroidState[]>([]);
  const centroidAnimStartRef = useRef<number>(0);

  // Touch ripple animation ref
  const rippleStateRef = useRef<{ pointId: number | null; startMs: number }>({
    pointId: null,
    startMs: 0,
  });

  // Pointer interaction refs
  const pointerDownRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    lastClientX: number;
    lastClientY: number;
    moved: boolean;
    longPressed: boolean;
    timerId: number | null;
    lastBrushMs: number;
  }>({
    active: false,
    pointerId: -1,
    startClientX: 0,
    startClientY: 0,
    lastClientX: 0,
    lastClientY: 0,
    moved: false,
    longPressed: false,
    timerId: null,
    lastBrushMs: 0,
  });

  const displayPoints = currentFrame?.points ?? rawPoints;
  const targetCentroids = currentFrame?.centroids ?? [];

  // Trigger centroid glide animation when target centroids change
  useEffect(() => {
    const prevDisplayed = displayedCentroidsRef.current;
    if (prevDisplayed.length === targetCentroids.length && prevDisplayed.length > 0) {
      animFromCentroidsRef.current = prevDisplayed.map((c) => ({ ...c }));
      targetCentroidsRef.current = targetCentroids.map((c) => ({ ...c }));
      centroidAnimStartRef.current = performance.now();
    } else {
      animFromCentroidsRef.current = targetCentroids.map((c) => ({ ...c }));
      targetCentroidsRef.current = targetCentroids.map((c) => ({ ...c }));
      displayedCentroidsRef.current = targetCentroids.map((c) => ({ ...c }));
      centroidAnimStartRef.current = 0;
    }
  }, [targetCentroids]);

  useEffect(() => {
    if (lastAddedPointId !== null) {
      rippleStateRef.current = { pointId: lastAddedPointId, startMs: performance.now() };
    }
  }, [lastAddedPointId]);

  // Measure container dynamically via ResizeObserver
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        setCanvasSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    };
    updateSize();
    const obs = new ResizeObserver(updateSize);
    obs.observe(el);
    return () => obs.disconnect();
  }, [wrapperRef]);

  const clientToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { wx: 0.5, wy: 0.5, sx: 0, sy: 0 };
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const pad = 18;
      const w = Math.max(1, rect.width - pad * 2);
      const h = Math.max(1, rect.height - pad * 2);
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const unpannedX = (sx - cx - panOffset.x) / zoomScale + cx;
      const unpannedY = (sy - cy - panOffset.y) / zoomScale + cy;
      const wx = Math.max(0, Math.min(1, (unpannedX - pad) / w));
      const wy = Math.max(0, Math.min(1, (unpannedY - pad) / h));
      return { wx, wy, sx, sy };
    },
    [panOffset.x, panOffset.y, zoomScale]
  );

  const resolveNearestClusterForAnnotation = useCallback(
    (wx: number, wy: number): { clusterId: number; existing?: ClusterAnnotation } => {
      // Check existing annotation pins first
      for (const ann of annotations) {
        const dx = ann.x - wx;
        const dy = ann.y - wy;
        if (dx * dx + dy * dy < 0.045 * 0.045) {
          return { clusterId: ann.clusterId, existing: ann };
        }
      }
      // Check centroids
      let bestCluster = -1;
      let bestDist2 = 0.1 * 0.1;
      for (const c of targetCentroids) {
        const dx = c.x - wx;
        const dy = c.y - wy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestCluster = c.clusterId;
        }
      }
      if (bestCluster >= 0) return { clusterId: bestCluster };
      // Check nearest clustered point
      let bestPtCluster = -1;
      let bestPtDist2 = 0.12 * 0.12;
      for (const p of displayPoints) {
        if (p.clusterId < 0) continue;
        const dx = p.x - wx;
        const dy = p.y - wy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestPtDist2) {
          bestPtDist2 = d2;
          bestPtCluster = p.clusterId;
        }
      }
      return { clusterId: bestPtCluster };
    },
    [annotations, displayPoints, targetCentroids]
  );

  // Main render loop (runs during animations and whenever inputs change)
  useEffect(() => {
    let rafId = 0;
    const renderFrame = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvasSize.width;
      const height = canvasSize.height;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Clear canvas background
      ctx.fillStyle = isDarkTheme ? '#131C31' : '#FFFFFF';
      ctx.fillRect(0, 0, width, height);

      // Compute centroid interpolation
      const animStart = centroidAnimStartRef.current;
      const durationMs = 460;
      let animNeedsContinue = false;
      let activeCentroids = targetCentroidsRef.current;
      if (
        animStart > 0 &&
        animFromCentroidsRef.current.length === targetCentroidsRef.current.length
      ) {
        const rawT = Math.min(1, (now - animStart) / durationMs);
        const eased = 1 - Math.pow(1 - rawT, 3);
        activeCentroids = targetCentroidsRef.current.map((target, idx) => {
          const from = animFromCentroidsRef.current[idx];
          return {
            ...target,
            x: from.x + (target.x - from.x) * eased,
            y: from.y + (target.y - from.y) * eased,
          };
        });
        displayedCentroidsRef.current = activeCentroids;
        if (rawT < 1) {
          animNeedsContinue = true;
        } else {
          centroidAnimStartRef.current = 0;
        }
      }

      // Ripple check
      const rippleElapsed = now - rippleStateRef.current.startMs;
      const rippleActive =
        rippleStateRef.current.pointId !== null && rippleElapsed >= 0 && rippleElapsed < 440;
      if (rippleActive) animNeedsContinue = true;

      // Apply view zoom/pan
      const cx = width / 2;
      const cy = height / 2;
      ctx.translate(cx + panOffset.x, cy + panOffset.y);
      ctx.scale(zoomScale, zoomScale);
      ctx.translate(-cx, -cy);

      const pad = 18;
      const plotW = Math.max(1, width - pad * 2);
      const plotH = Math.max(1, height - pad * 2);
      const toSx = (wx: number) => pad + wx * plotW;
      const toSy = (wy: number) => pad + wy * plotH;

      // 1. Voronoi Background for K-Means
      if (algorithm === 'KMEANS' && kMeansConfig.showVoronoi && activeCentroids.length >= 2) {
        const cols = 38;
        const rows = 24;
        const cellW = plotW / cols;
        const cellH = plotH / rows;
        for (let r = 0; r < rows; r++) {
          const wy = (r + 0.5) / rows;
          for (let c = 0; c < cols; c++) {
            const wx = (c + 0.5) / cols;
            let bestCluster = 0;
            let bestD2 = Number.POSITIVE_INFINITY;
            for (const cen of activeCentroids) {
              const dx = wx - cen.x;
              const dy = wy - cen.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2) {
                bestD2 = d2;
                bestCluster = cen.clusterId;
              }
            }
            ctx.fillStyle = hexToRgba(clusterColor(bestCluster), isDarkTheme ? 0.11 : 0.085);
            ctx.fillRect(pad + c * cellW, pad + r * cellH, cellW + 0.6, cellH + 0.6);
          }
        }
      }

      // 2. Coordinate Grid (10x10)
      if (showGrid) {
        for (let i = 0; i <= 10; i++) {
          const frac = i / 10;
          const x = pad + frac * plotW;
          const y = pad + frac * plotH;
          const isMid = i === 5;
          ctx.strokeStyle = isDarkTheme
            ? isMid
              ? 'rgba(148, 163, 184, 0.25)'
              : 'rgba(148, 163, 184, 0.11)'
            : isMid
              ? 'rgba(15, 23, 42, 0.14)'
              : 'rgba(15, 23, 42, 0.06)';
          ctx.lineWidth = (isMid ? 1.2 : 0.8) / zoomScale;
          ctx.beginPath();
          ctx.moveTo(x, pad);
          ctx.lineTo(x, pad + plotH);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(pad, y);
          ctx.lineTo(pad + plotW, y);
          ctx.stroke();
        }
      }

      // 3. DBSCAN Epsilon Neighborhood Rings
      if (algorithm === 'DBSCAN' && dbscanConfig.showEpsilonRings) {
        const radiusPx = dbscanConfig.epsilon * Math.min(plotW, plotH);
        const corePoints = displayPoints
          .filter((p) => p.role === 'CORE' && p.clusterId >= 0)
          .slice(0, 65);
        ctx.save();
        ctx.setLineDash([4 / zoomScale, 4 / zoomScale]);
        ctx.lineWidth = 1 / zoomScale;
        for (const pt of corePoints) {
          ctx.strokeStyle = hexToRgba(clusterColor(pt.clusterId), isDarkTheme ? 0.28 : 0.24);
          ctx.beginPath();
          ctx.arc(toSx(pt.x), toSy(pt.y), radiusPx, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 4. Spider Lines (Point -> Centroid)
      if (showSpiderLines && activeCentroids.length > 0) {
        const centroidMap = new Map(activeCentroids.map((c) => [c.clusterId, c]));
        ctx.lineWidth = 0.85 / zoomScale;
        for (const pt of displayPoints) {
          if (pt.clusterId < 0) continue;
          const c = centroidMap.get(pt.clusterId);
          if (!c) continue;
          ctx.strokeStyle = hexToRgba(clusterColor(pt.clusterId), isDarkTheme ? 0.28 : 0.22);
          ctx.beginPath();
          ctx.moveTo(toSx(pt.x), toSy(pt.y));
          ctx.lineTo(toSx(c.x), toSy(c.y));
          ctx.stroke();
        }
      }

      // 5. K-Means Centroid Movement Trails + Ghost Origin + Arrowhead
      if (algorithm === 'KMEANS' && kMeansConfig.showTrails) {
        for (const cen of activeCentroids) {
          if (cen.trail.length < 2) continue;
          const col = clusterColor(cen.clusterId);
          const origin = cen.trail[0];

          // Ghost ring at initial centroid seed
          ctx.strokeStyle = hexToRgba(col, 0.55);
          ctx.lineWidth = 1.4 / zoomScale;
          ctx.beginPath();
          ctx.arc(toSx(origin.x), toSy(origin.y), 4.5 / zoomScale, 0, Math.PI * 2);
          ctx.stroke();

          // Dashed trail path
          ctx.save();
          ctx.setLineDash([5 / zoomScale, 4 / zoomScale]);
          ctx.strokeStyle = hexToRgba(col, 0.8);
          ctx.lineWidth = 1.8 / zoomScale;
          ctx.beginPath();
          cen.trail.forEach((coord, idx) => {
            const x = idx === cen.trail.length - 1 ? toSx(cen.x) : toSx(coord.x);
            const y = idx === cen.trail.length - 1 ? toSy(cen.y) : toSy(coord.y);
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
          ctx.restore();

          // Arrowhead pointing to current centroid position
          const prev = cen.trail[cen.trail.length - 2];
          const px = toSx(prev.x);
          const py = toSy(prev.y);
          const tx = toSx(cen.x);
          const ty = toSy(cen.y);
          const angle = Math.atan2(ty - py, tx - px);
          const dist = Math.hypot(tx - px, ty - py);
          if (dist > 6 / zoomScale) {
            const headLen = 6.5 / zoomScale;
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(tx - headLen * Math.cos(angle - 0.45), ty - headLen * Math.sin(angle - 0.45));
            ctx.lineTo(tx - headLen * Math.cos(angle + 0.45), ty - headLen * Math.sin(angle + 0.45));
            ctx.closePath();
            ctx.fill();
          }
        }
      }

      // 6. Data Points
      const ptR = 4.6 / zoomScale;
      for (const pt of displayPoints) {
        const px = toSx(pt.x);
        const py = toSy(pt.y);

        // Touch ripple pulse on newly added point
        if (rippleActive && pt.id === rippleStateRef.current.pointId) {
          const progress = Math.min(1, rippleElapsed / 440);
          const rr = (6 + progress * 22) / zoomScale;
          ctx.strokeStyle = hexToRgba('#60A5FA', 1 - progress);
          ctx.lineWidth = 2 / zoomScale;
          ctx.beginPath();
          ctx.arc(px, py, rr, 0, Math.PI * 2);
          ctx.stroke();
        }

        if (pt.role === 'NOISE' || (algorithm === 'DBSCAN' && pt.clusterId < 0)) {
          ctx.strokeStyle = isDarkTheme ? '#94A3B8' : '#64748B';
          ctx.lineWidth = 1.8 / zoomScale;
          const half = 3.5 / zoomScale;
          ctx.beginPath();
          ctx.moveTo(px - half, py - half);
          ctx.lineTo(px + half, py + half);
          ctx.moveTo(px - half, py + half);
          ctx.lineTo(px + half, py - half);
          ctx.stroke();
        } else {
          const col = clusterColor(pt.clusterId);
          if (pt.role === 'BORDER') {
            ctx.fillStyle = isDarkTheme ? '#0B1120' : '#FFFFFF';
            ctx.beginPath();
            ctx.arc(px, py, ptR, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = col;
            ctx.lineWidth = 2 / zoomScale;
            ctx.stroke();
          } else {
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(px, py, ptR, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = isDarkTheme ? '#0B1120' : '#FFFFFF';
            ctx.lineWidth = 1.1 / zoomScale;
            ctx.stroke();
          }
        }
      }

      // 7. Centroid Diamonds & Coordinate Tags
      for (const cen of activeCentroids) {
        const sx = toSx(cen.x);
        const sy = toSy(cen.y);
        const col = clusterColor(cen.clusterId);
        const size = 8.5 / zoomScale;

        ctx.save();
        ctx.fillStyle = col;
        ctx.strokeStyle = isDarkTheme ? '#F8FAFC' : '#0F172A';
        ctx.lineWidth = 2 / zoomScale;
        ctx.beginPath();
        ctx.moveTo(sx, sy - size);
        ctx.lineTo(sx + size, sy);
        ctx.lineTo(sx, sy + size);
        ctx.lineTo(sx - size, sy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Compact coordinate pill next to centroid
        const fontSize = Math.max(9, 10.5 / zoomScale);
        ctx.font = `700 ${fontSize}px "JetBrains Mono", monospace`;
        const tag = developerModeEnabled
          ? `C${cen.clusterId + 1} (${cen.x.toFixed(2)}, ${cen.y.toFixed(2)})`
          : `C${cen.clusterId + 1}`;
        const textW = ctx.measureText(tag).width;
        const padX = 5 / zoomScale;
        const pillH = 16 / zoomScale;
        const pillX = Math.min(width - pad - textW - padX * 2, sx + 10 / zoomScale);
        const pillY = Math.max(pad, sy - pillH / 2);

        ctx.fillStyle = isDarkTheme ? 'rgba(11, 17, 32, 0.88)' : 'rgba(255, 255, 255, 0.92)';
        drawRoundedRect(ctx, pillX, pillY, textW + padX * 2, pillH, 4 / zoomScale);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2 / zoomScale;
        ctx.stroke();

        ctx.fillStyle = isDarkTheme ? '#F1F5F9' : '#0F172A';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, pillX + padX, pillY + pillH / 2);
        ctx.restore();
      }

      // 8. Annotations (Pins, Leader Lines, Labels)
      for (const ann of annotations) {
        const ax = toSx(ann.x);
        const ay = toSy(ann.y);
        const col = clusterColor(ann.clusterId);
        const prefix = ann.clusterId >= 0 ? `C${ann.clusterId + 1}: ` : 'Note: ';
        const shortText = ann.text.length > 26 ? `${ann.text.slice(0, 25)}…` : ann.text;
        const label = `${prefix}${shortText}`;

        const fontSize = 10.5 / zoomScale;
        ctx.font = `600 ${fontSize}px "Inter", sans-serif`;
        const textW = ctx.measureText(label).width;
        const padX = 7 / zoomScale;
        const pillW = textW + padX * 2;
        const pillH = 20 / zoomScale;
        const pillX = Math.max(pad + 4, Math.min(width - pad - pillW - 4, ax + 10 / zoomScale));
        const pillY = Math.max(pad + 4, ay - 26 / zoomScale);

        // Leader line
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5 / zoomScale;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(pillX + Math.min(20 / zoomScale, pillW * 0.25), pillY + pillH);
        ctx.stroke();

        // Anchor dot
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(ax, ay, 4.5 / zoomScale, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = isDarkTheme ? '#0B1120' : '#FFFFFF';
        ctx.lineWidth = 1.5 / zoomScale;
        ctx.stroke();

        // Label box
        ctx.fillStyle = isDarkTheme ? 'rgba(15, 23, 42, 0.94)' : 'rgba(255, 255, 255, 0.96)';
        drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 6 / zoomScale);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.3 / zoomScale;
        ctx.stroke();

        ctx.fillStyle = isDarkTheme ? '#F1F5F9' : '#0F172A';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, pillX + padX, pillY + pillH / 2);
      }

      ctx.restore();

      if (animNeedsContinue) {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [
    algorithm,
    annotations,
    canvasSize.height,
    canvasSize.width,
    developerModeEnabled,
    displayPoints,
    dbscanConfig.epsilon,
    dbscanConfig.showEpsilonRings,
    isDarkTheme,
    kMeansConfig.showTrails,
    kMeansConfig.showVoronoi,
    panOffset.x,
    panOffset.y,
    showGrid,
    showSpiderLines,
    targetCentroids,
    zoomScale,
    lastAddedPointId,
  ]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return; // Handled by onContextMenu
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);

    const { wx, wy } = clientToWorld(e.clientX, e.clientY);

    // Check if user tapped directly on an existing annotation anchor
    const hitAnn = annotations.find((ann) => {
      const dx = ann.x - wx;
      const dy = ann.y - wy;
      return dx * dx + dy * dy < 0.032 * 0.032;
    });
    if (hitAnn) {
      onOpenAnnotation(hitAnn.clusterId, hitAnn.x, hitAnn.y, hitAnn);
      return;
    }

    if (pointerDownRef.current.timerId !== null) {
      window.clearTimeout(pointerDownRef.current.timerId);
    }

    const timerId = window.setTimeout(() => {
      if (pointerDownRef.current.active && !pointerDownRef.current.moved) {
        pointerDownRef.current.longPressed = true;
        const target = resolveNearestClusterForAnnotation(wx, wy);
        onOpenAnnotation(target.clusterId, wx, wy, target.existing);
      }
    }, 500);

    pointerDownRef.current = {
      active: true,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      moved: false,
      longPressed: false,
      timerId,
      lastBrushMs: 0,
    };

    if (toolMode === 'BRUSH') {
      onAddPoint(wx, wy);
      pointerDownRef.current.lastBrushMs = performance.now();
    } else if (toolMode === 'ERASE') {
      onErasePointsNear(wx, wy);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointerDownRef.current;
    if (!p.active || p.pointerId !== e.pointerId) return;

    const totalDist = Math.hypot(e.clientX - p.startClientX, e.clientY - p.startClientY);
    if (totalDist > 7 && !p.moved) {
      p.moved = true;
      if (p.timerId !== null) {
        window.clearTimeout(p.timerId);
        p.timerId = null;
      }
    }

    if (p.longPressed) return;

    if (toolMode === 'PAN') {
      const dx = e.clientX - p.lastClientX;
      const dy = e.clientY - p.lastClientY;
      setPanOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    } else if (toolMode === 'BRUSH' || (toolMode === 'ADD' && p.moved)) {
      const now = performance.now();
      if (now - p.lastBrushMs >= 75) {
        const { wx, wy } = clientToWorld(e.clientX, e.clientY);
        onAddPoint(wx, wy);
        p.lastBrushMs = now;
      }
    } else if (toolMode === 'ERASE') {
      const { wx, wy } = clientToWorld(e.clientX, e.clientY);
      onErasePointsNear(wx, wy);
    }

    p.lastClientX = e.clientX;
    p.lastClientY = e.clientY;
  };

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointerDownRef.current;
    if (!p.active || p.pointerId !== e.pointerId) return;
    if (p.timerId !== null) {
      window.clearTimeout(p.timerId);
    }
    if (!p.moved && !p.longPressed && toolMode === 'ADD') {
      const { wx, wy } = clientToWorld(e.clientX, e.clientY);
      onAddPoint(wx, wy);
    }
    p.active = false;
    p.timerId = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    setZoomScale((prev) => Math.max(0.75, Math.min(4.0, Number((prev * factor).toFixed(3)))));
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { wx, wy } = clientToWorld(e.clientX, e.clientY);
    const target = resolveNearestClusterForAnnotation(wx, wy);
    onOpenAnnotation(target.clusterId, wx, wy, target.existing);
  };

  const isZoomedOrPanned =
    Math.abs(zoomScale - 1) > 0.02 || Math.abs(panOffset.x) > 4 || Math.abs(panOffset.y) > 4;

  const clusterCount = useMemo(() => {
    if (currentFrame && currentFrame.clusterSummaries.length > 0) {
      return currentFrame.clusterSummaries.length;
    }
    return new Set(displayPoints.filter((p) => p.clusterId >= 0).map((p) => p.clusterId)).size;
  }, [currentFrame, displayPoints]);

  const silhouette = currentFrame?.silhouetteScore ?? 0;
  const wcss = currentFrame?.wcss ?? 0;
  const maxIter = Math.max(1, totalFrames - 1);

  return (
    <div
      ref={wrapperRef}
      className="relative w-full h-[360px] sm:h-[420px] lg:h-[465px] rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] overflow-hidden shadow-sm select-none"
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        className={`w-full h-full block touch-none ${
          toolMode === 'PAN'
            ? 'cursor-grab active:cursor-grabbing'
            : toolMode === 'ERASE'
              ? 'cursor-cell'
              : 'cursor-crosshair'
        }`}
      />

      {/* Top-Left HUD: Mode / Point Count + Clickable Silhouette/Inertia + Convergence Badge */}
      <div className="absolute top-3 left-3 flex flex-col items-start gap-1.5 pointer-events-none">
        <div className="pointer-events-auto inline-flex items-center gap-2 rounded-lg bg-slate-900/85 dark:bg-[#0B1120]/90 text-slate-100 border border-slate-700/80 px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm">
          <span>{CANVAS_TOOL_LABELS[toolMode]}</span>
          <span className="text-slate-500">•</span>
          <span className="font-mono-num">N={displayPoints.length}</span>
          <span className="text-slate-500">•</span>
          <span className="font-mono-num">
            {algorithm === 'KMEANS'
              ? `K=${kMeansConfig.k}`
              : `ε=${dbscanConfig.epsilon.toFixed(3)} / G=${clusterCount}`}
          </span>
        </div>

        {/* Clickable Quality Overlay Pill */}
        {displayPoints.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setQualityMode((m) => (m === 'BOTH' ? 'SILHOUETTE' : m === 'SILHOUETTE' ? 'INERTIA' : 'BOTH'))
            }
            title="Click to cycle Quality Overlay (Both / Silhouette / Inertia)"
            className="pointer-events-auto inline-flex items-center gap-2 rounded-lg bg-white/90 dark:bg-[#0B1120]/85 text-slate-800 dark:text-slate-100 border border-slate-300/90 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium shadow-xs hover:border-blue-500/70 transition-colors"
          >
            {(qualityMode === 'BOTH' || qualityMode === 'SILHOUETTE') && (
              <span className="inline-flex items-center gap-1 font-mono-num">
                <span className="text-slate-500 dark:text-slate-400">Silhouette</span>
                <span
                  className={
                    silhouette >= 0.5
                      ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                      : silhouette >= 0.25
                        ? 'text-amber-600 dark:text-amber-400 font-semibold'
                        : 'text-slate-700 dark:text-slate-200 font-semibold'
                  }
                >
                  {silhouette.toFixed(3)}
                </span>
              </span>
            )}
            {qualityMode === 'BOTH' && <span className="text-slate-400">•</span>}
            {(qualityMode === 'BOTH' || qualityMode === 'INERTIA') && (
              <span className="inline-flex items-center gap-1 font-mono-num">
                <span className="text-slate-500 dark:text-slate-400">Inertia</span>
                <span className="text-blue-600 dark:text-blue-400 font-semibold">
                  {wcss.toFixed(3)}
                </span>
              </span>
            )}
          </button>
        )}

        {/* Convergence Badge for K-Means */}
        {algorithm === 'KMEANS' && currentFrame && displayPoints.length > 0 && (
          <div
            className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[10.5px] font-semibold border ${
              currentFrame.isConverged
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/35'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                currentFrame.isConverged ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
              }`}
            />
            {currentFrame.isConverged
              ? `Converged • Iter ${currentFrameIndex}/${maxIter}`
              : `Iter ${currentFrameIndex}/${maxIter} in progress`}
          </div>
        )}
      </div>

      {/* Top-Right Quick Overlay Actions */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {isZoomedOrPanned && (
          <button
            type="button"
            onClick={() => {
              setZoomScale(1);
              setPanOffset({ x: 0, y: 0 });
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-white/92 dark:bg-[#0B1120]/90 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium hover:border-blue-500 transition-colors shadow-xs"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Reset Zoom
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            const target = resolveNearestClusterForAnnotation(0.5, 0.5);
            onOpenAnnotation(target.clusterId, 0.5, 0.5);
          }}
          title="Add cluster or canvas annotation"
          className="inline-flex items-center gap-1 rounded-lg bg-white/92 dark:bg-[#0B1120]/90 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 px-2 py-1 text-[11px] font-medium hover:border-blue-500 transition-colors shadow-xs"
        >
          <MessageSquarePlus className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
          <span className="hidden sm:inline">Annotate</span>
        </button>
        {developerModeEnabled && (
          <>
            <button
              type="button"
              onClick={onToggleSpiderLines}
              title="Toggle point-to-centroid spider lines"
              className={`p-1.5 rounded-lg border text-xs transition-colors shadow-xs ${
                showSpiderLines
                  ? 'bg-blue-600/15 border-blue-500/60 text-blue-600 dark:text-blue-300'
                  : 'bg-white/90 dark:bg-[#0B1120]/90 border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <Network className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleGrid}
              title="Toggle 10x10 coordinate grid"
              className={`p-1.5 rounded-lg border text-xs transition-colors shadow-xs ${
                showGrid
                  ? 'bg-blue-600/15 border-blue-500/60 text-blue-600 dark:text-blue-300'
                  : 'bg-white/90 dark:bg-[#0B1120]/90 border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <Grid3X3 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Empty Canvas Prompt */}
      {displayPoints.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-6">
          <div className="rounded-xl bg-white/95 dark:bg-[#0B1120]/95 border border-slate-300 dark:border-slate-700 px-4 py-3 text-center max-w-xs shadow-sm">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Canvas is Empty
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Click anywhere on the plot to add points, or select a Benchmark Preset below.
            </p>
          </div>
        </div>
      )}

      {/* Bottom HUD: Live Centroids in Dev Mode + Right-click/hold hint */}
      <div className="absolute bottom-2.5 left-3 right-3 flex items-end justify-between gap-2 pointer-events-none">
        {developerModeEnabled && targetCentroids.length > 0 ? (
          <div className="pointer-events-auto flex items-center gap-1.5 overflow-x-auto max-w-[74%] pb-0.5">
            {targetCentroids.slice(0, 6).map((c) => (
              <span
                key={c.clusterId}
                className="inline-flex items-center gap-1.5 rounded-md bg-white/92 dark:bg-[#0B1120]/90 border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-[10.5px] font-mono-num text-slate-800 dark:text-slate-200 whitespace-nowrap"
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: clusterColor(c.clusterId) }}
                />
                C{c.clusterId + 1} ({c.x.toFixed(2)}, {c.y.toFixed(2)})
              </span>
            ))}
          </div>
        ) : (
          <div />
        )}

        <span className="rounded-md bg-white/85 dark:bg-[#0B1120]/80 border border-slate-200/80 dark:border-slate-700/80 px-2 py-0.5 text-[10px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
          Right-click or hold cluster to annotate
        </span>
      </div>
    </div>
  );
};
