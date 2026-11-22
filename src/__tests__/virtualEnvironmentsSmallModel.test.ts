import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GGUF_MODEL_PRESETS, StarClusterNode } from '../types/starCluster.ts';
import {
  buildStarClusterNodes,
  computeAndroidSafeCap,
  planStarCluster,
} from '../domain/starClusterPlanner.ts';
import {
  buildTunedOsBackendProfile,
  createDefaultBackendTuningConfig,
  validateStockLlamaFlags,
} from '../domain/backendTuner.ts';
import { createInitialTelemetryState } from '../service/nodeClusterService.ts';

describe('Data-Driven Auto-Planner Hard Mathematical Invariants', () => {
  const smallModel = GGUF_MODEL_PRESETS.find((m) => m.id === 'small-1.5b')!;
  const moeModel = GGUF_MODEL_PRESETS.find((m) => m.id === 'moe-30b')!;
  const baseTelemetry = createInitialTelemetryState(false);

  const master4Gb: StarClusterNode = {
    nodeId: 'master-win',
    label: 'Windows Master (4GB VRAM)',
    role: 'Master',
    platform: 'Desktop',
    osType: 'windows',
    ip: '127.0.0.1',
    rpcPort: 50052,
    backendDriver: 'CUDA 12.6',
    linkType: 'Local',
    totalRamMb: 16384,
    availableRamMb: 12288,
    vramFreeMb: 3900,
    vramTotalMb: 4096,
    memBwGbps: 224,
    computeTflops: 12,
    physicalCores: 8,
    rttMs: 0.2,
    pktLossPct: 0,
    tempC: 54,
    handshakeVerified: true,
    isConnected: true,
  };

  const androidUsb: StarClusterNode = {
    nodeId: 'android-usb',
    label: 'Android USB Worker',
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
    memBwGbps: 34,
    computeTflops: 2.1,
    physicalCores: 4,
    rttMs: 1.1,
    pktLossPct: 0,
    tempC: 35,
    handshakeVerified: true,
    isConnected: true,
  };

  it('enforces Zero-OOM, strict <=50% Android physical RAM cap, and --tensor-split summing to 100.0', () => {
    const cfg = {
      ...createDefaultBackendTuningConfig(moeModel),
      contextLength: 65536 as const,
    };
    const plan = planStarCluster([master4Gb, androidUsb], moeModel, undefined, cfg);

    // 1. Zero-OOM on every node
    for (const node of plan.nodes) {
      assert.ok(
        node.allocatedMb <= node.safeRamMb + node.safeVramMb,
        `Node ${node.nodeId} exceeded safe cap: ${node.allocatedMb} > ${node.safeRamMb + node.safeVramMb}`
      );
    }

    // 2. Strict 50% Android RAM cap (8192 * 0.5 = 4096 MB max)
    assert.ok(computeAndroidSafeCap(8192, 7500) <= 4096);
    const phone = plan.nodes.find((n) => n.nodeId === 'android-usb')!;
    assert.ok(phone.safeRamMb <= 4096);

    // 3. Normalized --tensor-split sums cleanly to 100.0
    const splitSum = plan.tensorSplit.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(splitSum - 100.0) < 0.05, `Expected tensor-split sum 100.0, got ${splitSum}`);

    // 4. Auto -nkvo triggers on 4 GB GPU at 65K context
    assert.equal(plan.autoNkvo, true);
    assert.ok(plan.cliArgs.includes('-nkvo'));
    assert.ok(plan.cliArgs.includes('--kv-unified'));
    assert.ok(plan.cliArgs.includes('--jinja'));
    assert.equal(validateStockLlamaFlags(plan.cliArgs).ok, true);
  });

  it('auto-prunes slow/lossy Wi-Fi and Edge ARM nodes when Master + USB already fit the model', () => {
    const slowWifi: StarClusterNode = {
      ...androidUsb,
      nodeId: 'slow-wifi-phone',
      label: 'Slow Wi-Fi Worker',
      linkType: 'Wi-Fi LAN',
      rttMs: 65,
      pktLossPct: 2.8,
    };
    const piNode: StarClusterNode = {
      ...androidUsb,
      nodeId: 'rpi-edge',
      label: 'Raspberry Pi 4',
      platform: 'Edge ARM',
      osType: 'edge-arm',
      linkType: 'Wi-Fi LAN',
      rttMs: 18,
      pktLossPct: 0.2,
    };

    const plan = planStarCluster([master4Gb, slowWifi, piNode], smallModel);
    assert.equal(plan.nodes.find((n) => n.nodeId === 'slow-wifi-phone')?.pruned, true);
    assert.equal(plan.nodes.find((n) => n.nodeId === 'rpi-edge')?.pruned, true);
    assert.equal(plan.useNoMmap, true, 'Pool >= 1.15x model need must enable --no-mmap');
    assert.ok(plan.cliArgs.includes('--no-mmap'));
  });

  it('sheds overheated Android workers to 0 layers and keeps mmap streaming when pool < 1.15x', () => {
    const hotPhone: StarClusterNode = {
      ...androidUsb,
      nodeId: 'hot-phone',
      tempC: 49.5,
    };
    const tightMaster: StarClusterNode = {
      ...master4Gb,
      availableRamMb: 14000,
    };
    const plan = planStarCluster([tightMaster, hotPhone], moeModel);
    const phone = plan.nodes.find((n) => n.nodeId === 'hot-phone')!;
    assert.equal(phone.allocatedLayers, 0);
    assert.equal(phone.thermalStatus.state, 'EMERGENCY_OFFLOAD');
    assert.equal(plan.useNoMmap, false);
    assert.equal(plan.mmapStreaming, true);
    assert.ok(!plan.cliArgs.includes('--no-mmap'));
  });

  it('NEVER displays offline or unverified workers in LIVE_CLUSTER mode', () => {
    const liveNodes = buildStarClusterNodes(baseTelemetry, 'LIVE_CLUSTER', 0, undefined, {
      platform: 'linux',
      osLabel: 'Linux',
      totalRamMb: 16384,
      availableRamMb: 12000,
      vramMb: 4096,
      cpuModel: 'Test CPU',
      cores: 8,
      connectedDevices: [
        {
          id: 'offline-ghost',
          model: 'Unverified Phone',
          platform: 'Android',
          transport: 'Wi-Fi LAN',
          safeCapMb: 2048,
          isOnline: false,
          isWorkerRunning: false,
          handshakeVerified: false,
        },
      ],
    });
    assert.equal(liveNodes.length, 1, 'Offline/unverified devices must be strictly excluded');
    assert.equal(liveNodes[0].role, 'Master');

    const profile = buildTunedOsBackendProfile(
      'linux',
      smallModel,
      planStarCluster(liveNodes, smallModel),
      createDefaultBackendTuningConfig(smallModel)
    );
    assert.ok(profile.scriptContent.includes('Silica Cluster Linux Tuned Backend'));
  });
});
