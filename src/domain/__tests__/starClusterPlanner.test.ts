import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAndroidSafeCap,
  computeDesktopSafeCap,
  computeVramSafeCap,
  evaluateNodeThermal,
  planStarCluster,
  scoreClusterNode,
  buildStarClusterNodes,
} from '../starClusterPlanner.ts';
import { GGUF_MODEL_PRESETS, StarClusterNode, GgufModelPreset, BackendTuningConfig } from '../../types/starCluster.ts';
import { createDefaultBackendTuningConfig } from '../backendTuner.ts';
import { createInitialTelemetryState } from '../../service/nodeClusterService.ts';

describe('starClusterPlanner', () => {
  const model = GGUF_MODEL_PRESETS[0]; // Qwen3-30B-A3B MoE
  const config = createDefaultBackendTuningConfig(model);

  it('bounds Android RAM allocation safely to prevent LMK kills', () => {
    // 8 GB Android phone with 4 GB available
    const safeCap = computeAndroidSafeCap(8192, 4096, 50, 512);
    assert.ok(safeCap <= 8192 * 0.5, 'Must not exceed 50% total RAM');
    assert.ok(safeCap <= 4096 - 512, 'Must reserve at least 512 MB available headroom');
    assert.ok(safeCap >= 256, 'Must respect minimum floor');
  });

  it('enforces Desktop RAM and VRAM safety reserves', () => {
    const desktopCap = computeDesktopSafeCap(16384, 1024);
    assert.equal(desktopCap, 15360);

    // Windows VRAM reserves max(512 MB, 12%) for WDDM compositor safety
    const vram8Gb = computeVramSafeCap(8192, true);
    assert.ok(vram8Gb <= 8192 - 512);

    // Linux/Vulkan VRAM reserves max(256 MB, 8%)
    const vram16Gb = computeVramSafeCap(16384, false);
    assert.equal(vram16Gb, 16384 - Math.floor(16384 * 0.08));
  });

  it('calculates comparative node throughput scores', () => {
    const telemetry = createInitialTelemetryState(false);
    const nodes = buildStarClusterNodes(telemetry, 'VIRTUAL_4NODE', 0, config);
    const master = nodes.find((n) => n.role === 'Master')!;
    const worker = nodes.find((n) => n.platform === 'Android')!;

    const masterScore = scoreClusterNode(master);
    const workerScore = scoreClusterNode(worker);

    assert.ok(masterScore > 0);
    assert.ok(workerScore > 0);
    assert.ok(masterScore > workerScore, 'Master desktop node should outscore phone node');
  });

  it('evaluates thermal states and triggers progressive load shedding', () => {
    const telemetry = createInitialTelemetryState(false);
    const nodes = buildStarClusterNodes(telemetry, 'VIRTUAL_4NODE', 0, config);
    const worker = nodes.find((n) => n.platform === 'Android')!;

    // Test cool state (< 42C)
    const coolStatus = evaluateNodeThermal({ ...worker, tempC: 38.0 });
    assert.equal(coolStatus.state, 'COOL');
    assert.equal(coolStatus.capacityScale, 1.0);

    // Test warn state (>= 42C, < 45C)
    const warnStatus = evaluateNodeThermal({ ...worker, tempC: 43.0 });
    assert.equal(warnStatus.state, 'WARN');
    assert.equal(warnStatus.capacityScale, 0.9);

    // Test shed state (>= 45C, < 48C)
    const shedStatus = evaluateNodeThermal({ ...worker, tempC: 46.0 });
    assert.equal(shedStatus.state, 'SHED_25');
    assert.equal(shedStatus.capacityScale, 0.75);

    // Test emergency offload state (>= 48C)
    const critStatus = evaluateNodeThermal({ ...worker, tempC: 49.0 });
    assert.equal(critStatus.state, 'EMERGENCY_OFFLOAD');
    assert.equal(critStatus.capacityScale, 0);
  });

  it('plans star cluster with contiguous layer spans and valid pool allocation', () => {
    const telemetry = createInitialTelemetryState(false);
    const nodes = buildStarClusterNodes(telemetry, 'VIRTUAL_4NODE', 0, config);
    const plan = planStarCluster(nodes, model, undefined, config);

    assert.ok(plan.totalSafePoolMb > 0, 'Safe pool must be non-zero');
    assert.ok(plan.neededMb > 0, 'Model memory needed must be non-zero');
    assert.ok(['Fast', 'Best Fit', 'Streaming', 'Too Large'].includes(plan.fitVerdict));

    const activeNodes = plan.nodes.filter((n) => n.allocatedLayers > 0);
    assert.ok(activeNodes.length >= 1, 'At least one node must receive layers');

    // Verify layer continuity across nodes
    let expectedNextLayer = 0;
    for (const node of activeNodes) {
      assert.equal(node.layerStart, expectedNextLayer);
      assert.ok(node.layerEnd >= node.layerStart);
      expectedNextLayer = node.layerEnd + 1;
    }
    assert.equal(expectedNextLayer, model.layers, 'All model layers must be covered');
  });

  it('safely balances GPU offload layers (-ngl) and device --tensor-split under manual split without VRAM overflow', () => {
    const master: StarClusterNode = {
      nodeId: 'master-pc',
      label: 'Windows Master RTX 3050',
      role: 'Master',
      platform: 'Desktop',
      osType: 'windows',
      ip: '127.0.0.1',
      rpcPort: 50052,
      backendDriver: 'NVIDIA RTX 3050 Laptop',
      linkType: 'Local',
      totalRamMb: 32768,
      availableRamMb: 24000,
      vramFreeMb: 4096,
      vramTotalMb: 4096,
      memBwGbps: 195.0,
      computeTflops: 9.0,
      physicalCores: 8,
      rttMs: 0.1,
      pktLossPct: 0,
      bandwidthMbps: 10000,
      tempC: 42,
      cpuUsagePct: 15,
      gpuUsagePct: 5,
      handshakeVerified: true,
      heartbeatAgeS: 0,
      isConnected: true,
    };

    const worker: StarClusterNode = {
      nodeId: 'android-worker',
      label: 'Galaxy Tab A9+',
      role: 'Worker',
      platform: 'Android',
      osType: 'android',
      ip: '192.168.1.8',
      rpcPort: 50055,
      backendDriver: 'ARM NEON / Vulkan',
      linkType: 'Wi-Fi LAN',
      totalRamMb: 8192,
      availableRamMb: 4000,
      vramFreeMb: 0,
      vramTotalMb: 0,
      memBwGbps: 28.0,
      computeTflops: 1.8,
      physicalCores: 4,
      rttMs: 45.0,
      pktLossPct: 0,
      bandwidthMbps: 220,
      tempC: 32,
      cpuUsagePct: 10,
      gpuUsagePct: 0,
      handshakeVerified: true,
      heartbeatAgeS: 0,
      isConnected: true,
    };

    const moe35b: GgufModelPreset = {
      id: 'moe-35b',
      name: 'Qwen 35B MoE',
      quant: 'IQ4_XS',
      architecture: 'MoE',
      sizeMb: 17281,
      layers: 41,
      totalParamsB: 35,
      activeParamsB: 5.2,
      contextLengthDefault: 4096,
      maxContextLength: 262144,
      hfRepo: 'local/moe-35b',
      hfUrl: 'file://model.gguf',
      summary: '35B MoE',
      tags: ['moe'],
    };

    const manualConfig: BackendTuningConfig = {
      ...config,
      manualTensorSplit: '85, 15',
      contextLength: 4096,
    };

    const plan = planStarCluster([master, worker], moe35b, undefined, manualConfig);

    // Master gets 35 layers (85%), Worker gets 6 layers (15%)
    const plannedMaster = plan.nodes.find((n) => n.role === 'Master')!;
    const plannedWorker = plan.nodes.find((n) => n.role === 'Worker')!;
    assert.equal(plannedMaster.allocatedLayers, 35);
    assert.equal(plannedWorker.allocatedLayers, 6);

    // Master dedicated VRAM only holds 8 layers safely (no 15GB Shared Memory spillover)
    assert.equal(plannedMaster.nglLayers, 8);

    // CLI -ngl must be 14 (8 Master GPU + 6 Worker RPC)
    const nglIdx = plan.cliArgs.indexOf('-ngl');
    assert.ok(nglIdx >= 0);
    assert.equal(plan.cliArgs[nglIdx + 1], '14');

    // CLI --tensor-split must follow llama.cpp backend order [RPC0, CUDA0] -> [Worker (6), Master GPU (8)] = 42.9,57.1
    const tsIdx = plan.cliArgs.indexOf('--tensor-split');
    assert.ok(tsIdx >= 0);
    assert.equal(plan.cliArgs[tsIdx + 1], '42.9,57.1');

    // User-facing tensorSplit array must reflect overall 85% / 15% allocation
    assert.deepEqual(plan.tensorSplit, [85.0, 15.0]);

    // autoNkvo must be enabled to prevent KV cache from overflowing 4GB VRAM
    assert.equal(plan.autoNkvo, true);
    assert.ok(plan.cliArgs.includes('-nkvo'));
  });
});
