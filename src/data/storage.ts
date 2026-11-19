import {
  AlgorithmType,
  CentroidState,
  DataPoint,
  LocalCsvFileInfo,
  LocalPdfReportInfo,
  SavedDatasetEntity,
  StudioPreferences,
} from '../types/clustering';
import { exportPointsToCsv, parseRawTextToPoints } from '../domain/datasetGenerator';

const KEY_PREFS = 'clusterlab.prefs.v1';
const KEY_SNAPSHOTS = 'clusterlab.snapshots.v1';
const KEY_CSV_FILES = 'clusterlab.csv_files.v1';
const KEY_PDF_REPORTS = 'clusterlab.pdf_reports.v1';

const DEFAULT_PREFS: StudioPreferences = {
  isDarkTheme: true,
  showGrid: true,
  showSpiderLines: true,
  developerModeEnabled: false,
  hasCompletedOnboarding: false,
};

export function loadPreferences(): StudioPreferences {
  try {
    const raw = localStorage.getItem(KEY_PREFS);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<StudioPreferences>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePreferences(prefs: StudioPreferences): void {
  try {
    localStorage.setItem(KEY_PREFS, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors
  }
}

// Snapshots (replaces Android Room SavedDatasetDao)
export function serializePoints(points: DataPoint[]): string {
  return JSON.stringify(points);
}

export function deserializePoints(serialized: string): DataPoint[] {
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p, idx) => ({
      id: typeof p.id === 'number' ? p.id : idx + 1,
      x: typeof p.x === 'number' ? p.x : 0.5,
      y: typeof p.y === 'number' ? p.y : 0.5,
      clusterId: typeof p.clusterId === 'number' ? p.clusterId : -1,
      role: p.role ?? 'STANDARD',
    }));
  } catch {
    return [];
  }
}

export function loadSavedSnapshots(): SavedDatasetEntity[] {
  try {
    const raw = localStorage.getItem(KEY_SNAPSHOTS);
    if (!raw) return [];
    const list = JSON.parse(raw) as SavedDatasetEntity[];
    return Array.isArray(list) ? list.sort((a, b) => b.createdAt - a.createdAt) : [];
  } catch {
    return [];
  }
}

export function saveDatasetSnapshot(params: {
  title: string;
  algorithm: AlgorithmType;
  points: DataPoint[];
  kValue: number;
  epsilonValue: number;
  minPtsValue: number;
}): SavedDatasetEntity[] {
  const existing = loadSavedSnapshots();
  const nextId = (existing.reduce((m, s) => Math.max(m, s.id), 0) || 0) + 1;
  const entity: SavedDatasetEntity = {
    id: nextId,
    title: params.title,
    algorithm: params.algorithm,
    pointCount: params.points.length,
    kValue: params.kValue,
    epsilonValue: params.epsilonValue,
    minPtsValue: params.minPtsValue,
    pointsSerialized: serializePoints(params.points),
    createdAt: Date.now(),
  };
  const updated = [entity, ...existing];
  try {
    localStorage.setItem(KEY_SNAPSHOTS, JSON.stringify(updated));
  } catch {
    // ignore quota
  }
  return updated;
}

export function deleteDatasetSnapshot(id: number): SavedDatasetEntity[] {
  const updated = loadSavedSnapshots().filter((s) => s.id !== id);
  try {
    localStorage.setItem(KEY_SNAPSHOTS, JSON.stringify(updated));
  } catch {
    // ignore quota
  }
  return updated;
}

// Local CSV Storage Manager
export function sanitizeCsvFileName(rawTitle: string): string {
  const base = rawTitle
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = base || 'clusterlab_dataset';
  return safe.toLowerCase().endsWith('.csv') ? safe : `${safe}.csv`;
}

export function loadLocalCsvFiles(): LocalCsvFileInfo[] {
  try {
    const raw = localStorage.getItem(KEY_CSV_FILES);
    if (!raw) return [];
    const list = JSON.parse(raw) as LocalCsvFileInfo[];
    return Array.isArray(list)
      ? list.sort((a, b) => b.lastModifiedMillis - a.lastModifiedMillis)
      : [];
  } catch {
    return [];
  }
}

