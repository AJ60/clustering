import express, { type Request, type Response } from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BackendOsTarget,
  BackendTuningConfig,
  ClusterMode,
  ClusterNetworkAuditReport,
  ConnectedDeviceInfo,
  EngineRuntimeStatus,
  GGUF_MODEL_PRESETS,
  GgufModelPreset,
  LiveHardwareProbe,
  NodeNetworkAudit,
  RuntimeClusterSnapshot,
} from './src/types/starCluster';
import { createInitialTelemetryState } from './src/service/nodeClusterService';
import { buildStarClusterNodes, planStarCluster, isSameAndroidWorker } from './src/domain/starClusterPlanner';
import {
  buildTunedOsBackendProfile,
  createDefaultBackendTuningConfig,
  validateStockLlamaFlags,
} from './src/domain/backendTuner';
import { CURATED_HF_GGUF_CATALOG, inferHfModelMetadata } from './src/data/hfModelsCatalog';
import { parseLocalGgufModel } from './src/data/localModelsScanner';
import {
  computeClusterAuthToken,
  decodeGgufHandshakeFrame,
  HANDSHAKE_CHALLENGE,
} from './src/domain/clusterAuth';
import {
  ClusterHistoryDocument,
  createEmptyHistoryDocument,
  recordEmaObservation,
  RunObservationInput,
} from './src/domain/emaHistory';
import { isBlockedIpLiteral, validatePublicHttpUrl } from './src/domain/ssrfGuard';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const CLUSTER_SECRET = process.env.CLUSTER_SECRET || 'clusterd-default-hmac-key';
const WORKER_TTL_MS = 30_000;
const HISTORY_PATH = path.resolve(process.cwd(), 'cluster_history.json');

interface RegisteredWorkerRecord {
  id: string;
  label: string;
  platform: 'Android' | 'Linux' | 'Windows' | 'Edge ARM' | 'Other';
  osType: string;
  ip: string;
  rpcPort: number;
  linkType: string;
  totalRamMb: number;
  availableRamMb: number;
  vramMb: number;
  computeTflops: number;
  memBwGbps: number;
  bigCores: number;
  rttMs: number;
  pktLossPct: number;
  tempC: number;
  cpuUsagePct: number;
  gpuUsagePct: number;
  handshakeVerified: boolean;
  lastSeenMs: number;
}

const registeredWorkers = new Map<string, RegisteredWorkerRecord>();
const customModelsRegistry = new Map<string, GgufModelPreset>();
let cachedGpuInfo: { ts: number; vramMb: number; gpuName?: string; gpuTempC?: number; gpuUsagePct?: number } | null = null;
let cachedAdbInfo: { ts: number; serials: string[] } | null = null;
let spawnedLlamaChild: ChildProcess | null = null;

// Turn-boundary drain state machine
let activeGenerationTurns = 0;
let engineDraining = false;
const drainWaiters: Array<() => void> = [];
const engineEventListeners = new Set<(msg: string) => void>();

function emitEngineEvent(msg: string) {
  engineStatus.lastEvent = msg;
  for (const fn of engineEventListeners) {
    try {
      fn(msg);
    } catch {
      // ignore disconnected listener
    }
  }
}

function tryAcquireTurn(): boolean {
  if (engineDraining) return false;
  activeGenerationTurns += 1;
  return true;
}

function releaseTurn(): void {
  activeGenerationTurns = Math.max(0, activeGenerationTurns - 1);
  if (activeGenerationTurns === 0 && engineDraining) {
    while (drainWaiters.length > 0) {
      const resolve = drainWaiters.shift();
      resolve?.();
    }
  }
}

async function drainActiveTurns(maxWaitMs = 10_000): Promise<boolean> {
  engineDraining = true;
  if (activeGenerationTurns === 0) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), maxWaitMs);
    drainWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function loadHistoryStore(): ClusterHistoryDocument {
  if (process.env.NODE_ENV === 'test') return createEmptyHistoryDocument();
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.profiles) {
        return parsed as ClusterHistoryDocument;
      }
    }
  } catch {
    // ignore corrupt history file
  }
  return createEmptyHistoryDocument();
}

function saveHistoryStore(doc: ClusterHistoryDocument): void {
  if (process.env.NODE_ENV === 'test') return;
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(doc, null, 2), 'utf8');
  } catch {
    // non-fatal
  }
}

const historyStore: ClusterHistoryDocument = loadHistoryStore();

function parseValidHttpOrigin(raw?: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

let activeModel: GgufModelPreset = GGUF_MODEL_PRESETS[0];
let clusterMode: ClusterMode = 'LIVE_CLUSTER';
let tuningConfig: BackendTuningConfig = createDefaultBackendTuningConfig(activeModel);
let upstreamBaseUrl: string = parseValidHttpOrigin(process.env.UPSTREAM_LLAMA_URL);

const engineStatus: EngineRuntimeStatus = {
  running: Boolean(upstreamBaseUrl),
  draining: false,
  activeTurns: 0,
  upstreamUrl: upstreamBaseUrl || null,
  serverType: upstreamBaseUrl ? 'llama-server' : 'offline',
  hasMmproj: Boolean(activeModel.mmprojPath),
  mmprojPath: activeModel.mmprojPath ?? null,
  lastEvent: upstreamBaseUrl
    ? `Connected to configured upstream ${upstreamBaseUrl}`
    : 'Engine offline — load a GGUF model or connect a local server',
  reloadProgressPct: upstreamBaseUrl ? 100 : 0,
};

function getPrimaryLanIpv4(): string {
  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    const addrs = nets[name] || [];
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        candidates.push(addr.address);
      }
    }
  }
  // Prefer private RFC1918 LAN addresses first
  const rfc1918 = candidates.find(
    (ip) =>
      ip.startsWith('192.168.') ||
      ip.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
  return rfc1918 || candidates[0] || '127.0.0.1';
}

function readLinuxThermalC(): number {
  if (os.platform() !== 'linux') return 44;
  try {
    const base = '/sys/class/thermal';
    if (!fs.existsSync(base)) return 44;
    let maxC = 0;
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith('thermal_zone')) continue;
      const p = path.join(base, entry, 'temp');
      if (!fs.existsSync(p)) continue;
      const raw = Number(fs.readFileSync(p, 'utf8').trim());
      const c = raw > 200 ? raw / 1000 : raw;
      if (c > 15 && c < 115 && c > maxC) maxC = c;
    }
    return maxC > 0 ? Number(maxC.toFixed(1)) : 44;
  } catch {
    return 44;
  }
}

async function probeGpuCached(): Promise<{
  vramMb: number;
  gpuName?: string;
  gpuTempC?: number;
  gpuUsagePct?: number;
}> {
  const now = Date.now();
  if (cachedGpuInfo && now - cachedGpuInfo.ts < 15_000) {
    return cachedGpuInfo;
  }
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,memory.total,temperature.gpu,utilization.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 2500 }
    );
    const first = stdout.trim().split('\n')[0];
    if (first) {
      const [name, vramStr, tempStr, utilStr] = first.split(',').map((s) => s.trim());
      const vramMb = Number(vramStr);
      if (Number.isFinite(vramMb) && vramMb > 0) {
        cachedGpuInfo = {
          ts: now,
          vramMb: Math.round(vramMb),
          gpuName: name,
          gpuTempC: Number(tempStr) || 0,
          gpuUsagePct: Number(utilStr) || 0,
        };
        return cachedGpuInfo;
      }
    }
  } catch {
    // No NVIDIA GPU or nvidia-smi not available — report real 0 VRAM (never fake VRAM!)
  }
  cachedGpuInfo = { ts: now, vramMb: 0 };
  return cachedGpuInfo;
}

