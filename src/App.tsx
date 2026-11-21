import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ClusterAnnotation } from './types/clustering';
import {
  BackendTuningConfig,
  ClusterMode,
  GGUF_MODEL_PRESETS,
  GgufModelPreset,
  LiveHardwareProbe,
} from './types/starCluster';
import { createDefaultBackendTuningConfig } from './domain/backendTuner';
import {
  buildStarClusterNodes,
  planStarCluster,
} from './domain/starClusterPlanner';
import { useClusterLabStore } from './hooks/useClusterLabStore';
import { useNodeWorkerStore } from './hooks/useNodeWorkerStore';
import { StarClusterDashboard } from './components/StarClusterDashboard';
import { ModelsHubPage } from './components/ModelsHubPage';
import { ChatAndBrainPage } from './components/ChatAndBrainPage';
import { ApiHarnessConnectPage } from './components/ApiHarnessConnectPage';
import { InteractiveClusterCanvas } from './components/InteractiveClusterCanvas';
import {
  AlgorithmAndHyperparametersCard,
  CanvasToolbarAndPlaybackBar,
  MetricsInspectorCard,
  PresetDatasetSelectorCard,
} from './components/ControlAndMetricsPanels';
import {
  SessionHistoryDialog,
  SessionHistoryStripCard,
} from './components/SessionHistorySection';
import {
  BatchProcessingDialog,
  BatchProcessingQuickCard,
} from './components/BatchProcessingSection';
import {
  PdfPreviewModal,
  PdfReportExportCard,
  PdfReportManagerDialog,
} from './components/PdfReportSection';
import {
  CsvStorageManagerDialog,
  LocalCsvStorageCard,
} from './components/LocalCsvStorageSection';
import {
  ClusterAnnotationDialog,
  PasteDatasetDialog,
  SavedSnapshotsDialog,
  SaveSnapshotDialog,
} from './components/StudioDialogs';
import { SettingsMenuDialog } from './components/SettingsMenuDialog';
import { UserGuideDialog } from './components/UserGuideDialog';
import { InteractiveCoachMarkOverlay } from './components/CoachMarkOverlay';
import {
  BookOpen,
  BookmarkPlus,
  Brain,
  ClipboardPaste,
  Download,
  FileText,
  FolderOpen,
  History,
  Layers,
  Network,
  Package,
  PlugZap,
  ScatterChart,
  Settings,
  Upload,
  X,
} from 'lucide-react';

type AppTab = 'STAR' | 'MODELS' | 'CHAT' | 'API' | 'LAB';

