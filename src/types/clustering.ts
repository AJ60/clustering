export const CLUSTER_COLORS = [
  '#3B82F6', // 0: Cobalt Blue
  '#10B981', // 1: Emerald Green
  '#F59E0B', // 2: Warm Amber
  '#EF4444', // 3: Coral Red
  '#8B5CF6', // 4: Electric Violet
  '#06B6D4', // 5: Cyan Teal
  '#EC4899', // 6: Vivid Rose
  '#84CC16', // 7: Lime
  '#F97316', // 8: Bright Orange
  '#6366F1', // 9: Indigo
] as const;

export const NOISE_POINT_COLOR = '#94A3B8';

export type AlgorithmType = 'KMEANS' | 'DBSCAN';

export const ALGORITHM_LABELS: Record<AlgorithmType, string> = {
  KMEANS: 'K-Means',
  DBSCAN: 'DBSCAN',
};

export type PointRole = 'STANDARD' | 'CORE' | 'BORDER' | 'NOISE';

export type CanvasToolMode = 'ADD' | 'BRUSH' | 'ERASE' | 'PAN';

export const CANVAS_TOOL_LABELS: Record<CanvasToolMode, string> = {
  ADD: 'Tap Add',
  BRUSH: 'Brush',
  ERASE: 'Erase',
  PAN: 'Pan/Zoom',
};

export type PresetDatasetType =
  | 'TWO_MOONS'
  | 'GAUSSIAN_BLOBS'
  | 'CONCENTRIC_RINGS'
  | 'ANISOTROPIC'
  | 'SPIRAL_GALAXY'
  | 'NOISY_CLUSTERS';

export const PRESET_DATASETS: Array<{
  type: PresetDatasetType;
  title: string;
  subtitle: string;
}> = [
  { type: 'TWO_MOONS', title: 'Two Moons', subtitle: 'Non-convex interleaving crescents' },
  { type: 'GAUSSIAN_BLOBS', title: 'Gaussian Blobs', subtitle: 'Four well-separated isotropic clusters' },
  { type: 'CONCENTRIC_RINGS', title: 'Concentric Rings', subtitle: 'Nested inner ring and outer annulus' },
  { type: 'ANISOTROPIC', title: 'Anisotropic Streaks', subtitle: 'Elongated diagonal covariance clusters' },
  { type: 'SPIRAL_GALAXY', title: 'Twin Spirals', subtitle: 'Entangled spiral arms with background noise' },
  { type: 'NOISY_CLUSTERS', title: 'Dense + Outliers', subtitle: 'High-density cores with uniform scatter noise' },
];

export interface DataPoint {
  id: number;
  x: number; // Normalized world space [0, 1]
  y: number; // Normalized world space [0, 1]
  clusterId: number; // -1 = unassigned or noise
  role: PointRole;
}

export interface Coordinate {
  x: number;
  y: number;
}

export interface CentroidState {
  clusterId: number;
  x: number;
  y: number;
  trail: Coordinate[];
}

export interface ClusterAnnotation {
  id: number;
  clusterId: number; // >= 0 for a specific cluster, -1 for noise/unclustered canvas area
  x: number;
  y: number;
  text: string;
}

export interface KMeansConfig {
  k: number;
  useKMeansPlusPlus: boolean;
  maxIterations: number;
  showVoronoi: boolean;
  showTrails: boolean;
}

export interface DbscanConfig {
  epsilon: number;
  minPts: number;
  showEpsilonRings: boolean;
}

export interface ClusterSummary {
  clusterId: number;
  count: number;
  percentage: number;
  centroidX: number;
  centroidY: number;
  avgIntraDistance: number;
}

export interface ClusteringStepFrame {
  stepIndex: number;
  description: string;
  points: DataPoint[];
  centroids: CentroidState[];
  isConverged: boolean;
  wcss: number;
  silhouetteScore: number;
  noiseCount: number;
  coreCount: number;
  borderCount: number;
  clusterSummaries: ClusterSummary[];
}

export interface ClusteringSessionRun {
  runId: number;
  timestampMillis: number;
  datasetTitle: string;
  algorithm: AlgorithmType;
  kMeansConfig: KMeansConfig;
  dbscanConfig: DbscanConfig;
  rawPoints: DataPoint[];
  frames: ClusteringStepFrame[];
  inertiaWcss: number;
  silhouetteScore: number;
  clusterCount: number;
  noiseCount: number;
  randomSeed: number;
  annotations: ClusterAnnotation[];
}

export function formatSessionParameterSummary(
  algorithm: AlgorithmType,
  kMeansConfig: KMeansConfig,
  dbscanConfig: DbscanConfig
): string {
  return algorithm === 'KMEANS'
    ? `K-Means • K=${kMeansConfig.k}`
    : `DBSCAN • ε=${dbscanConfig.epsilon.toFixed(3)}`;
}

