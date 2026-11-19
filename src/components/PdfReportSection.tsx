import React, { useEffect, useMemo } from 'react';
import { LocalPdfReportInfo } from '../types/clustering';
import { formatBytes, formatDateTime, triggerFileDownload } from '../data/storage';
import { Download, Eye, FileText, FolderOpen, Trash2, X } from 'lucide-react';

interface PdfExportCardProps {
  reportsCount: number;
  lastFileName: string | null;
  lastSizeLabel: string | null;
  annotationsCount: number;
  hasPoints: boolean;
  onGeneratePdf: () => void;
  onOpenManager: () => void;
}

export const PdfReportExportCard: React.FC<PdfExportCardProps> = ({
  reportsCount,
  lastFileName,
  lastSizeLabel,
  annotationsCount,
  hasPoints,
  onGeneratePdf,
  onOpenManager,
}) => {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-4 space-y-3 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-blue-500" />
          <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
            PDF Summary Reports
          </h2>
          <span className="rounded-md bg-slate-100 dark:bg-[#1E293B] px-1.5 py-0.5 text-[10px] font-mono-num font-semibold text-slate-600 dark:text-slate-300">
            {reportsCount} saved
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenManager}
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Browse Reports
        </button>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Generates a vector A4 PDF 1.4 summary with live canvas snapshot, KPI statistics, cluster centroid breakdown{annotationsCount > 0 ? `, and ${annotationsCount} cluster note(s)` : ''}.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onGeneratePdf}
          disabled={!hasPoints}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-45 text-white px-3.5 py-1.5 text-xs font-semibold shadow-xs"
        >
          <FileText className="w-3.5 h-3.5" />
          Export & Preview PDF
        </button>

        {lastFileName && (
          <span className="text-[11px] font-mono-num text-emerald-600 dark:text-emerald-400 truncate max-w-[220px]">
            Last: {lastFileName} ({lastSizeLabel})
          </span>
        )}
      </div>
    </div>
  );
};

interface PdfManagerDialogProps {
  reports: LocalPdfReportInfo[];
  onPreview: (fileName: string) => void;
  onDownload: (fileName: string) => void;
  onDelete: (fileName: string) => void;
  onClose: () => void;
}

export const PdfReportManagerDialog: React.FC<PdfManagerDialogProps> = ({
  reports,
  onPreview,
  onDownload,
  onDelete,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-500" />
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                Saved PDF Reports ({reports.length})
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Stored locally in your browser. Preview inline or download anytime.
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
          {reports.length === 0 ? (
            <p className="text-sm text-center text-slate-500 dark:text-slate-400 py-8">
              No PDF reports saved yet. Export a single analysis or batch report first.
            </p>
          ) : (
            reports.map((report) => (
              <div
                key={report.fileName}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-xs font-mono-num font-bold text-slate-900 dark:text-slate-100 truncate">
                    {report.fileName}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {formatBytes(report.sizeBytes)} • {formatDateTime(report.lastModifiedMillis)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onPreview(report.fileName)}
                    className="inline-flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1.5 text-xs font-semibold"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => onDownload(report.fileName)}
                    title="Download PDF"
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-blue-500"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(report.fileName)}
                    title="Delete PDF"
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

interface PdfPreviewModalProps {
  fileName: string;
  bytes: Uint8Array;
  onClose: () => void;
}

export const PdfPreviewModal: React.FC<PdfPreviewModalProps> = ({ fileName, bytes, onClose }) => {
  const blobUrl = useMemo(() => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
  }, [bytes]);

  useEffect(() => {
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-4xl h-[88vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-700">
          <div className="min-w-0">
            <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
              PDF Preview — {fileName}
            </h3>
            <p className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
              {formatBytes(bytes.length)} • Vector PDF 1.4
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const copy = new Uint8Array(bytes.length);
                copy.set(bytes);
                triggerFileDownload(new Blob([copy], { type: 'application/pdf' }), fileName);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-1.5 text-xs font-semibold"
            >
              <Download className="w-3.5 h-3.5" />
              Download PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 bg-slate-100 dark:bg-slate-900">
          <iframe
            src={blobUrl}
            title={`PDF Preview ${fileName}`}
            className="w-full h-full border-0"
          />
        </div>
      </div>
    </div>
  );
};
