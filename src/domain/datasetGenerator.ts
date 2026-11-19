import {
  CentroidState,
  DataPoint,
  PointRole,
  PresetDatasetType,
} from '../types/clustering';
import { SeededRandom } from './clusteringEngine';

function clampCoord(v: number): number {
  return Math.max(0.04, Math.min(0.96, v));
}

export function generatePresetDataset(
  type: PresetDatasetType,
  count = 150,
  noiseSpread = 0.035,
  seed = Date.now()
): DataPoint[] {
  const rng = new SeededRandom(seed);

  switch (type) {
    case 'TWO_MOONS': {
      const points: DataPoint[] = [];
      const half = Math.floor(count / 2);
      for (let i = 0; i < half; i++) {
        const angle = (i / half) * Math.PI;
        const x = 0.36 + 0.24 * Math.cos(angle) + rng.nextGaussian() * noiseSpread;
        const y = 0.44 - 0.22 * Math.sin(angle) + rng.nextGaussian() * noiseSpread;
        points.push({ id: points.length + 1, x: clampCoord(x), y: clampCoord(y), clusterId: -1, role: 'STANDARD' });
      }
      const rem = count - half;
      for (let i = 0; i < rem; i++) {
        const angle = (i / rem) * Math.PI;
        const x = 0.62 - 0.24 * Math.cos(angle) + rng.nextGaussian() * noiseSpread;
        const y = 0.56 + 0.22 * Math.sin(angle) + rng.nextGaussian() * noiseSpread;
        points.push({ id: points.length + 1, x: clampCoord(x), y: clampCoord(y), clusterId: -1, role: 'STANDARD' });
      }
      return points;
    }

    case 'GAUSSIAN_BLOBS': {
      const centers: Array<[number, number]> = [
        [0.26, 0.28],
        [0.74, 0.27],
        [0.29, 0.73],
        [0.72, 0.72],
      ];
      const spread = Math.max(0.03, Math.min(0.12, noiseSpread * 1.65));
      return Array.from({ length: count }, (_, idx) => {
        const [cx, cy] = centers[idx % centers.length];
        return {
          id: idx + 1,
          x: clampCoord(cx + rng.nextGaussian() * spread),
          y: clampCoord(cy + rng.nextGaussian() * spread),
          clusterId: -1,
          role: 'STANDARD' as PointRole,
        };
      });
    }

    case 'CONCENTRIC_RINGS': {
      const points: DataPoint[] = [];
      const innerCount = Math.floor(count * 0.36);
      const outerCount = count - innerCount;
      const ringNoise = Math.max(0.012, Math.min(0.045, noiseSpread * 0.75));
      for (let i = 0; i < innerCount; i++) {
        const theta = (2 * Math.PI * i) / innerCount;
        const r = 0.14 + rng.nextGaussian() * ringNoise;
        points.push({
          id: points.length + 1,
          x: clampCoord(0.5 + r * Math.cos(theta)),
          y: clampCoord(0.5 + r * Math.sin(theta)),
          clusterId: -1,
          role: 'STANDARD',
        });
      }
      for (let i = 0; i < outerCount; i++) {
        const theta = (2 * Math.PI * i) / outerCount;
        const r = 0.34 + rng.nextGaussian() * ringNoise;
        points.push({
          id: points.length + 1,
          x: clampCoord(0.5 + r * Math.cos(theta)),
          y: clampCoord(0.5 + r * Math.sin(theta)),
          clusterId: -1,
          role: 'STANDARD',
        });
      }
      return points;
    }

    case 'ANISOTROPIC': {
      const centers: Array<[number, number]> = [
        [0.28, 0.34],
        [0.52, 0.5],
        [0.74, 0.64],
      ];
      const vSpread = Math.max(0.02, noiseSpread * 0.75);
      return Array.from({ length: count }, (_, idx) => {
        const [cx, cy] = centers[idx % centers.length];
        const u = rng.nextGaussian() * 0.11;
        const v = rng.nextGaussian() * vSpread;
        return {
          id: idx + 1,
          x: clampCoord(cx + u * 0.78 - v * 0.62),
          y: clampCoord(cy + u * 0.62 + v * 0.78),
          clusterId: -1,
          role: 'STANDARD' as PointRole,
        };
      });
    }

    case 'SPIRAL_GALAXY': {
      const points: DataPoint[] = [];
      const armCount = Math.floor(count / 2);
      const spiralNoise = Math.max(0.008, Math.min(0.03, noiseSpread * 0.55));
      for (let i = 0; i < armCount; i++) {
        const t = i / armCount;
        const angle = t * 2.4 * Math.PI;
        const radius = 0.06 + t * 0.34;
        points.push({
          id: points.length + 1,
          x: clampCoord(0.5 + radius * Math.cos(angle) + rng.nextGaussian() * spiralNoise),
          y: clampCoord(0.5 + radius * Math.sin(angle) + rng.nextGaussian() * spiralNoise),
          clusterId: -1,
          role: 'STANDARD',
        });
        points.push({
          id: points.length + 1,
          x: clampCoord(0.5 - radius * Math.cos(angle) + rng.nextGaussian() * spiralNoise),
          y: clampCoord(0.5 - radius * Math.sin(angle) + rng.nextGaussian() * spiralNoise),
          clusterId: -1,
          role: 'STANDARD',
        });
      }
      return points;
    }

    case 'NOISY_CLUSTERS': {
      const points: DataPoint[] = [];
      const centers: Array<[number, number]> = [
        [0.26, 0.32],
        [0.73, 0.3],
        [0.5, 0.72],
      ];
      const outlierCount = Math.max(10, Math.floor(count * 0.14));
      const clusterCount = count - outlierCount;
      const spread = Math.max(0.025, Math.min(0.07, noiseSpread * 1.2));
      for (let i = 0; i < clusterCount; i++) {
        const [cx, cy] = centers[i % centers.length];
        points.push({
          id: points.length + 1,
          x: clampCoord(cx + rng.nextGaussian() * spread),
          y: clampCoord(cy + rng.nextGaussian() * spread),
          clusterId: -1,
          role: 'STANDARD',
        });
      }
      for (let i = 0; i < outlierCount; i++) {
        points.push({
          id: points.length + 1,
          x: 0.08 + rng.nextFloat() * 0.84,
          y: 0.08 + rng.nextFloat() * 0.84,
          clusterId: -1,
          role: 'STANDARD',
        });
      }
      return points;
    }
  }
}