export function App() {
  const studio = useClusterLabStore();
  const node = useNodeWorkerStore(studio.state.developerModeEnabled);
  const [activeTab, setActiveTab] = useState<AppTab>('STAR');

  // Shared Cluster Model, Mode & Windows/Linux Backend Tuning State
  const [activeModel, setActiveModel] = useState<GgufModelPreset>(GGUF_MODEL_PRESETS[0]);
  const [clusterMode, setClusterMode] = useState<ClusterMode>('LIVE_CLUSTER');
  const [tuningConfig, setTuningConfig] = useState<BackendTuningConfig>(() =>
    createDefaultBackendTuningConfig(GGUF_MODEL_PRESETS[0])
  );
  const [upstreamBaseUrl, setUpstreamBaseUrl] = useState('');
  const [liveHardware, setLiveHardware] = useState<LiveHardwareProbe | undefined>(undefined);
  const [localModels, setLocalModels] = useState<GgufModelPreset[]>([]);

  // Dialog States
  const [showSettings, setShowSettings] = useState(false);
  const [showUserGuide, setShowUserGuide] = useState(false);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showPdfManager, setShowPdfManager] = useState(false);
  const [showCsvManager, setShowCsvManager] = useState(false);
  const [showSaveSnapshot, setShowSaveSnapshot] = useState(false);
  const [showSavedSnapshots, setShowSavedSnapshots] = useState(false);
  const [showPasteDialog, setShowPasteDialog] = useState(false);

  const [annotationDraft, setAnnotationDraft] = useState<{
    clusterId: number;
    wx: number;
    wy: number;
    existing?: ClusterAnnotation;
  } | null>(null);

  // Refs for CoachMarkOverlay & File Input (Developer 2D Lab)
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const gestureControlsRef = useRef<HTMLDivElement | null>(null);
  const runButtonRef = useRef<HTMLButtonElement | null>(null);
  const topFileInputRef = useRef<HTMLInputElement | null>(null);

  const { state, currentFrame } = studio;
  const isDevLabActive = state.developerModeEnabled && activeTab === 'LAB';

  const fetchLiveHardware = async () => {
    try {
      const res = await fetch('/api/cluster/hardware');
      if (res.ok) {
        const data = (await res.json()) as LiveHardwareProbe;
        setLiveHardware(data);
      }
    } catch {
      // Non-blocking fallback
    }
  };

  const fetchLocalModels = async (dir?: string) => {
    try {
      const url = dir ? `/api/local/models?dir=${encodeURIComponent(dir)}` : '/api/local/models';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.models)) {
          setLocalModels(data.models);
        }
      }
    } catch {
      // Non-blocking fallback
    }
  };

  const handleAddLocalModelPath = async (filePath: string): Promise<GgufModelPreset | null> => {
    try {
      const res = await fetch('/api/local/models/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.model) {
          setLocalModels((prev) => {
            const exists = prev.some((m) => m.id === data.model.id);
            return exists ? prev : [data.model, ...prev];
          });
          return data.model;
        }
      }
    } catch {
      // Non-blocking fallback
    }
    return null;
  };

  useEffect(() => {
    void fetchLiveHardware();
    void fetchLocalModels();
  }, []);

  const clusterPlan = useMemo(() => {
    const rawNodes = buildStarClusterNodes(
      node.telemetry,
      clusterMode,
      0,
      tuningConfig,
      liveHardware
    );
    return planStarCluster(rawNodes, activeModel, undefined, tuningConfig);
  }, [node.telemetry, clusterMode, tuningConfig, activeModel, liveHardware]);

  // Sync active model, plan & backend tuning to Express /api/cluster/state
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/cluster/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeModel,
        clusterMode,
        tuningConfig,
        plan: clusterPlan,
        upstreamBaseUrl,
      }),
      signal: controller.signal,
    }).catch(() => {
      // Non-blocking sync when running static preview
    });
    return () => controller.abort();
  }, [activeModel, clusterMode, tuningConfig, clusterPlan, upstreamBaseUrl]);

  // Ensure turning Developer Mode OFF immediately exits 2D Lab back to Star Cluster
  useEffect(() => {
    if (!state.developerModeEnabled && activeTab === 'LAB') {
      setActiveTab('STAR');
    }
  }, [state.developerModeEnabled, activeTab]);

  const handleToggleDeveloperMode = (enabled: boolean) => {
    studio.toggleDeveloperMode(enabled);
    if (!enabled && activeTab === 'LAB') {
      setActiveTab('STAR');
    }
  };

  const handleSelectModel = (model: GgufModelPreset) => {
    setActiveModel(model);
    const recommended = createDefaultBackendTuningConfig(model);
    setTuningConfig((prev) => ({
      ...prev,
      contextLength: recommended.contextLength,
      kvCacheQuant: recommended.kvCacheQuant,
      enableFlashAttn: recommended.enableFlashAttn,
      moeCpuOffload: recommended.moeCpuOffload,
      windowsNoMmap: recommended.windowsNoMmap,
      linuxMlock: recommended.linuxMlock,
    }));
  };

  const handleActivateModel = async (model: GgufModelPreset) => {
    handleSelectModel(model);
    try {
      const res = await fetch('/api/models/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: model.id,
          filePath: model.localPath,
          model,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.snapshot?.activeModel) {
          setActiveModel(data.snapshot.activeModel);
        }
        if (data.snapshot?.tuningConfig) {
          setTuningConfig(data.snapshot.tuningConfig);
        }
      }
    } catch {
      // Non-blocking fallback
    }
  };

  const handleUpdateTuningConfig = (patch: Partial<BackendTuningConfig>) => {
    setTuningConfig((prev) => ({ ...prev, ...patch }));
  };

  const handleTopFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      const cleanName = file.name.replace(/\.(csv|json|txt)$/i, '');
      studio.importPastedText(cleanName, content);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const navItems: Array<{ id: AppTab; label: string; devOnly?: boolean }> = [
    { id: 'STAR', label: 'Cluster' },
    { id: 'MODELS', label: 'Models' },
    { id: 'CHAT', label: 'Chat & Brain' },
    { id: 'API', label: 'API & Harness' },
    { id: 'LAB', label: '2D Lab (Dev)', devOnly: true },
  ];
  const visibleNavItems = navItems.filter(
    (item) => !item.devOnly || state.developerModeEnabled
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-[#0B1120] text-[#0F172A] dark:text-[#F1F5F9] transition-colors">
      {/* Top Studio App Bar — Clean 3-Zone Contract */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0B1120]/95 backdrop-blur-md">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('STAR')}
            className="flex items-center gap-2.5 min-w-0 shrink-0 text-left"
          >
            <img
              src="/clusterlab-icon.jpg"
              alt="ClusterLab"
              className="w-7 h-7 rounded-lg object-cover border border-slate-200 dark:border-slate-700 shrink-0"
            />
            <span className="font-display text-base font-bold tracking-tight whitespace-nowrap">
              ClusterLab
            </span>
          </button>

          {/* Zone 2: Clean Single-Line Nav Links */}
          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-6"
          >
            {visibleNavItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    isActive
                      ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400'
                      : 'text-slate-600 dark:text-slate-400 border-transparent hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Primary Action & Utility Icons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isDevLabActive ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowPasteDialog(true)}
                  title="Paste CSV / JSON Coordinates"
                  className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <ClipboardPaste className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => topFileInputRef.current?.click()}
                  title="Import CSV / JSON / TXT File"
                  className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Upload className="w-4 h-4" />
                </button>
                <input
                  ref={topFileInputRef}
                  type="file"
                  accept=".csv,.json,.txt"
                  onChange={handleTopFileImport}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={studio.exportCurrentCsvDownload}
                  title="Export CSV"
                  className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowSaveSnapshot(true)}
                  title="Save Snapshot"
                  className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <BookmarkPlus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowSavedSnapshots(true)}
                  title="Saved Snapshots"
                  className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowBatchModal(true)}
                  title="Batch Run Queue"
                  className="relative p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Layers className="w-4 h-4" />
                  {state.batchProcessing.queue.length > 0 && (
                    <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-teal-500" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowSessionHistory(true)}
                  title="Session History Comparison"
                  className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <History className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => studio.generateAndSaveSinglePdf(true)}
                  title="Export & Preview PDF Report"
                  className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <FileText className="w-4 h-4" />
                </button>
              </>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Master: Port 3000</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowUserGuide(true)}
              title="Quick Guide"
              className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <BookOpen className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              title="Settings"
              className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 pb-20 md:pb-8">
        {isDevLabActive && state.statusBanner && (
          <div className="mb-4 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-blue-700 dark:text-blue-200">
            <span>{state.statusBanner}</span>
            <button
              type="button"
              onClick={studio.dismissBanner}
              className="p-1 rounded hover:bg-blue-500/20"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {activeTab === 'MODELS' ? (
          <ModelsHubPage
            clusterPlan={clusterPlan}
            activeModel={activeModel}
            onSelectModel={handleActivateModel}
            onOpenChat={() => setActiveTab('CHAT')}
            localModels={localModels}
            onRefreshLocalModels={fetchLocalModels}
            onAddLocalModelPath={handleAddLocalModelPath}
          />
        ) : activeTab === 'CHAT' ? (
          <ChatAndBrainPage
            activeModel={activeModel}
            clusterPlan={clusterPlan}
            tuningConfig={tuningConfig}
            upstreamBaseUrl={upstreamBaseUrl}
            onChangeUpstreamBaseUrl={setUpstreamBaseUrl}
            onOpenModels={() => setActiveTab('MODELS')}
            onUpdateTuningConfig={handleUpdateTuningConfig}
          />
        ) : activeTab === 'API' ? (
          <ApiHarnessConnectPage
            activeModel={activeModel}
            clusterPlan={clusterPlan}
            clusterSecret={node.telemetry.clusterSecret}
          />
        ) : isDevLabActive ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Left Column: Canvas + Toolbar + Session History + Batch Queue */}
            <div className="lg:col-span-7 space-y-4">
              <InteractiveClusterCanvas
                containerRef={canvasContainerRef}
                algorithm={state.algorithm}
                kMeansConfig={state.kMeansConfig}
                dbscanConfig={state.dbscanConfig}
                rawPoints={state.rawPoints}
                currentFrame={currentFrame}
                totalFrames={state.frames.length}
                currentFrameIndex={state.currentFrameIndex}
                toolMode={state.toolMode}
                showGrid={state.showGrid}
                showSpiderLines={state.showSpiderLines}
                isDarkTheme={state.isDarkTheme}
                developerModeEnabled={state.developerModeEnabled}
                annotations={state.annotations}
                lastAddedPointId={state.lastAddedPointId}
                onAddPoint={studio.addPoint}
                onErasePointsNear={studio.erasePointsNear}
                onToggleGrid={studio.toggleGrid}
                onToggleSpiderLines={studio.toggleSpiderLines}
                onOpenAnnotation={(clusterId, wx, wy, existing) =>
                  setAnnotationDraft({ clusterId, wx, wy, existing })
                }
              />

              <CanvasToolbarAndPlaybackBar
                gestureControlsRef={gestureControlsRef}
                runButtonRef={runButtonRef}
                toolMode={state.toolMode}
                developerModeEnabled={state.developerModeEnabled}
                isPlaying={state.isPlaying}
                currentFrameIndex={state.currentFrameIndex}
                totalFrames={state.frames.length}
                frameDescription={currentFrame?.description ?? 'Ready'}
                isConverged={currentFrame?.isConverged ?? false}
                hasPoints={state.rawPoints.length > 0}
                onSelectTool={studio.selectToolMode}
                onClearCanvas={studio.clearCanvas}
                onRunAnimated={studio.runClusteringAnimated}
                onTogglePlayPause={studio.togglePlayPause}
                onStepForward={studio.stepForward}
                onResetToStart={studio.resetToStart}
                onJumpToConverged={studio.jumpToConverged}
              />

              <SessionHistoryStripCard
                runs={state.sessionHistory}
                activeRunId={state.activeSessionRunId}
                onRestoreRun={studio.restoreSessionRun}
                onOpenDialog={() => setShowSessionHistory(true)}
              />

              <BatchProcessingQuickCard
                batchState={state.batchProcessing}
                onAddCurrentToBatch={studio.enqueueCurrentCanvasToBatch}
                onOpenBatchModal={() => setShowBatchModal(true)}
                onRunBatch={() => studio.runBatchAndGeneratePdf()}
                onPreviewCombinedPdf={studio.openSavedPdfPreview}
              />
            </div>

            {/* Right Column: Controls + Presets + PDF + Dev Panels */}
            <div className="lg:col-span-5 space-y-4">
              <AlgorithmAndHyperparametersCard
                algorithm={state.algorithm}
                kMeansConfig={state.kMeansConfig}
                dbscanConfig={state.dbscanConfig}
                onSelectAlgorithm={studio.selectAlgorithm}
                onUpdateK={studio.updateK}
                onToggleKMeansPlusPlus={studio.toggleKMeansPlusPlus}
                onToggleVoronoi={studio.toggleShowVoronoi}
                onToggleTrails={studio.toggleShowTrails}
                onUpdateEpsilon={studio.updateEpsilon}
                onUpdateMinPts={studio.updateMinPts}
                onToggleEpsilonRings={studio.toggleEpsilonRings}
              />

              <PresetDatasetSelectorCard
                selectedPreset={state.selectedPreset}
                sampleCount={state.sampleCount}
                noiseLevel={state.noiseLevel}
                developerModeEnabled={state.developerModeEnabled}
                onSelectPreset={studio.selectPreset}
                onUpdateSampleCount={studio.updateSampleCount}
                onUpdateNoiseLevel={studio.updateNoiseLevel}
              />

              <MetricsInspectorCard
                algorithm={state.algorithm}
                frame={currentFrame}
              />

              {state.developerModeEnabled && (
                <>
                  <PdfReportExportCard
                    reportsCount={state.localPdfReports.length}
                    lastFileName={state.lastExportedPdfFileName}
                    lastSizeLabel={state.lastExportedPdfSizeLabel}
                    annotationsCount={state.annotations.length}
                    hasPoints={state.rawPoints.length > 0}
                    onGeneratePdf={() => studio.generateAndSaveSinglePdf(true)}
                    onOpenManager={() => setShowPdfManager(true)}
                  />

                  <LocalCsvStorageCard
                    datasetTitle={state.datasetTitle}
                    pointCount={state.rawPoints.length}
                    csvFiles={state.localCsvFiles}
                    onSaveCsvLocally={studio.saveCsvLocally}
                    onExportCsvDownload={studio.exportCurrentCsvDownload}
                    onImportUploadedText={studio.importPastedText}
                    onOpenManager={() => setShowCsvManager(true)}
                  />
                </>
              )}
            </div>
          </div>
        ) : (
          <StarClusterDashboard
            telemetry={node.telemetry}
            activeModel={activeModel}
            clusterMode={clusterMode}
            tuningConfig={tuningConfig}
            clusterPlan={clusterPlan}
            liveHardware={liveHardware}
            localModels={localModels}
            onSelectModel={handleSelectModel}
            onActivateModel={handleActivateModel}
            onChangeClusterMode={setClusterMode}
            onUpdateTuningConfig={handleUpdateTuningConfig}
            onUpdateSecret={node.updateClusterSecret}
            onOpenModels={() => setActiveTab('MODELS')}
            onOpenChat={() => setActiveTab('CHAT')}
            onOpen2DLab={
              state.developerModeEnabled ? () => setActiveTab('LAB') : undefined
            }
            onRefreshHardware={fetchLiveHardware}
            onAddLocalModelPath={handleAddLocalModelPath}
            onRefreshLocalModels={fetchLocalModels}
          />
        )}
      </main>

      {/* Mobile Navigation Bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0B1120]/95 backdrop-blur-md">
        <div
          className={`mx-auto grid h-14 ${
            state.developerModeEnabled ? 'grid-cols-5' : 'grid-cols-4'
          }`}
        >
          <button
            type="button"
            onClick={() => setActiveTab('STAR')}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
              activeTab === 'STAR'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Network className="w-4 h-4" />
            <span>Cluster</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('MODELS')}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
              activeTab === 'MODELS'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Package className="w-4 h-4" />
            <span>Models</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('CHAT')}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
              activeTab === 'CHAT'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Brain className="w-4 h-4" />
            <span>Chat</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('API')}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
              activeTab === 'API'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <PlugZap className="w-4 h-4" />
            <span>API</span>
          </button>
          {state.developerModeEnabled && (
            <button
              type="button"
              onClick={() => setActiveTab('LAB')}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
                activeTab === 'LAB'
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <ScatterChart className="w-4 h-4" />
              <span>2D Lab</span>
            </button>
          )}
        </div>
      </nav>

      {/* Dialogs & Overlays */}
      {showSettings && (
        <SettingsMenuDialog
          isDarkTheme={state.isDarkTheme}
          developerModeEnabled={state.developerModeEnabled}
          showGrid={state.showGrid}
          showSpiderLines={state.showSpiderLines}
          onToggleTheme={studio.toggleDarkTheme}
          onToggleDeveloperMode={handleToggleDeveloperMode}
          onToggleGrid={studio.toggleGrid}
          onToggleSpiderLines={studio.toggleSpiderLines}
          onOpenUserGuide={() => setShowUserGuide(true)}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showUserGuide && (
        <UserGuideDialog
          developerModeEnabled={state.developerModeEnabled}
          onReplayTour={() => {
            if (state.developerModeEnabled) {
              setActiveTab('LAB');
              studio.restartOnboarding();
            }
          }}
          onClose={() => setShowUserGuide(false)}
        />
      )}

      {showSessionHistory && (
        <SessionHistoryDialog
          runs={state.sessionHistory}
          activeRunId={state.activeSessionRunId}
          onRestoreRun={studio.restoreSessionRun}
          onClearHistory={studio.clearSessionHistory}
          onClose={() => setShowSessionHistory(false)}
        />
      )}

      {showBatchModal && (
        <BatchProcessingDialog
          batchState={state.batchProcessing}
          savedSnapshots={state.savedDatasets}
          onAddCurrent={studio.enqueueCurrentCanvasToBatch}
          onAddBenchmarkSuite={studio.enqueueBenchmarkSuite}
          onAddPreset={studio.enqueuePresetToBatch}
          onAddSnapshot={studio.enqueueSavedSnapshotToBatch}
          onRemoveJob={studio.removeBatchJob}
          onClearQueue={studio.clearBatchQueue}
          onRunBatch={studio.runBatchAndGeneratePdf}
          onInspectJob={studio.inspectBatchJobOnCanvas}
          onPreviewCombinedPdf={studio.openSavedPdfPreview}
          onClose={() => setShowBatchModal(false)}
        />
      )}

      {showPdfManager && (
        <PdfReportManagerDialog
          reports={state.localPdfReports}
          onPreview={studio.openSavedPdfPreview}
          onDownload={studio.downloadSavedPdf}
          onDelete={studio.deleteSavedPdf}
          onClose={() => setShowPdfManager(false)}
        />
      )}

      {showCsvManager && (
        <CsvStorageManagerDialog
          datasetTitle={state.datasetTitle}
          pointCount={state.rawPoints.length}
          csvFiles={state.localCsvFiles}
          onSaveCsvLocally={studio.saveCsvLocally}
          onImportCsvFile={studio.importCsvFromStorage}
          onDownloadCsvFile={studio.downloadCsvFromStorage}
          onShareCsvFile={studio.shareCsvText}
          onDeleteCsvFile={studio.deleteCsvFromStorage}
          onClose={() => setShowCsvManager(false)}
        />
      )}

      {showSaveSnapshot && (
        <SaveSnapshotDialog
          defaultTitle={state.datasetTitle}
          pointCount={state.rawPoints.length}
          onSave={studio.saveSnapshot}
          onClose={() => setShowSaveSnapshot(false)}
        />
      )}

      {showSavedSnapshots && (
        <SavedSnapshotsDialog
          snapshots={state.savedDatasets}
          onLoad={studio.loadSnapshot}
          onDelete={studio.deleteSnapshot}
          onClose={() => setShowSavedSnapshots(false)}
        />
      )}

      {showPasteDialog && (
        <PasteDatasetDialog
          onImport={studio.importPastedText}
          onClose={() => setShowPasteDialog(false)}
        />
      )}

      {annotationDraft && (
        <ClusterAnnotationDialog
          clusterId={annotationDraft.clusterId}
          wx={annotationDraft.wx}
          wy={annotationDraft.wy}
          existing={annotationDraft.existing}
          onSave={(text) =>
            studio.addOrUpdateAnnotation(
              annotationDraft.clusterId,
              annotationDraft.wx,
              annotationDraft.wy,
              text,
              annotationDraft.existing?.id
            )
          }
          onDelete={
            annotationDraft.existing
              ? () => studio.deleteAnnotation(annotationDraft.existing!.id)
              : undefined
          }
          onClose={() => setAnnotationDraft(null)}
        />
      )}

      {studio.pdfPreviewState && (
        <PdfPreviewModal
          fileName={studio.pdfPreviewState.fileName}
          bytes={studio.pdfPreviewState.bytes}
          onClose={studio.closePdfPreview}
        />
      )}

      {isDevLabActive && (
        <InteractiveCoachMarkOverlay
          visible={!state.hasCompletedOnboarding}
          canvasRef={canvasContainerRef}
          gestureControlsRef={gestureControlsRef}
          runButtonRef={runButtonRef}
          onDropSamplePoint={() => studio.addPoint(0.5, 0.5)}
          onRunAnimated={studio.runClusteringAnimated}
          onComplete={studio.completeOnboarding}
        />
      )}
    </div>
  );
}

export default App;
