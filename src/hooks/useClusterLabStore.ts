import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlgorithmType,
  BatchProcessingState,
  BatchQueueItem,
  CanvasToolMode,
  CentroidState,
  ClusterAnnotation,
  ClusteringSessionRun,
  ClusteringStepFrame,
  DataPoint,
  DbscanConfig,
  KMeansConfig,
  LocalCsvFileInfo,
  LocalPdfReportInfo,
  PRESET_DATASETS,
  PresetDatasetType,
  SavedDatasetEntity,
  StudioPreferences,
  formatBatchParameterSummary,
} from '../types/clustering';
import { computeDbscanFrames, computeKMeansFrames } from '../domain/clusteringEngine';
import {
  exportPointsToCsv,
  generatePresetDataset,
  parseRawTextToPoints,
} from '../domain/datasetGenerator';
import {
  deleteDatasetSnapshot,
  deleteLocalCsvFile,
  deleteLocalPdfReport,
  deserializePoints,
  formatBytes,
  formatDateTime,
  getLocalPdfBytes,
  importCsvFromLocalStorage,
  loadLocalCsvFiles,
  loadLocalPdfReports,
  loadPreferences,
  loadSavedSnapshots,
  sanitizeCsvFileName,
  saveCsvToLocalStorage,
  saveDatasetSnapshot,
  savePdfToLocalStorage,
  savePreferences,
  triggerFileDownload,
} from '../data/storage';
import {
  generateCombinedBatchPdfBytes,
  generateSinglePdfBytes,
} from '../data/pdfGenerator';

export interface ClusteringUiState {
  datasetTitle: string;
  selectedPreset: PresetDatasetType | null;
  sampleCount: number;
  noiseLevel: number;
  rawPoints: DataPoint[];
  algorithm: AlgorithmType;
  kMeansConfig: KMeansConfig;
  dbscanConfig: DbscanConfig;
  toolMode: CanvasToolMode;
  showGrid: boolean;
  showSpiderLines: boolean;
  isDarkTheme: boolean;
  developerModeEnabled: boolean;
  hasCompletedOnboarding: boolean;
  frames: ClusteringStepFrame[];
  currentFrameIndex: number;
  isPlaying: boolean;
  statusBanner: string | null;
  randomSeed: number;
  savedDatasets: SavedDatasetEntity[];
  localCsvFiles: LocalCsvFileInfo[];
  localPdfReports: LocalPdfReportInfo[];
  lastExportedPdfFileName: string | null;
  lastExportedPdfSizeLabel: string | null;
  sessionHistory: ClusteringSessionRun[];
  activeSessionRunId: number | null;
  annotations: ClusterAnnotation[];
  batchProcessing: BatchProcessingState;
  lastAddedPointId: number | null;
}

const DEFAULT_KMEANS_CONFIG: KMeansConfig = {
  k: 3,
  useKMeansPlusPlus: true,
  maxIterations: 25,
  showVoronoi: true,
  showTrails: true,
};

const DEFAULT_DBSCAN_CONFIG: DbscanConfig = {
  epsilon: 0.085,
  minPts: 4,
  showEpsilonRings: true,
};

function computeFramesFor(
  points: DataPoint[],
  algorithm: AlgorithmType,
  kMeansConfig: KMeansConfig,
  dbscanConfig: DbscanConfig,
  seed: number
): ClusteringStepFrame[] {
  return algorithm === 'KMEANS'
    ? computeKMeansFrames(points, kMeansConfig, seed)
    : computeDbscanFrames(points, dbscanConfig);
}

function buildInitialState(): ClusteringUiState {
  const prefs: StudioPreferences = loadPreferences();
  const initialPoints = generatePresetDataset('TWO_MOONS', 160, 0.035, 42);
  const initialFrames = computeKMeansFrames(initialPoints, DEFAULT_KMEANS_CONFIG, 42);
  const lastFrameIdx = Math.max(0, initialFrames.length - 1);
  const finalFrame = initialFrames[lastFrameIdx] ?? null;

  const firstRun: ClusteringSessionRun | null = finalFrame
    ? {
        runId: 1,
        timestampMillis: Date.now(),
        datasetTitle: 'Two Moons',
        algorithm: 'KMEANS',
        kMeansConfig: DEFAULT_KMEANS_CONFIG,
        dbscanConfig: DEFAULT_DBSCAN_CONFIG,
        rawPoints: initialPoints,
        frames: initialFrames,
        inertiaWcss: finalFrame.wcss,
        silhouetteScore: finalFrame.silhouetteScore,
        clusterCount: finalFrame.clusterSummaries.length,
        noiseCount: finalFrame.noiseCount,
        randomSeed: 42,
        annotations: [],
      }
    : null;

  return {
    datasetTitle: 'Two Moons',
    selectedPreset: 'TWO_MOONS',
    sampleCount: 160,
    noiseLevel: 0.035,
    rawPoints: initialPoints,
    algorithm: 'KMEANS',
    kMeansConfig: DEFAULT_KMEANS_CONFIG,
    dbscanConfig: DEFAULT_DBSCAN_CONFIG,
    toolMode: 'ADD',
    showGrid: prefs.showGrid,
    showSpiderLines: prefs.showSpiderLines,
    isDarkTheme: prefs.isDarkTheme,
    developerModeEnabled: prefs.developerModeEnabled,
    hasCompletedOnboarding: prefs.hasCompletedOnboarding,
    frames: initialFrames,
    currentFrameIndex: lastFrameIdx,
    isPlaying: false,
    statusBanner: null,
    randomSeed: 42,
    savedDatasets: loadSavedSnapshots(),
    localCsvFiles: loadLocalCsvFiles(),
    localPdfReports: loadLocalPdfReports(),
    lastExportedPdfFileName: null,
    lastExportedPdfSizeLabel: null,
    sessionHistory: firstRun ? [firstRun] : [],
    activeSessionRunId: firstRun ? 1 : null,
    annotations: [],
    batchProcessing: {
      queue: [],
      isRunning: false,
      currentJobIndex: -1,
      lastCombinedPdfFileName: null,
      lastCombinedPdfSizeLabel: null,
      lastCompletedAtLabel: null,
    },
    lastAddedPointId: null,
  };
}

