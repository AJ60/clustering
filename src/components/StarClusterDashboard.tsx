import React, { useMemo, useState } from 'react';
import {
  AutoFixAction,
  DeviceTelemetryState,
  DiagnosticSeverity,
} from '../types/clustering';
import {
  BackendOsTarget,
  BackendTuningConfig,
  ClusterMode,
  ContextLengthOption,
  GGUF_MODEL_PRESETS,
  GgufModelPreset,
  KvCacheQuantOption,
  LinuxAccelerator,
  PlannedStarNode,
  StarClusterPlan,
  ThermalState,
  WindowsAccelerator,
} from '../types/starCluster';
import { buildTunedOsBackendProfile } from '../domain/backendTuner';
import { CameraQrScannerDialog } from './HardenedNodeDashboard';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  Flame,
  HardDrive,
  Laptop,
  Play,
  QrCode,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Snowflake,
  Square,
  Terminal,
  Usb,
  Wifi,
  Wrench,
} from 'lucide-react';

interface StarClusterDashboardProps {
  telemetry: DeviceTelemetryState;
  activeModel: GgufModelPreset;
  clusterMode: ClusterMode;
  tuningConfig: BackendTuningConfig;
  clusterPlan: StarClusterPlan;
  simulatedTempOffsetC: number;
  onSelectModel: (model: GgufModelPreset) => void;
  onChangeClusterMode: (mode: ClusterMode) => void;
  onUpdateTuningConfig: (patch: Partial<BackendTuningConfig>) => void;
  onChangeSimulatedTempOffsetC: (offsetC: number) => void;
  onRecalibrate: () => void;
  onStartWorker: () => void;
  onStopWorker: () => void;
  onAutoDetectMaster: () => void;
  onPairQrPayload: (raw: string) => boolean;
  onToggleBindMode: (usbOnly: boolean) => void;
  onUpdateSecret: (secret: string) => void;
  onSimulateShedLayers: () => void;
  onRunDiagnostics: () => void;
  onApplyAutoFix: (action: AutoFixAction) => void;
  onOpenModels?: () => void;
  onOpenChat?: () => void;
  onOpen2DLab?: () => void;
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
        colorClass: 'text-emerald-600 dark:text-emerald-400',
        icon: <Snowflake className="w-3.5 h-3.5 text-emerald-500 shrink-0" />,
      };
    case 'WARN':
      return {
        text: 'Warming (90% Cap)',
        colorClass: 'text-amber-600 dark:text-amber-400',
        icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />,
      };
    case 'SHED_25':
      return {
        text: 'Thermal Shed (-25%)',
        colorClass: 'text-amber-600 dark:text-amber-400',
        icon: <Flame className="w-3.5 h-3.5 text-amber-500 shrink-0" />,
      };
    case 'EMERGENCY_OFFLOAD':
      return {
        text: 'Emergency Offload (0 Layers)',
        colorClass: 'text-red-600 dark:text-red-400',
        icon: <ShieldAlert className="w-3.5 h-3.5 text-red-500 shrink-0" />,
      };
  }
}

function diagnosticLabel(sev: DiagnosticSeverity) {
  if (sev === 'OK') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap shrink-0">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Passed
      </span>
    );
  }
  if (sev === 'WARNING') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400 whitespace-nowrap shrink-0">
        <AlertTriangle className="w-3.5 h-3.5" />
        Tip
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400 whitespace-nowrap shrink-0">
      <ShieldAlert className="w-3.5 h-3.5" />
      Action Needed
    </span>
  );
}

