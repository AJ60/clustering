export type ThermalState = 'COOL' | 'WARN' | 'SHED_25' | 'EMERGENCY_OFFLOAD';

export type ClusterTierCode = 'S' | 'A' | 'B' | 'C';

export type ClusterMode = 'LIVE_CLUSTER' | 'LOCAL_DEVICE' | 'VIRTUAL_4NODE';

export interface ConnectedDeviceInfo {
  id: string;
  model: string;
  platform: 'Android' | 'Linux' | 'Other';
  transport: string;
  safeCapMb: number;
  totalRamMb?: number;
  rttMs?: number;
}

export interface LiveHardwareProbe {
  platform: 'windows' | 'linux' | 'darwin';
  osLabel: string;
  totalRamMb: number;
  availableRamMb: number;
  vramMb: number;
  gpuName?: string;
  cpuModel: string;
  cores: number;
  connectedDevices: ConnectedDeviceInfo[];
}

export type ModelPresetId =
  | 'small-1.5b'
  | 'moe-30b'
  | 'ternary-27b'
  | 'dense-32b'
  | 'dense-70b'
  | 'custom-hf';

export type ContextLengthOption = 4096 | 8192 | 16384 | 32768;
export type KvCacheQuantOption = 'f16' | 'q8_0' | 'q4_0';
export type BackendOsTarget = 'windows' | 'linux';

export type WindowsAccelerator = 'CUDA 12.6' | 'Vulkan 1.3' | 'DirectML' | 'CPU AVX2';
export type LinuxAccelerator = 'CUDA 12.6' | 'ROCm 6.3' | 'Vulkan 1.3' | 'CPU OpenBLAS';

export interface GgufModelPreset {
  id: string;
  name: string;
  quant: string;
  architecture: 'MoE' | 'Ternary' | 'Dense';
  sizeMb: number;
  layers: number;
  totalParamsB: number;
  activeParamsB: number;
  contextLengthDefault: ContextLengthOption;
  hfRepo: string;
  hfUrl: string;
  summary: string;
  tags?: string[];
  isLocal?: boolean;
  localPath?: string;
}