function recordSessionRun(
  prev: ClusteringUiState,
  frames: ClusteringStepFrame[],
  rawPoints: DataPoint[],
  datasetTitle: string,
  algorithm: AlgorithmType,
  kMeansConfig: KMeansConfig,
  dbscanConfig: DbscanConfig,
  randomSeed: number,
  annotations: ClusterAnnotation[]
): {
  sessionHistory: ClusteringSessionRun[];
  activeSessionRunId: number | null;
} {
  if (rawPoints.length === 0 || frames.length === 0) {
    return {
      sessionHistory: prev.sessionHistory,
      activeSessionRunId: prev.activeSessionRunId,
    };
  }
  const finalFrame = frames[frames.length - 1];
  const latest = prev.sessionHistory[0];
  const isDuplicate =
    latest &&
    latest.algorithm === algorithm &&
    latest.datasetTitle === datasetTitle &&
    latest.rawPoints.length === rawPoints.length &&
    latest.kMeansConfig.k === kMeansConfig.k &&
    Math.abs(latest.dbscanConfig.epsilon - dbscanConfig.epsilon) < 1e-4 &&
    latest.dbscanConfig.minPts === dbscanConfig.minPts &&
    latest.randomSeed === randomSeed &&
    Math.abs(latest.inertiaWcss - finalFrame.wcss) < 0.00005;

  if (isDuplicate) {
    return {
      sessionHistory: prev.sessionHistory,
      activeSessionRunId: latest.runId,
    };
  }

  const nextRunId =
    (prev.sessionHistory.reduce((acc, r) => Math.max(acc, r.runId), 0) || 0) + 1;

  const newRun: ClusteringSessionRun = {
    runId: nextRunId,
    timestampMillis: Date.now(),
    datasetTitle,
    algorithm,
    kMeansConfig,
    dbscanConfig,
    rawPoints,
    frames,
    inertiaWcss: finalFrame.wcss,
    silhouetteScore: finalFrame.silhouetteScore,
    clusterCount: finalFrame.clusterSummaries.length,
    noiseCount: finalFrame.noiseCount,
    randomSeed,
    annotations,
  };

  return {
    sessionHistory: [newRun, ...prev.sessionHistory].slice(0, 10),
    activeSessionRunId: nextRunId,
  };
}

