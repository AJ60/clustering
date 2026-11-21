import { DeviceTelemetryState } from '../types/clustering';
import {
  BackendTuningConfig,
  ClusterMode,
  ClusterTierCode,
  DEFAULT_THERMAL_LIMITS,
  FitVerdict,
  GgufModelPreset,
  LiveHardwareProbe,
  PlannedStarNode,
  StarClusterNode,
  StarClusterPlan,
  ThermalLimits,
  ThermalState,
  ThermalStatus,
} from '../types/starCluster';
import {
  createDefaultBackendTuningConfig,
  estimateKvCacheMb,
} from './backendTuner';

export function computeAndroidSafeCap(
  totalMb: number,
  availMb: number,
  capPct = 50,
  reserveMb = 512
): number {
  const boundedPct = Math.min(50, Math.max(10, capPct));
  const pctCap = Math.floor((totalMb * boundedPct) / 100);
  const boundedReserve = Math.min(512, Math.max(256, reserveMb));
  const headroomCap = Math.max(0, availMb - boundedReserve);
  return Math.max(256, Math.min(pctCap, headroomCap));
}

export function computeDesktopSafeCap(availMb: number, reserveMb = 1024): number {
  return Math.max(512, availMb - Math.max(256, reserveMb));
}

export function computeVramSafeCap(rawFreeVramMb: number, vramCapPct = 90): number {
  if (rawFreeVramMb <= 0) return 0;
  const pctCap = Math.floor((rawFreeVramMb * vramCapPct) / 100);
  if (rawFreeVramMb <= 8192) {
    return Math.min(pctCap, Math.max(0, rawFreeVramMb - 450));
  }
  return pctCap;
}

export function scoreClusterNode(node: StarClusterNode): number {
  const vramBonus = 1 + (Math.max(0, node.vramFreeMb) / 1024) * 0.22;
  const num = (0.7 * node.memBwGbps + 10.0 * node.computeTflops) * vramBonus;
  const den = 1.0 + 0.15 * node.rttMs + 2.0 * node.pktLossPct;
  return Number((num / Math.max(0.01, den)).toFixed(2));
}

export function evaluateNodeThermal(
  node: StarClusterNode,
  limits: ThermalLimits = DEFAULT_THERMAL_LIMITS
): ThermalStatus {
  const isAndroid = node.platform === 'Android';
  const hasGpu = node.vramFreeMb > 0;

  if (isAndroid) {
    if (node.tempC >= limits.androidCritC) {
      return {
        state: 'EMERGENCY_OFFLOAD',
        capacityScale: 0,
        reason: `Device ${node.tempC.toFixed(1)}°C >= ${limits.androidCritC}°C critical ceiling (0 layers)`,
        cooldownRemainingS: limits.cooldownHoldSecs,
      };
    }
    if (node.tempC >= limits.androidShedC) {
      return {
        state: 'SHED_25',
        capacityScale: 0.75,
        reason: `Device ${node.tempC.toFixed(1)}°C >= ${limits.androidShedC}°C shed limit (-25% load)`,
        cooldownRemainingS: 0,
      };
    }
    if (node.tempC >= limits.androidWarnC) {
      return {
        state: 'WARN',
        capacityScale: 0.9,
        reason: `Device warming at ${node.tempC.toFixed(1)}°C`,
        cooldownRemainingS: 0,
      };
    }
    return {
      state: 'COOL',
      capacityScale: 1.0,
      reason: `Cool & steady at ${node.tempC.toFixed(1)}°C`,
      cooldownRemainingS: 0,
    };
  }

  const critLimit = hasGpu ? limits.gpuCritC : limits.cpuCritC;
  const shedLimit = hasGpu ? limits.gpuShedC : limits.cpuShedC;
  const warnLimit = hasGpu ? limits.gpuWarnC : limits.cpuWarnC;

  if (node.tempC >= critLimit) {
    return {
      state: 'EMERGENCY_OFFLOAD',
      capacityScale: 0,
      reason: `Thermal critical (${node.tempC.toFixed(1)}°C >= ${critLimit}°C) — offloaded`,
      cooldownRemainingS: limits.cooldownHoldSecs,
    };
  }
  if (node.tempC >= shedLimit) {
    return {
      state: 'SHED_25',
      capacityScale: 0.75,
      reason: `Thermal shed (${node.tempC.toFixed(1)}°C >= ${shedLimit}°C) — 75% capacity`,
      cooldownRemainingS: 0,
    };
  }
  if (node.tempC >= warnLimit) {
    return {
      state: 'WARN',
      capacityScale: 0.9,
      reason: `Warm (${node.tempC.toFixed(1)}°C) — monitoring`,
      cooldownRemainingS: 0,
    };
  }
  return {
    state: 'COOL',
    capacityScale: 1.0,
    reason: `Nominal thermal envelope (${node.tempC.toFixed(1)}°C)`,
    cooldownRemainingS: 0,
  };
}

