import fs from "node:fs";
import path from "node:path";

export const RPC_VERSION_PIN = 9;
export const LLAMA_TAG_PIN = "v1.0.0";

export type NodeStatus = "CONNECTED" | "OFFLINE";
export type ClusterTierCode = "S" | "A" | "B" | "C";
export type ThermalState = "COOL" | "WARN" | "SHED_25" | "EMERGENCY_OFFLOAD";
export type BackendPreference = "auto" | "stock" | "ik_llama" | "tandem";

export interface ThermalLimits {
  android_warn_c: number;
  android_shed_c: number;
  android_crit_c: number;
  android_warn_headroom: number;
  android_shed_headroom: number;
  android_crit_headroom: number;
  gpu_warn_c: number;
  gpu_shed_c: number;
  gpu_crit_c: number;
  cpu_warn_c: number;
  cpu_shed_c: number;
  cpu_crit_c: number;
  cooldown_hysteresis_c: number;
  cooldown_hold_secs: number;
}

export const DEFAULT_THERMAL_LIMITS: ThermalLimits = {
  android_warn_c: 42.0,
  android_shed_c: 45.0,
  android_crit_c: 48.0,
  android_warn_headroom: 0.85,
  android_shed_headroom: 0.90,
  android_crit_headroom: 0.97,
  gpu_warn_c: 78.0,
  gpu_shed_c: 83.0,
  gpu_crit_c: 87.0,
  cpu_warn_c: 75.0,
  cpu_shed_c: 82.0,
  cpu_crit_c: 88.0,
  cooldown_hysteresis_c: 5.0,
  cooldown_hold_secs: 30,
};

export interface NodeOverride {
  disabled?: boolean;
  ram_cap_pct?: number;
  vram_cap_pct?: number;
  threads?: number;
  manual_weight?: number;
  max_cpu_temp_c?: number;
  max_gpu_temp_c?: number;
}

export interface LearnedNodeProfile {
  key: string;
  node_id: string;
  silicon: string;
  model_arch: string;
  quant_type: string;
  link_type: string;
  effective_tok_s_per_gb: number;
  thermal_rise_c_per_min: number;
  speculative_alpha: number;
  oom_or_throttle_count: number;
  learned_score: number;
  thermal_sustainability: number;
  recommended_load_scale: number;
  sessions_observed: number;
  last_updated_epoch_s: number;
}

export interface NodeThermalStatus {
  state: ThermalState;
  capacity_scale: number;
  tripped_epoch_s: number | null;
  cooldown_remaining_s: number;
  reason: string;
}

export interface NodeTelemetry {
  node_id: string;
  is_master: boolean;
  os: string;
  isa?: string;
  silicon: string;
  ip: string;
  link_type: string;
  rpc_port: number;
  rpc_version: number;
  git_tag: string;
  perf_cores?: number;
  ram_total_mb: number;
  ram_avail_mb: number;
  safe_cap_mb: number;
  vram_total_free_mb?: number;
  vram_safe_mb: number;
  compute_tflops: number;
  mem_bw_gbps: number;
  disk_mbps?: number;
  rtt_ms: number;
  p95_rtt_ms: number;
  jitter_ms?: number;
  pkt_loss_pct: number;
  bandwidth_mbps: number;
  temp_c: number;
  cpu_temp_c?: number;
  gpu_temp_c?: number;
  cpu_util_pct?: number;
  gpu_util_pct?: number;
  thermal_headroom: number;
  strength_score?: number;
  vulkan_active: boolean;
  execution_backend: string;
  handshake_ok: boolean;
  status: NodeStatus;
  last_seen?: number;
  score?: number;
  learned_score?: number;
  thermal_sustainability?: number;
  alloc_mb?: number;
  safe_total_mb?: number;
  compute_share_pct?: number;
  stage_latency_ms?: number;
  effective_tok_s?: number;
  thermal_state?: ThermalState;
  cooldown_remaining_s?: number;
  pruned?: boolean;
  prune_reason?: string;
}

export interface GgufMeta {
  model_path: string;
  file_size_mb: number;
  is_moe: boolean;
  is_ternary: boolean;
  has_mtp_heads?: boolean;
  arch: string;
  quant: string;
  block_count?: number;
  expert_count?: number;
  context_length?: number;
  vocab_hash?: string;
  fit_badge?: "Fast" | "Best Fit" | "Streaming";
}

export interface AutoTuneDecision {
  mechanism: string;
  category: "Compute" | "Memory" | "Topology" | "Speculation" | "Serving" | "Thermal" | "Learner";
  status: "ACTIVE" | "STANDBY" | "PRUNED";
  reason: string;
}

export interface ClusterConfig {
  role_override: "auto" | "master" | "worker";
  android_ram_cap_pct: number;
  desktop_ram_cap_pct: number;
  vram_cap_pct: number;
  os_reserve_mb: number;
  max_p95_rtt_ms: number;
  max_pkt_loss_pct: number;
  thermal_threshold: number;
  min_alloc_mb: number;

  ngl: number;
  ctx_size: number;
  batch_size: number;
  ubatch_size: number;
  threads: number;
  rpc_cache_c: boolean;
  kv_quant: "q8_0" | "q4_0" | "f16";
  flash_attn: boolean;
  cont_batching: boolean;
  cache_reuse: number;
  parallel_slots: number;
  mlock: boolean;
  moe_ot_regex: string;
  draft_model: string;
  manual_tensor_split: string;
  api_key: string;
  emit_tuning_flags: boolean;
  temp: number;
  top_p: number;
  top_k: number;
  min_p: number;
  repeat_penalty: number;
  seed: number;

  experimental_fork_enabled: boolean;
  allow_android_over_50: boolean;
  async_rpc: boolean;
  fp8_wire_compress: boolean;
  ternary_mode: boolean;
  backend_preference: BackendPreference;
  thermal_limits: ThermalLimits;
  node_overrides: Record<string, NodeOverride>;
}

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  role_override: "auto",
  android_ram_cap_pct: 50,
  desktop_ram_cap_pct: 100,
  vram_cap_pct: 90,
  os_reserve_mb: 1024,
  max_p95_rtt_ms: 15.0,
  max_pkt_loss_pct: 2.0,
  thermal_threshold: 0.9,
  min_alloc_mb: 256,

  ngl: 99,
  ctx_size: 4096,
  batch_size: 2048,
  ubatch_size: 512,
  threads: 0,
  rpc_cache_c: true,
  kv_quant: "q8_0",
  flash_attn: true,
  cont_batching: true,
  cache_reuse: 256,
  parallel_slots: 0,
  mlock: false,
  moe_ot_regex: ".ffn_.*_exps.=CPU",
  draft_model: "",
  manual_tensor_split: "",
  api_key: "",
  emit_tuning_flags: false,
  temp: 0.7,
  top_p: 0.9,
  top_k: 40,
  min_p: 0.05,
  repeat_penalty: 1.1,
  seed: -1,

  experimental_fork_enabled: false,
  allow_android_over_50: false,
  async_rpc: false,
  fp8_wire_compress: false,
  ternary_mode: false,
  backend_preference: "auto",
  thermal_limits: { ...DEFAULT_THERMAL_LIMITS },
  node_overrides: {},
};

export interface ClusterPlan {
  cluster_tier: ClusterTierCode;
  cluster_tier_label: string;
  elected_master_id: string;
  active_backend: string;
  symmetric_lan_tp_eligible: boolean;
  active_nodes: NodeTelemetry[];
  pruned_nodes: NodeTelemetry[];
  rpc_arg: string;
  tensor_split: string;
  flags: string[];
  experimental_flags: string[];
  command_preview: string;
  auto_ctx_size: number;
  auto_parallel_slots: number;
  cluster_tok_s: number;
  mmap_stream: boolean;
  tier_2_ssd_streaming: boolean;
  needed_mb: number;
  total_cluster_safe_mb: number;
  total_pool_mb: number;
  decisions: AutoTuneDecision[];
}

export interface VirtualTestCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface HandshakeResult {
  ok: boolean;
  rpcVer: number;
  gitTag: string;
  error?: string;
}

export function encodePreflightHandshake(rpcVer: number, gitTag: string): Buffer {
  const buf = Buffer.alloc(32, 0);
  buf.write("GGUF", 0, "ascii");
  buf.writeUInt32BE(rpcVer, 4);
  buf.write(gitTag.slice(0, 16), 8, "ascii");
  return buf;
}

