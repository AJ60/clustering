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
    title: '1-Hop Star GGUF Cluster & Windows / Linux Backends',
    body: 'Choose a GGUF preset or Hugging Face model and toggle between This Device and 4-Node Cluster. Tune Windows (CUDA/Vulkan/DirectML, WDDM -450 MB guard) and Linux (CUDA/ROCm/OpenBLAS, numactl, MemAvailable - 1024 MB cap) backends and download tuned .ps1 / .sh scripts.',
  },
  {
    step: '02',
    title: 'Models Page & Hugging Face GGUF Browser',
    body: 'Search live Hugging Face GGUF repositories, inspect model cards scored automatically against your active RAM + VRAM pool (Fast, Best Fit, Streaming), switch quantization levels, and load directly into the cluster.',
  },
  {
    step: '03',
    title: 'Chat Window & Active Parameters Brain Inspector',
    body: 'Chat directly over POST /v1/chat/completions with SSE streaming while inspecting active parameters per token (e.g., 3.3B active / 30.5B total for MoE), per-node layer spans, KV cache footprint, and thermal state.',
  },
  {
    step: '04',
    title: 'OpenAI-Compatible Endpoints & 1-Step Harness Connect',
    body: 'Copy or download ready-to-run configs and 1-step terminal commands for Hermes, OpenCode, Claude Code Bridge, Codex CLI, Cline, Continue.dev, Aider, or Python SDK—plus test /v1/models and /v1/chat/completions live.',
  },
  {
    step: '05',
    title: 'Connect, Health & 6-Check Troubleshooter',
    body: 'Auto-discover your Master hub, pair with 21×21 CRC-8 QR codes, monitor Safe RAM Caps (<=50% Android, MemAvailable - 1 GB Desktop), and run the 6-check Auto-Diagnosis troubleshooter.',
  },
  {
    step: '06',
    title: 'Developer Mode & 2D Clustering Lab (Dev)',
    body: 'Enable Developer Mode in Settings to unlock the 2D Lab (Dev) workbench (interactive K-Means & DBSCAN canvas, Batch queue, CSV manager, Vector PDF reports) along with thermal stress simulators and raw node logs.',
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
                1-Hop Star GGUF Cluster, Windows/Linux tuning, Hugging Face Models, Chat & Brain, and OpenAI Harnesses.
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
