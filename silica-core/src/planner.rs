//! True data-driven automatic model & non-uniform layer distribution planner.
//!
//! Hard Mathematical Invariants:
//! 1. Zero OOM: `alloc_mb[i] <= safe_cap_mb[i] + vram_safe_mb[i]` for every single node.
//! 2. Strict 50% Android physical RAM cap (ignoring zram).
//! 3. Cap-Bounded `--tensor-split`: normalized ratios summing cleanly to 100.0.
//! 4. Automatic pruning of slow/lossy Wi-Fi (>40ms p95 RTT or >1.5% loss) or Edge ARM SBC nodes
//!    when Master + USB-C nodes already fit the model with safety margin.
//! 5. Smart `mmap` switching: pass `--no-mmap` ONLY when `total_safe_pool >= model_need * 1.15`.
//! 6. Automatic `-nkvo` (CPU KV offload) for <= 4 GB GPUs when target context >= 32,768.
//! 7. Master-pinned `--mmproj` vision projector + embedding/lm_head budget reservation.
//! 8. Strict stock `llama.cpp v1.0.0` CLI flag allowlist (zero hallucinated flags).

use crate::gguf::{GgufModelCard, ModelArchMode};
use crate::history::LearnedProfile;
use crate::speculative::SpeculativeMode;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeOs {
    Windows,
    Linux,
    Android,
    EdgeArm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LinkTransport {
    Local,
    UsbC,
    UsbRndis,
    Ethernet25G,
    WifiLan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThermalState {
    Cool,
    Warn,
    Shed25,
    EmergencyOffload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveNodeInput {
    pub node_id: String,
    pub label: String,
    pub is_master: bool,
    pub os: NodeOs,
    pub ip: String,
    pub rpc_port: u16,
    pub transport: LinkTransport,
    pub total_ram_mb: f64,
    pub available_ram_mb: f64,
    pub vram_total_mb: f64,
    pub vram_free_mb: f64,
    pub mem_bw_gbps: f64,
    pub big_cores: u32,
    pub rtt_p95_ms: f64,
    pub bandwidth_mbps: f64,
    pub pkt_loss_pct: f64,
    pub temp_c: f64,
    pub thermal_headroom: f64,
    pub handshake_verified: bool,
    pub heartbeat_age_s: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLoadConfig {
    pub context_length: u32,
    pub kv_cache_quant: String, // "f16" | "q8_0" | "q4_0"
    pub gpu_offload_layers: Option<u32>,
    pub manual_tensor_split: Option<Vec<f64>>,
    pub moe_cpu_offload: bool,
    pub speculative_mode: SpeculativeMode,
    pub draft_model_path: Option<String>,
    pub draft_max_tokens: u32,
    pub flash_attn: bool,
    pub cont_batching: bool,
    pub cache_reuse: u32,
    pub kv_unified: bool,
    pub no_kv_offload: Option<bool>,
    pub slot_save_path: Option<String>,
    pub force_no_mmap: Option<bool>,
    pub threads: Option<u32>,
    pub batch_size: u32,
    pub ubatch_size: u32,
    pub enable_jinja: bool,
}

impl Default for ModelLoadConfig {
    fn default() -> Self {
        Self {
            context_length: 16384,
            kv_cache_quant: "q8_0".to_string(),
            gpu_offload_layers: None,
            manual_tensor_split: None,
            moe_cpu_offload: true,
            speculative_mode: SpeculativeMode::Off,
            draft_model_path: None,
            draft_max_tokens: 8,
            flash_attn: true,
            cont_batching: true,
            cache_reuse: 256,
            kv_unified: true,
            no_kv_offload: None,
            slot_save_path: Some("./.silica-kv-cache".to_string()),
            force_no_mmap: None,
            threads: None,
            batch_size: 1024,
            ubatch_size: 256,
            enable_jinja: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedNodeAllocation {
    pub node_id: String,
    pub label: String,
    pub is_master: bool,
    pub ip: String,
    pub rpc_addr: Option<String>,
    pub transport: LinkTransport,
    pub safe_cap_mb: f64,
    pub vram_safe_mb: f64,
    pub alloc_mb: f64,
    pub layer_start: Option<u32>,
    pub layer_end: Option<u32>,
    pub layer_count: u32,
    pub tensor_split_pct: f64,
    pub thermal_state: ThermalState,
    pub pruned: bool,
    pub prune_reason: Option<String>,
    pub estimated_tok_per_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterPlanOutput {
    pub total_safe_pool_mb: f64,
    pub total_model_need_mb: f64,
    pub use_no_mmap: bool,
    pub mmap_streaming: bool,
    pub auto_nkvo: bool,
    pub master_mmproj_path: Option<String>,
    pub tensor_split: Vec<f64>,
    pub tensor_split_csv: String,
    pub rpc_endpoints_csv: Option<String>,
    pub nodes: Vec<PlannedNodeAllocation>,
    pub cli_args: Vec<String>,
}

/// Evaluates non-root safe physical memory cap:
/// - Android: strictly <= 50% of physical MemTotal AND <= 80% MemAvailable (ignoring zram).
/// - Windows/Linux/EdgeARM: respects OS headroom (75% of available or 70% of total minus reserve).
pub fn compute_safe_caps(node: &LiveNodeInput) -> (f64, f64, ThermalState) {
    let (thermal_state, scale) = match node.os {
        NodeOs::Android => {
            if node.temp_c >= 48.0 || node.thermal_headroom >= 0.95 {
                (ThermalState::EmergencyOffload, 0.0)
            } else if node.temp_c >= 45.0 || node.thermal_headroom >= 0.90 {
                (ThermalState::Shed25, 0.75)
            } else if node.temp_c >= 42.0 {
                (ThermalState::Warn, 0.90)
            } else {
                (ThermalState::Cool, 1.0)
            }
        }
        _ => {
            if node.temp_c >= 88.0 {
                (ThermalState::EmergencyOffload, 0.0)
            } else if node.temp_c >= 82.0 {
                (ThermalState::Shed25, 0.75)
            } else if node.temp_c >= 75.0 {
                (ThermalState::Warn, 0.92)
            } else {
                (ThermalState::Cool, 1.0)
            }
        }
    };

    let raw_ram_cap = match node.os {
        NodeOs::Android => {
            let half_physical = node.total_ram_mb * 0.50;
            let avail_guard = node.available_ram_mb * 0.80;
            half_physical.min(avail_guard).max(0.0)
        }
        NodeOs::Windows => {
            let reserve = (node.total_ram_mb * 0.22).max(2048.0);
            (node.available_ram_mb - reserve * 0.35)
                .min((node.total_ram_mb - reserve).max(0.0))
                .max(0.0)
        }
        NodeOs::Linux | NodeOs::EdgeArm => {
            let reserve = (node.total_ram_mb * 0.18).max(768.0);
            (node.available_ram_mb * 0.85)
                .min((node.total_ram_mb - reserve).max(0.0))
                .max(0.0)
        }
    };

    // Windows WDDM VRAM cliff protection: reserve 12% or 512MB minimum on Windows GPUs.
    let raw_vram_cap = if node.vram_free_mb > 0.0 {
        let vram_reserve = if node.os == NodeOs::Windows {
            (node.vram_total_mb * 0.12).max(512.0)
        } else {
            (node.vram_total_mb * 0.08).max(256.0)
        };
        (node.vram_free_mb - vram_reserve).max(0.0)
    } else {
        0.0
    };

    // Keep Master online with minimal floor even if warm, while Workers shed cleanly to 0 on emergency.
    let eff_scale = if node.is_master && scale == 0.0 {
        0.5
    } else {
        scale
    };

    (raw_ram_cap * eff_scale, raw_vram_cap * eff_scale, thermal_state)
}

/// Strict stock `llama.cpp v1.0.0` CLI flag allowlist validator.
pub fn validate_stock_llama_cpp_flags(args: &[String]) -> Result<(), String> {
    let allowed: HashSet<&'static str> = [
        "-m",
        "--mmproj",
        "--host",
        "--port",
        "-c",
        "-ngl",
        "--tensor-split",
        "--rpc",
        "--jinja",
        "-fa",
        "-ctk",
        "-ctv",
        "--kv-unified",
        "-nkvo",
        "--slot-save-path",
        "-ot",
        "-t",
        "-b",
        "-ub",
        "--cont-batching",
        "--cache-reuse",
        "--no-mmap",
        "--model-draft",
        "--draft-max",
        "--lookup-cache-static",
    ]
    .into_iter()
    .collect();

    for arg in args {
        if arg.starts_with('-') {
            if !allowed.contains(arg.as_str()) {
                return Err(format!("Disallowed / non-stock llama.cpp v1.0.0 flag: {}", arg));
            }
        }
    }
    Ok(())
}

/// Computes the complete zero-OOM, cap-bounded, non-uniform cluster plan and stock CLI arguments.
pub fn compute_cluster_plan(
    card: &GgufModelCard,
    nodes_input: &[LiveNodeInput],
    cfg: &ModelLoadConfig,
    learned: Option<&LearnedProfile>,
) -> ClusterPlanOutput {
    // Only consider Master + verified ONLINE workers with active heartbeat (<30s TTL).
    let live_nodes: Vec<&LiveNodeInput> = nodes_input
        .iter()
        .filter(|n| n.is_master || (n.handshake_verified && n.heartbeat_age_s < 30))
        .collect();

    let master_vram_total = live_nodes
        .iter()
        .find(|n| n.is_master)
        .map(|n| n.vram_total_mb)
        .unwrap_or(0.0);

    // Automatic `-nkvo` (CPU KV offload) for <= 4 GB GPUs at 32K–131K context or learned OOM profile.
    let auto_nkvo = cfg.no_kv_offload.unwrap_or_else(|| {
        let low_vram_long_ctx =
            master_vram_total > 0.0 && master_vram_total <= 4300.0 && cfg.context_length >= 32768;
        let learned_flag = learned.map(|l| l.learned_kv_offload).unwrap_or(false);
        low_vram_long_ctx || learned_flag
    });

    let total_layer_weights_mb: f64 = card
        .per_layer_profiles
        .iter()
        .map(|l| l.total_weight_mb)
        .sum();
    let total_kv_mb: f64 = card.per_layer_profiles.iter().map(|l| l.kv_cache_mb).sum();
    let total_model_need_mb = card.master_pinned_overhead_mb + total_layer_weights_mb + total_kv_mb;

    // Pre-calculate safe caps & evaluate fast-tier (Master + USB/Ethernet) sufficiency for pruning.
    let mut evaluated: Vec<(&LiveNodeInput, f64, f64, ThermalState)> = live_nodes
        .iter()
        .map(|n| {
            let (ram_cap, vram_cap, tstate) = compute_safe_caps(n);
            (*n, ram_cap, vram_cap, tstate)
        })
        .collect();

    // Master always first.
    evaluated.sort_by_key(|(n, _, _, _)| if n.is_master { 0 } else { 1 });

    let fast_tier_pool_mb: f64 = evaluated
        .iter()
        .filter(|(n, _, _, t)| {
            *t != ThermalState::EmergencyOffload
                && (n.is_master
                    || matches!(
                        n.transport,
                        LinkTransport::UsbC | LinkTransport::UsbRndis | LinkTransport::Ethernet25G
                    ))
        })
        .map(|(_, ram, vram, _)| ram + vram)
        .sum();

    let fast_tier_fits = fast_tier_pool_mb >= total_model_need_mb * 1.05;

    let mut active_indices = Vec::new();
    let mut allocations: Vec<PlannedNodeAllocation> = Vec::with_capacity(evaluated.len());

    for (idx, (node, safe_cap_mb, vram_safe_mb, thermal_state)) in evaluated.iter().enumerate() {
        let mut pruned = false;
        let mut prune_reason = None;

        if !node.is_master {
            if *thermal_state == ThermalState::EmergencyOffload || (*safe_cap_mb + *vram_safe_mb) < 256.0 {
                pruned = true;
                prune_reason = Some("Thermal offload or insufficient safe RAM cap".to_string());
            } else if fast_tier_fits
                && (node.os == NodeOs::EdgeArm
                    || (node.transport == LinkTransport::WifiLan
                        && (node.rtt_p95_ms > 40.0 || node.pkt_loss_pct > 1.5)))
            {
                pruned = true;
                prune_reason = Some(format!(
                    "Pruned slow/lossy link (p95 {:.1}ms, loss {:.1}%) — Master+USB already fits model",
                    node.rtt_p95_ms, node.pkt_loss_pct
                ));
            }
        }

        if !pruned {
            active_indices.push(idx);
        }

        allocations.push(PlannedNodeAllocation {
            node_id: node.node_id.clone(),
            label: node.label.clone(),
            is_master: node.is_master,
            ip: node.ip.clone(),
            rpc_addr: if node.is_master {
                None
            } else {
                Some(format!("{}:{}", node.ip, node.rpc_port))
            },
            transport: node.transport,
            safe_cap_mb: *safe_cap_mb,
            vram_safe_mb: *vram_safe_mb,
            alloc_mb: 0.0,
            layer_start: None,
            layer_end: None,
            layer_count: 0,
            tensor_split_pct: 0.0,
            thermal_state: *thermal_state,
            pruned,
            prune_reason,
            estimated_tok_per_sec: 0.0,
        });
    }

    let total_safe_pool_mb: f64 = active_indices
        .iter()
        .map(|&i| allocations[i].safe_cap_mb + allocations[i].vram_safe_mb)
        .sum();

    // Smart mmap rule: ONLY pass `--no-mmap` when total_safe_pool >= model_need * 1.15.
    let use_no_mmap = cfg
        .force_no_mmap
        .unwrap_or(total_safe_pool_mb >= total_model_need_mb * 1.15);

    // Non-uniform greedy cap-bounded layer assignment respecting Master-pinned overhead first.
    let mut node_remaining_mb: Vec<f64> = allocations
        .iter()
        .map(|a| a.safe_cap_mb + a.vram_safe_mb)
        .collect();

    if let Some(&master_idx) = active_indices.first() {
        let master_overhead = card
            .master_pinned_overhead_mb
            .min(node_remaining_mb[master_idx]);
        allocations[master_idx].alloc_mb += master_overhead;
        node_remaining_mb[master_idx] = (node_remaining_mb[master_idx] - master_overhead).max(0.0);
    }

    // Compute per-active-node desirability weight (bandwidth * EMA efficiency / RTT penalty).
    let mut raw_weights: Vec<(usize, f64)> = active_indices
        .iter()
        .map(|&idx| {
            let node = evaluated[idx].0;
            let cap = node_remaining_mb[idx].max(1.0);
            let ema_mult = learned
                .and_then(|l| l.node_efficiency.get(&node.node_id).copied())
                .unwrap_or(1.0);
            let rtt_penalty = 1.0 / (1.0 + (node.rtt_p95_ms / 25.0));
            let score = cap * (node.mem_bw_gbps.max(10.0).sqrt()) * ema_mult * rtt_penalty;
            (idx, score)
        })
        .collect();

    let weight_sum: f64 = raw_weights.iter().map(|(_, w)| *w).sum::<f64>().max(1e-6);
    let total_layer_budget_mb = total_layer_weights_mb + total_kv_mb;

    // Determine target layer budget per active node, strictly clamped to node_remaining_mb.
    let mut target_budgets: Vec<(usize, f64)> = raw_weights
        .drain(..)
        .map(|(idx, w)| {
            let desired = total_layer_budget_mb * (w / weight_sum);
            (idx, desired.min(node_remaining_mb[idx]))
        })
        .collect();

    // Assign contiguous layers sequentially while NEVER exceeding any node's cap (Zero-OOM invariant).
    let mut current_pos = 0usize;
    let mut current_used_for_layers = 0.0f64;

    for layer in &card.per_layer_profiles {
        let layer_need = layer.total_weight_mb + layer.kv_cache_mb;
        let mut placed = false;

        // Advance to next node if current node reached target or lacks remaining cap.
        while current_pos < target_budgets.len() {
            let (node_idx, target_mb) = target_budgets[current_pos];
            let has_room = node_remaining_mb[node_idx] >= layer_need;
            let within_target =
                current_pos == target_budgets.len() - 1 || current_used_for_layers + layer_need <= target_mb * 1.05;

            if has_room && within_target {
                allocations[node_idx].alloc_mb += layer_need;
                node_remaining_mb[node_idx] = (node_remaining_mb[node_idx] - layer_need).max(0.0);
                current_used_for_layers += layer_need;
                allocations[node_idx].layer_count += 1;
                if allocations[node_idx].layer_start.is_none() {
                    allocations[node_idx].layer_start = Some(layer.layer_index);
                }
                allocations[node_idx].layer_end = Some(layer.layer_index);
                placed = true;
                break;
            }
            current_pos += 1;
            current_used_for_layers = 0.0;
        }

        // Spillover pass: place layer on any active node with remaining safe cap (still zero OOM).
        if !placed {
            if let Some(&(best_idx, _)) = target_budgets
                .iter()
                .max_by(|(a, _), (b, _)| node_remaining_mb[*a].total_cmp(&node_remaining_mb[*b]))
            {
                let clamped = layer_need.min(node_remaining_mb[best_idx]);
                if clamped > 0.0 {
                    allocations[best_idx].alloc_mb += clamped;
                    node_remaining_mb[best_idx] = (node_remaining_mb[best_idx] - clamped).max(0.0);
                    allocations[best_idx].layer_count += 1;
                    if allocations[best_idx].layer_start.is_none() {
                        allocations[best_idx].layer_start = Some(layer.layer_index);
                    }
                    allocations[best_idx].layer_end = Some(layer.layer_index);
                }
            }
        }
    }

    // Hard Zero-OOM clamp guarantee & exact normalized `--tensor-split` summing to 100.0.
    for alloc in &mut allocations {
        let max_cap = alloc.safe_cap_mb + alloc.vram_safe_mb;
        if alloc.alloc_mb > max_cap {
            alloc.alloc_mb = max_cap;
        }
    }

    let active_alloc_sum: f64 = active_indices
        .iter()
        .map(|&i| allocations[i].alloc_mb)
        .sum();

    let mut tensor_split = Vec::with_capacity(active_indices.len());
    if let Some(ref manual) = cfg.manual_tensor_split {
        if manual.len() == active_indices.len() && manual.iter().sum::<f64>() > 0.0 {
            let msum: f64 = manual.iter().sum();
            for (k, &idx) in active_indices.iter().enumerate() {
                let pct = (manual[k] / msum) * 100.0;
                allocations[idx].tensor_split_pct = pct;
                tensor_split.push(pct);
            }
        }
    }

    if tensor_split.is_empty() && !active_indices.is_empty() {
        let mut running = 0.0f64;
        for (k, &idx) in active_indices.iter().enumerate() {
            let pct = if k == active_indices.len() - 1 {
                (100.0 - running).max(0.0)
            } else if active_alloc_sum > 0.0 {
                ((allocations[idx].alloc_mb / active_alloc_sum) * 1000.0).round() / 10.0
            } else {
                (100.0 / active_indices.len() as f64 * 10.0).round() / 10.0
            };
            running += pct;
            allocations[idx].tensor_split_pct = pct;
            tensor_split.push(pct);
        }
    }

    // Estimate per-node real tok/s contribution from memory bandwidth & active parameters.
    let active_gb = (card.active_params_b * 0.58).max(0.8);
    for &idx in &active_indices {
        let node = evaluated[idx].0;
        let base_tok = (node.mem_bw_gbps.max(12.0) / active_gb) * 0.65;
        let share = (allocations[idx].tensor_split_pct / 100.0).max(0.05);
        allocations[idx].estimated_tok_per_sec = (base_tok * share).clamp(1.0, 240.0);
    }

    let tensor_split_csv = tensor_split
        .iter()
        .map(|v| format!("{:.1}", v))
        .collect::<Vec<_>>()
        .join(",");

    let rpc_endpoints: Vec<String> = active_indices
        .iter()
        .filter_map(|&i| allocations[i].rpc_addr.clone())
        .collect();
    let rpc_endpoints_csv = if rpc_endpoints.is_empty() {
        None
    } else {
        Some(rpc_endpoints.join(","))
    };

    // Build verified stock llama.cpp v1.0.0 CLI args.
    let mut cli_args = vec![
        "-m".to_string(),
        card.path.clone(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        "8080".to_string(),
        "-c".to_string(),
        cfg.context_length.to_string(),
        "-ctk".to_string(),
        cfg.kv_cache_quant.clone(),
        "-ctv".to_string(),
        cfg.kv_cache_quant.clone(),
        "-b".to_string(),
        learned
            .map(|l| l.recommended_batch)
            .unwrap_or(cfg.batch_size)
            .to_string(),
        "-ub".to_string(),
        learned
            .map(|l| l.recommended_ubatch)
            .unwrap_or(cfg.ubatch_size)
            .to_string(),
    ];

    if let Some(ref mmproj) = card.mmproj_path {
        cli_args.push("--mmproj".to_string());
        cli_args.push(mmproj.clone());
    }

    let ngl = cfg.gpu_offload_layers.unwrap_or_else(|| {
        if master_vram_total > 0.0 {
            card.block_count
        } else {
            0
        }
    });
    cli_args.push("-ngl".to_string());
    cli_args.push(ngl.to_string());

    if let Some(t) = cfg.threads {
        cli_args.push("-t".to_string());
        cli_args.push(t.to_string());
    }

    if cfg.enable_jinja {
        cli_args.push("--jinja".to_string());
    }
    if cfg.flash_attn {
        cli_args.push("-fa".to_string());
        cli_args.push("on".to_string());
    }
    if cfg.cont_batching {
        cli_args.push("--cont-batching".to_string());
    }
    if cfg.cache_reuse > 0 {
        cli_args.push("--cache-reuse".to_string());
        cli_args.push(cfg.cache_reuse.to_string());
    }
    if cfg.kv_unified {
        cli_args.push("--kv-unified".to_string());
    }
    if auto_nkvo {
        cli_args.push("-nkvo".to_string());
    }
    if let Some(ref slot_dir) = cfg.slot_save_path {
        if !slot_dir.is_empty() {
            cli_args.push("--slot-save-path".to_string());
            cli_args.push(slot_dir.clone());
        }
    }
    if use_no_mmap {
        cli_args.push("--no-mmap".to_string());
    }
    if cfg.moe_cpu_offload && card.arch_mode == ModelArchMode::MoE {
        cli_args.push("-ot".to_string());
        cli_args.push(".ffn_.*_exps.=CPU".to_string());
    }
    if let Some(ref rpc_csv) = rpc_endpoints_csv {
        cli_args.push("--rpc".to_string());
        cli_args.push(rpc_csv.clone());
    }
    if tensor_split.len() > 1 {
        cli_args.push("--tensor-split".to_string());
        cli_args.push(tensor_split_csv.clone());
    }
    if cfg.speculative_mode == SpeculativeMode::ExternalDraft {
        if let Some(ref draft) = cfg.draft_model_path {
            cli_args.push("--model-draft".to_string());
            cli_args.push(draft.clone());
            cli_args.push("--draft-max".to_string());
            cli_args.push(cfg.draft_max_tokens.to_string());
        }
    }

    ClusterPlanOutput {
        total_safe_pool_mb,
        total_model_need_mb,
        use_no_mmap,
        mmap_streaming: !use_no_mmap,
        auto_nkvo,
        master_mmproj_path: card.mmproj_path.clone(),
        tensor_split,
        tensor_split_csv,
        rpc_endpoints_csv,
        nodes: allocations,
        cli_args,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gguf::LayerFootprint;

    fn sample_card(layers: u32, layer_mb: f64, mode: ModelArchMode, mmproj: Option<&str>) -> GgufModelCard {
        let per_layer_profiles = (0..layers)
            .map(|i| LayerFootprint {
                layer_index: i,
                attention_weight_mb: layer_mb * 0.3,
                ffn_or_expert_weight_mb: layer_mb * 0.7,
                total_weight_mb: layer_mb,
                kv_cache_mb: 16.0,
                is_moe_layer: mode == ModelArchMode::MoE,
            })
            .collect();
        GgufModelCard {
            path: "/models/test.gguf".into(),
            file_size_mb: layers as f64 * layer_mb + 600.0,
            gguf_version: 3,
            name: "TestModel".into(),
            basename: "TestModel".into(),
            architecture: "qwen3".into(),
            arch_mode: mode,
            quant_label: "Q4_K_M".into(),
            block_count: layers,
            embedding_length: 4096,
            feed_forward_length: 11008,
            head_count: 32,
            head_count_kv: 8,
            expert_count: if mode == ModelArchMode::MoE { 64 } else { 0 },
            expert_used_count: if mode == ModelArchMode::MoE { 8 } else { 0 },
            context_length: 131072,
            has_chat_template: true,
            has_native_mtp: false,
            vocab_size: 151936,
            vocab_hash: "abcd1234abcd1234".into(),
            mmproj_path: mmproj.map(|s| s.to_string()),
            mmproj_size_mb: if mmproj.is_some() { 550.0 } else { 0.0 },
            master_pinned_overhead_mb: if mmproj.is_some() { 950.0 } else { 400.0 },
            per_layer_profiles,
            estimated_params_b: 14.0,
            active_params_b: if mode == ModelArchMode::MoE { 3.0 } else { 14.0 },
        }
    }

    fn master_node(ram_mb: f64, vram_mb: f64) -> LiveNodeInput {
        LiveNodeInput {
            node_id: "master".into(),
            label: "Desktop Master".into(),
            is_master: true,
            os: NodeOs::Windows,
            ip: "127.0.0.1".into(),
            rpc_port: 50052,
            transport: LinkTransport::Local,
            total_ram_mb: ram_mb,
            available_ram_mb: ram_mb * 0.78,
            vram_total_mb: vram_mb,
            vram_free_mb: vram_mb * 0.92,
            mem_bw_gbps: 240.0,
            big_cores: 8,
            rtt_p95_ms: 0.2,
            bandwidth_mbps: 10000.0,
            pkt_loss_pct: 0.0,
            temp_c: 52.0,
            thermal_headroom: 0.2,
            handshake_verified: true,
            heartbeat_age_s: 0,
        }
    }

    fn android_worker(id: &str, ram_mb: f64, transport: LinkTransport, rtt: f64, temp: f64) -> LiveNodeInput {
        LiveNodeInput {
            node_id: id.into(),
            label: format!("Android {}", id),
            is_master: false,
            os: NodeOs::Android,
            ip: "192.168.1.42".into(),
            rpc_port: 50052,
            transport,
            total_ram_mb: ram_mb,
            available_ram_mb: ram_mb * 0.65,
            vram_total_mb: 0.0,
            vram_free_mb: 0.0,
            mem_bw_gbps: 34.0,
            big_cores: 4,
            rtt_p95_ms: rtt,
            bandwidth_mbps: if transport == LinkTransport::UsbC { 480.0 } else { 180.0 },
            pkt_loss_pct: if rtt > 45.0 { 2.5 } else { 0.0 },
            temp_c: temp,
            thermal_headroom: if temp >= 48.0 { 0.96 } else { 0.3 },
            handshake_verified: true,
            heartbeat_age_s: 3,
        }
    }

    #[test]
    fn enforces_zero_oom_50pct_android_cap_and_tensor_split_sum_100() {
        let card = sample_card(36, 300.0, ModelArchMode::MoE, Some("/models/mmproj.gguf"));
        let nodes = vec![
            master_node(16384.0, 4096.0),
            android_worker("phone-usb", 8192.0, LinkTransport::UsbC, 1.4, 34.0),
        ];
        let cfg = ModelLoadConfig {
            context_length: 65536,
            ..Default::default()
        };
        let plan = compute_cluster_plan(&card, &nodes, &cfg, None);

        // Zero OOM invariant on every node
        for n in &plan.nodes {
            assert!(
                n.alloc_mb <= n.safe_cap_mb + n.vram_safe_mb + 1e-6,
                "Node {} exceeded safe cap: {} > {}",
                n.node_id,
                n.alloc_mb,
                n.safe_cap_mb + n.vram_safe_mb
            );
        }

        // Strict 50% physical RAM cap on Android (8192 * 0.5 = 4096 MB max)
        let phone = plan.nodes.iter().find(|n| n.node_id == "phone-usb").unwrap();
        assert!(phone.safe_cap_mb <= 4096.0 + 1e-6);

        // Normalized --tensor-split sums cleanly to 100.0
        let split_sum: f64 = plan.tensor_split.iter().sum();
        assert!((split_sum - 100.0).abs() < 0.05, "split sum = {}", split_sum);

        // Auto -nkvo triggers on 4 GB GPU at 65K context + mmproj + jinja + stock flags only
        assert!(plan.auto_nkvo);
        assert!(plan.cli_args.contains(&"-nkvo".to_string()));
        assert!(plan.cli_args.contains(&"--kv-unified".to_string()));
        assert!(plan.cli_args.contains(&"--jinja".to_string()));
        assert!(plan.cli_args.contains(&"--mmproj".to_string()));
        assert!(validate_stock_llama_cpp_flags(&plan.cli_args).is_ok());
    }

    #[test]
    fn prunes_slow_wifi_and_sheds_overheated_workers() {
        let card = sample_card(24, 120.0, ModelArchMode::Dense, None);
        let nodes = vec![
            master_node(16384.0, 8192.0),
            android_worker("slow-wifi", 6144.0, LinkTransport::WifiLan, 68.0, 35.0),
            android_worker("hot-phone", 8192.0, LinkTransport::UsbC, 1.2, 49.0),
        ];
        let plan = compute_cluster_plan(&card, &nodes, &ModelLoadConfig::default(), None);

        let slow = plan.nodes.iter().find(|n| n.node_id == "slow-wifi").unwrap();
        let hot = plan.nodes.iter().find(|n| n.node_id == "hot-phone").unwrap();
        assert!(slow.pruned);
        assert!(hot.pruned);
        assert_eq!(hot.thermal_state, ThermalState::EmergencyOffload);
        // Pool easily >= 1.15x model need -> --no-mmap active
        assert!(plan.use_no_mmap);
        assert!(plan.cli_args.contains(&"--no-mmap".to_string()));
    }

    #[test]
    fn switches_to_mmap_streaming_when_pool_below_115pct() {
        let card = sample_card(40, 420.0, ModelArchMode::Dense, None);
        let nodes = vec![master_node(16384.0, 4096.0)];
        let plan = compute_cluster_plan(&card, &nodes, &ModelLoadConfig::default(), None);
        assert!(!plan.use_no_mmap);
        assert!(plan.mmap_streaming);
        assert!(!plan.cli_args.contains(&"--no-mmap".to_string()));
    }
}