export function formatBatchParameterSummary(
  algorithm: AlgorithmType,
  kMeansConfig: KMeansConfig,
  dbscanConfig: DbscanConfig
): string {
  return algorithm === 'KMEANS'
    ? `K-Means • K=${kMeansConfig.k}`
    : `DBSCAN • ε=${dbscanConfig.epsilon.toFixed(3)} • MinPts=${dbscanConfig.minPts}`;
}

export type BatchJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface BatchQueueItem {
  jobId: number;
  datasetTitle: string;
  sourceLabel: string;
  algorithm: AlgorithmType;
  kMeansConfig: KMeansConfig;
  dbscanConfig: DbscanConfig;
  rawPoints: DataPoint[];
  status: BatchJobStatus;
  resultFrame: ClusteringStepFrame | null;
  durationMs: number;
  errorMessage: string | null;
  annotations: ClusterAnnotation[];
}

export interface BatchProcessingState {
  queue: BatchQueueItem[];
  isRunning: boolean;
  currentJobIndex: number;
  lastCombinedPdfFileName: string | null;
  lastCombinedPdfSizeLabel: string | null;
  lastCompletedAtLabel: string | null;
}

export interface SavedDatasetEntity {
  id: number;
  title: string;
  algorithm: AlgorithmType;
  pointCount: number;
  kValue: number;
  epsilonValue: number;
  minPtsValue: number;
  pointsSerialized: string;
  createdAt: number;
}

export interface LocalCsvFileInfo {
  fileName: string;
  pointCount: number;
  sizeBytes: number;
  lastModifiedMillis: number;
  content: string;
}

export interface LocalPdfReportInfo {
  fileName: string;
  sizeBytes: number;
  lastModifiedMillis: number;
  base64Data: string;
}

export interface StudioPreferences {
  isDarkTheme: boolean;
  showGrid: boolean;
  showSpiderLines: boolean;
  developerModeEnabled: boolean;
  hasCompletedOnboarding: boolean;
}

// Connect Node / Worker Types
export type ComputeBackend =
  | 'WEBGL_FP16'
  | 'WASM_SIMD'
  | 'JS_BASELINE';

export type WorkerRunState =
  | 'STOPPED'
  | 'PROBING'
  | 'RUNNING_USB'
  | 'RUNNING_WIFI'
  | 'THROTTLED_THERMAL'
  | 'SHEDDING_MEMORY';

export interface CalibrationProfile {
  isCalibrated: boolean;
  isCalibrating: boolean;
  calibratedAtLabel: string;
  performanceScore: number;
  tierLabel: string;
  recommendedSafeRamMb: number;
  recommendedThreads: number;
  recommendedBackendLabel: string;
  estimatedLayerCapacity: number;
  benchmarkDurationMs: number;
  summarySentence: string;
}

export type DiagnosticSeverity = 'OK' | 'WARNING' | 'ISSUE';

export type AutoFixAction =
  | 'AUTO_DETECT_MASTER'
  | 'RECALIBRATE_DEVICE'
  | 'START_SHARING'
  | 'SWITCH_TO_USB_SAFE_MODE'
  | 'FREE_MEMORY_AND_RESTART';

export interface DiagnosticCheck {
  id: string;
  title: string;
  statusText: string;
  plainEnglishTip: string;
  severity: DiagnosticSeverity;
  fixAction?: AutoFixAction;
}

export interface DiagnosticReport {
  overallStatus: DiagnosticSeverity;
  headline: string;
  subtext: string;
  checks: DiagnosticCheck[];
  ranAtLabel: string;
}

export interface DeviceTelemetryState {
  deviceModel: string;
  platformLabel: string;
  totalRamMb: number;
  availableRamMb: number;
  safeCapMb: number;
  bigCoreCount: number;
  totalCoreCount: number;
  cpuFeatures: string;
  webglProbePassed: boolean;
  webglRendererName: string;
  activeBackend: ComputeBackend;
  batteryPercent: number;
  isPluggedIn: boolean;
  temperatureCelsius: number;
  thermalStatusLabel: string;
  workerState: WorkerRunState;
  usbLoopbackOnly: boolean;
  bindAddress: string;
  clusterSecret: string;
  activeLayersAssigned: number;
  handshakesCompleted: number;
  lastTrimLevel: number;
  pairedMasterAddress: string;
  isScanningMaster: boolean;
  pairingQrPayload: string;
  calibration: CalibrationProfile;
  diagnosticReport: DiagnosticReport | null;
  isDiagnosing: boolean;
  developerModeEnabled: boolean;
  legacyHardwareMode: boolean;
  legacyGraphicsMode: boolean;
  graphicsTierLabel: string;
  authTokenHex: string;
  eventLogs: string[];
}
