export type ThermalState = 'COOL' | 'WARN' | 'SHED_25' | 'EMERGENCY_OFFLOAD';

export type ClusterTierCode = 'S' | 'A' | 'B' | 'C';

export type ClusterMode = 'LOCAL_DEVICE' | 'VIRTUAL_4NODE';

export type ModelPresetId = 'moe-30b' | 'ternary-27b' | 'dense-32b' | 'dense-70b';

export interface GgufModelPreset {
  id: ModelPresetId;
  name: string;
  quant: string;
  architecture: 'MoE' | 'Ternary' | 'Dense';
  sizeMb: number;
  layers: number;
  summary: string;
}

export const GGUF_MODEL_PRESETS: GgufModelPreset[] = [
  {
    id: 'moe-30b',
    name: 'Qwen3-30B-A3B MoE',
    quant: 'Q4_K_M',
    architecture: 'MoE',
    sizeMb: 18500,
    layers: 48,
    summary: '18.5 GB · 48 layers · Sparse mixture-of-experts',
  },
  {
    id: 'ternary-27b',
    name: 'BitNet b1.58 Ternary',
    quant: 'TQ1_0',
    architecture: 'Ternary',
    sizeMb: 6400,
    layers: 36,
    summary: '6.4 GB · 36 layers · Compact 1.58-bit weights',
  },
  {
    id: 'dense-32b',
    name: 'Qwen2.5-32B Dense',
    quant: 'Q4_K_M',
    architecture: 'Dense',
    sizeMb: 19800,
    layers: 64,
    summary: '19.8 GB · 64 layers · High-precision dense',
  },
  {
    id: 'dense-70b',
    name: 'Llama-3.3-70B Dense',
    quant: 'Q4_K_M',
    architecture: 'Dense',
    sizeMb: 40500,
    layers: 80,
    summary: '40.5 GB · 80 layers · Multi-node cluster model',
  },
];

export interface ThermalLimits {
  androidWarnC: number;
  androidShedC: number;
  androidCritC: number;
  cpuWarnC: number;
  cpuShedC: number;
  cpuCritC: number;
  gpuWarnC: number;
  gpuShedC: number;
  gpuCritC: number;
  cooldownHysteresisC: number;
  cooldownHoldSecs: number;
}

export const DEFAULT_THERMAL_LIMITS: ThermalLimits = {
  androidWarnC: 42.0,
  androidShedC: 45.0,
  androidCritC: 48.0,
  cpuWarnC: 75.0,
  cpuShedC: 82.0,
  cpuCritC: 88.0,
  gpuWarnC: 78.0,
  gpuShedC: 83.0,
  gpuCritC: 87.0,
  cooldownHysteresisC: 5.0,
  cooldownHoldSecs: 30,
};

export interface ThermalStatus {
  state: ThermalState;
  capacityScale: number;
  reason: string;
  cooldownRemainingS: number;
}

export interface StarClusterNode {
  nodeId: string;
  label: string;
  role: 'Master' | 'Worker';
  platform: 'Desktop' | 'Android' | 'Edge ARM';
  linkType: 'Local' | 'USB-C Tunnel' | 'Ethernet 2.5G' | 'Wi-Fi LAN';
  totalRamMb: number;
  availableRamMb: number;
  vramFreeMb: number;
  memBwGbps: number;
  computeTflops: number;
  rttMs: number;
  pktLossPct: number;
  tempC: number;
  isConnected: boolean;
}

export interface PlannedStarNode extends StarClusterNode {
  safeRamMb: number;
  safeVramMb: number;
  effectiveCapMb: number;
  score: number;
  thermalStatus: ThermalStatus;
  allocatedMb: number;
  allocatedLayers: number;
  sharePct: number;
  statusNote: string;
}

export type FitVerdict = 'Fast' | 'Best Fit' | 'Streaming';

export interface StarClusterPlan {
  tierCode: ClusterTierCode;
  tierLabel: string;
  masterId: string;
  fitVerdict: FitVerdict;
  totalSafePoolMb: number;
  neededMb: number;
  coveragePct: number;
  overallThermalState: ThermalState;
  nodes: PlannedStarNode[];
  tensorSplitLabel: string;
}
