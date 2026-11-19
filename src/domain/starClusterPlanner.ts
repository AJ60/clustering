import { DeviceTelemetryState } from '../types/clustering';
import {
  ClusterMode,
  ClusterTierCode,
  DEFAULT_THERMAL_LIMITS,
  FitVerdict,
  GgufModelPreset,
  PlannedStarNode,
  StarClusterNode,
  StarClusterPlan,
  ThermalLimits,
  ThermalState,
  ThermalStatus,
} from '../types/starCluster';

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
  simulatedTempOffsetC = 0
): StarClusterNode[] {
  const isWorkerActive =
    telemetry.workerState === 'RUNNING_USB' ||
    telemetry.workerState === 'RUNNING_WIFI' ||
    telemetry.workerState === 'STOPPED';

  const isAndroidBrowser = /android/i.test(navigator.userAgent);
  const localTemp = Math.max(25, telemetry.temperatureCelsius + simulatedTempOffsetC);

  const thisBrowserNode: StarClusterNode = {
    nodeId: 'this-device',
    label: isAndroidBrowser ? 'This Phone (Worker)' : 'This Device (Local)',
    role: mode === 'VIRTUAL_4NODE' ? 'Worker' : 'Master',
    platform: isAndroidBrowser ? 'Android' : 'Desktop',
    linkType: telemetry.usbLoopbackOnly ? 'USB-C Tunnel' : 'Wi-Fi LAN',
    totalRamMb: telemetry.totalRamMb,
    availableRamMb: telemetry.availableRamMb,
    vramFreeMb: telemetry.webglProbePassed ? Math.round(telemetry.safeCapMb * 0.65) : 0,
    memBwGbps: telemetry.webglProbePassed ? 38.0 : 19.5,
    computeTflops: Number(
      Math.max(0.6, (telemetry.calibration.performanceScore || 55) * 0.055).toFixed(1)
    ),
    rttMs: telemetry.usbLoopbackOnly ? 0.8 : 4.2,
    pktLossPct: 0,
    tempC: localTemp,
    isConnected: telemetry.workerState !== 'SHEDDING_MEMORY' && isWorkerActive,
  };

  if (mode === 'LOCAL_DEVICE') {
    const hasPairedDesktop =
      telemetry.pairedMasterAddress.includes(':') &&
      !telemetry.pairedMasterAddress.startsWith('Not Paired');

    if (!hasPairedDesktop) {
      return [{ ...thisBrowserNode, role: 'Master', linkType: 'Local', rttMs: 0.2 }];
    }

    const masterHost: StarClusterNode = {
      nodeId: 'paired-master',
      label: `Master (${telemetry.pairedMasterAddress.split(' ')[0]})`,
      role: 'Master',
      platform: 'Desktop',
      linkType: 'Local',
      totalRamMb: 32768,
      availableRamMb: 24576,
      vramFreeMb: 8192,
      memBwGbps: 112.0,
      computeTflops: 18.4,
      rttMs: 0.2,
      pktLossPct: 0,
      tempC: 61.0,
      isConnected: true,
    };

    return [masterHost, { ...thisBrowserNode, role: 'Worker' }];
  }

  // 4-Node Virtual Heterogeneous Star Test (mirrors AJ60/clustering matrix)
  return [
    {
      nodeId: 'desktop-hub',
      label: 'Desktop Master Hub',
      role: 'Master',
      platform: 'Desktop',
      linkType: 'Local',
      totalRamMb: 32768,
      availableRamMb: 23500,
      vramFreeMb: 11200,
      memBwGbps: 145.0,
      computeTflops: 22.6,
      rttMs: 0.2,
      pktLossPct: 0,
      tempC: 62.0,
      isConnected: true,
    },
    {
      ...thisBrowserNode,
      label: isAndroidBrowser ? 'This Phone (Worker)' : 'This Browser Node',
      role: 'Worker',
      linkType: telemetry.usbLoopbackOnly ? 'USB-C Tunnel' : 'Wi-Fi LAN',
      rttMs: telemetry.usbLoopbackOnly ? 0.7 : 3.9,
    },
    {
      nodeId: 'android-usb',
      label: 'Pixel Worker (USB-C)',
      role: 'Worker',
      platform: 'Android',
      linkType: 'USB-C Tunnel',
      totalRamMb: 8192,
      availableRamMb: 5200,
      vramFreeMb: 0,
      memBwGbps: 34.0,
      computeTflops: 2.1,
      rttMs: 0.9,
      pktLossPct: 0,
      tempC: Math.max(33, 35.5 + simulatedTempOffsetC),
      isConnected: true,
    },
    {
      nodeId: 'edge-arm',
      label: 'Raspberry Pi / Edge Node',
      role: 'Worker',
      platform: 'Edge ARM',
      linkType: 'Ethernet 2.5G',
      totalRamMb: 4096,
      availableRamMb: 2800,
      vramFreeMb: 0,
      memBwGbps: 17.5,
      computeTflops: 0.9,
      rttMs: 1.8,
      pktLossPct: 0,
      tempC: 49.0,
      isConnected: true,
    },
  ];
}

export function planStarCluster(
  rawNodes: StarClusterNode[],
  model: GgufModelPreset,
  limits: ThermalLimits = DEFAULT_THERMAL_LIMITS
): StarClusterPlan {
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
  const neededMb = model.sizeMb;
  const totalScore = active.reduce((acc, n) => acc + n.score, 0);

  // Greedy capacity-aware layer & MB distribution across active star nodes
  let remainingNeed = Math.min(neededMb, totalSafePoolMb);
  const sortedActive = [...active].sort((a, b) => b.score - a.score);

  for (const node of sortedActive) {
    if (remainingNeed <= 0 || totalScore <= 0) break;
    const targetWeight = node.score / totalScore;
    const proportionalMb = Math.round(neededMb * targetWeight);
    const alloc = Math.min(node.effectiveCapMb, Math.max(256, proportionalMb), remainingNeed);
    node.allocatedMb = alloc;
    remainingNeed -= alloc;
  }

  // Fill any residual if headroom exists on active nodes
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
  for (const node of evaluated) {
    if (node.allocatedMb > 0) {
      node.sharePct = Math.round((node.allocatedMb / totalAllocated) * 100);
      node.allocatedLayers = Math.max(
        1,
        Math.round((node.allocatedMb / totalAllocated) * model.layers)
      );
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

  const master = evaluated.find((n) => n.role === 'Master') ?? evaluated[0];
  const splitParts = evaluated.filter((n) => n.allocatedMb > 0).map((n) => `${n.sharePct}%`);

  return {
    tierCode,
    tierLabel,
    masterId: master?.label ?? 'Local Hub',
    fitVerdict,
    totalSafePoolMb,
    neededMb,
    coveragePct,
    overallThermalState,
    nodes: evaluated,
    tensorSplitLabel: splitParts.length > 0 ? splitParts.join(' / ') : '0%',
  };
}