async function setupAdbTunnelsCached(): Promise<string[]> {
  if (process.env.NODE_ENV === 'test') return [];
  const now = Date.now();
  if (cachedAdbInfo && now - cachedAdbInfo.ts < 10_000) {
    return cachedAdbInfo.serials;
  }
  try {
    const { stdout } = await execFileAsync('adb', ['devices', '-l'], { timeout: 2000 });
    const serials: string[] = [];
    for (const line of stdout.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === 'device') {
        const serial = parts[0];
        serials.push(serial);
        // Pass explicit `-s <serial>` so multi-device ADB never fails
        await execFileAsync('adb', ['-s', serial, 'reverse', 'tcp:3000', 'tcp:3000'], {
          timeout: 1500,
        }).catch(() => {});
        // Detect phone worker bound port dynamically (from /data/local/tmp/worker.log)
        let remotePort = '50054';
        try {
          const { stdout: pOut } = await execFileAsync('adb', [
            '-s', serial, 'shell',
            "toybox grep -o 'BoundPort=[0-9]*' /data/local/tmp/worker.log 2>/dev/null | toybox tail -n 1 | toybox cut -d= -f2"
          ], { timeout: 1500 });
          const trimmedPort = pOut.trim();
          if (trimmedPort && /^\d+$/.test(trimmedPort)) {
            remotePort = trimmedPort;
          }
        } catch {
          // fallback to 50054 or 50052
        }
        await execFileAsync('adb', ['-s', serial, 'forward', 'tcp:50052', `tcp:${remotePort}`], {
          timeout: 1500,
        }).catch(() => {});
      }
    }
    cachedAdbInfo = { ts: now, serials };
    return serials;
  } catch {
    cachedAdbInfo = { ts: now, serials: [] };
    return [];
  }
}

/**
 * Performs a genuine TCP + 32-byte keyed GGUF/RPC v9/v1.0.0 handshake probe against a worker.
 */
async function probeRpcHandshake(
  host: string,
  port: number,
  timeoutMs = 1500
): Promise<{ ok: boolean; rttMs: number; safeCapMb?: number; bigCores?: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, rttMs: timeoutMs });
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let totalLen = 0;

    socket.on('connect', () => {
      const authToken = computeClusterAuthToken(CLUSTER_SECRET, HANDSHAKE_CHALLENGE);
      socket.write(Buffer.from(authToken));
    });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      totalLen += chunk.length;
      if (totalLen >= 32) {
        clearTimeout(timer);
        const full = Buffer.concat(chunks);
        const decoded = decodeGgufHandshakeFrame(new Uint8Array(full.subarray(0, 32)));
        const rttMs = Math.max(0.4, Date.now() - start);
        socket.destroy();
        if (decoded) {
          resolve({
            ok: true,
            rttMs,
            safeCapMb: decoded.safeCapMb,
            bigCores: decoded.bigCores,
          });
        } else {
          resolve({ ok: false, rttMs });
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, rttMs: timeoutMs });
    });
  });
}

async function pruneStaleWorkers(): Promise<void> {
  const now = Date.now();
  const toDelete: string[] = [];
  for (const [id, worker] of registeredWorkers.entries()) {
    if (now - worker.lastSeenMs > WORKER_TTL_MS) {
      toDelete.push(id);
      continue;
    }
    // In live runtime, verify that the worker's TCP port is actively listening.
    // If the app was closed or uninstalled, the TCP connection is refused immediately.
    if (process.env.NODE_ENV !== 'test') {
      const alive = await probeTcpPort(worker.ip, worker.rpcPort, 120);
      if (!alive) {
        toDelete.push(id);
      }
    }
  }
  for (const id of toDelete) {
    registeredWorkers.delete(id);
  }
}

async function probeLiveHardware(): Promise<LiveHardwareProbe> {
  await pruneStaleWorkers();
  const rawPlatform = os.platform();
  const platform: 'windows' | 'linux' | 'darwin' =
    rawPlatform === 'win32' ? 'windows' : rawPlatform === 'darwin' ? 'darwin' : 'linux';
  const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
  const availableRamMb = Math.round(os.freemem() / (1024 * 1024));
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || 'Generic CPU';
  const cores = Math.max(1, cpus.length);
  const load1 = os.loadavg()[0] || 0;
  const cpuUsagePct = Math.min(100, Math.max(2, Math.round((load1 / cores) * 100)));

  const [gpu, _adbSerials] = await Promise.all([probeGpuCached(), setupAdbTunnelsCached()]);

  const connectedDevices: ConnectedDeviceInfo[] = [];
  const sortedWorkers = Array.from(registeredWorkers.values()).sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  for (const w of sortedWorkers) {
    if (!w.handshakeVerified) continue;
    const isDup = connectedDevices.some((existing) =>
      isSameAndroidWorker(existing, w) ||
      (existing.ip === w.ip && existing.rpcPort === w.rpcPort) ||
      (existing.platform === 'Android' &&
        w.platform === 'Android' &&
        (!existing.ip || existing.ip === 'localhost' || existing.ip.startsWith('127.')) &&
        (!w.ip || w.ip === 'localhost' || w.ip.startsWith('127.')) &&
        !existing.id.startsWith('vm-') &&
        !w.id.startsWith('vm-'))
    );
    if (isDup) continue;
    const safeCapMb =
      w.platform === 'Android'
        ? Math.floor(Math.min(w.totalRamMb * 0.5, w.availableRamMb * 0.8))
        : Math.max(512, Math.floor(w.availableRamMb * 0.82));
    connectedDevices.push({
      id: w.id,
      model: w.label,
      platform: w.platform,
      transport: w.linkType,
      safeCapMb,
      totalRamMb: w.totalRamMb,
      availableRamMb: w.availableRamMb,
      vramMb: w.vramMb,
      computeTflops: w.computeTflops,
      rttMs: w.rttMs,
      pktLossPct: w.pktLossPct,
      bandwidthMbps: w.linkType.includes('USB') ? 480 : w.linkType.includes('Eth') ? 2500 : 220,
      tempC: w.tempC,
      cpuUsagePct: w.cpuUsagePct,
      gpuUsagePct: w.gpuUsagePct,
      bigCores: w.bigCores,
      ip: w.ip,
      rpcPort: w.rpcPort,
      lastHeartbeatMs: w.lastSeenMs,
      handshakeVerified: true,
      isOnline: true,
      isWorkerRunning: true,
      workerStatus: 'Running',
    });
  }

  return {
    platform,
    osLabel: platform === 'windows' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux',
    hostname: os.hostname(),
    hostIp: getPrimaryLanIpv4(),
    totalRamMb,
    availableRamMb,
    vramMb: gpu.vramMb,
    gpuName: gpu.gpuName,
    cpuModel,
    cores,
    bigCores: Math.max(2, Math.ceil(cores / 2)),
    cpuTempC: readLinuxThermalC(),
    gpuTempC: gpu.gpuTempC ?? 0,
    cpuUsagePct,
    gpuUsagePct: gpu.gpuUsagePct ?? 0,
    connectedDevices,
  };
}