export function useClusterLabStore() {
  const [state, setState] = useState<ClusteringUiState>(() => buildInitialState());
  const nextPointIdRef = useRef<number>(10000);
  const nextAnnotationIdRef = useRef<number>(1);
  const nextBatchJobIdRef = useRef<number>(1);

  const [pdfPreviewState, setPdfPreviewState] = useState<{
    fileName: string;
    bytes: Uint8Array;
  } | null>(null);

  // Sync Tailwind dark class and preferences
  useEffect(() => {
    document.documentElement.classList.toggle('dark', state.isDarkTheme);
    savePreferences({
      isDarkTheme: state.isDarkTheme,
      showGrid: state.showGrid,
      showSpiderLines: state.showSpiderLines,
      developerModeEnabled: state.developerModeEnabled,
      hasCompletedOnboarding: state.hasCompletedOnboarding,
    });
  }, [
    state.isDarkTheme,
    state.showGrid,
    state.showSpiderLines,
    state.developerModeEnabled,
    state.hasCompletedOnboarding,
  ]);

  // Playback loop (640ms interval)
  useEffect(() => {
    if (!state.isPlaying) return;
    const timer = window.setInterval(() => {
      setState((prev) => {
        if (!prev.isPlaying) return prev;
        if (prev.currentFrameIndex >= prev.frames.length - 1) {
          return { ...prev, isPlaying: false };
        }
        const nextIdx = prev.currentFrameIndex + 1;
        const reachedEnd = nextIdx >= prev.frames.length - 1;
        return {
          ...prev,
          currentFrameIndex: nextIdx,
          isPlaying: !reachedEnd,
        };
      });
    }, 640);
    return () => window.clearInterval(timer);
  }, [state.isPlaying]);

  const currentFrame: ClusteringStepFrame | null = useMemo(() => {
    if (state.frames.length === 0) return null;
    const idx = Math.max(0, Math.min(state.currentFrameIndex, state.frames.length - 1));
    return state.frames[idx];
  }, [state.frames, state.currentFrameIndex]);

  const dismissBanner = useCallback(() => {
    setState((prev) => ({ ...prev, statusBanner: null }));
  }, []);

  const setBanner = useCallback((msg: string) => {
    setState((prev) => ({ ...prev, statusBanner: msg }));
  }, []);

  const selectAlgorithm = useCallback((algorithm: AlgorithmType) => {
    setState((prev) => {
      const frames = computeFramesFor(
        prev.rawPoints,
        algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      const finalIdx = Math.max(0, frames.length - 1);
      const recorded = recordSessionRun(
        prev,
        frames,
        prev.rawPoints,
        prev.datasetTitle,
        algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed,
        prev.annotations
      );
      return {
        ...prev,
        algorithm,
        frames,
        currentFrameIndex: finalIdx,
        isPlaying: false,
        ...recorded,
      };
    });
  }, []);

  const updateK = useCallback((k: number) => {
    const clampedK = Math.max(2, Math.min(10, Math.round(k)));
    setState((prev) => {
      const kMeansConfig = { ...prev.kMeansConfig, k: clampedK };
      const frames =
        prev.algorithm === 'KMEANS'
          ? computeKMeansFrames(prev.rawPoints, kMeansConfig, prev.randomSeed)
          : prev.frames;
      const finalIdx = prev.algorithm === 'KMEANS' ? Math.max(0, frames.length - 1) : prev.currentFrameIndex;
      const recorded =
        prev.algorithm === 'KMEANS'
          ? recordSessionRun(
              prev,
              frames,
              prev.rawPoints,
              prev.datasetTitle,
              prev.algorithm,
              kMeansConfig,
              prev.dbscanConfig,
              prev.randomSeed,
              prev.annotations
            )
          : { sessionHistory: prev.sessionHistory, activeSessionRunId: prev.activeSessionRunId };
      return {
        ...prev,
        kMeansConfig,
        frames,
        currentFrameIndex: finalIdx,
        isPlaying: false,
        ...recorded,
      };
    });
  }, []);

  const toggleKMeansPlusPlus = useCallback((usePlusPlus: boolean) => {
    setState((prev) => {
      const kMeansConfig = { ...prev.kMeansConfig, useKMeansPlusPlus: usePlusPlus };
      const frames =
        prev.algorithm === 'KMEANS'
          ? computeKMeansFrames(prev.rawPoints, kMeansConfig, prev.randomSeed)
          : prev.frames;
      return {
        ...prev,
        kMeansConfig,
        frames,
        currentFrameIndex: prev.algorithm === 'KMEANS' ? Math.max(0, frames.length - 1) : prev.currentFrameIndex,
        isPlaying: false,
      };
    });
  }, []);

  const toggleShowVoronoi = useCallback((showVoronoi: boolean) => {
    setState((prev) => ({
      ...prev,
      kMeansConfig: { ...prev.kMeansConfig, showVoronoi },
    }));
  }, []);

  const toggleShowTrails = useCallback((showTrails: boolean) => {
    setState((prev) => ({
      ...prev,
      kMeansConfig: { ...prev.kMeansConfig, showTrails },
    }));
  }, []);

  const updateEpsilon = useCallback((epsilon: number) => {
    const clamped = Math.max(0.025, Math.min(0.22, epsilon));
    setState((prev) => {
      const dbscanConfig = { ...prev.dbscanConfig, epsilon: clamped };
      const frames =
        prev.algorithm === 'DBSCAN'
          ? computeDbscanFrames(prev.rawPoints, dbscanConfig)
          : prev.frames;
      const finalIdx = prev.algorithm === 'DBSCAN' ? Math.max(0, frames.length - 1) : prev.currentFrameIndex;
      const recorded =
        prev.algorithm === 'DBSCAN'
          ? recordSessionRun(
              prev,
              frames,
              prev.rawPoints,
              prev.datasetTitle,
              prev.algorithm,
              prev.kMeansConfig,
              dbscanConfig,
              prev.randomSeed,
              prev.annotations
            )
          : { sessionHistory: prev.sessionHistory, activeSessionRunId: prev.activeSessionRunId };
      return {
        ...prev,
        dbscanConfig,
        frames,
        currentFrameIndex: finalIdx,
        isPlaying: false,
        ...recorded,
      };
    });
  }, []);

  const updateMinPts = useCallback((minPts: number) => {
    const clamped = Math.max(2, Math.min(15, Math.round(minPts)));
    setState((prev) => {
      const dbscanConfig = { ...prev.dbscanConfig, minPts: clamped };
      const frames =
        prev.algorithm === 'DBSCAN'
          ? computeDbscanFrames(prev.rawPoints, dbscanConfig)
          : prev.frames;
      const finalIdx = prev.algorithm === 'DBSCAN' ? Math.max(0, frames.length - 1) : prev.currentFrameIndex;
      const recorded =
        prev.algorithm === 'DBSCAN'
          ? recordSessionRun(
              prev,
              frames,
              prev.rawPoints,
              prev.datasetTitle,
              prev.algorithm,
              prev.kMeansConfig,
              dbscanConfig,
              prev.randomSeed,
              prev.annotations
            )
          : { sessionHistory: prev.sessionHistory, activeSessionRunId: prev.activeSessionRunId };
      return {
        ...prev,
        dbscanConfig,
        frames,
        currentFrameIndex: finalIdx,
        isPlaying: false,
        ...recorded,
      };
    });
  }, []);

  const toggleEpsilonRings = useCallback((showEpsilonRings: boolean) => {
    setState((prev) => ({
      ...prev,
      dbscanConfig: { ...prev.dbscanConfig, showEpsilonRings },
    }));
  }, []);

  const selectToolMode = useCallback((toolMode: CanvasToolMode) => {
    setState((prev) => ({ ...prev, toolMode }));
  }, []);

  const toggleGrid = useCallback(() => {
    setState((prev) => ({ ...prev, showGrid: !prev.showGrid }));
  }, []);

  const toggleSpiderLines = useCallback(() => {
    setState((prev) => ({ ...prev, showSpiderLines: !prev.showSpiderLines }));
  }, []);

  const toggleDarkTheme = useCallback(() => {
    setState((prev) => ({ ...prev, isDarkTheme: !prev.isDarkTheme }));
  }, []);

  const toggleDeveloperMode = useCallback((enabled: boolean) => {
    setState((prev) => ({
      ...prev,
      developerModeEnabled: enabled,
      toolMode:
        !enabled && (prev.toolMode === 'BRUSH' || prev.toolMode === 'PAN')
          ? 'ADD'
          : prev.toolMode,
      statusBanner: enabled
        ? 'Developer Mode enabled: step-by-step playback, metrics inspector & local CSV storage unlocked.'
        : 'Developer Mode disabled: Studio returned to clean exploration view.',
    }));
  }, []);

  const completeOnboarding = useCallback(() => {
    setState((prev) => ({ ...prev, hasCompletedOnboarding: true }));
  }, []);

  const restartOnboarding = useCallback(() => {
    setState((prev) => ({ ...prev, hasCompletedOnboarding: false }));
  }, []);

  const selectPreset = useCallback((type: PresetDatasetType) => {
    const presetMeta = PRESET_DATASETS.find((p) => p.type === type);
    const title = presetMeta?.title ?? 'Preset Dataset';
    setState((prev) => {
      const points = generatePresetDataset(type, prev.sampleCount, prev.noiseLevel, prev.randomSeed);
      const frames = computeFramesFor(
        points,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      const finalIdx = Math.max(0, frames.length - 1);
      const recorded = recordSessionRun(
        prev,
        frames,
        points,
        title,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed,
        []
      );
      return {
        ...prev,
        datasetTitle: title,
        selectedPreset: type,
        rawPoints: points,
        frames,
        currentFrameIndex: finalIdx,
        isPlaying: false,
        annotations: [],
        lastAddedPointId: null,
        ...recorded,
      };
    });
  }, []);

  const updateSampleCount = useCallback((count: number) => {
    const clamped = Math.max(50, Math.min(300, Math.round(count)));
    setState((prev) => {
      if (!prev.selectedPreset) return { ...prev, sampleCount: clamped };
      const points = generatePresetDataset(
        prev.selectedPreset,
        clamped,
        prev.noiseLevel,
        prev.randomSeed
      );
      const frames = computeFramesFor(
        points,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      return {
        ...prev,
        sampleCount: clamped,
        rawPoints: points,
        frames,
        currentFrameIndex: Math.max(0, frames.length - 1),
        isPlaying: false,
      };
    });
  }, []);

  const updateNoiseLevel = useCallback((noiseLevel: number) => {
    const clamped = Math.max(0.012, Math.min(0.08, noiseLevel));
    setState((prev) => {
      if (!prev.selectedPreset) return { ...prev, noiseLevel: clamped };
      const points = generatePresetDataset(
        prev.selectedPreset,
        prev.sampleCount,
        clamped,
        prev.randomSeed
      );
      const frames = computeFramesFor(
        points,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      return {
        ...prev,
        noiseLevel: clamped,
        rawPoints: points,
        frames,
        currentFrameIndex: Math.max(0, frames.length - 1),
        isPlaying: false,
      };
    });
  }, []);

  const addPoint = useCallback((wx: number, wy: number) => {
    const cx = Math.max(0.02, Math.min(0.98, wx));
    const cy = Math.max(0.02, Math.min(0.98, wy));
    const id = nextPointIdRef.current++;
    setState((prev) => {
      const nextPoints: DataPoint[] = [
        ...prev.rawPoints,
        { id, x: cx, y: cy, clusterId: -1, role: 'STANDARD' },
      ];
      const frames = computeFramesFor(
        nextPoints,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      return {
        ...prev,
        rawPoints: nextPoints,
        selectedPreset: null,
        frames,
        currentFrameIndex: Math.max(0, frames.length - 1),
        isPlaying: false,
        lastAddedPointId: id,
      };
    });
  }, []);

  const erasePointsNear = useCallback((wx: number, wy: number, radius = 0.055) => {
    setState((prev) => {
      const r2 = radius * radius;
      const filtered = prev.rawPoints.filter((p) => {
        const dx = p.x - wx;
        const dy = p.y - wy;
        return dx * dx + dy * dy > r2;
      });
      if (filtered.length === prev.rawPoints.length) return prev;
      const frames = computeFramesFor(
        filtered,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      return {
        ...prev,
        rawPoints: filtered,
        selectedPreset: null,
        frames,
        currentFrameIndex: Math.max(0, frames.length - 1),
        isPlaying: false,
      };
    });
  }, []);

  const clearCanvas = useCallback(() => {
    setState((prev) => ({
      ...prev,
      rawPoints: [],
      datasetTitle: 'Custom Canvas',
      selectedPreset: null,
      frames: computeFramesFor([], prev.algorithm, prev.kMeansConfig, prev.dbscanConfig, prev.randomSeed),
      currentFrameIndex: 0,
      isPlaying: false,
      annotations: [],
      lastAddedPointId: null,
      statusBanner: 'Canvas cleared. Tap anywhere on the plot to add data points.',
    }));
  }, []);

  const runClusteringAnimated = useCallback(() => {
    setState((prev) => {
      if (prev.rawPoints.length === 0) {
        return { ...prev, statusBanner: 'Add points to the canvas before running clustering.' };
      }
      const nextSeed = prev.algorithm === 'KMEANS' ? prev.randomSeed + 1 : prev.randomSeed;
      const frames = computeFramesFor(
        prev.rawPoints,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        nextSeed
      );
      const recorded = recordSessionRun(
        prev,
        frames,
        prev.rawPoints,
        prev.datasetTitle,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        nextSeed,
        prev.annotations
      );
      return {
        ...prev,
        randomSeed: nextSeed,
        frames,
        currentFrameIndex: 0,
        isPlaying: frames.length > 1,
        ...recorded,
      };
    });
  }, []);

  const togglePlayPause = useCallback(() => {
    setState((prev) => {
      if (prev.frames.length <= 1) return prev;
      if (prev.isPlaying) return { ...prev, isPlaying: false };
      const restart = prev.currentFrameIndex >= prev.frames.length - 1;
      return {
        ...prev,
        currentFrameIndex: restart ? 0 : prev.currentFrameIndex,
        isPlaying: true,
      };
    });
  }, []);

  const stepForward = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isPlaying: false,
      currentFrameIndex: Math.min(prev.frames.length - 1, prev.currentFrameIndex + 1),
    }));
  }, []);

  const resetToStart = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isPlaying: false,
      currentFrameIndex: 0,
    }));
  }, []);

  const jumpToConverged = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isPlaying: false,
      currentFrameIndex: Math.max(0, prev.frames.length - 1),
    }));
  }, []);

  // Annotations CRUD
  const addOrUpdateAnnotation = useCallback(
    (clusterId: number, x: number, y: number, text: string, existingId?: number) => {
      const clean = text.trim().slice(0, 120);
      if (!clean) return;
      setState((prev) => {
        let updatedAnnotations: ClusterAnnotation[];
        if (existingId !== undefined) {
          updatedAnnotations = prev.annotations.map((a) =>
            a.id === existingId ? { ...a, text: clean, clusterId, x, y } : a
          );
        } else {
          const newId = nextAnnotationIdRef.current++;
          updatedAnnotations = [
            ...prev.annotations,
            { id: newId, clusterId, x, y, text: clean },
          ];
        }
        const updatedHistory = prev.sessionHistory.map((r) =>
          r.runId === prev.activeSessionRunId ? { ...r, annotations: updatedAnnotations } : r
        );
        return {
          ...prev,
          annotations: updatedAnnotations,
          sessionHistory: updatedHistory,
          statusBanner: `Saved annotation for ${clusterId >= 0 ? `Cluster ${clusterId + 1}` : 'Canvas Note'}.`,
        };
      });
    },
    []
  );

  const deleteAnnotation = useCallback((id: number) => {
    setState((prev) => {
      const updatedAnnotations = prev.annotations.filter((a) => a.id !== id);
      const updatedHistory = prev.sessionHistory.map((r) =>
        r.runId === prev.activeSessionRunId ? { ...r, annotations: updatedAnnotations } : r
      );
      return {
        ...prev,
        annotations: updatedAnnotations,
        sessionHistory: updatedHistory,
      };
    });
  }, []);

  const clearAnnotations = useCallback(() => {
    setState((prev) => {
      const updatedHistory = prev.sessionHistory.map((r) =>
        r.runId === prev.activeSessionRunId ? { ...r, annotations: [] } : r
      );
      return {
        ...prev,
        annotations: [],
        sessionHistory: updatedHistory,
      };
    });
  }, []);

  // Session History
  const restoreSessionRun = useCallback((runId: number) => {
    setState((prev) => {
      const match = prev.sessionHistory.find((r) => r.runId === runId);
      if (!match) return prev;
      const matchedPreset =
        PRESET_DATASETS.find((p) => p.title === match.datasetTitle)?.type ?? null;
      return {
        ...prev,
        datasetTitle: match.datasetTitle,
        selectedPreset: matchedPreset,
        rawPoints: match.rawPoints,
        algorithm: match.algorithm,
        kMeansConfig: match.kMeansConfig,
        dbscanConfig: match.dbscanConfig,
        randomSeed: match.randomSeed,
        frames: match.frames,
        currentFrameIndex: Math.max(0, match.frames.length - 1),
        isPlaying: false,
        annotations: match.annotations,
        activeSessionRunId: match.runId,
        statusBanner: `Restored Run #${match.runId}: ${match.datasetTitle}`,
      };
    });
  }, []);

  const clearSessionHistory = useCallback(() => {
    setState((prev) => ({
      ...prev,
      sessionHistory: [],
      activeSessionRunId: null,
      statusBanner: 'Cleared session history.',
    }));
  }, []);

  // Snapshots & Paste / File Import / CSV
  const importPastedText = useCallback((title: string, rawText: string): boolean => {
    const parsed = parseRawTextToPoints(rawText);
    if (parsed.length === 0) {
      setState((prev) => ({
        ...prev,
        statusBanner: 'Could not find valid numeric (x, y) coordinates in the provided input.',
      }));
      return false;
    }
    const cleanTitle = title.trim() || 'Imported Dataset';
    setState((prev) => {
      const frames = computeFramesFor(
        parsed,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      const recorded = recordSessionRun(
        prev,
        frames,
        parsed,
        cleanTitle,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed,
        []
      );
      return {
        ...prev,
        datasetTitle: cleanTitle,
        selectedPreset: null,
        rawPoints: parsed,
        frames,
        currentFrameIndex: Math.max(0, frames.length - 1),
        isPlaying: false,
        annotations: [],
        statusBanner: `Loaded ${parsed.length} points from "${cleanTitle}".`,
        ...recorded,
      };
    });
    return true;
  }, []);

  const saveSnapshot = useCallback((title: string) => {
    const cleanTitle = title.trim() || 'Dataset Snapshot';
    setState((prev) => {
      const updated = saveDatasetSnapshot({
        title: cleanTitle,
        algorithm: prev.algorithm,
        points: prev.rawPoints,
        kValue: prev.kMeansConfig.k,
        epsilonValue: prev.dbscanConfig.epsilon,
        minPtsValue: prev.dbscanConfig.minPts,
      });
      return {
        ...prev,
        savedDatasets: updated,
        statusBanner: `Saved snapshot "${cleanTitle}" (${prev.rawPoints.length} pts).`,
      };
    });
  }, []);

  const loadSnapshot = useCallback((entity: SavedDatasetEntity) => {
    const pts = deserializePoints(entity.pointsSerialized);
    setState((prev) => {
      const kMeansConfig = { ...prev.kMeansConfig, k: entity.kValue };
      const dbscanConfig = {
        ...prev.dbscanConfig,
        epsilon: entity.epsilonValue,
        minPts: entity.minPtsValue,
      };
      const frames = computeFramesFor(
        pts,
        entity.algorithm,
        kMeansConfig,
        dbscanConfig,
        prev.randomSeed
      );
      const recorded = recordSessionRun(
        prev,
        frames,
        pts,
        entity.title,
        entity.algorithm,
        kMeansConfig,
        dbscanConfig,
        prev.randomSeed,
        []
      );
      return {
        ...prev,
        datasetTitle: entity.title,
        selectedPreset: null,
        algorithm: entity.algorithm,
        kMeansConfig,
        dbscanConfig,
        rawPoints: pts,
        frames,
        currentFrameIndex: Math.max(0, frames.length - 1),
        isPlaying: false,
        annotations: [],
        statusBanner: `Loaded snapshot "${entity.title}" (${pts.length} pts).`,
        ...recorded,
      };
    });
  }, []);

  const deleteSnapshot = useCallback((id: number) => {
    setState((prev) => ({
      ...prev,
      savedDatasets: deleteDatasetSnapshot(id),
    }));
  }, []);

  const exportCurrentCsvDownload = useCallback(() => {
    const frame = currentFrame;
    const pts = frame?.points ?? state.rawPoints;
    const centroids: CentroidState[] = frame?.centroids ?? [];
    const csv = exportPointsToCsv(pts, centroids, state.datasetTitle);
    const fileName = sanitizeCsvFileName(state.datasetTitle);
    triggerFileDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileName);
    setBanner(`Downloaded CSV "${fileName}" (${pts.length} pts).`);
  }, [currentFrame, state.rawPoints, state.datasetTitle, setBanner]);

  const saveCsvLocally = useCallback(
    (desiredName: string) => {
      const frame = currentFrame;
      const pts = frame?.points ?? state.rawPoints;
      const centroids = frame?.centroids ?? [];
      const { info, allFiles } = saveCsvToLocalStorage(desiredName, pts, centroids);
      setState((prev) => ({
        ...prev,
        localCsvFiles: allFiles,
        statusBanner: `Saved "${info.fileName}" (${info.pointCount} pts) to browser storage.`,
      }));
    },
    [currentFrame, state.rawPoints]
  );

  const importCsvFromStorage = useCallback((fileName: string) => {
    const res = importCsvFromLocalStorage(fileName);
    if (!res || res.points.length === 0) return;
    const title = res.fileName.replace(/\.csv$/i, '').replace(/_/g, ' ');
    setState((prev) => {
      const frames = computeFramesFor(
        res.points,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed
      );
      const recorded = recordSessionRun(
        prev,
        frames,
        res.points,
        title,
        prev.algorithm,
        prev.kMeansConfig,
        prev.dbscanConfig,
        prev.randomSeed,
        []
      );
      return {
        ...prev,
        datasetTitle: title,
        selectedPreset: null,
        rawPoints: res.points,
        frames,
        currentFrameIndex: Math.max(0, frames.length - 1),
        isPlaying: false,
        annotations: [],
        statusBanner: `Imported ${res.points.length} points from ${res.fileName}.`,
        ...recorded,
      };
    });
  }, []);

  const deleteCsvFromStorage = useCallback((fileName: string) => {
    setState((prev) => ({
      ...prev,
      localCsvFiles: deleteLocalCsvFile(fileName),
    }));
  }, []);

  const downloadCsvFromStorage = useCallback(
    (file: LocalCsvFileInfo) => {
      triggerFileDownload(new Blob([file.content], { type: 'text/csv;charset=utf-8' }), file.fileName);
      setBanner(`Downloaded ${file.fileName}.`);
    },
    [setBanner]
  );

  const shareCsvText = useCallback(
    async (file: LocalCsvFileInfo) => {
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(file.content);
          setBanner(`Copied ${file.fileName} CSV contents to clipboard.`);
          return;
        }
      } catch {
        // Fallback to download
      }
      triggerFileDownload(new Blob([file.content], { type: 'text/csv;charset=utf-8' }), file.fileName);
      setBanner(`Downloaded ${file.fileName}.`);
    },
    [setBanner]
  );

  // PDF Reports
  const generateAndSaveSinglePdf = useCallback(
    (openPreview = true) => {
      const frame = currentFrame;
      const bytes = generateSinglePdfBytes({
        datasetTitle: state.datasetTitle,
        algorithm: state.algorithm,
        kMeansConfig: state.kMeansConfig,
        dbscanConfig: state.dbscanConfig,
        points: frame?.points ?? state.rawPoints,
        centroids: frame?.centroids ?? [],
        frame,
        showVoronoi: state.kMeansConfig.showVoronoi,
        showTrails: state.kMeansConfig.showTrails,
        showSpiderLines: state.showSpiderLines,
        showEpsilonRings: state.dbscanConfig.showEpsilonRings,
        annotations: state.annotations,
      });
      const { info, allReports } = savePdfToLocalStorage(
        `${state.datasetTitle}_${state.algorithm.toLowerCase()}`,
        bytes
      );
      setState((prev) => ({
        ...prev,
        localPdfReports: allReports,
        lastExportedPdfFileName: info.fileName,
        lastExportedPdfSizeLabel: formatBytes(info.sizeBytes),
        statusBanner: `Generated PDF report "${info.fileName}" (${formatBytes(info.sizeBytes)}).`,
      }));
      if (openPreview) {
        setPdfPreviewState({ fileName: info.fileName, bytes });
      }
    },
    [
      currentFrame,
      state.datasetTitle,
      state.algorithm,
      state.kMeansConfig,
      state.dbscanConfig,
      state.rawPoints,
      state.showSpiderLines,
      state.annotations,
    ]
  );

  const openSavedPdfPreview = useCallback((fileName: string) => {
    const bytes = getLocalPdfBytes(fileName);
    if (!bytes) return;
    setPdfPreviewState({ fileName, bytes });
  }, []);

  const downloadSavedPdf = useCallback((fileName: string) => {
    const bytes = getLocalPdfBytes(fileName);
    if (!bytes) return;
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    triggerFileDownload(new Blob([copy], { type: 'application/pdf' }), fileName);
  }, []);

  const deleteSavedPdf = useCallback((fileName: string) => {
    setState((prev) => ({
      ...prev,
      localPdfReports: deleteLocalPdfReport(fileName),
    }));
  }, []);

  // Batch Queue
  const enqueueCurrentCanvasToBatch = useCallback(() => {
    setState((prev) => {
      if (prev.rawPoints.length === 0) {
        return { ...prev, statusBanner: 'Add points on the canvas before adding to the batch queue.' };
      }
      const item: BatchQueueItem = {
        jobId: nextBatchJobIdRef.current++,
        datasetTitle: prev.datasetTitle,
        sourceLabel: 'Canvas',
        algorithm: prev.algorithm,
        kMeansConfig: prev.kMeansConfig,
        dbscanConfig: prev.dbscanConfig,
        rawPoints: prev.rawPoints,
        status: 'QUEUED',
        resultFrame: null,
        durationMs: 0,
        errorMessage: null,
        annotations: prev.annotations,
      };
      return {
        ...prev,
        batchProcessing: {
          ...prev.batchProcessing,
          queue: [...prev.batchProcessing.queue, item],
        },
        statusBanner: `Queued "${prev.datasetTitle}" (${formatBatchParameterSummary(prev.algorithm, prev.kMeansConfig, prev.dbscanConfig)}) for batch run.`,
      };
    });
  }, []);

  const enqueuePresetToBatch = useCallback((type: PresetDatasetType) => {
    const meta = PRESET_DATASETS.find((p) => p.type === type);
    const title = meta?.title ?? 'Preset';
    setState((prev) => {
      const pts = generatePresetDataset(type, prev.sampleCount, prev.noiseLevel, prev.randomSeed);
      const item: BatchQueueItem = {
        jobId: nextBatchJobIdRef.current++,
        datasetTitle: title,
        sourceLabel: 'Preset',
        algorithm: prev.algorithm,
        kMeansConfig: prev.kMeansConfig,
        dbscanConfig: prev.dbscanConfig,
        rawPoints: pts,
        status: 'QUEUED',
        resultFrame: null,
        durationMs: 0,
        errorMessage: null,
        annotations: [],
      };
      return {
        ...prev,
        batchProcessing: {
          ...prev.batchProcessing,
          queue: [...prev.batchProcessing.queue, item],
        },
      };
    });
  }, []);

  const enqueueSavedSnapshotToBatch = useCallback((entity: SavedDatasetEntity) => {
    const pts = deserializePoints(entity.pointsSerialized);
    if (pts.length === 0) return;
    setState((prev) => {
      const kCfg = { ...prev.kMeansConfig, k: entity.kValue };
      const dCfg = { ...prev.dbscanConfig, epsilon: entity.epsilonValue, minPts: entity.minPtsValue };
      const item: BatchQueueItem = {
        jobId: nextBatchJobIdRef.current++,
        datasetTitle: entity.title,
        sourceLabel: 'Snapshot',
        algorithm: entity.algorithm,
        kMeansConfig: kCfg,
        dbscanConfig: dCfg,
        rawPoints: pts,
        status: 'QUEUED',
        resultFrame: null,
        durationMs: 0,
        errorMessage: null,
        annotations: [],
      };
      return {
        ...prev,
        batchProcessing: {
          ...prev.batchProcessing,
          queue: [...prev.batchProcessing.queue, item],
        },
      };
    });
  }, []);

  const enqueueBenchmarkSuite = useCallback(() => {
    setState((prev) => {
      const suite: Array<{ type: PresetDatasetType; algo: AlgorithmType; k?: number; eps?: number }> = [
        { type: 'TWO_MOONS', algo: 'DBSCAN', eps: 0.085 },
        { type: 'GAUSSIAN_BLOBS', algo: 'KMEANS', k: 4 },
        { type: 'CONCENTRIC_RINGS', algo: 'DBSCAN', eps: 0.08 },
      ];
      const added: BatchQueueItem[] = suite.map((spec) => {
        const meta = PRESET_DATASETS.find((p) => p.type === spec.type);
        const pts = generatePresetDataset(spec.type, prev.sampleCount, prev.noiseLevel, prev.randomSeed);
        return {
          jobId: nextBatchJobIdRef.current++,
          datasetTitle: meta?.title ?? spec.type,
          sourceLabel: 'Benchmark',
          algorithm: spec.algo,
          kMeansConfig: { ...prev.kMeansConfig, k: spec.k ?? prev.kMeansConfig.k },
          dbscanConfig: { ...prev.dbscanConfig, epsilon: spec.eps ?? prev.dbscanConfig.epsilon },
          rawPoints: pts,
          status: 'QUEUED',
          resultFrame: null,
          durationMs: 0,
          errorMessage: null,
          annotations: [],
        };
      });
      return {
        ...prev,
        batchProcessing: {
          ...prev.batchProcessing,
          queue: [...prev.batchProcessing.queue, ...added],
        },
        statusBanner: 'Added 3-run Benchmark Suite (Two Moons DBSCAN, Blobs K-Means, Rings DBSCAN).',
      };
    });
  }, []);

  const removeBatchJob = useCallback((jobId: number) => {
    setState((prev) => ({
      ...prev,
      batchProcessing: {
        ...prev.batchProcessing,
        queue: prev.batchProcessing.queue.filter((j) => j.jobId !== jobId),
      },
    }));
  }, []);

  const clearBatchQueue = useCallback(() => {
    setState((prev) => ({
      ...prev,
      batchProcessing: {
        ...prev.batchProcessing,
        queue: [],
        isRunning: false,
        currentJobIndex: -1,
      },
    }));
  }, []);

  const inspectBatchJobOnCanvas = useCallback((job: BatchQueueItem) => {
    if (!job.resultFrame) return;
    const frames = computeFramesFor(
      job.rawPoints,
      job.algorithm,
      job.kMeansConfig,
      job.dbscanConfig,
      42
    );
    setState((prev) => ({
      ...prev,
      datasetTitle: job.datasetTitle,
      selectedPreset: null,
      algorithm: job.algorithm,
      kMeansConfig: job.kMeansConfig,
      dbscanConfig: job.dbscanConfig,
      rawPoints: job.rawPoints,
      frames,
      currentFrameIndex: Math.max(0, frames.length - 1),
      isPlaying: false,
      annotations: job.annotations,
      statusBanner: `Inspecting batch job "${job.datasetTitle}" on canvas.`,
    }));
  }, []);

  const runBatchAndGeneratePdf = useCallback(
    async (batchTitle = 'ClusterLab Benchmark Batch') => {
      const queueSnapshot = state.batchProcessing.queue;
      if (queueSnapshot.length === 0 || state.batchProcessing.isRunning) return;

      setState((prev) => ({
        ...prev,
        batchProcessing: {
          ...prev.batchProcessing,
          isRunning: true,
          currentJobIndex: 0,
        },
      }));

      const completedList: BatchQueueItem[] = queueSnapshot.map((item) => ({ ...item }));

      for (let idx = 0; idx < completedList.length; idx++) {
        completedList[idx] = { ...completedList[idx], status: 'RUNNING' };
        setState((prev) => ({
          ...prev,
          batchProcessing: {
            ...prev.batchProcessing,
            currentJobIndex: idx,
            queue: [...completedList],
          },
        }));

        await new Promise((r) => setTimeout(r, 45));

        const t0 = performance.now();
        try {
          const item = completedList[idx];
          const frames = computeFramesFor(
            item.rawPoints,
            item.algorithm,
            item.kMeansConfig,
            item.dbscanConfig,
            42
          );
          const finalFrame = frames[frames.length - 1] ?? null;
          completedList[idx] = {
            ...item,
            status: finalFrame ? 'COMPLETED' : 'FAILED',
            resultFrame: finalFrame,
            durationMs: Math.max(1, Math.round(performance.now() - t0)),
            errorMessage: finalFrame ? null : 'Empty result frame',
          };
        } catch (err) {
          completedList[idx] = {
            ...completedList[idx],
            status: 'FAILED',
            durationMs: Math.max(1, Math.round(performance.now() - t0)),
            errorMessage: err instanceof Error ? err.message : 'Execution error',
          };
        }

        setState((prev) => ({
          ...prev,
          batchProcessing: {
            ...prev.batchProcessing,
            queue: [...completedList],
          },
        }));
      }

      const successful = completedList.filter((i) => i.status === 'COMPLETED' && i.resultFrame);
      let fileName: string | null = null;
      let sizeLabel: string | null = null;
      let allReports = state.localPdfReports;
      let generatedBytes: Uint8Array | null = null;

      if (successful.length > 0) {
        generatedBytes = generateCombinedBatchPdfBytes({
          batchTitle,
          completedItems: successful,
          showVoronoi: state.kMeansConfig.showVoronoi,
          showTrails: state.kMeansConfig.showTrails,
          showSpiderLines: state.showSpiderLines,
          showEpsilonRings: state.dbscanConfig.showEpsilonRings,
        });
        const saved = savePdfToLocalStorage(`${batchTitle}_combined`, generatedBytes);
        fileName = saved.info.fileName;
        sizeLabel = formatBytes(saved.info.sizeBytes);
        allReports = saved.allReports;
      }

      setState((prev) => ({
        ...prev,
        localPdfReports: allReports,
        lastExportedPdfFileName: fileName ?? prev.lastExportedPdfFileName,
        lastExportedPdfSizeLabel: sizeLabel ?? prev.lastExportedPdfSizeLabel,
        batchProcessing: {
          ...prev.batchProcessing,
          queue: completedList,
          isRunning: false,
          currentJobIndex: -1,
          lastCombinedPdfFileName: fileName,
          lastCombinedPdfSizeLabel: sizeLabel,
          lastCompletedAtLabel: formatDateTime(Date.now()),
        },
        statusBanner: fileName
          ? `Batch complete (${successful.length}/${completedList.length} passed). Saved "${fileName}".`
          : 'Batch finished with no completed jobs.',
      }));

      if (fileName && generatedBytes) {
        setPdfPreviewState({ fileName, bytes: generatedBytes });
      }
    },
    [
      state.batchProcessing.queue,
      state.batchProcessing.isRunning,
      state.localPdfReports,
      state.kMeansConfig,
      state.showSpiderLines,
      state.dbscanConfig.showEpsilonRings,
    ]
  );

  return {
    state,
    currentFrame,
    pdfPreviewState,
    closePdfPreview: () => setPdfPreviewState(null),
    dismissBanner,
    setBanner,
    selectAlgorithm,
    updateK,
    toggleKMeansPlusPlus,
    toggleShowVoronoi,
    toggleShowTrails,
    updateEpsilon,
    updateMinPts,
    toggleEpsilonRings,
    selectToolMode,
    toggleGrid,
    toggleSpiderLines,
    toggleDarkTheme,
    toggleDeveloperMode,
    completeOnboarding,
    restartOnboarding,
    selectPreset,
    updateSampleCount,
    updateNoiseLevel,
    addPoint,
    erasePointsNear,
    clearCanvas,
    runClusteringAnimated,
    togglePlayPause,
    stepForward,
    resetToStart,
    jumpToConverged,
    addOrUpdateAnnotation,
    deleteAnnotation,
    clearAnnotations,
    restoreSessionRun,
    clearSessionHistory,
    importPastedText,
    saveSnapshot,
    loadSnapshot,
    deleteSnapshot,
    exportCurrentCsvDownload,
    saveCsvLocally,
    importCsvFromStorage,
    deleteCsvFromStorage,
    downloadCsvFromStorage,
    shareCsvText,
    generateAndSaveSinglePdf,
    openSavedPdfPreview,
    downloadSavedPdf,
    deleteSavedPdf,
    enqueueCurrentCanvasToBatch,
    enqueuePresetToBatch,
    enqueueSavedSnapshotToBatch,
    enqueueBenchmarkSuite,
    removeBatchJob,
    clearBatchQueue,
    inspectBatchJobOnCanvas,
    runBatchAndGeneratePdf,
  };
}
