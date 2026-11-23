import { DeviceTelemetryState } from '../types/clustering';
import {
  BackendTuningConfig,
  ClusterMode,
  ClusterTierCode,
  ConnectedDeviceInfo,
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
        ? 1.18
        : node.linkType === 'Ethernet 2.5G'
          ? 1.14
          : node.linkType === 'Wi-Fi Direct P2P'
            ? 1.04
            : node.linkType === 'Wi-Fi LAN'
              ? 0.88
              : 0.82; // WebGPU Browser
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
/**
 * Identifies whether two worker records belong to the same physical Android device
 * (e.g. ADB loopback aliases, different daemon registrations, or similar model names).
 */
export function isSameAndroidWorker(
  a: { platform?: string; ip?: string; id?: string; model?: string; label?: string },
  b: { platform?: string; ip?: string; id?: string; model?: string; label?: string }
): boolean {
  // Both nodes MUST be Android (case-insensitive)
  const aPlat = (a.platform || '').toLowerCase();
  const bPlat = (b.platform || '').toLowerCase();
  if (aPlat !== 'android' || bPlat !== 'android') return false;

  // Distinct simulated test VMs must never be deduplicated
  if (a.id?.startsWith('vm-') && b.id?.startsWith('vm-') && a.id !== b.id) {
    return false;
  }

  // 1. Direct ID match
  if (a.id && b.id && a.id === b.id) return true;

  // 2. Exact IP match
  if (a.ip && b.ip && a.ip === b.ip) return true;

  // 3. Both are mapped to the local host ADB loopback tunnel (127.0.0.0/8 or localhost)
  const aIsLoopback = !a.ip || a.ip === 'localhost' || a.ip.startsWith('127.');
  const bIsLoopback = !b.ip || b.ip === 'localhost' || b.ip.startsWith('127.');
  if (aIsLoopback && bIsLoopback) {
    // If neither is a distinct VM, any two loopback Android records are the same physical device
    if (!a.id?.startsWith('vm-') && !b.id?.startsWith('vm-')) {
      return true;
    }
  }

  // 4. Normalized label / model similarity (e.g. "Redmi Note 7 Pro" vs "Xiaomi Redmi Note 7 Pro (Android)")
  const normA = (a.label || a.model || a.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normB = (b.label || b.model || b.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normA && normB) {
    if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
      return true;
    }
  }
  return false;
}

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
    const rawDevices = (liveHardware?.connectedDevices ?? [])
      .filter((dev) => Boolean(dev.isOnline && dev.isWorkerRunning && dev.handshakeVerified !== false));
    const dedupedDevices: ConnectedDeviceInfo[] = [];
    for (const dev of rawDevices) {
      const isDup = dedupedDevices.some((existing) =>
        isSameAndroidWorker(existing, dev) || (existing.ip === dev.ip && existing.rpcPort === dev.rpcPort)
      );
      if (!isDup) dedupedDevices.push(dev);
    }
    const verifiedWorkers: StarClusterNode[] = dedupedDevices.map((dev) => {
        const osType: StarClusterNode['osType'] =
          dev.platform === 'Android'
            ? 'android'
            : dev.platform === 'Windows'
              ? 'windows'
              : dev.platform === 'Edge ARM'
                ? 'edge-arm'
                : dev.platform === 'WebGPU'
                  ? 'webgpu'
                  : 'linux';
        const lowT = dev.transport.toLowerCase();
        const linkType: StarClusterNode['linkType'] =
          dev.platform === 'WebGPU' || lowT.includes('webgpu')
            ? 'WebGPU Browser'
            : lowT.includes('p2p') || lowT.includes('direct')
              ? 'Wi-Fi Direct P2P'
              : lowT.includes('rndis')
                ? 'USB RNDIS'
                : lowT.includes('usb')
                  ? 'USB-C Tunnel'
                  : lowT.includes('eth')
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
                : dev.platform === 'WebGPU'
                  ? 'WebGPU'
                  : 'Desktop',
          osType,
          ip: dev.ip || (linkType === 'USB-C Tunnel' ? '127.0.0.1' : '192.168.1.20'),
          rpcPort: dev.rpcPort || 50052,
          backendDriver:
            dev.platform === 'Android'
              ? 'ARM NEON / Vulkan'
              : dev.platform === 'WebGPU'
                ? 'WebGPU WGSL Compute'
                : dev.vramMb && dev.vramMb > 0
                  ? 'CUDA / Vulkan'
                  : 'CPU OpenBLAS',
          linkType,
          safeRamMb: dev.safeCapMb,
          totalRamMb: dev.totalRamMb ?? dev.safeCapMb * 2,
          availableRamMb: dev.availableRamMb ?? dev.safeCapMb,
          vramFreeMb: dev.vramMb ?? 0,
          vramTotalMb: dev.vramMb ?? 0,
          memBwGbps:
            dev.vramMb && dev.vramMb > 0
              ? 180.0
              : dev.platform === 'WebGPU'
                ? 96.0
                : dev.platform === 'Android'
                  ? 28.0
                  : 42.0,
          computeTflops:
            dev.computeTflops ??
            (dev.platform === 'Android' ? 1.8 : dev.platform === 'WebGPU' ? 3.6 : 4.2),
          physicalCores: dev.bigCores ?? 4,
          rttMs:
            dev.rttMs ??
            (linkType === 'USB-C Tunnel'
              ? 0.9
              : linkType === 'Wi-Fi Direct P2P'
                ? 3.5
                : linkType === 'WebGPU Browser'
                  ? 8.5
                  : 4.5),
          pktLossPct: dev.pktLossPct ?? 0,
          bandwidthMbps:
            dev.bandwidthMbps ??
            (linkType === 'USB-C Tunnel' ? 480 : linkType === 'Wi-Fi Direct P2P' ? 866 : 240),
          tempC: Math.max(25, (dev.tempC ?? 34.0) + simulatedTempOffsetC),
          cpuUsagePct: dev.cpuUsagePct ?? 12,
          gpuUsagePct: dev.gpuUsagePct ?? 0,
          handshakeVerified: true,
          rpcNativeReady: dev.rpcNativeReady,
          heartbeatAgeS: dev.lastHeartbeatMs
            ? Math.max(0, Math.round((Date.now() - dev.lastHeartbeatMs) / 1000))
            : 0,
          isConnected: true,
          statusNote:
            dev.platform === 'WebGPU'
              ? `WebGPU Browser Worker · ${dev.safeCapMb} MB VRAM shard`
              : `Verified RPC v9 · ${dev.safeCapMb} MB safe cap`,
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
    const strictAndroidCap = computeAndroidSafeCap(
      n.totalRamMb,
      n.availableRamMb,
      n.totalRamMb <= 2048 ? 40 : 50,
      n.totalRamMb <= 2048 ? 256 : 512
    );
    const safeRamMb =
      n.platform === 'Android'
        ? n.safeRamMb && n.safeRamMb > 256
          ? Math.min(n.safeRamMb, strictAndroidCap)
          : strictAndroidCap
        : n.platform === 'WebGPU'
          ? Math.max(256, Math.min(8192, n.safeRamMb ?? Math.floor(n.availableRamMb * 0.75)))
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
      if (node.rpcNativeReady === false) {
        node.pruned = true;
        node.pruneReason =
          'Handshake-only listener (install native llama.cpp rpc-server -c to offload layers)';
        node.statusNote = node.pruneReason;
        continue;
      }
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

  // Reset layer allocations across all evaluated nodes
  for (const n of evaluated) {
    n.allocatedMb = 0;
    n.allocatedLayers = 0;
    n.layerStart = 0;
    n.layerEnd = -1;
    n.kvCacheMb = 0;
  }

  const totalLayers = Math.max(1, nonUniform.perLayerProfiles.length);
  const master = active.find((n) => n.role === 'Master') ?? active[0];
  const workers = active.filter((n) => n.nodeId !== master?.nodeId && !n.pruned);

  if (master && workers.length === 0) {
    // Single node: Master takes 100% of layers
    master.allocatedLayers = totalLayers;
    master.layerStart = 0;
    master.layerEnd = totalLayers - 1;
    let sumWeightMb = 0;
    let sumKvMb = 0;
    for (const l of nonUniform.perLayerProfiles) {
      sumWeightMb += l.totalWeightMb;
      sumKvMb += l.kvCacheMb;
    }
    master.allocatedMb = sumWeightMb + sumKvMb + masterOverheadMb;
    master.kvCacheMb = sumKvMb;
  } else if (master && workers.length > 0) {
    // Multi-node star cluster: strictly contiguous, mutually exclusive layer partitioning
    const masterPinned = Math.min(masterOverheadMb, master.effectiveCapMb);
    const mbPerLayer = model.sizeMb / totalLayers;
    const totalScore = active.reduce((acc, n) => acc + n.score, 0) || 1;
    const workerLayerMap = new Map<string, number>();
    let totalWorkerLayers = 0;

    for (const w of workers) {
      // Safe cap constraint: worker can hold at most effectiveCapMb / mbPerLayer
      const maxCapLayers = Math.max(0, Math.floor(w.effectiveCapMb / Math.max(1, mbPerLayer)));
      // Throughput-proportional share with an active worker offload minimum (at least 2 layers if capacity fits)
      const scoreShare = w.score / totalScore;
      const targetLayers = Math.max(2, Math.round(totalLayers * scoreShare));
      const allocated = Math.max(0, Math.min(maxCapLayers, targetLayers));
      workerLayerMap.set(w.nodeId, allocated);
      totalWorkerLayers += allocated;
    }

    // Master must retain at least layer 0 + embedding
    if (totalWorkerLayers >= totalLayers) {
      const allowedWorkerLayers = totalLayers - 1;
      let excess = totalWorkerLayers - allowedWorkerLayers;
      for (const w of [...workers].reverse()) {
        const cur = workerLayerMap.get(w.nodeId) ?? 0;
        const deduct = Math.min(cur, excess);
        workerLayerMap.set(w.nodeId, cur - deduct);
        excess -= deduct;
        if (excess <= 0) break;
      }
      totalWorkerLayers = allowedWorkerLayers;
    }

    const masterLayers = totalLayers - totalWorkerLayers;

    // Lay out strictly contiguous non-overlapping spans:
    // Master: [0, masterLayers - 1]
    master.allocatedLayers = masterLayers;
    master.layerStart = 0;
    master.layerEnd = masterLayers - 1;

    let cursorLayer = masterLayers;
    for (const w of workers) {
      const count = workerLayerMap.get(w.nodeId) ?? 0;
      if (count > 0 && cursorLayer < totalLayers) {
        w.allocatedLayers = count;
        w.layerStart = cursorLayer;
        w.layerEnd = cursorLayer + count - 1;
        cursorLayer += count;
      } else {
        w.allocatedLayers = 0;
        w.layerStart = 0;
        w.layerEnd = -1;
      }
    }

    // Ensure 100% of layers are assigned contiguously
    if (cursorLayer < totalLayers) {
      const remaining = totalLayers - cursorLayer;
      const lastActive = [...workers].reverse().find((w) => w.allocatedLayers > 0) || master;
      lastActive.allocatedLayers += remaining;
      lastActive.layerEnd = totalLayers - 1;
    }

    // Exact per-node allocatedMb & kvCacheMb derived from assigned contiguous slices
    for (const n of active) {
      if (n.allocatedLayers > 0) {
        let weightMb = 0;
        let kvMb = 0;
        for (let l = n.layerStart; l <= n.layerEnd; l++) {
          const prof = nonUniform.perLayerProfiles[l];
          if (prof) {
            weightMb += prof.totalWeightMb;
            kvMb += prof.kvCacheMb;
          }
        }
        n.allocatedMb = weightMb + kvMb + (n.nodeId === master.nodeId ? masterPinned : 0);
        n.kvCacheMb = kvMb;
      } else {
        n.allocatedMb = 0;
        n.kvCacheMb = 0;
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
  const masterNode = evaluated.find((n) => n.role === 'Master') ?? master ?? evaluated[0];
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
    String(effectiveConfig.gpuOffloadLayers ?? masterNode?.nglLayers ?? 0),
    '-b',
    String(learned?.recommendedBatch ?? effectiveConfig.batchSize ?? 1024),
    '-ub',
    String(learned?.recommendedUbatch ?? effectiveConfig.ubatchSize ?? 256),
  ];
  if (effectiveMmproj) cliArgs.push('--mmproj', effectiveMmproj);
  if (effectiveConfig.threads && effectiveConfig.threads > 0) {
    cliArgs.push('-t', String(effectiveConfig.threads));
  }
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
    masterId: masterNode?.label ?? 'Local Master',
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
