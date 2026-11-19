import React, { useRef, useState } from 'react';
import { LocalCsvFileInfo } from '../types/clustering';
import { formatBytes, formatDateTime } from '../data/storage';
import {
  Copy,
  Database,
  Download,
  FolderOpen,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

interface LocalCsvCardProps {
  datasetTitle: string;
  pointCount: number;
  csvFiles: LocalCsvFileInfo[];
  onSaveCsvLocally: (name: string) => void;
  onExportCsvDownload: () => void;
  onImportUploadedText: (title: string, text: string) => void;
  onOpenManager: () => void;
}

export const LocalCsvStorageCard: React.FC<LocalCsvCardProps> = ({
  datasetTitle,
  pointCount,
  csvFiles,
  onSaveCsvLocally,
  onExportCsvDownload,
  onImportUploadedText,
  onOpenManager,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      const cleanName = file.name.replace(/\.(csv|json|txt)$/i, '');
      onImportUploadedText(cleanName, content);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-4 space-y-3 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-blue-500" />
          <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
            Local CSV Storage (Dev)
          </h2>
          <span className="rounded-md bg-slate-100 dark:bg-[#1E293B] px-1.5 py-0.5 text-[10px] font-mono-num font-semibold text-slate-600 dark:text-slate-300">
            {csvFiles.length} files
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenManager}
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Manage Files
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onSaveCsvLocally(datasetTitle)}
          disabled={pointCount === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500 disabled:opacity-45"
        >
          <Save className="w-3.5 h-3.5 text-blue-500" />
          Save CSV Locally
        </button>

        <button
          type="button"
          onClick={onExportCsvDownload}
          disabled={pointCount === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500 disabled:opacity-45"
        >
          <Download className="w-3.5 h-3.5 text-emerald-500" />
          Download CSV
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500"
        >
          <Upload className="w-3.5 h-3.5 text-teal-500" />
          Import File
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json,.txt"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
    </div>
  );
};

interface CsvManagerDialogProps {
  datasetTitle: string;
  pointCount: number;
  csvFiles: LocalCsvFileInfo[];
  onSaveCsvLocally: (name: string) => void;
  onImportCsvFile: (fileName: string) => void;
  onDownloadCsvFile: (file: LocalCsvFileInfo) => void;
  onShareCsvFile: (file: LocalCsvFileInfo) => void;
  onDeleteCsvFile: (fileName: string) => void;
  onClose: () => void;
}

export const CsvStorageManagerDialog: React.FC<CsvManagerDialogProps> = ({
  datasetTitle,
  pointCount,
  csvFiles,
  onSaveCsvLocally,
  onImportCsvFile,
  onDownloadCsvFile,
  onShareCsvFile,
  onDeleteCsvFile,
  onClose,
}) => {
  const [saveName, setSaveName] = useState(datasetTitle);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-blue-500" />
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                Local CSV File Manager ({csvFiles.length})
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Export, reload, copy, or download CSV datasets saved in browser storage.
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

        <div className="p-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120]/50 flex gap-2">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Dataset filename..."
            className="flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-hidden focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => onSaveCsvLocally(saveName || datasetTitle)}
            disabled={pointCount === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-45 text-white px-3.5 py-1.5 text-xs font-semibold"
          >
            <Save className="w-3.5 h-3.5" />
            Save Current ({pointCount})
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {csvFiles.length === 0 ? (
            <p className="text-sm text-center text-slate-500 dark:text-slate-400 py-8">
              No saved CSV files yet. Save the current canvas dataset above.
            </p>
          ) : (
            csvFiles.map((file) => (
              <div
                key={file.fileName}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
              >
                <div className="min-w-0">
                  <div className="text-xs font-mono-num font-bold text-slate-900 dark:text-slate-100 truncate">
                    {file.fileName}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {file.pointCount} pts • {formatBytes(file.sizeBytes)} •{' '}
                    {formatDateTime(file.lastModifiedMillis)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      onImportCsvFile(file.fileName);
                      onClose();
                    }}
                    className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1.5 text-xs font-semibold"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => onShareCsvFile(file)}
                    title="Copy CSV to clipboard"
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-blue-500"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDownloadCsvFile(file)}
                    title="Download CSV"
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-blue-500"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteCsvFile(file.fileName)}
                    title="Delete CSV"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
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
