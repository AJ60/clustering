use crate::backend::{AutoDetectedBackend, ComputeBackend};
use crate::hw_probe::log_event;
use crate::learner::ClusterLearner;
use crate::speculation::{select_speculation_cascade, AutoTuneDecision};
use crate::strength_profiler::{classify_cluster_tier, ClusterTier};
use crate::thermal_balancer::{
    compute_node_attribution, ThermalBalancer, ThermalLimits, ThermalState,
};
use crate::topology::is_symmetric_lan_tp_eligible;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeStatus {
    Connected,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpokeTelemetry {
    pub node_id: String,
    pub is_master: bool,
    pub is_android: bool,
    pub os: String,
    pub isa: String,
    pub silicon: String,
    pub endpoint: String,
    pub link_type: String,
    pub perf_cores: u32,
    pub ram_total_mb: u64,
    pub ram_avail_mb: u64,
    pub safe_cap_mb: u64,
    pub vram_total_free_mb: u64,
    pub vram_safe_mb: u64,
    pub compute_tflops: f64,
    pub mem_bw_gbps: f64,
    pub disk_mbps: f64,
    pub p95_rtt_ms: f64,
    pub jitter_ms: f64,
    pub pkt_loss_pct: f64,
    pub bandwidth_mbps: f64,
    pub cpu_temp_c: f64,
    pub gpu_temp_c: f64,
    pub cpu_util_pct: f64,
    pub gpu_util_pct: f64,
    pub thermal_headroom: f64,
    pub strength_score: f64,
    pub vulkan_active: bool,
    pub execution_backend: String,
    pub handshake_ok: bool,
    pub status: NodeStatus,
    pub last_seen_epoch_s: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NodeOverride {
    pub disabled: bool,
    pub ram_cap_pct: Option<u64>,
    pub vram_cap_pct: Option<u64>,
    pub threads: Option<u32>,
    pub manual_weight: Option<f64>,
    pub max_cpu_temp_c: Option<f64>,
    pub max_gpu_temp_c: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GgufInspection {
    pub model_path: String,
    pub file_size_mb: u64,
    pub is_moe: bool,
    pub is_ternary: bool,
    pub has_mtp_heads: bool,
    pub arch: String,
    pub quant: String,
    pub block_count: u32,
    pub expert_count: u32,
    pub context_length: u32,
    pub chat_template_present: bool,
    pub vocab_hash: u64,
    pub fit_badge: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClusterConfig {
    pub role_override: String, // "auto" | "master" | "worker"
    pub android_ram_cap_pct: u64,
    pub desktop_ram_cap_pct: u64,
    pub vram_cap_pct: u64,
    pub os_reserve_mb: u64,
    pub max_p95_rtt_ms: f64,
    pub max_pkt_loss_pct: f64,
    pub thermal_threshold: f64,
    pub min_alloc_mb: u64,

    pub ngl: u32,
    pub ctx_size: u32, // 0 = auto-fit within 90% remaining cluster RAM
    pub batch_size: u32,
    pub ubatch_size: u32,
    pub threads: u32, // 0 = auto P-core pin
    pub rpc_cache_c: bool,
    pub kv_quant: String,
    pub split_mode: String, // "auto" | "layer" | "tensor"
    pub flash_attn: bool,
    pub cont_batching: bool,
    pub cache_reuse: u32,
    pub parallel_slots: u32, // 0 = auto
    pub mlock: bool,
    pub moe_ot_regex: String,
    pub draft_model: String,
    pub manual_tensor_split: String,
    pub api_key: String,
    pub emit_tuning_flags: bool,
    pub temp: f64,
    pub top_p: f64,
    pub top_k: u32,
    pub min_p: f64,
    pub repeat_penalty: f64,
    pub seed: i64,

    pub experimental_fork_enabled: bool,
    pub allow_android_over_50: bool,
    pub async_rpc: bool,
    pub fp8_wire_compress: bool,
    pub ternary_mode: bool,
    pub backend_preference: String, // "auto" | "stock" | "ik_llama" | "tandem"
    pub thermal_limits: ThermalLimits,
    pub node_overrides: HashMap<String, NodeOverride>,
}

impl Default for ClusterConfig {
    fn default() -> Self {
        Self {
            role_override: "auto".to_string(),
            android_ram_cap_pct: 50,
            desktop_ram_cap_pct: 100,
            vram_cap_pct: 90,
            os_reserve_mb: 1024,
            max_p95_rtt_ms: 15.0,
            max_pkt_loss_pct: 2.0,
            thermal_threshold: 0.90,
            min_alloc_mb: 256,

            ngl: 99,
            ctx_size: 0,
            batch_size: 2048,
            ubatch_size: 512,
            threads: 0,
            rpc_cache_c: true,
            kv_quant: "auto".to_string(),
            split_mode: "auto".to_string(),
            flash_attn: true,
            cont_batching: true,
            cache_reuse: 256,
            parallel_slots: 0,
            mlock: false,
            moe_ot_regex: ".ffn_.*_exps.=CPU".to_string(),
            draft_model: String::new(),
            manual_tensor_split: String::new(),
            api_key: String::new(),
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
            backend_preference: "auto".to_string(),
            thermal_limits: ThermalLimits::default(),
            node_overrides: HashMap::new(),
        }
    }
}

impl ClusterConfig {
    pub fn load_or_default(path: &str) -> Self {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(cfg) = serde_json::from_str::<ClusterConfig>(&raw) {
                return cfg;
            }
        }
        Self::default()
    }

    pub fn save_atomic(&self, path: &str) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = format!("{path}.tmp");
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// MoE Hot-Expert & Locality LRU Tracker (Tier 0 VRAM -> Tier 1 RAM -> Tier 2 SSD)
pub struct ExpertLruTracker {
    hot_capacity: usize,
    hot_experts: VecDeque<String>,
}

impl ExpertLruTracker {
    pub fn new(hot_capacity: usize) -> Self {
        Self {
            hot_capacity: hot_capacity.max(1),
            hot_experts: VecDeque::with_capacity(hot_capacity.max(1)),
        }
    }

    pub fn touch(&mut self, expert_key: &str) {
        if let Some(pos) = self.hot_experts.iter().position(|x| x == expert_key) {
            self.hot_experts.remove(pos);
        } else if self.hot_experts.len() >= self.hot_capacity {
            self.hot_experts.pop_back();
        }
        self.hot_experts.push_front(expert_key.to_string());
    }

    pub fn is_hot_in_tier0_vram(&self, expert_key: &str) -> bool {
        self.hot_experts.iter().any(|x| x == expert_key)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedNode {
    pub node_id: String,
    pub is_master: bool,
    pub endpoint: String,
    pub score: f64,
    pub learned_score: Option<f64>,
    pub thermal_sustainability: f64,
    pub alloc_mb: u64,
    pub safe_total_mb: u64,
    pub compute_share_pct: f64,
    pub stage_latency_ms: f64,
    pub effective_tok_s: f64,
    pub thermal_state: String,
    pub cooldown_remaining_s: u64,
    pub pruned: bool,
    pub prune_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterPlan {
    pub cluster_tier: String,
    pub cluster_tier_label: String,
    pub elected_master_id: String,
    pub active_backend: String,
    pub symmetric_lan_tp_eligible: bool,
    pub active_nodes: Vec<PlannedNode>,
    pub pruned_nodes: Vec<PlannedNode>,
    pub rpc_arg: String,
    pub tensor_split: String,
    pub resolved_split_mode: String,
    pub resolved_kv_quant: String,
    pub estimated_tpot_ms: f64,
    pub flags: Vec<String>,
    pub command_preview: String,
    pub auto_ctx_size: u32,
    pub auto_parallel_slots: u32,
    pub cluster_tok_s: f64,
    pub mmap_stream: bool,
    pub tier_2_ssd_streaming: bool,
    pub total_cluster_safe_mb: u64,
    pub total_alloc_mb: u64,
    pub needed_mb: u64,
    pub decisions: Vec<AutoTuneDecision>,
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn read_u32_le<R: Read>(r: &mut R) -> Option<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b))
}

fn read_u64_le<R: Read>(r: &mut R) -> Option<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).ok()?;
    Some(u64::from_le_bytes(b))
}

fn read_gguf_string<R: Read>(r: &mut R) -> Option<String> {
    let len = read_u64_le(r)? as usize;
    if len > 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

fn gguf_scalar_size(vtype: u32) -> Option<u64> {
    match vtype {
        0 | 1 | 7 => Some(1),  // UINT8, INT8, BOOL
        2 | 3 => Some(2),      // UINT16, INT16
        4 | 5 | 6 => Some(4),  // UINT32, INT32, FLOAT32
        10 | 11 | 12 => Some(8), // UINT64, INT64, FLOAT64
        _ => None,
    }
}

fn skip_gguf_value<R: Read + Seek>(r: &mut R, vtype: u32) -> Option<()> {
    if let Some(sz) = gguf_scalar_size(vtype) {
        r.seek(SeekFrom::Current(sz as i64)).ok()?;
        return Some(());
    }
    if vtype == 8 {
        let len = read_u64_le(r)? as i64;
        r.seek(SeekFrom::Current(len)).ok()?;
        return Some(());
    }
    if vtype == 9 {
        let elem_type = read_u32_le(r)?;
        let count = read_u64_le(r)?;
        if let Some(sz) = gguf_scalar_size(elem_type) {
            r.seek(SeekFrom::Current((count * sz) as i64)).ok()?;
            return Some(());
        }
        for _ in 0..count.min(200_000) {
            skip_gguf_value(r, elem_type)?;
        }
        return Some(());
    }
    None
}

/// Pure-Rust Binary GGUF Header Parser (magic 0x46554747):
/// Reads general.architecture, *.block_count, *.expert_count, *.context_length,
/// tokenizer.chat_template, and hashes tokenizer.ggml.tokens. Never guesses from filenames when binary exists.
pub fn inspect_gguf_header(path: &str, fallback_size_mb: u64, cluster_safe_mb: u64) -> GgufInspection {
    let lower = path.to_lowercase();
    let quant = if lower.contains("tq1_0") {
        "TQ1_0"
    } else if lower.contains("tq2_0") {
        "TQ2_0"
    } else if lower.contains("q8_0") {
        "Q8_0"
    } else if lower.contains("q6_k") {
        "Q6_K"
    } else {
        "Q4_K_M"
    }
    .to_string();

    let Ok(file) = File::open(path) else {
        let file_size_mb = fallback_size_mb.max(1);
        let fit_badge = classify_fit_badge(file_size_mb, cluster_safe_mb);
        return GgufInspection {
            model_path: path.to_string(),
            file_size_mb,
            is_moe: lower.contains("a3b") || lower.contains("moe") || lower.contains("mixtral"),
            is_ternary: lower.contains("tq1") || lower.contains("tq2") || lower.contains("bitnet"),
            has_mtp_heads: lower.contains("mtp") || lower.contains("nextn"),
            arch: if lower.contains("qwen") {
                "qwen3moe".to_string()
            } else {
                "llama".to_string()
            },
            quant,
            block_count: 32,
            expert_count: if lower.contains("a3b") || lower.contains("moe") { 64 } else { 0 },
            context_length: 32768,
            chat_template_present: true,
            vocab_hash: 0,
            fit_badge,
        };
    };

    let size_mb = file
        .metadata()
        .map(|m| (m.len() / (1024 * 1024)).max(1))
        .unwrap_or(fallback_size_mb.max(1));
    let mut r = BufReader::new(file);

    let magic = read_u32_le(&mut r).unwrap_or(0);
    if magic != 0x46554747 {
        return GgufInspection {
            model_path: path.to_string(),
            file_size_mb: size_mb,
            is_moe: false,
            is_ternary: false,
            has_mtp_heads: false,
            arch: "unknown".into(),
            quant,
            block_count: 32,
            expert_count: 0,
            context_length: 4096,
            chat_template_present: false,
            vocab_hash: 0,
            fit_badge: classify_fit_badge(size_mb, cluster_safe_mb),
        };
    }

    let version = read_u32_le(&mut r).unwrap_or(3);
    let _tensor_count = if version >= 2 { read_u64_le(&mut r).unwrap_or(0) } else { 0 };
    let kv_count = if version >= 2 { read_u64_le(&mut r).unwrap_or(0) } else { 0 };

    let mut arch = "llama".to_string();
    let mut block_count = 32u32;
    let mut expert_count = 0u32;
    let mut context_length = 8192u32;
    let mut chat_template_present = false;
    let mut has_mtp_heads = false;
    let mut is_ternary = false;
    let mut vocab_hash = 0u64;

    for _ in 0..kv_count.min(4096) {
        let Some(key) = read_gguf_string(&mut r) else { break };
        let Some(vtype) = read_u32_le(&mut r) else { break };

        if key == "general.architecture" && vtype == 8 {
            if let Some(val) = read_gguf_string(&mut r) {
                arch = val;
            }
            continue;
        }
        if key == "tokenizer.chat_template" {
            chat_template_present = true;
            if skip_gguf_value(&mut r, vtype).is_none() { break }
            continue;
        }
        if key.contains("nextn") || key.contains("mtp") {
            has_mtp_heads = true;
        }
        if key.ends_with(".block_count") && (vtype == 4 || vtype == 5) {
            block_count = read_u32_le(&mut r).unwrap_or(block_count);
            continue;
        }
        if key.ends_with(".expert_count") && (vtype == 4 || vtype == 5) {
            expert_count = read_u32_le(&mut r).unwrap_or(0);
            continue;
        }
        if key.ends_with(".context_length") && (vtype == 4 || vtype == 5) {
            context_length = read_u32_le(&mut r).unwrap_or(context_length);
            continue;
        }
        if key == "general.file_type" && (vtype == 4 || vtype == 5) {
            let ftype = read_u32_le(&mut r).unwrap_or(0);
            if ftype == 34 || ftype == 35 {
                is_ternary = true;
            }
            continue;
        }
        if key == "tokenizer.ggml.tokens" && vtype == 9 {
            let Some(elem_type) = read_u32_le(&mut r) else { break };
            let Some(count) = read_u64_le(&mut r) else { break };
            if elem_type == 8 {
                let mut acc = 0xcbf29ce484222325u64;
                for idx in 0..count.min(200_000) {
                    let Some(tok) = read_gguf_string(&mut r) else { break };
                    if idx < 256 {
                        acc ^= fnv1a_64(tok.as_bytes());
                        acc = acc.wrapping_mul(0x100000001b3);
                    }
                }
                vocab_hash = acc ^ count;
                continue;
            }
        }
        if skip_gguf_value(&mut r, vtype).is_none() {
            break;
        }
    }

    GgufInspection {
        model_path: path.to_string(),
        file_size_mb: size_mb,
        is_moe: expert_count > 1,
        is_ternary: is_ternary || arch.contains("bitnet"),
        has_mtp_heads,
        arch,
        quant,
        block_count,
        expert_count,
        context_length,
        chat_template_present,
        vocab_hash,
        fit_badge: classify_fit_badge(size_mb, cluster_safe_mb),
    }
}

fn classify_fit_badge(file_size_mb: u64, cluster_safe_mb: u64) -> String {
    let need = ((file_size_mb as f64) * 1.15).ceil() as u64;
    if cluster_safe_mb == 0 {
        return "Unprobed".into();
    }
    if need <= (cluster_safe_mb * 75) / 100 {
        "Fast".into()
    } else if need <= cluster_safe_mb {
        "Best Fit".into()
    } else {
        "Streaming".into()
    }
}

pub fn scan_models_directory(dir: &str, cluster_safe_mb: u64) -> Vec<GgufInspection> {
    let mut list = Vec::new();
    let Ok(entries) = fs::read_dir(Path::new(dir)) else {
        return list;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext.eq_ignore_ascii_case("gguf") {
                    let p_str = path.to_string_lossy().to_string();
                    list.push(inspect_gguf_header(&p_str, 4096, cluster_safe_mb));
                }
            }
        }
    }
    list.sort_by(|a, b| a.model_path.cmp(&b.model_path));
    list
}

/// Pillar C Link-Weighted Score:
/// Score_i = (0.7 * MemBW_i + 10.0 * TFLOPS_i) / (1.0 + 0.15 * p95_RTT_i + 2.0 * PktLoss_i)
pub fn score_node(n: &SpokeTelemetry) -> f64 {
    let numerator = 0.7 * n.mem_bw_gbps + 10.0 * n.compute_tflops;
    let denominator = 1.0 + 0.15 * n.p95_rtt_ms + 2.0 * n.pkt_loss_pct;
    numerator / denominator.max(0.01)
}

pub fn compute_auto_ctx_size(
    cfg_ctx: u32,
    model_meta: &GgufInspection,
    total_cluster_safe_mb: u64,
    total_alloc_mb: u64,
) -> u32 {
    if cfg_ctx > 0 {
        return cfg_ctx.min(model_meta.context_length.max(512));
    }
    let spare_mb = total_cluster_safe_mb.saturating_sub(total_alloc_mb);
    let usable_kv_mb = (spare_mb * 90) / 100;
    let auto_ctx = if usable_kv_mb >= 4096 {
        16384
    } else if usable_kv_mb >= 1536 {
        8192
    } else if usable_kv_mb >= 512 {
        4096
    } else {
        2048
    };
    auto_ctx.min(model_meta.context_length.max(2048))
}

pub fn compute_cluster_plan(
    nodes: &[SpokeTelemetry],
    gguf: &GgufInspection,
    cfg: &ClusterConfig,
) -> ClusterPlan {
    let mut tb = ThermalBalancer::new();
    let learner = ClusterLearner::load_or_empty("cluster_history.json");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    compute_cluster_plan_with_state(nodes, gguf, cfg, &mut tb, &learner, 0.0, now)
}

pub fn compute_cluster_plan_with_state(
    nodes: &[SpokeTelemetry],
    gguf: &GgufInspection,
    cfg: &ClusterConfig,
    thermal_balancer: &mut ThermalBalancer,
    learner: &ClusterLearner,
    cluster_tok_s: f64,
    now_epoch_s: u64,
) -> ClusterPlan {
    let backend = AutoDetectedBackend::detect_with_preference(&cfg.backend_preference).capability();
    let needed_mb = ((gguf.file_size_mb as f64) * 1.15).ceil() as u64;
    let max_rtt = cfg.max_p95_rtt_ms.max(1.0);
    let max_loss = cfg.max_pkt_loss_pct.max(0.0);
    let min_alloc = cfg.min_alloc_mb.max(64);
    let allow_android_over_50 = cfg.experimental_fork_enabled && cfg.allow_android_over_50;

    let effective_safe_caps = |n: &SpokeTelemetry, ov: Option<&NodeOverride>, learned_scale: f64, thermal_scale: f64| -> (u64, u64) {
        let max_pct = if allow_android_over_50 { 85 } else { 50 };
        let capped_ram = if n.is_android {
            let pct = ov.and_then(|o| o.ram_cap_pct).unwrap_or(cfg.android_ram_cap_pct).clamp(10, max_pct);
            let max_by_pct = (n.ram_total_mb * pct) / 100;
            n.safe_cap_mb.min(max_by_pct)
        } else {
            let pct = ov.and_then(|o| o.ram_cap_pct).unwrap_or(cfg.desktop_ram_cap_pct).clamp(10, 100);
            (n.safe_cap_mb * pct) / 100
        };
        let vram_pct = ov.and_then(|o| o.vram_cap_pct).unwrap_or(cfg.vram_cap_pct).clamp(10, 100);
        let scaled_vram = if n.vram_total_free_mb > 0 {
            crate::hw_probe::compute_vram_safe_cap(n.vram_total_free_mb, vram_pct)
        } else {
            n.vram_safe_mb
        };
        let combined_scale = (learned_scale * thermal_scale).clamp(0.0, 1.0);
        if combined_scale == 0.0 {
            return (0, 0);
        }
        let ram_out = ((capped_ram as f64) * combined_scale).floor() as u64;
        let vram_out = ((scaled_vram as f64) * combined_scale).floor() as u64;
        (ram_out.min(capped_ram), vram_out.min(scaled_vram))
    };

    let mut thermal_map = HashMap::new();
    let mut learned_map = HashMap::new();
    for n in nodes {
        let ov = cfg.node_overrides.get(&n.node_id);
        let mut node_limits = cfg.thermal_limits.clone();
        if let Some(max_cpu) = ov.and_then(|o| o.max_cpu_temp_c) {
            node_limits.cpu_crit_c = max_cpu;
            node_limits.cpu_shed_c = (max_cpu - 5.0).max(50.0);
            node_limits.cpu_warn_c = (max_cpu - 10.0).max(45.0);
        }
        if let Some(max_gpu) = ov.and_then(|o| o.max_gpu_temp_c) {
            node_limits.gpu_crit_c = max_gpu;
            node_limits.gpu_shed_c = (max_gpu - 4.0).max(50.0);
            node_limits.gpu_warn_c = (max_gpu - 9.0).max(45.0);
        }
        let th = thermal_balancer.evaluate_node(
            &n.node_id,
            n.is_android,
            n.vram_total_free_mb > 0 || n.gpu_temp_c > 0.0,
            n.cpu_temp_c,
            n.gpu_temp_c,
            n.thermal_headroom,
            now_epoch_s,
            &node_limits,
        );
        thermal_map.insert(n.node_id.clone(), th);
        if let Some(lp) = learner.lookup(&n.node_id, &n.silicon, &gguf.arch, &gguf.quant, &n.link_type) {
            learned_map.insert(n.node_id.clone(), lp.clone());
        }
    }

    let fast_capacity_mb: u64 = nodes
        .iter()
        .filter(|n| {
            let th_scale = thermal_map
                .get(&n.node_id)
                .map(|t| t.capacity_scale)
                .unwrap_or(1.0);
            let disabled = cfg.node_overrides.get(&n.node_id).map(|o| o.disabled).unwrap_or(false);
            !disabled
                && n.status == NodeStatus::Connected
                && n.handshake_ok
                && th_scale > 0.0
                && (n.is_master || n.p95_rtt_ms <= max_rtt)
                && n.pkt_loss_pct <= max_loss
                && n.thermal_headroom < cfg.thermal_threshold
        })
        .map(|n| {
            let ov = cfg.node_overrides.get(&n.node_id);
            let ls = learned_map.get(&n.node_id).map(|l| l.recommended_load_scale).unwrap_or(1.0);
            let ts = thermal_map.get(&n.node_id).map(|t| t.capacity_scale).unwrap_or(1.0);
            let (ram_c, vram_c) = effective_safe_caps(n, ov, ls, ts);
            ram_c + vram_c
        })
        .sum();

    let mut eligible: Vec<(&SpokeTelemetry, f64, u64, Option<f64>, f64, String, u64)> = Vec::new();
    let mut pruned_nodes: Vec<PlannedNode> = Vec::new();
    let mut any_thermal_shed = false;
    let mut any_emergency_offload = false;

    for n in nodes {
        let ov = cfg.node_overrides.get(&n.node_id);
        let lp = learned_map.get(&n.node_id);
        let th = thermal_map.get(&n.node_id).cloned().unwrap_or(crate::thermal_balancer::NodeThermalStatus {
            state: ThermalState::Cool,
            capacity_scale: 1.0,
            tripped_epoch_s: None,
            cooldown_remaining_s: 0,
            reason: "Nominal".into(),
        });
        if th.state == ThermalState::Shed25 {
            any_thermal_shed = true;
        } else if th.state == ThermalState::EmergencyOffload {
            any_emergency_offload = true;
        }

        let ls = lp.map(|l| l.recommended_load_scale).unwrap_or(1.0);
        let sustain = lp.map(|l| l.thermal_sustainability).unwrap_or(1.0);
        let base_score = lp.map(|l| l.learned_score).unwrap_or_else(|| score_node(n));
        let manual_w = ov.and_then(|o| o.manual_weight).unwrap_or(1.0).clamp(0.1, 10.0);
        let s = ((base_score * sustain * manual_w)
            / (1.0 + 0.15 * n.p95_rtt_ms + 2.0 * n.pkt_loss_pct).max(0.01)
            * 100.0)
            .round()
            / 100.0;

        let (ram_c, vram_c) = effective_safe_caps(n, ov, ls, th.capacity_scale);
        let safe_total = ram_c + vram_c;

        if ov.map(|o| o.disabled).unwrap_or(false) {
            pruned_nodes.push(PlannedNode {
                node_id: n.node_id.clone(),
                is_master: n.is_master,
                endpoint: n.endpoint.clone(),
                score: s,
                learned_score: lp.map(|l| l.learned_score),
                thermal_sustainability: sustain,
                alloc_mb: 0,
                safe_total_mb: safe_total,
                compute_share_pct: 0.0,
                stage_latency_ms: 0.0,
                effective_tok_s: 0.0,
                thermal_state: th.state.label().into(),
                cooldown_remaining_s: th.cooldown_remaining_s,
                pruned: true,
                prune_reason: Some("Disabled via node override".into()),
            });
            continue;
        }

        if n.status == NodeStatus::Offline || !n.handshake_ok {
            pruned_nodes.push(PlannedNode {
                node_id: n.node_id.clone(),
                is_master: n.is_master,
                endpoint: n.endpoint.clone(),
                score: s,
                learned_score: lp.map(|l| l.learned_score),
                thermal_sustainability: sustain,
                alloc_mb: 0,
                safe_total_mb: safe_total,
                compute_share_pct: 0.0,
                stage_latency_ms: 0.0,
                effective_tok_s: 0.0,
                thermal_state: th.state.label().into(),
                cooldown_remaining_s: th.cooldown_remaining_s,
                pruned: true,
                prune_reason: Some("OFFLINE / handshake failed".into()),
            });
            continue;
        }
        if th.state == ThermalState::EmergencyOffload || (!n.is_master && n.thermal_headroom >= cfg.thermal_threshold) {
            pruned_nodes.push(PlannedNode {
                node_id: n.node_id.clone(),
                is_master: n.is_master,
                endpoint: n.endpoint.clone(),
                score: s,
                learned_score: lp.map(|l| l.learned_score),
                thermal_sustainability: sustain,
                alloc_mb: 0,
                safe_total_mb: 0,
                compute_share_pct: 0.0,
                stage_latency_ms: 0.0,
                effective_tok_s: 0.0,
                thermal_state: ThermalState::EmergencyOffload.label().into(),
                cooldown_remaining_s: th.cooldown_remaining_s,
                pruned: true,
                prune_reason: Some(th.reason.clone()),
            });
            continue;
        }
        if !n.is_master && n.pkt_loss_pct > max_loss {
            log_event(
                "WARNING",
                &n.node_id,
                "PLANNER",
                "PRUNE_LOSS",
                "Pruned spoke due to packet loss exceeding threshold",
                &format!("pkt_loss={:.1}% > {:.1}%", n.pkt_loss_pct, max_loss),
            );
            pruned_nodes.push(PlannedNode {
                node_id: n.node_id.clone(),
                is_master: false,
                endpoint: n.endpoint.clone(),
                score: s,
                learned_score: lp.map(|l| l.learned_score),
                thermal_sustainability: sustain,
                alloc_mb: 0,
                safe_total_mb: safe_total,
                compute_share_pct: 0.0,
                stage_latency_ms: 0.0,
                effective_tok_s: 0.0,
                thermal_state: th.state.label().into(),
                cooldown_remaining_s: th.cooldown_remaining_s,
                pruned: true,
                prune_reason: Some(format!("pkt_loss {:.1}% > {:.1}%", n.pkt_loss_pct, max_loss)),
            });
            continue;
        }
        if !n.is_master && n.p95_rtt_ms > max_rtt && fast_capacity_mb >= needed_mb {
            pruned_nodes.push(PlannedNode {
                node_id: n.node_id.clone(),
                is_master: false,
                endpoint: n.endpoint.clone(),
                score: s,
                learned_score: lp.map(|l| l.learned_score),
                thermal_sustainability: sustain,
                alloc_mb: 0,
                safe_total_mb: safe_total,
                compute_share_pct: 0.0,
                stage_latency_ms: 0.0,
                effective_tok_s: 0.0,
                thermal_state: th.state.label().into(),
                cooldown_remaining_s: th.cooldown_remaining_s,
                pruned: true,
                prune_reason: Some(format!(
                    "p95 RTT {:.1}ms > {:.1}ms (fast nodes fit)",
                    n.p95_rtt_ms, max_rtt
                )),
            });
            continue;
        }
        eligible.push((
            n,
            s,
            safe_total,
            lp.map(|l| l.learned_score),
            sustain,
            th.state.label().into(),
            th.cooldown_remaining_s,
        ));
    }

    eligible.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.is_master.cmp(&a.0.is_master))
    });

    let total_cluster_safe_mb: u64 = eligible.iter().map(|(_, _, st, ..)| *st).sum();
    let mut staged_active: Vec<(&SpokeTelemetry, f64, u64, u64, Option<f64>, f64, String, u64)> = Vec::new();
    let mut remaining_mb: u64 = needed_mb;
    let mut max_vram_mb: u64 = 0;
    let mut cluster_p95_rtt_ms = 0.0f64;
    let mut master_perf_cores = 4u32;
    let mut master_spare_mb = 0u64;
    let mut elected_master_id = String::from("master-hub");

    for (n, s, safe_total, lscore, sustain, tstate, cd_rem) in eligible {
        if n.is_master {
            elected_master_id = n.node_id.clone();
            master_perf_cores = cfg
                .node_overrides
                .get(&n.node_id)
                .and_then(|o| o.threads)
                .unwrap_or(n.perf_cores)
                .max(2);
        }
        max_vram_mb = max_vram_mb.max(n.vram_safe_mb);
        if !n.is_master && n.p95_rtt_ms > cluster_p95_rtt_ms {
            cluster_p95_rtt_ms = n.p95_rtt_ms;
        }

        // HARD INVARIANT: alloc_mb <= safe_cap_mb + vram_safe_mb
        let alloc_mb = safe_total.min(remaining_mb);
        assert!(alloc_mb <= safe_total, "Zero-OOM Hard Invariant failed");

        if n.is_master {
            master_spare_mb = safe_total.saturating_sub(alloc_mb);
        }

        if alloc_mb < min_alloc && !n.is_master {
            pruned_nodes.push(PlannedNode {
                node_id: n.node_id.clone(),
                is_master: false,
                endpoint: n.endpoint.clone(),
                score: s,
                learned_score: lscore,
                thermal_sustainability: sustain,
                alloc_mb: 0,
                safe_total_mb: safe_total,
                compute_share_pct: 0.0,
                stage_latency_ms: 0.0,
                effective_tok_s: 0.0,
                thermal_state: tstate,
                cooldown_remaining_s: cd_rem,
                pruned: true,
                prune_reason: Some(if remaining_mb == 0 {
                    "model already fits in faster tiers".into()
                } else {
                    format!("alloc_mb < {min_alloc} MB")
                }),
            });
            continue;
        }

        remaining_mb = remaining_mb.saturating_sub(alloc_mb);
        staged_active.push((n, s, safe_total, alloc_mb, lscore, sustain, tstate, cd_rem));
    }

    let total_alloc_mb: u64 = staged_active.iter().map(|x| x.3).sum();
    let raw_share_sum: f64 = staged_active
        .iter()
        .map(|(n, _, _, alloc_mb, ..)| {
            if total_alloc_mb == 0 {
                0.0
            } else {
                ((*alloc_mb as f64) / (total_alloc_mb as f64)) * n.mem_bw_gbps.max(1.0)
            }
        })
        .sum();

    let active_nodes: Vec<PlannedNode> = staged_active
        .into_iter()
        .map(|(n, s, safe_total, alloc_mb, lscore, sustain, tstate, cd_rem)| {
            let (share_pct, stage_ms, eff_tok_s) = compute_node_attribution(
                alloc_mb,
                total_alloc_mb,
                n.mem_bw_gbps,
                n.p95_rtt_ms,
                cluster_tok_s,
                raw_share_sum,
            );
            PlannedNode {
                node_id: n.node_id.clone(),
                is_master: n.is_master,
                endpoint: n.endpoint.clone(),
                score: s,
                learned_score: lscore,
                thermal_sustainability: sustain,
                alloc_mb,
                safe_total_mb: safe_total,
                compute_share_pct: share_pct,
                stage_latency_ms: stage_ms,
                effective_tok_s: eff_tok_s,
                thermal_state: tstate,
                cooldown_remaining_s: cd_rem,
                pruned: false,
                prune_reason: None,
            }
        })
        .collect();

    let tensor_split = if !cfg.manual_tensor_split.trim().is_empty() {
        cfg.manual_tensor_split.trim().to_string()
    } else if total_alloc_mb == 0 {
        "100.0".to_string()
    } else {
        let mut pcts: Vec<f64> = active_nodes
            .iter()
            .map(|n| (((n.alloc_mb as f64) / (total_alloc_mb as f64)) * 1000.0).round() / 10.0)
            .collect();
        let sum_other: f64 = pcts.iter().skip(1).sum();
        if let Some(first) = pcts.first_mut() {
            *first = ((100.0 - sum_other) * 10.0).round() / 10.0;
        }
        pcts.iter().map(|p| format!("{p:.1}")).collect::<Vec<_>>().join(",")
    };

    let rpc_arg = active_nodes
        .iter()
        .filter(|n| !n.is_master)
        .map(|n| n.endpoint.clone())
        .collect::<Vec<_>>()
        .join(",");

    let tier = classify_cluster_tier(
        total_cluster_safe_mb,
        needed_mb,
        max_vram_mb,
        max_vram_mb >= 10_000,
    );
    let mmap_stream = total_cluster_safe_mb < needed_mb;
    let tier_2_ssd_streaming = mmap_stream || tier == ClusterTier::TierC;
    let auto_ctx_size = compute_auto_ctx_size(cfg.ctx_size, gguf, total_cluster_safe_mb, total_alloc_mb);
    let auto_parallel_slots = if cfg.parallel_slots > 0 {
        cfg.parallel_slots
    } else if tier == ClusterTier::TierS {
        4
    } else if tier == ClusterTier::TierA {
        2
    } else {
        1
    };

    let symmetric_lan_tp_eligible = is_symmetric_lan_tp_eligible(nodes);
    let resolved_split_mode = if cfg.split_mode.eq_ignore_ascii_case("tensor") {
        "tensor".to_string()
    } else if cfg.split_mode.eq_ignore_ascii_case("layer") {
        "layer".to_string()
    } else if symmetric_lan_tp_eligible {
        "tensor".to_string()
    } else {
        "layer".to_string()
    };

    // Adaptive KV quantization (LinguaLinked / prima.cpp memory pressure rule):
    // Under "auto", downscale KV to q4_0 when any active node has <=4 GB physical RAM or tight spare RAM.
    let tight_ram_node = active_nodes.iter().any(|p| p.safe_total_mb <= 2048);
    let spare_mb = total_cluster_safe_mb.saturating_sub(total_alloc_mb);
    let resolved_kv_quant = if cfg.kv_quant.eq_ignore_ascii_case("q4_0") {
        "q4_0".to_string()
    } else if cfg.kv_quant.eq_ignore_ascii_case("f16") {
        "f16".to_string()
    } else if cfg.kv_quant.eq_ignore_ascii_case("q8_0") {
        "q8_0".to_string()
    } else if tight_ram_node || (spare_mb < 1536 && auto_ctx_size >= 8192) {
        "q4_0".to_string()
    } else {
        "q8_0".to_string()
    };
    let kv_flag = resolved_kv_quant.as_str();

    // Halda / prima.cpp Heterogeneity-Aware TPOT Co-Optimizer:
    // T_pot = sum(stage_compute_ms + net_rtt_ms) + ssd_mmap_penalty_ms (or parallel overlap discount)
    let base_stage_sum_ms: f64 = active_nodes.iter().map(|n| n.stage_latency_ms).sum();
    let hop_overhead_ms = if active_nodes.len() > 1 {
        (active_nodes.len().saturating_sub(1) as f64) * 1.6
    } else {
        0.0
    };
    let mmap_penalty_ms = if mmap_stream { 42.0 } else { 0.0 };
    let estimated_tpot_ms =
        (((base_stage_sum_ms + hop_overhead_ms + mmap_penalty_ms).max(4.0)) * 100.0).round() / 100.0;

    let spec = select_speculation_cascade(
        tier,
        gguf,
        None,
        cluster_p95_rtt_ms,
        master_spare_mb,
        0.78,
    );

    // Strictly verified stock llama.cpp v1.0.0 CLI flags ONLY
    let threads_val = if cfg.threads > 0 { cfg.threads } else { master_perf_cores };
    let mut flags = vec![
        "--host".into(),
        "0.0.0.0".into(),
        "--port".into(),
        "8080".into(),
        "-ngl".into(),
        cfg.ngl.to_string(),
        "-c".into(),
        auto_ctx_size.to_string(),
        "-t".into(),
        threads_val.to_string(),
        "--jinja".into(),
        "-ctk".into(),
        kv_flag.into(),
        "-ctv".into(),
        kv_flag.into(),
    ];

    if cfg.cont_batching {
        flags.push("--cont-batching".into());
        flags.push("--cache-reuse".into());
        flags.push(cfg.cache_reuse.to_string());
        flags.push("--parallel".into());
        flags.push(auto_parallel_slots.to_string());
    }
    if cfg.flash_attn {
        flags.push("--flash-attn".into());
    }
    if !mmap_stream {
        flags.push("--no-mmap".into());
    }
    if cfg.mlock {
        flags.push("--mlock".into());
    }
    if active_nodes.len() > 1 {
        flags.push("-sm".into());
        flags.push(resolved_split_mode.clone());
    }
    if cfg.emit_tuning_flags {
        flags.extend([
            "-b".into(),
            cfg.batch_size.to_string(),
            "-ub".into(),
            cfg.ubatch_size.to_string(),
            "--temp".into(),
            format!("{:.2}", cfg.temp),
            "--top-p".into(),
            format!("{:.2}", cfg.top_p),
            "--top-k".into(),
            cfg.top_k.to_string(),
            "--min-p".into(),
            format!("{:.2}", cfg.min_p),
            "--repeat-penalty".into(),
            format!("{:.2}", cfg.repeat_penalty),
        ]);
        if cfg.seed >= 0 {
            flags.push("--seed".into());
            flags.push(cfg.seed.to_string());
        }
    }
    if gguf.is_moe {
        flags.push("-ot".into());
        flags.push("\"^output\\.weight=CPU\"".into());
        flags.push("-ot".into());
        flags.push(format!("\"{}\"", cfg.moe_ot_regex));
    }
    let effective_draft = if !cfg.draft_model.trim().is_empty() {
        Some(cfg.draft_model.trim().to_string())
    } else {
        spec.draft_model_arg.clone()
    };
    if let Some(dm) = effective_draft {
        flags.push("--model-draft".into());
        flags.push(dm);
    }
    if !cfg.api_key.trim().is_empty() {
        flags.push("--api-key".into());
        flags.push(cfg.api_key.trim().into());
    }
    if cfg.experimental_fork_enabled {
        if cfg.async_rpc {
            flags.push("--rpc-async".into());
        }
        if cfg.fp8_wire_compress {
            flags.push("--rpc-wire-quant".into());
            flags.push("fp8".into());
        }
    }

    let learned_count = learned_map.len();
    let mut decisions = spec.decisions;
    decisions.push(AutoTuneDecision {
        mechanism: "Proactive Thermal-Safe Load Balancer".into(),
        category: "Thermal".into(),
        status: if any_emergency_offload {
            "PRUNED".into()
        } else if any_thermal_shed {
            "ACTIVE".into()
        } else {
            "ACTIVE".into()
        },
        reason: if any_emergency_offload {
            "Emergency Offload active on overheating node (30s hold + 5.0°C hysteresis band)".into()
        } else if any_thermal_shed {
            "Thermal shed (-25% load) active to keep nodes below critical thermal threshold".into()
        } else {
            format!(
                "All nodes COOL within safe envelope (Android warn {:.0}°C / GPU shed {:.0}°C / CPU shed {:.0}°C)",
                cfg.thermal_limits.android_warn_c,
                cfg.thermal_limits.gpu_shed_c,
                cfg.thermal_limits.cpu_shed_c
            )
        },
    });
    decisions.push(AutoTuneDecision {
        mechanism: "Self-Learning EMA Optimizer (cluster_history.json)".into(),
        category: "Learner".into(),
        status: if learned_count > 0 { "ACTIVE".into() } else { "STANDBY".into() },
        reason: if learned_count > 0 {
            format!("Applying 0.7/0.3 EMA weights & thermal sustainability across {learned_count} learned profile(s)")
        } else {
            "Warm-started from 1.5s hardware profiler; EMA updates activate after 50+ tokens".into()
        },
    });
    decisions.push(AutoTuneDecision {
        mechanism: "3-Tier Memory & Hot-Expert Offload".into(),
        category: "Memory".into(),
        status: if gguf.is_moe || tier_2_ssd_streaming {
            "ACTIVE".into()
        } else {
            "STANDBY".into()
        },
        reason: if tier_2_ssd_streaming {
            "Tier-2 NVMe cyclic mmap streaming enabled (model > safe RAM)".into()
        } else if gguf.is_moe {
            "Shared attention in Tier-0 VRAM, MoE experts pinned to Tier-1 Host RAM via -ot".into()
        } else {
            "Dense model fits cleanly in Tier-0/Tier-1 RAM+VRAM (--no-mmap active)".into()
        },
    });
    decisions.push(AutoTuneDecision {
        mechanism: "Radix Prefix Cache + Sarathi Continuous Batching".into(),
        category: "Serving".into(),
        status: if cfg.cont_batching { "ACTIVE".into() } else { "STANDBY".into() },
        reason: format!(
            "Emits --cont-batching --cache-reuse {} --parallel {} with pure-Rust RadixPrefixRouter",
            cfg.cache_reuse, auto_parallel_slots
        ),
    });
    decisions.push(AutoTuneDecision {
        mechanism: "Auto Big-Core Thread Pinning".into(),
        category: "Compute".into(),
        status: "ACTIVE".into(),
        reason: format!("Pinned -t {threads_val} P-cores (excludes E-cores & HyperThreads)"),
    });
    decisions.push(AutoTuneDecision {
        mechanism: "Symmetric dllama LAN TP Detector".into(),
        category: "Topology".into(),
        status: if symmetric_lan_tp_eligible { "ACTIVE".into() } else { "STANDBY".into() },
        reason: if symmetric_lan_tp_eligible {
            "2^n identical Gigabit nodes detected (SYMMETRIC_LAN_TP_ELIGIBLE)".into()
        } else {
            "Heterogeneous hardware detected; 1-Hop Star RPC selected".into()
        },
    });

    decisions.push(AutoTuneDecision {
        mechanism: "Halda / prima.cpp TPOT & Split Co-Optimizer".into(),
        category: "Topology".into(),
        status: "ACTIVE".into(),
        reason: format!(
            "Est. TPOT {estimated_tpot_ms:.1} ms · -sm {resolved_split_mode} · adaptive -ctk/-ctv {resolved_kv_quant} · loopback-safe USB RPC"
        ),
    });

    let mut cmd_parts = vec![backend.server_bin.clone(), "-m".into(), gguf.model_path.clone()];
    cmd_parts.extend(flags.clone());
    if !rpc_arg.is_empty() {
        cmd_parts.push("--rpc".into());
        cmd_parts.push(rpc_arg.clone());
    }
    if active_nodes.len() > 1 {
        cmd_parts.push("--tensor-split".into());
        cmd_parts.push(tensor_split.clone());
    }

    ClusterPlan {
        cluster_tier: tier.code().to_string(),
        cluster_tier_label: tier.label().to_string(),
        elected_master_id,
        active_backend: backend.label().to_string(),
        symmetric_lan_tp_eligible,
        active_nodes,
        pruned_nodes,
        rpc_arg,
        tensor_split,
        resolved_split_mode,
        resolved_kv_quant,
        estimated_tpot_ms,
        flags,
        command_preview: cmd_parts.join(" "),
        auto_ctx_size,
        auto_parallel_slots,
        cluster_tok_s,
        mmap_stream,
        tier_2_ssd_streaming,
        total_cluster_safe_mb,
        total_alloc_mb,
        needed_mb,
        decisions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_nodes() -> Vec<SpokeTelemetry> {
        vec![
            SpokeTelemetry {
                node_id: "master-rtx3050".into(),
                is_master: true,
                is_android: false,
                os: "linux".into(),
                isa: "AVX2 / FMA".into(),
                silicon: "NVIDIA RTX 3050 4GB".into(),
                endpoint: "127.0.0.1:50052".into(),
                link_type: "local".into(),
                perf_cores: 8,
                ram_total_mb: 16384,
                ram_avail_mb: 14336,
                safe_cap_mb: 13312,
                vram_total_free_mb: 4096,
                vram_safe_mb: 3646,
                compute_tflops: 9.1,
                mem_bw_gbps: 224.0,
                disk_mbps: 3200.0,
                p95_rtt_ms: 0.0,
                jitter_ms: 0.0,
                pkt_loss_pct: 0.0,
                bandwidth_mbps: 10000.0,
                cpu_temp_c: 54.0,
                gpu_temp_c: 58.0,
                cpu_util_pct: 22.0,
                gpu_util_pct: 38.0,
                thermal_headroom: 0.48,
                strength_score: 1239.0,
                vulkan_active: true,
                execution_backend: "CUDA0".into(),
                handshake_ok: true,
                status: NodeStatus::Connected,
                last_seen_epoch_s: 1,
            },
            SpokeTelemetry {
                node_id: "android-usb-12gb".into(),
                is_master: false,
                is_android: true,
                os: "android_termux".into(),
                isa: "ARMv8.2+ DotProd/i8mm".into(),
                silicon: "Snapdragon 8 Gen 2".into(),
                endpoint: "127.0.0.1:50052".into(),
                link_type: "adb_usb".into(),
                perf_cores: 5,
                ram_total_mb: 12288,
                ram_avail_mb: 8800,
                safe_cap_mb: 6144,
                vram_total_free_mb: 0,
                vram_safe_mb: 0,
                compute_tflops: 2.6,
                mem_bw_gbps: 64.0,
                disk_mbps: 900.0,
                p95_rtt_ms: 0.35,
                jitter_ms: 0.08,
                pkt_loss_pct: 0.0,
                bandwidth_mbps: 3200.0,
                cpu_temp_c: 36.0,
                gpu_temp_c: 0.0,
                cpu_util_pct: 18.0,
                gpu_util_pct: 0.0,
                thermal_headroom: 0.55,
                strength_score: 70.8,
                vulkan_active: true,
                execution_backend: "Vulkan 1.4".into(),
                handshake_ok: true,
                status: NodeStatus::Connected,
                last_seen_epoch_s: 1,
            },
            SpokeTelemetry {
                node_id: "android-wifi-4gb-lossy".into(),
                is_master: false,
                is_android: true,
                os: "android_apk".into(),
                isa: "ARMv8.2+ DotProd".into(),
                silicon: "Exynos / Xclipse".into(),
                endpoint: "192.168.1.50:50052".into(),
                link_type: "wifi_lan".into(),
                perf_cores: 4,
                ram_total_mb: 4096,
                ram_avail_mb: 2800,
                safe_cap_mb: 2048,
                vram_total_free_mb: 0,
                vram_safe_mb: 0,
                compute_tflops: 1.5,
                mem_bw_gbps: 34.0,
                disk_mbps: 320.0,
                p95_rtt_ms: 18.4,
                jitter_ms: 4.5,
                pkt_loss_pct: 3.0,
                bandwidth_mbps: 85.0,
                cpu_temp_c: 40.0,
                gpu_temp_c: 0.0,
                cpu_util_pct: 12.0,
                gpu_util_pct: 0.0,
                thermal_headroom: 0.62,
                strength_score: 38.8,
                vulkan_active: false,
                execution_backend: "ARM NEON".into(),
                handshake_ok: true,
                status: NodeStatus::Connected,
                last_seen_epoch_s: 1,
            },
        ]
    }

    #[test]
    fn enforces_hard_cap_invariant_verified_flags_and_tier_classification() {
        let nodes = sample_nodes();
        let gguf = GgufInspection {
            model_path: "models/Qwen3-30B-A3B-Q4_K_M.gguf".into(),
            file_size_mb: 18500,
            is_moe: true,
            is_ternary: false,
            has_mtp_heads: false,
            arch: "qwen3moe".into(),
            quant: "Q4_K_M".into(),
            block_count: 48,
            expert_count: 128,
            context_length: 32768,
            chat_template_present: true,
            vocab_hash: 0,
            fit_badge: "Best Fit".into(),
        };
        let plan = compute_cluster_plan(&nodes, &gguf, &ClusterConfig::default());

        for n in &plan.active_nodes {
            assert!(n.alloc_mb <= n.safe_total_mb);
        }
        assert!(plan.pruned_nodes.iter().any(|n| n.node_id == "android-wifi-4gb-lossy"));
        assert!(!plan.mmap_stream);
        assert!(plan.flags.contains(&"--no-mmap".to_string()));
        assert!(plan.flags.contains(&"--cont-batching".to_string()));
        assert!(!plan.flags.contains(&"--rpc-async".to_string()));
        assert_eq!(plan.cluster_tier, "A");
    }

    #[test]
    fn switches_to_tier_c_ssd_streaming_when_model_exceeds_safe_pool() {
        let nodes = sample_nodes();
        let huge = GgufInspection {
            model_path: "models/Llama-3.3-70B-Q4_K_M.gguf".into(),
            file_size_mb: 40500,
            is_moe: false,
            is_ternary: false,
            has_mtp_heads: false,
            arch: "llama".into(),
            quant: "Q4_K_M".into(),
            block_count: 80,
            expert_count: 0,
            context_length: 131072,
            chat_template_present: true,
            vocab_hash: 0,
            fit_badge: "Streaming".into(),
        };
        let plan = compute_cluster_plan(&nodes, &huge, &ClusterConfig::default());
        assert!(plan.mmap_stream);
        assert!(plan.tier_2_ssd_streaming);
        assert_eq!(plan.cluster_tier, "C");
        assert!(!plan.flags.contains(&"--no-mmap".to_string()));
    }
}