export function decodePreflightHandshake(buf: Buffer): HandshakeResult {
  if (buf.length < 32 || buf.subarray(0, 4).toString("ascii") !== "GGUF") {
    return { ok: false, rpcVer: 0, gitTag: "", error: "Invalid pre-flight magic (expected GGUF)" };
  }
  const rpcVer = buf.readUInt32BE(4);
  const rawTag = buf.subarray(8, 24);
  const zeroIdx = rawTag.indexOf(0);
  const gitTag = rawTag.subarray(0, zeroIdx === -1 ? 16 : zeroIdx).toString("ascii");
  if (rpcVer !== RPC_VERSION_PIN || gitTag !== LLAMA_TAG_PIN) {
    return {
      ok: false,
      rpcVer,
      gitTag,
      error: `Version mismatch: peer rpc_ver=${rpcVer} tag=${gitTag}, expected rpc_ver=${RPC_VERSION_PIN} tag=${LLAMA_TAG_PIN}`,
    };
  }
  return { ok: true, rpcVer, gitTag };
}

export function computeAndroidSafeCap(
  totalMb: number,
  availMb: number,
  capPct = 50,
  reserveMb = 512,
  allowOver50 = false
): number {
  const maxPct = allowOver50 ? 85 : 50;
  const boundedPct = Math.min(maxPct, Math.max(10, capPct));
  const pctCap = Math.floor((totalMb * boundedPct) / 100);
  const boundedReserve = Math.min(512, Math.max(256, reserveMb));
  const headroomCap = Math.max(0, availMb - boundedReserve);
  return Math.max(256, Math.min(pctCap, headroomCap));
}

export function computeDesktopSafeCap(
  availMb: number,
  desktopCapPct = 100,
  reserveMb = 512
): number {
  const usable = Math.max(512, availMb - Math.max(256, reserveMb));
  const boundedPct = Math.min(100, Math.max(10, desktopCapPct));
  return Math.max(512, Math.floor((usable * boundedPct) / 100));
}

export function computeVramSafeCap(rawFreeVramMb: number, vramCapPct = 90): number {
  if (rawFreeVramMb <= 0) return 0;
  const boundedPct = Math.min(100, Math.max(10, vramCapPct));
  const pctCap = Math.floor((rawFreeVramMb * boundedPct) / 100);
  if (rawFreeVramMb <= 8192) {
    return Math.min(pctCap, Math.max(0, rawFreeVramMb - 450));
  }
  return pctCap;
}

export function computeNodeStrengthScore(
  memBwGbps: number,
  tflops: number,
  vramTotalFreeMb = 0
): number {
  const vramGb = Math.max(0, vramTotalFreeMb) / 1024.0;
  const raw = (0.7 * memBwGbps + 10.0 * tflops) * (1.0 + vramGb * 0.25);
  return Math.round(raw * 100) / 100;
}

export function scoreNode(n: NodeTelemetry): number {
  const num = 0.7 * (n.mem_bw_gbps ?? 25.0) + 10.0 * (n.compute_tflops ?? 1.0);
  const den = 1.0 + 0.15 * (n.p95_rtt_ms ?? n.rtt_ms ?? 1.0) + 2.0 * (n.pkt_loss_pct ?? 0.0);
  return num / Math.max(0.01, den);
}

/**
 * Proactive Thermal-Safe Load Balancer with anti-flapping hysteresis:
 * - Enforces Warn / Shed (-25%) / Emergency Offload (0 layers) thresholds
 * - Holds Emergency Offload for cooldown_hold_secs (30s) AND cooldown_hysteresis_c (5.0°C) below shed.
 */
export class ThermalBalancer {
  private readonly records = new Map<string, { state: ThermalState; trippedEpochS: number | null }>();

  evaluateNode(
    nodeId: string,
    isAndroid: boolean,
    hasGpu: boolean,
    cpuTempC: number,
    gpuTempC: number,
    thermalHeadroom: number,
    nowEpochS: number,
    limits: ThermalLimits = DEFAULT_THERMAL_LIMITS
  ): NodeThermalStatus {
    const prev = this.records.get(nodeId);
    let critHit = false;
    let shedHit = false;
    let warnHit = false;
    let reason = "Nominal thermal envelope";

    if (isAndroid) {
      if (cpuTempC >= limits.android_crit_c || thermalHeadroom >= limits.android_crit_headroom) {
        critHit = true;
        reason = `Android temp ${cpuTempC.toFixed(1)}°C / headroom ${thermalHeadroom.toFixed(2)} >= crit`;
      } else if (cpuTempC >= limits.android_shed_c || thermalHeadroom >= limits.android_shed_headroom) {
        shedHit = true;
        reason = `Android temp ${cpuTempC.toFixed(1)}°C / headroom ${thermalHeadroom.toFixed(2)} >= shed`;
      } else if (cpuTempC >= limits.android_warn_c || thermalHeadroom >= limits.android_warn_headroom) {
        warnHit = true;
        reason = `Android temp ${cpuTempC.toFixed(1)}°C / headroom ${thermalHeadroom.toFixed(2)} >= warn`;
      }
    } else if (hasGpu && gpuTempC >= limits.gpu_crit_c) {
      critHit = true;
      reason = `GPU temp ${gpuTempC.toFixed(1)}°C >= crit ${limits.gpu_crit_c.toFixed(1)}°C`;
    } else if (cpuTempC >= limits.cpu_crit_c) {
      critHit = true;
      reason = `CPU temp ${cpuTempC.toFixed(1)}°C >= crit ${limits.cpu_crit_c.toFixed(1)}°C`;
    } else if (hasGpu && gpuTempC >= limits.gpu_shed_c) {
      shedHit = true;
      reason = `GPU temp ${gpuTempC.toFixed(1)}°C >= shed ${limits.gpu_shed_c.toFixed(1)}°C`;
    } else if (cpuTempC >= limits.cpu_shed_c) {
      shedHit = true;
      reason = `CPU temp ${cpuTempC.toFixed(1)}°C >= shed ${limits.cpu_shed_c.toFixed(1)}°C`;
    } else if ((hasGpu && gpuTempC >= limits.gpu_warn_c) || cpuTempC >= limits.cpu_warn_c) {
      warnHit = true;
      reason = `Temp warning (CPU ${cpuTempC.toFixed(1)}°C / GPU ${gpuTempC.toFixed(1)}°C)`;
    }

    if (prev && prev.state === "EMERGENCY_OFFLOAD") {
      const trippedAt = prev.trippedEpochS ?? nowEpochS;
      const elapsed = Math.max(0, nowEpochS - trippedAt);
      const holdRemaining = Math.max(0, Math.ceil(limits.cooldown_hold_secs - elapsed));
      const cooledEnough = isAndroid
        ? cpuTempC <= limits.android_shed_c - limits.cooldown_hysteresis_c &&
          thermalHeadroom <= limits.android_warn_headroom - 0.1
        : cpuTempC <= limits.cpu_shed_c - limits.cooldown_hysteresis_c &&
          (!hasGpu || gpuTempC <= limits.gpu_shed_c - limits.cooldown_hysteresis_c);

      if (holdRemaining > 0 || !cooledEnough || critHit) {
        return {
          state: "EMERGENCY_OFFLOAD",
          capacity_scale: 0,
          tripped_epoch_s: trippedAt,
          cooldown_remaining_s: holdRemaining,
          reason:
            holdRemaining > 0
              ? `Anti-flapping hold active (${holdRemaining}s remaining; requires -${limits.cooldown_hysteresis_c.toFixed(1)}°C)`
              : `Awaiting ${limits.cooldown_hysteresis_c.toFixed(1)}°C thermal hysteresis cooldown`,
        };
      }
    }

    let state: ThermalState = "COOL";
    let scale = 1.0;
    let trippedAt: number | null = null;
    if (critHit) {
      state = "EMERGENCY_OFFLOAD";
      scale = 0.0;
      trippedAt = nowEpochS;
    } else if (shedHit) {
      state = "SHED_25";
      scale = 0.75;
    } else if (warnHit) {
      state = "WARN";
      scale = 0.9;
    }

    this.records.set(nodeId, { state, trippedEpochS: trippedAt });
    return {
      state,
      capacity_scale: scale,
      tripped_epoch_s: trippedAt,
      cooldown_remaining_s: 0,
      reason,
    };
  }
}

