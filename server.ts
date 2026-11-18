import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, ChildProcess, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RPC_VERSION_PIN,
  LLAMA_TAG_PIN,
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_THERMAL_LIMITS,
  RadixPrefixRouter,
  ThermalBalancer,
  ClusterLearner,
  computeAndroidSafeCap,
  computeDesktopSafeCap,
  computeVramSafeCap,
  computeNodeStrengthScore,
  classifyFitBadge,
  inspectGgufBinaryHeader,
  scanModelsDirectory,
  proposeNgramDraft,
  computeClusterPlan,
  encodePreflightHandshake,
  decodePreflightHandshake,
  buildVirtual4NodeSuite,
  scoreNode,
} from "./planner.ts";
import type {
  NodeTelemetry,
  GgufMeta,
  ClusterConfig,
  ClusterPlan,
  VirtualTestCheck,
  ThermalLimits,
  NodeOverride,
  BackendPreference,
} from "./planner.ts";

export {
  RPC_VERSION_PIN,
  LLAMA_TAG_PIN,
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_THERMAL_LIMITS,
  ThermalBalancer,
  ClusterLearner,
  computeAndroidSafeCap,
  computeDesktopSafeCap,
  computeVramSafeCap,
  computeNodeStrengthScore,
  computeClusterPlan,
  encodePreflightHandshake,
  decodePreflightHandshake,
  buildVirtual4NodeSuite,
  scoreNode,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "cluster.log");
const MAX_LOG_BUFFER = 250;
const logBuffer: string[] = [];

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // Ephemeral filesystem fallback handled by in-memory buffer
}

