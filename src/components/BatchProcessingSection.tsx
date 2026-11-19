import React, { useState } from 'react';
import {
  BatchProcessingState,
  BatchQueueItem,
  PRESET_DATASETS,
  PresetDatasetType,
  SavedDatasetEntity,
  formatBatchParameterSummary,
} from '../types/clustering';
import {
  CheckCircle2,
  Eye,
  FileText,
  Layers,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

interface BatchQuickCardProps {
  batchState: BatchProcessingState;
  onAddCurrentToBatch: () => void;
  onOpenBatchModal: () => void;
  onRunBatch: () => void;
  onPreviewCombinedPdf: (fileName: string) => void;
}

export const BatchProcessingQuickCard: React.FC<BatchQuickCardProps> = ({
  batchState,
  onAddCurrentToBatch,
  onOpenBatchModal,
  onRunBatch,
  onPreviewCombinedPdf,
}) => {
  const completed = batchState.queue.filter((j) => j.status === 'COMPLETED').length;

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-4 space-y-3 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-teal-500" />
          <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
            Batch Run Queue
          </h2>
          <span className="rounded-md bg-slate-100 dark:bg-[#1E293B] px-1.5 py-0.5 text-[10px] font-mono-num font-semibold text-slate-600 dark:text-slate-300">
            {batchState.queue.length} queued
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenBatchModal}
          className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          Manage Queue
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAddCurrentToBatch}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-100 hover:border-blue-500"
        >
          <Plus className="w-3.5 h-3.5 text-blue-500" />
          Queue Canvas
        </button>

        <button
          type="button"
          onClick={onRunBatch}
          disabled={batchState.queue.length === 0 || batchState.isRunning}
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-45 text-white px-3 py-1.5 text-xs font-semibold"
        >
          {batchState.isRunning ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Running {batchState.currentJobIndex + 1}/{batchState.queue.length}
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" />
              Run & Export PDF
            </>
          )}
        </button>

        {batchState.lastCombinedPdfFileName && (
          <button
            type="button"
            onClick={() => onPreviewCombinedPdf(batchState.lastCombinedPdfFileName!)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
          >
            <FileText className="w-3.5 h-3.5" />
            Open Batch PDF ({batchState.lastCombinedPdfSizeLabel})
          </button>
        )}
      </div>

      {batchState.queue.length > 0 && (
        <div className="text-[11px] text-slate-500 dark:text-slate-400">
          {completed > 0
            ? `${completed}/${batchState.queue.length} completed • Last batch at ${batchState.lastCompletedAtLabel}`
            : 'Queued runs execute sequentially and assemble a multi-page Executive PDF report.'}
        </div>
      )}
    </div>
  );
};

interface BatchDialogProps {
  batchState: BatchProcessingState;
  savedSnapshots: SavedDatasetEntity[];
  onAddCurrent: () => void;
  onAddBenchmarkSuite: () => void;
  onAddPreset: (type: PresetDatasetType) => void;
  onAddSnapshot: (entity: SavedDatasetEntity) => void;
  onRemoveJob: (jobId: number) => void;
  onClearQueue: () => void;
  onRunBatch: (title: string) => void;
  onInspectJob: (job: BatchQueueItem) => void;
  onPreviewCombinedPdf: (fileName: string) => void;
  onClose: () => void;
}