export function buildStarClusterNodes(
  telemetry: DeviceTelemetryState,
  mode: ClusterMode,
  simulatedTempOffsetC = 0,
  tuningConfig?: BackendTuningConfig,
  liveHardware?: LiveHardwareProbe
): StarClusterNode[] {
  const isWorkerActive =
    telemetry.workerState === 'RUNNING_USB' ||
    telemetry.workerState === 'RUNNING_WIFI' ||
    telemetry.workerState === 'STOPPED';

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroidBrowser = /android/i.test(ua);
  const isWindowsBrowser =
    liveHardware?.platform === 'windows' ||
    (typeof process !== 'undefined' && process.platform === 'win32') ||
    /windows/i.test(ua);
  const localTemp = Math.max(25, telemetry.temperatureCelsius + simulatedTempOffsetC);

  const localOsType = isAndroidBrowser
    ? 'android'
    : isWindowsBrowser
      ? 'windows'
      : 'linux';

  const masterHostNode: StarClusterNode = {
    nodeId: 'master-host',
    label: liveHardware?.osLabel
      ? `${liveHardware.osLabel} Master Host`
      : isWindowsBrowser
        ? 'Windows 11 Master Host'
        : 'Linux Master Hub',
    role: 'Master',
    platform: 'Desktop',
    osType: localOsType,
    backendDriver: isWindowsBrowser
      ? tuningConfig?.windowsAccelerator ?? 'CUDA 12.6'
      : tuningConfig?.linuxAccelerator ?? 'CUDA 12.6',
    linkType: 'Local',
    totalRamMb: liveHardware?.totalRamMb ?? 32768,
    availableRamMb: liveHardware?.availableRamMb ?? 22400,
    vramFreeMb: liveHardware?.vramMb ?? 4096,
    memBwGbps: isWindowsBrowser ? 145.0 : 158.0,
    computeTflops: isWindowsBrowser ? 9.2 : 24.4,
    physicalCores: liveHardware?.cores ?? (isWindowsBrowser ? 12 : 16),
    rttMs: 0.2,
    pktLossPct: 0,
    tempC: 48.0,
    isConnected: true,
  };

  const thisBrowserNode: StarClusterNode = {
    nodeId: 'this-device',
    label: isAndroidBrowser
      ? 'This Phone (Worker)'
      : isWindowsBrowser
        ? 'This Windows Node'
        : 'This Linux / Local Node',
    role: mode === 'VIRTUAL_4NODE' ? 'Worker' : 'Master',
    platform: isAndroidBrowser ? 'Android' : 'Desktop',
    osType: localOsType,
    backendDriver: isAndroidBrowser
      ? 'WebGL/NEON'
      : isWindowsBrowser
        ? tuningConfig?.windowsAccelerator ?? 'CUDA 12.6'
        : tuningConfig?.linuxAccelerator ?? 'CUDA 12.6',
    linkType: telemetry.usbLoopbackOnly ? 'USB-C Tunnel' : 'Wi-Fi LAN',
    totalRamMb: telemetry.totalRamMb,
    availableRamMb: telemetry.availableRamMb,
    vramFreeMb: telemetry.webglProbePassed ? Math.round(telemetry.safeCapMb * 0.65) : 0,
    memBwGbps: telemetry.webglProbePassed ? 44.0 : 21.5,
    computeTflops: Number(
      Math.max(0.8, (telemetry.calibration.performanceScore || 55) * 0.06).toFixed(1)
    ),
    physicalCores: Math.max(2, telemetry.totalCoreCount),
    rttMs: telemetry.usbLoopbackOnly ? 0.8 : 4.2,
    pktLossPct: 0,
    tempC: localTemp,
    isConnected: telemetry.workerState !== 'SHEDDING_MEMORY' && isWorkerActive,
  };

  // 1. Live Hardware Mode: Uses real host specs and real detected devices (e.g. Redmi Note 7 Pro)
  if (mode === 'LIVE_CLUSTER') {
    if (liveHardware?.connectedDevices && liveHardware.connectedDevices.length > 0) {
      const realWorkers: StarClusterNode[] = liveHardware.connectedDevices.map((dev) => ({
        nodeId: `dev-${dev.id}`,
        label: `${dev.model} (Worker)`,
        role: 'Worker',
        platform: dev.platform === 'Android' ? 'Android' : 'Desktop',
        osType: dev.platform === 'Android' ? 'android' : 'linux',
        backendDriver: dev.platform === 'Android' ? 'Snapdragon 675 / NEON' : 'CPU OpenBLAS',
        linkType: dev.transport.includes('USB') ? 'USB-C Tunnel' : 'Wi-Fi LAN',
        totalRamMb: dev.totalRamMb ?? 3700,
        availableRamMb: 1800,
        vramFreeMb: 0,
        memBwGbps: 24.0,
        computeTflops: 1.4,
        physicalCores: 8,
        rttMs: dev.rttMs ?? 0.8,
        pktLossPct: 0,
        tempC: 34.0,
        isConnected: true,
      }));
      return [masterHostNode, ...realWorkers];
    }

    // Single host standalone if no external worker device attached
    return [masterHostNode];
  }

  // 2. Local Device Standalone Mode
  if (mode === 'LOCAL_DEVICE') {
    return [masterHostNode];
  }

  // 3. 4-Node Virtual Simulation Mode (Clearly labeled virtual preview)
  return [
    {
      nodeId: 'linux-hub',
      label: 'Linux Master Hub',
      role: 'Master',
      platform: 'Desktop',
      osType: 'linux',
      backendDriver: tuningConfig?.linuxAccelerator ?? 'CUDA 12.6',
      linkType: 'Local',
      totalRamMb: 32768,
      availableRamMb: 24200,
      vramFreeMb: 12288,
      memBwGbps: 158.0,
      computeTflops: 24.4,
      physicalCores: 16,
      rttMs: 0.2,
      pktLossPct: 0,
      tempC: 60.5,
      isConnected: true,
    },
    {
      nodeId: 'windows-worker',
      label: 'Windows Workstation',
      role: 'Worker',
      platform: 'Desktop',
      osType: 'windows',
      backendDriver: tuningConfig?.windowsAccelerator ?? 'CUDA 12.6',
      linkType: 'Ethernet 2.5G',
      totalRamMb: 32768,
      availableRamMb: 21500,
      vramFreeMb: 8192,
      memBwGbps: 124.0,
      computeTflops: 18.6,
      physicalCores: 12,
      rttMs: 0.6,
      pktLossPct: 0,
      tempC: Math.max(48, 58.0 + simulatedTempOffsetC),
      isConnected: true,
    },
    {
      ...thisBrowserNode,
      label: isAndroidBrowser ? 'This Phone (Worker)' : 'This Browser Node',
      role: 'Worker',
      linkType: telemetry.usbLoopbackOnly ? 'USB-C Tunnel' : 'Wi-Fi LAN',
      rttMs: telemetry.usbLoopbackOnly ? 0.7 : 3.4,
    },
    {
      nodeId: 'edge-arm',
      label: 'Pixel / Edge ARM Helper',
      role: 'Worker',
      platform: 'Android',
      osType: 'android',
      backendDriver: 'NEON / Vulkan',
      linkType: 'USB-C Tunnel',
      totalRamMb: 8192,
      availableRamMb: 5400,
      vramFreeMb: 0,
      memBwGbps: 36.0,
      computeTflops: 2.3,
      physicalCores: 8,
      rttMs: 0.9,
      pktLossPct: 0,
      tempC: Math.max(33, 35.5 + simulatedTempOffsetC),
      isConnected: true,
    },
  ];
}

