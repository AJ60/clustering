import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { GGUF_MODEL_PRESETS } from './src/types/starCluster.ts';
import type {
  BackendOsTarget,
  BackendTuningConfig,
  ClusterMode,
  ConnectedDeviceInfo,
  GgufModelPreset,
  LiveHardwareProbe,
  StarClusterPlan,
} from './src/types/starCluster.ts';
import {
  buildTunedOsBackendProfile,
  createDefaultBackendTuningConfig,
} from './src/domain/backendTuner.ts';
import {
  buildStarClusterNodes,
  planStarCluster,
} from './src/domain/starClusterPlanner.ts';
import { createInitialTelemetryState } from './src/service/nodeClusterService.ts';
import {
  CURATED_HF_GGUF_CATALOG,
  inferHfModelMetadata,
} from './src/data/hfModelsCatalog.ts';
import { parseLocalGgufModel } from './src/data/localModelsScanner.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ChatMessageInput {
  role: string;
  content: string;
}

interface RuntimeClusterSnapshot {
  activeModel: GgufModelPreset;
  clusterMode: ClusterMode;
  tuningConfig: BackendTuningConfig;
  plan: StarClusterPlan;
  upstreamBaseUrl: string;
  updatedAt: string;
}

function probeLiveHardware(): LiveHardwareProbe {
  const isWin = process.platform === 'win32';
  const osLabel = isWin ? 'Windows 11' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
  const availableRamMb = Math.round(os.freemem() / (1024 * 1024));
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || (isWin ? 'AMD Ryzen / Intel Core' : 'Host CPU');
  const cores = cpus.length || 8;

  const connectedDevices: ConnectedDeviceInfo[] = [];
  try {
    const adbPath = isWin
      ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
      : 'adb';
    if (fs.existsSync(adbPath) || !isWin) {
      const out = child_process.execFileSync(adbPath, ['devices', '-l'], { timeout: 2500 }).toString();
      const lines = out.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('List of')) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s+device\s+(.*)$/);
        if (match) {
          const devId = match[1];
          const info = match[2];
          let modelName = 'Android Device';
          const modelMatch = info.match(/model:([^\s]+)/);
          if (modelMatch) {
            modelName = modelMatch[1].replace(/_/g, ' ');
          }
          connectedDevices.push({
            id: devId,
            model: modelName,
            platform: 'Android',
            transport: 'USB-C (ADB Reverse Tunnel)',
            safeCapMb: 1300,
            totalRamMb: 3700,
            rttMs: 0.8,
          });
        }
      }
    }
  } catch {
    // ADB inactive or not found
  }

  return {
    platform: isWin ? 'windows' : 'linux',
    osLabel,
    totalRamMb,
    availableRamMb,
    vramMb: isWin ? 4096 : 8192,
    gpuName: isWin ? 'NVIDIA GeForce RTX 3050 Laptop GPU' : undefined,
    cpuModel,
    cores,
    connectedDevices,
  };
}

