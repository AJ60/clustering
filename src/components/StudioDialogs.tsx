import React, { useState } from 'react';
import {
  ALGORITHM_LABELS,
  CLUSTER_COLORS,
  ClusterAnnotation,
  SavedDatasetEntity,
} from '../types/clustering';
import { formatDateTime } from '../data/storage';
import {
  BookmarkPlus,
  ClipboardPaste,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  Trash2,
  X,
} from 'lucide-react';

interface SaveSnapshotDialogProps {
  defaultTitle: string;
  pointCount: number;
  onSave: (title: string) => void;
  onClose: () => void;
}

export const SaveSnapshotDialog: React.FC<SaveSnapshotDialogProps> = ({
  defaultTitle,
  pointCount,
  onSave,
  onClose,
}) => {
  const [title, setTitle] = useState(defaultTitle);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <BookmarkPlus className="w-5 h-5 text-blue-500" />
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
              Save Dataset Snapshot
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(title);
            onClose();
          }}
          className="p-5 space-y-4"
        >
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Saves your {pointCount} canvas coordinates and current hyperparameters into local browser storage.
          </p>
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Snapshot Name
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-hidden focus:border-blue-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 px-4 py-2 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pointCount === 0}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-45 text-white px-4 py-2 text-xs font-semibold"
            >
              Save Snapshot
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface SavedSnapshotsDialogProps {
  snapshots: SavedDatasetEntity[];
  onLoad: (entity: SavedDatasetEntity) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
}

export const SavedSnapshotsDialog: React.FC<SavedSnapshotsDialogProps> = ({
  snapshots,
  onLoad,
  onDelete,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-blue-500" />
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
              Saved Snapshots ({snapshots.length})
            </h3>
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
          {snapshots.length === 0 ? (
            <p className="text-sm text-center text-slate-500 dark:text-slate-400 py-8">
              No saved snapshots yet. Use "Save Snapshot" to store a workspace state.
            </p>
          ) : (
            snapshots.map((snap) => (
              <div
                key={snap.id}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                    {snap.title}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {ALGORITHM_LABELS[snap.algorithm]} • {snap.pointCount} pts •{' '}
                    {formatDateTime(snap.createdAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      onLoad(snap);
                      onClose();
                    }}
                    className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-xs font-semibold"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(snap.id)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-slate-200 dark:border-slate-700">
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

interface PasteDatasetDialogProps {
  onImport: (title: string, rawText: string) => boolean;
  onClose: () => void;
}

const SAMPLE_PASTE_DATA = `0.21, 0.31
0.24, 0.28
0.25, 0.35
0.74, 0.71
0.78, 0.68
0.72, 0.76`;

export const PasteDatasetDialog: React.FC<PasteDatasetDialogProps> = ({ onImport, onClose }) => {
  const [title, setTitle] = useState('Pasted Coordinates');
  const [rawText, setRawText] = useState(SAMPLE_PASTE_DATA);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <ClipboardPaste className="w-5 h-5 text-blue-500" />
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
              Paste CSV / JSON Coordinates
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (onImport(title, rawText)) {
              onClose();
            }
          }}
          className="p-5 space-y-3"
        >
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Supports comma/tab CSV (<code className="font-mono-num">x,y</code>), JSON coordinate arrays, or raw numeric pairs. Out-of-range coordinates are normalized into [0.08, 0.92].
          </p>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Dataset title"
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-hidden focus:border-blue-500"
          />
          <textarea
            rows={7}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="0.25, 0.30&#10;0.75, 0.72"
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] p-3 text-xs font-mono-num text-slate-900 dark:text-slate-100 focus:outline-hidden focus:border-blue-500"
          />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 px-4 py-2 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-xs font-semibold"
            >
              Parse & Plot Points
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface ClusterAnnotationDialogProps {
  clusterId: number;
  wx: number;
  wy: number;
  existing?: ClusterAnnotation;
  onSave: (text: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}

const SUGGESTION_CHIPS = [
  'Primary High-Density Cluster',
  'Boundary Transition Zone',
  'Isolated Outlier Group',
  'Elongated Crescent Arm',
  'Verify Epsilon Radius',
];

export const ClusterAnnotationDialog: React.FC<ClusterAnnotationDialogProps> = ({
  clusterId,
  wx,
  wy,
  existing,
  onSave,
  onDelete,
  onClose,
}) => {
  const [text, setText] = useState(existing?.text ?? '');
  const color =
    clusterId >= 0 ? CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length] : '#64748B';

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2.5">
            <span
              className="w-3.5 h-3.5 rounded-full shrink-0"
              style={{ backgroundColor: color }}
            />
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <MessageSquarePlus className="w-4 h-4 text-blue-500" />
                {clusterId >= 0 ? `Annotate Cluster C${clusterId + 1}` : 'Canvas Note'}
              </h3>
              <p className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                Anchor ({wx.toFixed(2)}, {wy.toFixed(2)})
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) {
              onSave(text.trim());
              onClose();
            }
          }}
          className="p-5 space-y-3"
        >
          <div className="flex items-center gap-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 px-2.5 py-1.5 text-[11px] text-blue-600 dark:text-blue-300">
            <FileText className="w-3.5 h-3.5 shrink-0" />
            Annotations appear directly on the canvas and in exported PDF reports.
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                Annotation Text
              </span>
              <span className="font-mono-num text-slate-500">{text.length}/120</span>
            </div>
            <textarea
              rows={3}
              maxLength={120}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Describe cluster shape, density, or anomaly..."
              autoFocus
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] p-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-hidden focus:border-blue-500"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SUGGESTION_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => setText(chip)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] px-2 py-1 text-[11px] text-slate-700 dark:text-slate-300 hover:border-blue-500"
              >
                {chip}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2">
            {existing && onDelete ? (
              <button
                type="button"
                onClick={() => {
                  onDelete();
                  onClose();
                }}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-500/10"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            ) : (
              <div />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 px-3.5 py-2 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!text.trim()}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-45 text-white px-4 py-2 text-xs font-semibold"
              >
                Save Note
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