export function saveCsvToLocalStorage(
  desiredName: string,
  points: DataPoint[],
  centroids: CentroidState[] = []
): { info: LocalCsvFileInfo; allFiles: LocalCsvFileInfo[] } {
  const fileName = sanitizeCsvFileName(desiredName);
  const content = exportPointsToCsv(points, centroids, desiredName);
  const bytes = new TextEncoder().encode(content).length;
  const info: LocalCsvFileInfo = {
    fileName,
    pointCount: points.length,
    sizeBytes: bytes,
    lastModifiedMillis: Date.now(),
    content,
  };
  const existing = loadLocalCsvFiles().filter((f) => f.fileName !== fileName);
  const allFiles = [info, ...existing];
  try {
    localStorage.setItem(KEY_CSV_FILES, JSON.stringify(allFiles));
  } catch {
    // ignore quota
  }
  return { info, allFiles };
}

export function importCsvFromLocalStorage(fileName: string): {
  points: DataPoint[];
  fileName: string;
} | null {
  const match = loadLocalCsvFiles().find((f) => f.fileName === fileName);
  if (!match) return null;
  return {
    points: parseRawTextToPoints(match.content),
    fileName: match.fileName,
  };
}

export function deleteLocalCsvFile(fileName: string): LocalCsvFileInfo[] {
  const updated = loadLocalCsvFiles().filter((f) => f.fileName !== fileName);
  try {
    localStorage.setItem(KEY_CSV_FILES, JSON.stringify(updated));
  } catch {
    // ignore quota
  }
  return updated;
}

// Local PDF Reports Storage Manager
export function sanitizePdfFileName(rawTitle: string): string {
  const base = rawTitle
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = base || 'clusterlab_report';
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}_report.pdf`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function loadLocalPdfReports(): LocalPdfReportInfo[] {
  try {
    const raw = localStorage.getItem(KEY_PDF_REPORTS);
    if (!raw) return [];
    const list = JSON.parse(raw) as LocalPdfReportInfo[];
    return Array.isArray(list)
      ? list.sort((a, b) => b.lastModifiedMillis - a.lastModifiedMillis)
      : [];
  } catch {
    return [];
  }
}

export function savePdfToLocalStorage(
  desiredName: string,
  pdfBytes: Uint8Array
): { info: LocalPdfReportInfo; allReports: LocalPdfReportInfo[] } {
  const fileName = sanitizePdfFileName(desiredName);
  const info: LocalPdfReportInfo = {
    fileName,
    sizeBytes: pdfBytes.length,
    lastModifiedMillis: Date.now(),
    base64Data: uint8ToBase64(pdfBytes),
  };
  const existing = loadLocalPdfReports().filter((r) => r.fileName !== fileName);
  const allReports = [info, ...existing].slice(0, 12);
  try {
    localStorage.setItem(KEY_PDF_REPORTS, JSON.stringify(allReports));
  } catch {
    // If quota exceeded, keep latest few reports
    try {
      localStorage.setItem(KEY_PDF_REPORTS, JSON.stringify(allReports.slice(0, 4)));
    } catch {
      // ignore
    }
  }
  return { info, allReports };
}

export function deleteLocalPdfReport(fileName: string): LocalPdfReportInfo[] {
  const updated = loadLocalPdfReports().filter((r) => r.fileName !== fileName);
  try {
    localStorage.setItem(KEY_PDF_REPORTS, JSON.stringify(updated));
  } catch {
    // ignore
  }
  return updated;
}

export function getLocalPdfBytes(fileName: string): Uint8Array | null {
  const found = loadLocalPdfReports().find((r) => r.fileName === fileName);
  if (!found) return null;
  return base64ToUint8(found.base64Data);
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

export function formatDateTime(millis: number): string {
  const d = new Date(millis);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function triggerFileDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