/**
 * Finds companion `*mmproj*.gguf` in the same or parent directory of a local model.
 */
export function findCompanionMmproj(modelPath: string): { path: string; sizeMb: number } | null {
  try {
    const base = path.basename(modelPath).toLowerCase();
    if (base.includes('mmproj')) return null;
    const dir = path.dirname(modelPath);
    const parent = path.dirname(dir);
    const dirs = [dir, parent].filter((d, i, arr) => d && arr.indexOf(d) === i);
    const stemPrefix = base.split(/[-_.]/)[0] || '';

    let best: { score: number; path: string; sizeMb: number } | null = null;
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const entry of fs.readdirSync(d)) {
        const lower = entry.toLowerCase();
        if (lower.endsWith('.gguf') && lower.includes('mmproj')) {
          const full = path.join(d, entry);
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          let score = 10;
          if (stemPrefix && lower.includes(stemPrefix)) score += 50;
          if (d === dir) score += 20;
          const sizeMb = Math.max(1, Math.round(st.size / (1024 * 1024)));
          if (!best || score > best.score) {
            best = { score, path: full, sizeMb };
          }
        }
      }
    }
    return best ? { path: best.path, sizeMb: best.sizeMb } : null;
  } catch {
    return null;
  }
}

function inspectGgufPathSync(filePath: string): GgufModelPreset {
  const st = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const readSize = Math.min(st.size, 131072);
  const buf = Buffer.alloc(readSize);
  try {
    fs.readSync(fd, buf, 0, readSize, 0);
  } finally {
    fs.closeSync(fd);
  }
  const mmproj = findCompanionMmproj(filePath);
  return parseLocalGgufModel(
    filePath,
    st.size,
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    mmproj
  );
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function resolveLlamaServerBinary(userSpecified?: string): string {
  if (userSpecified && fs.existsSync(userSpecified)) return userSpecified;
  const localWin = path.join(process.cwd(), 'llama-b11429', 'llama-server.exe');
  if (fs.existsSync(localWin)) return localWin;
  const localLinux = path.join(process.cwd(), 'llama-b11429', 'llama-server');
  if (fs.existsSync(localLinux)) return localLinux;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wingetDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetDir)) {
      try {
        const matches = fs.readdirSync(wingetDir).filter((d) => d.includes('llamacpp'));
        for (const m of matches) {
          const binP = path.join(wingetDir, m, 'llama-server.exe');
          if (fs.existsSync(binP)) return binP;
        }
      } catch {
        // ignore
      }
    }
  }
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

function findGgufFilesRecursive(dir: string, depth = 0, maxDepth = 2): string[] {
  if (depth > maxDepth || !fs.existsSync(dir)) return [];
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        files.push(...findGgufFilesRecursive(full, depth + 1, maxDepth));
      } else if (
        e.isFile() &&
        e.name.toLowerCase().endsWith('.gguf') &&
        !e.name.toLowerCase().includes('mmproj')
      ) {
        files.push(full);
      }
    }
  } catch {
    // skip unreadable directories
  }
  return files;
}

function resolveGgufModelPath(model: GgufModelPreset): string | null {
  if (model.localPath && fs.existsSync(model.localPath)) {
    return model.localPath;
  }
  const searchDirs = [
    path.resolve(process.cwd(), 'models'),
    path.resolve(process.cwd()),
    path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'models'),
    path.join(os.homedir(), 'Downloads', 'Models'),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), '.ollama', 'models'),
    path.join(os.homedir(), '.cache', 'lm-studio', 'models'),
  ];
  for (const d of searchDirs) {
    if (!fs.existsSync(d)) continue;
    const ggufs = findGgufFilesRecursive(d, 0, 2);
    for (const full of ggufs) {
      const e = path.basename(full);
      const normE = e.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normName = model.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normId = model.id.toLowerCase().replace(/[^a-z0-9]/g, '');
      // Match exact name/id or common model stem (e.g. qwen38 / 27b / coder)
      if (
        normE.includes(normName) ||
        normName.includes(normE) ||
        normE.includes(normId) ||
        (normName.includes('qwen') && normE.includes('qwen') && normE.includes('27b') && normName.includes('27b')) ||
        (normName.includes('bonsai') && normE.includes('bonsai')) ||
        (normName.includes('coder') && normE.includes('coder'))
      ) {
        return full;
      }
    }
  }
  return null;
}

function probeTcpPort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      clearTimeout(timer);
      s.destroy();
      resolve(false);
    });
  });
}

async function waitForServerHealth(
  baseUrl: string,
  maxWaitMs = 7000,
  child?: ChildProcess | null
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (child && child.exitCode !== null) return false;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 400);
      const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // not yet up
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function scanLocalGgufFiles(directory?: string): { directory: string; models: GgufModelPreset[] } {
  const targetDir = directory?.trim()
    ? path.resolve(expandHome(directory.trim()))
    : path.resolve(process.cwd(), 'models');
  const models: GgufModelPreset[] = [];

  const dirsToScan = [targetDir];
  if (!directory || directory === './models' || directory === 'models') {
    const hermesDir = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'models');
    if (fs.existsSync(hermesDir)) dirsToScan.push(hermesDir);
    const downloadsModelsDir = path.join(os.homedir(), 'Downloads', 'Models');
    if (fs.existsSync(downloadsModelsDir)) dirsToScan.push(downloadsModelsDir);
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    if (fs.existsSync(downloadsDir)) dirsToScan.push(downloadsDir);
  }

  const seenPaths = new Set<string>();
  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;
    const ggufFiles = findGgufFilesRecursive(dir, 0, 2);
    for (const full of ggufFiles) {
      if (seenPaths.has(full)) continue;
      seenPaths.add(full);
      try {
        const st = fs.statSync(full);
        // Skip small vocab helper files (< 50MB)
        if (st.size < 50 * 1024 * 1024 && path.basename(full).toLowerCase().includes('vocab')) {
          continue;
        }
        const parsed = inspectGgufPathSync(full);
        customModelsRegistry.set(parsed.id, parsed);
        models.push(parsed);
      } catch {
        // skip unreadable file
      }
    }
  }
  return { directory: targetDir, models };
}

function resolveModelPreset(idOrName?: string): GgufModelPreset {
  if (!idOrName) return activeModel;
  const key = idOrName.trim();
  if (customModelsRegistry.has(key)) return customModelsRegistry.get(key)!;
  const preset = GGUF_MODEL_PRESETS.find(
    (m) => m.id === key || m.name.toLowerCase() === key.toLowerCase()
  );
  if (preset) return preset;
  for (const m of customModelsRegistry.values()) {
    if (m.name.toLowerCase() === key.toLowerCase()) return m;
  }
  return activeModel;
}

