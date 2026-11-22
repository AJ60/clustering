import React from 'react';
import { Activity, BookOpen, Moon, Sun, X } from 'lucide-react';

interface SettingsMenuDialogProps {
  open: boolean;
  isDarkTheme: boolean;
  hudOpen: boolean;
  onToggleTheme: () => void;
  onToggleHud: () => void;
  onReopenOnboarding: () => void;
  onClose: () => void;
}

export const SettingsMenuDialog: React.FC<SettingsMenuDialogProps> = ({
  open,
  isDarkTheme,
  hudOpen,
  onToggleTheme,
  onToggleHud,
  onReopenOnboarding,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Silica Cluster Settings"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden shadow-xl">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Silica Cluster Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm">
          <button
            type="button"
            onClick={onToggleTheme}
            className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <span className="flex items-center gap-2.5 font-medium text-slate-900 dark:text-slate-100">
              {isDarkTheme ? <Moon className="w-4 h-4 text-sky-400" /> : <Sun className="w-4 h-4 text-amber-500" />}
              Appearance Theme
            </span>
            <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
              {isDarkTheme ? 'Dark' : 'Light'}
            </span>
          </button>

          <button
            type="button"
            onClick={onToggleHud}
            className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <span className="flex items-center gap-2.5 font-medium text-slate-900 dark:text-slate-100">
              <Activity className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              Floating Resource Monitor HUD
            </span>
            <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
              {hudOpen ? 'Visible' : 'Hidden'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onReopenOnboarding();
              onClose();
            }}
            className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <span className="flex items-center gap-2.5 font-medium text-slate-900 dark:text-slate-100">
              <BookOpen className="w-4 h-4 text-slate-500" />
              Guided Setup Stepper
            </span>
            <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
              Reopen
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