export const BatchProcessingDialog: React.FC<BatchDialogProps> = ({
  batchState,
  savedSnapshots,
  onAddCurrent,
  onAddBenchmarkSuite,
  onAddPreset,
  onAddSnapshot,
  onRemoveJob,
  onClearQueue,
  onRunBatch,
  onInspectJob,
  onPreviewCombinedPdf,
  onClose,
}) => {
  const [batchTitle, setBatchTitle] = useState('ClusterLab Benchmark Batch');

  const progressFraction =
    batchState.queue.length > 0 && batchState.isRunning
      ? Math.max(0.08, (batchState.currentJobIndex + 1) / batchState.queue.length)
      : 0;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-teal-500" />
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                Sequential Batch Runner & Combined PDF Builder
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Queue datasets & configurations, execute back-to-back, and export a multi-page PDF.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Batch Title + Quick Enqueue Actions */}
          <div className="space-y-2.5">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Combined Report Title
            </label>
            <input
              type="text"
              value={batchTitle}
              onChange={(e) => setBatchTitle(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-hidden focus:border-blue-500"
            />
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={onAddCurrent}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Current Canvas
              </button>
              <button
                type="button"
                onClick={onAddBenchmarkSuite}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-500/20"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Add 3-Preset Benchmark Suite
              </button>
              {PRESET_DATASETS.map((p) => (
                <button
                  key={p.type}
                  type="button"
                  onClick={() => onAddPreset(p.type)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:border-blue-500"
                >
                  + {p.title}
                </button>
              ))}
            </div>

            {savedSnapshots.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Saved Snapshots:
                </span>
                {savedSnapshots.slice(0, 4).map((snap) => (
                  <button
                    key={snap.id}
                    type="button"
                    onClick={() => onAddSnapshot(snap)}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1 text-[11px] text-slate-700 dark:text-slate-300 hover:border-teal-500"
                  >
                    + {snap.title}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Progress Bar while Running */}
          {batchState.isRunning && (
            <div className="rounded-xl border border-teal-500/40 bg-teal-500/10 p-3 space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-teal-700 dark:text-teal-300">
                <span>
                  Processing Job {batchState.currentJobIndex + 1} of {batchState.queue.length}...
                </span>
                <span className="font-mono-num">{Math.round(progressFraction * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-teal-500 transition-all duration-150"
                  style={{ width: `${Math.round(progressFraction * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Queue List */}
          <div className="space-y-2">
            {batchState.queue.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                Your batch queue is empty. Click "Add 3-Preset Benchmark Suite" or "Add Current Canvas" above.
              </div>
            ) : (
              batchState.queue.map((job, idx) => (
                <div
                  key={job.jobId}
                  className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono-num font-bold text-slate-500">
                        #{idx + 1}
                      </span>
                      <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                        {job.datasetTitle}
                      </span>
                      <span className="rounded bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:text-slate-200">
                        {job.sourceLabel}
                      </span>
                      {job.status === 'COMPLETED' && (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      )}
                      {job.status === 'RUNNING' && (
                        <Loader2 className="w-4 h-4 text-teal-500 animate-spin" />
                      )}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {formatBatchParameterSummary(job.algorithm, job.kMeansConfig, job.dbscanConfig)} •{' '}
                      {job.rawPoints.length} pts
                      {job.resultFrame && (
                        <span className="ml-2 font-mono-num text-slate-700 dark:text-slate-200">
                          Sil {job.resultFrame.silhouetteScore.toFixed(3)} • WCSS{' '}
                          {job.resultFrame.wcss.toFixed(3)} • {job.durationMs}ms
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {job.status === 'COMPLETED' && job.resultFrame && (
                      <button
                        type="button"
                        onClick={() => {
                          onInspectJob(job);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-blue-600/15 text-blue-600 dark:text-blue-300 px-2.5 py-1 text-xs font-semibold hover:bg-blue-600/25"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Inspect
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemoveJob(job.jobId)}
                      disabled={batchState.isRunning}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 disabled:opacity-40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120]/60">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClearQueue}
              disabled={batchState.queue.length === 0 || batchState.isRunning}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-40"
            >
              Clear Queue
            </button>
            {batchState.lastCombinedPdfFileName && (
              <button
                type="button"
                onClick={() => onPreviewCombinedPdf(batchState.lastCombinedPdfFileName!)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
              >
                <FileText className="w-3.5 h-3.5" />
                Preview Last PDF
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => onRunBatch(batchTitle.trim() || 'ClusterLab Benchmark Batch')}
            disabled={batchState.queue.length === 0 || batchState.isRunning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-45 text-white px-4 py-2 text-xs font-semibold"
          >
            <Play className="w-3.5 h-3.5" />
            Run Batch ({batchState.queue.length}) & Generate PDF
          </button>
        </div>
      </div>
    </div>
  );
};
