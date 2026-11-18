use crate::strength_profiler::ClusterTier;
use crate::tier_planner::GgufInspection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTuneDecision {
    pub mechanism: String,
    pub category: String,
    pub status: String, // "ACTIVE" | "STANDBY" | "PRUNED"
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeculationPlan {
    pub selected_strategy: String,
    pub draft_model_arg: Option<String>,
    pub acceptance_alpha: f64,
    pub vocab_guard_ok: bool,
    pub decisions: Vec<AutoTuneDecision>,
}

/// Auto-selects the highest-value lossless speculation & drafting cascade based on Cluster Tier,
/// GGUF metadata, cluster p95 RTT, Master spare RAM/VRAM, and UAG-TLI Vocab Hash Guard.
pub fn select_speculation_cascade(
    tier: ClusterTier,
    main_gguf: &GgufInspection,
    draft_gguf: Option<&GgufInspection>,
    cluster_p95_rtt_ms: f64,
    master_spare_mb: u64,
    rolling_alpha: f64,
) -> SpeculationPlan {
    let mut decisions = Vec::new();
    let mut selected = "PromptLookup-NGram".to_string();
    let mut draft_model_arg: Option<String> = None;
    let mut vocab_guard_ok = true;

    // 1. Native MTP (NextN)
    if main_gguf.has_mtp_heads {
        selected = "Native-MTP (NextN)".to_string();
        decisions.push(AutoTuneDecision {
            mechanism: "Native MTP (NextN Heads)".into(),
            category: "Speculation".into(),
            status: "ACTIVE".into(),
            reason: "GGUF advertises built-in multi-token prediction heads (zero extra VRAM)".into(),
        });
    } else {
        decisions.push(AutoTuneDecision {
            mechanism: "Native MTP (NextN Heads)".into(),
            category: "Speculation".into(),
            status: "STANDBY".into(),
            reason: "Main GGUF header does not advertise MTP heads".into(),
        });
    }

    // 2. Pure-Rust Prompt Lookup (N-gram / REST)
    decisions.push(AutoTuneDecision {
        mechanism: "Pure-Rust Prompt Lookup (N-gram)".into(),
        category: "Speculation".into(),
        status: "ACTIVE".into(),
        reason: "Zero-VRAM suffix matcher active in proxy for coding/RAG/summarization turns".into(),
    });

    // 3. External Draft / EAGLE-3 / DFlash / Medusa + UAG-TLI Vocab Hash Guard + rolling alpha
    if let Some(draft) = draft_gguf {
        let vocab_matches =
            main_gguf.vocab_hash == 0 || draft.vocab_hash == 0 || main_gguf.vocab_hash == draft.vocab_hash;
        vocab_guard_ok = vocab_matches;
        if !vocab_matches {
            decisions.push(AutoTuneDecision {
                mechanism: "EAGLE-3 / External Speculative Draft".into(),
                category: "Speculation".into(),
                status: "PRUNED".into(),
                reason: "UAG-TLI Vocab Hash Guard blocked mismatched tokenizer draft GGUF".into(),
            });
        } else if rolling_alpha < 0.55 {
            decisions.push(AutoTuneDecision {
                mechanism: "EAGLE-3 / External Speculative Draft".into(),
                category: "Speculation".into(),
                status: "STANDBY".into(),
                reason: format!("Live acceptance alpha={rolling_alpha:.2} < 0.55; auto-disabled to prevent latency drag"),
            });
        } else if (cluster_p95_rtt_ms > 5.0 || tier == ClusterTier::TierS) && master_spare_mb >= 1536 {
            selected = format!("External-Draft ({})", draft.arch);
            draft_model_arg = Some(draft.model_path.clone());
            decisions.push(AutoTuneDecision {
                mechanism: "EAGLE-3 / External Speculative Draft".into(),
                category: "Speculation".into(),
                status: "ACTIVE".into(),
                reason: format!("Vocab hash verified, master spare={master_spare_mb}MB >= 1.5GB, amortizing RTT={cluster_p95_rtt_ms:.1}ms"),
            });
        } else {
            decisions.push(AutoTuneDecision {
                mechanism: "EAGLE-3 / External Speculative Draft".into(),
                category: "Speculation".into(),
                status: "STANDBY".into(),
                reason: "Waiting for spare Master >= 1.5 GB & RTT > 5ms (or Tier S)".into(),
            });
        }
    } else {
        decisions.push(AutoTuneDecision {
            mechanism: "EAGLE-3 / External Speculative Draft".into(),
            category: "Speculation".into(),
            status: "STANDBY".into(),
            reason: "No matching --model-draft GGUF attached; using zero-VRAM N-gram/MTP".into(),
        });
    }

    // 4. LayerSkip / Lookahead fallback note
    decisions.push(AutoTuneDecision {
        mechanism: "LayerSkip / Lookahead Fallback".into(),
        category: "Speculation".into(),
        status: if main_gguf.has_mtp_heads || draft_model_arg.is_some() {
            "STANDBY".into()
        } else {
            "ACTIVE".into()
        },
        reason: "Zero-draft-VRAM self-speculative profile ready for CPU/Edge Tier B/C".into(),
    });

    SpeculationPlan {
        selected_strategy: selected,
        draft_model_arg,
        acceptance_alpha: rolling_alpha,
        vocab_guard_ok,
        decisions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uag_tli_blocks_mismatched_vocab_and_low_alpha() {
        let main = GgufInspection {
            model_path: "models/main.gguf".into(),
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
            vocab_hash: 0xAA11BB22,
            fit_badge: "Best Fit".into(),
        };
        let bad_vocab_draft = GgufInspection {
            vocab_hash: 0xDEADBEEF,
            model_path: "models/bad_draft.gguf".into(),
            ..main.clone()
        };
        let res = select_speculation_cascade(
            ClusterTier::TierA,
            &main,
            Some(&bad_vocab_draft),
            8.0,
            2048,
            0.78,
        );
        assert!(!res.vocab_guard_ok);
        assert!(res.draft_model_arg.is_none());

        let good_draft = GgufInspection {
            vocab_hash: 0xAA11BB22,
            model_path: "models/good_draft.gguf".into(),
            ..main.clone()
        };
        let low_alpha = select_speculation_cascade(
            ClusterTier::TierA,
            &main,
            Some(&good_draft),
            8.0,
            2048,
            0.40,
        );
        assert!(low_alpha.vocab_guard_ok);
        assert!(low_alpha.draft_model_arg.is_none());

        let high_alpha = select_speculation_cascade(
            ClusterTier::TierA,
            &main,
            Some(&good_draft),
            8.0,
            2048,
            0.78,
        );
        assert_eq!(high_alpha.draft_model_arg.as_deref(), Some("models/good_draft.gguf"));
    }
}
