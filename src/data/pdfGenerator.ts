import {
  AlgorithmType,
  BatchQueueItem,
  CLUSTER_COLORS,
  CentroidState,
  ClusterAnnotation,
  ClusteringStepFrame,
  DataPoint,
  DbscanConfig,
  KMeansConfig,
} from '../types/clustering';
import { formatDateTime } from './storage';

const PAGE_WIDTH = 595; // A4 width in PostScript points
const PAGE_HEIGHT = 842; // A4 height in PostScript points

export interface PdfReportInput {
  datasetTitle: string;
  algorithm: AlgorithmType;
  kMeansConfig: KMeansConfig;
  dbscanConfig: DbscanConfig;
  points: DataPoint[];
  centroids: CentroidState[];
  frame: ClusteringStepFrame | null;
  showVoronoi: boolean;
  showTrails: boolean;
  showSpiderLines: boolean;
  showEpsilonRings: boolean;
  annotations: ClusterAnnotation[];
}

export interface BatchPdfReportInput {
  batchTitle: string;
  completedItems: BatchQueueItem[];
  showVoronoi: boolean;
  showTrails: boolean;
  showSpiderLines: boolean;
  showEpsilonRings: boolean;
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function clusterRgb(clusterId: number): [number, number, number] {
  if (clusterId < 0) return hexToRgb01('#94A3B8');
  const hex = CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];
  return hexToRgb01(hex);
}

function blendWithWhite([r, g, b]: [number, number, number], alpha: number): [number, number, number] {
  return [1 - alpha + r * alpha, 1 - alpha + g * alpha, 1 - alpha + b * alpha];
}

function escPdf(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, (ch) => (ch === '•' ? '-' : ch === 'ε' ? 'eps' : ch === '—' ? '-' : ' '))
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function silhouetteInterpretation(score: number): string {
  if (score >= 0.7) return 'Strong separation';
  if (score >= 0.5) return 'Good structure';
  if (score >= 0.25) return 'Moderate overlap';
  if (score > 0) return 'Weak separation';
  return 'Unclustered / sparse';
}

function hyperparameterSummary(input: PdfReportInput): string {
  if (input.algorithm === 'KMEANS') {
    const init = input.kMeansConfig.useKMeansPlusPlus ? 'K-Means++' : 'Random Init';
    return `K-Means  -  K = ${input.kMeansConfig.k}  -  ${init}`;
  }
  return `DBSCAN  -  Epsilon = ${input.dbscanConfig.epsilon.toFixed(3)}  -  MinPts = ${input.dbscanConfig.minPts}`;
}

function drawCirclePath(cx: number, cy: number, r: number): string {
  const k = 0.5522847498 * r;
  return [
    `${fmt(cx + r)} ${fmt(cy)} m`,
    `${fmt(cx + r)} ${fmt(cy + k)} ${fmt(cx + k)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)} c`,
    `${fmt(cx - k)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + k)} ${fmt(cx - r)} ${fmt(cy)} c`,
    `${fmt(cx - r)} ${fmt(cy - k)} ${fmt(cx - k)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)} c`,
    `${fmt(cx + k)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - k)} ${fmt(cx + r)} ${fmt(cy)} c`,
  ].join(' ');
}

