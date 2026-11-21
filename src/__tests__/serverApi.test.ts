import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../../server.ts';

describe('serverApi Endpoints', () => {
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

  it('GET /health returns 200 OK and valid health telemetry', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string; activeModel: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'ClusterLab');
    assert.ok(typeof body.activeModel === 'string');
  });

  it('GET /v1/models returns OpenAI-compatible list of models with cluster metadata', async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; x_cluster?: { architecture: string; total_params_b: number } }>;
    };
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 1);
    const first = body.data[0];
    assert.ok(first.id);
    assert.ok(first.x_cluster);
    assert.ok(first.x_cluster.total_params_b > 0);
  });

  it('POST /v1/chat/completions returns OpenAI-compliant JSON with cluster trace', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'moe-30b',
        messages: [{ role: 'user', content: 'What is the cluster node status?' }],
        stream: false,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      choices: Array<{ message: { role: string; content: string } }>;
      x_cluster_trace: { active_params_per_token_b: number; total_params_b: number };
    };

    assert.equal(body.object, 'chat.completion');
    assert.ok(body.choices.length > 0);
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.ok(body.choices[0].message.content.length > 0);
    assert.ok(body.x_cluster_trace.active_params_per_token_b > 0);
  });

  it('GET /api/backends/script generates downloadable OS launch scripts', async () => {
    const winRes = await fetch(`${baseUrl}/api/backends/script?os=windows`);
    assert.equal(winRes.status, 200);
    const winScript = await winRes.text();
    assert.ok(winScript.includes('ClusterLab Windows Tuned Backend'));

    const linuxRes = await fetch(`${baseUrl}/api/backends/script?os=linux`);
    assert.equal(linuxRes.status, 200);
    const linuxScript = await linuxRes.text();
    assert.ok(linuxScript.includes('#!/usr/bin/env bash'));
  });

  it('GET /api/cluster/hardware probes real host specs and returns devices array', async () => {
    const res = await fetch(`${baseUrl}/api/cluster/hardware`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      platform: string;
      totalRamMb: number;
      availableRamMb: number;
      connectedDevices: Array<{ id: string; model: string }>;
    };
    assert.ok(typeof body.platform === 'string');
    assert.ok(body.totalRamMb > 0);
    assert.ok(Array.isArray(body.connectedDevices));
  });

  it('GET /api/local/models scans local directory and returns discovered GGUF files', async () => {
    const res = await fetch(`${baseUrl}/api/local/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      directory: string;
      count: number;
      models: Array<{ id: string; isLocal?: boolean }>;
    };
    assert.ok(typeof body.directory === 'string');
    assert.ok(typeof body.count === 'number');
    assert.ok(Array.isArray(body.models));
  });

  it('POST /api/local/models/add rejects missing or non-existent file path with 404', async () => {
    const resMissing = await fetch(`${baseUrl}/api/local/models/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resMissing.status, 400);

    const resNonExistent = await fetch(`${baseUrl}/api/local/models/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'C:\\non-existent-path\\fake.gguf' }),
    });
    assert.equal(resNonExistent.status, 404);
  });

  it('GET /api/cluster/network/audit returns comprehensive audit of host and worker nodes', async () => {
    const res = await fetch(`${baseUrl}/api/cluster/network/audit`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      hostIp: string;
      nodes: Array<{ nodeId: string; rttMs: number; bandwidthMbps: number }>;
      summary: { totalNodes: number; clusterRating: string };
    };
    assert.ok(typeof body.hostIp === 'string');
    assert.ok(Array.isArray(body.nodes));
    assert.ok(body.nodes.length >= 1);
    assert.ok(body.summary.totalNodes >= 1);
    assert.ok(body.summary.clusterRating.length > 0);
  });

  it('GET /api/cluster/beacon returns discovery beacon with master coordinates', async () => {
    const res = await fetch(`${baseUrl}/api/cluster/beacon`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      service: string;
      masterHost: string;
      port: number;
      activeModel: string;
    };
    assert.equal(body.service, 'ClusterLab-Master');
    assert.ok(body.port === 3000);
    assert.ok(typeof body.activeModel === 'string');
  });

  it('POST /api/cluster/nodes/register dynamically registers worker node and shards layers', async () => {
    const res = await fetch(`${baseUrl}/api/cluster/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-linux-worker',
        label: 'Ubuntu RTX 4090 Node',
        platform: 'Desktop',
        osType: 'linux',
        totalRamMb: 64000,
        availableRamMb: 48000,
        vramMb: 24000,
        computeTflops: 82.0,
        memBwGbps: 1008.0,
        linkType: 'Ethernet 2.5G',
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; registered: string; assignedLayers: number };
    assert.equal(body.ok, true);
    assert.equal(body.registered, 'test-linux-worker');
    assert.ok(body.assignedLayers > 0);
  });

  it('returns structured JSON 404 for unknown /api and /v1 routes', async () => {
    const resApi = await fetch(`${baseUrl}/api/non-existent-route`);
    assert.equal(resApi.status, 404);
    const bodyApi = await resApi.json();
    assert.equal(bodyApi.error, 'API endpoint not found');

    const resV1 = await fetch(`${baseUrl}/v1/non-existent-route`);
    assert.equal(resV1.status, 404);
    const bodyV1 = await resV1.json();
    assert.equal(bodyV1.error, 'API endpoint not found');
  });

  it('POST /v1/chat/completions dynamically switches model and includes exact model name in reply text and trace', async () => {
    // 1. Send request with Recursive Flint local model
    const resFlint = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local-flint-q4-k-m-gguf',
        messages: [{ role: 'user', content: 'write a 1000 word story about space' }],
      }),
    });
    assert.equal(resFlint.status, 200);
    const bodyFlint = (await resFlint.json()) as any;
    assert.equal(bodyFlint.model, 'local-flint-q4-k-m-gguf');
    const contentFlint = bodyFlint.choices[0].message.content;
    assert.ok(contentFlint.includes('Recursive Flint'), 'Response must cite Recursive Flint, not Qwen2.5');
    assert.ok(!contentFlint.includes('Qwen2.5-1.5B-Instruct'), 'Response must not contain stale Qwen2.5-1.5B');

    // 2. Send request with Qwen3.8-27B
    const resQwen3 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local-qwen3-8-27b-q4-0-gguf',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(resQwen3.status, 200);
    const bodyQwen3 = (await resQwen3.json()) as any;
    assert.equal(bodyQwen3.model, 'local-qwen3-8-27b-q4-0-gguf');
    const contentQwen3 = bodyQwen3.choices[0].message.content;
    assert.ok(contentQwen3.includes('Qwen3.8-27B'), 'Greeting must cite Qwen3.8-27B');
  });

  it('deduplicates Android mobile worker registrations to prevent ghost duplicate nodes', async () => {
    const regRes = await fetch(`${baseUrl}/api/cluster/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'android-redmi-worker',
        label: 'Xiaomi Redmi Note 7 Pro',
        platform: 'Android',
        addr: '127.0.0.1:50052',
        totalRamMb: 3700,
        availableRamMb: 1800,
      }),
    });
    assert.equal(regRes.status, 200);
    const body = (await regRes.json()) as any;
    assert.equal(body.ok, true);

    // Verify snapshot nodes count: at most 1 Android node should ever exist in active nodes
    const androidNodes = body.snapshot.plan.nodes.filter(
      (n: any) => n.platform === 'Android' || n.label.includes('Redmi') || n.label.includes('Android')
    );
    assert.ok(androidNodes.length <= 1, `Expected at most 1 Android node, got ${androidNodes.length}`);
  });
});
