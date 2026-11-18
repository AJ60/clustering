use crate::hw_probe::log_event;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedNodeProfile {
    pub key: String,
    pub node_id: String,
    pub silicon: String,
    pub model_arch: String,
    pub quant_type: String,
    pub link_type: String,
    pub effective_tok_s_per_gb: f64,
    pub thermal_rise_c_per_min: f64,
    pub speculative_alpha: f64,
    pub oom_or_throttle_count: u32,
    pub learned_score: f64,
    pub thermal_sustainability: f64,
    pub recommended_load_scale: f64,
    pub sessions_observed: u32,
    pub last_updated_epoch_s: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct HistoryFile {
    profiles: HashMap<String, LearnedNodeProfile>,
}

pub struct ClusterLearner {
    history_path: String,
    profiles: HashMap<String, LearnedNodeProfile>,
}

impl ClusterLearner {
    pub fn make_key(
        node_id: &str,
        silicon: &str,
        model_arch: &str,
        quant_type: &str,
        link_type: &str,
    ) -> String {
        format!("{node_id}|{silicon}|{model_arch}|{quant_type}|{link_type}")
    }

    pub fn load_or_empty(history_path: &str) -> Self {
        let mut profiles = HashMap::new();
        if let Ok(raw) = fs::read_to_string(history_path) {
            if let Ok(parsed) = serde_json::from_str::<HistoryFile>(&raw) {
                profiles = parsed.profiles;
            }
        }
        Self {
            history_path: history_path.to_string(),
            profiles,
        }
    }

    pub fn save_atomic(&self) -> Result<(), String> {
        let wrapper = HistoryFile {
            profiles: self.profiles.clone(),
        };
        let json = serde_json::to_string_pretty(&wrapper).map_err(|e| e.to_string())?;
        let tmp = format!("{}.tmp", self.history_path);
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.history_path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reset(&mut self) -> Result<(), String> {
        self.profiles.clear();
        if Path::new(&self.history_path).exists() {
            fs::remove_file(&self.history_path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn all_profiles(&self) -> Vec<LearnedNodeProfile> {
        let mut out: Vec<LearnedNodeProfile> = self.profiles.values().cloned().collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    pub fn lookup(
        &self,
        node_id: &str,
        silicon: &str,
        model_arch: &str,
        quant_type: &str,
        link_type: &str,
    ) -> Option<&LearnedNodeProfile> {
        let key = Self::make_key(node_id, silicon, model_arch, quant_type, link_type);
        self.profiles.get(&key)
    }

    /// Updates empirical profile using EMA after >= 50 generated tokens:
    /// - `learned_score = 0.7 * prev_score + 0.3 * observed_performance_score`
    /// - `thermal_sustainability = clamp(1.0 - (thermal_rise_c_per_min / max_safe_slope), 0.35, 1.0)`
    /// - Automatically lowers `recommended_load_scale` if thermal warn/throttle events recur.
    #[allow(clippy::too_many_arguments)]
    pub fn record_completed_session(
        &mut self,
        node_id: &str,
        silicon: &str,
        model_arch: &str,
        quant_type: &str,
        link_type: &str,
        tokens_generated: u32,
        observed_performance_score: f64,
        observed_tok_s_per_gb: f64,
        thermal_rise_c_per_min: f64,
        max_safe_slope: f64,
        speculative_alpha: f64,
        hit_thermal_warn_or_throttle: bool,
        now_epoch_s: u64,
    ) -> Option<LearnedNodeProfile> {
        if tokens_generated < 50 {
            return None;
        }
        let key = Self::make_key(node_id, silicon, model_arch, quant_type, link_type);
        let safe_slope = max_safe_slope.max(1.0);
        let obs_sustainability = (1.0 - (thermal_rise_c_per_min.max(0.0) / safe_slope)).clamp(0.35, 1.0);

        let updated = match self.profiles.get(&key) {
            Some(prev) => {
                let ema_score = 0.7 * prev.learned_score + 0.3 * observed_performance_score;
                let ema_tok_gb = 0.7 * prev.effective_tok_s_per_gb + 0.3 * observed_tok_s_per_gb;
                let ema_rise = 0.7 * prev.thermal_rise_c_per_min + 0.3 * thermal_rise_c_per_min.max(0.0);
                let ema_alpha = 0.7 * prev.speculative_alpha + 0.3 * speculative_alpha.clamp(0.0, 1.0);
                let ema_sustain = (0.7 * prev.thermal_sustainability + 0.3 * obs_sustainability).clamp(0.35, 1.0);
                let throttle_cnt = prev.oom_or_throttle_count + u32::from(hit_thermal_warn_or_throttle);
                let load_scale = if hit_thermal_warn_or_throttle {
                    (prev.recommended_load_scale * 0.85).clamp(0.70, 1.0)
                } else if prev.recommended_load_scale < 1.0 && obs_sustainability > 0.85 {
                    (prev.recommended_load_scale + 0.03).min(1.0)
                } else {
                    prev.recommended_load_scale
                };
                LearnedNodeProfile {
                    key: key.clone(),
                    node_id: node_id.to_string(),
                    silicon: silicon.to_string(),
                    model_arch: model_arch.to_string(),
                    quant_type: quant_type.to_string(),
                    link_type: link_type.to_string(),
                    effective_tok_s_per_gb: (ema_tok_gb * 100.0).round() / 100.0,
                    thermal_rise_c_per_min: (ema_rise * 100.0).round() / 100.0,
                    speculative_alpha: (ema_alpha * 100.0).round() / 100.0,
                    oom_or_throttle_count: throttle_cnt,
                    learned_score: (ema_score * 100.0).round() / 100.0,
                    thermal_sustainability: (ema_sustain * 100.0).round() / 100.0,
                    recommended_load_scale: (load_scale * 100.0).round() / 100.0,
                    sessions_observed: prev.sessions_observed + 1,
                    last_updated_epoch_s: now_epoch_s,
                }
            }
            None => {
                let throttle_cnt = u32::from(hit_thermal_warn_or_throttle);
                let load_scale = if hit_thermal_warn_or_throttle { 0.85 } else { 1.0 };
                LearnedNodeProfile {
                    key: key.clone(),
                    node_id: node_id.to_string(),
                    silicon: silicon.to_string(),
                    model_arch: model_arch.to_string(),
                    quant_type: quant_type.to_string(),
                    link_type: link_type.to_string(),
                    effective_tok_s_per_gb: (observed_tok_s_per_gb * 100.0).round() / 100.0,
                    thermal_rise_c_per_min: (thermal_rise_c_per_min.max(0.0) * 100.0).round() / 100.0,
                    speculative_alpha: (speculative_alpha.clamp(0.0, 1.0) * 100.0).round() / 100.0,
                    oom_or_throttle_count: throttle_cnt,
                    learned_score: (observed_performance_score * 100.0).round() / 100.0,
                    thermal_sustainability: (obs_sustainability * 100.0).round() / 100.0,
                    recommended_load_scale: load_scale,
                    sessions_observed: 1,
                    last_updated_epoch_s: now_epoch_s,
                }
            }
        };

        self.profiles.insert(key, updated.clone());
        let _ = self.save_atomic();
        log_event(
            "INFO",
            node_id,
            "LEARNER",
            "EMA_UPDATED",
            "Updated self-learning cluster profile",
            &format!(
                "score={:.2} sustain={:.2} load_scale={:.2} sessions={}",
                updated.learned_score,
                updated.thermal_sustainability,
                updated.recommended_load_scale,
                updated.sessions_observed
            ),
        );
        Some(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ema_updates_score_downscales_on_thermal_throttle_and_persists_json() {
        let tmp = std::env::temp_dir().join("clusterd_test_history.json");
        let tmp_str = tmp.to_string_lossy().to_string();
        let _ = fs::remove_file(&tmp);

        let mut learner = ClusterLearner::load_or_empty(&tmp_str);
        // Session <50 tokens is ignored
        assert!(learner
            .record_completed_session(
                "android-usb-12gb",
                "SD8Gen2",
                "qwen3moe",
                "Q4_K_M",
                "adb_usb",
                20,
                100.0,
                2.5,
                0.5,
                6.0,
                0.75,
                false,
                100,
            )
            .is_none());

        // First real session sets baseline 100.0
        let p1 = learner
            .record_completed_session(
                "android-usb-12gb",
                "SD8Gen2",
                "qwen3moe",
                "Q4_K_M",
                "adb_usb",
                128,
                100.0,
                2.5,
                1.0,
                6.0,
                0.78,
                false,
                110,
            )
            .unwrap();
        assert_eq!(p1.learned_score, 100.0);
        assert_eq!(p1.recommended_load_scale, 1.0);

        // Second session hits thermal throttle with lower observed score (60.0) & high rise
        let p2 = learner
            .record_completed_session(
                "android-usb-12gb",
                "SD8Gen2",
                "qwen3moe",
                "Q4_K_M",
                "adb_usb",
                150,
                60.0,
                1.4,
                4.5,
                6.0,
                0.72,
                true,
                200,
            )
            .unwrap();
        // 0.7 * 100 + 0.3 * 60 = 88.0
        assert!((p2.learned_score - 88.0).abs() < 0.01);
        assert!(p2.recommended_load_scale < 1.0);
        assert!(p2.thermal_sustainability < 0.9);
        assert_eq!(p2.oom_or_throttle_count, 1);

        // Reload from disk and verify persistence
        let reloaded = ClusterLearner::load_or_empty(&tmp_str);
        let found = reloaded
            .lookup("android-usb-12gb", "SD8Gen2", "qwen3moe", "Q4_K_M", "adb_usb")
            .unwrap();
        assert_eq!(found.sessions_observed, 2);
        assert_eq!(found.oom_or_throttle_count, 1);

        let _ = fs::remove_file(&tmp);
    }
}
