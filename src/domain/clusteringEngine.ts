import {
  CentroidState,
  ClusterSummary,
  ClusteringStepFrame,
  Coordinate,
  DataPoint,
  DbscanConfig,
  KMeansConfig,
  PointRole,
} from '../types/clustering';

/**
 * Deterministic seeded PRNG (Mulberry32) so K-Means++ / Random initialization and
 * preset generation behave deterministically per seed.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
    if (this.state === 0) this.state = 0x6d2b79f5;
  }

  nextFloat(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(bound: number): number {
    if (bound <= 1) return 0;
    return Math.floor(this.nextFloat() * bound);
  }

  nextGaussian(): number {
    let u1 = this.nextFloat();
    const u2 = this.nextFloat();
    if (u1 < 1e-7) u1 = 1e-7;
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }
}

export function euclideanDistance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

export function computeClusterCentroids(points: DataPoint[]): CentroidState[] {
  const groups = new Map<number, DataPoint[]>();
  for (const pt of points) {
    if (pt.clusterId < 0) continue;
    const list = groups.get(pt.clusterId);
    if (list) list.push(pt);
    else groups.set(pt.clusterId, [pt]);
  }
  const sortedIds = Array.from(groups.keys()).sort((a, b) => a - b);
  return sortedIds.map((clusterId) => {
    const members = groups.get(clusterId)!;
    let sx = 0;
    let sy = 0;
    for (const m of members) {
      sx += m.x;
      sy += m.y;
    }
    const cx = sx / members.length;
    const cy = sy / members.length;
    return {
      clusterId,
      x: cx,
      y: cy,
      trail: [{ x: cx, y: cy }],
    };
  });
}

export function evaluateClustering(
  points: DataPoint[],
  centroids: CentroidState[],
  maxSilhouetteSample = 100
): {
  wcss: number;
  silhouetteScore: number;
  clusterSummaries: ClusterSummary[];
} {
  if (points.length === 0) {
    return { wcss: 0, silhouetteScore: 0, clusterSummaries: [] };
  }

  const centroidMap = new Map<number, CentroidState>();
  for (const c of centroids) centroidMap.set(c.clusterId, c);

  const grouped = new Map<number, DataPoint[]>();
  for (const pt of points) {
    if (pt.clusterId < 0) continue;
    const list = grouped.get(pt.clusterId);
    if (list) list.push(pt);
    else grouped.set(pt.clusterId, [pt]);
  }

  let totalWcss = 0;
  const sortedClusterIds = Array.from(grouped.keys()).sort((a, b) => a - b);

  const clusterSummaries: ClusterSummary[] = sortedClusterIds.map((clusterId) => {
    const members = grouped.get(clusterId)!;
    const c = centroidMap.get(clusterId);
    let cx = c?.x ?? 0;
    let cy = c?.y ?? 0;
    if (!c) {
      let sx = 0;
      let sy = 0;
      for (const m of members) {
        sx += m.x;
        sy += m.y;
      }
      cx = sx / members.length;
      cy = sy / members.length;
    }

    let distSum = 0;
    for (const m of members) {
      const dist = euclideanDistance(m.x, m.y, cx, cy);
      totalWcss += dist * dist;
      distSum += dist;
    }

    return {
      clusterId,
      count: members.length,
      percentage: (members.length / points.length) * 100,
      centroidX: cx,
      centroidY: cy,
      avgIntraDistance: members.length > 0 ? distSum / members.length : 0,
    };
  });

  const clustered = points.filter((p) => p.clusterId >= 0);
  let silhouetteScore = 0;
  if (grouped.size >= 2 && clustered.length >= 3) {
    const stride = Math.max(1, Math.floor(clustered.length / maxSilhouetteSample));
    let silSum = 0;
    let validCount = 0;

    for (let idx = 0; idx < clustered.length; idx += stride) {
      const item = clustered[idx];
      const ownGroup = grouped.get(item.clusterId) ?? [];
      let a = 0;
      if (ownGroup.length > 1) {
        let sum = 0;
        for (const other of ownGroup) {
          if (other.id !== item.id) {
            sum += euclideanDistance(item.x, item.y, other.x, other.y);
          }
        }
        a = sum / (ownGroup.length - 1);
      }

      let b = Number.POSITIVE_INFINITY;
      for (const [otherClusterId, otherMembers] of grouped.entries()) {
        if (otherClusterId === item.clusterId || otherMembers.length === 0) continue;
        let sum = 0;
        for (const other of otherMembers) {
          sum += euclideanDistance(item.x, item.y, other.x, other.y);
        }
        const avgDist = sum / otherMembers.length;
        if (avgDist < b) b = avgDist;
      }

      const denom = Math.max(a, b);
      if (denom > 1e-9 && Number.isFinite(b)) {
        silSum += (b - a) / denom;
        validCount++;
      }
    }
    if (validCount > 0) {
      silhouetteScore = Math.max(-1, Math.min(1, silSum / validCount));
    }
  }

  return {
    wcss: totalWcss,
    silhouetteScore,
    clusterSummaries,
  };
}

function initializeKMeansPlusPlus(
  points: DataPoint[],
  k: number,
  rng: SeededRandom
): CentroidState[] {
  const chosen: CentroidState[] = [];
  const first = points[rng.nextInt(points.length)];
  chosen.push({
    clusterId: 0,
    x: first.x,
    y: first.y,
    trail: [{ x: first.x, y: first.y }],
  });

  const distSquared = new Float64Array(points.length);
  for (let clusterIdx = 1; clusterIdx < k; clusterIdx++) {
    let sumSq = 0;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      let minD2 = Number.POSITIVE_INFINITY;
      for (const c of chosen) {
        const d = euclideanDistance(pt.x, pt.y, c.x, c.y);
        const d2 = d * d;
        if (d2 < minD2) minD2 = d2;
      }
      distSquared[i] = minD2;
      sumSq += minD2;
    }

    let selectedPoint = points[points.length - 1];
    if (sumSq <= 1e-12) {
      selectedPoint = points[rng.nextInt(points.length)];
    } else {
      const target = rng.nextFloat() * sumSq;
      let cumulative = 0;
      for (let i = 0; i < points.length; i++) {
        cumulative += distSquared[i];
        if (cumulative >= target) {
          selectedPoint = points[i];
          break;
        }
      }
    }

    chosen.push({
      clusterId: clusterIdx,
      x: selectedPoint.x,
      y: selectedPoint.y,
      trail: [{ x: selectedPoint.x, y: selectedPoint.y }],
    });
  }

  return chosen;
}

function assignPointsToNearestCentroids(
  points: DataPoint[],
  centroids: CentroidState[]
): DataPoint[] {
  if (centroids.length === 0) {
    return points.map((p) => ({ ...p, clusterId: -1, role: 'STANDARD' }));
  }
  return points.map((pt) => {
    let bestCluster = centroids[0].clusterId;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const c of centroids) {
      const d = euclideanDistance(pt.x, pt.y, c.x, c.y);
      if (d < bestDistance) {
        bestDistance = d;
        bestCluster = c.clusterId;
      }
    }
    return {
      ...pt,
      clusterId: bestCluster,
      role: 'STANDARD',
    };
  });
}

export function computeKMeansFrames(
  rawPoints: DataPoint[],
  config: KMeansConfig,
  seed = 42
): ClusteringStepFrame[] {
  if (rawPoints.length === 0) {
    return [
      {
        stepIndex: 0,
        description: 'Add or load points to run K-Means.',
        points: [],
        centroids: [],
        isConverged: true,
        wcss: 0,
        silhouetteScore: 0,
        noiseCount: 0,
        coreCount: 0,
        borderCount: 0,
        clusterSummaries: [],
      },
    ];
  }

  const effectiveK = Math.max(1, Math.min(config.k, Math.min(10, rawPoints.length)));
  const rng = new SeededRandom(seed);
  const tolerance = 1e-4;

  let centroids: CentroidState[];
  if (config.useKMeansPlusPlus) {
    centroids = initializeKMeansPlusPlus(rawPoints, effectiveK, rng);
  } else {
    const shuffled = [...rawPoints];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    centroids = shuffled.slice(0, effectiveK).map((pt, idx) => ({
      clusterId: idx,
      x: pt.x,
      y: pt.y,
      trail: [{ x: pt.x, y: pt.y }],
    }));
  }

  const frames: ClusteringStepFrame[] = [];
  let currentAssignments = assignPointsToNearestCentroids(rawPoints, centroids);
  const initEval = evaluateClustering(currentAssignments, centroids);

  frames.push({
    stepIndex: 0,
    description: config.useKMeansPlusPlus
      ? `Step 0: K-Means++ seeded ${effectiveK} centroids & initial Voronoi assignment`
      : `Step 0: Random seeded ${effectiveK} centroids & initial assignment`,
    points: currentAssignments,
    centroids,
    isConverged: false,
    wcss: initEval.wcss,
    silhouetteScore: initEval.silhouetteScore,
    noiseCount: 0,
    coreCount: currentAssignments.length,
    borderCount: 0,
    clusterSummaries: initEval.clusterSummaries,
  });

  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    let maxCentroidShift = 0;

    const updatedCentroids: CentroidState[] = centroids.map((centroid) => {
      const members = currentAssignments.filter((p) => p.clusterId === centroid.clusterId);
      if (members.length === 0) {
        return centroid;
      }
      let sx = 0;
      let sy = 0;
      for (const m of members) {
        sx += m.x;
        sy += m.y;
      }
      const nx = sx / members.length;
      const ny = sy / members.length;
      const shift = euclideanDistance(centroid.x, centroid.y, nx, ny);
      if (shift > maxCentroidShift) {
        maxCentroidShift = shift;
      }
      const nextTrail: Coordinate[] = [...centroid.trail, { x: nx, y: ny }];
      return {
        clusterId: centroid.clusterId,
        x: nx,
        y: ny,
        trail: nextTrail,
      };
    });

    const nextAssignments = assignPointsToNearestCentroids(rawPoints, updatedCentroids);
    let anyReassigned = false;
    for (let i = 0; i < nextAssignments.length; i++) {
      if (nextAssignments[i].clusterId !== currentAssignments[i].clusterId) {
        anyReassigned = true;
        break;
      }
    }

    centroids = updatedCentroids;
    currentAssignments = nextAssignments;
    const converged = !anyReassigned || maxCentroidShift <= tolerance;
    const stepEval = evaluateClustering(currentAssignments, centroids);

    frames.push({
      stepIndex: iteration,
      description: converged
        ? `Step ${iteration}: Converged (Δ centroid = ${maxCentroidShift.toFixed(4)})`
        : `Step ${iteration}: Updated centroids & reassigned points (Δ = ${maxCentroidShift.toFixed(4)})`,
      points: currentAssignments,
      centroids,
      isConverged: converged,
      wcss: stepEval.wcss,
      silhouetteScore: stepEval.silhouetteScore,
      noiseCount: 0,
      coreCount: currentAssignments.length,
      borderCount: 0,
      clusterSummaries: stepEval.clusterSummaries,
    });

    if (converged) break;
  }

  return frames;
}

export function computeDbscanFrames(
  rawPoints: DataPoint[],
  config: DbscanConfig
): ClusteringStepFrame[] {
  if (rawPoints.length === 0) {
    return [
      {
        stepIndex: 0,
        description: 'Add or load points to run DBSCAN.',
        points: [],
        centroids: [],
        isConverged: true,
        wcss: 0,
        silhouetteScore: 0,
        noiseCount: 0,
        coreCount: 0,
        borderCount: 0,
        clusterSummaries: [],
      },
    ];
  }

  const eps = config.epsilon;
  const minPts = config.minPts;
  const n = rawPoints.length;

  const neighborhoods: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p1 = rawPoints[i];
    const neighbors: number[] = [];
    for (let j = 0; j < n; j++) {
      if (euclideanDistance(p1.x, p1.y, rawPoints[j].x, rawPoints[j].y) <= eps) {
        neighbors.push(j);
      }
    }
    neighborhoods[i] = neighbors;
  }

  const isCore = neighborhoods.map((nb) => nb.length >= minPts);
  const clusterIds = new Int32Array(n).fill(-1);
  const roles: PointRole[] = isCore.map((core) => (core ? 'CORE' : 'NOISE'));
  const visited = new Uint8Array(n);

  const frames: ClusteringStepFrame[] = [];

  const initialAssignments: DataPoint[] = rawPoints.map((pt, idx) => ({
    ...pt,
    clusterId: -1,
    role: isCore[idx] ? 'CORE' : 'STANDARD',
  }));
  const initialCoreCount = isCore.filter(Boolean).length;

  frames.push({
    stepIndex: 0,
    description: `Step 0: Detected ${initialCoreCount} core points (ε=${eps.toFixed(3)}, MinPts=${minPts})`,
    points: initialAssignments,
    centroids: [],
    isConverged: false,
    wcss: 0,
    silhouetteScore: 0,
    noiseCount: n - initialCoreCount,
    coreCount: initialCoreCount,
    borderCount: 0,
    clusterSummaries: [],
  });

  let currentClusterIndex = 0;
  let stepCounter = 1;

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = 1;

    if (!isCore[i]) {
      roles[i] = 'NOISE';
      continue;
    }

    const assignedClusterId = currentClusterIndex;
    currentClusterIndex++;
    clusterIds[i] = assignedClusterId;
    roles[i] = 'CORE';

    const queue: number[] = [];
    for (const nb of neighborhoods[i]) {
      if (nb !== i) queue.push(nb);
    }

    let expandedCount = 1;
    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      if (!visited[curr]) {
        visited[curr] = 1;
        if (isCore[curr]) {
          roles[curr] = 'CORE';
          for (const nb of neighborhoods[curr]) {
            if (clusterIds[nb] === -1) {
              queue.push(nb);
            }
          }
        }
      }
      if (clusterIds[curr] === -1) {
        clusterIds[curr] = assignedClusterId;
        roles[curr] = isCore[curr] ? 'CORE' : 'BORDER';
        expandedCount++;
      }
    }

    const waveAssignments: DataPoint[] = rawPoints.map((pt, idx) => ({
      ...pt,
      clusterId: clusterIds[idx],
      role: roles[idx],
    }));
    const centroids = computeClusterCentroids(waveAssignments);
    const waveEval = evaluateClustering(waveAssignments, centroids);
    const waveCoreCount = waveAssignments.filter(
      (p) => p.role === 'CORE' && p.clusterId >= 0
    ).length;
    const waveBorderCount = waveAssignments.filter((p) => p.role === 'BORDER').length;
    const waveNoiseCount = waveAssignments.filter((p) => p.clusterId === -1).length;

    frames.push({
      stepIndex: stepCounter,
      description: `Step ${stepCounter}: Expanded Cluster #${currentClusterIndex} (${expandedCount} density-reachable pts)`,
      points: waveAssignments,
      centroids,
      isConverged: false,
      wcss: waveEval.wcss,
      silhouetteScore: waveEval.silhouetteScore,
      noiseCount: waveNoiseCount,
      coreCount: waveCoreCount,
      borderCount: waveBorderCount,
      clusterSummaries: waveEval.clusterSummaries,
    });
    stepCounter++;
  }

  const finalAssignments: DataPoint[] = rawPoints.map((pt, idx) => {
    const cid = clusterIds[idx];
    const finalRole: PointRole =
      cid === -1 ? 'NOISE' : isCore[idx] ? 'CORE' : 'BORDER';
    return {
      ...pt,
      clusterId: cid,
      role: finalRole,
    };
  });
  const finalCentroids = computeClusterCentroids(finalAssignments);
  const finalEval = evaluateClustering(finalAssignments, finalCentroids);
  const finalCoreCount = finalAssignments.filter((p) => p.role === 'CORE').length;
  const finalBorderCount = finalAssignments.filter((p) => p.role === 'BORDER').length;
  const finalNoiseCount = finalAssignments.filter((p) => p.role === 'NOISE').length;

  frames.push({
    stepIndex: stepCounter,
    description: `Complete: ${currentClusterIndex} clusters found (${finalCoreCount} core, ${finalBorderCount} border, ${finalNoiseCount} noise)`,
    points: finalAssignments,
    centroids: finalCentroids,
    isConverged: true,
    wcss: finalEval.wcss,
    silhouetteScore: finalEval.silhouetteScore,
    noiseCount: finalNoiseCount,
    coreCount: finalCoreCount,
    borderCount: finalBorderCount,
    clusterSummaries: finalEval.clusterSummaries,
  });

  return frames;
}