function logEvent(
  level: string,
  nodeId: string,
  stage: string,
  code: string,
  msg: string,
  kv: Record<string, string | number | boolean | undefined> = {}
): void {
  const ts = new Date().toISOString();
  const pairs = Object.entries(kv)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const line = `[${ts}] [${level}] [${nodeId}] [${stage}] [${code}] ${msg} | ${pairs}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.shift();
  }
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    // Ignore disk write failures in read-only environments
  }
}

function detectOs(): string {
  if (process.env.ANDROID_ROOT || fs.existsSync("/system/build.prop")) {
    if (fs.existsSync("/data/data/com.termux") || process.env.TERMUX_VERSION) {
      return "android_termux";
    }
    return "android_apk";
  }
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function detectIsaAndPerfCores(): { isa: string; perfCores: number; logicalCores: number } {
  const logicalCores = Math.max(1, os.cpus().length);
  let cpuinfoStr = "";
  if (fs.existsSync("/proc/cpuinfo")) {
    try {
      cpuinfoStr = fs.readFileSync("/proc/cpuinfo", "utf-8").toLowerCase();
    } catch {
      // ignore
    }
  }
  let isa = "x86_64 Baseline";
  if (cpuinfoStr.includes("avx512f")) {
    isa = cpuinfoStr.includes("amx_tile") ? "AVX-512 / AMX" : "AVX-512";
  } else if (cpuinfoStr.includes("avx2")) {
    isa = "AVX2 / FMA";
  } else if (cpuinfoStr.includes("asimddp") && cpuinfoStr.includes("i8mm")) {
    isa = "ARMv8.2+ DotProd/i8mm";
  } else if (cpuinfoStr.includes("asimddp")) {
    isa = "ARMv8.2+ DotProd";
  } else if (os.arch() === "arm64") {
    isa = "ARMv8.0 NEON";
  } else if (os.arch() === "x64") {
    isa = "AVX2 / FMA";
  }

  // Exclude HyperThreads & slower efficiency E-cores via cpufreq max freq check
  const freqs: number[] = [];
  for (let i = 0; i < Math.min(logicalCores, 64); i++) {
    const p = `/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`;
    if (fs.existsSync(p)) {
      try {
        const khz = parseInt(fs.readFileSync(p, "utf-8").trim(), 10);
        if (Number.isFinite(khz) && khz > 0) freqs.push(khz);
      } catch {
        // ignore
      }
    }
  }
  let perfCores = logicalCores;
  if (freqs.length > 0) {
    const maxKhz = Math.max(...freqs);
    perfCores = Math.max(1, freqs.filter((f) => f * 100 >= maxKhz * 82).length);
  } else if (cpuinfoStr.includes("ht ") || logicalCores >= 8) {
    perfCores = Math.max(2, Math.floor(logicalCores / 2));
  }
  return { isa, perfCores: Math.min(logicalCores, perfCores), logicalCores };
}

function benchmarkMemBwGbps(): number {
  const size = 8 * 1024 * 1024;
  const src = Buffer.alloc(size, 0x3c);
  const dst = Buffer.allocUnsafe(size);
  const t0 = performance.now();
  src.copy(dst);
  src.copy(dst);
  const secs = Math.max(0.0005, (performance.now() - t0) / 1000);
  const gbps = (size * 2) / 1e9 / secs;
  return Math.round(Math.min(450, Math.max(8, gbps)) * 10) / 10;
}

function benchmarkDiskSeqMbps(): number {
  const probeFile = path.join(os.tmpdir(), "clusterd_disk_probe.tmp");
  try {
    const block = Buffer.alloc(1024 * 1024, 0x5a);
    const fd = fs.openSync(probeFile, "w");
    for (let i = 0; i < 8; i++) fs.writeSync(fd, block);
    fs.closeSync(fd);
    const rfd = fs.openSync(probeFile, "r");
    const rbuf = Buffer.allocUnsafe(1024 * 1024);
    const t0 = performance.now();
    let total = 0;
    while (true) {
      const n = fs.readSync(rfd, rbuf, 0, rbuf.length, null);
      if (n <= 0) break;
      total += n;
    }
    fs.closeSync(rfd);
    const secs = Math.max(0.001, (performance.now() - t0) / 1000);
    return Math.round(Math.min(8000, Math.max(20, total / (1024 * 1024) / secs)));
  } catch {
    return 450;
  } finally {
    try {
      fs.unlinkSync(probeFile);
    } catch {
      // ignore
    }
  }
}

function detectSilicon(): { name: string; computeTflops: number; memBwGbps: number; vramTotalFreeMb: number } {
  let cpuinfoStr = "";
  if (fs.existsSync("/proc/cpuinfo")) {
    try {
      cpuinfoStr = fs.readFileSync("/proc/cpuinfo", "utf-8").toLowerCase();
    } catch {
      // ignore
    }
  }

  try {
    const nvOut = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 1200, stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim();
    if (nvOut) {
      const firstLine = nvOut.split(/\r?\n/)[0] || "";
      const [gpuName, freeMbStr] = firstLine.split(",");
      const freeMb = parseInt((freeMbStr || "0").trim(), 10) || 0;
      return {
        name: `NVIDIA ${(gpuName || "GPU").trim()}`,
        computeTflops: 12.0,
        memBwGbps: 300.0,
        vramTotalFreeMb: freeMb,
      };
    }
  } catch {
    // No NVIDIA GPU available
  }

  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.toLowerCase() : "";
  const combinedInfo = `${cpuinfoStr} ${cpuModel} ${os.arch()}`.toLowerCase();

  if (combinedInfo.includes("sm8650") || combinedInfo.includes("snapdragon 8 gen 3")) {
    return { name: "Snapdragon 8 Gen 3/Adreno 750", computeTflops: 3.4, memBwGbps: 77.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("sm8550") || combinedInfo.includes("snapdragon 8 gen 2")) {
    return { name: "Snapdragon 8 Gen 2/Adreno 740", computeTflops: 2.6, memBwGbps: 64.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("sm8450") || combinedInfo.includes("snapdragon 8 gen 1")) {
    return { name: "Snapdragon 8 Gen 1/Adreno 730", computeTflops: 2.0, memBwGbps: 51.2, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("snapdragon") || combinedInfo.includes("qcom") || combinedInfo.includes("adreno")) {
    return { name: "Snapdragon/Adreno", computeTflops: 1.85, memBwGbps: 34.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("tensor") || combinedInfo.includes("zuma")) {
    return { name: "Google Tensor/Mali", computeTflops: 2.2, memBwGbps: 64.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("dimensity") || combinedInfo.includes("mtk")) {
    return { name: "MediaTek Dimensity/Mali", computeTflops: 2.4, memBwGbps: 60.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("exynos") || combinedInfo.includes("xclipse")) {
    return { name: "Samsung Exynos/Xclipse", computeTflops: 2.0, memBwGbps: 64.0, vramTotalFreeMb: 0 };
  }
  if (process.platform === "darwin" || combinedInfo.includes("apple")) {
    return { name: "Apple Silicon", computeTflops: 4.5, memBwGbps: 100.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("amd") || combinedInfo.includes("ryzen") || combinedInfo.includes("epyc")) {
    return { name: "AMD Ryzen/Radeon", computeTflops: 1.8, memBwGbps: 50.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("intel") || combinedInfo.includes("xeon")) {
    return { name: "Intel Core/Xeon", computeTflops: 1.5, memBwGbps: 45.0, vramTotalFreeMb: 0 };
  }
  if (combinedInfo.includes("cortex") || combinedInfo.includes("arm64") || combinedInfo.includes("aarch64")) {
    return { name: "ARM Cortex/Generic", computeTflops: 0.4, memBwGbps: 17.0, vramTotalFreeMb: 0 };
  }

  return { name: "Generic CPU", computeTflops: 0.5, memBwGbps: 25.0, vramTotalFreeMb: 0 };
}

function getRamInfo(osName: string, cfg: ClusterConfig): { ramTotalMb: number; ramAvailMb: number; safeCapMb: number } {
  let ramTotalMb = Math.max(512, Math.floor(os.totalmem() / (1024 * 1024)));
  let ramAvailMb = Math.max(256, Math.floor(os.freemem() / (1024 * 1024)));

  if (fs.existsSync("/proc/meminfo")) {
    try {
      const meminfo: Record<string, number> = {};
      const lines = fs.readFileSync("/proc/meminfo", "utf-8").split(/\r?\n/);
      for (const line of lines) {
        const parts = line.split(":");
        if (parts.length === 2) {
          const k = parts[0].trim();
          const v = parts[1].trim().split(/\s+/)[0];
          if (/^\d+$/.test(v)) {
            meminfo[k] = parseInt(v, 10);
          }
        }
      }
      if (meminfo.MemTotal) ramTotalMb = Math.floor(meminfo.MemTotal / 1024);
      if (meminfo.MemAvailable) {
        ramAvailMb = Math.floor(meminfo.MemAvailable / 1024);
      } else if (meminfo.MemFree) {
        ramAvailMb = Math.floor(((meminfo.MemFree || 0) + (meminfo.Buffers || 0) + (meminfo.Cached || 0)) / 1024);
      }
    } catch {
      // fallback
    }
  }

  const allowOver50 = cfg.experimental_fork_enabled && cfg.allow_android_over_50;
  const safeCapMb = osName.toLowerCase().includes("android")
    ? computeAndroidSafeCap(ramTotalMb, ramAvailMb, cfg.android_ram_cap_pct, cfg.os_reserve_mb, allowOver50)
    : computeDesktopSafeCap(ramAvailMb, cfg.desktop_ram_cap_pct, cfg.os_reserve_mb);

  return { ramTotalMb, ramAvailMb, safeCapMb };
}

function selectNetworkInterface(): { ip: string; linkType: string } {
  const candidates: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const ifaceList of Object.values(interfaces)) {
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (iface.family === "IPv4" && !iface.internal && iface.address) {
        candidates.push(iface.address);
      }
    }
  }

  for (const ip of candidates) {
    if (ip.startsWith("192.168.42.") || ip.startsWith("192.168.43.") || ip.startsWith("10.42.0.")) {
      return { ip, linkType: "usb_rndis" };
    }
  }
  for (const ip of candidates) {
    if (ip.startsWith("192.168.137.")) {
      return { ip, linkType: "wifi_hotspot" };
    }
  }
  for (const ip of candidates) {
    const octets = ip.split(".");
    const second = parseInt(octets[1] || "0", 10);
    if (ip.startsWith("192.168.") || ip.startsWith("10.") || (ip.startsWith("172.") && second >= 16 && second <= 31)) {
      return { ip, linkType: "wifi_lan" };
    }
  }
  return { ip: "127.0.0.1", linkType: "loopback" };
}

let prevCpuSample: { idle: number; total: number } | null = null;

function readCpuUtilPct(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  if (!prevCpuSample || total <= prevCpuSample.total) {
    prevCpuSample = { idle, total };
    const load1 = os.loadavg()[0] || 0.25;
    return Math.round(Math.min(100, Math.max(2, (load1 / Math.max(1, cpus.length)) * 100)) * 10) / 10;
  }
  const idleDiff = idle - prevCpuSample.idle;
  const totalDiff = total - prevCpuSample.total;
  prevCpuSample = { idle, total };
  const pct = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 5.0;
  return Math.round(Math.min(100, Math.max(1, pct)) * 10) / 10;
}

function getThermalTelemetry(isAndroid = false): {
  cpuTempC: number;
  gpuTempC: number;
  cpuUtilPct: number;
  gpuUtilPct: number;
  thermalHeadroom: number;
} {
  let cpuTempC = 42.0;
  let gpuTempC = 0.0;
  let gpuUtilPct = 0.0;
  const cpuUtilPct = readCpuUtilPct();

  const thermalBase = "/sys/class/thermal";
  if (fs.existsSync(thermalBase)) {
    try {
      for (const zone of fs.readdirSync(thermalBase)) {
        if (!zone.startsWith("thermal_zone")) continue;
        const tFile = path.join(thermalBase, zone, "temp");
        if (fs.existsSync(tFile)) {
          let val = parseFloat(fs.readFileSync(tFile, "utf-8").trim());
          if (val > 1000) val /= 1000.0;
          if (val >= 15.0 && val <= 110.0) {
            cpuTempC = val;
            break;
          }
        }
      }
    } catch {
      // fallback
    }
  }

  try {
    const nvOut = execFileSync(
      "nvidia-smi",
      ["--query-gpu=temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 600, stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim();
    if (nvOut) {
      const firstLine = nvOut.split(/\r?\n/)[0] || "";
      const [tStr, uStr] = firstLine.split(",");
      const tVal = parseFloat((tStr || "").trim());
      const uVal = parseFloat((uStr || "").trim());
      if (Number.isFinite(tVal)) gpuTempC = tVal;
      if (Number.isFinite(uVal)) gpuUtilPct = uVal;
    }
  } catch {
    // No NVIDIA GPU sensors present
  }

  const refTemp = isAndroid ? cpuTempC : Math.max(cpuTempC, gpuTempC);
  const thermalHeadroom = isAndroid
    ? Math.max(0.0, Math.min(1.0, (refTemp - 26.0) / (50.0 - 26.0)))
    : Math.max(0.0, Math.min(1.0, (refTemp - 30.0) / (90.0 - 30.0)));

  return {
    cpuTempC: Math.round(cpuTempC * 10) / 10,
    gpuTempC: Math.round(gpuTempC * 10) / 10,
    cpuUtilPct,
    gpuUtilPct: Math.round(gpuUtilPct * 10) / 10,
    thermalHeadroom: Math.round(thermalHeadroom * 100) / 100,
  };
}

/**
 * Real TCP connect + 32-byte GGUF / RPC v9 / v1.0.0 handshake probe.
 * Returns connected:true only when peer responds with valid 32-byte handshake.
 */
async function probeTcpHandshake(host: string, port: number, timeoutMs = 400): Promise<{
  connected: boolean;
  rttMs: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (connected: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        connected,
        rttMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(false, "TCP handshake timeout"));
    socket.on("error", (err) => finish(false, err.message));

    socket.connect(port, host, () => {
      socket.write(encodePreflightHandshake(RPC_VERSION_PIN, LLAMA_TAG_PIN));
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes >= 32) {
        const res = decodePreflightHandshake(Buffer.concat(chunks).subarray(0, 32));
        finish(res.ok, res.error);
      }
    });
  });
}

class NodeAgent {
  public readonly nodeId: string;
  public readonly isMaster: boolean;
  public readonly rpcPort: number;
  public readonly osName: string;
  public readonly isa: string;
  public readonly perfCores: number;
  public readonly silicon: string;
  public readonly computeTflops: number;
  public readonly memBwGbps: number;
  public readonly diskMbps: number;
  public readonly vramTotalFreeMb: number;
  public readonly ip: string;
  public readonly linkType: string;

  constructor(nodeId = "master-hub", isMaster = true, rpcPort = 50052) {
    this.nodeId = nodeId;
    this.isMaster = isMaster;
    this.rpcPort = rpcPort;
    this.osName = detectOs();
    const cpuInfo = detectIsaAndPerfCores();
    this.isa = cpuInfo.isa;
    this.perfCores = cpuInfo.perfCores;
    const siliconInfo = detectSilicon();
    this.silicon = siliconInfo.name;
    this.computeTflops = siliconInfo.computeTflops;
    this.memBwGbps = Math.max(siliconInfo.memBwGbps, benchmarkMemBwGbps());
    this.diskMbps = benchmarkDiskSeqMbps();
    this.vramTotalFreeMb = siliconInfo.vramTotalFreeMb;
    const netInfo = selectNetworkInterface();
    this.ip = netInfo.ip;
    this.linkType = netInfo.linkType;

    logEvent("INFO", this.nodeId, "PROFILER", "BENCHMARK_DONE", `Auto-profiled ${this.osName} host (${this.isa}, ${this.perfCores} P-cores)`, {
      silicon: this.silicon,
      mem_bw_gbps: this.memBwGbps,
      disk_mbps: this.diskMbps,
      ip: this.ip,
      pin: `${LLAMA_TAG_PIN}/rpc-v${RPC_VERSION_PIN}`,
    });
  }

  getTelemetry(cfg: ClusterConfig = DEFAULT_CLUSTER_CONFIG): NodeTelemetry {
    const { ramTotalMb, ramAvailMb, safeCapMb } = getRamInfo(this.osName, cfg);
    const { cpuTempC, gpuTempC, cpuUtilPct, gpuUtilPct, thermalHeadroom } = getThermalTelemetry(
      this.osName.toLowerCase().includes("android")
    );
    const vramSafeMb = computeVramSafeCap(this.vramTotalFreeMb, cfg.vram_cap_pct);
    const strengthScore = computeNodeStrengthScore(this.memBwGbps, this.computeTflops, this.vramTotalFreeMb);

    return {
      node_id: this.nodeId,
      is_master: this.isMaster,
      os: this.osName,
      isa: this.isa,
      silicon: this.silicon,
      ip: this.ip,
      link_type: this.linkType,
      rpc_port: this.rpcPort,
      rpc_version: RPC_VERSION_PIN,
      git_tag: LLAMA_TAG_PIN,
      perf_cores: this.perfCores,
      ram_total_mb: ramTotalMb,
      ram_avail_mb: ramAvailMb,
      safe_cap_mb: safeCapMb,
      vram_total_free_mb: this.vramTotalFreeMb,
      vram_safe_mb: vramSafeMb,
      compute_tflops: this.computeTflops,
      mem_bw_gbps: this.memBwGbps,
      disk_mbps: this.diskMbps,
      rtt_ms: 0.0,
      p95_rtt_ms: 0.0,
      jitter_ms: 0.0,
      pkt_loss_pct: 0.0,
      bandwidth_mbps: 10000.0,
      temp_c: cpuTempC,
      cpu_temp_c: cpuTempC,
      gpu_temp_c: gpuTempC,
      cpu_util_pct: cpuUtilPct,
      gpu_util_pct: gpuUtilPct,
      thermal_headroom: thermalHeadroom,
      strength_score: strengthScore,
      vulkan_active: false,
      execution_backend: vramSafeMb > 0 ? "CUDA0 + Host CPU" : "Host CPU (Master)",
      handshake_ok: true,
      status: "CONNECTED",
      last_seen: Date.now() / 1000,
    };
  }
}

class MasterController {
  public readonly masterId: string;
  public readonly httpPort: number;
  public readonly rpcPort: number;
  // Live Cluster registry ONLY (never polluted by virtual simulation nodes)
  public readonly nodes = new Map<string, NodeTelemetry>();
  public currentPlan!: ClusterPlan;
  public llamaProc: ChildProcess | null = null;
  public localAgent: NodeAgent;
  public ggufMeta: GgufMeta;
  public discoveredModels: GgufMeta[] = [];
  public config: ClusterConfig;
  public readonly radixRouter = new RadixPrefixRouter(4);
  public readonly thermalBalancer = new ThermalBalancer();
  public readonly learner = new ClusterLearner(path.join(__dirname, "cluster_history.json"));
  public clusterTokS = 0.0;
  public llamaRunning = false;
  public lastVirtualSuite: ReturnType<typeof buildVirtual4NodeSuite> | null = null;

  constructor(masterId = "master-hub", httpPort = 3000, rpcPort = 50052) {
    this.masterId = masterId;
    this.httpPort = httpPort;
    this.rpcPort = rpcPort;
    this.config = {
      ...DEFAULT_CLUSTER_CONFIG,
      thermal_limits: { ...DEFAULT_THERMAL_LIMITS },
      node_overrides: {},
    };

    this.localAgent = new NodeAgent(this.masterId, true, this.rpcPort);
    const masterTel = this.localAgent.getTelemetry(this.config);
    this.registerLiveNode(masterTel);

    const safePool = masterTel.safe_cap_mb + masterTel.vram_safe_mb;
    this.discoveredModels = scanModelsDirectory("models", safePool);
    if (this.discoveredModels.length > 0) {
      this.ggufMeta = this.discoveredModels[0];
    } else {
      this.ggufMeta = inspectGgufBinaryHeader("models/Qwen3-30B-A3B-Q4_K_M.gguf", 18500, safePool);
    }

    logEvent("INFO", this.masterId, "INIT", "MASTER_INITIALIZED", `clusterd coordinator initialized on port ${this.httpPort}`);
  }

  registerLiveNode(telemetry: NodeTelemetry): void {
    telemetry.last_seen = Date.now() / 1000;
    this.nodes.set(telemetry.node_id, telemetry);
    logEvent("INFO", this.masterId, "REGISTRY", "NODE_REGISTERED", `Registered live node ${telemetry.node_id}`, {
      ip: telemetry.ip,
      link: telemetry.link_type,
      status: telemetry.status,
      cap_mb: telemetry.safe_cap_mb,
      vram_safe_mb: telemetry.vram_safe_mb,
    });
  }

  updateClusterPlan(): ClusterPlan {
    this.currentPlan = computeClusterPlan(
      Array.from(this.nodes.values()),
      this.ggufMeta,
      this.config,
      (nodeId, code, msg) => logEvent("WARNING", nodeId, "PLANNER", code, msg),
      {
        thermalBalancer: this.thermalBalancer,
        learner: this.learner,
        clusterTokS: this.clusterTokS,
        nowEpochS: Math.floor(Date.now() / 1000),
      }
    );
    logEvent(
      "INFO",
      this.masterId,
      "PLAN",
      "PLAN_COMPUTED",
      `Live plan computed: ${this.currentPlan.active_nodes.length} active, ${this.currentPlan.pruned_nodes.length} pruned`,
      {
        rpc: this.currentPlan.rpc_arg || "standalone",
        split: this.currentPlan.tensor_split,
        mmap_stream: this.currentPlan.mmap_stream,
      }
    );
    return this.currentPlan;
  }

  resetLiveToLocal(): ClusterPlan {
    this.nodes.clear();
    this.registerLiveNode(this.localAgent.getTelemetry(this.config));
    return this.updateClusterPlan();
  }

  async discoverAndProbe(): Promise<{ adb_devices: number; verified_spokes: string[]; plan: ClusterPlan }> {
    const verifiedSpokes: string[] = [];
    let adbDevices = 0;

    try {
      const out = execFileSync("adb", ["devices"], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      for (const line of out.split(/\r?\n/).slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === "device") {
          const port = 50052 + adbDevices;
          adbDevices += 1;
          try {
            execFileSync("adb", ["-s", parts[0], "forward", `tcp:${port}`, "tcp:50052"], {
              timeout: 1000,
              stdio: "ignore",
            });
          } catch {
            // ignore adb forward failure
          }
          const probe = await probeTcpHandshake("127.0.0.1", port, 400);
          const spokeId = `adb-usb-${parts[0]}`;
          if (probe.connected) {
            verifiedSpokes.push(`127.0.0.1:${port}`);
            this.registerLiveNode({
              node_id: spokeId,
              is_master: false,
              os: "android_apk",
              silicon: "Android USB Spoke",
              ip: "127.0.0.1",
              link_type: "adb_usb",
              rpc_port: port,
              rpc_version: RPC_VERSION_PIN,
              git_tag: LLAMA_TAG_PIN,
              ram_total_mb: 8192,
              ram_avail_mb: 5120,
              safe_cap_mb: computeAndroidSafeCap(
                8192,
                5120,
                this.config.android_ram_cap_pct,
                this.config.os_reserve_mb,
                this.config.experimental_fork_enabled && this.config.allow_android_over_50
              ),
              vram_safe_mb: 0,
              compute_tflops: 2.0,
              mem_bw_gbps: 50.0,
              rtt_ms: probe.rttMs,
              p95_rtt_ms: probe.rttMs,
              pkt_loss_pct: 0.0,
              bandwidth_mbps: 3000.0,
              temp_c: 38.0,
              thermal_headroom: 0.25,
              vulkan_active: true,
              execution_backend: "Vulkan 1.4 (RPC v9)",
              handshake_ok: true,
              status: "CONNECTED",
            });
          } else {
            this.registerLiveNode({
              node_id: spokeId,
              is_master: false,
              os: "android_apk",
              silicon: "Android USB Spoke",
              ip: "127.0.0.1",
              link_type: "adb_usb",
              rpc_port: port,
              rpc_version: 0,
              git_tag: "",
              ram_total_mb: 0,
              ram_avail_mb: 0,
              safe_cap_mb: 0,
              vram_safe_mb: 0,
              compute_tflops: 0,
              mem_bw_gbps: 0,
              rtt_ms: 999.0,
              p95_rtt_ms: 999.0,
              pkt_loss_pct: 100.0,
              bandwidth_mbps: 0,
              temp_c: 0,
              thermal_headroom: 0,
              vulkan_active: false,
              execution_backend: "Offline",
              handshake_ok: false,
              status: "OFFLINE",
            });
          }
        }
      }
    } catch {
      logEvent("INFO", this.masterId, "DISCOVERY", "ADB_UNAVAILABLE", "adb binary not present; no USB Android spokes attached");
    }

    // Re-probe any registered remote spokes in live registry
    for (const [nodeId, node] of Array.from(this.nodes.entries())) {
      if (node.is_master) continue;
      const probe = await probeTcpHandshake(node.ip, node.rpc_port, 400);
      if (probe.connected) {
        node.status = "CONNECTED";
        node.handshake_ok = true;
        node.p95_rtt_ms = probe.rttMs;
        node.last_seen = Date.now() / 1000;
        verifiedSpokes.push(`${node.ip}:${node.rpc_port}`);
      } else {
        node.status = "OFFLINE";
        node.handshake_ok = false;
        node.alloc_mb = 0;
        logEvent("WARNING", nodeId, "DISCOVERY", "SPOKE_OFFLINE", `TCP/handshake failed (${probe.error || "unreachable"})`);
      }
      this.nodes.set(nodeId, node);
    }

    return {
      adb_devices: adbDevices,
      verified_spokes: verifiedSpokes,
      plan: this.updateClusterPlan(),
    };
  }

  /**
   * Executes the 4-node simulation in a completely isolated sandbox without
   * mutating live controller.nodes or controller.currentPlan.
   */
  runVirtual4NodeTest(): ReturnType<typeof buildVirtual4NodeSuite> {
    const suite = buildVirtual4NodeSuite(this.config.android_ram_cap_pct, this.config);
    this.lastVirtualSuite = suite;
    logEvent(
      "INFO",
      this.masterId,
      "VIRTUAL_TEST",
      suite.passed ? "SANDBOX_PASS" : "SANDBOX_FAIL",
      `Isolated 4-node sandbox simulation completed (${suite.checks.filter((c) => c.passed).length}/${suite.checks.length} passed) — live nodes untouched`
    );
    return suite;
  }

  checkContingencies(): boolean {
    const now = Date.now() / 1000;
    let changed = false;

    for (const [nodeId, node] of Array.from(this.nodes.entries())) {
      if (node.is_master) {
        const refreshed = this.localAgent.getTelemetry(this.config);
        refreshed.last_seen = now;
        const prevAlloc = this.currentPlan?.active_nodes.find((n) => n.node_id === nodeId)?.alloc_mb ?? 0;
        const prevState = this.currentPlan?.active_nodes.find((n) => n.node_id === nodeId)?.thermal_state ?? "COOL";
        const capShrankBelowAlloc = refreshed.safe_cap_mb + refreshed.vram_safe_mb < prevAlloc;
        const majorDrift = Math.abs(refreshed.safe_cap_mb - node.safe_cap_mb) >= 128;

        // Always keep live sensor metrics current for the 1.5s SSE HUD
        node.cpu_temp_c = refreshed.cpu_temp_c;
        node.gpu_temp_c = refreshed.gpu_temp_c;
        node.cpu_util_pct = refreshed.cpu_util_pct;
        node.gpu_util_pct = refreshed.gpu_util_pct;
        node.temp_c = refreshed.temp_c;
        node.thermal_headroom = refreshed.thermal_headroom;
        node.last_seen = now;

        const nextTh = this.thermalBalancer.evaluateNode(
          nodeId,
          node.os.toLowerCase().includes("android"),
          (node.vram_total_free_mb ?? node.vram_safe_mb ?? 0) > 0 || (node.gpu_temp_c ?? 0) > 0,
          node.cpu_temp_c ?? node.temp_c,
          node.gpu_temp_c ?? 0,
          node.thermal_headroom,
          Math.floor(now),
          this.config.thermal_limits
        );

        if (
          capShrankBelowAlloc ||
          majorDrift ||
          refreshed.vram_safe_mb !== node.vram_safe_mb ||
          nextTh.state !== prevState
        ) {
          if (capShrankBelowAlloc || majorDrift || refreshed.vram_safe_mb !== node.vram_safe_mb) {
            this.nodes.set(nodeId, refreshed);
          } else {
            this.nodes.set(nodeId, node);
          }
          changed = true;
        } else {
          this.nodes.set(nodeId, node);
        }
        continue;
      }

      const ageSec = now - (node.last_seen ?? 0);
      if (node.status === "CONNECTED" && ageSec > 6.0) {
        node.status = "OFFLINE";
        node.handshake_ok = false;
        node.alloc_mb = 0;
        this.nodes.set(nodeId, node);
        changed = true;
        logEvent(
          "WARNING",
          nodeId,
          "WATCHDOG",
          "NODE_OFFLINE",
          `Spoke missed >6s heartbeat (${ageSec.toFixed(1)}s); set OFFLINE and alloc_mb=0`
        );
      }
    }

    if (changed) {
      this.updateClusterPlan();
    }
    return changed;
  }

  findLlamaServerBinary(): string | null {
    const candidates = ["llama-server", "llama-server.exe"];
    for (const dir of [process.cwd(), path.join(process.cwd(), "build", "bin")]) {
      for (const name of candidates) {
        const p = path.join(dir, name);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      }
    }
    return null;
  }

  startLlamaServer(): boolean {
    const binPath = this.findLlamaServerBinary();
    if (!binPath) {
      logEvent("WARNING", this.masterId, "LLAMA", "BINARY_NOT_FOUND", "Stock llama-server v1.0.0 binary not installed; live inference proxy returns 503 until llama-server listens on 8080");
      return false;
    }
    if (!fs.existsSync(this.ggufMeta.model_path)) {
      logEvent("INFO", this.masterId, "LLAMA", "MODEL_NOT_FOUND", `Model '${this.ggufMeta.model_path}' not on local disk; ready for hardware launch`);
      return false;
    }
    const plan = this.currentPlan;
    const args = ["-m", this.ggufMeta.model_path, ...plan.flags];
    if (plan.rpc_arg) args.push("--rpc", plan.rpc_arg);
    if (plan.active_nodes.length > 1) args.push("--tensor-split", plan.tensor_split);
    try {
      this.llamaProc = spawn(binPath, args, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async checkLlamaServerReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${LLAMA_SERVER_URL}/health`, {
        headers: { "x-clusterd-hop": "1" },
        signal: AbortSignal.timeout(400),
      });
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      return res.ok && ct.includes("application/json");
    } catch {
      return Boolean(this.llamaProc && this.llamaProc.exitCode === null);
    }
  }
}