async function computeRuntimeSnapshot(): Promise<RuntimeClusterSnapshot> {
  const liveHw = await probeLiveHardware();
  const baseTelemetry = createInitialTelemetryState(false);
  const nodes = buildStarClusterNodes(baseTelemetry, clusterMode, 0, tuningConfig, liveHw);
  const profileKey = `${activeModel.architecture}:${nodes.length}nodes`;
  const learned = historyStore.profiles[profileKey] ?? null;
  const plan = planStarCluster(nodes, activeModel, undefined, tuningConfig, learned);

  engineStatus.draining = engineDraining;
  engineStatus.activeTurns = activeGenerationTurns;
  engineStatus.hasMmproj = Boolean(plan.masterMmprojPath);
  engineStatus.mmprojPath = plan.masterMmprojPath ?? null;

  return {
    activeModel,
    clusterMode,
    tuningConfig,
    plan,
    upstreamBaseUrl,
    engineStatus: { ...engineStatus },
    learnedProfile: learned,
    updatedAt: new Date().toISOString(),
  };
}

function startUdpDiscoveryBeacon(): void {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', () => {
      try {
        udp.close();
      } catch {
        // ignore
      }
    });
    udp.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8').trim();
      if (text === 'CLUSTERD_DISCOVER') {
        const reply = Buffer.from(`CLUSTERD_MASTER:port=${PORT};secret=${CLUSTER_SECRET}`, 'utf8');
        udp.send(reply, rinfo.port, rinfo.address);
      }
    });
    udp.bind(50050, '0.0.0.0', () => {
      try {
        udp.setBroadcast(true);
      } catch {
        // ignore
      }
    });
  } catch {
    // UDP :50050 optional on restricted container environments
  }
}

async function resolveAndVerifyPublicUrl(rawUrl: string): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  const validated = validatePublicHttpUrl(rawUrl);
  if (!validated.ok) return validated;
  const host = validated.url.hostname;
  try {
    const records = await dns.promises.lookup(host, { all: true });
    for (const rec of records) {
      if (isBlockedIpLiteral(rec.address)) {
        return { ok: false, error: 'Hostname resolves to a blocked private or loopback address' };
      }
    }
  } catch {
    // If DNS lookup fails offline, let fetch handle or reject cleanly
  }
  return validated;
}

