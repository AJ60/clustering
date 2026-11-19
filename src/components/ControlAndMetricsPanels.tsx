import React from 'react';
import {
  ALGORITHM_LABELS,
  AlgorithmType,
  CLUSTER_COLORS,
  CanvasToolMode,
  ClusteringStepFrame,
  DbscanConfig,
  KMeansConfig,
  PRESET_DATASETS,
  PresetDatasetType,
} from '../types/clustering';
import {
  Brush,
  Eraser,
  FastForward,
  Move,
  Pause,
  Play,
  PlusCircle,
  RotateCcw,
  SkipForward,
  Trash2,
} from 'lucide-react';

interface ToolbarProps {
  gestureControlsRef?: React.RefObject<HTMLDivElement | null>;
  runButtonRef?: React.RefObject<HTMLButtonElement | null>;
  toolMode: CanvasToolMode;
  developerModeEnabled: boolean;
  isPlaying: boolean;
  currentFrameIndex: number;
  totalFrames: number;
  frameDescription: string;
  isConverged: boolean;
  hasPoints: boolean;
  onSelectTool: (mode: CanvasToolMode) => void;
  onClearCanvas: () => void;
  onRunAnimated: () => void;
  onTogglePlayPause: () => void;
  onStepForward: () => void;
  onResetToStart: () => void;
  onJumpToConverged: () => void;
}

export const CanvasToolbarAndPlaybackBar: React.FC<ToolbarProps> = ({
  gestureControlsRef,
  runButtonRef,
  toolMode,
  developerModeEnabled,
  isPlaying,
  currentFrameIndex,
  totalFrames,
  frameDescription,
  isConverged,
  hasPoints,
  onSelectTool,
  onClearCanvas,
  onRunAnimated,
  onTogglePlayPause,
  onStepForward,
  onResetToStart,
  onJumpToConverged,
}) => {
  const availableTools: Array<{
    mode: CanvasToolMode;
    label: string;
    icon: React.ReactNode;
  }> = [
    { mode: 'ADD', label: 'Tap Add', icon: <PlusCircle className="w-3.5 h-3.5" /> },
    ...(developerModeEnabled
      ? [{ mode: 'BRUSH' as CanvasToolMode, label: 'Brush', icon: <Brush className="w-3.5 h-3.5" /> }]
      : []),
    { mode: 'ERASE', label: 'Erase', icon: <Eraser className="w-3.5 h-3.5" /> },
    ...(developerModeEnabled
      ? [{ mode: 'PAN' as CanvasToolMode, label: 'Pan/Zoom', icon: <Move className="w-3.5 h-3.5" /> }]
      : []),
  ];

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-3 space-y-2.5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Left: Gesture Mode Tools */}
        <div ref={gestureControlsRef} className="flex flex-wrap items-center gap-1.5">
          {availableTools.map((t) => {
            const active = toolMode === t.mode;
            return (
              <button
                key={t.mode}
                type="button"
                onClick={() => onSelectTool(t.mode)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                    : 'bg-slate-100 dark:bg-[#1E293B] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-blue-500/60'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            );
          })}

          <button
            type="button"
            onClick={onClearCanvas}
            disabled={!hasPoints}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] text-slate-600 dark:text-slate-300 hover:text-red-500 hover:border-red-400/60 disabled:opacity-45 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear Canvas
          </button>
        </div>

        {/* Right: Run / Play Controls */}
        <div className="flex items-center gap-1.5">
          {developerModeEnabled && (
            <>
              <button
                type="button"
                onClick={onResetToStart}
                disabled={currentFrameIndex <= 0}
                title="Reset to Step 0"
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:border-blue-500"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onTogglePlayPause}
                disabled={totalFrames <= 1}
                title={isPlaying ? 'Pause animation' : 'Play animation'}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:border-blue-500"
              >
                {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={onStepForward}
                disabled={currentFrameIndex >= totalFrames - 1}
                title="Step forward 1 iteration"
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:border-blue-500"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onJumpToConverged}
                disabled={currentFrameIndex >= totalFrames - 1}
                title="Jump to final converged frame"
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-mono-num font-medium border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:border-blue-500"
              >
                <FastForward className="w-3.5 h-3.5" />
                {currentFrameIndex + 1}/{Math.max(1, totalFrames)}
              </button>
            </>
          )}

          <button
            ref={runButtonRef}
            type="button"
            onClick={isPlaying ? onTogglePlayPause : onRunAnimated}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-xs transition-colors"
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                Pause
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                Run Animated
              </>
            )}
          </button>
        </div>
      </div>

      {/* Developer Step Narrative Strip */}
      {developerModeEnabled && (
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-700/80 text-xs">
          <span className="text-slate-600 dark:text-slate-300 truncate">{frameDescription}</span>
          {isConverged && hasPoints && (
            <span className="shrink-0 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-mono-num font-bold">
              CONVERGED
            </span>
          )}
        </div>
      )}
    </div>
  );
};