export const StarClusterDashboard: React.FC<StarClusterDashboardProps> = ({
  telemetry,
  activeModel,
  clusterMode,
  tuningConfig,
  clusterPlan,
  simulatedTempOffsetC,
  onSelectModel,
  onChangeClusterMode,
  onUpdateTuningConfig,
  onChangeSimulatedTempOffsetC,
  onRecalibrate,
  onStartWorker,
  onStopWorker,
  onAutoDetectMaster,
  onPairQrPayload,
  onToggleBindMode,
  onUpdateSecret,
  onSimulateShedLayers,
  onRunDiagnostics,
  onApplyAutoFix,
  onOpenModels,
  onOpenChat,
  onOpen2DLab,
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string>('linux-hub');
  const [backendOs, setBackendOs] = useState<BackendOsTarget>('windows');
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);

  const presetOptions = useMemo(() => {
    const exists = GGUF_MODEL_PRESETS.some((p) => p.id === activeModel.id);
    return exists ? GGUF_MODEL_PRESETS : [activeModel, ...GGUF_MODEL_PRESETS];
  }, [activeModel]);

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

  const masterNode =
    clusterPlan.nodes.find((n) => n.role === 'Master') ?? clusterPlan.nodes[0];
  const workerNodes = clusterPlan.nodes.filter((n) => n.nodeId !== masterNode?.nodeId);

  const isRunning =
    telemetry.workerState === 'RUNNING_USB' || telemetry.workerState === 'RUNNING_WIFI';
  const cal = telemetry.calibration;
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

  return (
    <div className="space-y-6 pb-8">
      {/* 1. Cluster Toolbar: Model Preset & Mode Switch */}
      <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label
              htmlFor="gguf-model-preset"
              className="text-xs font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap"
            >
              Active Model
            </label>
            <select
              id="gguf-model-preset"
              value={activeModel.id}
              onChange={(e) => {
                const chosen = presetOptions.find((m) => m.id === e.target.value);
                if (chosen) onSelectModel(chosen);
              }}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] px-3 py-2 text-xs font-semibold text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            >
              {presetOptions.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.quant} · {(preset.sizeMb / 1024).toFixed(1)} GB)
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{activeModel.architecture}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num">
              {activeModel.activeParamsB}B active / {activeModel.totalParamsB}B total
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num">{activeModel.layers} layers</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num">~{clusterPlan.estimatedClusterTokPerSec} tok/s</span>
          </div>

          {onOpenModels && (
            <button
              type="button"
              onClick={onOpenModels}
              className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              Browse HF Catalog →
            </button>
          )}
        </div>

        {/* Segmented Mode Selector + Chat Shortcut */}
        <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
          <div
            role="tablist"
            aria-label="Cluster topology mode"
            className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-[#131C31] border border-slate-200 dark:border-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={clusterMode === 'LOCAL_DEVICE'}
              onClick={() => onChangeClusterMode('LOCAL_DEVICE')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                clusterMode === 'LOCAL_DEVICE'
                  ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              This Device
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={clusterMode === 'VIRTUAL_4NODE'}
              onClick={() => onChangeClusterMode('VIRTUAL_4NODE')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                clusterMode === 'VIRTUAL_4NODE'
                  ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              4-Node Cluster
            </button>
          </div>

          {onOpenChat && (
            <button
              type="button"
              onClick={onOpenChat}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] hover:border-blue-500 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap shrink-0"
            >
              Open Chat & Brain
            </button>
          )}
        </div>
      </section>

      {/* 2. 4-KPI Summary Strip: Tier, Safe RAM Pool, Layer Allocation, Thermal Guard */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-4 space-y-1">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Cluster Tier & Active Params
          </div>
          <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono-num">
            {clusterPlan.tierLabel}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            {clusterPlan.activeParamsPerTokenB}B active/tok ·{' '}
            {clusterPlan.nodes.filter((n) => n.effectiveCapMb > 0).length} node(s)
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-500 dark:text-slate-400">
              Safe RAM + VRAM Pool
            </span>
            <span
              className={`font-semibold ${
                clusterPlan.fitVerdict === 'Fast' || clusterPlan.fitVerdict === 'Best Fit'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            >
              {clusterPlan.fitVerdict}
            </span>
          </div>
          <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono-num">
            {(clusterPlan.totalSafePoolMb / 1024).toFixed(1)} GB{' '}
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              / {(clusterPlan.neededMb / 1024).toFixed(1)} GB (incl. KV)
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-200 ${
                clusterPlan.coveragePct >= 100 ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              style={{ width: `${clusterPlan.coveragePct}%` }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-4 space-y-1">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Layer Split & Throughput
          </div>
          <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono-num truncate">
            {clusterPlan.tensorSplitLabel} · ~{clusterPlan.estimatedClusterTokPerSec} tok/s
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
            Hub: {clusterPlan.masterId}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-4 space-y-1">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Thermal Guard
          </div>
          <div className={`text-base font-bold flex items-center gap-1.5 ${thermalMeta.colorClass}`}>
            {thermalMeta.icon}
            <span className="truncate">{thermalMeta.text}</span>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            WDDM & Android ≤50% caps · Anti-flap 30s
          </div>
        </div>
      </section>

      {/* 3. Live 1-Hop Star Topology & Cap-Bounded Node Allocation */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
              1-Hop Star Topology & Node Active Parameters
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click any node to inspect its OS backend, active parameter slice, safe RAM/VRAM cap, and layer bounds.
            </p>
          </div>
          <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
            {activeModel.name} · {clusterPlan.coveragePct}% pool coverage
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
          {/* Interactive SVG Hub & Spoke Diagram */}
          <div className="lg:col-span-5">
            <svg
              viewBox="0 0 560 250"
              className="w-full h-56 sm:h-60"
              role="img"
              aria-label="1-Hop Star Cluster Topology"
            >
              {(() => {
                const hubX = 160;
                const hubY = 125;
                const workerPositions =
                  workerNodes.length === 1
                    ? [{ x: 410, y: 125 }]
                    : workerNodes.length === 2
                      ? [
                          { x: 410, y: 72 },
                          { x: 410, y: 178 },
                        ]
                      : [
                          { x: 410, y: 50 },
                          { x: 430, y: 125 },
                          { x: 410, y: 200 },
                        ];

                return (
                  <>
                    {workerNodes.map((w, idx) => {
                      const pos = workerPositions[idx] ?? { x: 410, y: 125 };
                      const offloaded =
                        w.thermalStatus.state === 'EMERGENCY_OFFLOAD' || w.effectiveCapMb === 0;
                      const strokeColor = offloaded
                        ? '#EF4444'
                        : w.thermalStatus.state === 'SHED_25' || w.thermalStatus.state === 'WARN'
                          ? '#F59E0B'
                          : '#3B82F6';
                      const midX = (hubX + pos.x) / 2;
                      const midY = (hubY + pos.y) / 2;

                      return (
                        <g key={`edge-${w.nodeId}`}>
                          <line
                            x1={hubX}
                            y1={hubY}
                            x2={pos.x}
                            y2={pos.y}
                            stroke={strokeColor}
                            strokeWidth={selectedNodeId === w.nodeId ? 2.8 : 1.8}
                            strokeDasharray={offloaded ? '5 4' : undefined}
                            strokeOpacity={offloaded ? 0.6 : 0.85}
                          />
                          <rect
                            x={midX - 40}
                            y={midY - 10}
                            width={80}
                            height={20}
                            rx={4}
                            className="fill-slate-100 dark:fill-[#0B1120] stroke-slate-300 dark:stroke-slate-700"
                            strokeWidth={1}
                          />
                          <text
                            x={midX}
                            y={midY + 3.5}
                            textAnchor="middle"
                            className="fill-slate-700 dark:fill-slate-300 text-[10px] font-mono-num"
                          >
                            {offloaded ? '0 layers' : `${w.rttMs.toFixed(1)}ms · ${w.sharePct}%`}
                          </text>
                        </g>
                      );
                    })}

                    {masterNode && (
                      <g
                        onClick={() => setSelectedNodeId(masterNode.nodeId)}
                        className="cursor-pointer"
                      >
                        <rect
                          x={hubX - 115}
                          y={hubY - 34}
                          width={145}
                          height={68}
                          rx={10}
                          className={`transition-colors ${
                            selectedNodeId === masterNode.nodeId
                              ? 'fill-blue-600/15 stroke-blue-500'
                              : 'fill-slate-50 dark:fill-[#0B1120] stroke-slate-300 dark:stroke-slate-700'
                          }`}
                          strokeWidth={selectedNodeId === masterNode.nodeId ? 2 : 1.2}
                        />
                        <text
                          x={hubX - 42}
                          y={hubY - 10}
                          textAnchor="middle"
                          className="fill-slate-900 dark:fill-slate-100 text-[12px] font-bold"
                        >
                          {masterNode.label.slice(0, 19)}
                        </text>
                        <text
                          x={hubX - 42}
                          y={hubY + 7}
                          textAnchor="middle"
                          className="fill-blue-600 dark:fill-blue-400 text-[10.5px] font-mono-num font-semibold"
                        >
                          {masterNode.activeParamsB}B act · {masterNode.allocatedLayers}L
                        </text>
                        <text
                          x={hubX - 42}
                          y={hubY + 22}
                          textAnchor="middle"
                          className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono-num"
                        >
                          {masterNode.backendDriver}
                        </text>
                      </g>
                    )}

                    {workerNodes.map((w, idx) => {
                      const pos = workerPositions[idx] ?? { x: 410, y: 125 };
                      const isSelected = selectedNodeId === w.nodeId;
                      return (
                        <g
                          key={w.nodeId}
                          onClick={() => setSelectedNodeId(w.nodeId)}
                          className="cursor-pointer"
                        >
                          <rect
                            x={pos.x - 10}
                            y={pos.y - 26}
                            width={148}
                            height={52}
                            rx={10}
                            className={`transition-colors ${
                              isSelected
                                ? 'fill-blue-600/15 stroke-blue-500'
                                : 'fill-slate-50 dark:fill-[#0B1120] stroke-slate-300 dark:stroke-slate-700'
                            }`}
                            strokeWidth={isSelected ? 2 : 1.2}
                          />
                          <text
                            x={pos.x + 64}
                            y={pos.y - 5}
                            textAnchor="middle"
                            className="fill-slate-900 dark:fill-slate-100 text-[11.5px] font-bold"
                          >
                            {w.label.slice(0, 20)}
                          </text>
                          <text
                            x={pos.x + 64}
                            y={pos.y + 12}
                            textAnchor="middle"
                            className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono-num"
                          >
                            {w.activeParamsB}B act · {w.allocatedLayers}L · {w.tempC.toFixed(0)}°C
                          </text>
                        </g>
                      );
                    })}
                  </>
                );
              })()}
            </svg>
          </div>

          {/* Cap-Bounded Node Allocation Table */}
          <div className="lg:col-span-7 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-2 pr-3">Node & OS Backend</th>
                  <th className="py-2 pr-3 text-right">Safe Cap</th>
                  <th className="py-2 pr-3 text-right">Active Params</th>
                  <th className="py-2 pr-3 text-right">Layers</th>
                  <th className="py-2 text-right">Thermal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80 text-xs">
                {clusterPlan.nodes.map((node) => {
                  const selected = node.nodeId === inspectedNode?.nodeId;
                  const tMeta = thermalLabel(node.thermalStatus.state);
                  return (
                    <tr
                      key={node.nodeId}
                      onClick={() => setSelectedNodeId(node.nodeId)}
                      className={`cursor-pointer transition-colors ${
                        selected
                          ? 'bg-blue-500/8 dark:bg-blue-500/12'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-2.5 pr-3">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {node.label}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
                          {node.osType.toUpperCase()} · {node.backendDriver} · {node.linkType}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono-num text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        {(node.effectiveCapMb / 1024).toFixed(1)} GB
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono-num font-semibold text-blue-600 dark:text-blue-400 whitespace-nowrap">
                        {node.activeParamsB}B
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono-num font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {node.allocatedLayers > 0
                          ? `L${node.layerStart}–${node.layerEnd} (${node.sharePct}%)`
                          : '0L'}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 font-mono-num font-semibold ${tMeta.colorClass}`}>
                          {tMeta.icon}
                          {node.tempC.toFixed(0)}°C
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {inspectedNode && (
              <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>
                  <strong className="text-slate-800 dark:text-slate-200">{inspectedNode.label}:</strong>{' '}
                  {inspectedNode.thermalStatus.reason}
                </span>
                <span className="font-mono-num">
                  Score {inspectedNode.score} · ~{inspectedNode.estimatedTokPerSec} tok/s
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 4. Windows & Linux Tuned Backend Profiles */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Server className="w-4 h-4 text-blue-500" />
              Windows & Linux Native Backends (Auto-Tuned for {activeModel.name})
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Architecture-tuned GPU/CPU threads, WDDM / MemAvailable memory guards, KV cache quantization, and downloadable launch scripts.
            </p>
          </div>

          <div className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 self-start">
            <button
              type="button"
              onClick={() => setBackendOs('windows')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                backendOs === 'windows'
                  ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Windows 10/11
            </button>
            <button
              type="button"
              onClick={() => setBackendOs('linux')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                backendOs === 'linux'
                  ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Linux Kernel / NUMA
            </button>
          </div>
        </div>

        {/* Tuning Knobs Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1">
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              {backendOs === 'windows' ? 'Windows Accelerator' : 'Linux Accelerator'}
            </label>
            {backendOs === 'windows' ? (
              <select
                value={tuningConfig.windowsAccelerator}
                onChange={(e) =>
                  onUpdateTuningConfig({
                    windowsAccelerator: e.target.value as WindowsAccelerator,
                  })
                }
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100"
              >
                <option value="CUDA 12.6">CUDA 12.6 (RTX / cuBLAS)</option>
                <option value="Vulkan 1.3">Vulkan 1.3 (AMD / Intel / RTX)</option>
                <option value="DirectML">DirectML (Windows iGPU)</option>
                <option value="CPU AVX2">CPU AVX2 / BitNet LUT</option>
              </select>
            ) : (
              <select
                value={tuningConfig.linuxAccelerator}
                onChange={(e) =>
                  onUpdateTuningConfig({
                    linuxAccelerator: e.target.value as LinuxAccelerator,
                  })
                }
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100"
              >
                <option value="CUDA 12.6">CUDA 12.6 (NVIDIA + NVCC)</option>
                <option value="ROCm 6.3">ROCm 6.3 (AMD HIP)</option>
                <option value="Vulkan 1.3">Vulkan 1.3 (Mesa RADV / ANV)</option>
                <option value="CPU OpenBLAS">CPU OpenBLAS + AVX-512</option>
              </select>
            )}
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              Context Window
            </label>
            <select
              value={tuningConfig.contextLength}
              onChange={(e) =>
                onUpdateTuningConfig({
                  contextLength: Number(e.target.value) as ContextLengthOption,
                })
              }
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono-num font-semibold text-slate-900 dark:text-slate-100"
            >
              <option value={4096}>4,096 tokens</option>
              <option value={8192}>8,192 tokens</option>
              <option value={16384}>16,384 tokens</option>
              <option value={32768}>32,768 tokens</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              KV Cache Precision
            </label>
            <select
              value={tuningConfig.kvCacheQuant}
              onChange={(e) =>
                onUpdateTuningConfig({
                  kvCacheQuant: e.target.value as KvCacheQuantOption,
                })
              }
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono-num font-semibold text-slate-900 dark:text-slate-100"
            >
              <option value="f16">F16 (Full Precision)</option>
              <option value="q8_0">Q8_0 (50% RAM Saved)</option>
              <option value="q4_0">Q4_0 (Max Context Fit)</option>
            </select>
          </div>

          <div className="flex flex-col justify-end gap-1.5 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={tuningConfig.enableFlashAttn}
                onChange={(e) =>
                  onUpdateTuningConfig({ enableFlashAttn: e.target.checked })
                }
                className="accent-blue-600"
              />
              <span>FlashAttention (`--flash-attn`)</span>
            </label>
            {activeModel.architecture === 'MoE' ? (
              <label className="inline-flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={tuningConfig.moeCpuOffload}
                  onChange={(e) =>
                    onUpdateTuningConfig({ moeCpuOffload: e.target.checked })
                  }
                  className="accent-blue-600"
                />
                <span>CPU MoE Experts (`--cpu-moe`)</span>
              </label>
            ) : backendOs === 'windows' ? (
              <label className="inline-flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={tuningConfig.windowsNoMmap}
                  onChange={(e) =>
                    onUpdateTuningConfig({ windowsNoMmap: e.target.checked })
                  }
                  className="accent-blue-600"
                />
                <span>Lock weights in RAM (`--no-mmap`)</span>
              </label>
            ) : (
              <label className="inline-flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={tuningConfig.linuxNumaInterleave}
                  onChange={(e) =>
                    onUpdateTuningConfig({ linuxNumaInterleave: e.target.checked })
                  }
                  className="accent-blue-600"
                />
                <span>NUMA Interleave (`numactl`)</span>
              </label>
            )}
          </div>
        </div>

        {/* Tuned Telemetry Summary & Script Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start pt-2 border-t border-slate-200 dark:border-slate-800">
          <div className="lg:col-span-5 space-y-2">
            <div className="grid grid-cols-2 gap-2 text-xs font-mono-num">
              <div className="rounded-lg bg-slate-50 dark:bg-[#0B1120] p-2.5 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500">GPU Layers (-ngl)</div>
                <div className="font-bold text-slate-900 dark:text-slate-100">
                  {backendProfile.gpuOffloadLayers} / {activeModel.layers}L
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-[#0B1120] p-2.5 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500">Est. Speed · Threads</div>
                <div className="font-bold text-slate-900 dark:text-slate-100">
                  ~{backendProfile.expectedTokPerSec} tok/s · {backendProfile.recommendedThreads}T
                </div>
              </div>
            </div>

            <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
              {backendProfile.optimizations.map((note) => (
                <li key={note} className="flex items-start gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="lg:col-span-7 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-200">
                Tuned {backendProfile.title} Launch Command
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyCommand}
                  className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 font-semibold hover:underline"
                >
                  {copiedCmd ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedCmd ? 'Copied' : 'Copy Command'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadBackendScript}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{backendProfile.scriptFileName}</span>
                </button>
              </div>
            </div>

            <pre className="rounded-lg bg-slate-950 border border-slate-800 p-3 text-[11px] font-mono-num text-emerald-400 overflow-x-auto max-h-40">
              {backendProfile.launchCommand}
            </pre>
          </div>
        </div>
      </section>

      {/* 5. Three Simple User Cards: Connect · Health · Troubleshooter */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
        {/* Card 1: Connect */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Laptop className="w-4 h-4 text-blue-500" />
                Connect Device
              </h2>
              <span
                className={`text-xs font-semibold ${
                  isRunning
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : telemetry.workerState === 'SHEDDING_MEMORY'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {isRunning
                  ? 'Active Worker'
                  : telemetry.workerState === 'SHEDDING_MEMORY'
                    ? 'Memory Paused'
                    : 'Ready to Pair'}
              </span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Join your desktop master hub safely over USB cable or Wi-Fi. Memory usage is hard-capped at{' '}
              <span className="font-mono-num font-semibold">{telemetry.safeCapMb} MB</span>.
            </p>

            <div className="pt-1 text-xs text-slate-500 dark:text-slate-400 font-mono-num truncate">
              Link: {telemetry.pairedMasterAddress}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onAutoDetectMaster}
              disabled={telemetry.isScanningMaster}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3.5 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${telemetry.isScanningMaster ? 'animate-spin' : ''}`} />
              {telemetry.isScanningMaster ? 'Scanning...' : 'Auto-Connect'}
            </button>

            <button
              type="button"
              onClick={() => setShowQrModal(true)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 whitespace-nowrap shrink-0"
            >
              <QrCode className="w-3.5 h-3.5 text-blue-500" />
              Scan QR
            </button>

            {isRunning ? (
              <button
                type="button"
                onClick={onStopWorker}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300 px-3 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
              >
                <Square className="w-3.5 h-3.5" />
                Stop Sharing
              </button>
            ) : (
              <button
                type="button"
                onClick={onStartWorker}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500 whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5 text-emerald-500" />
                Start Sharing
              </button>
            )}
          </div>
        </div>

        {/* Card 2: Health */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                Device Health
              </h2>
              <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
                {cal.isCalibrated ? `${cal.performanceScore}/100` : 'Checking'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div className="space-y-0.5">
                <div className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  <HardDrive className="w-3 h-3" /> Safe RAM Cap
                </div>
                <div className="font-bold font-mono-num text-slate-900 dark:text-slate-100">
                  {telemetry.safeCapMb} MB
                </div>
              </div>

              <div className="space-y-0.5">
                <div className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  <Cpu className="w-3 h-3" /> Engine
                </div>
                <div className="font-bold text-slate-900 dark:text-slate-100 truncate">
                  {cal.recommendedBackendLabel}
                </div>
              </div>

              <div className="space-y-0.5">
                <div className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  <BatteryCharging className="w-3 h-3" /> Battery / Temp
                </div>
                <div className="font-bold font-mono-num text-slate-900 dark:text-slate-100">
                  {telemetry.batteryPercent}% · {(telemetry.temperatureCelsius + simulatedTempOffsetC).toFixed(0)}°C
                </div>
              </div>

              <div className="space-y-0.5">
                <div className="text-slate-500 dark:text-slate-400">Tier</div>
                <div className="font-bold text-slate-900 dark:text-slate-100 truncate">
                  {cal.tierLabel}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {cal.summarySentence}
            </span>
            <button
              type="button"
              onClick={onRecalibrate}
              disabled={cal.isCalibrating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${cal.isCalibrating ? 'animate-spin' : ''}`} />
              Re-Tune Speed
            </button>
          </div>
        </div>

        {/* Card 3: Troubleshooter */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Wrench className="w-4 h-4 text-blue-500" />
                Troubleshooter
              </h2>
              {telemetry.diagnosticReport && (
                <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
                  {telemetry.diagnosticReport.ranAtLabel}
                </span>
              )}
            </div>

            {telemetry.diagnosticReport ? (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {telemetry.diagnosticReport.checks.map((chk) => (
                  <div
                    key={chk.id}
                    className="flex items-center justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70 last:border-0 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 dark:text-slate-100 truncate">
                        {chk.title}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {chk.statusText}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {diagnosticLabel(chk.severity)}
                      {chk.fixAction && (
                        <button
                          type="button"
                          onClick={() => onApplyAutoFix(chk.fixAction!)}
                          className="rounded-md bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 text-[11px] font-semibold whitespace-nowrap"
                        >
                          Fix
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Run a 6-point check on memory limits, network link, battery temperature, and cluster reachability with 1-click fixes.
              </p>
            )}
          </div>

          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {telemetry.diagnosticReport?.headline ?? '6 automated readiness checks'}
            </span>
            <button
              type="button"
              onClick={onRunDiagnostics}
              disabled={telemetry.isDiagnosing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-500 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0"
            >
              <Activity className={`w-3.5 h-3.5 ${telemetry.isDiagnosing ? 'animate-pulse' : ''}`} />
              {telemetry.isDiagnosing ? 'Checking...' : 'Run Auto-Diagnosis'}
            </button>
          </div>
        </div>
      </section>

      {/* 6. Developer Settings Section (Only visible when Developer Mode is ON) */}
      {telemetry.developerModeEnabled && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-amber-500" />
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                Developer Node Controls, Thermal Simulator & Raw Telemetry
              </h2>
            </div>
            {onOpen2DLab && (
              <button
                type="button"
                onClick={onOpen2DLab}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0"
              >
                Open 2D Clustering Lab (Dev)
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Transport Bind ({telemetry.bindAddress})
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onToggleBindMode(true)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold border ${
                    telemetry.usbLoopbackOnly
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <Usb className="w-3.5 h-3.5" />
                  USB Tunnel
                </button>
                <button
                  type="button"
                  onClick={() => onToggleBindMode(false)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold border ${
                    !telemetry.usbLoopbackOnly
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <Wifi className="w-3.5 h-3.5" />
                  Wi-Fi LAN
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Cluster Secret & 32-Byte Auth Token
              </label>
              <input
                type="text"
                value={telemetry.clusterSecret}
                onChange={(e) => onUpdateSecret(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono-num text-slate-900 dark:text-slate-100"
              />
              <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 truncate">
                {telemetry.authTokenHex}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Thermal & Memory Stress Guard
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => onChangeSimulatedTempOffsetC(0)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500"
                >
                  Cool (Nominal)
                </button>
                <button
                  type="button"
                  onClick={() => onChangeSimulatedTempOffsetC(25)}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
                >
                  Test SHED_25
                </button>
                <button
                  type="button"
                  onClick={() => onChangeSimulatedTempOffsetC(30)}
                  className="rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-700 dark:text-red-300"
                >
                  Test Emergency Offload
                </button>
                <button
                  type="button"
                  onClick={onSimulateShedLayers}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-amber-500"
                >
                  SHED_LAYERS
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-mono-num text-slate-400">
              <span className="flex items-center gap-1.5 font-semibold">
                <Terminal className="w-3.5 h-3.5 text-teal-400" />
                Raw Node Event Log
              </span>
              <span>
                {telemetry.webglRendererName} · Handshakes: {telemetry.handshakesCompleted}
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

      {showQrModal && (
        <CameraQrScannerDialog
          activePayload={telemetry.pairingQrPayload}
          onPairPayload={onPairQrPayload}
          onClose={() => setShowQrModal(false)}
        />
      )}
    </div>
  );
};
