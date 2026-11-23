import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server.ts';
import { computeClusterAuthToken, verifyClusterAuthToken } from '../domain/clusterAuth.ts';
import { validatePublicHttpUrl } from '../domain/ssrfGuard.ts';
import { splitReasoningContent } from '../domain/reasoningParser.ts';
import { createEmptyHistoryDocument, recordEmaObservation } from '../domain/emaHistory.ts';
import { parseGgufBinaryHeader } from '../data/localModelsScanner.ts';
import { validateStockLlamaFlags } from '../domain/backendTuner.ts';

function buildSyntheticGgufHeader(opts: {
  arch: string;
  name: string;
  blocks: number;
  experts?: number;
  tokens: string[];
}): Buffer {
  const parts: Buffer[] = [];
  const pushU32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    parts.push(b);
  };
  const pushU64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    parts.push(b);
  };
  const pushStr = (s: string) => {
    const sb = Buffer.from(s, 'utf8');
    pushU64(sb.length);
    parts.push(sb);
  };

  parts.push(Buffer.from('GGUF', 'ascii'));
  pushU32(3); // GGUF v3
  pushU64(0); // tensor_count
  const kvCount = opts.experts ? 7 : 6;
  pushU64(kvCount);

  pushStr('general.architecture');
  pushU32(8);
  pushStr(opts.arch);

  pushStr('general.name');
  pushU32(8);
  pushStr(opts.name);

  pushStr(`${opts.arch}.block_count`);
  pushU32(4);
  pushU32(opts.blocks);

  pushStr(`${opts.arch}.context_length`);
  pushU32(4);
  pushU32(65536);

  pushStr('tokenizer.chat_template');
  pushU32(8);
  pushStr('{% for m in messages %}{{ m.content }}{% endfor %}');

  pushStr('tokenizer.ggml.tokens');
  pushU32(9); // array
  pushU32(8); // string
  pushU64(opts.tokens.length);
  for (const t of opts.tokens) pushStr(t);

  if (opts.experts) {
    pushStr(`${opts.arch}.expert_count`);
    pushU32(4);
    pushU32(opts.experts);
  }

  return Buffer.concat(parts);
}

