import React from 'react';
import { BookOpen, Code2, Grid3X3, Moon, Network, Sun, X } from 'lucide-react';

interface SettingsMenuDialogProps {
  isDarkTheme: boolean;
  developerModeEnabled: boolean;
  showGrid: boolean;
  showSpiderLines: boolean;
  onToggleTheme: () => void;
  onToggleDeveloperMode: (enabled: boolean) => void;
  onToggleGrid: () => void;
  onToggleSpiderLines: () => void;
  onOpenUserGuide: () => void;
  onClose: () => void;
}

export const SettingsMenuDialog: React.FC<SettingsMenuDialogProps> = ({
  isDarkTheme,
  developerModeEnabled,
  showGrid,
  showSpiderLines,
  onToggleTheme,
  onToggleDeveloperMode,
  onToggleGrid,
  onToggleSpiderLines,
  onOpenUserGuide,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
            Studio Settings & Preferences
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Theme Selection Swatches */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Studio Theme
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  if (!isDarkTheme) onToggleTheme();
                }}
                className={`rounded-xl p-3 border text-left transition-colors ${
                  isDarkTheme
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 hover:border-blue-500/50'
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-slate-100">
                  <Moon className="w-4 h-4 text-blue-400" />
                  Dark Studio
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className="w-4 h-4 rounded bg-[#0B1120] border border-slate-600" />
                  <span className="w-4 h-4 rounded bg-[#131C31] border border-slate-600" />
                  <span className="w-4 h-4 rounded bg-[#60A5FA]" />
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (isDarkTheme) onToggleTheme();
                }}
                className={`rounded-xl p-3 border text-left transition-colors ${
                  !isDarkTheme
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 hover:border-blue-500/50'
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-slate-100">
                  <Sun className="w-4 h-4 text-amber-500" />
                  Light Studio
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className="w-4 h-4 rounded bg-[#F8FAFC] border border-slate-300" />
                  <span className="w-4 h-4 rounded bg-[#FFFFFF] border border-slate-300" />
                  <span className="w-4 h-4 rounded bg-[#2563EB]" />
                </div>
              </button>
            </div>
          </div>

          {/* Developer Mode */}
          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3 cursor-pointer">
            <div className="flex items-start gap-2.5">
              <Code2 className="w-4 h-4 text-teal-500 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Developer Mode (2D Lab & Telemetry)
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Unlocks the 2D Lab (Dev) clustering workbench (K-Means & DBSCAN canvas, CSV/Batch/PDF tools), thermal stress simulator, and raw node telemetry.
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={developerModeEnabled}
              onChange={(e) => onToggleDeveloperMode(e.target.checked)}
              className="accent-blue-600 w-4 h-4 shrink-0"
            />
          </label>

          {/* Grid & Spider Overlays */}
          {developerModeEnabled && (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 px-3 py-2 text-xs cursor-pointer">
                <span className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
                  <Grid3X3 className="w-3.5 h-3.5 text-blue-500" />
                  10×10 Grid
                </span>
                <input
                  type="checkbox"
                  checked={showGrid}
                  onChange={onToggleGrid}
                  className="accent-blue-600 w-3.5 h-3.5"
                />
              </label>
              <label className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 px-3 py-2 text-xs cursor-pointer">
                <span className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
                  <Network className="w-3.5 h-3.5 text-blue-500" />
                  Spider Lines
                </span>
                <input
                  type="checkbox"
                  checked={showSpiderLines}
                  onChange={onToggleSpiderLines}
                  className="accent-blue-600 w-3.5 h-3.5"
                />
              </label>
            </div>
          )}

          {/* User Guide Trigger */}
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenUserGuide();
            }}
            className="w-full flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 px-3.5 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500"
          >
            <span className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-blue-500" />
              Open Interactive User Guide & Tour
            </span>
            <span className="text-blue-500">→</span>
          </button>
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 text-xs font-semibold"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