function buildReportPageStream(
  input: PdfReportInput,
  pageNumber = 1,
  totalPages = 1,
  batchRunLabel?: string
): Uint8Array {
  const out: string[] = [];
  const margin = 36;
  const contentWidth = PAGE_WIDTH - margin * 2;
  const generatedAt = formatDateTime(Date.now());

  // White background
  out.push(`1 1 1 rg 0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT} re f`);

  // Header banner (top of page: y from 750 to 842)
  out.push(`0.059 0.090 0.165 rg 0 750 ${PAGE_WIDTH} 92 re f`);
  out.push(`0.145 0.388 0.922 rg 0 750 ${PAGE_WIDTH} 4 re f`);

  const titleHeader = batchRunLabel
    ? `ClusterLab - ${batchRunLabel}`
    : 'ClusterLab - Clustering Analysis Report';
  out.push(`1 1 1 rg BT /F2 18 Tf ${margin} 808 Td (${escPdf(titleHeader)}) Tj ET`);
  out.push(
    `0.796 0.835 0.882 rg BT /F1 10 Tf ${margin} 788 Td (${escPdf(`Dataset: ${input.datasetTitle}   |   ${hyperparameterSummary(input)}`)}) Tj ET`
  );
  out.push(`0.376 0.647 0.980 rg BT /F1 9 Tf ${margin} 769 Td (${escPdf(`Generated: ${generatedAt}`)}) Tj ET`);

  // Section 1: Visualization Snapshot
  out.push(`0.059 0.090 0.165 rg BT /F2 12 Tf ${margin} 728 Td (1. Clustering Visualization Snapshot) Tj ET`);

  const plotBoxL = margin;
  const plotBoxB = 446;
  const plotBoxW = contentWidth;
  const plotBoxH = 272;
  out.push(`0.973 0.980 0.988 rg ${plotBoxL} ${plotBoxB} ${plotBoxW} ${plotBoxH} re f`);

  const innerL = plotBoxL + 36;
  const innerB = plotBoxB + 24;
  const innerW = plotBoxW - 54;
  const innerH = plotBoxH - 40;

  const toPdfX = (wx: number) => innerL + Math.max(0, Math.min(1, wx)) * innerW;
  // Invert Y relative to top-down canvas coordinates so the exported PDF plot matches the screen canvas orientation
  const toPdfY = (wy: number) => innerB + (1 - Math.max(0, Math.min(1, wy))) * innerH;

  // Voronoi cells for K-Means
  if (input.algorithm === 'KMEANS' && input.showVoronoi && input.centroids.length >= 2) {
    const cols = 36;
    const rows = 22;
    const cellW = innerW / cols;
    const cellH = innerH / rows;
    for (let r = 0; r < rows; r++) {
      const wy = 1 - (r + 0.5) / rows;
      for (let c = 0; c < cols; c++) {
        const wx = (c + 0.5) / cols;
        let bestCluster = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const centroid of input.centroids) {
          const dx = wx - centroid.x;
          const dy = wy - centroid.y;
          const d = dx * dx + dy * dy;
          if (d < bestDist) {
            bestDist = d;
            bestCluster = centroid.clusterId;
          }
        }
        const [cr, cg, cb] = blendWithWhite(clusterRgb(bestCluster), 0.12);
        const rx = innerL + c * cellW;
        const ry = innerB + (rows - 1 - r) * cellH;
        out.push(`${fmt(cr, 3)} ${fmt(cg, 3)} ${fmt(cb, 3)} rg ${fmt(rx)} ${fmt(ry)} ${fmt(cellW + 0.4)} ${fmt(cellH + 0.4)} re f`);
      }
    }
  }

  // Coordinate grid & axis ticks
  out.push(`0.886 0.910 0.941 RG 0.75 w`);
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const x = innerL + frac * innerW;
    const y = innerB + (1 - frac) * innerH;
    out.push(`${fmt(x)} ${fmt(innerB)} m ${fmt(x)} ${fmt(innerB + innerH)} l S`);
    out.push(`${fmt(innerL)} ${fmt(y)} m ${fmt(innerL + innerW)} ${fmt(y)} l S`);
    const tick = frac.toFixed(2);
    out.push(`0.392 0.455 0.545 rg BT /F1 8 Tf ${fmt(x - 8)} ${fmt(innerB - 12)} Td (${tick}) Tj ET`);
    out.push(`0.392 0.455 0.545 rg BT /F1 8 Tf ${fmt(plotBoxL + 6)} ${fmt(y - 3)} Td (${tick}) Tj ET`);
  }

  // DBSCAN epsilon rings
  if (input.algorithm === 'DBSCAN' && input.showEpsilonRings) {
    const epsRadiusPt = input.dbscanConfig.epsilon * Math.min(innerW, innerH);
    const corePts = input.points.filter((p) => p.role === 'CORE' && p.clusterId >= 0).slice(0, 60);
    out.push('0.8 w');
    for (const pt of corePts) {
      const [r, g, b] = blendWithWhite(clusterRgb(pt.clusterId), 0.25);
      out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} RG ${drawCirclePath(toPdfX(pt.x), toPdfY(pt.y), epsRadiusPt)} S`);
    }
  }

  // K-Means spider lines
  if (input.algorithm === 'KMEANS' && input.showSpiderLines && input.centroids.length > 0) {
    const cMap = new Map(input.centroids.map((c) => [c.clusterId, c]));
    out.push('0.7 w');
    for (const pt of input.points) {
      const c = cMap.get(pt.clusterId);
      if (!c) continue;
      const [r, g, b] = blendWithWhite(clusterRgb(pt.clusterId), 0.3);
      out.push(
        `${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} RG ${fmt(toPdfX(pt.x))} ${fmt(toPdfY(pt.y))} m ${fmt(toPdfX(c.x))} ${fmt(toPdfY(c.y))} l S`
      );
    }
  }

  // Centroid trails
  if (input.algorithm === 'KMEANS' && input.showTrails) {
    out.push('1.4 w [4 3] 0 d');
    for (const c of input.centroids) {
      if (c.trail.length < 2) continue;
      const [r, g, b] = clusterRgb(c.clusterId);
      const segs = c.trail.map((coord, idx) =>
        `${fmt(toPdfX(coord.x))} ${fmt(toPdfY(coord.y))} ${idx === 0 ? 'm' : 'l'}`
      );
      out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} RG ${segs.join(' ')} S`);
    }
    out.push('[] 0 d');
  }

  // Data points
  for (const pt of input.points) {
    const px = toPdfX(pt.x);
    const py = toPdfY(pt.y);
    if (pt.role === 'NOISE' || pt.clusterId < 0) {
      out.push(
        `0.392 0.455 0.545 RG 1.1 w ${fmt(px - 2.6)} ${fmt(py - 2.6)} m ${fmt(px + 2.6)} ${fmt(py + 2.6)} l S ${fmt(px - 2.6)} ${fmt(py + 2.6)} m ${fmt(px + 2.6)} ${fmt(py - 2.6)} l S`
      );
    } else {
      const [r, g, b] = clusterRgb(pt.clusterId);
      if (pt.role === 'BORDER') {
        out.push(`1 1 1 rg ${drawCirclePath(px, py, 3.6)} f`);
        out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} RG 1.1 w ${drawCirclePath(px, py, 3.6)} S`);
      } else {
        out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} rg ${drawCirclePath(px, py, 3.8)} f`);
        out.push(`1 1 1 RG 0.9 w ${drawCirclePath(px, py, 3.8)} S`);
      }
    }
  }

  // Centroids
  for (const centroid of input.centroids) {
    const cx = toPdfX(centroid.x);
    const cy = toPdfY(centroid.y);
    const [r, g, b] = clusterRgb(centroid.clusterId);
    const diamond = `${fmt(cx)} ${fmt(cy + 7)} m ${fmt(cx + 7)} ${fmt(cy)} l ${fmt(cx)} ${fmt(cy - 7)} l ${fmt(cx - 7)} ${fmt(cy)} l h`;
    out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} rg ${diamond} f`);
    out.push(`0.059 0.090 0.165 RG 1.5 w ${diamond} S`);
    out.push(`0.059 0.090 0.165 rg BT /F2 8.5 Tf ${fmt(cx + 9)} ${fmt(cy - 3)} Td (C${centroid.clusterId + 1}) Tj ET`);
  }

  // Plot Annotations
  for (const ann of input.annotations.slice(0, 12)) {
    const ax = toPdfX(ann.x);
    const ay = toPdfY(ann.y);
    const [r, g, b] = clusterRgb(ann.clusterId);
    const prefix = ann.clusterId >= 0 ? `C${ann.clusterId + 1}: ` : 'Note: ';
    const shortText = ann.text.length > 26 ? `${ann.text.slice(0, 25)}...` : ann.text;
    const label = `${prefix}${shortText}`;
    const pillW = Math.min(170, label.length * 4.4 + 12);
    const pillH = 14;
    const pillX = Math.max(innerL + 2, Math.min(innerL + innerW - pillW - 2, ax + 6));
    const pillY = Math.max(innerB + 2, Math.min(innerB + innerH - pillH - 2, ay + 6));

    out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} RG 1.1 w ${fmt(ax)} ${fmt(ay)} m ${fmt(pillX + pillW * 0.25)} ${fmt(pillY)} l S`);
    out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} rg ${drawCirclePath(ax, ay, 3.5)} f`);
    out.push(`1 1 1 rg ${fmt(pillX)} ${fmt(pillY)} ${fmt(pillW)} ${pillH} re f`);
    out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} RG 1 w ${fmt(pillX)} ${fmt(pillY)} ${fmt(pillW)} ${pillH} re S`);
    out.push(`0.059 0.090 0.165 rg BT /F2 7.5 Tf ${fmt(pillX + 5)} ${fmt(pillY + 4)} Td (${escPdf(label)}) Tj ET`);
  }

  // Plot outer border
  out.push(`0.796 0.835 0.882 RG 1.2 w ${plotBoxL} ${plotBoxB} ${plotBoxW} ${plotBoxH} re S`);

  // Section 2: Key KPI Grid
  out.push(`0.059 0.090 0.165 rg BT /F2 12 Tf ${margin} 422 Td (2. Key Convergence & Quality Statistics) Tj ET`);

  const frame = input.frame;
  const summaries = frame?.clusterSummaries ?? [];
  const clusterCount =
    summaries.length > 0
      ? summaries.length
      : new Set(input.points.filter((p) => p.clusterId >= 0).map((p) => p.clusterId)).size;
  const silhouette = frame?.silhouetteScore ?? 0;
  const wcss = frame?.wcss ?? 0;
  const statusSub = !frame
    ? 'Raw Points'
    : frame.isConverged
      ? `Converged (Step ${frame.stepIndex})`
      : `In Progress (Step ${frame.stepIndex})`;

  const thirdLabel = input.algorithm === 'KMEANS' ? 'WCSS (INERTIA)' : 'CORE / BORDER';
  const thirdValue =
    input.algorithm === 'KMEANS'
      ? wcss.toFixed(4)
      : `${frame?.coreCount ?? 0} / ${frame?.borderCount ?? 0}`;
  const thirdSub =
    input.algorithm === 'KMEANS' ? 'Lower is tighter' : `Noise: ${frame?.noiseCount ?? 0} pts`;

  const kpis = [
    ['DATA POINTS', `${input.points.length}`, `${clusterCount} cluster${clusterCount === 1 ? '' : 's'} found`],
    ['SILHOUETTE', silhouette.toFixed(3), silhouetteInterpretation(silhouette)],
    [thirdLabel, thirdValue, thirdSub],
    ['STATUS', frame?.isConverged ? 'Converged' : 'Active', statusSub],
  ];

  const cardGap = 10;
  const cardW = (contentWidth - cardGap * 3) / 4;
  const cardH = 62;
  const cardTopY = 412;
  const cardBotY = cardTopY - cardH;

  kpis.forEach(([label, val, sub], idx) => {
    const left = margin + idx * (cardW + cardGap);
    out.push(`0.945 0.961 0.976 rg ${fmt(left)} ${fmt(cardBotY)} ${fmt(cardW)} ${cardH} re f`);
    out.push(`0.796 0.835 0.882 RG 0.9 w ${fmt(left)} ${fmt(cardBotY)} ${fmt(cardW)} ${cardH} re S`);
    out.push(`0.278 0.333 0.412 rg BT /F2 7.6 Tf ${fmt(left + 9)} ${fmt(cardTopY - 15)} Td (${escPdf(label)}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F2 13.5 Tf ${fmt(left + 9)} ${fmt(cardTopY - 36)} Td (${escPdf(val)}) Tj ET`);
    out.push(`0.392 0.455 0.545 rg BT /F1 8 Tf ${fmt(left + 9)} ${fmt(cardTopY - 52)} Td (${escPdf(sub)}) Tj ET`);
  });

  // Section 3: Cluster Breakdown Table
  let tableTop = cardBotY - 22;
  out.push(`0.059 0.090 0.165 rg BT /F2 12 Tf ${margin} ${fmt(tableTop)} Td (3. Cluster Breakdown & Centroid Summary) Tj ET`);
  tableTop -= 10;

  const rowH = 22;
  out.push(`0.118 0.161 0.231 rg ${margin} ${fmt(tableTop - rowH)} ${contentWidth} ${rowH} re f`);
  const colCluster = margin + 12;
  const colCount = margin + 145;
  const colShare = margin + 225;
  const colCentroid = margin + 315;
  const colSpread = margin + 435;
  const hy = tableTop - 14.5;
  out.push(`1 1 1 rg BT /F2 9 Tf ${colCluster} ${fmt(hy)} Td (Cluster) Tj ET`);
  out.push(`1 1 1 rg BT /F2 9 Tf ${colCount} ${fmt(hy)} Td (Points) Tj ET`);
  out.push(`1 1 1 rg BT /F2 9 Tf ${colShare} ${fmt(hy)} Td (Share) Tj ET`);
  out.push(`1 1 1 rg BT /F2 9 Tf ${colCentroid} ${fmt(hy)} Td (Centroid (X, Y)) Tj ET`);
  out.push(`1 1 1 rg BT /F2 9 Tf ${colSpread} ${fmt(hy)} Td (Avg Spread) Tj ET`);

  let curY = tableTop - rowH;
  summaries.slice(0, 8).forEach((s, idx) => {
    const rowBot = curY - rowH;
    if (idx % 2 === 1) {
      out.push(`0.973 0.980 0.988 rg ${margin} ${fmt(rowBot)} ${contentWidth} ${rowH} re f`);
    }
    const [r, g, b] = clusterRgb(s.clusterId);
    out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} rg ${drawCirclePath(colCluster + 5, rowBot + 11, 4.2)} f`);
    const ty = rowBot + 7.5;
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colCluster + 16} ${fmt(ty)} Td (Cluster ${s.clusterId + 1}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colCount} ${fmt(ty)} Td (${s.count}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colShare} ${fmt(ty)} Td (${s.percentage.toFixed(1)}%) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colCentroid} ${fmt(ty)} Td ((${s.centroidX.toFixed(3)}, ${s.centroidY.toFixed(3)})) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colSpread} ${fmt(ty)} Td (${s.avgIntraDistance.toFixed(4)}) Tj ET`);
    out.push(`0.886 0.910 0.941 RG 0.7 w ${margin} ${fmt(rowBot)} m ${margin + contentWidth} ${fmt(rowBot)} l S`);
    curY = rowBot;
  });

  const noiseCnt = frame?.noiseCount ?? 0;
  if (noiseCnt > 0) {
    const rowBot = curY - rowH;
    const noisePct = input.points.length > 0 ? (noiseCnt * 100) / input.points.length : 0;
    out.push(`0.580 0.639 0.722 rg ${drawCirclePath(colCluster + 5, rowBot + 11, 4.2)} f`);
    const ty = rowBot + 7.5;
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colCluster + 16} ${fmt(ty)} Td (Noise / Outliers) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colCount} ${fmt(ty)} Td (${noiseCnt}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colShare} ${fmt(ty)} Td (${noisePct.toFixed(1)}%) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colCentroid} ${fmt(ty)} Td (-) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 9 Tf ${colSpread} ${fmt(ty)} Td (-) Tj ET`);
    out.push(`0.886 0.910 0.941 RG 0.7 w ${margin} ${fmt(rowBot)} m ${margin + contentWidth} ${fmt(rowBot)} l S`);
    curY = rowBot;
  }

  // Section 4: Cluster Annotations
  if (input.annotations.length > 0 && curY > 90) {
    curY -= 20;
    out.push(`0.059 0.090 0.165 rg BT /F2 11.5 Tf ${margin} ${fmt(curY)} Td (4. Cluster Annotations) Tj ET`);
    curY -= 10;
    for (const ann of input.annotations) {
      if (curY - 22 < 46) break;
      const boxBot = curY - 20;
      out.push(`0.973 0.980 0.988 rg ${margin} ${fmt(boxBot)} ${contentWidth} 20 re f`);
      out.push(`0.886 0.910 0.941 RG 0.8 w ${margin} ${fmt(boxBot)} ${contentWidth} 20 re S`);
      const [r, g, b] = clusterRgb(ann.clusterId);
      out.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} rg ${drawCirclePath(margin + 12, boxBot + 10, 3.8)} f`);
      const areaLabel = ann.clusterId >= 0 ? `Cluster ${ann.clusterId + 1}` : 'Canvas Note';
      out.push(`0.059 0.090 0.165 rg BT /F2 8.5 Tf ${margin + 22} ${fmt(boxBot + 6.5)} Td (${escPdf(areaLabel)}) Tj ET`);
      out.push(`0.392 0.455 0.545 rg BT /F1 8 Tf ${margin + 88} ${fmt(boxBot + 6.5)} Td ((${ann.x.toFixed(2)}, ${ann.y.toFixed(2)})) Tj ET`);
      out.push(`0.118 0.161 0.231 rg BT /F1 8.8 Tf ${margin + 146} ${fmt(boxBot + 6.5)} Td (${escPdf(ann.text.slice(0, 76))}) Tj ET`);
      curY = boxBot - 4;
    }
  }

  // Footer
  out.push(`0.886 0.910 0.941 RG 1 w ${margin} 36 m ${PAGE_WIDTH - margin} 36 l S`);
  out.push(
    `0.392 0.455 0.545 rg BT /F1 8.5 Tf ${margin} 20 Td (${escPdf(`ClusterLab v1.0 (AJ60)  -  Local Analysis Report  -  Page ${pageNumber} of ${totalPages}`)}) Tj ET`
  );

  return new TextEncoder().encode(out.join('\n') + '\n');
}

