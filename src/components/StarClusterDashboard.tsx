import React, { useMemo, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Download,
  Loader2,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import {
  BackendOsTarget,
  BackendTuningConfig,
  ClusterMode,
  ClusterNetworkAuditReport,
  EngineRuntimeStatus,
  GGUF_MODEL_PRESETS,
  GgufModelPreset,
  LiveHardwareProbe,
  StarClusterPlan,
} from '../types/starCluster';
import { buildTunedOsBackendProfile } from '../domain/backendTuner';
import { LiveClusterGraph } from './LiveClusterGraph';
import { OnboardingWizardCard } from './OnboardingWizardCard';

interface StarClusterDashboardProps {
  activeModel: GgufModelPreset;
  onSelectModel: (model: GgufModelPreset) => void;
  clusterMode: ClusterMode;
  onChangeClusterMode: (mode: ClusterMode) => void;
  tuningConfig: BackendTuningConfig;
  plan: StarClusterPlan;
  liveHardware?: LiveHardwareProbe;
  engineStatus?: EngineRuntimeStatus;
  showOnboarding: boolean;
  onDismissOnboarding: () => void;
  onRescanDevices: () => void;
  onOpenModels: () => void;
  onOpenLoadConfig: () => void;
  onOpenChat: () => void;
  onOpenHud: () => void;
  onApplyAndReload?: (spawnLocalBinary: boolean) => Promise<{ ok: boolean; message: string }>;
}

export const StarClusterDashboard: React.FC<StarClusterDashboardProps> = ({
  activeModel,
  onSelectModel,
  clusterMode,
  onChangeClusterMode,
  tuningConfig,
  plan,
  liveHardware,
  engineStatus,
  showOnboarding,
  onDismissOnboarding,
  onRescanDevices,
  onOpenModels,
  onOpenLoadConfig,
  onOpenChat,
  onOpenHud,
  onApplyAndReload,
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(plan.nodes[0]?.nodeId ?? null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [reloadingEngine, setReloadingEngine] = useState(false);
  const [engineMsg, setEngineMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [scriptOs, setScriptOs] = useState<BackendOsTarget>(
    liveHardware?.platform === 'windows' ? 'windows' : 'linux'
  );
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [auditReport, setAuditReport] = useState<ClusterNetworkAuditReport | null>(null);
  const [auditing, setAuditing] = useState(false);

  const backendProfile = useMemo(
    () => buildTunedOsBackendProfile(scriptOs, activeModel, plan, tuningConfig),
    [scriptOs, activeModel, plan, tuningConfig]
  );

  const runNetworkAudit = async () => {
    setAuditing(true);
    try {
      const res = await fetch('/api/cluster/network/audit');
      if (res.ok) {
        setAuditReport((await res.json()) as ClusterNetworkAuditReport);
      }
    } finally {
      setAuditing(false);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(backendProfile.launchCommand);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const modelChoices = useMemo(() => {
    const exists = GGUF_MODEL_PRESETS.some((p) => p.id === activeModel.id);
    return exists ? GGUF_MODEL_PRESETS : [activeModel, ...GGUF_MODEL_PRESETS];
  }, [activeModel]);

  return (
    <div className="space-y-5">
      {/* Non-blocking Guided Setup Stepper */}
      {showOnboarding && (
        <OnboardingWizardCard
          liveHardware={liveHardware}
          activeModel={activeModel}
          engineStatus={engineStatus}
          onRescanDevices={onRescanDevices}
          onOpenModels={onOpenModels}
          onOpenLoadConfig={onOpenLoadConfig}
          onOpenChat={onOpenChat}
          onDismiss={onDismissOnboarding}
        />
      )}

      {/* Streamlined Model & Cluster Mode Toolbar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="sr-only" htmlFor="active-model-select">
            Active GGUF Model
          </label>
          <select
            id="active-model-select"
            value={activeModel.id}
            onChange={(e) => {
              const found = modelChoices.find((m) => m.id === e.target.value);
              if (found) onSelectModel(found);
            }}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1424] px-3 py-2 text-xs font-medium text-slate-900 dark:text-slate-100 min-w-[220px]"
          >
            {modelChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.quant} · {m.architecture})
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={reloadingEngine}
            onClick={async () => {
              if (onApplyAndReload) {
                setReloadingEngine(true);
                setEngineMsg(null);
                try {
                  const res = await onApplyAndReload(true);
                  setEngineMsg({ ok: res.ok, text: res.message });
                } finally {
                  setReloadingEngine(false);
                }
              } else {
                onOpenLoadConfig();
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 shadow-xs"
            title="Load local weights & spawn inference engine"
          >
            {reloadingEngine ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Starting...
              </>
            ) : engineStatus?.running ? (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                Reload Model
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                Load & Start Engine
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenLoadConfig}
            title="Configure context length, KV cache, and speculative decoding"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors shrink-0"
            aria-label="Open model load config"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onOpenModels}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            Browse GGUF
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1424] p-0.5 text-xs"
            role="group"
            aria-label="Cluster topology mode"
          >
            {(
              [
                { id: 'LIVE_CLUSTER', label: 'Live Cluster' },
                { id: 'LOCAL_DEVICE', label: 'Master Only' },
                { id: 'VIRTUAL_4NODE', label: 'Dry-Run' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeClusterMode(opt.id)}
                className={`px-2.5 py-1.5 rounded-md font-medium transition-colors whitespace-nowrap ${
                  clusterMode === opt.id
                    ? 'bg-white dark:bg-[#1A2438] text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onRescanDevices}
            aria-label="Rescan real hardware and connected nodes"
            className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Rescan
          </button>

          <button
            type="button"
            onClick={onOpenHud}
            className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Activity className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            HUD
          </button>
        </div>
      </div>

      {engineMsg && (
        <div
          className={`rounded-xl border p-3 text-xs flex items-center justify-between gap-3 ${
            engineMsg.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-300'
          }`}
        >
          <span>{engineMsg.text}</span>
          <button
            type="button"
            onClick={() => setEngineMsg(null)}
            className="text-[11px] underline opacity-75 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 4-KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">Engine & Fit Verdict</p>
          <p className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1">
            {plan.fitVerdict}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono-num">
            {engineStatus?.running ? `Live · ${engineStatus.serverType}` : 'Offline (HTTP 503)'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">Safe Memory Pool</p>
          <p className="text-lg font-semibold font-mono-num text-slate-900 dark:text-slate-100 mt-1">
            {(plan.totalSafePoolMb / 1024).toFixed(1)} GB
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono-num">
            Need {(plan.neededMb / 1024).toFixed(1)} GB · {plan.coveragePct}% covered
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">Throughput & Active Params</p>
          <p className="text-lg font-semibold font-mono-num text-emerald-700 dark:text-emerald-400 mt-1">
            {plan.estimatedClusterTokPerSec} tok/s
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono-num">
            {plan.activeParamsPerTokenB}B active / {plan.totalParamsB}B total
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">Thermal & KV Guard</p>
          <p className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1">
            {plan.overallThermalState === 'COOL' ? 'Nominal' : plan.overallThermalState}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono-num">
            KV {(plan.kvCacheTotalMb / 1024).toFixed(2)} GB · {tuningConfig.contextLength.toLocaleString()} ctx
          </p>
        </div>
      </div>

      {/* Single Centerpiece: Live Cluster Graph */}
      <LiveClusterGraph
        plan={plan}
        model={activeModel}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        onOpenPairHelp={() => setAdvancedOpen(true)}
      />

      {/* Collapsible Advanced Scripts, Multi-OS Worker CLI & Network Audit Drawer */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Terminal className="w-4 h-4 text-slate-500" />
            Advanced Backend Scripts, Multi-OS Worker CLI & Network Audit
          </span>
          {advancedOpen ? (
            <ChevronUp className="w-4 h-4 text-slate-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-500" />
          )}
        </button>

        {advancedOpen && (
          <div className="px-5 pb-5 pt-2 border-t border-slate-200 dark:border-slate-800 space-y-5">
            {/* Symmetric Multi-OS Rust CLI quick reference */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1424] p-3">
                <p className="font-semibold text-slate-900 dark:text-slate-100">Master Coordinator</p>
                <code className="block mt-1 font-mono-num text-emerald-700 dark:text-emerald-400">
                  clusterd master
                </code>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                  Pure-Rust server + embedded Web UI + stock llama-server supervisor.
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1424] p-3">
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  Win / Linux / ARM64 Worker
                </p>
                <code className="block mt-1 font-mono-num text-sky-700 dark:text-sky-400">
                  clusterd worker
                </code>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                  UDP :50050 discovery, 8s heartbeat, thermal guard, and rpc-server -c.
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1424] p-3">
                <p className="font-semibold text-slate-900 dark:text-slate-100">Zero-Config Auto Role</p>
                <code className="block mt-1 font-mono-num text-violet-700 dark:text-violet-400">
                  clusterd --auto
                </code>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                  Joins live LAN Master as worker, or promotes to Master if none responds.
                </p>
              </div>
            </div>

            {/* OS Script Generator */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 text-xs">
                  {(['windows', 'linux'] as const).map((osId) => (
                    <button
                      key={osId}
                      type="button"
                      onClick={() => setScriptOs(osId)}
                      className={`px-3 py-1 rounded-md font-medium capitalize ${
                        scriptOs === osId
                          ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      {osId}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copyCommand}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCmd ? 'Copied' : 'Copy Command'}
                  </button>
                  <a
                    href={`/api/backends/script?os=${scriptOs}`}
                    download={backendProfile.scriptFileName}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download Script
                  </a>
                </div>
              </div>
              <pre className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#090D16] font-mono-num text-[11px] text-slate-700 dark:text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">
                {backendProfile.launchCommand}
              </pre>
            </div>

            {/* Live Network Audit */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Cluster Network & Handshake Audit
                </p>
                <button
                  type="button"
                  disabled={auditing}
                  onClick={runNetworkAudit}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {auditing ? 'Auditing...' : 'Run Audit'}
                </button>
              </div>
              {auditReport && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1424] p-3 text-xs space-y-1.5 font-mono-num">
                  <p className="text-slate-800 dark:text-slate-200">
                    Host {auditReport.hostIp} · {auditReport.summary.clusterRating} · avg {auditReport.summary.avgRttMs} ms
                  </p>
                  {auditReport.nodes.map((n) => (
                    <div key={n.nodeId} className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                      <span>{n.label} ({n.ip})</span>
                      <span>{n.linkType} · {n.rttMs} ms · {n.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
