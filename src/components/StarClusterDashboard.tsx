import React, { useMemo, useState } from 'react';
import {
  AutoFixAction,
  DeviceTelemetryState,
  DiagnosticSeverity,
} from '../types/clustering';
import {
  ClusterMode,
  GGUF_MODEL_PRESETS,
  ModelPresetId,
  PlannedStarNode,
  ThermalState,
} from '../types/starCluster';
import {
  buildStarClusterNodes,
  planStarCluster,
} from '../domain/starClusterPlanner';
import { CameraQrScannerDialog } from './HardenedNodeDashboard';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  CheckCircle2,
  Cpu,
  Flame,
  HardDrive,
  Laptop,
  Play,
  QrCode,
  RefreshCw,
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
  onOpen2DLab,
}) => {
  const [selectedPresetId, setSelectedPresetId] = useState<ModelPresetId>('moe-30b');
  const [clusterMode, setClusterMode] = useState<ClusterMode>('VIRTUAL_4NODE');
  const [simulatedTempOffsetC, setSimulatedTempOffsetC] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('this-device');
  const [showQrModal, setShowQrModal] = useState(false);

  const selectedModel = useMemo(
    () => GGUF_MODEL_PRESETS.find((m) => m.id === selectedPresetId) ?? GGUF_MODEL_PRESETS[0],
    [selectedPresetId]
  );

  const clusterPlan = useMemo(() => {
    const rawNodes = buildStarClusterNodes(telemetry, clusterMode, simulatedTempOffsetC);
    return planStarCluster(rawNodes, selectedModel);
  }, [telemetry, clusterMode, simulatedTempOffsetC, selectedModel]);

  const inspectedNode: PlannedStarNode | undefined = useMemo(() => {
    return (
      clusterPlan.nodes.find((n) => n.nodeId === selectedNodeId) ??
      clusterPlan.nodes[0]
    );
  }, [clusterPlan.nodes, selectedNodeId]);

  const masterNode = clusterPlan.nodes.find((n) => n.role === 'Master') ?? clusterPlan.nodes[0];
  const workerNodes = clusterPlan.nodes.filter((n) => n.nodeId !== masterNode?.nodeId);

  const isRunning =
    telemetry.workerState === 'RUNNING_USB' || telemetry.workerState === 'RUNNING_WIFI';
  const cal = telemetry.calibration;
  const thermalMeta = thermalLabel(clusterPlan.overallThermalState);

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
              Model Preset
            </label>
            <select
              id="gguf-model-preset"
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value as ModelPresetId)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] px-3 py-2 text-xs font-semibold text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            >
              {GGUF_MODEL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.quant} · {(preset.sizeMb / 1000).toFixed(1)} GB)
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{selectedModel.architecture}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num">{selectedModel.layers} layers</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num">{(selectedModel.sizeMb / 1024).toFixed(1)} GB needed</span>
          </div>
        </div>

        {/* Segmented Mode Selector: Live Device vs 4-Node Virtual Test */}
        <div
          role="tablist"
          aria-label="Cluster topology mode"
          className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 self-start lg:self-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={clusterMode === 'LOCAL_DEVICE'}
            onClick={() => setClusterMode('LOCAL_DEVICE')}
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
            onClick={() => setClusterMode('VIRTUAL_4NODE')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              clusterMode === 'VIRTUAL_4NODE'
                ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            4-Node Cluster Test
          </button>
        </div>
      </section>

      {/* 2. 4-KPI Summary Strip: Tier, Safe RAM Pool, Layer Allocation, Thermal Guard */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-4 space-y-1">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Cluster Tier
          </div>
          <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono-num">
            {clusterPlan.tierLabel}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            {clusterPlan.nodes.filter((n) => n.effectiveCapMb > 0).length} active node(s) · 1-Hop Star
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-500 dark:text-slate-400">Safe RAM Pool</span>
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
              / {(clusterPlan.neededMb / 1024).toFixed(1)} GB
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
            Layer Split
          </div>
          <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono-num truncate">
            {clusterPlan.tensorSplitLabel}
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
            Android ≤50% RAM cap · Anti-flap 30s
          </div>
        </div>
      </section>

      {/* 3. Live 1-Hop Star Topology & Cap-Bounded Node Allocation */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
              1-Hop Star Topology & Memory Pool
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click any node to inspect its safe RAM limit, network latency, and assigned layers.
            </p>
          </div>
          <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
            {selectedModel.name} · {clusterPlan.coveragePct}% in RAM
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
          {/* Interactive SVG Hub & Spoke Diagram */}
          <div className="lg:col-span-6">
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
                    {/* Edges */}
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
                            x={midX - 38}
                            y={midY - 10}
                            width={76}
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

                    {/* Master Hub Node */}
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
                          Master · {masterNode.sharePct}% ({masterNode.allocatedLayers}L)
                        </text>
                        <text
                          x={hubX - 42}
                          y={hubY + 22}
                          textAnchor="middle"
                          className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono-num"
                        >
                          {(masterNode.effectiveCapMb / 1024).toFixed(1)} GB safe cap
                        </text>
                      </g>
                    )}

                    {/* Worker Nodes */}
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
                            width={145}
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
                            x={pos.x + 62}
                            y={pos.y - 5}
                            textAnchor="middle"
                            className="fill-slate-900 dark:fill-slate-100 text-[11.5px] font-bold"
                          >
                            {w.label.slice(0, 20)}
                          </text>
                          <text
                            x={pos.x + 62}
                            y={pos.y + 12}
                            textAnchor="middle"
                            className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono-num"
                          >
                            {w.allocatedLayers}L · {(w.effectiveCapMb / 1024).toFixed(1)} GB · {w.tempC.toFixed(0)}°C
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
          <div className="lg:col-span-6 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-2 pr-3">Node</th>
                  <th className="py-2 pr-3">Link</th>
                  <th className="py-2 pr-3 text-right">Safe Cap</th>
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
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {node.role} · {node.platform}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600 dark:text-slate-300 font-mono-num whitespace-nowrap">
                        {node.linkType}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono-num text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        {(node.effectiveCapMb / 1024).toFixed(1)} GB
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono-num font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {node.allocatedLayers} ({node.sharePct}%)
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
                  Score {inspectedNode.score} · RTT {inspectedNode.rttMs.toFixed(1)} ms
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 4. Three Simple User Cards: Connect · Health · Troubleshooter */}
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
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500 whitespace-nowrap shrink-0"
            >
              <QrCode className="w-3.5 h-3.5 text-blue-500" />
              Scan QR
            </button>

            {isRunning ? (
              <button
                type="button"
                onClick={onStopWorker}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300 px-3 py-2 text-xs font-semibold hover:bg-red-500/20 whitespace-nowrap shrink-0"
              >
                <Square className="w-3.5 h-3.5" />
                Stop Sharing
              </button>
            ) : (
              <button
                type="button"
                onClick={onStartWorker}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] text-slate-800 dark:text-slate-100 px-3 py-2 text-xs font-semibold hover:border-emerald-500 whitespace-nowrap shrink-0"
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
                <Cpu className="w-4 h-4 text-emerald-500" />
                Device Health
              </h2>
              <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                {cal.tierLabel}
              </span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              {cal.summarySentence}
            </p>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-1 text-xs">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Safe RAM Cap</dt>
                <dd className="font-mono-num font-bold text-slate-900 dark:text-slate-100">
                  {cal.recommendedSafeRamMb} MB{' '}
                  <span className="font-normal text-slate-500">/ {telemetry.totalRamMb}</span>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Compute Engine</dt>
                <dd className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {cal.recommendedBackendLabel}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  <BatteryCharging className="w-3.5 h-3.5 text-emerald-500" />
                  Battery & Heat
                </dt>
                <dd className="font-mono-num font-bold text-slate-900 dark:text-slate-100">
                  {telemetry.batteryPercent}% · {(telemetry.temperatureCelsius + simulatedTempOffsetC).toFixed(1)}°C
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  <HardDrive className="w-3.5 h-3.5 text-blue-500" />
                  Speed & Threads
                </dt>
                <dd className="font-mono-num font-bold text-slate-900 dark:text-slate-100">
                  {cal.performanceScore}/100 · {cal.recommendedThreads} threads
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
              Capacity: {cal.estimatedLayerCapacity} layers
            </span>
            <button
              type="button"
              onClick={onRecalibrate}
              disabled={cal.isCalibrating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${cal.isCalibrating ? 'animate-spin' : ''}`} />
              {cal.isCalibrating ? 'Tuning...' : 'Re-Tune Speed'}
            </button>
          </div>
        </div>

        {/* Card 3: Troubleshooter */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-teal-500" />
                Troubleshooter
              </h2>
              {telemetry.diagnosticReport && (
                <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
                  {telemetry.diagnosticReport.ranAtLabel}
                </span>
              )}
            </div>

            {telemetry.diagnosticReport ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  {telemetry.diagnosticReport.headline}
                </div>
                <div className="max-h-52 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800/80 pr-1">
                  {telemetry.diagnosticReport.checks.map((chk) => (
                    <div key={chk.id} className="py-2 first:pt-0 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                          {chk.title}
                        </span>
                        {diagnosticLabel(chk.severity)}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {chk.statusText}
                      </p>
                      {chk.fixAction && (
                        <button
                          type="button"
                          onClick={() => onApplyAutoFix(chk.fixAction!)}
                          className="inline-flex items-center gap-1 rounded-md bg-blue-600/12 text-blue-600 dark:text-blue-400 px-2.5 py-1 text-[11px] font-semibold hover:bg-blue-600/20"
                        >
                          <Wrench className="w-3 h-3" />
                          1-Click Fix
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Verify calibration, USB/Wi-Fi connectivity, desktop master reachability, battery/thermal comfort, and free memory headroom with automatic 1-click fixes.
              </p>
            )}
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onRunDiagnostics}
              disabled={telemetry.isDiagnosing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 hover:opacity-90 text-white px-3.5 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
            >
              <Activity className={`w-3.5 h-3.5 ${telemetry.isDiagnosing ? 'animate-pulse' : ''}`} />
              {telemetry.isDiagnosing ? 'Checking...' : 'Run Auto-Diagnosis'}
            </button>
          </div>
        </div>
      </section>

      {/* 5. Developer Settings Section (Only visible when Developer Mode is ON) */}
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
            {/* Transport Bind Switch */}
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

            {/* Keyed Auth Secret & 32-Byte Token */}
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

            {/* ThermalBalancer & SHED_LAYERS Stress Tests */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Thermal & Memory Stress Guard
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setSimulatedTempOffsetC(0)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500"
                >
                  Cool (Nominal)
                </button>
                <button
                  type="button"
                  onClick={() => setSimulatedTempOffsetC(15)}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
                >
                  Test SHED_25
                </button>
                <button
                  type="button"
                  onClick={() => setSimulatedTempOffsetC(19)}
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