interface AlgorithmPanelProps {
  algorithm: AlgorithmType;
  kMeansConfig: KMeansConfig;
  dbscanConfig: DbscanConfig;
  onSelectAlgorithm: (algo: AlgorithmType) => void;
  onUpdateK: (k: number) => void;
  onToggleKMeansPlusPlus: (v: boolean) => void;
  onToggleVoronoi: (v: boolean) => void;
  onToggleTrails: (v: boolean) => void;
  onUpdateEpsilon: (eps: number) => void;
  onUpdateMinPts: (m: number) => void;
  onToggleEpsilonRings: (v: boolean) => void;
}

export const AlgorithmAndHyperparametersCard: React.FC<AlgorithmPanelProps> = ({
  algorithm,
  kMeansConfig,
  dbscanConfig,
  onSelectAlgorithm,
  onUpdateK,
  onToggleKMeansPlusPlus,
  onToggleVoronoi,
  onToggleTrails,
  onUpdateEpsilon,
  onUpdateMinPts,
  onToggleEpsilonRings,
}) => {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-4 space-y-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
          Algorithm & Hyperparameters
        </h2>
        <div className="inline-flex rounded-lg p-0.5 bg-slate-100 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-700">
          {(['KMEANS', 'DBSCAN'] as AlgorithmType[]).map((algo) => {
            const active = algorithm === algo;
            return (
              <button
                key={algo}
                type="button"
                onClick={() => onSelectAlgorithm(algo)}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                  active
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {ALGORITHM_LABELS[algo]}
              </button>
            );
          })}
        </div>
      </div>

      {algorithm === 'KMEANS' ? (
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                Clusters (K)
              </span>
              <span className="font-mono-num font-bold text-blue-600 dark:text-blue-400">
                K = {kMeansConfig.k}
              </span>
            </div>
            <input
              type="range"
              min={2}
              max={10}
              step={1}
              value={kMeansConfig.k}
              onChange={(e) => onUpdateK(Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
            <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 px-2.5 py-2 text-xs cursor-pointer">
              <span className="text-slate-700 dark:text-slate-200 font-medium">K-Means++</span>
              <input
                type="checkbox"
                checked={kMeansConfig.useKMeansPlusPlus}
                onChange={(e) => onToggleKMeansPlusPlus(e.target.checked)}
                className="accent-blue-600 w-3.5 h-3.5"
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 px-2.5 py-2 text-xs cursor-pointer">
              <span className="text-slate-700 dark:text-slate-200 font-medium">Voronoi Fill</span>
              <input
                type="checkbox"
                checked={kMeansConfig.showVoronoi}
                onChange={(e) => onToggleVoronoi(e.target.checked)}
                className="accent-blue-600 w-3.5 h-3.5"
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 px-2.5 py-2 text-xs cursor-pointer">
              <span className="text-slate-700 dark:text-slate-200 font-medium">Trails</span>
              <input
                type="checkbox"
                checked={kMeansConfig.showTrails}
                onChange={(e) => onToggleTrails(e.target.checked)}
                className="accent-blue-600 w-3.5 h-3.5"
              />
            </label>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                Neighborhood Radius (ε)
              </span>
              <span className="font-mono-num font-bold text-teal-600 dark:text-teal-400">
                ε = {dbscanConfig.epsilon.toFixed(3)}
              </span>
            </div>
            <input
              type="range"
              min={0.025}
              max={0.22}
              step={0.005}
              value={dbscanConfig.epsilon}
              onChange={(e) => onUpdateEpsilon(Number(e.target.value))}
              className="w-full accent-teal-500 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                Minimum Density (MinPts)
              </span>
              <span className="font-mono-num font-bold text-teal-600 dark:text-teal-400">
                MinPts = {dbscanConfig.minPts}
              </span>
            </div>
            <input
              type="range"
              min={2}
              max={15}
              step={1}
              value={dbscanConfig.minPts}
              onChange={(e) => onUpdateMinPts(Number(e.target.value))}
              className="w-full accent-teal-500 cursor-pointer"
            />
          </div>

          <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 px-3 py-2 text-xs cursor-pointer">
            <span className="text-slate-700 dark:text-slate-200 font-medium">
              Show ε-Neighborhood Rings around Core Points
            </span>
            <input
              type="checkbox"
              checked={dbscanConfig.showEpsilonRings}
              onChange={(e) => onToggleEpsilonRings(e.target.checked)}
              className="accent-teal-500 w-3.5 h-3.5"
            />
          </label>
        </div>
      )}
    </div>
  );
};

interface PresetSelectorProps {
  selectedPreset: PresetDatasetType | null;
  sampleCount: number;
  noiseLevel: number;
  developerModeEnabled: boolean;
  onSelectPreset: (type: PresetDatasetType) => void;
  onUpdateSampleCount: (count: number) => void;
  onUpdateNoiseLevel: (noise: number) => void;
}

export const PresetDatasetSelectorCard: React.FC<PresetSelectorProps> = ({
  selectedPreset,
  sampleCount,
  noiseLevel,
  developerModeEnabled,
  onSelectPreset,
  onUpdateSampleCount,
  onUpdateNoiseLevel,
}) => {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-4 space-y-3 shadow-xs">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
          Benchmark Datasets
        </h2>
        <span className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
          N={sampleCount}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PRESET_DATASETS.map((preset) => {
          const active = selectedPreset === preset.type;
          return (
            <button
              key={preset.type}
              type="button"
              onClick={() => onSelectPreset(preset.type)}
              className={`text-left rounded-xl p-2.5 border transition-colors ${
                active
                  ? 'border-blue-500 bg-blue-500/10 dark:bg-blue-500/15'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/50 hover:border-blue-500/50'
              }`}
            >
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                {preset.title}
              </div>
              <div className="text-[10.5px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5 leading-snug">
                {preset.subtitle}
              </div>
            </button>
          );
        })}
      </div>

      {developerModeEnabled && (
        <div className="pt-2 border-t border-slate-200 dark:border-slate-700/80 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="text-slate-600 dark:text-slate-400">Sample Points</span>
              <span className="font-mono-num font-semibold text-slate-800 dark:text-slate-200">
                {sampleCount}
              </span>
            </div>
            <input
              type="range"
              min={50}
              max={300}
              step={10}
              value={sampleCount}
              onChange={(e) => onUpdateSampleCount(Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="text-slate-600 dark:text-slate-400">Scatter Noise</span>
              <span className="font-mono-num font-semibold text-slate-800 dark:text-slate-200">
                {noiseLevel.toFixed(3)}
              </span>
            </div>
            <input
              type="range"
              min={0.012}
              max={0.08}
              step={0.004}
              value={noiseLevel}
              onChange={(e) => onUpdateNoiseLevel(Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>
        </div>
      )}
    </div>
  );
};

interface MetricsInspectorProps {
  algorithm: AlgorithmType;
  frame: ClusteringStepFrame | null;
}

export const MetricsInspectorCard: React.FC<MetricsInspectorProps> = ({ algorithm, frame }) => {
  const summaries = frame?.clusterSummaries ?? [];
  const totalPts = frame?.points.length ?? 0;

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-4 space-y-3 shadow-xs">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
          Metrics Inspector
        </h2>
        <span className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
          {algorithm === 'KMEANS' ? 'Centroid WCSS & Silhouette' : 'Core / Border / Noise'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Silhouette
          </div>
          <div className="text-base font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
            {(frame?.silhouetteScore ?? 0).toFixed(3)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {algorithm === 'KMEANS' ? 'WCSS Inertia' : 'Core Pts'}
          </div>
          <div className="text-base font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
            {algorithm === 'KMEANS' ? (frame?.wcss ?? 0).toFixed(3) : frame?.coreCount ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {algorithm === 'KMEANS' ? 'Clusters' : 'Noise Pts'}
          </div>
          <div className="text-base font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
            {algorithm === 'KMEANS' ? summaries.length : frame?.noiseCount ?? 0}
          </div>
        </div>
      </div>

      {summaries.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {summaries.map((s) => {
            const color = CLUSTER_COLORS[s.clusterId % CLUSTER_COLORS.length];
            const pct = totalPts > 0 ? Math.round((s.count / totalPts) * 100) : 0;
            return (
              <div key={s.clusterId} className="flex items-center gap-2 text-xs">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="font-mono-num font-semibold w-10 text-slate-700 dark:text-slate-200">
                  C{s.clusterId + 1}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                  />
                </div>
                <span className="font-mono-num text-[11px] text-slate-600 dark:text-slate-300 w-16 text-right">
                  {s.count} ({pct}%)
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