interface ParsedRawRow {
  id: number | null;
  x: number;
  y: number;
  clusterId: number;
  role: PointRole;
}

function parseRole(raw?: string): PointRole {
  const upper = (raw ?? '').trim().toUpperCase();
  if (upper === 'CORE' || upper === 'BORDER' || upper === 'NOISE' || upper === 'STANDARD') {
    return upper;
  }
  return 'STANDARD';
}

function toFiniteFloat(raw?: string): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function toInt(raw?: string): number | null {
  const num = toFiniteFloat(raw);
  if (num === null || !Number.isInteger(num)) return null;
  return num;
}

export function parseRawTextToPoints(rawText: string): DataPoint[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const parsedRows: ParsedRawRow[] = [];
  const numberRegex = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const objMatches = trimmed.match(/\{[^}]*\}|\[[^[\]]*\]/g);
    const blocks = objMatches && objMatches.length > 0 ? objMatches : trimmed.split(/\r?\n/);
    for (const block of blocks) {
      const nums = (block.match(numberRegex) ?? []).map(Number).filter(Number.isFinite);
      if (nums.length >= 2) {
        parsedRows.push({
          id: null,
          x: nums[0],
          y: nums[1],
          clusterId: -1,
          role: 'STANDARD',
        });
      }
    }
  } else {
    let hasIdColumnHeader = false;
    let xColIndex = 0;
    let yColIndex = 1;
    let clusterColIndex = -1;
    let roleColIndex = -1;
    let headerParsed = false;

    for (const line of trimmed.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith('#') || clean.startsWith('//')) continue;

      const tokens = clean.split(/[,;\t]/).map((t) => t.trim());
      const lowerTokens = tokens.map((t) => t.toLowerCase());

      if (
        !headerParsed &&
        lowerTokens.some((t) => t === 'x' || t === 'y' || t === 'cluster_id' || t === 'point_role')
      ) {
        headerParsed = true;
        hasIdColumnHeader = lowerTokens[0] === 'id';
        const foundX = lowerTokens.indexOf('x');
        const foundY = lowerTokens.indexOf('y');
        if (foundX >= 0 && foundY >= 0) {
          xColIndex = foundX;
          yColIndex = foundY;
        } else if (hasIdColumnHeader) {
          xColIndex = 1;
          yColIndex = 2;
        }
        clusterColIndex = lowerTokens.findIndex((t) => t === 'cluster_id' || t === 'cluster');
        roleColIndex = lowerTokens.findIndex((t) => t === 'point_role' || t === 'role');
        continue;
      }

      if (headerParsed && tokens.length > Math.max(xColIndex, yColIndex)) {
        const xVal = toFiniteFloat(tokens[xColIndex]);
        const yVal = toFiniteFloat(tokens[yColIndex]);
        if (xVal !== null && yVal !== null) {
          const idVal = hasIdColumnHeader ? toInt(tokens[0]) : null;
          const clusterVal = clusterColIndex >= 0 ? toInt(tokens[clusterColIndex]) ?? -1 : -1;
          const roleVal = roleColIndex >= 0 ? parseRole(tokens[roleColIndex]) : 'STANDARD';
          parsedRows.push({
            id: idVal,
            x: xVal,
            y: yVal,
            clusterId: clusterVal,
            role: roleVal,
          });
          continue;
        }
      }

      if (
        tokens.length >= 4 &&
        toInt(tokens[0]) !== null &&
        toFiniteFloat(tokens[1]) !== null &&
        toFiniteFloat(tokens[2]) !== null &&
        toInt(tokens[3]) !== null
      ) {
        parsedRows.push({
          id: toInt(tokens[0]),
          x: toFiniteFloat(tokens[1])!,
          y: toFiniteFloat(tokens[2])!,
          clusterId: toInt(tokens[3]) ?? -1,
          role: parseRole(tokens[4]),
        });
        continue;
      }

      const nums = (clean.match(numberRegex) ?? []).map(Number).filter(Number.isFinite);
      if (nums.length >= 2) {
        parsedRows.push({
          id: null,
          x: nums[0],
          y: nums[1],
          clusterId: nums[2] !== undefined ? Math.trunc(nums[2]) : -1,
          role: 'STANDARD',
        });
      }
    }
  }

  if (parsedRows.length === 0) return [];

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of parsedRows) {
    if (r.x < minX) minX = r.x;
    if (r.x > maxX) maxX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.y > maxY) maxY = r.y;
  }

  const alreadyNormalized = minX >= 0 && maxX <= 1 && minY >= 0 && maxY <= 1;
  const rangeX = maxX - minX > 1e-6 ? maxX - minX : 1;
  const rangeY = maxY - minY > 1e-6 ? maxY - minY : 1;

  return parsedRows.map((row, index) => {
    const nx = alreadyNormalized
      ? clampCoord(row.x)
      : clampCoord(0.08 + ((row.x - minX) / rangeX) * 0.84);
    const ny = alreadyNormalized
      ? clampCoord(row.y)
      : clampCoord(0.08 + ((row.y - minY) / rangeY) * 0.84);
    return {
      id: row.id ?? index + 1,
      x: nx,
      y: ny,
      clusterId: row.clusterId,
      role: row.role,
    };
  });
}

export function exportPointsToCsv(
  points: DataPoint[],
  centroids: CentroidState[] = [],
  datasetTitle?: string
): string {
  const lines: string[] = [];
  if (datasetTitle && datasetTitle.trim().length > 0) {
    lines.push(`# dataset: ${datasetTitle.trim()}`);
  }
  for (const c of centroids) {
    lines.push(`# centroid_${c.clusterId}: ${c.x.toFixed(5)},${c.y.toFixed(5)}`);
  }
  lines.push('id,x,y,cluster_id,point_role');
  for (const pt of points) {
    lines.push(`${pt.id},${pt.x.toFixed(5)},${pt.y.toFixed(5)},${pt.clusterId},${pt.role}`);
  }
  return lines.join('\n') + '\n';
}