const PORT = Number(process.env.PORT) || 3000;
const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080";

const controller = new MasterController("master-hub", PORT, 50052);
controller.updateClusterPlan();
controller.startLlamaServer();

const contingencyTimer = setInterval(() => {
  controller.checkContingencies();
}, 2000);
contingencyTimer.unref();

const app = express();
app.use(express.json());

app.get(["/", "/dashboard.html", "/index.html"], (_req: Request, res: Response) => {
  const dashPath = path.join(__dirname, "dashboard.html");
  if (fs.existsSync(dashPath)) {
    res.sendFile(dashPath);
  } else {
    res.status(404).send("dashboard.html not found");
  }
});

function buildStatusPayload(llamaOnline: boolean) {
  const poolMb = controller.currentPlan?.total_cluster_safe_mb ?? 0;
  const activeModel = {
    ...controller.ggufMeta,
    fit_badge: classifyFitBadge(controller.ggufMeta.file_size_mb, poolMb),
  };
  return {
    cluster_id: controller.masterId,
    version: LLAMA_TAG_PIN,
    rpc_version: RPC_VERSION_PIN,
    mode: "live",
    timestamp: Date.now() / 1000,
    plan: controller.currentPlan,
    config: controller.config,
    nodes: Array.from(controller.nodes.values()),
    llama_running: llamaOnline,
    cluster_tok_s: controller.clusterTokS,
    model: activeModel,
    discovered_models: controller.discoveredModels,
    learned_profiles: controller.learner.allProfiles(),
    virtual_sandbox: controller.lastVirtualSuite,
  };
}