export function planStarCluster(
  rawNodes: StarClusterNode[],
  model: GgufModelPreset,
  limits: ThermalLimits = DEFAULT_THERMAL_LIMITS,
  tuningConfig?: BackendTuningConfig
): StarClusterPlan {
  const effectiveConfig = tuningConfig ?? createDefaultBackendTuningConfig(model);
  const totalKvCacheMb = estimateKvCacheMb(
    model.layers,
    effectiveConfig.contextLength,
    effectiveConfig.kvCacheQuant,
    model.totalParamsB
  );

  const evaluated: PlannedStarNode[] = rawNodes.map((n) => {
    const safeRamMb =
      n.platform === 'Android'
        ? computeAndroidSafeCap(n.totalRamMb, n.availableRamMb)
        : computeDesktopSafeCap(n.availableRamMb, n.platform === 'Edge ARM' ? 512 : 1024);
    const safeVramMb = computeVramSafeCap(n.vramFreeMb);
    const thermalStatus = evaluateNodeThermal(n, limits);
    const baseCap = safeRamMb + safeVramMb;
    const effectiveCapMb =
      n.isConnected && thermalStatus.state !== 'EMERGENCY_OFFLOAD'
        ? Math.floor(baseCap * thermalStatus.capacityScale)
        : 0;
    const score = effectiveCapMb > 0 ? scoreClusterNode(n) : 0;

    return {
      ...n,
      safeRamMb,
      safeVramMb,
      effectiveCapMb,
      score,
      thermalStatus,
      allocatedMb: 0,
      allocatedLayers: 0,
      layerStart: 0,
      layerEnd: -1,
      activeParamsB: 0,
      totalParamsB: 0,
      kvCacheMb: 0,
      estimatedTokPerSec: 0,
      nglLayers: 0,
      tuningFlags: [],
      sharePct: 0,
      statusNote:
        !n.isConnected
          ? 'Paused / Memory shedded'
          : thermalStatus.state === 'EMERGENCY_OFFLOAD'
            ? thermalStatus.reason
            : `${effectiveCapMb.toLocaleString()} MB safe cap`,
    };
  });

  const active = evaluated.filter((n) => n.effectiveCapMb > 0);
  const totalSafePoolMb = evaluated.reduce((acc, n) => acc + n.effectiveCapMb, 0);
  const totalVramPoolMb = evaluated.reduce(
    (acc, n) => acc + (n.effectiveCapMb > 0 ? n.safeVramMb : 0),
    0
  );
  const neededMb = model.sizeMb + totalKvCacheMb;
  const totalScore = active.reduce((acc, n) => acc + n.score, 0);

  // Greedy capacity-aware MB distribution across active star nodes
  let remainingNeed = Math.min(model.sizeMb, totalSafePoolMb);
  const sortedActive = [...active].sort((a, b) => b.score - a.score);

  for (const node of sortedActive) {
    if (remainingNeed <= 0 || totalScore <= 0) break;
    const targetWeight = node.score / totalScore;
    const proportionalMb = Math.round(model.sizeMb * targetWeight);
    const alloc = Math.min(node.effectiveCapMb, Math.max(256, proportionalMb), remainingNeed);
    node.allocatedMb = alloc;
    remainingNeed -= alloc;
  }

  if (remainingNeed > 0) {
    for (const node of sortedActive) {
      if (remainingNeed <= 0) break;
      const spare = node.effectiveCapMb - node.allocatedMb;
      if (spare > 0) {
        const take = Math.min(spare, remainingNeed);
        node.allocatedMb += take;
        remainingNeed -= take;
      }
    }
  }

  const totalAllocated = Math.max(1, evaluated.reduce((acc, n) => acc + n.allocatedMb, 0));

  // Assign contiguous layer slices + Active Parameters + KV + Backend tuning per node
  let assignedLayersSum = 0;
  const activeWithAlloc = evaluated.filter((n) => n.allocatedMb > 0);
  activeWithAlloc.forEach((node, idx) => {
    const ratio = node.allocatedMb / totalAllocated;
    node.sharePct = Math.round(ratio * 100);
    if (idx === activeWithAlloc.length - 1) {
      node.allocatedLayers = Math.max(1, model.layers - assignedLayersSum);
    } else {
      node.allocatedLayers = Math.max(1, Math.round(ratio * model.layers));
      assignedLayersSum += node.allocatedLayers;
    }
  });

  // Ensure sum equals model.layers cleanly if rounding slightly overshot
  if (activeWithAlloc.length > 0) {
    const sumLayers = activeWithAlloc.reduce((acc, n) => acc + n.allocatedLayers, 0);
    if (sumLayers !== model.layers) {
      const largest = [...activeWithAlloc].sort((a, b) => b.allocatedLayers - a.allocatedLayers)[0];
      largest.allocatedLayers = Math.max(1, largest.allocatedLayers + (model.layers - sumLayers));
    }
  }

  let cursorLayer = 0;
  for (const node of evaluated) {
    if (node.allocatedLayers > 0) {
      node.layerStart = cursorLayer;
      node.layerEnd = cursorLayer + node.allocatedLayers - 1;
      cursorLayer += node.allocatedLayers;

      const layerShare = node.allocatedLayers / Math.max(1, model.layers);
      node.activeParamsB = Number((model.activeParamsB * layerShare).toFixed(2));
      node.totalParamsB = Number((model.totalParamsB * layerShare).toFixed(2));
      node.kvCacheMb = Math.max(32, Math.round(totalKvCacheMb * layerShare));

      const mbPerLayer = model.sizeMb / Math.max(1, model.layers);
      const gpuLayerCap =
        node.safeVramMb > 0 ? Math.floor(node.safeVramMb / Math.max(1, mbPerLayer)) : 0;
      node.nglLayers = Math.min(node.allocatedLayers, gpuLayerCap);

      const effectiveBw = node.nglLayers > 0 ? Math.max(node.memBwGbps, 195) : node.memBwGbps;
      const nodeTok =
        (effectiveBw / Math.max(0.35, node.activeParamsB * 0.6)) *
        node.thermalStatus.capacityScale;
      node.estimatedTokPerSec = Number(Math.max(1.5, Math.min(180, nodeTok)).toFixed(1));

      const flags: string[] = [];
      if (node.osType === 'windows') {
        flags.push(effectiveConfig.windowsAccelerator);
        if (effectiveConfig.windowsNoMmap) flags.push('--no-mmap');
        flags.push('WDDM Guard -450MB');
      } else if (node.osType === 'linux') {
        flags.push(effectiveConfig.linuxAccelerator);
        if (effectiveConfig.linuxNumaInterleave) flags.push('numactl --interleave');
        if (effectiveConfig.linuxMlock) flags.push('--mlock');
      } else if (node.osType === 'android') {
        flags.push('<=50% Safe RAM');
        flags.push('USB/NEON');
      }
      if (effectiveConfig.enableFlashAttn && node.nglLayers > 0) flags.push('FlashAttn');
      if (effectiveConfig.moeCpuOffload && model.architecture === 'MoE') flags.push('--cpu-moe');
      node.tuningFlags = flags;
    }
  }

  const coveragePct = Math.min(100, Math.round((totalSafePoolMb / Math.max(1, neededMb)) * 100));
  const fitVerdict: FitVerdict =
    totalSafePoolMb >= neededMb * 1.15
      ? 'Fast'
      : totalSafePoolMb >= neededMb
        ? 'Best Fit'
        : 'Streaming';

  const tierCode: ClusterTierCode =
    totalSafePoolMb >= 32000
      ? 'S'
      : totalSafePoolMb >= 16000
        ? 'A'
        : totalSafePoolMb >= 6000
          ? 'B'
          : 'C';

  const tierLabel =
    tierCode === 'S'
      ? 'Tier S · High-Capacity Star'
      : tierCode === 'A'
        ? 'Tier A · Multi-Node Balanced'
        : tierCode === 'B'
          ? 'Tier B · Edge Star Helper'
          : 'Tier C · Light Safe Helper';

  const thermalRank: Record<ThermalState, number> = {
    COOL: 0,
    WARN: 1,
    SHED_25: 2,
    EMERGENCY_OFFLOAD: 3,
  };
  const overallThermalState = evaluated.reduce<ThermalState>(
    (worst, n) =>
      thermalRank[n.thermalStatus.state] > thermalRank[worst] ? n.thermalStatus.state : worst,
    'COOL'
  );

  // Pipeline bottleneck determines overall cluster tok/s
  const bottleneckTok =
    activeWithAlloc.length > 0
      ? Math.min(...activeWithAlloc.map((n) => n.estimatedTokPerSec)) *
        (activeWithAlloc.length > 1 ? 0.92 : 1.0)
      : 0;
  const master = evaluated.find((n) => n.role === 'Master') ?? evaluated[0];
  const splitParts = activeWithAlloc.map((n) => `${n.sharePct}%`);

  return {
    tierCode,
    tierLabel,
    masterId: master?.label ?? 'Local Hub',
    fitVerdict,
    totalSafePoolMb,
    totalVramPoolMb,
    neededMb,
    kvCacheTotalMb: totalKvCacheMb,
    coveragePct,
    overallThermalState,
    estimatedClusterTokPerSec: Number(Math.max(1.2, bottleneckTok).toFixed(1)),
    activeParamsPerTokenB: model.activeParamsB,
    totalParamsB: model.totalParamsB,
    nodes: evaluated,
    tensorSplitLabel: splitParts.length > 0 ? splitParts.join(' / ') : '0%',
  };
}