export async function createApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Auto-discover local GGUF weights on startup (models/, hermes, Downloads)
  if (process.env.NODE_ENV !== 'test') {
    try {
      const scanned = scanLocalGgufFiles();
      if (scanned.models.length > 0 && !resolveGgufModelPath(activeModel)) {
        activeModel = scanned.models[0];
        tuningConfig = {
          ...createDefaultBackendTuningConfig(activeModel),
          mmprojPath: activeModel.mmprojPath ?? '',
        };
      }
    } catch {
      // non-fatal
    }
  }

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  async function launchLlamaServer(
    binPath?: string
  ): Promise<{ ok: boolean; spawned: boolean; message: string }> {
    const modelLocalPath = resolveGgufModelPath(activeModel);
    if (!modelLocalPath || !fs.existsSync(modelLocalPath)) {
      return {
        ok: false,
        spawned: false,
        message: `Local GGUF model file for "${activeModel.name}" was not found on disk. Place .gguf in models/ or Downloads.`,
      };
    }
    activeModel.localPath = modelLocalPath;
    activeModel.isLocal = true;

    const bin = resolveLlamaServerBinary(binPath);
    const snap = await computeRuntimeSnapshot();
    let finalCliArgs = [...snap.plan.cliArgs];
    const mIdx = finalCliArgs.indexOf('-m');
    if (mIdx >= 0 && mIdx + 1 < finalCliArgs.length) {
      finalCliArgs[mIdx + 1] = modelLocalPath;
    }

    // Verify RPC targets
    const rpcIdx = finalCliArgs.indexOf('--rpc');
    if (rpcIdx >= 0 && rpcIdx + 1 < finalCliArgs.length) {
      const rawRpcs = finalCliArgs[rpcIdx + 1].split(',').map((s) => s.trim()).filter(Boolean);
      const verifiedRpcs: string[] = [];
      for (const target of rawRpcs) {
        const [rHost, rPortStr] = target.split(':');
        const rPort = Number(rPortStr || 50052);
        const live = await probeTcpPort(rHost, rPort, 800);
        if (live) verifiedRpcs.push(target);
      }
      if (verifiedRpcs.length === 0) {
        const tsIdx = finalCliArgs.indexOf('--tensor-split');
        if (tsIdx >= 0) finalCliArgs.splice(tsIdx, 2);
        const newRpcIdx = finalCliArgs.indexOf('--rpc');
        if (newRpcIdx >= 0) finalCliArgs.splice(newRpcIdx, 2);
      } else if (verifiedRpcs.length < rawRpcs.length) {
        finalCliArgs[rpcIdx + 1] = verifiedRpcs.join(',');
      }
    }

    // Ensure --slot-save-path directory exists if present, or strip it cleanly
    const slotIdx = finalCliArgs.indexOf('--slot-save-path');
    if (slotIdx >= 0 && slotIdx + 1 < finalCliArgs.length) {
      const slotVal = (finalCliArgs[slotIdx + 1] || '').trim();
      if (!slotVal) {
        finalCliArgs.splice(slotIdx, 2);
      } else {
        const slotDir = path.isAbsolute(slotVal) ? slotVal : path.resolve(process.cwd(), slotVal);
        try {
          fs.mkdirSync(slotDir, { recursive: true });
          finalCliArgs[slotIdx + 1] = slotDir;
        } catch {
          finalCliArgs.splice(slotIdx, 2);
        }
      }
    }

    // Dynamically calculate health wait time based on model size (min 10s, up to 35s for 35B models)
    const loadWaitMs = Math.max(10000, Math.min(35000, Math.ceil((activeModel.sizeMb || 4000) / 1024) * 2000));

    try {
      emitEngineEvent(`Launching ${path.basename(bin)} with local weights (${path.basename(modelLocalPath)})...`);
      const child = spawn(bin, finalCliArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let earlyStderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        if (earlyStderr.length < 2048) earlyStderr += c.toString('utf8');
      });

      const ready = await waitForServerHealth('http://127.0.0.1:8080', loadWaitMs, child);
      if (ready) {
        spawnedLlamaChild = child;
        upstreamBaseUrl = 'http://127.0.0.1:8080';
        engineStatus.running = true;
        engineStatus.upstreamUrl = upstreamBaseUrl;
        engineStatus.serverType = 'llama-server';
        const msg = `Live stock llama-server running on http://127.0.0.1:8080 (${path.basename(modelLocalPath)})`;
        return { ok: true, spawned: true, message: msg };
      }

      // If timed out but child is still hanging without listening, terminate it
      if (child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }

      // Unconditional resilient fallback to direct Master inference
      emitEngineEvent('Primary engine spawn failed or timed out, attempting resilient direct launch on Master...');
      const retryArgs = finalCliArgs.filter((a, idx, arr) => {
        if (a === '--rpc' || arr[idx - 1] === '--rpc') return false;
        if (a === '--tensor-split' || arr[idx - 1] === '--tensor-split') return false;
        if (a === '--slot-save-path' || arr[idx - 1] === '--slot-save-path') return false;
        return true;
      });
      const fallbackChild = spawn(bin, retryArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let fbStderr = '';
      fallbackChild.stderr?.on('data', (c: Buffer) => {
        if (fbStderr.length < 2048) fbStderr += c.toString('utf8');
      });
      const fbReady = await waitForServerHealth('http://127.0.0.1:8080', loadWaitMs, fallbackChild);
      if (fbReady) {
        spawnedLlamaChild = fallbackChild;
        upstreamBaseUrl = 'http://127.0.0.1:8080';
        engineStatus.running = true;
        engineStatus.upstreamUrl = upstreamBaseUrl;
        engineStatus.serverType = 'llama-server';
        const msg = `Live llama-server running on Master http://127.0.0.1:8080 (${path.basename(modelLocalPath)})`;
        return { ok: true, spawned: true, message: msg };
      }
      if (fallbackChild.exitCode === null) {
        try { fallbackChild.kill('SIGTERM'); } catch {}
      }
      const errDetail = (earlyStderr || fbStderr).slice(0, 240).trim() || 'Process exited prematurely or timed out';
      return { ok: false, spawned: false, message: `Engine start failed: ${errDetail}` };
    } catch (err) {
      return {
        ok: false,
        spawned: false,
        message: `Unable to spawn binary: ${err instanceof Error ? err.message : 'ENOENT'}`,
      };
    }
  }

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'Silica Cluster',
      runtime: 'node-preview-bridge',
      activeModel: activeModel.name,
      activeModelId: activeModel.id,
      engineRunning: engineStatus.running,
      draining: engineDraining,
      activeTurns: activeGenerationTurns,
    });
  });

  app.get('/api/cluster/beacon', (_req: Request, res: Response) => {
    res.json({
      service: 'Silica-Cluster-Master',
      masterHost: getPrimaryLanIpv4(),
      port: PORT,
      rpcPort: 50052,
      secret: CLUSTER_SECRET,
      protocolVersion: 9,
      activeModel: activeModel.name,
      activeModelId: activeModel.id,
      hasMmproj: Boolean(activeModel.mmprojPath || tuningConfig.mmprojPath),
    });
  });

  app.get('/api/cluster/hardware', async (_req: Request, res: Response) => {
    const hw = await probeLiveHardware();
    res.json(hw);
  });

  app.get('/api/cluster/state', async (_req: Request, res: Response) => {
    const snap = await computeRuntimeSnapshot();
    res.json(snap);
  });

  app.post('/api/cluster/state', async (req: Request, res: Response) => {
    const body = req.body as Partial<{
      activeModel: GgufModelPreset;
      clusterMode: ClusterMode;
      tuningConfig: Partial<BackendTuningConfig>;
      upstreamBaseUrl: string;
    }>;

    if (body.activeModel && body.activeModel.id) {
      customModelsRegistry.set(body.activeModel.id, body.activeModel);
      activeModel = body.activeModel;
    }
    if (body.clusterMode) {
      clusterMode = body.clusterMode;
    }
    if (body.tuningConfig) {
      tuningConfig = { ...tuningConfig, ...body.tuningConfig };
    }
    if (typeof body.upstreamBaseUrl === 'string') {
      upstreamBaseUrl = body.upstreamBaseUrl.trim();
      engineStatus.upstreamUrl = upstreamBaseUrl || null;
      engineStatus.running = Boolean(upstreamBaseUrl);
      engineStatus.serverType = upstreamBaseUrl
        ? upstreamBaseUrl.includes('11434')
          ? 'ollama'
          : upstreamBaseUrl.includes('1234')
            ? 'lm-studio'
            : 'llama-server'
        : 'offline';
      engineStatus.reloadProgressPct = upstreamBaseUrl ? 100 : 0;
    }

    const snap = await computeRuntimeSnapshot();
    res.json(snap);
  });

  app.get('/api/models', (_req: Request, res: Response) => {
    const scanned = scanLocalGgufFiles();
    const allModels = new Map<string, GgufModelPreset>();
    for (const m of scanned.models) allModels.set(m.id, m);
    for (const m of customModelsRegistry.values()) allModels.set(m.id, m);
    for (const m of GGUF_MODEL_PRESETS) if (!allModels.has(m.id)) allModels.set(m.id, m);
    res.json({
      activeId: activeModel.id,
      models: Array.from(allModels.values()),
    });
  });

  app.post('/api/models/activate', async (req: Request, res: Response) => {
    const body = req.body as { model?: GgufModelPreset; modelId?: string; reloadIfRunning?: boolean };
    if (body.model && body.model.id) {
      customModelsRegistry.set(body.model.id, body.model);
      activeModel = body.model;
      tuningConfig = {
        ...createDefaultBackendTuningConfig(activeModel),
        mmprojPath: activeModel.mmprojPath ?? '',
      };
    } else if (body.modelId) {
      activeModel = resolveModelPreset(body.modelId);
      tuningConfig = {
        ...createDefaultBackendTuningConfig(activeModel),
        mmprojPath: activeModel.mmprojPath ?? '',
      };
    }
    // If engine is currently running, hot-reload engine process with the newly activated model
    if (engineStatus.running && (body.reloadIfRunning || spawnedLlamaChild)) {
      if (spawnedLlamaChild) {
        try { spawnedLlamaChild.kill('SIGTERM'); } catch {}
        spawnedLlamaChild = null;
      }
      await launchLlamaServer();
    }
    const snap = await computeRuntimeSnapshot();
    res.json({ ok: true, snapshot: snap });
  });

  app.post('/api/models/inspect', (req: Request, res: Response) => {
    const filePath = String(req.body?.filePath || req.body?.path || '').trim();
    if (!filePath) {
      res.status(400).json({ error: 'filePath is required' });
      return;
    }
    if (!filePath.toLowerCase().endsWith('.gguf')) {
      res.status(400).json({ error: 'Only .gguf model files are supported' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: `Model file not found: ${filePath}` });
      return;
    }
    try {
      const parsed = inspectGgufPathSync(filePath);
      customModelsRegistry.set(parsed.id, parsed);
      res.json({
        ok: true,
        model: parsed,
        recommendedConfig: createDefaultBackendTuningConfig(parsed),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to parse GGUF binary header',
      });
    }
  });

  app.get('/api/local/models', (req: Request, res: Response) => {
    const dir = typeof req.query.dir === 'string' ? req.query.dir : undefined;
    const scanned = scanLocalGgufFiles(dir);
    res.json({
      directory: scanned.directory,
      count: scanned.models.length,
      models: scanned.models,
    });
  });

  app.post('/api/local/models/add', (req: Request, res: Response) => {
    const filePath = String(req.body?.filePath || '').trim();
    if (!filePath) {
      res.status(400).json({ error: 'filePath is required' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: `GGUF file not found on disk: ${filePath}` });
      return;
    }
    try {
      const parsed = inspectGgufPathSync(filePath);
      customModelsRegistry.set(parsed.id, parsed);
      res.json({ ok: true, model: parsed });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid GGUF file' });
    }
  });

  // Hugging Face live search with curated fallback
  app.get('/api/hf/models', async (req: Request, res: Response) => {
    const query = String(req.query.q || '').trim();
    const limit = Math.min(30, Math.max(4, Number(req.query.limit || 16)));
    if (!query) {
      res.json({ source: 'curated', models: CURATED_HF_GGUF_CATALOG.slice(0, limit) });
      return;
    }
    try {
      const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4500);
      const hfRes = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (hfRes.ok) {
        const items = (await hfRes.json()) as Array<{ id: string; downloads?: number; likes?: number; tags?: string[] }>;
        const mapped = items.map((item) => inferHfModelMetadata(item));
        res.json({ source: 'huggingface', models: mapped });
        return;
      }
    } catch {
      // fallback to curated filter
    }
    const lower = query.toLowerCase();
    const filtered = CURATED_HF_GGUF_CATALOG.filter(
      (m) =>
        m.name.toLowerCase().includes(lower) ||
        m.hfRepo.toLowerCase().includes(lower) ||
        m.tags.some((t) => t.toLowerCase().includes(lower))
    );
    res.json({ source: 'curated', models: filtered });
  });

  // Worker registration & live handshake verification
  const handleWorkerRegister = async (req: Request, res: Response) => {
    const b = req.body as Record<string, unknown>;
    const rawId = String(b.id || '').trim();
    const label = String(b.label || 'Remote Worker').trim();
    const ip = String(b.ip || String(b.addr || '127.0.0.1').split(':')[0] || '127.0.0.1').trim();
    const rpcPort = Number(b.rpcPort || b.rpc_port || String(b.addr || '').split(':')[1] || 50052);
    const rawPlatform = String(b.platform || b.osType || 'Linux');
    const platform: RegisteredWorkerRecord['platform'] = /android/i.test(rawPlatform)
      ? 'Android'
      : /win/i.test(rawPlatform)
        ? 'Windows'
        : /arm|rpi|sbc|edge/i.test(rawPlatform)
          ? 'Edge ARM'
          : 'Linux';

    const id =
      rawId ||
      `${platform.toLowerCase().replace(/\s+/g, '-')}-${label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 24)}`;

    // Deduplicate Android worker entries by IP/loopback and hardware signature so ghost duplicates never occur
    if (platform === 'Android') {
      const isLoopback = !ip || ip === 'localhost' || ip.startsWith('127.');
      for (const [existingId, existing] of registeredWorkers.entries()) {
        const existingIsLoopback = !existing.ip || existing.ip === 'localhost' || existing.ip.startsWith('127.');
        if (
          existing.platform === 'Android' &&
          (existingId === id ||
            existing.ip === ip ||
            (existingIsLoopback && isLoopback && !existingId.startsWith('vm-') && !id.startsWith('vm-')) ||
            isSameAndroidWorker(existing, { platform, ip, id, label }))
        ) {
          registeredWorkers.delete(existingId);
        }
      }
    }

    // Attempt live 32-byte GGUF/RPC v9 handshake unless explicitly registering inside unit test
    let rttMs = Number(b.rttMs || (ip === '127.0.0.1' ? 0.8 : 4.2));
    let handshakeVerified = process.env.NODE_ENV === 'test' || Boolean(b.skipHandshakeProbe);
    if (!handshakeVerified && ip) {
      const probe = await probeRpcHandshake(ip, rpcPort, 1200);
      if (probe.ok) {
        handshakeVerified = true;
        rttMs = probe.rttMs;
      } else if (b.allowHttpRegistration === true || ip === '127.0.0.1') {
        // Even for HTTP registration, strictly verify that the worker's TCP port is actively open
        const tcpOpen = await probeTcpPort(ip, rpcPort, 400);
        if (tcpOpen) {
          handshakeVerified = true;
        }
      }
    }

    if (!handshakeVerified) {
      res.status(502).json({
        ok: false,
        error: `Worker ${ip}:${rpcPort} failed 32-byte GGUF/RPC v9 handshake verification`,
      });
      return;
    }

    const rec: RegisteredWorkerRecord = {
      id,
      label,
      platform,
      osType: String(b.osType || platform.toLowerCase()),
      ip,
      rpcPort,
      linkType: String(b.linkType || (ip === '127.0.0.1' ? 'USB-C Tunnel' : 'Wi-Fi LAN')),
      totalRamMb: Number(b.totalRamMb || 8192),
      availableRamMb: Number(b.availableRamMb || 4096),
      vramMb: Number(b.vramMb || 0),
      computeTflops: Number(b.computeTflops || (platform === 'Android' ? 1.8 : 4.5)),
      memBwGbps: Number(b.memBwGbps || (platform === 'Android' ? 28 : 48)),
      bigCores: Number(b.bigCores || 4),
      rttMs,
      pktLossPct: Number(b.pktLossPct || 0),
      tempC: Number(b.tempC || 34),
      cpuUsagePct: Number(b.cpuUsagePct || 16),
      gpuUsagePct: Number(b.gpuUsagePct || 0),
      handshakeVerified: true,
      lastSeenMs: Date.now(),
    };

    registeredWorkers.set(id, rec);
    const snapshot = await computeRuntimeSnapshot();
    const planned = snapshot.plan.nodes.find((n) => n.nodeId === id);

    res.json({
      ok: true,
      registered: id,
      assignedLayers: planned?.allocatedLayers ?? 0,
      snapshot,
    });
  };

  app.post('/api/cluster/nodes/register', handleWorkerRegister);
  app.post('/api/nodes/add', handleWorkerRegister);

  app.post('/api/cluster/nodes/unregister', async (req: Request, res: Response) => {
    const id = String(req.body?.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'id is required' });
      return;
    }
    const removed = registeredWorkers.delete(id);
    const snapshot = await computeRuntimeSnapshot();
    res.json({ ok: true, removed, snapshot });
  });

  app.get('/api/cluster/network/audit', async (_req: Request, res: Response) => {
    const hw = await probeLiveHardware();
    const nodes: NodeNetworkAudit[] = [
      {
        nodeId: 'master-host',
        label: `${hw.hostname || hw.osLabel} (Master)`,
        role: 'Master',
        ip: hw.hostIp || '127.0.0.1',
        linkType: 'Local',
        rttMs: 0.2,
        bandwidthMbps: 10000,
        packetLossPct: 0,
        status: 'Optimal',
        portsReachable: {
          master3000: true,
          upstream8080: engineStatus.running,
        },
      },
      ...hw.connectedDevices.map((dev) => ({
        nodeId: dev.id,
        label: dev.model,
        role: 'Worker' as const,
        ip: dev.ip || '127.0.0.1',
        linkType: (dev.transport.includes('USB')
          ? 'USB-C Tunnel'
          : dev.transport.includes('Eth')
            ? 'Ethernet 2.5G'
            : 'Wi-Fi LAN') as NodeNetworkAudit['linkType'],
        rttMs: dev.rttMs ?? 1.2,
        bandwidthMbps: dev.bandwidthMbps ?? 480,
        packetLossPct: dev.pktLossPct ?? 0,
        status: ((dev.rttMs ?? 1) > 40 ? 'Degraded' : 'Optimal') as NodeNetworkAudit['status'],
        portsReachable: {
          rpc50052: Boolean(dev.handshakeVerified),
        },
      })),
    ];

    const avgRtt = nodes.reduce((a, n) => a + n.rttMs, 0) / Math.max(1, nodes.length);
    const report: ClusterNetworkAuditReport = {
      timestamp: new Date().toISOString(),
      hostIp: hw.hostIp || '127.0.0.1',
      hostHostname: hw.hostname || os.hostname(),
      activeTransport: nodes.length > 1 ? nodes[1].linkType : 'Local Master Only',
      nodes,
      summary: {
        totalNodes: nodes.length,
        healthyNodes: nodes.filter((n) => n.status === 'Optimal').length,
        clusterRating: avgRtt < 5 ? 'Ultra-Low Latency (A+)' : avgRtt < 25 ? 'Balanced LAN (A)' : 'Degraded Link (B)',
        avgRttMs: Number(avgRtt.toFixed(2)),
        bottleneckNode: nodes.find((n) => n.status === 'Degraded')?.label ?? null,
      },
    };
    res.json(report);
  });

  // Live Upstream Connection Probe (`llama-server`, Ollama, LM Studio)
  app.post('/api/upstream/test', async (req: Request, res: Response) => {
    const rawUrl = String(req.body?.url || upstreamBaseUrl || '').trim().replace(/\/+$/, '');
    if (!rawUrl) {
      res.status(400).json({ ok: false, error: 'Server URL is required' });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Invalid scheme');
      }
    } catch {
      res.status(400).json({ ok: false, error: 'Enter a valid http:// or https:// URL' });
      return;
    }

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const modelsRes = await fetch(`${parsed.origin}/v1/models`, { signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (modelsRes.ok) {
        const json = (await modelsRes.json()) as { data?: Array<{ id: string }> };
        const models = Array.isArray(json.data) ? json.data.map((m) => m.id) : [];
        const serverType: EngineRuntimeStatus['serverType'] = parsed.port === '11434'
          ? 'ollama'
          : parsed.port === '1234'
            ? 'lm-studio'
            : 'llama-server';

        if (req.body?.apply === true) {
          upstreamBaseUrl = parsed.origin;
          engineStatus.running = true;
          engineStatus.upstreamUrl = parsed.origin;
          engineStatus.serverType = serverType;
          engineStatus.reloadProgressPct = 100;
          emitEngineEvent(`Connected to ${serverType} at ${parsed.origin} (${latencyMs} ms)`);
        }

        res.json({ ok: true, latencyMs, serverType, models, url: parsed.origin });
        return;
      }
      res.status(502).json({
        ok: false,
        latencyMs,
        error: `Server responded with HTTP ${modelsRes.status} on /v1/models`,
      });
    } catch (err) {
      clearTimeout(timer);
      res.status(502).json({
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'Unable to reach local server',
      });
    }
  });

  // Model Hot-Reload with Graceful Turn-Boundary Draining + Stock Flag Validation
  app.post('/api/engine/reload', async (req: Request, res: Response) => {
    const body = req.body as Partial<{
      model: GgufModelPreset;
      tuningConfig: Partial<BackendTuningConfig>;
      spawnLocalBinary: boolean;
      binaryPath: string;
    }>;

    if (body.model && body.model.id) {
      customModelsRegistry.set(body.model.id, body.model);
      activeModel = body.model;
    }
    if (body.tuningConfig) {
      tuningConfig = { ...tuningConfig, ...body.tuningConfig };
    }

    const snap = await computeRuntimeSnapshot();
    const flagValidation = validateStockLlamaFlags(snap.plan.cliArgs);
    if (!flagValidation.ok) {
      res.status(400).json({
        ok: false,
        error: `Rejected non-stock llama.cpp flag: ${flagValidation.invalidFlag}`,
      });
      return;
    }

    // Check draft vocab hash compatibility when external draft is configured
    if (
      tuningConfig.speculativeMode === 'external_draft' &&
      tuningConfig.draftModelPath?.trim() &&
      fs.existsSync(tuningConfig.draftModelPath.trim()) &&
      activeModel.vocabHash
    ) {
      try {
        const draftCard = inspectGgufPathSync(tuningConfig.draftModelPath.trim());
        if (draftCard.vocabHash && draftCard.vocabHash !== activeModel.vocabHash) {
          res.status(400).json({
            ok: false,
            error: `Draft model vocabulary hash mismatch (${draftCard.vocabHash} != ${activeModel.vocabHash})`,
          });
          return;
        }
      } catch {
        // ignore if draft file unreadable
      }
    }

    engineStatus.reloadProgressPct = 20;
    emitEngineEvent('Draining active generation turns at turn boundary...');
    await drainActiveTurns(8000);
    engineStatus.reloadProgressPct = 55;

    if (spawnedLlamaChild) {
      try {
        spawnedLlamaChild.kill('SIGTERM');
      } catch {
        // ignore
      }
      spawnedLlamaChild = null;
    }

    let spawned = false;
    let spawnNote = 'Configuration & sharding plan validated and applied.';

    if (body.spawnLocalBinary) {
      const launchRes = await launchLlamaServer(body.binaryPath);
      spawned = launchRes.spawned;
      spawnNote = launchRes.message;
      if (!launchRes.ok) {
        engineDraining = false;
        engineStatus.reloadProgressPct = 0;
        emitEngineEvent(spawnNote);
        const errSnap = await computeRuntimeSnapshot();
        res.status(400).json({
          ok: false,
          spawned: false,
          error: spawnNote,
          cliArgs: errSnap.plan.cliArgs,
          snapshot: errSnap,
        });
        return;
      }
    }

    engineDraining = false;
    engineStatus.reloadProgressPct = 100;
    emitEngineEvent(spawnNote);

    const updated = await computeRuntimeSnapshot();
    res.json({
      ok: true,
      spawned,
      message: spawnNote,
      cliArgs: updated.plan.cliArgs,
      snapshot: updated,
    });
  });

  app.post('/api/engine/stop', async (_req: Request, res: Response) => {
    emitEngineEvent('Stopping local inference engine...');
    if (spawnedLlamaChild) {
      try {
        spawnedLlamaChild.kill('SIGTERM');
      } catch {
        // ignore
      }
      spawnedLlamaChild = null;
    }
    upstreamBaseUrl = '';
    engineStatus.running = false;
    engineStatus.upstreamUrl = null;
    engineStatus.serverType = 'offline';
    engineStatus.lastEvent = 'Engine stopped — offline';
    engineStatus.reloadProgressPct = 0;
    const snap = await computeRuntimeSnapshot();
    res.json({ ok: true, message: 'Engine stopped cleanly.', snapshot: snap });
  });

  app.get('/api/engine/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ event: engineStatus.lastEvent, progress: engineStatus.reloadProgressPct })}\n\n`);

    const onEvent = (msg: string) => {
      res.write(`data: ${JSON.stringify({ event: msg, progress: engineStatus.reloadProgressPct })}\n\n`);
    };
    engineEventListeners.add(onEvent);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 10_000);
    req.on('close', () => {
      clearInterval(keepalive);
      engineEventListeners.delete(onEvent);
    });
  });

  app.get('/api/backends/script', async (req: Request, res: Response) => {
    const osTarget: BackendOsTarget = req.query.os === 'linux' ? 'linux' : 'windows';
    const snap = await computeRuntimeSnapshot();
    const profile = buildTunedOsBackendProfile(osTarget, snap.activeModel, snap.plan, snap.tuningConfig);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${profile.scriptFileName}"`);
    res.send(profile.scriptContent);
  });

  // Self-learning EMA history API
  app.get('/api/history', (_req: Request, res: Response) => {
    res.json(historyStore);
  });

  app.post('/api/history/record', (req: Request, res: Response) => {
    const obs = req.body as RunObservationInput;
    if (!obs?.profileKey) {
      res.status(400).json({ error: 'profileKey is required' });
      return;
    }
    const updated = recordEmaObservation(historyStore, obs);
    saveHistoryStore(historyStore);
    res.json({ ok: true, profile: updated });
  });

  // SSRF-safe optional Web Tools for Chat
  app.post('/api/tools/fetch-url', async (req: Request, res: Response) => {
    const rawUrl = String(req.body?.url || '').trim();
    const check = await resolveAndVerifyPublicUrl(rawUrl);
    if (!check.ok) {
      res.status(400).json({ ok: false, error: check.error });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(check.url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Silica-Cluster-Agent/1.0' },
      });
      clearTimeout(timer);
      if (resp.status >= 300 && resp.status < 400) {
        res.status(400).json({ ok: false, error: 'Cross-origin redirects are blocked for safety' });
        return;
      }
      const rawText = await resp.text();
      const plain = rawText
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12000);
      res.json({ ok: true, status: resp.status, url: check.url.toString(), content: plain });
    } catch (err) {
      clearTimeout(timer);
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to fetch URL',
      });
    }
  });

  app.post('/api/tools/web-search', async (req: Request, res: Response) => {
    const query = String(req.body?.query || '').trim();
    if (!query || query.length > 300) {
      res.status(400).json({ ok: false, error: 'Provide a search query (1-300 chars)' });
      return;
    }
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await fetch(ddgUrl, { signal: controller.signal });
      clearTimeout(timer);
      const data = (await resp.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        Heading?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      const results: Array<{ title: string; snippet: string; url: string }> = [];
      if (data.AbstractText) {
        results.push({
          title: data.Heading || query,
          snippet: data.AbstractText,
          url: data.AbstractURL || '',
        });
      }
      for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(' - ')[0] || query,
            snippet: topic.Text,
            url: topic.FirstURL,
          });
        }
      }
      res.json({ ok: true, query, results });
    } catch (err) {
      clearTimeout(timer);
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Web search request failed',
      });
    }
  });

  // OpenAI-compatible /v1/models
  app.get('/v1/models', async (_req: Request, res: Response) => {
    const snap = await computeRuntimeSnapshot();
    const allModels = new Map<string, GgufModelPreset>();
    allModels.set(activeModel.id, activeModel);
    for (const m of customModelsRegistry.values()) allModels.set(m.id, m);
    for (const m of GGUF_MODEL_PRESETS) if (!allModels.has(m.id)) allModels.set(m.id, m);

    res.json({
      object: 'list',
      data: Array.from(allModels.values()).map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'silica-cluster',
        x_cluster: {
          name: m.name,
          architecture: m.architecture,
          quant: m.quant,
          layers: m.layers,
          total_params_b: m.totalParamsB,
          active_params_b: m.activeParamsB,
          has_mmproj: Boolean(m.mmprojPath),
          vocab_hash: m.vocabHash ?? null,
          engine_running: snap.engineStatus?.running ?? false,
        },
      })),
    });
  });

  // OpenAI-compatible /v1/chat/completions
  // - Strict honest HTTP 503 when no live engine is loaded (zero misleading fake replies!)
  // - Full passthrough for image_url, tools, tool_choice, delta.tool_calls, reasoning_content
  // - 10-second SSE `: keepalive\n\n` heartbeats during long prefills
  // - Turn-boundary guard + connect-only timeout (never cuts long streams)
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    if (!upstreamBaseUrl) {
      res.status(503).json({
        error: {
          message:
            'No live inference engine is loaded. Load a local .gguf model or connect a running llama-server, Ollama, or LM Studio instance.',
          type: 'engine_offline',
          code: 'ENGINE_OFFLINE',
          recovery: 'Open Models to load a GGUF or use Connect Local Server in Chat.',
        },
      });
      return;
    }

    if (!tryAcquireTurn()) {
      res.status(503).json({
        error: {
          message: 'Silica Cluster is draining active generation turns for a model hot-reload.',
          type: 'engine_draining',
          code: 'ENGINE_DRAINING',
        },
      });
      return;
    }

    const startTime = Date.now();
    const isStream = Boolean(req.body?.stream);
    const targetUrl = `${upstreamBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 120_000);

    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization ? { Authorization: String(req.headers.authorization) } : {}),
        },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });

      // Clear connect timeout immediately once response headers arrive so long SSE streams never abort
      clearTimeout(connectTimer);

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        res.status(upstreamRes.status).type('application/json').send(
          errText ||
            JSON.stringify({
              error: {
                message: `Upstream engine returned HTTP ${upstreamRes.status}`,
                code: 'UPSTREAM_ERROR',
              },
            })
        );
        return;
      }

      if (!isStream) {
        const json = await upstreamRes.text();
        res.status(200).type('application/json').send(json);
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      // Emit 10-second SSE keepalive heartbeats so long prefills never time out
      const keepaliveTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': keepalive\n\n');
        }
      }, 10_000);

      let firstChunkAt: number | null = null;
      let chunkCount = 0;

      try {
        const reader = upstreamRes.body?.getReader();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              if (firstChunkAt === null) firstChunkAt = Date.now();
              chunkCount += 1;
              res.write(Buffer.from(value));
            }
          }
        }
      } finally {
        clearInterval(keepaliveTimer);
        if (!res.writableEnded) res.end();

        // Feed real observed TTFT & throughput back into EMA self-learning history
        if (firstChunkAt !== null && chunkCount > 2) {
          const totalSec = Math.max(0.1, (Date.now() - firstChunkAt) / 1000);
          const estTokS = chunkCount / totalSec;
          const ttftMs = firstChunkAt - startTime;
          const profileKey = `${activeModel.architecture}:${1 + registeredWorkers.size}nodes`;
          recordEmaObservation(historyStore, {
            profileKey,
            observedTokPerSec: estTokS,
            observedTtftMs: ttftMs,
            peakVramMb: 0,
            batchSize: tuningConfig.batchSize ?? 1024,
            ubatchSize: tuningConfig.ubatchSize ?? 256,
            usedNkvo: Boolean(tuningConfig.noKvOffload),
            throttled: false,
            oomOrFail: false,
          });
          saveHistoryStore(historyStore);
        }
      }
    } catch (err) {
      clearTimeout(connectTimer);
      if (!res.headersSent) {
        res.status(503).json({
          error: {
            message: `Upstream engine unreachable at ${upstreamBaseUrl}: ${err instanceof Error ? err.message : 'connection failed'}`,
            type: 'upstream_unreachable',
            code: 'UPSTREAM_UNREACHABLE',
          },
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      releaseTurn();
    }
  });

  // Structured JSON 404 for unknown API & v1 routes
  app.use(['/api', '/v1'], (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  // Serve Vite dev middleware in development or static dist in production
  if (process.env.NODE_ENV !== 'test') {
    if (process.env.NODE_ENV === 'production') {
      const distDir = path.resolve(process.cwd(), 'dist');
      app.use(express.static(distDir));
      app.use((_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }
  }

  return app;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  startUdpDiscoveryBeacon();
  createApp().then((app) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Silica Cluster preview bridge running on http://0.0.0.0:${PORT}`);
    });
  });
}