app.get("/api/status", async (_req: Request, res: Response) => {
  const llamaOnline = await controller.checkLlamaServerReachable();
  controller.llamaRunning = llamaOnline;
  res.json(buildStatusPayload(llamaOnline));
});

app.get("/api/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendSnapshot = () => {
    const payload = buildStatusPayload(controller.llamaRunning);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sendSnapshot();
  const timer = setInterval(sendSnapshot, 1500);
  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
});

app.get("/api/history", (_req: Request, res: Response) => {
  res.json({ profiles: controller.learner.allProfiles() });
});

app.post("/api/history/reset", (_req: Request, res: Response) => {
  controller.learner.reset();
  const plan = controller.updateClusterPlan();
  logEvent("INFO", controller.masterId, "LEARNER", "HISTORY_RESET", "Cleared cluster_history.json learned EMA profiles");
  res.json({ ok: true, profiles: [], plan });
});

app.get("/api/models", (_req: Request, res: Response) => {
  const poolMb = controller.currentPlan?.total_cluster_safe_mb ?? 16384;
  controller.discoveredModels = scanModelsDirectory("models", poolMb);
  res.json({ models: controller.discoveredModels });
});

app.get("/api/nodes", (_req: Request, res: Response) => {
  res.json(Array.from(controller.nodes.values()));
});

