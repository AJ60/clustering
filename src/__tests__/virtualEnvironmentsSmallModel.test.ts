import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../../server.ts';
import { GGUF_MODEL_PRESETS } from '../types/starCluster.ts';
import {
  buildStarClusterNodes,
  planStarCluster,
} from '../domain/starClusterPlanner.ts';
import {
  buildTunedOsBackendProfile,
  createDefaultBackendTuningConfig,
} from '../domain/backendTuner.ts';
import { createInitialTelemetryState } from '../service/nodeClusterService.ts';

describe('Small Model Multi-Virtual-Environment Verification', () => {
  const smallModel = GGUF_MODEL_PRESETS.find((m) => m.id === 'small-1.5b')!;
  const tuningConfig = createDefaultBackendTuningConfig(smallModel);
  const baseTelemetry = createInitialTelemetryState(false);

  let server: Server;
  let baseUrl: string;

  before(async () => {
    process.env.NODE_ENV = 'test';
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ===========================================================================
  // Virtual Environment 1: 4-Node Heterogeneous Mixed-OS Cluster
  // ===========================================================================
  describe('Virtual Environment 1: 4-Node Mixed-OS Cluster (Win + Linux + Android + Edge-ARM)', () => {
    it('partitions small model layers seamlessly across all 4 healthy nodes', () => {
      const nodes = buildStarClusterNodes(baseTelemetry, 'VIRTUAL_4NODE', 0, tuningConfig);
      assert.equal(nodes.length, 4, 'Must instantiate 4 virtual nodes');

      const plan = planStarCluster(nodes, smallModel, undefined, tuningConfig);

      assert.equal(plan.fitVerdict, 'Fast', '1.15 GB model must yield Fast verdict across 4 nodes');
      assert.ok(plan.totalSafePoolMb > smallModel.sizeMb * 3, 'Safe pool must exceed model requirement');
      assert.ok(plan.estimatedClusterTokPerSec > 20, 'Expected throughput should exceed 20 tok/s');

      const activeNodes = plan.nodes.filter((n) => n.allocatedLayers > 0);
      assert.ok(activeNodes.length >= 2, 'Layers must be distributed across nodes');

      // Verify layer coverage (0 to 27 = 28 layers)
      const totalAllocated = activeNodes.reduce((sum, n) => sum + n.allocatedLayers, 0);
      assert.equal(totalAllocated, smallModel.layers, 'Total allocated layers must equal 28');

      // Verify no gaps in layer ranges
      for (let i = 0; i < activeNodes.length - 1; i++) {
        assert.equal(
          activeNodes[i].layerEnd + 1,
          activeNodes[i + 1].layerStart,
          'Layer distribution must be contiguous'
        );
      }
    });

    it('generates Windows and Linux tuning profiles for small model execution', () => {
      const nodes = buildStarClusterNodes(baseTelemetry, 'VIRTUAL_4NODE', 0, tuningConfig);
      const plan = planStarCluster(nodes, smallModel, undefined, tuningConfig);

      const winProfile = buildTunedOsBackendProfile('windows', smallModel, plan, tuningConfig);
      assert.equal(winProfile.os, 'windows');
      assert.ok(winProfile.gpuOffloadLayers >= 0);
      assert.ok(winProfile.cliFlags.some((f) => f.toLowerCase().includes('qwen2.5-1.5b-instruct')));

      const linuxProfile = buildTunedOsBackendProfile('linux', smallModel, plan, tuningConfig);
      assert.equal(linuxProfile.os, 'linux');
      assert.ok(linuxProfile.launchCommand.includes('llama-server'));
    });
  });

  // ===========================================================================
  // Virtual Environment 2: Thermal Stress & Node Shedding Simulation
  // ===========================================================================
  describe('Virtual Environment 2: Thermal Throttling & Dynamic Layer Rescheduling', () => {
    it('reschedules layers when Android node warms and Pi enters critical state', () => {
      // Simulate +15C temperature offset to trigger thermal guards
      const warmNodes = buildStarClusterNodes(baseTelemetry, 'VIRTUAL_4NODE', 15, tuningConfig);
      
      const edgeArmNode = warmNodes.find((n) => n.nodeId === 'edge-arm')!;
      const windowsNode = warmNodes.find((n) => n.nodeId === 'windows-worker')!;
      
      // Check that +15C offset pushed Android Edge node past emergency ceiling (35.5 + 15 = 50.5C >= 48C)
      assert.ok(edgeArmNode.tempC >= 48.0, 'Edge ARM Android node must enter emergency thermal ceiling');
      assert.ok(windowsNode.tempC >= 70.0, 'Windows node must register elevated temperature');
      
      const stressedPlan = planStarCluster(warmNodes, smallModel, undefined, tuningConfig);

      // Verify that all 28 layers remain covered even during thermal stress
      const totalLayers = stressedPlan.nodes.reduce((sum, n) => sum + n.allocatedLayers, 0);
      assert.equal(totalLayers, smallModel.layers, 'All 28 layers must still be allocated');

      // Edge ARM node in emergency offload must receive 0 layers
      const stressedEdge = stressedPlan.nodes.find((n) => n.nodeId === 'edge-arm')!;
      assert.equal(stressedEdge.allocatedLayers, 0, 'Thermal-critical node must be shed to 0 layers');

      // Master must absorb the remaining layer load
      const masterNode = stressedPlan.nodes.find((n) => n.role === 'Master')!;
      assert.ok(masterNode.allocatedLayers >= 10, 'Master must absorb layer load from degraded workers');
    });
  });

  // ===========================================================================
  // Virtual Environment 3: Single Local Device Node (Pure Standalone)
  // ===========================================================================
  describe('Virtual Environment 3: Single Local Device Standalone', () => {
    it('allocates 100% of small model layers to the local host with zero RPC overhead', () => {
      const localNodes = buildStarClusterNodes(baseTelemetry, 'LOCAL_DEVICE', 0, tuningConfig);
      assert.equal(localNodes.length, 1, 'Local device mode must have exactly 1 node');

      const plan = planStarCluster(localNodes, smallModel, undefined, tuningConfig);
      assert.equal(plan.nodes[0].allocatedLayers, smallModel.layers, 'Local node must hold all 28 layers');
      assert.equal(plan.nodes[0].layerStart, 0);
      assert.equal(plan.nodes[0].layerEnd, smallModel.layers - 1);
      assert.equal(plan.fitVerdict, 'Fast');
    });
  });

  // ===========================================================================
  // API Wire Verification for the Small Model
  // ===========================================================================
  describe('OpenAI API Wire Verification on Small Model', () => {
    it('POST /api/cluster/state activates small-1.5b preset', async () => {
      const nodes = buildStarClusterNodes(baseTelemetry, 'VIRTUAL_4NODE', 0, tuningConfig);
      const plan = planStarCluster(nodes, smallModel, undefined, tuningConfig);

      const stateRes = await fetch(`${baseUrl}/api/cluster/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeModel: smallModel,
          clusterMode: 'VIRTUAL_4NODE',
          tuningConfig,
          plan,
        }),
      });

      assert.equal(stateRes.status, 200);
      const stateJson = (await stateRes.json()) as { ok: boolean };
      assert.equal(stateJson.ok, true);
    });

    it('GET /health reflects small-1.5b active model', async () => {
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = (await healthRes.json()) as { activeModel: string };
      assert.equal(health.activeModel, smallModel.name);
    });

    it('POST /v1/chat/completions executes prompt with small model active param trace', async () => {
      const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'small-1.5b',
          messages: [{ role: 'user', content: 'Explain cluster layer distribution on small models.' }],
          stream: false,
        }),
      });

      assert.equal(chatRes.status, 200);
      const chatJson = (await chatRes.json()) as {
        id: string;
        choices: Array<{ message: { content: string } }>;
        x_cluster_trace: {
          active_params_per_token_b: number;
          total_params_b: number;
          nodes: Array<{ node_id: string; layers: string; active_params_b: number }>;
        };
      };

      assert.ok(chatJson.choices[0].message.content.length > 0);
      assert.equal(chatJson.x_cluster_trace.active_params_per_token_b, 1.54);
      assert.equal(chatJson.x_cluster_trace.total_params_b, 1.54);
      assert.ok(chatJson.x_cluster_trace.nodes.length >= 1);
    });

    it('POST /v1/chat/completions handles streaming SSE chunks for small-1.5b', async () => {
      const streamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'small-1.5b',
          messages: [{ role: 'user', content: 'Run token stream test.' }],
          stream: true,
        }),
      });

      assert.equal(streamRes.status, 200);
      assert.ok(streamRes.headers.get('content-type')?.includes('text/event-stream'));

      const text = await streamRes.text();
      assert.ok(text.includes('chat.completion.chunk'));
      assert.ok(text.includes('[DONE]'));
    });
  });
});
