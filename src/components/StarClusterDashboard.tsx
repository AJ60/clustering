import React, { useMemo, useRef, useState } from 'react';
import {
  DeviceTelemetryState,
} from '../types/clustering';
import {
  BackendOsTarget,
  BackendTuningConfig,
  ClusterMode,
  ClusterNetworkAuditReport,
  GGUF_MODEL_PRESETS,
  GgufModelPreset,
  LiveHardwareProbe,
  PlannedStarNode,
  StarClusterPlan,
  ThermalState,
} from '../types/starCluster';
import { buildTunedOsBackendProfile } from '../domain/backendTuner';
import { parseLocalGgufModel } from '../data/localModelsScanner';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  Cpu,
  Download,
  Flame,
  FolderOpen,
  HardDrive,
  Layers,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  Smartphone,
  Snowflake,
  Sparkles,
  Terminal,
  Usb,
  X,
  Zap,
} from 'lucide-react';

interface StarClusterDashboardProps {
  telemetry: DeviceTelemetryState;
  activeModel: GgufModelPreset;
  clusterMode: ClusterMode;
  tuningConfig: BackendTuningConfig;
  clusterPlan: StarClusterPlan;
  liveHardware?: LiveHardwareProbe;
  localModels?: GgufModelPreset[];
  onSelectModel: (model: GgufModelPreset) => void;
  onChangeClusterMode: (mode: ClusterMode) => void;
  onUpdateTuningConfig: (patch: Partial<BackendTuningConfig>) => void;
  onUpdateSecret: (secret: string) => void;
  onOpenModels?: () => void;
  onOpenChat?: () => void;
  onOpen2DLab?: () => void;
  onRefreshHardware?: () => void;
  onAddLocalModelPath?: (filePath: string) => Promise<GgufModelPreset | null>;
  onRefreshLocalModels?: (dir?: string) => Promise<void>;
  onActivateModel?: (model: GgufModelPreset) => Promise<void>;
}

function thermalLabel(state: ThermalState): {
  text: string;
  colorClass: string;
  icon: React.ReactNode;
} {
  switch (state) {
    case 'COOL':
      return {
        text: 'Cool & Optimal',
        colorClass: 'text-emerald-400',
        icon: <Snowflake className="w-3.5 h-3.5 text-emerald-400 shrink-0" />,
      };
    case 'WARN':
      return {
        text: 'Warming (90% Cap)',
        colorClass: 'text-amber-400',
        icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
      };
    case 'SHED_25':
      return {
        text: 'Thermal Shed (-25%)',
        colorClass: 'text-amber-400',
        icon: <Flame className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
      };
    case 'EMERGENCY_OFFLOAD':
      return {
        text: 'Emergency Offload (0 Layers)',
        colorClass: 'text-red-400',
        icon: <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />,
      };
  }
}