function buildBatchExecutiveCoverStream(
  input: BatchPdfReportInput,
  runs: BatchQueueItem[],
  totalPages: number
): Uint8Array {
  const out: string[] = [];
  const margin = 36;
  const contentWidth = PAGE_WIDTH - margin * 2;
  const generatedAt = formatDateTime(Date.now());

  out.push(`1 1 1 rg 0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT} re f`);
  out.push(`0.059 0.090 0.165 rg 0 746 ${PAGE_WIDTH} 96 re f`);
  out.push(`0.145 0.388 0.922 rg 0 746 ${PAGE_WIDTH} 4 re f`);

  out.push(`1 1 1 rg BT /F2 18 Tf ${margin} 806 Td (ClusterLab - Combined Batch Summary Report) Tj ET`);
  out.push(
    `0.796 0.835 0.882 rg BT /F1 10 Tf ${margin} 786 Td (${escPdf(`Batch: ${input.batchTitle}   |   ${runs.length} Sequential Runs   |   ${totalPages} Pages`)}) Tj ET`
  );
  out.push(`0.376 0.647 0.980 rg BT /F1 9 Tf ${margin} 766 Td (${escPdf(`Generated: ${generatedAt}`)}) Tj ET`);

  out.push(`0.059 0.090 0.165 rg BT /F2 12 Tf ${margin} 722 Td (1. Batch Overview & Top Performers) Tj ET`);

  const totalPoints = runs.reduce((acc, r) => acc + r.rawPoints.length, 0);
  const totalDurationMs = runs.reduce((acc, r) => acc + r.durationMs, 0);
  const bestSil = [...runs].sort(
    (a, b) => (b.resultFrame?.silhouetteScore ?? -999) - (a.resultFrame?.silhouetteScore ?? -999)
  )[0];
  const bestInertia = [...runs].sort(
    (a, b) => (a.resultFrame?.wcss ?? 999999) - (b.resultFrame?.wcss ?? 999999)
  )[0];

  const kpis = [
    ['QUEUED RUNS', `${runs.length}`, `${totalDurationMs} ms total`],
    ['TOTAL POINTS', `${totalPoints}`, 'Across all runs'],
    [
      'BEST SILHOUETTE',
      bestSil?.resultFrame ? bestSil.resultFrame.silhouetteScore.toFixed(3) : '-',
      bestSil?.datasetTitle.slice(0, 18) ?? 'No runs',
    ],
    [
      'LOWEST INERTIA',
      bestInertia?.resultFrame ? bestInertia.resultFrame.wcss.toFixed(3) : '-',
      bestInertia?.datasetTitle.slice(0, 18) ?? 'No runs',
    ],
  ];

  const cardGap = 10;
  const cardW = (contentWidth - cardGap * 3) / 4;
  const cardH = 64;
  const cardTopY = 710;
  const cardBotY = cardTopY - cardH;

  kpis.forEach(([label, val, sub], idx) => {
    const left = margin + idx * (cardW + cardGap);
    out.push(`0.945 0.961 0.976 rg ${fmt(left)} ${fmt(cardBotY)} ${fmt(cardW)} ${cardH} re f`);
    out.push(`0.796 0.835 0.882 RG 0.9 w ${fmt(left)} ${fmt(cardBotY)} ${fmt(cardW)} ${cardH} re S`);
    out.push(`0.278 0.333 0.412 rg BT /F2 7.5 Tf ${fmt(left + 9)} ${fmt(cardTopY - 15)} Td (${escPdf(label)}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F2 13.5 Tf ${fmt(left + 9)} ${fmt(cardTopY - 36)} Td (${escPdf(val)}) Tj ET`);
    out.push(`0.392 0.455 0.545 rg BT /F1 8 Tf ${fmt(left + 9)} ${fmt(cardTopY - 52)} Td (${escPdf(sub)}) Tj ET`);
  });

  let tableTop = cardBotY - 24;
  out.push(`0.059 0.090 0.165 rg BT /F2 12 Tf ${margin} ${fmt(tableTop)} Td (2. Sequential Run Comparison Table) Tj ET`);
  tableTop -= 12;

  const rowH = 24;
  out.push(`0.118 0.161 0.231 rg ${margin} ${fmt(tableTop - rowH)} ${contentWidth} ${rowH} re f`);
  const colIdx = margin + 8;
  const colDataset = margin + 34;
  const colAlgo = margin + 175;
  const colPts = margin + 292;
  const colClusters = margin + 338;
  const colSil = margin + 390;
  const colInertia = margin + 450;
  const hy = tableTop - 15.5;

  out.push(`1 1 1 rg BT /F2 8.8 Tf ${colIdx} ${fmt(hy)} Td (#) Tj ET`);
  out.push(`1 1 1 rg BT /F2 8.8 Tf ${colDataset} ${fmt(hy)} Td (Dataset) Tj ET`);
  out.push(`1 1 1 rg BT /F2 8.8 Tf ${colAlgo} ${fmt(hy)} Td (Algorithm & Config) Tj ET`);
  out.push(`1 1 1 rg BT /F2 8.8 Tf ${colPts} ${fmt(hy)} Td (Pts) Tj ET`);
  out.push(`1 1 1 rg BT /F2 8.8 Tf ${colClusters} ${fmt(hy)} Td (Groups) Tj ET`);
  out.push(`1 1 1 rg BT /F2 8.8 Tf ${colSil} ${fmt(hy)} Td (Silhouette) Tj ET`);
  out.push(`1 1 1 rg BT /F2 8.8 Tf ${colInertia} ${fmt(hy)} Td (Inertia) Tj ET`);

  let curY = tableTop - rowH;
  runs.slice(0, 18).forEach((item, idx) => {
    const rowBot = curY - rowH;
    const frame = item.resultFrame;
    if (idx % 2 === 1) {
      out.push(`0.973 0.980 0.988 rg ${margin} ${fmt(rowBot)} ${contentWidth} ${rowH} re f`);
    }
    const cfgShort =
      item.algorithm === 'KMEANS'
        ? `K-Means (K=${item.kMeansConfig.k})`
        : `DBSCAN (eps=${item.dbscanConfig.epsilon.toFixed(2)})`;
    const ry = rowBot + 8;
    out.push(`0.059 0.090 0.165 rg BT /F1 8.8 Tf ${colIdx} ${fmt(ry)} Td (${idx + 1}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 8.8 Tf ${colDataset} ${fmt(ry)} Td (${escPdf(item.datasetTitle.slice(0, 24))}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 8.8 Tf ${colAlgo} ${fmt(ry)} Td (${escPdf(cfgShort)}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 8.8 Tf ${colPts} ${fmt(ry)} Td (${item.rawPoints.length}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 8.8 Tf ${colClusters} ${fmt(ry)} Td (${frame?.clusterSummaries.length ?? 0}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 8.8 Tf ${colSil} ${fmt(ry)} Td (${(frame?.silhouetteScore ?? 0).toFixed(3)}) Tj ET`);
    out.push(`0.059 0.090 0.165 rg BT /F1 8.8 Tf ${colInertia} ${fmt(ry)} Td (${(frame?.wcss ?? 0).toFixed(4)}) Tj ET`);
    out.push(`0.886 0.910 0.941 RG 0.7 w ${margin} ${fmt(rowBot)} m ${margin + contentWidth} ${fmt(rowBot)} l S`);
    curY = rowBot;
  });

  const noteY = Math.max(54, curY - 24);
  out.push(
    `0.278 0.333 0.412 rg BT /F1 9.5 Tf ${margin} ${fmt(noteY)} Td (${escPdf(`Detailed 2D visualization snapshots and per-cluster tables follow on Pages 2-${totalPages}.`)}) Tj ET`
  );

  out.push(`0.886 0.910 0.941 RG 1 w ${margin} 36 m ${PAGE_WIDTH - margin} 36 l S`);
  out.push(
    `0.392 0.455 0.545 rg BT /F1 8.5 Tf ${margin} 20 Td (${escPdf(`ClusterLab v1.0 (AJ60)  -  Combined Batch Analysis Report  -  Page 1 of ${totalPages}`)}) Tj ET`
  );

  return new TextEncoder().encode(out.join('\n') + '\n');
}