app.post("/api/nodes/register", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const ip = typeof b.ip === "string" ? b.ip.trim() : "";
  const rpcPort = Number(b.rpc_port) || 50052;
  const nodeId = typeof b.node_id === "string" && b.node_id.trim() ? b.node_id.trim() : "";
  if (!ip || !nodeId) {
    res.status(400).json({ error: "node_id and ip are required" });
    return;
  }

  // Only allow CONNECTED status if real TCP + 32-byte GGUF v1.0.0 / RPC v9 handshake succeeds
  const probe = await probeTcpHandshake(ip, rpcPort, 500);
  const status = probe.connected ? "CONNECTED" : "OFFLINE";

  const nodeOs = typeof b.os === "string" ? b.os : "linux";
  const ramTotalMb = Number(b.ram_total_mb) || 4096;
  const ramAvailMb = Number(b.ram_avail_mb) || 2048;
  const allowOver50 = controller.config.experimental_fork_enabled && controller.config.allow_android_over_50;
  const computedCap = nodeOs.toLowerCase().includes("android")
    ? computeAndroidSafeCap(ramTotalMb, ramAvailMb, controller.config.android_ram_cap_pct, controller.config.os_reserve_mb, allowOver50)
    : (Number(b.safe_cap_mb) > 0
      ? Number(b.safe_cap_mb)
      : computeDesktopSafeCap(ramAvailMb, controller.config.desktop_ram_cap_pct, controller.config.os_reserve_mb));
  const rawFreeVramMb = Math.max(0, Number(b.vram_total_free_mb) || Number(b.vram_safe_mb) || 0);
  const computedVram = b.vram_total_free_mb !== undefined
    ? computeVramSafeCap(rawFreeVramMb, controller.config.vram_cap_pct)
    : Math.max(0, Number(b.vram_safe_mb) || 0);

  const node: NodeTelemetry = {
    node_id: nodeId,
    is_master: false,
    os: nodeOs,
    silicon: typeof b.silicon === "string" ? b.silicon : "Remote Spoke",
    ip,
    link_type: typeof b.link_type === "string" ? b.link_type : "wifi_lan",
    rpc_port: rpcPort,
    rpc_version: probe.connected ? RPC_VERSION_PIN : 0,
    git_tag: probe.connected ? LLAMA_TAG_PIN : "",
    ram_total_mb: ramTotalMb,
    ram_avail_mb: ramAvailMb,
    safe_cap_mb: computedCap,
    vram_total_free_mb: rawFreeVramMb > 0 ? rawFreeVramMb : undefined,
    vram_safe_mb: computedVram,
    compute_tflops: Number(b.compute_tflops) || 1.0,
    mem_bw_gbps: Number(b.mem_bw_gbps) || 25.0,
    rtt_ms: probe.connected ? probe.rttMs : 999.0,
    p95_rtt_ms: probe.connected ? probe.rttMs : 999.0,
    pkt_loss_pct: probe.connected ? Number(b.pkt_loss_pct) || 0 : 100.0,
    bandwidth_mbps: probe.connected ? Number(b.bandwidth_mbps) || 100 : 0,
    temp_c: Number(b.temp_c) || 40,
    thermal_headroom: Number(b.thermal_headroom) || 0.3,
    vulkan_active: Boolean(b.vulkan_active),
    execution_backend: probe.connected ? (typeof b.execution_backend === "string" ? b.execution_backend : "RPC v9") : "Offline",
    handshake_ok: probe.connected,
    status,
  };

  controller.registerLiveNode(node);
  const plan = controller.updateClusterPlan();
  res.status(probe.connected ? 200 : 502).json({
    ok: probe.connected,
    status,
    handshake_error: probe.error,
    node,
    plan,
  });
});

