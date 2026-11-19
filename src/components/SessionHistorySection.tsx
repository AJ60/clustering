import React, { useMemo } from 'react';
import {
  ClusteringSessionRun,
  formatSessionParameterSummary,
} from '../types/clustering';
import { formatDateTime } from '../data/storage';
import { History, RotateCcw, Trash2, Trophy, X } from 'lucide-react';

interface SessionHistoryStripProps {
  runs: ClusteringSessionRun[];
  activeRunId: number | null;
  onRestoreRun: (runId: number) => void;
  onOpenDialog: () => void;
}

export const SessionHistoryStripCard: React.FC<SessionHistoryStripProps> = ({
  runs,
  activeRunId,
  onRestoreRun,
  onOpenDialog,
}) => {
  const bestInertiaRunId = useMemo(() => {
    const valid = runs.filter((r) => r.clusterCount > 0 && r.inertiaWcss > 0);
    if (valid.length === 0) return null;
    return valid.reduce((best, cur) => (cur.inertiaWcss < best.inertiaWcss ? cur : best)).runId;
  }, [runs]);

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-4 space-y-2.5 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-blue-500 dark:text-blue-400" />
          <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
            Session History
          </h2>
          <span className="rounded-md bg-slate-100 dark:bg-[#1E293B] px-1.5 py-0.5 text-[10px] font-mono-num font-semibold text-slate-600 dark:text-slate-300">
            {runs.length}/10
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenDialog}
          className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          Compare All
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Run clustering on any dataset to record comparable snapshots here.
        </p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {runs.map((run) => {
            const isActive = run.runId === activeRunId;
            const isBest = run.runId === bestInertiaRunId;
            return (
              <button
                key={run.runId}
                type="button"
                onClick={() => onRestoreRun(run.runId)}
                className={`shrink-0 w-44 text-left rounded-xl p-2.5 border transition-colors ${
                  isActive
                    ? 'border-blue-500 bg-blue-500/10 dark:bg-blue-500/15'
                    : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 hover:border-blue-500/50'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-bold text-slate-900 dark:text-slate-100 truncate">
                    #{run.runId} {run.datasetTitle}
                  </span>
                  {isBest && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1 py-0.5 text-[9px] font-bold">
                      <Trophy className="w-2.5 h-2.5" />
                      BEST
                    </span>
                  )}
                </div>
                <div className="text-[10.5px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {formatSessionParameterSummary(run.algorithm, run.kMeansConfig, run.dbscanConfig)}
                </div>
                <div className="flex items-center justify-between text-[10.5px] font-mono-num mt-1.5 text-slate-700 dark:text-slate-200">
                  <span>Sil {run.silhouetteScore.toFixed(2)}</span>
                  <span>WCSS {run.inertiaWcss.toFixed(2)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface SessionHistoryDialogProps {
  runs: ClusteringSessionRun[];
  activeRunId: number | null;
  onRestoreRun: (runId: number) => void;
  onClearHistory: () => void;
  onClose: () => void;
}

export const SessionHistoryDialog: React.FC<SessionHistoryDialogProps> = ({
  runs,
  activeRunId,
  onRestoreRun,
  onClearHistory,
  onClose,
}) => {
  const bestInertiaRunId = useMemo(() => {
    const valid = runs.filter((r) => r.clusterCount > 0 && r.inertiaWcss > 0);
    if (valid.length === 0) return null;
    return valid.reduce((best, cur) => (cur.inertiaWcss < best.inertiaWcss ? cur : best)).runId;
  }, [runs]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-blue-500" />
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                Session Run Comparison ({runs.length}/10)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Click any recorded run to restore its exact canvas points, parameters, and annotations.
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

        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {runs.length === 0 ? (
            <p className="text-sm text-center text-slate-500 dark:text-slate-400 py-8">
              No runs recorded yet in this session.
            </p>
          ) : (
            runs.map((run) => {
              const isActive = run.runId === activeRunId;
              const isBest = run.runId === bestInertiaRunId;
              return (
                <div
                  key={run.runId}
                  className={`rounded-xl p-3.5 border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                    isActive
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/50'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                        Run #{run.runId} — {run.datasetTitle}
                      </span>
                      {isBest && (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] font-bold">
                          <Trophy className="w-3 h-3" />
                          LOWEST INERTIA
                        </span>
                      )}
                      {isActive && (
                        <span className="rounded bg-blue-600 text-white px-1.5 py-0.5 text-[10px] font-bold">
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {formatSessionParameterSummary(run.algorithm, run.kMeansConfig, run.dbscanConfig)} •{' '}
                      {run.rawPoints.length} pts • {run.clusterCount} clusters • {formatDateTime(run.timestampMillis)}
                    </div>
                    <div className="flex items-center gap-4 text-xs font-mono-num text-slate-700 dark:text-slate-200 pt-0.5">
                      <span>Silhouette: {run.silhouetteScore.toFixed(3)}</span>
                      <span>WCSS: {run.inertiaWcss.toFixed(4)}</span>
                      <span>Noise: {run.noiseCount}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      onRestoreRun(run.runId);
                      onClose();
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-xs font-semibold shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Restore
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120]/60">
          <button
            type="button"
            onClick={onClearHistory}
            disabled={runs.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear History
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 px-4 py-1.5 text-xs font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