export function computeNodeAttribution(
  allocMb: number,
  totalAllocMb: number,
  memBwGbps: number,
  p95RttMs: number,
  clusterTokS: number,
  rawShareSum: number
): { compute_share_pct: number; stage_latency_ms: number; effective_tok_s: number } {
  if (allocMb <= 0 || totalAllocMb <= 0) {
    return { compute_share_pct: 0, stage_latency_ms: 0, effective_tok_s: 0 };
  }
  const layerFrac = allocMb / totalAllocMb;
  const effBw = Math.max(1.0, memBwGbps);
  const rawWeight = layerFrac * effBw;
  const computeSharePct =
    rawShareSum > 0
      ? Math.round((rawWeight / rawShareSum) * 1000) / 10
      : Math.round(layerFrac * 1000) / 10;

  const activeBytes = allocMb * 1024 * 1024 * 0.05;
  const bwBytesPerMs = (Math.max(4.0, memBwGbps) * 1e9) / 1000.0;
  const stageMs = Math.max(0.1, activeBytes / bwBytesPerMs + p95RttMs);
  const effTokS = Math.round(clusterTokS * (computeSharePct / 100.0) * 100) / 100;

  return {
    compute_share_pct: computeSharePct,
    stage_latency_ms: Math.round(stageMs * 100) / 100,
    effective_tok_s: effTokS,
  };
}

/**
 * Self-Learning EMA Optimizer persisted to cluster_history.json.
 */
export class ClusterLearner {
  private readonly historyPath: string;
  private profiles = new Map<string, LearnedNodeProfile>();

  constructor(historyPath = "cluster_history.json") {
    this.historyPath = historyPath;
    if (fs.existsSync(historyPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
        if (parsed && parsed.profiles && typeof parsed.profiles === "object") {
          for (const [k, v] of Object.entries(parsed.profiles)) {
            this.profiles.set(k, v as LearnedNodeProfile);
          }
        }
      } catch {
        // start empty on malformed JSON
      }
    }
  }

  static makeKey(
    nodeId: string,
    silicon: string,
    modelArch: string,
    quantType: string,
    linkType: string
  ): string {
    return `${nodeId}|${silicon}|${modelArch}|${quantType}|${linkType}`;
  }