function clampNum(val: unknown, fallback: number, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

app.post("/api/config", (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (body.model && typeof body.model === "object") {
    controller.ggufMeta = {
      ...controller.ggufMeta,
      model_path: typeof body.model.model_path === "string" ? body.model.model_path : controller.ggufMeta.model_path,
      file_size_mb: Number(body.model.file_size_mb) > 0 ? Number(body.model.file_size_mb) : controller.ggufMeta.file_size_mb,
      is_moe: typeof body.model.is_moe === "boolean" ? body.model.is_moe : controller.ggufMeta.is_moe,
      is_ternary: typeof body.model.is_ternary === "boolean" ? body.model.is_ternary : controller.ggufMeta.is_ternary,
      arch: typeof body.model.arch === "string" ? body.model.arch : controller.ggufMeta.arch,
      quant: typeof body.model.quant === "string" ? body.model.quant : controller.ggufMeta.quant,
    };
  }
  if (body.config && typeof body.config === "object") {
    const c = body.config;
    const prev = controller.config;
    const expEnabled =
      typeof c.experimental_fork_enabled === "boolean"
        ? c.experimental_fork_enabled
        : prev.experimental_fork_enabled;
    const allowOver50 =
      expEnabled &&
      (typeof c.allow_android_over_50 === "boolean"
        ? c.allow_android_over_50
        : prev.allow_android_over_50);
    const kvQuant = c.kv_quant === "q4_0" || c.kv_quant === "f16" ? c.kv_quant : c.kv_quant === "q8_0" ? "q8_0" : prev.kv_quant;

    const roleOverride =
      c.role_override === "master" || c.role_override === "worker"
        ? c.role_override
        : c.role_override === "auto"
        ? "auto"
        : prev.role_override;

    const backendPref: BackendPreference =
      c.backend_preference === "stock" || c.backend_preference === "ik_llama" || c.backend_preference === "tandem"
        ? c.backend_preference
        : c.backend_preference === "auto"
        ? "auto"
        : prev.backend_preference;

    const prevTl = prev.thermal_limits ?? DEFAULT_THERMAL_LIMITS;
    const rawTl = (c.thermal_limits && typeof c.thermal_limits === "object" ? c.thermal_limits : {}) as Partial<ThermalLimits>;
    const sanitizedTl: ThermalLimits = {
      android_warn_c: clampNum(rawTl.android_warn_c, prevTl.android_warn_c, 35, 50),
      android_shed_c: clampNum(rawTl.android_shed_c, prevTl.android_shed_c, 38, 55),
      android_crit_c: clampNum(rawTl.android_crit_c, prevTl.android_crit_c, 40, 60),
      android_warn_headroom: Number(clampNum(rawTl.android_warn_headroom, prevTl.android_warn_headroom, 0.5, 0.96).toFixed(2)),
      android_shed_headroom: Number(clampNum(rawTl.android_shed_headroom, prevTl.android_shed_headroom, 0.6, 0.98).toFixed(2)),
      android_crit_headroom: Number(clampNum(rawTl.android_crit_headroom, prevTl.android_crit_headroom, 0.7, 0.99).toFixed(2)),
      gpu_warn_c: clampNum(rawTl.gpu_warn_c, prevTl.gpu_warn_c, 55, 90),
      gpu_shed_c: clampNum(rawTl.gpu_shed_c, prevTl.gpu_shed_c, 60, 95),
      gpu_crit_c: clampNum(rawTl.gpu_crit_c, prevTl.gpu_crit_c, 65, 100),
      cpu_warn_c: clampNum(rawTl.cpu_warn_c, prevTl.cpu_warn_c, 55, 95),
      cpu_shed_c: clampNum(rawTl.cpu_shed_c, prevTl.cpu_shed_c, 60, 100),
      cpu_crit_c: clampNum(rawTl.cpu_crit_c, prevTl.cpu_crit_c, 65, 105),
      cooldown_hysteresis_c: Number(clampNum(rawTl.cooldown_hysteresis_c, prevTl.cooldown_hysteresis_c, 2, 15).toFixed(1)),
      cooldown_hold_secs: Math.round(clampNum(rawTl.cooldown_hold_secs, prevTl.cooldown_hold_secs, 5, 180)),
    };

    const nextOverrides: Record<string, NodeOverride> = { ...(prev.node_overrides ?? {}) };
    if (c.node_overrides && typeof c.node_overrides === "object") {
      for (const [nid, rawOv] of Object.entries(c.node_overrides as Record<string, NodeOverride>)) {
        if (!nid || typeof rawOv !== "object" || !rawOv) continue;
        nextOverrides[nid] = {
          disabled: Boolean(rawOv.disabled),
          ram_cap_pct: rawOv.ram_cap_pct !== undefined ? clampNum(rawOv.ram_cap_pct, 50, 10, 100) : undefined,
          vram_cap_pct: rawOv.vram_cap_pct !== undefined ? clampNum(rawOv.vram_cap_pct, 90, 10, 100) : undefined,
          threads: rawOv.threads !== undefined ? Math.round(clampNum(rawOv.threads, 4, 1, 256)) : undefined,
          manual_weight: rawOv.manual_weight !== undefined ? Number(clampNum(rawOv.manual_weight, 1.0, 0.1, 10.0).toFixed(2)) : undefined,
          max_cpu_temp_c: rawOv.max_cpu_temp_c !== undefined ? clampNum(rawOv.max_cpu_temp_c, 88, 55, 105) : undefined,
          max_gpu_temp_c: rawOv.max_gpu_temp_c !== undefined ? clampNum(rawOv.max_gpu_temp_c, 87, 55, 100) : undefined,
        };
      }
    }

    controller.config = {
      role_override: roleOverride,
      android_ram_cap_pct: clampNum(
        c.android_ram_cap_pct,
        prev.android_ram_cap_pct,
        10,
        allowOver50 ? 85 : 50
      ),
      desktop_ram_cap_pct: clampNum(c.desktop_ram_cap_pct, prev.desktop_ram_cap_pct, 10, 100),
      vram_cap_pct: clampNum(c.vram_cap_pct, prev.vram_cap_pct, 10, 100),
      os_reserve_mb: Math.round(clampNum(c.os_reserve_mb, prev.os_reserve_mb, 256, 8192)),
      max_p95_rtt_ms: Number(clampNum(c.max_p95_rtt_ms, prev.max_p95_rtt_ms, 1, 250).toFixed(1)),
      max_pkt_loss_pct: Number(clampNum(c.max_pkt_loss_pct, prev.max_pkt_loss_pct, 0, 25).toFixed(1)),
      thermal_threshold: Number(clampNum(c.thermal_threshold, prev.thermal_threshold, 0.5, 0.99).toFixed(2)),
      min_alloc_mb: Math.round(clampNum(c.min_alloc_mb, prev.min_alloc_mb, 64, 4096)),

      ngl: Math.round(clampNum(c.ngl, prev.ngl, 0, 999)),
      ctx_size: Math.round(clampNum(c.ctx_size, prev.ctx_size, 0, 131072)),
      batch_size: Math.round(clampNum(c.batch_size, prev.batch_size, 64, 16384)),
      ubatch_size: Math.round(clampNum(c.ubatch_size, prev.ubatch_size, 32, 8192)),
      threads: Math.round(clampNum(c.threads, prev.threads, 0, 256)),
      rpc_cache_c: typeof c.rpc_cache_c === "boolean" ? c.rpc_cache_c : prev.rpc_cache_c,
      kv_quant: kvQuant,
      flash_attn: typeof c.flash_attn === "boolean" ? c.flash_attn : prev.flash_attn,
      cont_batching: typeof c.cont_batching === "boolean" ? c.cont_batching : prev.cont_batching,
      cache_reuse: Math.round(clampNum(c.cache_reuse, prev.cache_reuse, 0, 4096)),
      parallel_slots: Math.round(clampNum(c.parallel_slots, prev.parallel_slots, 0, 32)),
      mlock: typeof c.mlock === "boolean" ? c.mlock : prev.mlock,
      moe_ot_regex: typeof c.moe_ot_regex === "string" ? c.moe_ot_regex : prev.moe_ot_regex,
      draft_model: typeof c.draft_model === "string" ? c.draft_model : prev.draft_model,
      manual_tensor_split: typeof c.manual_tensor_split === "string" ? c.manual_tensor_split : prev.manual_tensor_split,
      api_key: typeof c.api_key === "string" ? c.api_key : prev.api_key,
      emit_tuning_flags: typeof c.emit_tuning_flags === "boolean" ? c.emit_tuning_flags : prev.emit_tuning_flags,
      temp: Number(clampNum(c.temp, prev.temp, 0, 2).toFixed(2)),
      top_p: Number(clampNum(c.top_p, prev.top_p, 0.01, 1).toFixed(2)),
      top_k: Math.round(clampNum(c.top_k, prev.top_k, 0, 200)),
      min_p: Number(clampNum(c.min_p, prev.min_p, 0, 1).toFixed(2)),
      repeat_penalty: Number(clampNum(c.repeat_penalty, prev.repeat_penalty, 0.8, 2).toFixed(2)),
      seed: Math.round(clampNum(c.seed, prev.seed, -1, 2147483647)),

      experimental_fork_enabled: expEnabled,
      allow_android_over_50: allowOver50,
      async_rpc: expEnabled && (typeof c.async_rpc === "boolean" ? c.async_rpc : prev.async_rpc),
      fp8_wire_compress: expEnabled && (typeof c.fp8_wire_compress === "boolean" ? c.fp8_wire_compress : prev.fp8_wire_compress),
      ternary_mode: typeof c.ternary_mode === "boolean" ? c.ternary_mode : prev.ternary_mode,
      backend_preference: backendPref,
      thermal_limits: sanitizedTl,
      node_overrides: nextOverrides,
    };
  }

  // Re-evaluate local master host safe_cap_mb & vram_safe_mb immediately under updated RAM/VRAM settings
  controller.registerLiveNode(controller.localAgent.getTelemetry(controller.config));
  const plan = controller.updateClusterPlan();
  logEvent("INFO", controller.masterId, "CONFIG", "PLAN_UPDATED", `Updated live model/tuning config (${controller.ggufMeta.model_path})`, {
    tier: plan.cluster_tier,
    desktop_cap: `${controller.config.desktop_ram_cap_pct}%`,
    vram_cap: `${controller.config.vram_cap_pct}%`,
    android_cap: `${controller.config.android_ram_cap_pct}%`,
    kv: controller.config.kv_quant,
    tuning_flags: controller.config.emit_tuning_flags,
    mmap_stream: plan.mmap_stream,
  });
  res.json({ ok: true, plan, config: controller.config, model: controller.ggufMeta });
});

app.post("/api/discover", async (_req: Request, res: Response) => {
  const result = await controller.discoverAndProbe();
  res.json({ ok: true, ...result });
});

app.post("/api/launch", (_req: Request, res: Response) => {
  const plan = controller.updateClusterPlan();
  const started = controller.startLlamaServer();
  res.json({
    ok: true,
    llama_running: started,
    command: plan.command_preview,
    message: started
      ? "llama-server v1.0.0 launched"
      : "Prepared verified llama-server v1.0.0 launch command (llama-server offline on port 8080)",
  });
});

app.post("/api/virtual-test", (_req: Request, res: Response) => {
  const result = controller.runVirtual4NodeTest();
  res.json({ ok: true, ...result });
});

app.post("/api/reset", (_req: Request, res: Response) => {
  const plan = controller.resetLiveToLocal();
  res.json({ ok: true, plan });
});

app.get("/api/clusterd-files", (_req: Request, res: Response) => {
  const files: Array<{ path: string; language: string; content: string }> = [];
  const relPaths: Array<[string, string]> = [
    ["clusterd/Cargo.toml", "toml"],
    ["clusterd/src/main.rs", "rust"],
    ["clusterd/src/strength_profiler.rs", "rust"],
    ["clusterd/src/thermal_balancer.rs", "rust"],
    ["clusterd/src/learner.rs", "rust"],
    ["clusterd/src/tier_planner.rs", "rust"],
    ["clusterd/src/backend.rs", "rust"],
    ["clusterd/src/topology.rs", "rust"],
    ["clusterd/src/speculation.rs", "rust"],
    ["clusterd/src/ngram_drafter.rs", "rust"],
    ["clusterd/src/serving.rs", "rust"],
    ["clusterd/src/adb_tunnel.rs", "rust"],
    ["clusterd/src/hw_probe.rs", "rust"],
    ["clusterd/src/net_probe.rs", "rust"],
    ["clusterd/src/worker.rs", "rust"],
    ["clusterd/src/web_ui.rs", "rust"],
    ["clusterd/scripts/build_android_ndk28.sh", "bash"],
    ["clusterd/.github/workflows/native-matrix-ci.yml", "yaml"],
    ["clusterd/android-apk/app/src/main/java/com/cluster/node/RpcService.kt", "kotlin"],
  ];

  for (const [rel, language] of relPaths) {
    const abs = path.join(__dirname, rel);
    if (fs.existsSync(abs)) {
      files.push({ path: rel, language, content: fs.readFileSync(abs, "utf-8") });
    }
  }
  res.json({ files });
});

app.get("/api/logs", (_req: Request, res: Response) => {
  let lines: string[] = [];
  if (fs.existsSync(LOG_FILE)) {
    try {
      lines = fs.readFileSync(LOG_FILE, "utf-8").split(/\r?\n/).filter(Boolean).slice(-45);
    } catch {
      lines = logBuffer.slice(-45);
    }
  } else {
    lines = logBuffer.slice(-45);
  }
  res.type("text/plain; charset=utf-8").send(lines.join("\n"));
});

/**
 * Strictly proxies /v1/chat/completions to real llama-server on port 8080.
 * Applies Radix Prefix slot routing + Prompt Lookup N-gram drafting metadata.
 * Never fabricates hardcoded LLM responses; returns HTTP 503 if unreachable.
 */
app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  // Detect container reverse-proxy loop (e.g., nginx on :8080 forwarding back to :3000)
  if (req.headers["x-clusterd-hop"]) {
    res.status(503).json({ error: "llama-server offline on port 8080" });
    return;
  }

  const bodyText = JSON.stringify(req.body ?? {});
  const route = controller.radixRouter.routeSlot(bodyText);
  const ngramDraft = proposeNgramDraft(bodyText, 6);
  if (ngramDraft) {
    logEvent("INFO", controller.masterId, "NGRAM", "DRAFT_HIT", `Proposed N-gram draft (${ngramDraft.length} tokens) on slot ${route.slotId}`);
  }

  const startedAt = performance.now();
  const isStream = Boolean(req.body?.stream);
  try {
    const upstream = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clusterd-hop": "1",
      },
      body: bodyText,
      signal: AbortSignal.timeout(1500),
    });

    const ct = (upstream.headers.get("content-type") || "").toLowerCase();
    // Reject container nginx/ingress HTML or 5xx/404 responses when real llama-server is not running on 8080
    if (upstream.status === 503 || upstream.status === 502 || upstream.status === 404 || ct.includes("text/html")) {
      res.status(503).json({ error: "llama-server offline on port 8080" });
      return;
    }

    if (isStream && upstream.body) {
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    const rawText = await upstream.text();
    const elapsedS = Math.max(0.05, (performance.now() - startedAt) / 1000);
    try {
      const parsed = JSON.parse(rawText);
      const predictedN = Number(parsed?.timings?.predicted_n ?? parsed?.usage?.completion_tokens ?? 0);
      const predictedPerSec = Number(parsed?.timings?.predicted_per_second ?? (predictedN / elapsedS));
      if (predictedN >= 1 && Number.isFinite(predictedPerSec)) {
        controller.clusterTokS = Math.round(predictedPerSec * 100) / 100;
        if (predictedN >= 50) {
          for (const act of controller.currentPlan.active_nodes) {
            const allocGb = Math.max(0.25, (act.alloc_mb ?? 512) / 1024);
            const obsTokGb = (controller.clusterTokS * ((act.compute_share_pct ?? 100) / 100)) / allocGb;
            const throttled = act.thermal_state === "SHED_25" || act.thermal_state === "EMERGENCY_OFFLOAD" || act.thermal_state === "WARN";
            controller.learner.recordCompletedSession({
              nodeId: act.node_id,
              silicon: act.silicon,
              modelArch: controller.ggufMeta.arch,
              quantType: controller.ggufMeta.quant,
              linkType: act.link_type,
              tokensGenerated: predictedN,
              observedPerformanceScore: scoreNode(act) * Math.min(1.5, Math.max(0.4, controller.clusterTokS / 18.0)),
              observedTokSPerGb: obsTokGb,
              thermalRiseCPerMin: throttled ? 4.2 : 0.8,
              maxSafeSlope: 6.0,
              speculativeAlpha: 0.78,
              hitThermalWarnOrThrottle: throttled,
            });
          }
          controller.updateClusterPlan();
        }
      }
      res.status(upstream.status).json(parsed);
    } catch {
      res.status(upstream.status).type("text/plain").send(rawText);
    }
  } catch {
    res.status(503).json({ error: "llama-server offline on port 8080" });
  }
});

app.listen(PORT, () => {
  logEvent(
    "INFO",
    controller.masterId,
    "HTTP",
    "SERVER_STARTED",
    `clusterd live web dashboard & proxy listening on port ${PORT}`
  );
});