export const GGUF_MODEL_PRESETS: GgufModelPreset[] = [
  {
    id: 'small-1.5b',
    name: 'Qwen2.5-1.5B-Instruct',
    quant: 'Q4_K_M',
    architecture: 'Dense',
    sizeMb: 1150,
    layers: 28,
    totalParamsB: 1.54,
    activeParamsB: 1.54,
    contextLengthDefault: 8192,
    hfRepo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    hfUrl: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    summary: '1.15 GB · 28 layers · Ultra-lightweight edge & multi-device test model',
    tags: ['small', 'fast', 'edge', 'testing'],
  },
  {
    id: 'moe-30b',
    name: 'Qwen3-30B-A3B MoE',
    quant: 'Q4_K_M',
    architecture: 'MoE',
    sizeMb: 18500,
    layers: 48,
    totalParamsB: 30.5,
    activeParamsB: 3.3,
    contextLengthDefault: 16384,
    hfRepo: 'Qwen/Qwen3-30B-A3B-GGUF',
    hfUrl: 'https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF',
    summary: '18.5 GB · 48 layers · 3.3B active / 30.5B total MoE',
    tags: ['moe', 'chat', 'fast'],
  },
  {
    id: 'ternary-27b',
    name: 'BitNet b1.58 Ternary',
    quant: 'TQ1_0',
    architecture: 'Ternary',
    sizeMb: 6400,
    layers: 36,
    totalParamsB: 27.0,
    activeParamsB: 27.0,
    contextLengthDefault: 8192,
    hfRepo: 'microsoft/BitNet-b1.58-2B-4T-gguf',
    hfUrl: 'https://huggingface.co/microsoft/BitNet-b1.58-2B-4T-gguf',
    summary: '6.4 GB · 36 layers · Compact 1.58-bit LUT weights',
    tags: ['ternary', 'edge', 'cpu'],
  },
  {
    id: 'dense-32b',
    name: 'Qwen2.5-Coder-32B Dense',
    quant: 'Q4_K_M',
    architecture: 'Dense',
    sizeMb: 19800,
    layers: 64,
    totalParamsB: 32.5,
    activeParamsB: 32.5,
    contextLengthDefault: 16384,
    hfRepo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF',
    hfUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct-GGUF',
    summary: '19.8 GB · 64 layers · Dense coding & tool-use model',
    tags: ['coding', 'dense', 'tools'],
  },
  {
    id: 'dense-70b',
    name: 'Llama-3.3-70B-Instruct',
    quant: 'Q4_K_M',
    architecture: 'Dense',
    sizeMb: 40500,
    layers: 80,
    totalParamsB: 70.6,
    activeParamsB: 70.6,
    contextLengthDefault: 8192,
    hfRepo: 'bartowski/Llama-3.3-70B-Instruct-GGUF',
    hfUrl: 'https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF',
    summary: '40.5 GB · 80 layers · Multi-node flagship cluster model',
    tags: ['dense', 'reasoning', 'multi-node'],
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

export type NodeOsType = 'windows' | 'linux' | 'android' | 'edge-arm';

export interface StarClusterNode {
  nodeId: string;
  label: string;
  role: 'Master' | 'Worker';
  platform: 'Desktop' | 'Android' | 'Edge ARM';
  osType: NodeOsType;
  backendDriver: string;
  linkType: 'Local' | 'USB-C Tunnel' | 'Ethernet 2.5G' | 'Wi-Fi LAN';
  totalRamMb: number;
  availableRamMb: number;
  vramFreeMb: number;
  memBwGbps: number;
  computeTflops: number;
  physicalCores: number;
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
  layerStart: number;
  layerEnd: number;
  activeParamsB: number;
  totalParamsB: number;
  kvCacheMb: number;
  estimatedTokPerSec: number;
  nglLayers: number;
  tuningFlags: string[];
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
  totalVramPoolMb: number;
  neededMb: number;
  kvCacheTotalMb: number;
  coveragePct: number;
  overallThermalState: ThermalState;
  estimatedClusterTokPerSec: number;
  activeParamsPerTokenB: number;
  totalParamsB: number;
  nodes: PlannedStarNode[];
  tensorSplitLabel: string;
}

export interface BackendTuningConfig {
  windowsAccelerator: WindowsAccelerator;
  linuxAccelerator: LinuxAccelerator;
  contextLength: ContextLengthOption;
  kvCacheQuant: KvCacheQuantOption;
  enableFlashAttn: boolean;
  moeCpuOffload: boolean;
  windowsNoMmap: boolean;
  linuxMlock: boolean;
  linuxNumaInterleave: boolean;
}

export interface TunedOsBackendProfile {
  os: BackendOsTarget;
  title: string;
  accelerator: string;
  recommendedThreads: number;
  gpuOffloadLayers: number;
  vramSafetyReserveMb: number;
  ramSafetyReserveMb: number;
  batchSize: number;
  ubatchSize: number;
  kvCacheMb: number;
  expectedTokPerSec: number;
  envVars: Array<{ key: string; value: string; reason: string }>;
  cliFlags: string[];
  launchCommand: string;
  scriptFileName: string;
  scriptContent: string;
  optimizations: string[];
}

export interface QuantVariantOption {
  quant: string;
  sizeMb: number;
  bpw: number;
}

export interface HfCatalogModel {
  id: string;
  hfRepo: string;
  hfUrl: string;
  name: string;
  author: string;
  architecture: 'MoE' | 'Ternary' | 'Dense';
  totalParamsB: number;
  activeParamsB: number;
  layers: number;
  defaultQuant: string;
  sizeMb: number;
  quantOptions: QuantVariantOption[];
  contextLengthDefault: ContextLengthOption;
  downloads: number;
  likes: number;
  tags: string[];
  summary: string;
  source: 'curated' | 'huggingface';
}
