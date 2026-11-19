import React from 'react';
import { BookOpen, Sparkles, X } from 'lucide-react';

interface UserGuideDialogProps {
  developerModeEnabled: boolean;
  onReplayTour: () => void;
  onClose: () => void;
}

const GUIDE_SECTIONS = [
  {
    step: '01',
    title: '1-Hop Star GGUF Cluster & Model Presets',
    body: 'Choose a quantized GGUF preset (Qwen3-30B-A3B MoE, BitNet b1.58 Ternary, Qwen2.5-32B Dense, or Llama-3.3-70B) and switch between This Device and 4-Node Cluster Test to inspect hub-and-spoke worker distribution.',
  },
  {
    step: '02',
    title: 'Safe RAM Pool & Cap-Bounded Layer Allocation',
    body: 'Enforces hard safety caps (<=50% physical RAM on Android, MemAvailable - 1 GB on Desktop, 90% VRAM) and assigns transformer layers proportionally by node compute score.',
  },
  {
    step: '03',
    title: 'Connect Device & 21×21 QR Pairing',
    body: 'Use Auto-Connect to locate your Master hub, pair via 21×21 QR code or token, and Start or Stop Sharing at any time with instant memory cleanup.',
  },
  {
    step: '04',
    title: 'Device Health & Thermal Guard',
    body: 'Tracks compute speed calibration, Safe RAM Cap, battery & thermal headroom, and 4 automatic thermal guard states (COOL, WARN, SHED_25, EMERGENCY_OFFLOAD) with anti-flapping hysteresis.',
  },
  {
    step: '05',
    title: '6-Check Auto-Diagnosis Troubleshooter',
    body: 'Runs local network, battery, thermal, memory, and cluster-secret checks with 1-click auto-fixes whenever a warning or failure appears.',
  },
  {
    step: '06',
    title: 'Developer Mode & 2D Clustering Lab (Dev)',
    body: 'Turn on Developer Mode in Settings to unlock the 2D Lab (Dev) tab (interactive K-Means & DBSCAN canvas, Batch queue, CSV manager, Vector PDF reports) along with thermal stress simulators and raw node logs.',
  },
];

export const UserGuideDialog: React.FC<UserGuideDialogProps> = ({
  developerModeEnabled,
  onReplayTour,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-blue-500" />
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                ClusterLab Quick Guide
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                1-Hop Star GGUF Cluster dashboard, health guard, and Developer 2D Lab.
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

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {GUIDE_SECTIONS.map((item) => (
            <div
              key={item.step}
              className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3.5 flex gap-3"
            >
              <span className="shrink-0 w-7 h-7 rounded-lg bg-blue-600/15 text-blue-600 dark:text-blue-400 font-mono-num text-xs font-bold flex items-center justify-center">
                {item.step}
              </span>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  {item.title}
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                  {item.body}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120]/50">
          {developerModeEnabled ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                onReplayTour();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3.5 py-1.5 text-xs font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-500/20"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Replay 2D Lab Tour
            </button>
          ) : (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Enable Developer Mode in Settings to unlock the 2D Lab.
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 text-xs font-semibold"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
};
