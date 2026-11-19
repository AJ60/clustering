import React, { useEffect, useRef, useState } from 'react';
import { ClusterAnnotation } from './types/clustering';
import { useClusterLabStore } from './hooks/useClusterLabStore';
import { useNodeWorkerStore } from './hooks/useNodeWorkerStore';
import { StarClusterDashboard } from './components/StarClusterDashboard';
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
  ClipboardPaste,
  Download,
  FileText,
  FolderOpen,
  History,
  Layers,
  Network,
  ScatterChart,
  Settings,
  Upload,
  Wifi,
  X,
} from 'lucide-react';

type AppTab = 'STAR' | 'LAB';

export function App() {
  const studio = useClusterLabStore();
  const node = useNodeWorkerStore(studio.state.developerModeEnabled);
  const [activeTab, setActiveTab] = useState<AppTab>('STAR');

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

  // Ensure turning Developer Mode OFF immediately exits the 2D Lab back to Star Cluster
  useEffect(() => {
    if (!state.developerModeEnabled && activeTab !== 'STAR') {
      setActiveTab('STAR');
    }
  }, [state.developerModeEnabled, activeTab]);

  const handleToggleDeveloperMode = (enabled: boolean) => {
    studio.toggleDeveloperMode(enabled);
    if (!enabled) {
      setActiveTab('STAR');
    }
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

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-[#0B1120] text-[#0F172A] dark:text-[#F1F5F9] transition-colors">
      {/* Top Studio App Bar — Clean 3-Zone Contract */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0B1120]/95 backdrop-blur-md">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          {/* Left Zone: Brand Wordmark */}
          <div className="flex items-center gap-2.5 min-w-0 shrink-0">
            <img
              src="/clusterlab-icon.jpg"
              alt="ClusterLab"
              className="w-7 h-7 rounded-lg object-cover border border-slate-200 dark:border-slate-700 shrink-0"
            />
            <span className="font-display text-base font-bold tracking-tight whitespace-nowrap">
              ClusterLab
            </span>
          </div>

          {/* Center Zone: Clean Mode Links (only shown when Developer Mode unlocks 2D Lab) */}
          {state.developerModeEnabled && (
            <nav
              aria-label="Workspace switcher"
              className="hidden sm:flex items-center gap-1"
            >
              <button
                type="button"
                onClick={() => setActiveTab('STAR')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  activeTab === 'STAR'
                    ? 'bg-slate-100 dark:bg-[#131C31] text-blue-600 dark:text-blue-400'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                Star Cluster
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('LAB')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  activeTab === 'LAB'
                    ? 'bg-slate-100 dark:bg-[#131C31] text-blue-600 dark:text-blue-400'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                2D Lab (Dev)
              </button>
            </nav>
          )}

          {/* Right Zone: Concise Actions + Primary CTA */}
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
              <button
                type="button"
                onClick={node.autoDetectMaster}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors"
              >
                <Wifi className="w-3.5 h-3.5" />
                <span>Auto-Discover</span>
              </button>
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
      <main
        className={`flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 ${
          state.developerModeEnabled ? 'pb-20 sm:pb-8' : 'pb-8'
        }`}
      >
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

        {!isDevLabActive ? (
          <StarClusterDashboard
            telemetry={node.telemetry}
            onRecalibrate={node.recalibrate}
            onStartWorker={node.startWorker}
            onStopWorker={node.stopWorkerAndFreeRam}
            onAutoDetectMaster={node.autoDetectMaster}
            onPairQrPayload={node.pairQrPayload}
            onToggleBindMode={node.toggleBindMode}
            onUpdateSecret={node.updateClusterSecret}
            onSimulateShedLayers={node.simulateLowMemoryShedLayers}
            onRunDiagnostics={node.runDiagnostics}
            onApplyAutoFix={node.applyAutoFix}
            onOpen2DLab={
              state.developerModeEnabled ? () => setActiveTab('LAB') : undefined
            }
          />
        ) : (
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

              <PdfReportExportCard
                reportsCount={state.localPdfReports.length}
                lastFileName={state.lastExportedPdfFileName}
                lastSizeLabel={state.lastExportedPdfSizeLabel}
                annotationsCount={state.annotations.length}
                hasPoints={state.rawPoints.length > 0}
                onGeneratePdf={() => studio.generateAndSaveSinglePdf(true)}
                onOpenManager={() => setShowPdfManager(true)}
              />

              <MetricsInspectorCard
                algorithm={state.algorithm}
                frame={currentFrame}
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
            </div>
          </div>
        )}
      </main>

      {/* Bottom Mode Switcher — Strictly gated behind Developer Mode on small screens */}
      {state.developerModeEnabled && (
        <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0B1120]/95 backdrop-blur-md">
          <div className="max-w-md mx-auto grid grid-cols-2 h-14">
            <button
              type="button"
              onClick={() => setActiveTab('STAR')}
              className={`flex flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors ${
                activeTab === 'STAR'
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Network className="w-4 h-4" />
              <span>Star Cluster</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('LAB')}
              className={`flex flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors ${
                activeTab === 'LAB'
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <ScatterChart className="w-4 h-4" />
              <span>2D Lab (Dev)</span>
            </button>
          </div>
        </nav>
      )}

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
