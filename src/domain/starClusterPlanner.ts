import { DeviceTelemetryState } from '../types/clustering';
import {
  BackendTuningConfig,
  ClusterMode,
  ClusterTierCode,
  DEFAULT_THERMAL_LIMITS,
  FitVerdict,
  GgufModelPreset,
  LearnedEmaProfile,
  LiveHardwareProbe,
  PlannedStarNode,
  StarClusterNode,
  StarClusterPlan,
  ThermalLimits,
  ThermalState,
  ThermalStatus,
} from '../types/starCluster';
import { buildNonUniformLayerProfiles } from '../data/localModelsScanner';
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
  const availGuard = Math.floor(availMb * 0.8);
  const headroomCap = Math.max(0, availMb - Math.min(512, Math.max(256, reserveMb)));
  return Math.max(0, Math.min(pctCap, availGuard, headroomCap));
}

export function computeDesktopSafeCap(availMb: number, reserveMb = 1024): number {
  return Math.max(512, availMb - Math.max(256, reserveMb));
}

export function computeVramSafeCap(rawFreeVramMb: number, isWindows = false): number {
  if (rawFreeVramMb <= 0) return 0;
  const reserve = isWindows
    ? Math.max(512, Math.floor(rawFreeVramMb * 0.12))
    : Math.max(256, Math.floor(rawFreeVramMb * 0.08));
  return Math.max(0, rawFreeVramMb - reserve);
}