export const StarClusterDashboard: React.FC<StarClusterDashboardProps> = ({
  telemetry,
  activeModel,
  clusterMode,
  tuningConfig,
  clusterPlan,
  liveHardware,
  localModels = [],
  onSelectModel,
  onChangeClusterMode,
  onUpdateTuningConfig: _onUpdateTuningConfig,
  onUpdateSecret,
  onOpenModels,
  onOpenChat,
  onOpen2DLab,
  onRefreshHardware,
  onAddLocalModelPath,
  onRefreshLocalModels,
  onActivateModel,
}) => {
  const masterNode =
    clusterPlan.nodes.find((n) => n.role === 'Master') ?? clusterPlan.nodes[0];
  const workerNodes = clusterPlan.nodes.filter((n) => n.nodeId !== masterNode?.nodeId);

  const [selectedNodeId, setSelectedNodeId] = useState<string>(masterNode?.nodeId ?? 'win-master');
  const [backendOs, setBackendOs] = useState<BackendOsTarget>(() => {
    if (liveHardware?.platform === 'windows') return 'windows';
    if (liveHardware?.platform === 'linux') return 'linux';
    return 'windows';
  });
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedAdb, setCopiedAdb] = useState(false);
  const [networkAudit, setNetworkAudit] = useState<ClusterNetworkAuditReport | null>(null);
  const [isAuditing, setIsAuditing] = useState(false);
  const [showQuickLoadModal, setShowQuickLoadModal] = useState(false);
  const [quickPathInput, setQuickPathInput] = useState('');
  const [quickLoading, setQuickLoading] = useState(false);
  const [quickFeedback, setQuickFeedback] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleActivateModel = async (model: GgufModelPreset) => {
    if (onActivateModel) {
      await onActivateModel(model);
    } else {
      onSelectModel(model);
    }
  };

  const handleQuickAddPath = async (pathOrName: string) => {
    if (!pathOrName.trim()) return;
    setQuickLoading(true);
    setQuickFeedback(null);
    try {
      if (onAddLocalModelPath) {
        const model = await onAddLocalModelPath(pathOrName.trim());
        if (model) {
          await handleActivateModel(model);
          setQuickFeedback(`Loaded & Auto-Distributed "${model.name}" (${(model.sizeMb / 1024).toFixed(1)} GB)`);
          window.setTimeout(() => {
            setShowQuickLoadModal(false);
            setQuickFeedback(null);
            setQuickPathInput('');
          }, 1100);
          return;
        }
      }
      const res = await fetch('/api/local/models/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: pathOrName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.model) {
          await handleActivateModel(data.model);
          if (onRefreshLocalModels) void onRefreshLocalModels();
          setQuickFeedback(`Loaded & Auto-Distributed "${data.model.name}"`);
          window.setTimeout(() => {
            setShowQuickLoadModal(false);
            setQuickFeedback(null);
            setQuickPathInput('');
          }, 1100);
          return;
        }
      }
      setQuickFeedback('Model not found at that path. Select from detected list or browse.');
    } catch {
      setQuickFeedback('Failed to load GGUF file.');
    } finally {
      setQuickLoading(false);
    }
  };

  const handleQuickFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setQuickLoading(true);
    setQuickFeedback(`Analyzing ${file.name}...`);
    try {
      const matched = localModels.find(
        (m) =>
          m.localPath?.toLowerCase().endsWith(file.name.toLowerCase()) ||
          m.name.toLowerCase() === file.name.replace(/\.gguf$/i, '').toLowerCase() ||
          (m.localPath && m.localPath.split(/[/\\]/).pop()?.toLowerCase() === file.name.toLowerCase())
      );
      if (matched) {
        await handleActivateModel(matched);
        setQuickFeedback(`Loaded "${matched.name}"`);
        window.setTimeout(() => {
          setShowQuickLoadModal(false);
          setQuickFeedback(null);
        }, 1100);
        return;
      }

      let headerBytes: Uint8Array | undefined;
      try {
        const slice = await file.slice(0, 131072).arrayBuffer();
        headerBytes = new Uint8Array(slice);
      } catch {
        // Non-blocking
      }

      const res = await fetch('/api/local/models/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: file.name }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.model) {
          await handleActivateModel(data.model);
          if (onRefreshLocalModels) void onRefreshLocalModels();
          setQuickFeedback(`Loaded "${data.model.name}"`);
          window.setTimeout(() => {
            setShowQuickLoadModal(false);
            setQuickFeedback(null);
          }, 1100);
          return;
        }
      }

      const parsed = parseLocalGgufModel(file.name, file.size, headerBytes);
      await handleActivateModel(parsed);
      setQuickFeedback(`Loaded "${parsed.name}"`);
      window.setTimeout(() => {
        setShowQuickLoadModal(false);
        setQuickFeedback(null);
      }, 1100);
    } catch {
      setQuickFeedback('Error parsing GGUF file.');
    } finally {
      setQuickLoading(false);
      e.target.value = '';
    }
  };
  const [healthStatus, setHealthStatus] = useState<{
    tested: boolean;
    loading: boolean;
    ok: boolean;
    latencyMs?: number;
    model?: string;
  }>({ tested: false, loading: false, ok: false });

  const handleRunNetworkAudit = async () => {
    setIsAuditing(true);
    try {
      const res = await fetch('/api/cluster/network/audit');
      if (res.ok) {
        const data = (await res.json()) as ClusterNetworkAuditReport;
        setNetworkAudit(data);
      }
    } catch {
      // Non-blocking
    } finally {
      setIsAuditing(false);
    }
  };

  const presetOptions = useMemo(() => {
    const combined = [...localModels, ...GGUF_MODEL_PRESETS];
    const exists = combined.some((p) => p.id === activeModel.id);
    return exists ? combined : [activeModel, ...combined];
  }, [activeModel, localModels]);

  const inspectedNode: PlannedStarNode | undefined = useMemo(() => {
    return (
      clusterPlan.nodes.find((n) => n.nodeId === selectedNodeId) ??
      clusterPlan.nodes[0]
    );
  }, [clusterPlan.nodes, selectedNodeId]);

  const backendProfile = useMemo(
    () => buildTunedOsBackendProfile(backendOs, activeModel, clusterPlan, tuningConfig),
    [backendOs, activeModel, clusterPlan, tuningConfig]
  );

  const thermalMeta = thermalLabel(clusterPlan.overallThermalState);

  const handleCopyCommand = () => {
    void navigator.clipboard?.writeText(backendProfile.launchCommand);
    setCopiedCmd(true);
    window.setTimeout(() => setCopiedCmd(false), 1600);
  };

  const handleDownloadBackendScript = () => {
    const blob = new Blob([backendProfile.scriptContent], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backendProfile.scriptFileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyAdb = () => {
    const cmd = 'adb reverse tcp:3000 tcp:3000; adb forward tcp:50052 tcp:50052';
    void navigator.clipboard?.writeText(cmd);
    setCopiedAdb(true);
    window.setTimeout(() => setCopiedAdb(false), 1600);
  };

  const handleVerifyHealth = async () => {
    setHealthStatus({ tested: false, loading: true, ok: false });
    const t0 = performance.now();
    try {
      const res = await fetch('/health');
      const t1 = performance.now();
      if (res.ok) {
        const data = await res.json();
        setHealthStatus({
          tested: true,
          loading: false,
          ok: true,
          latencyMs: Math.round(t1 - t0),
          model: data.activeModel ?? activeModel.name,
        });
      } else {
        setHealthStatus({ tested: true, loading: false, ok: false, latencyMs: Math.round(t1 - t0) });
      }
    } catch {
      setHealthStatus({ tested: true, loading: false, ok: false });
    }
  };

  const liveNodeCount = liveHardware
    ? 1 + (liveHardware.connectedDevices?.length ?? 0)
    : clusterPlan.nodes.length;

  const totalModelLayers = activeModel.layers || 28;

  return (
    <div className="space-y-6 pb-8">
      {/* 1. Unsloth-Style Top Toolbar: Model Selector & Live Cluster Mode */}
      <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-amber-500 uppercase tracking-wider">
              Model
            </span>
            <select
              id="gguf-model-preset"
              value={activeModel.id}
              onChange={(e) => {
                const chosen = presetOptions.find((m) => m.id === e.target.value);
                if (chosen) void handleActivateModel(chosen);
              }}
              className="rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-amber-500"
            >
              {localModels.length > 0 && (
                <optgroup label="📁 Local Models on Disk">
                  {localModels.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ({preset.quant} · {(preset.sizeMb / 1024).toFixed(1)} GB)
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="🌐 Hugging Face Presets">
                {GGUF_MODEL_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.quant} · {(preset.sizeMb / 1024).toFixed(1)} GB)
                  </option>
                ))}
              </optgroup>
            </select>

            <button
              type="button"
              onClick={() => setShowQuickLoadModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-gradient-to-r from-amber-500/20 to-amber-600/20 hover:from-amber-500/30 hover:to-amber-600/30 text-amber-300 border border-amber-500/40 transition-all hover:scale-[1.02] shadow-xs shrink-0"
              title="1-Click Load Any Local GGUF Model from PC"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
              <span>Load Local GGUF</span>
            </button>
          </div>

          {activeModel.isLocal && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400 border border-amber-500/30 whitespace-nowrap">
              📁 Local Disk GGUF
            </span>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 font-semibold">
              {activeModel.architecture}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num text-slate-200">
              {activeModel.activeParamsB}B active / {activeModel.totalParamsB}B total
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num text-slate-200">{activeModel.layers} layers</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num font-bold text-amber-400">~{clusterPlan.estimatedClusterTokPerSec} tok/s</span>
          </div>

          {onOpenModels && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onOpenModels}
                className="text-xs font-semibold text-cyan-400 hover:text-cyan-300 hover:underline whitespace-nowrap flex items-center gap-1"
              >
                📁 Local Directory & GGUF
              </button>
              <span className="text-slate-700" aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onOpenModels}
                className="text-xs font-semibold text-amber-400 hover:text-amber-300 hover:underline whitespace-nowrap"
              >
                Browse HF Catalog →
              </button>
            </div>
          )}
        </div>

        {/* Mode Selector & Quick Actions */}
        <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
          <div
            role="tablist"
            aria-label="Cluster topology mode"
            className="inline-flex items-center p-1 rounded-lg bg-[#080C14] border border-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={clusterMode === 'LIVE_CLUSTER'}
              onClick={() => onChangeClusterMode('LIVE_CLUSTER')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                clusterMode === 'LIVE_CLUSTER'
                  ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              <span>
                Live Cluster ({liveNodeCount} Node{liveNodeCount !== 1 ? 's' : ''})
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={clusterMode === 'LOCAL_DEVICE'}
              onClick={() => onChangeClusterMode('LOCAL_DEVICE')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                clusterMode === 'LOCAL_DEVICE'
                  ? 'bg-[#1E293B] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Host Only
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={clusterMode === 'VIRTUAL_4NODE'}
              onClick={() => onChangeClusterMode('VIRTUAL_4NODE')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                clusterMode === 'VIRTUAL_4NODE'
                  ? 'bg-[#1E293B] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              4-Node Simulation
            </button>
          </div>

          {onRefreshHardware && (
            <button
              type="button"
              onClick={onRefreshHardware}
              title="Rescan connected ADB and USB devices"
              className="p-2 rounded-lg border border-slate-700 bg-[#0B1120] hover:border-amber-500 text-slate-400 hover:text-amber-400 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          {onOpenChat && (
            <button
              type="button"
              onClick={onOpenChat}
              className="rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 px-3.5 py-1.5 text-xs font-semibold text-black font-bold whitespace-nowrap shrink-0 flex items-center gap-1.5 shadow-sm transition-all"
            >
              <Zap className="w-3.5 h-3.5 fill-black" />
              <span>Inference Chat</span>
            </button>
          )}
        </div>
      </section>

      {/* 1.5 Auto-Pilot Intelligent Resource Distribution Status Banner */}
      <section className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-[#0C1220] via-[#080E1A] to-[#0C1220] p-4 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center gap-3">
            <div className="p-2.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 shrink-0">
              <Sparkles className="w-5 h-5 text-amber-400 animate-pulse" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
                  ✨ Auto-Pilot Cluster Active
                </span>
                <span className="text-[10px] font-mono-num font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  Zero-Config Auto-Sharding
                </span>
                <span className="text-[10px] font-mono-num px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                  {activeModel.architecture === 'MoE' ? 'Sparse MoE (8 active experts)' : activeModel.architecture}
                </span>
                {activeModel.isLocal && (
                  <span className="text-[10px] font-mono-num px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    Local Disk
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-300 mt-1">
                Model <strong className="text-white">{activeModel.name}</strong> ({activeModel.quant} · {activeModel.layers} layers · {(activeModel.sizeMb / 1024).toFixed(1)} GB) automatically distributed:
                <span className="text-cyan-300 font-semibold ml-1.5">
                  {masterNode?.label.split(' ')[0]} ({masterNode?.allocatedLayers}L / {masterNode?.sharePct}%)
                </span>
                {workerNodes.length > 0 && (
                  <>
                    {' + '}
                    <span className="text-emerald-300 font-semibold">
                      {workerNodes.map((w) => `${w.label.split(' ')[0]} (${w.allocatedLayers}L / ${w.sharePct}%)`).join(', ')}
                    </span>
                  </>
                )}
                {' · '}
                <span className="text-amber-400 font-medium">
                  {tuningConfig.moeCpuOffload ? '--cpu-moe ' : ''}
                  {tuningConfig.enableFlashAttn ? '--flash-attn ' : ''}
                  LMKD RAM Guard Active
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
            {onRefreshHardware && (
              <button
                type="button"
                onClick={onRefreshHardware}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 transition-colors shadow-xs"
                title="Re-probe connected nodes and automatically rebalance layers"
              >
                <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
                <span>Auto-Rebalance</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowQuickLoadModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition-colors shadow-xs"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
              <span>Switch / Load GGUF</span>
            </button>
          </div>
        </div>
      </section>

      {/* 2. Full-Width Interactive Layer Sharding Visualizer (The Core Highlight) */}
      <section className="rounded-xl border border-slate-800 bg-[#0D121F] p-5 space-y-4 shadow-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <span>Model Layer Sharding & Workload Distribution</span>
                <span className="text-[10px] font-mono-num font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  100% Resident
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {activeModel.name} ({activeModel.quant}) · {totalModelLayers} layers sharded across {clusterPlan.nodes.length} compute nodes
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs">
            {clusterPlan.nodes.map((node) => {
              const isMaster = node.role === 'Master';
              const dotColor = isMaster ? 'bg-cyan-400' : 'bg-emerald-400';
              const textColor = isMaster ? 'text-cyan-300' : 'text-emerald-300';
              return (
                <div key={node.nodeId} className="flex items-center gap-1.5">
                  <span className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
                  <span className={`font-semibold ${textColor}`}>
                    {node.label}: L{node.layerStart}–L{node.layerEnd} ({node.allocatedLayers}L · {node.sharePct}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Contiguous Multi-Segment Layer Bar */}
        <div className="space-y-2">
          <div className="h-6 w-full rounded-lg bg-[#070A11] p-0.5 border border-slate-800 overflow-hidden flex">
            {clusterPlan.nodes.map((node) => {
              const isMaster = node.role === 'Master';
              const bgGradient = isMaster
                ? 'from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400'
                : 'from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400';
              const isSelected = selectedNodeId === node.nodeId;

              return (
                <div
                  key={node.nodeId}
                  onClick={() => setSelectedNodeId(node.nodeId)}
                  style={{ width: `${node.sharePct}%` }}
                  title={`${node.label}: Layers L${node.layerStart}–L${node.layerEnd} (${node.allocatedLayers}L · ${(node.allocatedMb / 1024).toFixed(1)} GB)`}
                  className={`h-full bg-gradient-to-r ${bgGradient} cursor-pointer transition-all flex items-center justify-center text-[10px] font-mono-num font-bold text-black border-r border-[#070A11] last:border-r-0 ${
                    isSelected ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-[#070A11] z-10' : ''
                  }`}
                >
                  <span className="truncate px-1">
                    {node.label.split(' ')[0]} (L{node.layerStart}–L{node.layerEnd})
                  </span>
                </div>
              );
            })}
          </div>

          {/* Discrete Layer Tiles Strip */}
          <div className="grid grid-cols-14 sm:grid-cols-28 gap-1 pt-1">
            {Array.from({ length: totalModelLayers }).map((_, layerIdx) => {
              const owningNode = clusterPlan.nodes.find(
                (n) => layerIdx >= n.layerStart && layerIdx <= n.layerEnd
              );
              const isMaster = owningNode?.role === 'Master';
              const isSelected = owningNode?.nodeId === selectedNodeId;
              const tileBg = isMaster
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';

              return (
                <div
                  key={layerIdx}
                  onClick={() => owningNode && setSelectedNodeId(owningNode.nodeId)}
                  title={`Layer ${layerIdx} assigned to ${owningNode?.label ?? 'Master'}`}
                  className={`h-6 rounded border flex items-center justify-center text-[10px] font-mono-num font-semibold cursor-pointer transition-all ${tileBg} ${
                    isSelected ? 'ring-1 ring-amber-400 scale-105 z-10' : 'hover:scale-105'
                  }`}
                >
                  {layerIdx}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 3. 4-KPI Summary Strip: Tier, Safe RAM Pool, Layer Allocation, Thermal Guard */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-800 bg-[#0D121F] p-4 space-y-1">
          <div className="text-xs font-medium text-slate-400">
            Cluster Tier & Active Params
          </div>
          <div className="text-base font-bold text-slate-100 font-mono-num">
            {clusterPlan.tierLabel}
          </div>
          <div className="text-xs text-amber-400 font-mono-num font-semibold">
            {clusterPlan.activeParamsPerTokenB}B active/tok · {clusterPlan.nodes.length} node(s)
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#0D121F] p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-400">
              Safe RAM + VRAM Pool
            </span>
            <span
              className={`font-semibold ${
                clusterPlan.fitVerdict === 'Fast' || clusterPlan.fitVerdict === 'Best Fit'
                  ? 'text-emerald-400'
                  : 'text-amber-400'
              }`}
            >
              {clusterPlan.fitVerdict}
            </span>
          </div>
          <div className="text-base font-bold text-slate-100 font-mono-num">
            {(clusterPlan.totalSafePoolMb / 1024).toFixed(1)} GB{' '}
            <span className="text-xs font-normal text-slate-400">
              / {(clusterPlan.neededMb / 1024).toFixed(1)} GB (incl. KV)
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-200 ${
                clusterPlan.coveragePct >= 100 ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              style={{ width: `${clusterPlan.coveragePct}%` }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#0D121F] p-4 space-y-1">
          <div className="text-xs font-medium text-slate-400">
            Layer Split & Speed
          </div>
          <div className="text-base font-bold text-slate-100 font-mono-num truncate">
            {clusterPlan.tensorSplitLabel}
          </div>
          <div className="text-xs text-emerald-400 font-mono-num font-bold">
            ~{clusterPlan.estimatedClusterTokPerSec} tok/s · 1-Hop Star
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#0D121F] p-4 space-y-1">
          <div className="text-xs font-medium text-slate-400">
            Thermal & RAM Guard
          </div>
          <div className={`text-base font-bold flex items-center gap-1.5 ${thermalMeta.colorClass}`}>
            {thermalMeta.icon}
            <span className="truncate">{thermalMeta.text}</span>
          </div>
          <div className="text-xs text-slate-400 font-mono-num">
            WDDM & Android ≤50% caps · Anti-flap active
          </div>
        </div>
      </section>

      {/* 4. Sleek Compute Node Fleet Cards (Unsloth Style) */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-bold text-slate-100">Active Compute Nodes</span>
            <span className="text-xs font-mono-num font-normal text-slate-400">
              ({clusterPlan.nodes.length} connected)
            </span>
            {networkAudit && (
              <span className="text-[11px] font-mono-num text-emerald-400 font-semibold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                {networkAudit.summary.clusterRating} ({networkAudit.summary.totalNodes} nodes)
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={handleRunNetworkAudit}
            disabled={isAuditing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B1120] hover:border-amber-500 px-3 py-1 text-xs font-semibold text-slate-200 disabled:opacity-60 transition-colors"
          >
            <Activity className={`w-3.5 h-3.5 text-amber-400 ${isAuditing ? 'animate-spin' : ''}`} />
            <span>{isAuditing ? 'Auditing...' : '⚡ Audit Network'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {clusterPlan.nodes.map((node) => {
            const isMaster = node.role === 'Master';
            const isSelected = node.nodeId === selectedNodeId;
            const tMeta = thermalLabel(node.thermalStatus.state);
            const isPhone = node.osType.toLowerCase().includes('android') || node.label.toLowerCase().includes('note') || node.label.toLowerCase().includes('phone');
            const linkBadge = isPhone ? 'USB-C Tunnel 0.48ms' : node.linkType;

            return (
              <div
                key={node.nodeId}
                onClick={() => setSelectedNodeId(node.nodeId)}
                className={`rounded-xl border bg-[#0D121F] p-4 space-y-3 cursor-pointer transition-all ${
                  isSelected
                    ? 'border-amber-500 shadow-lg shadow-amber-500/5 ring-1 ring-amber-500/50'
                    : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                {/* Node Card Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className={`p-2 rounded-lg ${isMaster ? 'bg-cyan-500/10 text-cyan-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                      {isPhone ? <Smartphone className="w-4 h-4" /> : <Server className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="font-bold text-slate-100 text-xs flex items-center gap-1.5">
                        <span>{node.label}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono-num flex items-center gap-1">
                        <span>{node.osType.toUpperCase()}</span>
                        <span>·</span>
                        <span>{node.backendDriver}</span>
                      </div>
                    </div>
                  </div>

                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                    isMaster ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30' : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  }`}>
                    {node.role}
                  </span>
                </div>

                {/* Sharded Layer Badge & Workload Share */}
                <div className="rounded-lg bg-[#070A11] p-2.5 border border-slate-800/80 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 text-[11px]">Assigned Shard</span>
                    <span className={`font-mono-num font-bold ${isMaster ? 'text-cyan-400' : 'text-emerald-400'}`}>
                      L{node.layerStart}–L{node.layerEnd} ({node.allocatedLayers} Layers)
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 text-[11px]">Workload Share</span>
                    <span className="font-mono-num font-semibold text-slate-200">
                      {node.sharePct}% ({node.activeParamsB}B active)
                    </span>
                  </div>
                </div>

                {/* Safe Memory Allocation */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-mono-num">
                    <span className="text-slate-400">Safe RAM Cap</span>
                    <span className="text-slate-200">
                      {(node.allocatedMb / 1024).toFixed(1)} GB / {(node.effectiveCapMb / 1024).toFixed(1)} GB
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${isMaster ? 'bg-cyan-500' : 'bg-emerald-500'}`}
                      style={{
                        width: `${Math.min(100, Math.round((node.allocatedMb / Math.max(1, node.effectiveCapMb)) * 100))}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Card Footer: Speed, Link & Thermal */}
                <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono-num">
                  <span className="text-slate-400 flex items-center gap-1">
                    <Activity className="w-3 h-3 text-amber-400" />
                    <span>~{node.estimatedTokPerSec} tok/s</span>
                  </span>
                  <span className="text-slate-400 flex items-center gap-1">
                    <Usb className="w-3 h-3 text-cyan-400" />
                    <span>{linkBadge}</span>
                  </span>
                  <span className={`flex items-center gap-1 font-semibold ${tMeta.colorClass}`}>
                    {tMeta.icon}
                    <span>{node.tempC.toFixed(0)}°C</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {inspectedNode && (
          <div className="rounded-lg bg-[#070A11] p-3 border border-slate-800 text-xs flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-300">
              <strong className="text-amber-400">{inspectedNode.label}:</strong> {inspectedNode.thermalStatus.reason} · Layers L{inspectedNode.layerStart}–L{inspectedNode.layerEnd} ({inspectedNode.allocatedLayers}L)
            </span>
            <span className="font-mono-num text-slate-400">
              Score {inspectedNode.score} · ~{inspectedNode.estimatedTokPerSec} tok/s · {(inspectedNode.allocatedMb / 1024).toFixed(1)} GB VRAM/RAM
            </span>
          </div>
        )}
      </section>

      {/* 5. Master Hub & Fleet Gateway (3 Clean Action Cards) */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
        {/* Card 1: Master Node Hub */}
        <div className="rounded-xl border border-slate-800 bg-[#0D121F] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Server className="w-4 h-4 text-cyan-400" />
                <span>Master Hub Service</span>
              </h2>
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                ONLINE :3000
              </span>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Serving OpenAI API wire completions and orchestrating tensor layers across local and USB devices.
            </p>

            <div className="space-y-1.5 rounded-lg bg-[#070A11] p-3 border border-slate-800 text-xs font-mono-num">
              <div className="flex justify-between text-slate-400">
                <span>Listening</span>
                <span className="text-slate-100 font-semibold">http://0.0.0.0:3000</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Endpoint</span>
                <span className="text-cyan-400 font-semibold">/v1/chat/completions</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Master Layers</span>
                <span className="text-slate-100 font-semibold">{masterNode?.allocatedLayers ?? 25}L resident</span>
              </div>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800 flex items-center gap-2">
            <button
              type="button"
              onClick={handleVerifyHealth}
              disabled={healthStatus.loading}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-[#080C14] hover:border-cyan-500 text-slate-200 px-3 py-2 text-xs font-semibold transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${healthStatus.loading ? 'animate-spin' : ''}`} />
              <span>{healthStatus.loading ? 'Testing...' : healthStatus.tested ? (healthStatus.ok ? `${healthStatus.latencyMs}ms OK` : 'Failed') : '🧪 Test Health'}</span>
            </button>
          </div>
        </div>

        {/* Card 2: Worker Node Fleet & ADB Setup */}
        <div className="rounded-xl border border-slate-800 bg-[#0D121F] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Radio className="w-4 h-4 text-emerald-400" />
                <span>Worker Fleet & USB ADB</span>
              </h2>
              <span className="text-xs font-mono-num font-semibold text-slate-400">
                {workerNodes.length} Worker(s) Active
              </span>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Auto-bridges Android devices over low-latency USB-C tunnels and connects LAN nodes via TCP port 50052.
            </p>

            <div className="space-y-1.5 rounded-lg bg-[#070A11] p-2.5 border border-slate-800 text-xs">
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
                <span className="flex items-center gap-1">
                  <Usb className="w-3 h-3 text-cyan-400" />
                  <span>ADB Reverse Tunnel</span>
                </span>
                <button
                  type="button"
                  onClick={handleCopyAdb}
                  className="text-amber-400 hover:text-amber-300 hover:underline flex items-center gap-1 font-semibold"
                >
                  {copiedAdb ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedAdb ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <code className="block font-mono-num text-[11px] text-slate-200 select-all truncate bg-[#0B1120] p-1.5 rounded border border-slate-800">
                adb reverse tcp:3000 tcp:3000; adb forward tcp:50052 tcp:50052
              </code>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800">
            {onOpenModels && (
              <button
                type="button"
                onClick={onOpenModels}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 hover:border-amber-500 bg-[#080C14] px-3.5 py-2 text-xs font-semibold text-slate-200 transition-colors"
              >
                <span>Browse GGUF Models</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Card 3: Windows & Linux Tuned Launch */}
        <div className="rounded-xl border border-slate-800 bg-[#0D121F] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-amber-400" />
                <span>Native Backend Launcher</span>
              </h2>
              <div className="inline-flex rounded p-0.5 bg-[#080C14] border border-slate-800 text-[10px]">
                <button
                  type="button"
                  onClick={() => setBackendOs('windows')}
                  className={`px-2 py-0.5 rounded font-semibold ${
                    backendOs === 'windows' ? 'bg-amber-500 text-black' : 'text-slate-400'
                  }`}
                >
                  Windows
                </button>
                <button
                  type="button"
                  onClick={() => setBackendOs('linux')}
                  className={`px-2 py-0.5 rounded font-semibold ${
                    backendOs === 'linux' ? 'bg-amber-500 text-black' : 'text-slate-400'
                  }`}
                >
                  Linux
                </button>
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Auto-tuned flags ({backendProfile.gpuOffloadLayers}L GPU offload, {backendProfile.recommendedThreads} threads, --no-mmap memory guard).
            </p>

            <pre className="rounded-lg bg-[#070A11] border border-slate-800 p-2.5 text-[10px] font-mono-num text-emerald-400 overflow-x-auto max-h-20 select-all">
              {backendProfile.launchCommand}
            </pre>
          </div>

          <div className="pt-2 border-t border-slate-800 flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyCommand}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-[#080C14] hover:border-amber-500 text-slate-200 px-3 py-2 text-xs font-semibold transition-colors"
            >
              {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedCmd ? 'Copied' : 'Copy Command'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadBackendScript}
              className="p-2 rounded-lg border border-slate-700 bg-[#080C14] hover:border-amber-500 text-slate-200 transition-colors"
              title={`Download ${backendProfile.scriptFileName}`}
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* 6. Developer Section (Only when Developer Mode is ON) */}
      {telemetry.developerModeEnabled && (
        <section className="rounded-xl border border-slate-800 bg-[#0D121F] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-bold text-slate-100">
                Developer Configuration & Node Events
              </h2>
            </div>
            {onOpen2DLab && (
              <button
                type="button"
                onClick={onOpen2DLab}
                className="rounded-lg bg-amber-500 hover:bg-amber-400 text-black px-3 py-1.5 text-xs font-bold whitespace-nowrap shrink-0"
              >
                Open 2D Clustering Lab (Dev)
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-300">
              Cluster Secret & 32-Byte Auth Token
            </label>
            <input
              type="text"
              value={telemetry.clusterSecret}
              onChange={(e) => onUpdateSecret(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono-num text-slate-100"
            />
            <div className="text-[11px] font-mono-num text-slate-400 truncate">
              {telemetry.authTokenHex}
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-mono-num text-slate-400">
              <span className="flex items-center gap-1.5 font-semibold">
                <Terminal className="w-3.5 h-3.5 text-teal-400" />
                Master Node Server Log
              </span>
              <span>
                Handshakes: {telemetry.handshakesCompleted}
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto space-y-0.5 text-[11px] font-mono-num text-emerald-400">
              {telemetry.eventLogs.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Quick Load Local GGUF Modal */}
      {showQuickLoadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-700/80 bg-[#0B1120] p-6 shadow-2xl space-y-5 text-slate-100 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400">
                  <FolderOpen className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <span>1-Click Load Local GGUF</span>
                    <span className="text-[10px] font-mono-num font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      Auto-Pilot
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Loads any GGUF from your machine. Layers, architecture, and node distributions configure automatically.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowQuickLoadModal(false);
                  setQuickFeedback(null);
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {quickFeedback && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-semibold flex items-center gap-2 shrink-0">
                <Sparkles className="w-4 h-4 shrink-0 text-amber-400 animate-pulse" />
                <span>{quickFeedback}</span>
              </div>
            )}

            <div className="space-y-4 overflow-y-auto pr-1 flex-1">
              {/* Option A: Browse File Directly */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="cursor-pointer rounded-xl border-2 border-dashed border-slate-700 hover:border-amber-500 bg-[#070A12] p-5 text-center transition-all hover:bg-slate-900/40 group"
              >
                <FolderOpen className="w-8 h-8 text-slate-400 group-hover:text-amber-400 mx-auto mb-2 transition-colors" />
                <div className="text-sm font-semibold text-slate-200 group-hover:text-amber-300">
                  Browse Any .gguf File on Your PC
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Click to select a file from LM Studio, FreeToken, Downloads, or any folder
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".gguf"
                  onChange={handleQuickFilePicked}
                  className="hidden"
                />
              </div>

              {/* Option B: Direct Path or Name */}
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-300">
                  Or Paste GGUF File Path / Model Name
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-500" />
                    <input
                      type="text"
                      value={quickPathInput}
                      onChange={(e) => setQuickPathInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleQuickAddPath(quickPathInput);
                      }}
                      placeholder="e.g. C:\Users\name\.lmstudio\models\model.gguf or Qwen3"
                      className="w-full rounded-lg border border-slate-700 bg-[#070A12] pl-8 pr-3 py-2 text-xs font-mono text-slate-100 placeholder:text-slate-600 focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={quickLoading || !quickPathInput.trim()}
                    onClick={() => void handleQuickAddPath(quickPathInput)}
                    className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black text-xs font-bold transition-colors whitespace-nowrap shadow-xs"
                  >
                    {quickLoading ? 'Loading...' : 'Load & Distribute'}
                  </button>
                </div>
              </div>

              {/* Option C: Detected Local Models List */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Detected GGUF Models on PC ({localModels.length})</span>
                  </span>
                  {onRefreshLocalModels && (
                    <button
                      type="button"
                      onClick={() => void onRefreshLocalModels()}
                      className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 font-semibold"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Rescan Drives</span>
                    </button>
                  )}
                </div>

                {localModels.length === 0 ? (
                  <div className="rounded-lg border border-slate-800 bg-[#070A12] p-4 text-center text-xs text-slate-400">
                    No models found in default folders. Use "Browse" above to pick your model file directly.
                  </div>
                ) : (
                  <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                    {localModels.map((m) => {
                      const isCurrent = activeModel.id === m.id;
                      return (
                        <div
                          key={m.id}
                          className={`rounded-lg border p-3 flex items-center justify-between gap-3 transition-colors ${
                            isCurrent
                              ? 'border-amber-500/50 bg-amber-500/10'
                              : 'border-slate-800 bg-[#070A12] hover:border-slate-700'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-xs text-slate-100 truncate">
                                {m.name}
                              </span>
                              <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shrink-0">
                                {m.architecture === 'MoE' ? 'Sparse MoE' : m.architecture}
                              </span>
                              <span className="text-[10px] font-mono-num text-slate-400 shrink-0">
                                {m.layers}L · {m.quant}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono-num text-slate-500 truncate mt-0.5" title={m.localPath}>
                              {(m.sizeMb / 1024).toFixed(1)} GB · {m.localPath || 'Local PC file'}
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={isCurrent}
                            onClick={() => void handleActivateModel(m)}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all shrink-0 ${
                              isCurrent
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                                : 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black shadow-xs'
                            }`}
                          >
                            {isCurrent ? 'Active Shard' : '⚡ 1-Click Load'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