describe('Silica Cluster Server & Systems Verification', () => {
  let server: Server;
  let baseUrl: string;
  let mockUpstream: Server;
  let mockUpstreamUrl: string;
  let lastUpstreamBody: Record<string, unknown> | null = null;

  before(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.UPSTREAM_LLAMA_URL;

    // Spin up a local OpenAI-compatible upstream mock to verify real streaming passthrough
    mockUpstream = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-vl-30b' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (lastUpstreamBody?.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(
              `data: ${JSON.stringify({
                id: 'chatcmpl-live',
                object: 'chat.completion.chunk',
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning_content: 'Checking tool definitions...',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'fetch_url', arguments: '{"url":"https://example.com"}' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              })}\n\n`
            );
            res.write(
              `data: ${JSON.stringify({
                id: 'chatcmpl-live',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'tool_calls' }],
              })}\n\n`
            );
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-live',
                object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Live upstream OK' }, finish_reason: 'stop' }],
              })
            );
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, '127.0.0.1', () => {
        const addr = mockUpstream.address();
        if (addr && typeof addr === 'object') {
          mockUpstreamUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
  });

  it('GET /health and /api/cluster/beacon report Silica Cluster branding', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'Silica Cluster');

    const beaconRes = await fetch(`${baseUrl}/api/cluster/beacon`);
    assert.equal(beaconRes.status, 200);
    const beacon = (await beaconRes.json()) as { service: string; protocolVersion: number };
    assert.equal(beacon.service, 'Silica-Cluster-Master');
    assert.equal(beacon.protocolVersion, 9);
  });

  it('POST /v1/chat/completions honestly returns HTTP 503 when no live engine is loaded', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'small-1.5b',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'ENGINE_OFFLINE');
  });

  it('POST /api/upstream/test connects real upstream and forwards image_url, tools, and reasoning_content SSE', async () => {
    const testRes = await fetch(`${baseUrl}/api/upstream/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: mockUpstreamUrl, apply: true }),
    });
    assert.equal(testRes.status, 200);
    const testJson = (await testRes.json()) as { ok: boolean; models: string[] };
    assert.equal(testJson.ok, true);
    assert.deepEqual(testJson.models, ['qwen3-vl-30b']);

    const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-vl-30b',
        stream: true,
        tools: [{ type: 'function', function: { name: 'fetch_url', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this screenshot' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
    });

    assert.equal(chatRes.status, 200);
    const sseText = await chatRes.text();
    assert.ok(sseText.includes('reasoning_content'));
    assert.ok(sseText.includes('tool_calls'));
    assert.ok(sseText.includes('fetch_url'));
    assert.ok(sseText.includes('[DONE]'));
    assert.ok(Array.isArray(lastUpstreamBody?.tools));
    const forwardedMsgs = lastUpstreamBody?.messages as Array<{ content: unknown }>;
    assert.ok(Array.isArray(forwardedMsgs[0].content));

    // Disconnect upstream again for cleanliness
    await fetch(`${baseUrl}/api/cluster/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstreamBaseUrl: '' }),
    });
  });

  it('inspects binary GGUF header, auto-pairs companion mmproj, and validates stock llama.cpp flags', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silica-gguf-'));
    try {
      const modelPath = path.join(tmpDir, 'qwen3-vl-30b-q4_k_m.gguf');
      const mmprojPath = path.join(tmpDir, 'qwen3-mmproj-f16.gguf');
      const hdr = buildSyntheticGgufHeader({
        arch: 'qwen3moe',
        name: 'Qwen3-VL-30B-A3B',
        blocks: 48,
        experts: 128,
        tokens: ['<bos>', 'hello', 'world'],
      });
      fs.writeFileSync(modelPath, hdr);
      fs.writeFileSync(mmprojPath, Buffer.alloc(1024 * 1024));

      const parsedDirect = parseGgufBinaryHeader(new Uint8Array(hdr));
      assert.equal(parsedDirect?.architecture, 'qwen3moe');
      assert.equal(parsedDirect?.layers, 48);
      assert.equal(parsedDirect?.expertCount, 128);
      assert.equal(parsedDirect?.hasChatTemplate, true);
      assert.ok(parsedDirect?.vocabHash);

      const res = await fetch(`${baseUrl}/api/models/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: modelPath }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        model: { architecture: string; layers: number; mmprojPath: string | null; vocabHash: string };
      };
      assert.equal(body.ok, true);
      assert.equal(body.model.architecture, 'MoE');
      assert.equal(body.model.layers, 48);
      assert.ok(body.model.mmprojPath?.includes('mmproj'));

      const reloadRes = await fetch(`${baseUrl}/api/engine/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: body.model }),
      });
      assert.equal(reloadRes.status, 200);
      const reloadBody = (await reloadRes.json()) as { ok: boolean; cliArgs: string[] };
      assert.equal(reloadBody.ok, true);
      assert.ok(reloadBody.cliArgs.includes('--mmproj'));
      assert.ok(reloadBody.cliArgs.includes('--jinja'));
      assert.ok(reloadBody.cliArgs.includes('--kv-unified'));
      assert.equal(validateStockLlamaFlags(reloadBody.cliArgs).ok, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('registers, deduplicates, and immediately unregisters workers without ghost nodes', async () => {
    // Register phone via App ID & loopback
    const reg = await fetch(`${baseUrl}/api/cluster/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'android-xiaomi-redmi-note-7-pro',
        label: 'Xiaomi Redmi Note 7 Pro (Android)',
        platform: 'Android',
        ip: '127.0.0.1',
        totalRamMb: 4096,
        availableRamMb: 2048,
      }),
    });
    assert.equal(reg.status, 200);
    const regBody = (await reg.json()) as { ok: boolean; registered: string };
    assert.equal(regBody.ok, true);

    // Register same phone via daemon alias (different ID & loopback alias 127.0.10.3)
    const regAlias = await fetch(`${baseUrl}/api/cluster/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'redmi-note-7-pro',
        label: 'Redmi Note 7 Pro',
        platform: 'Android',
        ip: '127.0.10.3',
        totalRamMb: 4096,
        availableRamMb: 2048,
        allowHttpRegistration: true,
      }),
    });
    assert.equal(regAlias.status, 200);

    // Hardware probe must strictly deduplicate to a single Android worker
    const hwRes = await fetch(`${baseUrl}/api/cluster/hardware`);
    assert.equal(hwRes.status, 200);
    const hwData = (await hwRes.json()) as { connectedDevices: Array<{ id: string; platform: string }> };
    const androidWorkers = hwData.connectedDevices.filter((d) => d.platform === 'Android');
    assert.equal(androidWorkers.length, 1, 'Duplicate registrations for same phone must strictly deduplicate to 1 node');

    const unreg = await fetch(`${baseUrl}/api/cluster/nodes/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'redmi-note-7-pro' }),
    });
    assert.equal(unreg.status, 200);
    const unregBody = (await unreg.json()) as { ok: boolean; removed: boolean };
    assert.equal(unregBody.removed, true);
  });

  it('enforces SSRF protection on /api/tools/fetch-url, 32-byte RPC auth, reasoning parser, and EMA learning', async () => {
    const blockedRes = await fetch(`${baseUrl}/api/tools/fetch-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert.equal(blockedRes.status, 400);
    assert.equal(validatePublicHttpUrl('http://127.0.0.1:8080').ok, false);
    assert.equal(validatePublicHttpUrl('https://93.184.216.34/docs').ok, true);

    const token = computeClusterAuthToken('clusterd-default-hmac-key');
    assert.equal(token.length, 32);
    assert.equal(verifyClusterAuthToken('clusterd-default-hmac-key', token), true);
    assert.equal(verifyClusterAuthToken('wrong', token), false);

    const split = splitReasoningContent('<think>step 1\nstep 2</think>\nFinal answer here.');
    assert.equal(split.reasoning, 'step 1\nstep 2');
    assert.equal(split.answer, 'Final answer here.');
    assert.equal(split.isThinkingOpen, false);

    const hist = createEmptyHistoryDocument();
    recordEmaObservation(hist, {
      profileKey: 'MoE:2nodes',
      observedTokPerSec: 20,
      observedTtftMs: 400,
      peakVramMb: 3600,
      batchSize: 1024,
      ubatchSize: 256,
      usedNkvo: false,
      throttled: false,
      oomOrFail: false,
    });
    const updated = recordEmaObservation(hist, {
      profileKey: 'MoE:2nodes',
      observedTokPerSec: 30,
      observedTtftMs: 300,
      peakVramMb: 4000,
      batchSize: 1024,
      ubatchSize: 256,
      usedNkvo: false,
      throttled: false,
      oomOrFail: true,
    });
    assert.equal(updated.emaTokPerSec, 23);
    assert.equal(updated.learnedKvOffload, true);
    assert.equal(updated.recommendedBatch, 512);
  });

  it('deduplicates same physical Android phone across USB (127.0.0.1) and secondary IP (127.0.10.3)', async () => {
    const reg1 = await fetch(`${baseUrl}/api/cluster/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'android-xiaomi-redmi-note-7-pro',
        label: 'Xiaomi Redmi Note 7 Pro (Android)',
        platform: 'Android',
        ip: '127.0.0.1',
        rpcPort: 50052,
        linkType: 'USB-C Tunnel',
        totalRamMb: 4096,
        availableRamMb: 1900,
        nativeRpcReady: true,
      }),
    });
    assert.equal(reg1.status, 200);

    const reg2 = await fetch(`${baseUrl}/api/cluster/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'android-redmi-note-7-pro-lan',
        label: 'Redmi Note 7 Pro',
        platform: 'Android',
        ip: '127.0.10.3',
        rpcPort: 50052,
        linkType: 'Wi-Fi LAN',
        totalRamMb: 4096,
        availableRamMb: 1900,
        nativeRpcReady: true,
      }),
    });
    assert.equal(reg2.status, 200);
    const body2 = (await reg2.json()) as {
      ok: boolean;
      deduplicated?: boolean;
      snapshot: {
        plan: {
          nodes: Array<{ role: string; ip: string; nodeId: string }>;
          cliArgs: string[];
        };
      };
    };
    assert.equal(body2.deduplicated, true);
    const workers = body2.snapshot.plan.nodes.filter((n) => n.role === 'Worker');
    assert.equal(workers.length, 1, 'Same phone must be deduplicated to exactly 1 worker');
    assert.equal(workers[0].ip, '127.0.0.1', 'Must prefer USB-C Tunnel loopback IP');

    await fetch(`${baseUrl}/api/cluster/nodes/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'android-xiaomi-redmi-note-7-pro' }),
    });
  });

  it('auto-creates --slot-save-path, passes --rpc & --tensor-split to real llama-server, and reports real stderr on RPC crash', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silica-spawn-'));
    try {
      const modelPath = path.join(tmpDir, 'test-local-7b-q4_k_m.gguf');
      const slotDir = path.join(tmpDir, 'nested', 'kv-cache-dir');
      const argsLog = path.join(tmpDir, 'spawned-args.json');
      const hdr = buildSyntheticGgufHeader({
        arch: 'qwen2',
        name: 'Test-Local-7B',
        blocks: 32,
        tokens: ['<bos>', 'hi'],
      });
      fs.writeFileSync(modelPath, hdr);

      // Register a native RPC worker so --rpc and --tensor-split are emitted
      await fetch(`${baseUrl}/api/cluster/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'linux-rpc-worker',
          label: 'Linux RPC Worker',
          platform: 'Linux',
          ip: '127.0.0.1',
          rpcPort: 50052,
          linkType: 'USB-C Tunnel',
          totalRamMb: 8192,
          availableRamMb: 6000,
          nativeRpcReady: true,
        }),
      });

      const inspectRes = await fetch(`${baseUrl}/api/models/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: modelPath }),
      });
      const { model } = (await inspectRes.json()) as { model: Record<string, unknown> };

      // 1. Missing binary must honestly fail with HTTP 400 (never silently claim ok: true)
      const missingBinRes = await fetch(`${baseUrl}/api/engine/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          spawnLocalBinary: true,
          binaryPath: path.join(tmpDir, 'does-not-exist-llama-server'),
        }),
      });
      assert.equal(missingBinRes.status, 400);
      const missingJson = (await missingBinRes.json()) as { ok: boolean; error: string };
      assert.equal(missingJson.ok, false);
      assert.ok(missingJson.error.includes('not found'));

      // 2. Failing llama-server (e.g. RPC rejected) must return HTTP 500 with stderr + RPC hint
      const failBin = path.join(tmpDir, 'mock-llama-fail.mjs');
      fs.writeFileSync(
        failBin,
        `console.error("ggml_backend_rpc: connection refused on 127.0.0.1:50052");\nprocess.exit(1);\n`,
        { mode: 0o755 }
      );
      const failRes = await fetch(`${baseUrl}/api/engine/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          tuningConfig: { slotSavePath: slotDir },
          spawnLocalBinary: true,
          binaryPath: failBin,
        }),
      });
      assert.equal(failRes.status, 500);
      const failJson = (await failRes.json()) as {
        ok: boolean;
        spawned: boolean;
        error: string;
        snapshot: { engineStatus: { running: boolean } };
      };
      assert.equal(failJson.ok, false);
      assert.equal(failJson.spawned, false);
      assert.equal(failJson.snapshot.engineStatus.running, false);
      assert.ok(failJson.error.includes('ggml_backend_rpc'));
      assert.ok(failJson.error.includes('rpc-server -c'));
      // Verify --slot-save-path directory was automatically created before spawning
      assert.equal(fs.existsSync(slotDir), true);

      // 3. Healthy mock llama-server script responds 200 on /health and records its CLI args
      const okBin = path.join(tmpDir, 'mock-llama-ok.mjs');
      fs.writeFileSync(
        okBin,
        `#!${process.execPath}\n` +
          `import http from 'node:http';\n` +
          `import fs from 'node:fs';\n` +
          `const args = process.argv.slice(2);\n` +
          `fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));\n` +
          `const pIdx = args.indexOf('--port');\n` +
          `const port = pIdx !== -1 ? Number(args[pIdx + 1]) : 8080;\n` +
          `const srv = http.createServer((req, res) => {\n` +
          `  if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return; }\n` +
          `  res.writeHead(404); res.end();\n` +
          `});\n` +
          `srv.listen(port, '127.0.0.1');\n` +
          `process.on('SIGTERM', () => { srv.close(() => process.exit(0)); });\n`,
        { mode: 0o755 }
      );

      const okRes = await fetch(`${baseUrl}/api/engine/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          tuningConfig: { slotSavePath: slotDir },
          spawnLocalBinary: true,
          binaryPath: okBin,
        }),
      });
      assert.equal(okRes.status, 200);
      const okJson = (await okRes.json()) as {
        ok: boolean;
        spawned: boolean;
        message: string;
        snapshot: { engineStatus: { running: boolean } };
      };
      assert.equal(okJson.ok, true);
      assert.equal(okJson.spawned, true);
      assert.equal(okJson.snapshot.engineStatus.running, true);
      assert.ok(okJson.message.includes('127.0.0.1:50052'));

      const recordedArgs = JSON.parse(fs.readFileSync(argsLog, 'utf8')) as string[];
      assert.ok(recordedArgs.includes('--rpc'));
      assert.ok(recordedArgs.includes('127.0.0.1:50052'));
      assert.ok(recordedArgs.includes('--tensor-split'));

      // Cleanly terminate spawned child and unregister test worker
      await fetch(`${baseUrl}/api/engine/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spawnLocalBinary: false }),
      });
      await fetch(`${baseUrl}/api/cluster/nodes/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'linux-rpc-worker' }),
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