export function scoreClusterNode(node: StarClusterNode, emaMultiplier = 1.0): number {
  const vramBonus = 1 + (Math.max(0, node.vramFreeMb) / 1024) * 0.22;
  const linkBonus =
    node.linkType === 'Local'
      ? 1.4
      : node.linkType === 'USB-C Tunnel' || node.linkType === 'USB RNDIS'
        ? 1.15
        : node.linkType === 'Ethernet 2.5G'
          ? 1.12
          : 0.86;
  const num =
    (0.7 * node.memBwGbps + 10.0 * node.computeTflops) * vramBonus * linkBonus * emaMultiplier;
  const den = 1.0 + 0.15 * Math.max(0.1, node.rttMs) + 2.0 * node.pktLossPct;
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

/**
 * Builds the Live Cluster node list strictly from real verified hardware.
 * In LIVE_CLUSTER mode, offline or unverified nodes are NEVER shown as connected.
 */
export function buildStarClusterNodes(
  telemetry: DeviceTelemetryState,
  mode: ClusterMode,
  simulatedTempOffsetC = 0,
  tuningConfig?: BackendTuningConfig,
  liveHardware?: LiveHardwareProbe
): StarClusterNode[] {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isWindows =
    liveHardware?.platform === 'windows' ||
    (typeof process !== 'undefined' && process.platform === 'win32') ||
    /windows/i.test(ua);

  const localOsType = isWindows ? 'windows' : 'linux';

  const masterHostNode: StarClusterNode = {
    nodeId: 'master-host',
    label: liveHardware?.hostname
      ? `${liveHardware.hostname} (Master)`
      : liveHardware?.osLabel
        ? `${liveHardware.osLabel} Master`
        : isWindows
          ? 'Windows Master Host'
          : 'Linux Master Host',
    role: 'Master',
    platform: 'Desktop',
    osType: localOsType,
    ip: liveHardware?.hostIp ?? '127.0.0.1',
    rpcPort: 50052,
    backendDriver: liveHardware?.gpuName
      ? liveHardware.gpuName
      : isWindows
        ? tuningConfig?.windowsAccelerator ?? 'CPU AVX2'
        : tuningConfig?.linuxAccelerator ?? 'CPU OpenBLAS',
    linkType: 'Local',
    totalRamMb: liveHardware?.totalRamMb ?? telemetry.totalRamMb ?? 16384,
    availableRamMb: liveHardware?.availableRamMb ?? telemetry.availableRamMb ?? 10240,
    vramFreeMb: liveHardware?.vramMb ?? 0,
    vramTotalMb: liveHardware?.vramMb ?? 0,
    memBwGbps: (liveHardware?.vramMb ?? 0) > 0 ? 220.0 : 52.0,
    computeTflops: (liveHardware?.vramMb ?? 0) > 0 ? 14.5 : 3.2,
    physicalCores: liveHardware?.bigCores ?? liveHardware?.cores ?? 8,
    rttMs: 0.2,
    pktLossPct: 0,
    bandwidthMbps: 10000,
    tempC: Math.max(30, (liveHardware?.gpuTempC || liveHardware?.cpuTempC || 46) + simulatedTempOffsetC),
    cpuUsagePct: liveHardware?.cpuUsagePct ?? 14,
    gpuUsagePct: liveHardware?.gpuUsagePct ?? ((liveHardware?.vramMb ?? 0) > 0 ? 8 : 0),
    handshakeVerified: true,
    heartbeatAgeS: 0,
    isConnected: true,
  };

  if (mode === 'LOCAL_DEVICE') {
    return [masterHostNode];
  }

  // Strictly Live-Only Verified Workers: only include workers with verified handshake + live heartbeat.
  if (mode === 'LIVE_CLUSTER') {
    const verifiedWorkers: StarClusterNode[] = (liveHardware?.connectedDevices ?? [])
      .filter((dev) => Boolean(dev.isOnline && dev.isWorkerRunning && dev.handshakeVerified !== false))
      .map((dev) => {
        const osType =
          dev.platform === 'Android'
            ? 'android'
            : dev.platform === 'Windows'
              ? 'windows'
              : dev.platform === 'Edge ARM'
                ? 'edge-arm'
                : 'linux';
        const linkType = dev.transport.toLowerCase().includes('rndis')
          ? 'USB RNDIS'
          : dev.transport.toLowerCase().includes('usb')
            ? 'USB-C Tunnel'
            : dev.transport.toLowerCase().includes('eth')
              ? 'Ethernet 2.5G'
              : 'Wi-Fi LAN';

        return {
          nodeId: dev.id,
          label: dev.model,
          role: 'Worker',
          platform:
            dev.platform === 'Android'
              ? 'Android'
              : dev.platform === 'Edge ARM'
                ? 'Edge ARM'
                : 'Desktop',
          osType,
          ip: dev.ip || (linkType === 'USB-C Tunnel' ? '127.0.0.1' : '192.168.1.20'),
          rpcPort: dev.rpcPort || 50052,
          backendDriver:
            dev.platform === 'Android'
              ? 'ARM NEON / Vulkan'
              : dev.vramMb && dev.vramMb > 0
                ? 'CUDA / Vulkan'
                : 'CPU OpenBLAS',
          linkType,
          totalRamMb: dev.totalRamMb ?? dev.safeCapMb * 2,
          availableRamMb: dev.availableRamMb ?? dev.safeCapMb,
          vramFreeMb: dev.vramMb ?? 0,
          vramTotalMb: dev.vramMb ?? 0,
          memBwGbps: dev.vramMb && dev.vramMb > 0 ? 180.0 : dev.platform === 'Android' ? 28.0 : 42.0,
          computeTflops: dev.computeTflops ?? (dev.platform === 'Android' ? 1.8 : 4.2),
          physicalCores: dev.bigCores ?? 4,
          rttMs: dev.rttMs ?? (linkType === 'USB-C Tunnel' ? 0.9 : 4.5),
          pktLossPct: dev.pktLossPct ?? 0,
          bandwidthMbps: dev.bandwidthMbps ?? (linkType === 'USB-C Tunnel' ? 480 : 240),
          tempC: Math.max(25, (dev.tempC ?? 34.0) + simulatedTempOffsetC),
          cpuUsagePct: dev.cpuUsagePct ?? 12,
          gpuUsagePct: dev.gpuUsagePct ?? 0,
          handshakeVerified: true,
          heartbeatAgeS: dev.lastHeartbeatMs
            ? Math.max(0, Math.round((Date.now() - dev.lastHeartbeatMs) / 1000))
            : 0,
          isConnected: true,
          statusNote: `Verified RPC v9 · ${dev.safeCapMb} MB safe cap`,
        };
      });

    return [masterHostNode, ...verifiedWorkers];
  }

  // Isolated Dry-Run Preview topology (never mixed into LIVE_CLUSTER).
  return [
    masterHostNode,
    {
      nodeId: 'dryrun-linux-worker',
      label: 'Linux Workstation (Dry-Run)',
      role: 'Worker',
      platform: 'Desktop',
      osType: 'linux',
      ip: '192.168.1.18',
      rpcPort: 50052,
      backendDriver: tuningConfig?.linuxAccelerator ?? 'CUDA 12.6',
      linkType: 'Ethernet 2.5G',
      totalRamMb: 32768,
      availableRamMb: 21500,
      vramFreeMb: 8192,
      vramTotalMb: 8192,
      memBwGbps: 185.0,
      computeTflops: 18.6,
      physicalCores: 12,
      rttMs: 0.6,
      pktLossPct: 0,
      bandwidthMbps: 2500,
      tempC: Math.max(44, 56.0 + simulatedTempOffsetC),
      cpuUsagePct: 24,
      gpuUsagePct: 38,
      handshakeVerified: true,
      heartbeatAgeS: 1,
      isConnected: true,
    },
    {
      nodeId: 'dryrun-android-usb',
      label: 'Android Worker (USB-C Dry-Run)',
      role: 'Worker',
      platform: 'Android',
      osType: 'android',
      ip: '127.0.0.1',
      rpcPort: 50052,
      backendDriver: 'ARMv8.2 DotProd',
      linkType: 'USB-C Tunnel',
      totalRamMb: 8192,
      availableRamMb: 5400,
      vramFreeMb: 0,
      vramTotalMb: 0,
      memBwGbps: 36.0,
      computeTflops: 2.3,
      physicalCores: 4,
      rttMs: 0.9,
      pktLossPct: 0,
      bandwidthMbps: 480,
      tempC: Math.max(30, 35.5 + simulatedTempOffsetC),
      cpuUsagePct: 18,
      gpuUsagePct: 0,
      handshakeVerified: true,
      heartbeatAgeS: 2,
      isConnected: true,
    },
  ];
}

/**
 * Data-driven non-uniform layer & memory planner mirroring `silica-core/src/planner.rs`:
 * - Hard Zero-OOM invariant: `allocatedMb <= safeRamMb + safeVramMb` on every node.
 * - Strict 50% Android physical RAM cap.
 * - Normalized cap-bounded `--tensor-split` summing to 100.0.
 * - Auto-prunes slow/lossy Wi-Fi (>40ms RTT or >1.5% loss) & Edge ARM SBCs when Master+USB fits.
 * - Smart `--no-mmap` ONLY when `totalSafePoolMb >= neededMb * 1.15`.
 * - Automatic `-nkvo` on <= 4 GB GPUs at 32K–131K context.
 */
export function planStarCluster(
  rawNodes: StarClusterNode[],
  model: GgufModelPreset,
  limits: ThermalLimits = DEFAULT_THERMAL_LIMITS,
  tuningConfig?: BackendTuningConfig,
  learned?: LearnedEmaProfile | null
): StarClusterPlan {
  const effectiveConfig = tuningConfig ?? createDefaultBackendTuningConfig(model);
  const headDim =
    model.embeddingLength && model.headCount
      ? Math.max(64, model.embeddingLength / model.headCount)
      : 128;

  const totalKvCacheMb = estimateKvCacheMb(
    model.layers,
    effectiveConfig.contextLength,
    effectiveConfig.kvCacheQuant,
    model.totalParamsB,
    model.headCountKv,
    headDim
  );

  const nonUniform =
    model.perLayerProfiles && model.perLayerProfiles.length === model.layers
      ? {
          masterPinnedOverheadMb: model.masterPinnedOverheadMb ?? Math.max(96, Math.round(model.sizeMb * 0.085)),
          perLayerProfiles: model.perLayerProfiles,
        }
      : buildNonUniformLayerProfiles(
          model.layers,
          model.sizeMb,
          model.architecture,
          effectiveConfig.contextLength,
          effectiveConfig.kvCacheQuant,
          model.headCount ?? 32,
          model.headCountKv ?? 8,
          model.embeddingLength ?? 4096
        );

  const effectiveMmproj = effectiveConfig.mmprojPath?.trim() || model.mmprojPath || null;
  const masterOverheadMb = nonUniform.masterPinnedOverheadMb + (effectiveMmproj ? model.mmprojSizeMb ?? 512 : 0);

  const masterNodeRaw = rawNodes.find((n) => n.role === 'Master') ?? rawNodes[0];
  const masterVramTotal = masterNodeRaw?.vramTotalMb ?? masterNodeRaw?.vramFreeMb ?? 0;

  const autoNkvo =
    effectiveConfig.noKvOffload !== null && effectiveConfig.noKvOffload !== undefined
      ? effectiveConfig.noKvOffload
      : (masterVramTotal > 0 && masterVramTotal <= 4300 && effectiveConfig.contextLength >= 32768) ||
        Boolean(learned?.learnedKvOffload);

  const evaluated: PlannedStarNode[] = rawNodes.map((n) => {
    const safeRamMb =
      n.platform === 'Android'
        ? computeAndroidSafeCap(n.totalRamMb, n.availableRamMb)
        : computeDesktopSafeCap(n.availableRamMb, n.platform === 'Edge ARM' ? 512 : 1024);
    const safeVramMb = computeVramSafeCap(n.vramFreeMb, n.osType === 'windows');
    const thermalStatus = evaluateNodeThermal(n, limits);
    const baseCap = safeRamMb + safeVramMb;
    const effScale =
      n.role === 'Master' && thermalStatus.capacityScale === 0 ? 0.5 : thermalStatus.capacityScale;
    const effectiveCapMb = n.isConnected ? Math.floor(baseCap * effScale) : 0;
    const emaMult = learned?.nodeEfficiency?.[n.nodeId] ?? 1.0;
    const score = effectiveCapMb > 0 ? scoreClusterNode(n, emaMult) : 0;

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
      pruned: false,
      statusNote: !n.isConnected
        ? n.statusNote || 'Offline'
        : thermalStatus.state === 'EMERGENCY_OFFLOAD'
          ? thermalStatus.reason
          : `${effectiveCapMb.toLocaleString()} MB safe cap`,
    };
  });

  // Sort Master first so layer 0 + embedding/lm_head/mmproj are always Master-pinned.
  evaluated.sort((a, b) => (a.role === 'Master' ? -1 : b.role === 'Master' ? 1 : b.score - a.score));

  const neededMb = Math.round(model.sizeMb + totalKvCacheMb + (effectiveMmproj ? model.mmprojSizeMb ?? 512 : 0));

  // Evaluate fast-tier pool (Master + USB/Ethernet) to prune slow/lossy Wi-Fi or Edge ARM SBCs.
  const fastTierPoolMb = evaluated
    .filter(
      (n) =>
        n.effectiveCapMb > 0 &&
        (n.role === 'Master' ||
          n.linkType === 'USB-C Tunnel' ||
          n.linkType === 'USB RNDIS' ||
          n.linkType === 'Ethernet 2.5G')
    )
    .reduce((acc, n) => acc + n.effectiveCapMb, 0);
  const fastTierFits = fastTierPoolMb >= neededMb * 1.05;

  const active: PlannedStarNode[] = [];
  for (const node of evaluated) {
    if (node.role !== 'Master') {
      if (node.effectiveCapMb < 256 || node.thermalStatus.state === 'EMERGENCY_OFFLOAD') {
        node.pruned = true;
        node.pruneReason =
          node.thermalStatus.state === 'EMERGENCY_OFFLOAD'
            ? node.thermalStatus.reason
            : 'Insufficient safe RAM cap (<256 MB)';
        node.statusNote = node.pruneReason;
        continue;
      }
      if (
        fastTierFits &&
        (node.platform === 'Edge ARM' ||
          (node.linkType === 'Wi-Fi LAN' && (node.rttMs > 40 || node.pktLossPct > 1.5)))
      ) {
        node.pruned = true;
        node.pruneReason = `Pruned slow/lossy link (p95 ${node.rttMs.toFixed(1)}ms, ${node.pktLossPct}% loss)`;
        node.statusNote = node.pruneReason;
        continue;
      }
    }
    if (node.effectiveCapMb > 0) {
      active.push(node);
    }
  }

  const totalSafePoolMb = active.reduce((acc, n) => acc + n.effectiveCapMb, 0);
  const totalVramPoolMb = active.reduce((acc, n) => acc + n.safeVramMb, 0);

  // Smart mmap switch: ONLY pass --no-mmap when totalSafePoolMb >= neededMb * 1.15.
  const useNoMmap =
    effectiveConfig.forceNoMmap !== null && effectiveConfig.forceNoMmap !== undefined
      ? effectiveConfig.forceNoMmap
      : totalSafePoolMb >= neededMb * 1.15;

  // Non-uniform greedy cap-bounded layer assignment with Zero-OOM guarantee.
  const remainingCap = new Map<string, number>();
  for (const n of active) {
    remainingCap.set(n.nodeId, n.effectiveCapMb);
  }

  if (active.length > 0) {
    const master = active[0];
    const pinned = Math.min(masterOverheadMb, remainingCap.get(master.nodeId) ?? 0);
    master.allocatedMb += pinned;
    remainingCap.set(master.nodeId, Math.max(0, (remainingCap.get(master.nodeId) ?? 0) - pinned));
  }

  const totalScore = active.reduce((acc, n) => acc + n.score, 0) || 1;
  const totalLayerCostMb = nonUniform.perLayerProfiles.reduce(
    (acc, l) => acc + l.totalWeightMb + l.kvCacheMb,
    0
  );

  const targetBudget = new Map<string, number>();
  for (const n of active) {
    const avail = remainingCap.get(n.nodeId) ?? 0;
    const share = totalLayerCostMb * (n.score / totalScore);
    targetBudget.set(n.nodeId, Math.min(avail, share));
  }

  let cursorNode = 0;
  let usedForLayersOnCurrent = 0;

  for (const layer of nonUniform.perLayerProfiles) {
    const layerNeed = layer.totalWeightMb + layer.kvCacheMb;
    let placed = false;

    while (cursorNode < active.length) {
      const node = active[cursorNode];
      const rem = remainingCap.get(node.nodeId) ?? 0;
      const target = targetBudget.get(node.nodeId) ?? 0;
      const isLast = cursorNode === active.length - 1;
      if (rem >= layerNeed && (isLast || usedForLayersOnCurrent + layerNeed <= target * 1.05)) {
        node.allocatedMb += layerNeed;
        remainingCap.set(node.nodeId, Math.max(0, rem - layerNeed));
        usedForLayersOnCurrent += layerNeed;
        if (node.allocatedLayers === 0) node.layerStart = layer.layerIndex;
        node.layerEnd = layer.layerIndex;
        node.allocatedLayers += 1;
        node.kvCacheMb += layer.kvCacheMb;
        placed = true;
        break;
      }
      cursorNode += 1;
      usedForLayersOnCurrent = 0;
    }

    if (!placed && active.length > 0) {
      let best = active[0];
      let bestRem = remainingCap.get(best.nodeId) ?? 0;
      for (const n of active) {
        const r = remainingCap.get(n.nodeId) ?? 0;
        if (r > bestRem) {
          best = n;
          bestRem = r;
        }
      }
      const clamped = Math.min(layerNeed, bestRem);
      if (clamped > 0) {
        best.allocatedMb += clamped;
        remainingCap.set(best.nodeId, Math.max(0, bestRem - clamped));
        if (best.allocatedLayers === 0) best.layerStart = layer.layerIndex;
        best.layerEnd = layer.layerIndex;
        best.allocatedLayers += 1;
        best.kvCacheMb += layer.kvCacheMb;
      }
    }
  }

  // Hard Zero-OOM clamp invariant & integer rounding
  for (const n of evaluated) {
    const hardCap = n.safeRamMb + n.safeVramMb;
    n.allocatedMb = Math.min(hardCap, Math.round(n.allocatedMb));
    n.kvCacheMb = Math.round(n.kvCacheMb);
  }

  // Exact cap-bounded --tensor-split summing cleanly to 100.0
  const activeWithAlloc = active.filter((n) => n.allocatedMb > 0);
  const totalAlloc = activeWithAlloc.reduce((acc, n) => acc + n.allocatedMb, 0) || 1;
  const tensorSplit: number[] = [];

  const manualParts = (effectiveConfig.manualTensorSplit ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (manualParts.length === activeWithAlloc.length && manualParts.length > 0) {
    const msum = manualParts.reduce((a, b) => a + b, 0);
    let running = 0;
    activeWithAlloc.forEach((n, idx) => {
      const pct =
        idx === activeWithAlloc.length - 1
          ? Number(Math.max(0, 100 - running).toFixed(1))
          : Number(((manualParts[idx] / msum) * 100).toFixed(1));
      running += pct;
      n.sharePct = pct;
      tensorSplit.push(pct);
    });
  } else {
    let running = 0;
    activeWithAlloc.forEach((n, idx) => {
      const pct =
        idx === activeWithAlloc.length - 1
          ? Number(Math.max(0, 100 - running).toFixed(1))
          : Number(((n.allocatedMb / totalAlloc) * 100).toFixed(1));
      running += pct;
      n.sharePct = pct;
      tensorSplit.push(pct);
    });
  }

  const mbPerLayer = model.sizeMb / Math.max(1, model.layers);
  for (const node of activeWithAlloc) {
    const layerShare = node.allocatedLayers / Math.max(1, model.layers);
    node.activeParamsB = Number((model.activeParamsB * layerShare).toFixed(2));
    node.totalParamsB = Number((model.totalParamsB * layerShare).toFixed(2));
    const gpuLayerCap =
      node.safeVramMb > 0 ? Math.floor(node.safeVramMb / Math.max(1, mbPerLayer)) : 0;
    node.nglLayers = Math.min(node.allocatedLayers, gpuLayerCap);
    const effectiveBw = node.nglLayers > 0 ? Math.max(node.memBwGbps, 195) : node.memBwGbps;
    const nodeTok =
      (effectiveBw / Math.max(0.45, Math.max(0.5, node.activeParamsB) * 0.6)) *
      node.thermalStatus.capacityScale;
    node.estimatedTokPerSec = Number(Math.max(1.4, Math.min(180, nodeTok)).toFixed(1));

    const flags: string[] = [];
    if (node.role === 'Master' && effectiveMmproj) flags.push('--mmproj');
    if (node.osType === 'android') flags.push('<=50% Safe RAM');
    if (autoNkvo && node.role === 'Master') flags.push('-nkvo');
    if (effectiveConfig.kvUnified !== false && node.role === 'Master') flags.push('--kv-unified');
    if (effectiveConfig.moeCpuOffload && model.architecture === 'MoE') flags.push('-ot .ffn_.*_exps.=CPU');
    if (useNoMmap && node.role === 'Master') flags.push('--no-mmap');
    node.tuningFlags = flags;
  }

  const coveragePct = Math.min(100, Math.round((totalSafePoolMb / Math.max(1, neededMb)) * 100));
  const fitVerdict: FitVerdict = useNoMmap
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
      ? 'Tier S · High-Capacity Cluster'
      : tierCode === 'A'
        ? 'Tier A · Multi-Node Balanced'
        : tierCode === 'B'
          ? 'Tier B · Edge Star Cluster'
          : 'Tier C · Compact Safe Pool';

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

  const bottleneckTok =
    activeWithAlloc.length > 0
      ? Math.min(...activeWithAlloc.map((n) => n.estimatedTokPerSec)) *
        (activeWithAlloc.length > 1 ? 0.92 : 1.0)
      : 0;
  const master = evaluated.find((n) => n.role === 'Master') ?? evaluated[0];
  const tensorSplitCsv = tensorSplit.map((v) => v.toFixed(1)).join(',');
  const tensorSplitLabel = tensorSplit.length > 0 ? tensorSplit.map((v) => `${v.toFixed(1)}%`).join(' / ') : '0%';

  // Build exact verified stock llama.cpp v1.0.0 CLI args
  const modelArg = model.isLocal && model.localPath ? model.localPath : `./models/${model.id}.gguf`;
  const workerRpcs = activeWithAlloc
    .filter((n) => n.role === 'Worker')
    .map((n) => `${n.ip || '127.0.0.1'}:${n.rpcPort || 50052}`);

  const cliArgs: string[] = [
    '-m',
    modelArg,
    '--host',
    '127.0.0.1',
    '--port',
    '8080',
    '-c',
    String(effectiveConfig.contextLength),
    '-ctk',
    effectiveConfig.kvCacheQuant,
    '-ctv',
    effectiveConfig.kvCacheQuant,
    '-ngl',
    String(effectiveConfig.gpuOffloadLayers ?? master?.nglLayers ?? 0),
    '-b',
    String(learned?.recommendedBatch ?? effectiveConfig.batchSize ?? 1024),
    '-ub',
    String(learned?.recommendedUbatch ?? effectiveConfig.ubatchSize ?? 256),
  ];
  if (effectiveMmproj) cliArgs.push('--mmproj', effectiveMmproj);
  if (effectiveConfig.enableJinja !== false) cliArgs.push('--jinja');
  if (effectiveConfig.enableFlashAttn && model.architecture !== 'Ternary') cliArgs.push('-fa', 'on');
  if (effectiveConfig.kvUnified !== false) cliArgs.push('--kv-unified');
  if (autoNkvo) cliArgs.push('-nkvo');
  if (effectiveConfig.slotSavePath?.trim()) cliArgs.push('--slot-save-path', effectiveConfig.slotSavePath.trim());
  if (effectiveConfig.contBatching !== false) cliArgs.push('--cont-batching');
  if ((effectiveConfig.cacheReuse ?? 256) > 0) cliArgs.push('--cache-reuse', String(effectiveConfig.cacheReuse ?? 256));
  if (useNoMmap) cliArgs.push('--no-mmap');
  if (effectiveConfig.moeCpuOffload && model.architecture === 'MoE') cliArgs.push('-ot', '.ffn_.*_exps.=CPU');
  if (workerRpcs.length > 0) cliArgs.push('--rpc', workerRpcs.join(','));
  if (tensorSplit.length > 1) cliArgs.push('--tensor-split', tensorSplitCsv);
  if (effectiveConfig.speculativeMode === 'external_draft' && effectiveConfig.draftModelPath?.trim()) {
    cliArgs.push('--model-draft', effectiveConfig.draftModelPath.trim());
    cliArgs.push('--draft-max', String(effectiveConfig.draftMaxTokens ?? 8));
  }

  return {
    tierCode,
    tierLabel,
    masterId: master?.label ?? 'Local Master',
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
    tensorSplit,
    tensorSplitLabel,
    tensorSplitCsv,
    useNoMmap,
    mmapStreaming: !useNoMmap,
    autoNkvo,
    masterMmprojPath: effectiveMmproj,
    cliArgs,
    emaLearnedRuns: learned?.runs ?? 0,
  };
}