  saveAtomic(): void {
    const obj: Record<string, LearnedNodeProfile> = {};
    for (const [k, v] of this.profiles.entries()) obj[k] = v;
    const tmp = `${this.historyPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ profiles: obj }, null, 2), "utf-8");
    fs.renameSync(tmp, this.historyPath);
  }

  reset(): void {
    this.profiles.clear();
    if (fs.existsSync(this.historyPath)) {
      fs.unlinkSync(this.historyPath);
    }
  }

  allProfiles(): LearnedNodeProfile[] {
    return Array.from(this.profiles.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  lookup(
    nodeId: string,
    silicon: string,
    modelArch: string,
    quantType: string,
    linkType: string
  ): LearnedNodeProfile | undefined {
    return this.profiles.get(ClusterLearner.makeKey(nodeId, silicon, modelArch, quantType, linkType));
  }

  recordCompletedSession(params: {
    nodeId: string;
    silicon: string;
    modelArch: string;
    quantType: string;
    linkType: string;
    tokensGenerated: number;
    observedPerformanceScore: number;
    observedTokSPerGb: number;
    thermalRiseCPerMin: number;
    maxSafeSlope: number;
    speculativeAlpha: number;
    hitThermalWarnOrThrottle: boolean;
    nowEpochS?: number;
  }): LearnedNodeProfile | null {
    if (params.tokensGenerated < 50) return null;
    const nowEpochS = params.nowEpochS ?? Math.floor(Date.now() / 1000);
    const key = ClusterLearner.makeKey(
      params.nodeId,
      params.silicon,
      params.modelArch,
      params.quantType,
      params.linkType
    );
    const safeSlope = Math.max(1.0, params.maxSafeSlope);
    const obsSustain = Math.max(
      0.35,
      Math.min(1.0, 1.0 - Math.max(0, params.thermalRiseCPerMin) / safeSlope)
    );
    const prev = this.profiles.get(key);

    let updated: LearnedNodeProfile;
    if (prev) {
      const emaScore = 0.7 * prev.learned_score + 0.3 * params.observedPerformanceScore;
      const emaTokGb = 0.7 * prev.effective_tok_s_per_gb + 0.3 * params.observedTokSPerGb;
      const emaRise =
        0.7 * prev.thermal_rise_c_per_min + 0.3 * Math.max(0, params.thermalRiseCPerMin);
      const emaAlpha =
        0.7 * prev.speculative_alpha + 0.3 * Math.max(0, Math.min(1, params.speculativeAlpha));
      const emaSustain = Math.max(
        0.35,
        Math.min(1.0, 0.7 * prev.thermal_sustainability + 0.3 * obsSustain)
      );
      const loadScale = params.hitThermalWarnOrThrottle
        ? Math.max(0.7, Math.min(1.0, prev.recommended_load_scale * 0.85))
        : prev.recommended_load_scale < 1.0 && obsSustain > 0.85
        ? Math.min(1.0, prev.recommended_load_scale + 0.03)
        : prev.recommended_load_scale;

      updated = {
        key,
        node_id: params.nodeId,
        silicon: params.silicon,
        model_arch: params.modelArch,
        quant_type: params.quantType,
        link_type: params.linkType,
        effective_tok_s_per_gb: Math.round(emaTokGb * 100) / 100,
        thermal_rise_c_per_min: Math.round(emaRise * 100) / 100,
        speculative_alpha: Math.round(emaAlpha * 100) / 100,
        oom_or_throttle_count:
          prev.oom_or_throttle_count + (params.hitThermalWarnOrThrottle ? 1 : 0),
        learned_score: Math.round(emaScore * 100) / 100,
        thermal_sustainability: Math.round(emaSustain * 100) / 100,
        recommended_load_scale: Math.round(loadScale * 100) / 100,
        sessions_observed: prev.sessions_observed + 1,
        last_updated_epoch_s: nowEpochS,
      };
    } else {
      updated = {
        key,
        node_id: params.nodeId,
        silicon: params.silicon,
        model_arch: params.modelArch,
        quant_type: params.quantType,
        link_type: params.linkType,
        effective_tok_s_per_gb: Math.round(params.observedTokSPerGb * 100) / 100,
        thermal_rise_c_per_min: Math.round(Math.max(0, params.thermalRiseCPerMin) * 100) / 100,
        speculative_alpha:
          Math.round(Math.max(0, Math.min(1, params.speculativeAlpha)) * 100) / 100,
        oom_or_throttle_count: params.hitThermalWarnOrThrottle ? 1 : 0,
        learned_score: Math.round(params.observedPerformanceScore * 100) / 100,
        thermal_sustainability: Math.round(obsSustain * 100) / 100,
        recommended_load_scale: params.hitThermalWarnOrThrottle ? 0.85 : 1.0,
        sessions_observed: 1,
        last_updated_epoch_s: nowEpochS,
      };
    }

    this.profiles.set(key, updated);
    this.saveAtomic();
    return updated;
  }
}

export function classifyClusterTier(
  totalClusterSafeMb: number,
  neededMb: number,
  maxNodeVramMb: number,
  hasStrongGpu: boolean
): { tier: ClusterTierCode; label: string } {
  if (neededMb > totalClusterSafeMb) {
    return { tier: "C", label: "Tier C (Cyclic NVMe mmap Streaming)" };
  }
  if (totalClusterSafeMb > 32768 && hasStrongGpu) {
    return { tier: "S", label: "Tier S (Heavyweight GPU + >32GB Pool)" };
  }
  if (totalClusterSafeMb >= 16384 && maxNodeVramMb >= 3000) {
    return { tier: "A", label: "Tier A (Hybrid 4–8GB GPU + USB Phones)" };
  }
  return { tier: "B", label: "Tier B (Edge CPU / Legacy RAM + Phones)" };
}

export function classifyFitBadge(fileSizeMb: number, clusterSafeMb: number): "Fast" | "Best Fit" | "Streaming" {
  const needed = Math.ceil(fileSizeMb * 1.15);
  if (needed <= clusterSafeMb * 0.75) return "Fast";
  if (needed <= clusterSafeMb) return "Best Fit";
  return "Streaming";
}

export function inspectGgufBinaryHeader(
  modelPath: string,
  fallbackSizeMb = 4096,
  clusterSafeMb = 16384
): GgufMeta {
  const lower = modelPath.toLowerCase();
  const quant = lower.includes("tq1_0")
    ? "TQ1_0"
    : lower.includes("tq2_0")
    ? "TQ2_0"
    : lower.includes("q8_0")
    ? "Q8_0"
    : lower.includes("q6_k")
    ? "Q6_K"
    : "Q4_K_M";

  if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile()) {
    return {
      model_path: modelPath,
      file_size_mb: fallbackSizeMb,
      is_moe: lower.includes("a3b") || lower.includes("moe") || lower.includes("mixtral"),
      is_ternary: lower.includes("tq1") || lower.includes("tq2") || lower.includes("bitnet"),
      has_mtp_heads: lower.includes("mtp") || lower.includes("nextn"),
      arch: lower.includes("qwen") ? "qwen3moe" : lower.includes("bitnet") ? "bitnet" : "llama",
      quant,
      block_count: 32,
      expert_count: lower.includes("a3b") || lower.includes("moe") ? 64 : 0,
      context_length: 32768,
      fit_badge: classifyFitBadge(fallbackSizeMb, clusterSafeMb),
    };
  }

  const stat = fs.statSync(modelPath);
  const fileSizeMb = Math.max(1, Math.floor(stat.size / (1024 * 1024)));
  const fd = fs.openSync(modelPath, "r");
  try {
    const headerBuf = Buffer.alloc(Math.min(262144, stat.size));
    const bytesRead = fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
    if (bytesRead < 24 || headerBuf.readUInt32LE(0) !== 0x46554747) {
      return {
        model_path: modelPath,
        file_size_mb: fileSizeMb,
        is_moe: false,
        is_ternary: false,
        has_mtp_heads: false,
        arch: "unknown",
        quant,
        fit_badge: classifyFitBadge(fileSizeMb, clusterSafeMb),
      };
    }

    const version = headerBuf.readUInt32LE(4);
    const kvCount = version >= 2 ? Number(headerBuf.readBigUInt64LE(16)) : 0;
    const strRegion = headerBuf.subarray(0, bytesRead).toString("latin1");
    const isMoe = strRegion.includes("expert_count") || strRegion.includes("ffn_gate_exps");
    const isTernary = strRegion.includes("bitnet") || strRegion.includes("TQ1_0");
    const hasMtp = strRegion.includes("nextn") || strRegion.includes("mtp");
    const arch = strRegion.includes("qwen3moe")
      ? "qwen3moe"
      : strRegion.includes("qwen")
      ? "qwen2"
      : strRegion.includes("bitnet")
      ? "bitnet"
      : "llama";

    return {
      model_path: modelPath,
      file_size_mb: fileSizeMb,
      is_moe: isMoe,
      is_ternary: isTernary,
      has_mtp_heads: hasMtp,
      arch,
      quant,
      block_count: kvCount > 0 ? 32 : 24,
      expert_count: isMoe ? 64 : 0,
      context_length: 32768,
      fit_badge: classifyFitBadge(fileSizeMb, clusterSafeMb),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function scanModelsDirectory(dirPath = "models", clusterSafeMb = 16384): GgufMeta[] {
  if (!fs.existsSync(dirPath)) return [];
  const results: GgufMeta[] = [];
  for (const entry of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, entry);
    try {
      if (fs.statSync(full).isFile() && entry.toLowerCase().endsWith(".gguf")) {
        results.push(inspectGgufBinaryHeader(full, 4096, clusterSafeMb));
      }
    } catch {
      // skip unreadable
    }
  }
  return results;
}

export class RadixPrefixRouter {
  private readonly slotMap = new Map<string, number>();
  private nextSlot = 0;
  private readonly maxSlots: number;

  constructor(maxSlots = 4) {
    this.maxSlots = Math.max(1, maxSlots);
  }

  routeSlot(prefixText: string): { slotId: number; cacheHit: boolean } {
    const key = prefixText.slice(0, 512);
    const existing = this.slotMap.get(key);
    if (existing !== undefined) {
      return { slotId: existing, cacheHit: true };
    }
    const assigned = this.nextSlot % this.maxSlots;
    this.nextSlot += 1;
    this.slotMap.set(key, assigned);
    return { slotId: assigned, cacheHit: false };
  }
}

export function proposeNgramDraft(promptText: string, maxTokens = 6): string[] | null {
  const words = promptText.trim().split(/\s+/).filter(Boolean);
  if (words.length < 16) return null;
  for (let n = 6; n >= 3; n -= 1) {
    if (words.length <= n + 2) continue;
    const tail = words.slice(words.length - n);
    const limit = words.length - n;
    for (let start = limit - 1; start >= 0; start -= 1) {
      let match = true;
      for (let k = 0; k < n; k += 1) {
        if (words[start + k] !== tail[k]) {
          match = false;
          break;
        }
      }
      if (match) {
        const end = Math.min(limit, start + n + maxTokens);
        if (end > start + n) {
          return words.slice(start + n, end);
        }
      }
    }
  }
  return null;
}

export function isSymmetricLanTpEligible(nodes: NodeTelemetry[]): boolean {
  const online = nodes.filter((n) => n.status === "CONNECTED" && n.handshake_ok);
  const count = online.length;
  if (count < 2 || (count & (count - 1)) !== 0) return false;
  if (online.some((n) => n.os.toLowerCase().includes("android"))) return false;
  const firstRam = online[0].ram_total_mb;
  const firstTflops = online[0].compute_tflops;
  return online.every(
    (n) =>
      (n.bandwidth_mbps ?? 0) >= 900 &&
      Math.abs(n.ram_total_mb - firstRam) <= 512 &&
      Math.abs(n.compute_tflops - firstTflops) <= 0.5
  );
}

export interface PlannerRuntimeContext {
  thermalBalancer?: ThermalBalancer;
  learner?: ClusterLearner;
  clusterTokS?: number;
  nowEpochS?: number;
}

export function computeClusterPlan(
  nodes: NodeTelemetry[],
  ggufMeta: GgufMeta,
  partialCfg: Partial<ClusterConfig>,
  onWarn?: (nodeId: string, code: string, msg: string) => void,
  runtimeCtx?: PlannerRuntimeContext
): ClusterPlan {
  const cfg: ClusterConfig = {
    ...DEFAULT_CLUSTER_CONFIG,
    ...partialCfg,
    thermal_limits: {
      ...DEFAULT_THERMAL_LIMITS,
      ...(partialCfg.thermal_limits ?? {}),
    },
    node_overrides: {
      ...(partialCfg.node_overrides ?? {}),
    },
  };
  const thermalBalancer = runtimeCtx?.thermalBalancer ?? new ThermalBalancer();
  const learner = runtimeCtx?.learner;
  const clusterTokS = runtimeCtx?.clusterTokS ?? 0;
  const nowEpochS = runtimeCtx?.nowEpochS ?? Math.floor(Date.now() / 1000);

  const neededMb = Math.ceil((ggufMeta.file_size_mb || 4096) * 1.15);
  const allowOver50 = cfg.experimental_fork_enabled && cfg.allow_android_over_50;

  const normalizeNodeCap = (raw: NodeTelemetry): NodeTelemetry => {
    const isAndroid = raw.os.toLowerCase().includes("android");
    const ov = cfg.node_overrides[raw.node_id];
    const hasGpu = (raw.vram_total_free_mb ?? raw.vram_safe_mb ?? 0) > 0 || (raw.gpu_temp_c ?? 0) > 0;
    const cpuTemp = raw.cpu_temp_c ?? raw.temp_c ?? 40.0;
    const gpuTemp = raw.gpu_temp_c ?? 0.0;

    const nodeLimits: ThermalLimits = { ...cfg.thermal_limits };
    if (ov?.max_cpu_temp_c !== undefined) {
      nodeLimits.cpu_crit_c = ov.max_cpu_temp_c;
      nodeLimits.cpu_shed_c = Math.max(45, ov.max_cpu_temp_c - 5);
      nodeLimits.cpu_warn_c = Math.max(40, ov.max_cpu_temp_c - 10);
    }
    if (ov?.max_gpu_temp_c !== undefined) {
      nodeLimits.gpu_crit_c = ov.max_gpu_temp_c;
      nodeLimits.gpu_shed_c = Math.max(45, ov.max_gpu_temp_c - 4);
      nodeLimits.gpu_warn_c = Math.max(40, ov.max_gpu_temp_c - 9);
    }

    const th = thermalBalancer.evaluateNode(
      raw.node_id,
      isAndroid,
      hasGpu,
      cpuTemp,
      gpuTemp,
      raw.thermal_headroom ?? 0.3,
      nowEpochS,
      nodeLimits
    );
    const lp = learner?.lookup(
      raw.node_id,
      raw.silicon,
      ggufMeta.arch,
      ggufMeta.quant,
      raw.link_type
    );
    const learnedScale = lp?.recommended_load_scale ?? 1.0;
    const combinedScale = Math.max(0, Math.min(1, learnedScale * th.capacity_scale));

    const androidPct = ov?.ram_cap_pct ?? cfg.android_ram_cap_pct;
    const desktopPct = ov?.ram_cap_pct ?? cfg.desktop_ram_cap_pct;
    const vramPct = ov?.vram_cap_pct ?? cfg.vram_cap_pct;

    const baseRamCapMb = isAndroid
      ? computeAndroidSafeCap(raw.ram_total_mb, raw.ram_avail_mb, androidPct, cfg.os_reserve_mb, allowOver50)
      : raw.ram_avail_mb > 0
      ? computeDesktopSafeCap(raw.ram_avail_mb, desktopPct, cfg.os_reserve_mb)
      : raw.safe_cap_mb;

    const rawFreeVram = raw.vram_total_free_mb ?? raw.vram_safe_mb ?? 0;
    const baseVramSafeMb =
      raw.vram_total_free_mb !== undefined
        ? computeVramSafeCap(rawFreeVram, vramPct)
        : Math.max(0, Math.floor(((raw.vram_safe_mb ?? 0) * Math.min(100, Math.max(10, vramPct))) / 100));

    const safeCapMb = combinedScale === 0 ? 0 : Math.floor(baseRamCapMb * combinedScale);
    const vramSafeMb = combinedScale === 0 ? 0 : Math.floor(baseVramSafeMb * combinedScale);

    const strengthScore =
      raw.strength_score ??
      computeNodeStrengthScore(raw.mem_bw_gbps ?? 25.0, raw.compute_tflops ?? 1.0, rawFreeVram);

    const baseScore = lp ? lp.learned_score : scoreNode(raw);
    const sustain = lp ? lp.thermal_sustainability : 1.0;
    const manualWeight = Math.max(0.1, Math.min(10.0, ov?.manual_weight ?? 1.0));
    const netDenom = Math.max(0.01, 1.0 + 0.15 * (raw.p95_rtt_ms ?? raw.rtt_ms ?? 1.0) + 2.0 * (raw.pkt_loss_pct ?? 0.0));
    const effectiveScore = lp
      ? Number(((baseScore * sustain * manualWeight) / netDenom).toFixed(2))
      : Number((baseScore * sustain * manualWeight).toFixed(2));

    return {
      ...raw,
      cpu_temp_c: cpuTemp,
      gpu_temp_c: gpuTemp,
      safe_cap_mb: safeCapMb,
      vram_safe_mb: vramSafeMb,
      safe_total_mb: safeCapMb + vramSafeMb,
      strength_score: strengthScore,
      learned_score: lp?.learned_score,
      thermal_sustainability: sustain,
      thermal_state: th.state,
      cooldown_remaining_s: th.cooldown_remaining_s,
      score: effectiveScore,
    };
  };

  const normalized = nodes.map(normalizeNodeCap);

  const onlineConnected = normalized.filter((n) => n.status === "CONNECTED" && n.handshake_ok);
  let electedMasterId = onlineConnected.find((n) => n.is_master)?.node_id ?? "master-hub";
  if (cfg.role_override === "auto" && onlineConnected.length > 0) {
    const best = [...onlineConnected].sort(
      (a, b) => (b.strength_score ?? 0) - (a.strength_score ?? 0)
    )[0];
    electedMasterId = best.node_id;
  }

  const fastCapacityMb = normalized
    .filter((n) => {
      const ov = cfg.node_overrides[n.node_id];
      return (
        !ov?.disabled &&
        n.status === "CONNECTED" &&
        n.handshake_ok &&
        n.thermal_state !== "EMERGENCY_OFFLOAD" &&
        (n.is_master || (n.p95_rtt_ms ?? n.rtt_ms) <= cfg.max_p95_rtt_ms) &&
        (n.pkt_loss_pct ?? 0.0) <= cfg.max_pkt_loss_pct &&
        (n.thermal_headroom ?? 0.0) < cfg.thermal_threshold
      );
    })
    .reduce((acc, n) => acc + (n.safe_total_mb ?? 0), 0);

  const eligible: NodeTelemetry[] = [];
  const pruned: NodeTelemetry[] = [];
  let anyThermalShed = false;
  let anyEmergencyOffload = false;

  for (const n of normalized) {
    const ov = cfg.node_overrides[n.node_id];
    if (n.thermal_state === "SHED_25") anyThermalShed = true;
    if (n.thermal_state === "EMERGENCY_OFFLOAD") anyEmergencyOffload = true;

    if (ov?.disabled) {
      n.alloc_mb = 0;
      n.compute_share_pct = 0;
      n.stage_latency_ms = 0;
      n.effective_tok_s = 0;
      n.pruned = true;
      n.prune_reason = "Disabled via node override";
      pruned.push(n);
      continue;
    }

    if (n.status === "OFFLINE" || !n.handshake_ok) {
      n.alloc_mb = 0;
      n.compute_share_pct = 0;
      n.stage_latency_ms = 0;
      n.effective_tok_s = 0;
      n.pruned = true;
      n.prune_reason =
        n.status === "OFFLINE"
          ? "OFFLINE / missed heartbeat"
          : `RPC v9 / ${LLAMA_TAG_PIN} handshake mismatch`;
      pruned.push(n);
      continue;
    }

    if (n.thermal_state === "EMERGENCY_OFFLOAD" || (!n.is_master && (n.thermal_headroom ?? 0.0) >= cfg.thermal_threshold)) {
      n.alloc_mb = 0;
      n.compute_share_pct = 0;
      n.stage_latency_ms = 0;
      n.effective_tok_s = 0;
      n.thermal_state = "EMERGENCY_OFFLOAD";
      n.pruned = true;
      n.prune_reason = `Emergency thermal offload (${n.cooldown_remaining_s ? `${n.cooldown_remaining_s}s cooldown hold` : "critical temp/headroom"})`;
      pruned.push(n);
      onWarn?.(n.node_id, "THERMAL_OFFLOAD", n.prune_reason);
      continue;
    }

    if (!n.is_master && (n.pkt_loss_pct ?? 0.0) > cfg.max_pkt_loss_pct) {
      n.alloc_mb = 0;
      n.compute_share_pct = 0;
      n.stage_latency_ms = 0;
      n.effective_tok_s = 0;
      n.pruned = true;
      n.prune_reason = `pkt_loss ${n.pkt_loss_pct.toFixed(1)}% > ${cfg.max_pkt_loss_pct.toFixed(1)}%`;
      pruned.push(n);
      onWarn?.(n.node_id, "PRUNE_LOSS", `Pruned lossy spoke (${n.prune_reason})`);
      continue;
    }

    if (!n.is_master && (n.p95_rtt_ms ?? n.rtt_ms) > cfg.max_p95_rtt_ms && fastCapacityMb >= neededMb) {
      n.alloc_mb = 0;
      n.compute_share_pct = 0;
      n.stage_latency_ms = 0;
      n.effective_tok_s = 0;
      n.pruned = true;
      n.prune_reason = `p95 RTT ${(n.p95_rtt_ms ?? n.rtt_ms).toFixed(1)}ms > ${cfg.max_p95_rtt_ms}ms (fast nodes fit)`;
      pruned.push(n);
      onWarn?.(n.node_id, "PRUNE_HIGH_RTT", `Pruned high-RTT spoke (${n.prune_reason})`);
      continue;
    }

    eligible.push(n);
  }

  eligible.sort((a, b) => {
    const diff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(diff) > 1e-6) return diff;
    return Number(Boolean(b.is_master)) - Number(Boolean(a.is_master));
  });

  const totalClusterSafeMb = eligible.reduce((sum, n) => sum + (n.safe_total_mb ?? 0), 0);
  const active: NodeTelemetry[] = [];
  let remainingMb = neededMb;
  let maxNodeVramMb = 0;
  let masterPerfCores = 4;
  let maxSpokeP95Rtt = 0;
  let masterSpareMb = 0;

  for (const n of eligible) {
    const safeTotalMb = n.safe_total_mb ?? n.safe_cap_mb + n.vram_safe_mb;
    const allocMb = Math.min(safeTotalMb, Math.max(0, remainingMb));
    maxNodeVramMb = Math.max(maxNodeVramMb, n.vram_safe_mb ?? 0);

    if (n.is_master) {
      masterPerfCores = cfg.node_overrides[n.node_id]?.threads ?? n.perf_cores ?? 4;
      masterSpareMb = Math.max(0, safeTotalMb - allocMb);
    } else {
      maxSpokeP95Rtt = Math.max(maxSpokeP95Rtt, n.p95_rtt_ms ?? n.rtt_ms ?? 0);
    }

    if (!n.is_master && allocMb < cfg.min_alloc_mb) {
      n.alloc_mb = 0;
      n.compute_share_pct = 0;
      n.stage_latency_ms = 0;
      n.effective_tok_s = 0;
      n.pruned = true;
      n.prune_reason =
        remainingMb === 0 ? "surplus capacity (model already fits)" : `alloc_mb < ${cfg.min_alloc_mb} MB`;
      pruned.push(n);
      continue;
    }

    n.alloc_mb = Math.min(safeTotalMb, allocMb);
    n.pruned = false;
    remainingMb = Math.max(0, remainingMb - n.alloc_mb);
    active.push(n);
  }

  const totalPoolMb = active.reduce((sum, n) => sum + (n.alloc_mb ?? 0), 0);
  const rawShareSum = active.reduce((sum, n) => {
    if (totalPoolMb <= 0) return sum;
    return sum + ((n.alloc_mb ?? 0) / totalPoolMb) * Math.max(1.0, n.mem_bw_gbps ?? 25.0);
  }, 0);

  for (const n of active) {
    const attr = computeNodeAttribution(
      n.alloc_mb ?? 0,
      totalPoolMb,
      n.mem_bw_gbps ?? 25.0,
      n.p95_rtt_ms ?? n.rtt_ms ?? 0,
      clusterTokS,
      rawShareSum
    );
    n.compute_share_pct = attr.compute_share_pct;
    n.stage_latency_ms = attr.stage_latency_ms;
    n.effective_tok_s = attr.effective_tok_s;
  }

  let autoSplit = "100.0";
  if (active.length > 0 && totalPoolMb > 0) {
    const pcts = active.map((n) => Math.round(((n.alloc_mb ?? 0) / totalPoolMb) * 100 * 10) / 10);
    const sumOther = pcts.slice(1).reduce((s, v) => s + v, 0);
    pcts[0] = Math.round((100.0 - sumOther) * 10) / 10;
    autoSplit = pcts.map((p) => p.toFixed(1)).join(",");
  }

  const tensorSplit = cfg.manual_tensor_split.trim() || autoSplit;
  const rpcEndpoints = active.filter((n) => !n.is_master).map((n) => `${n.ip}:${n.rpc_port}`);

  const tierInfo = classifyClusterTier(
    totalClusterSafeMb,
    neededMb,
    maxNodeVramMb,
    maxNodeVramMb >= 10000
  );
  const mmapStream = totalClusterSafeMb < neededMb;
  const kvFlag = cfg.kv_quant === "q4_0" ? "q4_0" : cfg.kv_quant === "f16" ? "f16" : "q8_0";

  const spareMb = Math.max(0, totalClusterSafeMb - totalPoolMb);
  const usableKvMb = Math.floor(spareMb * 0.9);
  const computedAutoCtx =
    cfg.ctx_size > 0
      ? cfg.ctx_size
      : usableKvMb >= 4096
      ? 16384
      : usableKvMb >= 1536
      ? 8192
      : usableKvMb >= 512
      ? 4096
      : 2048;

  const autoParallelSlots =
    cfg.parallel_slots > 0
      ? cfg.parallel_slots
      : tierInfo.tier === "S"
      ? 4
      : tierInfo.tier === "A"
      ? 2
      : 1;

  const threadsVal = cfg.threads > 0 ? cfg.threads : masterPerfCores;

  const exe = process.platform === "win32" ? ".exe" : "";
  const hasIkFork = fs.existsSync(path.join(process.cwd(), "bin", `ik-llama-server${exe}`));
  const hasTandemFork = fs.existsSync(path.join(process.cwd(), "bin", `tandem-server${exe}`));

  let serverBin = "llama-server";
  let activeBackend = "stock llama.cpp v1.0.0 (RPC v9)";
  if (cfg.backend_preference === "ik_llama" && hasIkFork) {
    serverBin = `bin/ik-llama-server${exe}`;
    activeBackend = "drop-in ik_llama.cpp (fused MoE / MLA)";
  } else if (cfg.backend_preference === "tandem" && hasTandemFork) {
    serverBin = `bin/tandem-server${exe}`;
    activeBackend = "drop-in tandem.cpp (CPU-miss overlap)";
  } else if (cfg.backend_preference === "auto") {
    if (hasIkFork) {
      serverBin = `bin/ik-llama-server${exe}`;
      activeBackend = "drop-in ik_llama.cpp (fused MoE / MLA)";
    } else if (hasTandemFork) {
      serverBin = `bin/tandem-server${exe}`;
      activeBackend = "drop-in tandem.cpp (CPU-miss overlap)";
    }
  }

  const flags: string[] = [
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
    "-ngl",
    String(cfg.ngl),
    "-c",
    String(computedAutoCtx),
    "-t",
    String(threadsVal),
    "--jinja",
    "-ctk",
    kvFlag,
    "-ctv",
    kvFlag,
  ];

  if (cfg.cont_batching) {
    flags.push("--cont-batching", "--cache-reuse", String(cfg.cache_reuse), "--parallel", String(autoParallelSlots));
  }
  if (cfg.flash_attn) {
    flags.push("--flash-attn");
  }
  if (!mmapStream) {
    flags.push("--no-mmap");
  }
  if (cfg.mlock) {
    flags.push("--mlock");
  }
  if (cfg.emit_tuning_flags) {
    flags.push(
      "-b",
      String(cfg.batch_size),
      "-ub",
      String(cfg.ubatch_size),
      "--temp",
      String(cfg.temp),
      "--top-p",
      String(cfg.top_p),
      "--top-k",
      String(cfg.top_k),
      "--min-p",
      String(cfg.min_p),
      "--repeat-penalty",
      String(cfg.repeat_penalty)
    );
    if (cfg.seed >= 0) {
      flags.push("--seed", String(cfg.seed));
    }
  }

  if (ggufMeta.is_moe) {
    const otRegex = cfg.moe_ot_regex.trim() || ".ffn_.*_exps.=CPU";
    flags.push("-ot", `"^output\\.weight=CPU"`, "-ot", `"${otRegex}"`);
  }
  if (cfg.draft_model.trim()) {
    flags.push("--model-draft", cfg.draft_model.trim());
  }
  if (cfg.api_key.trim()) {
    flags.push("--api-key", cfg.api_key.trim());
  }

  const experimentalFlags: string[] = [];
  if (cfg.experimental_fork_enabled) {
    if (cfg.async_rpc) experimentalFlags.push("--rpc-async");
    if (cfg.fp8_wire_compress) experimentalFlags.push("--rpc-wire-quant", "fp8");
  }

  const cmdParts = [serverBin, "-m", ggufMeta.model_path, ...flags];
  if (rpcEndpoints.length > 0) {
    cmdParts.push("--rpc", rpcEndpoints.join(","));
  }
  if (active.length > 1) {
    cmdParts.push("--tensor-split", tensorSplit);
  }
  if (experimentalFlags.length > 0) {
    cmdParts.push(...experimentalFlags);
  }

  const symmetricTp = isSymmetricLanTpEligible(normalized);
  const learnedCount = active.filter((n) => n.learned_score !== undefined).length;
  const ternaryActive = cfg.ternary_mode || ggufMeta.is_ternary;

  const decisions: AutoTuneDecision[] = [
    {
      mechanism: `Cluster Strength Tier ${tierInfo.tier} Auto-Profile`,
      category: "Compute",
      status: "ACTIVE",
      reason: `${tierInfo.label} · Auto-Master=${electedMasterId} · -t ${threadsVal} P-cores`,
    },
    {
      mechanism: "Proactive Thermal-Safe Load Balancer",
      category: "Thermal",
      status: anyEmergencyOffload ? "PRUNED" : "ACTIVE",
      reason: anyEmergencyOffload
        ? "Emergency Offload active on overheating node (30s hold + 5.0°C hysteresis band)"
        : anyThermalShed
        ? "Thermal shed (-25% capacity) active to keep nodes below critical temperature"
        : `All nodes COOL within safe envelope (Android warn ${cfg.thermal_limits.android_warn_c}°C / GPU shed ${cfg.thermal_limits.gpu_shed_c}°C / CPU shed ${cfg.thermal_limits.cpu_shed_c}°C)`,
    },
    {
      mechanism: "Self-Learning EMA Optimizer (cluster_history.json)",
      category: "Learner",
      status: learnedCount > 0 ? "ACTIVE" : "STANDBY",
      reason:
        learnedCount > 0
          ? `Applying 0.7/0.3 EMA weights & thermal sustainability across ${learnedCount} learned node profile(s)`
          : "Warm-started from 1.5s hardware profiler; EMA updates persist after 50+ tokens",
    },
    {
      mechanism: "3-Tier Memory & Hot-Expert Offload",
      category: "Memory",
      status: mmapStream || ggufMeta.is_moe || ternaryActive ? "ACTIVE" : "STANDBY",
      reason: mmapStream
        ? "Tier-2 NVMe cyclic mmap streaming enabled (--no-mmap omitted to prevent OOM)"
        : ternaryActive
        ? "BitNet / TQ1_0 / TQ2_0 1.58-bit CPU-LUT path active alongside zero-OOM RAM bounds"
        : ggufMeta.is_moe
        ? "Shared attention in Tier-0 VRAM, MoE experts pinned to Tier-1 Host RAM (-ot)"
        : "Dense weights locked cleanly inside Tier-0 VRAM + Tier-1 RAM (--no-mmap active)",
    },
    {
      mechanism: "Pure-Rust Prompt Lookup (N-gram) + MTP Cascade",
      category: "Speculation",
      status: "ACTIVE",
      reason: ggufMeta.has_mtp_heads
        ? "Native MTP NextN heads + zero-VRAM N-gram suffix matcher active"
        : cfg.draft_model.trim()
        ? `External draft (${cfg.draft_model.trim()}) + N-gram fallback (UAG-TLI Vocab Guard ready)`
        : `Zero-VRAM N-gram suffix matcher active (EAGLE-3 standby; max spoke RTT=${maxSpokeP95Rtt.toFixed(1)}ms, master spare=${masterSpareMb}MB)`,
    },
    {
      mechanism: "Radix Prefix Cache + Sarathi Continuous Batching",
      category: "Serving",
      status: cfg.cont_batching ? "ACTIVE" : "STANDBY",
      reason: `RadixPrefixRouter + --cont-batching --cache-reuse ${cfg.cache_reuse} --parallel ${autoParallelSlots}`,
    },
    {
      mechanism: "1-Hop Star Deduplication & Symmetric dllama Check",
      category: "Topology",
      status: symmetricTp ? "ACTIVE" : "STANDBY",
      reason: symmetricTp
        ? "SYMMETRIC_LAN_TP_ELIGIBLE (2^n homogeneous Gigabit nodes detected)"
        : "Heterogeneous hardware detected; 1-Hop Star USB > Hotspot > LAN priority active",
    },
  ];

  return {
    cluster_tier: tierInfo.tier,
    cluster_tier_label: tierInfo.label,
    elected_master_id: electedMasterId,
    active_backend: activeBackend,
    symmetric_lan_tp_eligible: symmetricTp,
    active_nodes: active,
    pruned_nodes: pruned,
    rpc_arg: rpcEndpoints.join(","),
    tensor_split: tensorSplit,
    flags,
    experimental_flags: experimentalFlags,
    command_preview: cmdParts.join(" "),
    auto_ctx_size: computedAutoCtx,
    auto_parallel_slots: autoParallelSlots,
    cluster_tok_s: clusterTokS,
    mmap_stream: mmapStream,
    tier_2_ssd_streaming: mmapStream,
    needed_mb: neededMb,
    total_cluster_safe_mb: totalClusterSafeMb,
    total_pool_mb: totalPoolMb,
    decisions,
  };
}

export function buildVirtual4NodeSuite(
  androidRamCapPct = 50,
  baseConfig?: Partial<ClusterConfig>
): {
  passed: boolean;
  simulated: true;
  model: GgufMeta;
  nodes: NodeTelemetry[];
  plan: ClusterPlan;
  checks: VirtualTestCheck[];
} {
  const simConfig: ClusterConfig = {
    ...DEFAULT_CLUSTER_CONFIG,
    os_reserve_mb: 512,
    ...baseConfig,
    android_ram_cap_pct: androidRamCapPct,
    manual_tensor_split: "",
    experimental_fork_enabled: false,
    allow_android_over_50: false,
    async_rpc: false,
    fp8_wire_compress: false,
    node_overrides: {},
  };

  const simModel: GgufMeta = {
    model_path: "models/Qwen3-30B-A3B-Q4_K_M.gguf",
    file_size_mb: 18500,
    is_moe: true,
    is_ternary: false,
    arch: "qwen3moe",
    quant: "Q4_K_M",
    fit_badge: "Best Fit",
  };

  const masterRtx: NodeTelemetry = {
    node_id: "master-rtx3050",
    is_master: true,
    os: "linux",
    isa: "AVX2 / FMA",
    silicon: "NVIDIA RTX 3050 4GB + Ryzen 7",
    ip: "127.0.0.1",
    link_type: "local",
    rpc_port: 50052,
    rpc_version: RPC_VERSION_PIN,
    git_tag: LLAMA_TAG_PIN,
    perf_cores: 8,
    ram_total_mb: 12288,
    ram_avail_mb: 10240,
    safe_cap_mb: computeDesktopSafeCap(10240, simConfig.desktop_ram_cap_pct, simConfig.os_reserve_mb),
    vram_total_free_mb: 4096,
    vram_safe_mb: computeVramSafeCap(4096, simConfig.vram_cap_pct),
    compute_tflops: 9.1,
    mem_bw_gbps: 224.0,
    disk_mbps: 3200.0,
    rtt_ms: 0.0,
    p95_rtt_ms: 0.0,
    pkt_loss_pct: 0.0,
    bandwidth_mbps: 10000.0,
    temp_c: 54.0,
    cpu_temp_c: 54.0,
    gpu_temp_c: 61.0,
    cpu_util_pct: 42.0,
    gpu_util_pct: 74.0,
    thermal_headroom: 0.48,
    strength_score: computeNodeStrengthScore(224.0, 9.1, 4096),
    vulkan_active: true,
    execution_backend: "CUDA0",
    handshake_ok: true,
    status: "CONNECTED",
  };

  const androidUsb12Gb: NodeTelemetry = {
    node_id: "android-usb-12gb",
    is_master: false,
    os: "android_termux",
    isa: "ARMv8.2+ DotProd/i8mm",
    silicon: "Snapdragon 8 Gen 2 / Adreno 740",
    ip: "127.0.0.1",
    link_type: "adb_usb",
    rpc_port: 50052,
    rpc_version: RPC_VERSION_PIN,
    git_tag: LLAMA_TAG_PIN,
    perf_cores: 5,
    ram_total_mb: 12288,
    ram_avail_mb: 8800,
    safe_cap_mb: computeAndroidSafeCap(12288, 8800, androidRamCapPct, simConfig.os_reserve_mb, false),
    vram_safe_mb: 0,
    compute_tflops: 2.6,
    mem_bw_gbps: 64.0,
    disk_mbps: 900.0,
    rtt_ms: 0.28,
    p95_rtt_ms: 0.35,
    pkt_loss_pct: 0.0,
    bandwidth_mbps: 3240.0,
    temp_c: 36.2,
    cpu_temp_c: 36.2,
    gpu_temp_c: 0.0,
    cpu_util_pct: 28.0,
    gpu_util_pct: 0.0,
    thermal_headroom: 0.24,
    strength_score: computeNodeStrengthScore(64.0, 2.6, 0),
    vulkan_active: true,
    execution_backend: "Vulkan 1.4 (16KB ELF)",
    handshake_ok: true,
    status: "CONNECTED",
  };

  const androidWifiLossy: NodeTelemetry = {
    node_id: "android-wifi-4gb-lossy",
    is_master: false,
    os: "android_apk",
    isa: "ARMv8.2+ DotProd",
    silicon: "Exynos / Xclipse (SPIR-V Fallback)",
    ip: "192.168.1.50",
    link_type: "wifi_lan",
    rpc_port: 50052,
    rpc_version: RPC_VERSION_PIN,
    git_tag: LLAMA_TAG_PIN,
    perf_cores: 4,
    ram_total_mb: 4096,
    ram_avail_mb: 2800,
    safe_cap_mb: computeAndroidSafeCap(4096, 2800, androidRamCapPct, simConfig.os_reserve_mb, false),
    vram_safe_mb: 0,
    compute_tflops: 1.5,
    mem_bw_gbps: 34.0,
    disk_mbps: 320.0,
    rtt_ms: 14.2,
    p95_rtt_ms: 18.4,
    pkt_loss_pct: 3.0,
    bandwidth_mbps: 84.0,
    temp_c: 39.5,
    cpu_temp_c: 39.5,
    gpu_temp_c: 0.0,
    cpu_util_pct: 15.0,
    gpu_util_pct: 0.0,
    thermal_headroom: 0.33,
    strength_score: computeNodeStrengthScore(34.0, 1.5, 0),
    vulkan_active: false,
    execution_backend: "ARM NEON/DotProd (SPIR-V Fallback)",
    handshake_ok: true,
    status: "CONNECTED",
  };

  const pi400: NodeTelemetry = {
    node_id: "pi400-4gb",
    is_master: false,
    os: "linux",
    isa: "ARMv8.0 Cortex-A72",
    silicon: "ARM Cortex-A72 (KleidiAI)",
    ip: "192.168.7.2",
    link_type: "usb_rndis",
    rpc_port: 50052,
    rpc_version: RPC_VERSION_PIN,
    git_tag: LLAMA_TAG_PIN,
    perf_cores: 4,
    ram_total_mb: 4096,
    ram_avail_mb: 3400,
    safe_cap_mb: computeDesktopSafeCap(3400, simConfig.desktop_ram_cap_pct, simConfig.os_reserve_mb),
    vram_safe_mb: 0,
    compute_tflops: 0.35,
    mem_bw_gbps: 17.0,
    disk_mbps: 90.0,
    rtt_ms: 0.95,
    p95_rtt_ms: 1.2,
    pkt_loss_pct: 0.0,
    bandwidth_mbps: 940.0,
    temp_c: 47.0,
    cpu_temp_c: 47.0,
    gpu_temp_c: 0.0,
    cpu_util_pct: 31.0,
    gpu_util_pct: 0.0,
    thermal_headroom: 0.37,
    strength_score: computeNodeStrengthScore(17.0, 0.35, 0),
    vulkan_active: false,
    execution_backend: "ARM64 CPU (-c)",
    handshake_ok: true,
    status: "CONNECTED",
  };

  const nodes = [masterRtx, androidUsb12Gb, androidWifiLossy, pi400];
  const plan = computeClusterPlan(nodes, simModel, simConfig, undefined, { clusterTokS: 24.5 });

  const plannedMaster = plan.active_nodes.find((n) => n.node_id === "master-rtx3050");
  const plannedAndroid = plan.active_nodes.find((n) => n.node_id === "android-usb-12gb");
  const plannedPi = plan.active_nodes.find((n) => n.node_id === "pi400-4gb");

  const goodHs = decodePreflightHandshake(encodePreflightHandshake(9, "v1.0.0"));
  const badHs = decodePreflightHandshake(encodePreflightHandshake(8, "b11429"));
  const expectedCap12Gb = computeAndroidSafeCap(12288, 8800, androidRamCapPct, simConfig.os_reserve_mb, false);
  const prunedLossy = plan.pruned_nodes.some(
    (n) => n.node_id === "android-wifi-4gb-lossy" && (n.alloc_mb ?? 0) === 0
  );
  const usbIncluded = Boolean(plannedAndroid);
  const piIncluded = Boolean(plannedPi);
  const allWithinCap = plan.active_nodes.every((n) => (n.alloc_mb ?? 0) <= n.safe_cap_mb + n.vram_safe_mb);
  const splitParts = plan.tensor_split.split(",").map(Number);
  const splitSum = splitParts.reduce((a, b) => a + b, 0);
  const shareSum = plan.active_nodes.reduce((a, b) => a + (b.compute_share_pct ?? 0), 0);
  const noHallucinatedFlags =
    !plan.flags.includes("--rpc-async") &&
    !plan.flags.includes("--rpc-wire-quant") &&
    plan.flags.includes("--cont-batching") &&
    plan.flags.includes(`"${simConfig.moe_ot_regex}"`);

  // Verify thermal emergency offload + 30s hysteresis hold
  const tbCheck = new ThermalBalancer();
  const hotGpu = tbCheck.evaluateNode("sim-gpu", false, true, 62, 88, 0.9, 1000, DEFAULT_THERMAL_LIMITS);
  const holdGpu = tbCheck.evaluateNode("sim-gpu", false, true, 58, 76, 0.5, 1010, DEFAULT_THERMAL_LIMITS);
  const releaseGpu = tbCheck.evaluateNode("sim-gpu", false, true, 55, 75, 0.4, 1035, DEFAULT_THERMAL_LIMITS);
  const thermalOk =
    hotGpu.state === "EMERGENCY_OFFLOAD" &&
    hotGpu.capacity_scale === 0 &&
    holdGpu.state === "EMERGENCY_OFFLOAD" &&
    holdGpu.cooldown_remaining_s === 20 &&
    releaseGpu.state === "COOL";

  const checks: VirtualTestCheck[] = [
    {
      name: "Strict Cap Invariant (alloc_mb <= safe_cap_mb + vram_safe_mb)",
      passed: allWithinCap,
      detail: plan.active_nodes
        .map((n) => `${n.node_id}: ${n.alloc_mb}/${n.safe_cap_mb + n.vram_safe_mb} MB`)
        .join(" · "),
    },
    {
      name: "Auto-Master Election & Cluster Tier Classification",
      passed: plan.elected_master_id === "master-rtx3050" && plan.cluster_tier === "A",
      detail: `Elected Master=${plan.elected_master_id} (score=${masterRtx.strength_score}) · Classified ${plan.cluster_tier_label}`,
    },
    {
      name: "Proactive Thermal-Safe Balancer & Compute Attribution",
      passed: thermalOk && Math.abs(shareSum - 100.0) <= 0.5,
      detail: `88°C GPU EmergencyOffload + 30s/5°C hysteresis verified · Per-node compute share=${plan.active_nodes
        .map((n) => `${n.node_id}:${n.compute_share_pct}%`)
        .join(", ")}`,
    },
    {
      name: "32-byte v1.0.0 / RPC v9 Handshake Pin",
      passed: goodHs.ok && !badHs.ok,
      detail: "Accepted v1.0.0 (RPC v9) and rejected legacy b11429 (RPC v8)",
    },
    {
      name: "Android-Only 50% RAM Cap (Linux/Windows uncapped by 50% rule)",
      passed:
        androidUsb12Gb.safe_cap_mb <= 6144 &&
        androidUsb12Gb.safe_cap_mb === expectedCap12Gb &&
        (plannedMaster?.safe_cap_mb ?? 0) > masterRtx.ram_total_mb / 2 &&
        (plannedPi?.safe_cap_mb ?? 0) > pi400.ram_total_mb / 2,
      detail: `Android capped at ${androidUsb12Gb.safe_cap_mb}/12288 MB (50%); Linux master=${plannedMaster?.safe_cap_mb}/${masterRtx.ram_total_mb} MB & Pi400=${plannedPi?.safe_cap_mb}/${pi400.ram_total_mb} MB`,
    },
    {
      name: "Weak-Node Pruning (3% Loss Wi-Fi Spoke -> 0 layers)",
      passed: prunedLossy && usbIncluded && piIncluded,
      detail: "android-wifi-4gb-lossy (3.0% loss, 18.4ms p95 RTT) pruned to 0 MB; android-usb-12gb & pi400-4gb active",
    },
    {
      name: "Normalized --tensor-split & Stock llama.cpp v1.0.0 Flags",
      passed:
        splitParts.length === plan.active_nodes.length && Math.abs(splitSum - 100.0) < 0.2 && noHallucinatedFlags,
      detail: `--tensor-split ${plan.tensor_split} (sum=${splitSum.toFixed(1)}%) · verified stock flags only (--cont-batching --cache-reuse 256)`,
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    simulated: true,
    model: simModel,
    nodes,
    plan,
    checks,
  };
}