function assembleMultiPagePdf14(pageContentStreams: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  const enc = new TextEncoder();
  let totalBytes = 0;

  const writeStr = (s: string) => {
    const b = enc.encode(s);
    chunks.push(b);
    totalBytes += b.length;
  };
  const writeBytes = (b: Uint8Array) => {
    chunks.push(b);
    totalBytes += b.length;
  };

  const pageCount = Math.max(1, pageContentStreams.length);
  // Objects:
  // 1: Catalog, 2: Pages, 3: Helvetica (/F1), 4: Helvetica-Bold (/F2)
  // Page i: pageObj = 5 + i*2, contentObj = 6 + i*2
  const kidsRefs = Array.from({ length: pageCount }, (_, i) => `${5 + i * 2} 0 R`).join(' ');

  writeStr('%PDF-1.4\n');

  offsets.push(totalBytes);
  writeStr('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');

  offsets.push(totalBytes);
  writeStr(`2 0 obj << /Type /Pages /Kids [${kidsRefs}] /Count ${pageCount} >> endobj\n`);

  offsets.push(totalBytes);
  writeStr('3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');

  offsets.push(totalBytes);
  writeStr('4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj\n');

  pageContentStreams.forEach((contentBytes, i) => {
    const pageObjId = 5 + i * 2;
    const contentObjId = 6 + i * 2;
    offsets.push(totalBytes);
    writeStr(
      `${pageObjId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >> endobj\n`
    );
    offsets.push(totalBytes);
    writeStr(`${contentObjId} 0 obj << /Length ${contentBytes.length} >> stream\n`);
    writeBytes(contentBytes);
    writeStr('\nendstream endobj\n');
  });

  const xrefOffset = totalBytes;
  writeStr(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) {
    writeStr(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  writeStr(`trailer << /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const merged = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return merged;
}

export function generateSinglePdfBytes(input: PdfReportInput): Uint8Array {
  return assembleMultiPagePdf14([buildReportPageStream(input, 1, 1)]);
}

export function generateCombinedBatchPdfBytes(input: BatchPdfReportInput): Uint8Array {
  const runs = input.completedItems.filter((item) => item.status === 'COMPLETED' && item.resultFrame !== null);
  const totalPages = 1 + runs.length;
  const streams: Uint8Array[] = [buildBatchExecutiveCoverStream(input, runs, totalPages)];

  runs.forEach((item, idx) => {
    const frame = item.resultFrame;
    streams.push(
      buildReportPageStream(
        {
          datasetTitle: item.datasetTitle,
          algorithm: item.algorithm,
          kMeansConfig: item.kMeansConfig,
          dbscanConfig: item.dbscanConfig,
          points: frame?.points ?? item.rawPoints,
          centroids: frame?.centroids ?? [],
          frame,
          showVoronoi: input.showVoronoi,
          showTrails: input.showTrails,
          showSpiderLines: input.showSpiderLines,
          showEpsilonRings: input.showEpsilonRings,
          annotations: item.annotations,
        },
        idx + 2,
        totalPages,
        `Batch Run ${idx + 1} of ${runs.length}`
      )
    );
  });

  return assembleMultiPagePdf14(streams);
}