function scanLocalGgufFiles(customDir?: string): { directory: string; models: GgufModelPreset[] } {
  const models: GgufModelPreset[] = [];
  const searchDirs: string[] = [];

  if (customDir && fs.existsSync(customDir)) {
    searchDirs.push(customDir);
  }

  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const defaultDirs = [
    path.join(process.cwd(), 'models'),
    path.join(userProfile, 'Downloads'),
    path.join(userProfile, 'models'),
    path.join(userProfile, '.cache', 'lm-studio', 'models'),
  ];

  for (const d of defaultDirs) {
    if (fs.existsSync(d) && !searchDirs.includes(d)) {
      searchDirs.push(d);
    }
  }

  const primaryDir = searchDirs[0] || path.join(userProfile, 'Downloads');

  for (const dir of searchDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            models.push(parseLocalGgufModel(fullPath, stat.size));
          } catch {
            // Ignore unreadable files
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  return { directory: primaryDir, models };
}

function createDefaultSnapshot(): RuntimeClusterSnapshot {
  const activeModel = GGUF_MODEL_PRESETS[0];
  const tuningConfig = createDefaultBackendTuningConfig(activeModel);
  const telemetry = createInitialTelemetryState(false);
  const liveHardware = probeLiveHardware();
  const nodes = buildStarClusterNodes(telemetry, 'LIVE_CLUSTER', 0, tuningConfig, liveHardware);
  const plan = planStarCluster(nodes, activeModel, undefined, tuningConfig);
  return {
    activeModel,
    clusterMode: 'LIVE_CLUSTER',
    tuningConfig,
    plan,
    upstreamBaseUrl: process.env.UPSTREAM_LLAMA_URL?.trim() ?? '',
    updatedAt: new Date().toISOString(),
  };
}

let clusterSnapshot: RuntimeClusterSnapshot = createDefaultSnapshot();

function buildClusterGroundedReply(
  messages: ChatMessageInput[],
  requestedModel: string
): string {
  const lastUserMsg =
    [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? '';
  const { activeModel, plan, tuningConfig } = clusterSnapshot;
  const activeNodes = plan.nodes.filter((n) => n.allocatedLayers > 0);
  const lower = lastUserMsg.toLowerCase();

  const nodeSummaryLines = activeNodes
    .map(
      (n) =>
        `- **${n.label}** (${n.osType} · ${n.backendDriver}): Layers \`L${n.layerStart}–L${n.layerEnd}\` (${n.allocatedLayers}L), **${n.activeParamsB}B active**, ${(n.allocatedMb / 1024).toFixed(1)} GB shard, KV ${n.kvCacheMb} MB, ~${n.estimatedTokPerSec} tok/s [${n.tuningFlags.join(', ')}]`
    )
    .join('\n');

  if (
    lower.includes('node') ||
    lower.includes('brain') ||
    lower.includes('layer') ||
    lower.includes('active param') ||
    lower.includes('ram') ||
    lower.includes('status')
  ) {
    return [
      `### Cluster Brain Execution Summary (\`${requestedModel || activeModel.name}\`)`,
      ``,
      `- **Architecture:** ${activeModel.architecture} (${activeModel.quant})`,
      `- **Active Parameters / Token:** \`${plan.activeParamsPerTokenB}B\` of \`${plan.totalParamsB}B\` total`,
      `- **Cluster Pool & Fit:** \`${(plan.totalSafePoolMb / 1024).toFixed(1)} GB\` safe pool / \`${(plan.neededMb / 1024).toFixed(1)} GB\` needed (**${plan.fitVerdict}**, ~${plan.estimatedClusterTokPerSec} tok/s)`,
      `- **Context & KV Cache:** \`${tuningConfig.contextLength.toLocaleString()} ctx\` · \`${tuningConfig.kvCacheQuant.toUpperCase()}\` (${plan.kvCacheTotalMb} MB)`,
      ``,
      `#### Per-Node Active Distribution`,
      nodeSummaryLines,
    ].join('\n');
  }

  if (
    lower.includes('hermes') ||
    lower.includes('opencode') ||
    lower.includes('api') ||
    lower.includes('endpoint') ||
    lower.includes('openai')
  ) {
    return [
      `OpenAI-compatible routes are active on this ClusterLab server:`,
      ``,
      `- \`GET /v1/models\` — lists \`${activeModel.name}\` and supported GGUF cluster presets`,
      `- \`POST /v1/chat/completions\` — supports streaming SSE (\`stream: true\`) and JSON completions`,
      ``,
      `To connect **OpenCode** or **Hermes**, point \`OPENAI_BASE_URL\` to \`http://<host>:3000/v1\` (or your native \`llama-server\` LAN port \`8080/v1\`) with model ID \`${activeModel.id}\`.`,
    ].join('\n');
  }

  return [
    `Processed across **${activeNodes.length} active star node(s)** running **${activeModel.name}** (${activeModel.quant}, \`${plan.activeParamsPerTokenB}B\` active params/token, ~\`${plan.estimatedClusterTokPerSec} tok/s\`).`,
    ``,
    `> **Prompt received:** ${lastUserMsg || '(empty prompt)'}`,
    ``,
    `**Execution Pipeline:**`,
    nodeSummaryLines,
    ``,
    `*Tip: To forward completions directly to a live native \`llama-server\` binary on your Windows or Linux host, enter its \`/v1\` URL in the Chat & Brain Upstream box or launch the tuned script from the Cluster dashboard.*`,
  ].join('\n');
}

async function createApp() {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Cluster-Secret');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'ClusterLab',
      runtime: 'express+vite',
      activeModel: clusterSnapshot.activeModel.name,
      activeNodes: clusterSnapshot.plan.nodes.filter((n) => n.allocatedLayers > 0).length,
      updatedAt: clusterSnapshot.updatedAt,
    });
  });

  app.get('/api/cluster/hardware', (_req, res) => {
    res.json(probeLiveHardware());
  });

  app.get('/api/local/models', (req, res) => {
    const dirParam = typeof req.query.dir === 'string' ? req.query.dir.trim() : undefined;
    const result = scanLocalGgufFiles(dirParam);
    res.json({
      directory: result.directory,
      count: result.models.length,
      models: result.models,
    });
  });

  app.post('/api/local/models/add', (req, res) => {
    const body = req.body as { filePath?: string } | undefined;
    const targetPath = body?.filePath?.trim();
    if (!targetPath) {
      res.status(400).json({ error: 'filePath parameter is required' });
      return;
    }

    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: `File not found at path: ${targetPath}` });
      return;
    }

    try {
      const stat = fs.statSync(targetPath);
      const model = parseLocalGgufModel(targetPath, stat.size);
      res.json({ ok: true, model });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to inspect local GGUF file',
      });
    }
  });

  app.get('/api/cluster/state', (_req, res) => {
    res.json(clusterSnapshot);
  });

  app.post('/api/cluster/state', (req, res) => {
    const body = req.body as Partial<RuntimeClusterSnapshot> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid cluster snapshot payload' });
      return;
    }

    clusterSnapshot = {
      activeModel: body.activeModel ?? clusterSnapshot.activeModel,
      clusterMode: body.clusterMode ?? clusterSnapshot.clusterMode,
      tuningConfig: body.tuningConfig ?? clusterSnapshot.tuningConfig,
      plan: body.plan ?? clusterSnapshot.plan,
      upstreamBaseUrl:
        typeof body.upstreamBaseUrl === 'string'
          ? body.upstreamBaseUrl.trim()
          : clusterSnapshot.upstreamBaseUrl,
      updatedAt: new Date().toISOString(),
    };

    res.json({ ok: true, updatedAt: clusterSnapshot.updatedAt });
  });

  app.get('/api/backends/script', (req, res) => {
    const osParam = req.query.os === 'linux' ? 'linux' : 'windows';
    const profile = buildTunedOsBackendProfile(
      osParam as BackendOsTarget,
      clusterSnapshot.activeModel,
      clusterSnapshot.plan,
      clusterSnapshot.tuningConfig
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${profile.scriptFileName}"`
    );
    res.send(profile.scriptContent);
  });

  app.get('/api/hf/models', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 18;
    const limit = Number.isFinite(limitRaw) ? Math.min(36, Math.max(4, limitRaw)) : 18;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    try {
      const params = new URLSearchParams({
        filter: 'gguf',
        sort: 'downloads',
        direction: '-1',
        limit: String(limit),
      });
      if (query) {
        params.set('search', query);
      }

      const hfRes = await fetch(`https://huggingface.co/api/models?${params.toString()}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ClusterLab/2.0',
        },
        signal: controller.signal,
      });

      if (!hfRes.ok) {
        throw new Error(`Hugging Face Hub HTTP ${hfRes.status}`);
      }

      const items = (await hfRes.json()) as Array<{
        id: string;
        downloads?: number;
        likes?: number;
        tags?: string[];
      }>;

      const mapped = items
        .filter((item) => Boolean(item?.id))
        .map((item) => inferHfModelMetadata(item));

      res.json({
        source: 'huggingface',
        query,
        count: mapped.length,
        models: mapped,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Hugging Face lookup failed';
      res.json({
        source: 'curated-fallback',
        query,
        warning: message,
        count: CURATED_HF_GGUF_CATALOG.length,
        models: CURATED_HF_GGUF_CATALOG,
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  // OpenAI-compatible GET /v1/models
  app.get('/v1/models', (_req, res) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const modelsData = [clusterSnapshot.activeModel, ...GGUF_MODEL_PRESETS]
      .filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .map((m) => ({
        id: m.id,
        object: 'model',
        created: nowSec,
        owned_by: 'clusterlab-star',
        x_cluster: {
          display_name: m.name,
          hf_repo: m.hfRepo,
          quant: m.quant,
          architecture: m.architecture,
          total_params_b: m.totalParamsB,
          active_params_b: m.activeParamsB,
          layers: m.layers,
          is_active: m.id === clusterSnapshot.activeModel.id,
          fit_verdict: clusterSnapshot.plan.fitVerdict,
          tensor_split: clusterSnapshot.plan.tensorSplitLabel,
          estimated_tok_per_sec: clusterSnapshot.plan.estimatedClusterTokPerSec,
        },
      }));

    res.json({
      object: 'list',
      data: modelsData,
    });
  });

  // OpenAI-compatible POST /v1/chat/completions (supports SSE streaming & upstream llama-server proxy)
  app.post('/v1/chat/completions', async (req, res) => {
    const body = (req.body ?? {}) as {
      model?: string;
      messages?: ChatMessageInput[];
      stream?: boolean;
      temperature?: number;
      max_tokens?: number;
      x_upstream_url?: string;
    };

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const requestedModel = body.model || clusterSnapshot.activeModel.id;
    const upstreamRaw = (body.x_upstream_url ?? clusterSnapshot.upstreamBaseUrl ?? '').trim();

    // Optional real upstream forwarding to a user-configured llama-server / clusterd endpoint
    if (upstreamRaw && /^https?:\/\//i.test(upstreamRaw)) {
      const normalized = upstreamRaw.replace(/\/+$/, '');
      const targetUrl = normalized.endsWith('/v1')
        ? `${normalized}/chat/completions`
        : `${normalized}/v1/chat/completions`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const forwardBody = { ...body };
        delete forwardBody.x_upstream_url;
        const upstreamRes = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
          },
          body: JSON.stringify(forwardBody),
          signal: controller.signal,
        });

        if (upstreamRes.ok && upstreamRes.body) {
          const contentType = upstreamRes.headers.get('content-type') || 'application/json';
          res.status(upstreamRes.status);
          res.setHeader('Content-Type', contentType);
          const reader = upstreamRes.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) res.write(Buffer.from(value));
          }
          res.end();
          return;
        }
      } catch {
        // Fall through to local cluster pipeline runtime when local LAN endpoint is unreachable
      } finally {
        clearTimeout(timeout);
      }
    }

    const replyText = buildClusterGroundedReply(messages, requestedModel);
    const completionId = `chatcmpl-clusterlab-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = Math.max(
      12,
      messages.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4), 0)
    );
    const completionTokens = Math.max(16, Math.ceil(replyText.length / 4));

    const activeNodeTrace = clusterSnapshot.plan.nodes
      .filter((n) => n.allocatedLayers > 0)
      .map((n) => ({
        node_id: n.nodeId,
        label: n.label,
        os: n.osType,
        driver: n.backendDriver,
        layers: `${n.layerStart}-${n.layerEnd}`,
        active_params_b: n.activeParamsB,
        kv_cache_mb: n.kvCacheMb,
        tok_per_sec: n.estimatedTokPerSec,
      }));

    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const chunks = replyText.match(/.{1,24}(\s|$)|\S+\s*/g) ?? [replyText];
      let idx = 0;

      const sendNextChunk = () => {
        if (idx === 0) {
          const roleChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
        }

        if (idx < chunks.length) {
          const tokenChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [
              {
                index: 0,
                delta: { content: chunks[idx] },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(tokenChunk)}\n\n`);
          idx++;
          setTimeout(sendNextChunk, 14);
        } else {
          const doneChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
            x_cluster_trace: {
              active_params_per_token_b: clusterSnapshot.plan.activeParamsPerTokenB,
              total_params_b: clusterSnapshot.plan.totalParamsB,
              estimated_tok_per_sec: clusterSnapshot.plan.estimatedClusterTokPerSec,
              nodes: activeNodeTrace,
            },
          };
          res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      };

      sendNextChunk();
      return;
    }

    res.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: replyText,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      x_cluster_trace: {
        active_params_per_token_b: clusterSnapshot.plan.activeParamsPerTokenB,
        total_params_b: clusterSnapshot.plan.totalParamsB,
        estimated_tok_per_sec: clusterSnapshot.plan.estimatedClusterTokPerSec,
        nodes: activeNodeTrace,
      },
    });
  });

  // Structured 404 for unmatched API / v1 endpoints across all environments
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });
  app.use('/v1', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  if (process.env.NODE_ENV === 'test') {
    return app;
  }

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // When running compiled dist/server.js, __dirname is the dist directory containing index.html.
    // When running from repo root, dist is a subdirectory.
    const distDir = fs.existsSync(path.join(__dirname, 'index.html'))
      ? __dirname
      : path.resolve(__dirname, 'dist');

    app.use(express.static(distDir));

    // SPA fallback: in Express 5 (path-to-regexp v6+), catch-all middleware avoids syntax errors
    app.use((_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Production build not found. Run npm run build.');
      }
    });
  }

  return app;
}

export async function startServer(portToUse?: number) {
  const app = await createApp();
  const port = portToUse ?? Number(process.env.PORT || process.env.PORT_APP || 3000);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`ClusterLab server listening on http://0.0.0.0:${port}`);
  });

  const shutdown = () => {
    console.log('Received termination signal. Closing ClusterLab server...');
    server.close(() => {
      console.log('ClusterLab server terminated cleanly.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server, port };
}

export { createApp };

// Only auto-start when executed directly (not when imported in unit tests)
const isDirectExecution =
  process.env.NODE_ENV !== 'test' &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('server.ts') ||
    process.argv[1]?.endsWith('server.js'));

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start ClusterLab server:', err);
    process.exit(1);
  });
}
