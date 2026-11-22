import React, { useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Cpu,
  MessageSquare,
  RefreshCw,
  Smartphone,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { EngineRuntimeStatus, GgufModelPreset, LiveHardwareProbe } from '../types/starCluster';

interface OnboardingWizardCardProps {
  liveHardware?: LiveHardwareProbe;
  activeModel: GgufModelPreset;
  engineStatus?: EngineRuntimeStatus;
  onRescanDevices: () => void;
  onOpenModels: () => void;
  onOpenLoadConfig: () => void;
  onOpenChat: () => void;
  onDismiss: () => void;
}

export const OnboardingWizardCard: React.FC<OnboardingWizardCardProps> = ({
  liveHardware,
  activeModel,
  engineStatus,
  onRescanDevices,
  onOpenModels,
  onOpenLoadConfig,
  onOpenChat,
  onDismiss,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const hostIp = liveHardware?.hostIp || '127.0.0.1';
  const onlineWorkers = liveHardware?.connectedDevices.filter((d) => d.isOnline).length ?? 0;
  const qrPayload = `clusterd://pair?master=${hostIp}:3000&rpc=50052&secret=clusterd-default-hmac-key`;

  const step1Done = Boolean(liveHardware);
  const step2Done = Boolean(activeModel.id);
  const step3Done = Boolean(engineStatus?.running);

  return (
    <section
      aria-label="Guided Setup"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Guided Setup
          </p>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
            Get Silica Cluster running in three steps
          </h2>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss guided setup"
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Stepper tabs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 my-4" role="tablist" aria-label="Setup steps">
        {[
          { num: 1 as const, label: 'Connect Real Nodes', done: step1Done },
          { num: 2 as const, label: 'Select GGUF & Auto-Config', done: step2Done },
          { num: 3 as const, label: 'Verify Engine & Chat', done: step3Done },
        ].map((item) => {
          const active = step === item.num;
          return (
            <button
              key={item.num}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStep(item.num)}
              className={`flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors ${
                active
                  ? 'border-emerald-500/70 bg-emerald-500/10 text-slate-900 dark:text-slate-100'
                  : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              <span className="flex items-center gap-2 text-xs font-medium">
                <span className="font-mono-num w-5 h-5 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[11px] font-semibold">
                  {item.num}
                </span>
                {item.label}
              </span>
              {item.done && <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />}
            </button>
          );
        })}
      </div>

      {/* Step content */}
      {step === 1 && (
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pt-1">
          <div className="space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
            <p className="font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              Host verified · {onlineWorkers} remote worker{onlineWorkers === 1 ? '' : 's'} online
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Plug in an Android phone over USB-C ADB, open the Silica Android app on the same 5 GHz Wi-Fi (UDP :50050), or run{' '}
              <code className="font-mono-num px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">
                clusterd worker
              </code>{' '}
              on another Windows/Linux/ARM64 machine.
            </p>
            <p className="text-xs font-mono-num text-slate-500 dark:text-slate-400 break-all">
              Pair URI: {qrPayload}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRescanDevices}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Rescan Devices
            </button>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Next: Model Setup
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pt-1">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              Active Model: {activeModel.name} ({activeModel.quant} · {activeModel.architecture})
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Selecting any local <code className="font-mono-num">.gguf</code> parses its binary header, auto-pairs companion{' '}
              <code className="font-mono-num">*mmproj*.gguf</code> on Master, and computes zero-OOM layer splits automatically.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={onOpenModels}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              Browse Models
            </button>
            <button
              type="button"
              onClick={onOpenLoadConfig}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Tune & Hot-Reload
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Next: Verify & Chat
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pt-1">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              Engine Status: {engineStatus?.running ? `Live (${engineStatus.upstreamUrl})` : 'Offline — Ready to Load or Connect'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Chat connects directly to your real <code className="font-mono-num">llama-server</code>, Ollama, or LM Studio endpoint with SSE streaming, vision uploads, reasoning panels, and web tools.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onDismiss}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              Finish Setup
            </button>
            <button
              type="button"
              onClick={() => {
                onDismiss();
                onOpenChat();
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Open Chat
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
