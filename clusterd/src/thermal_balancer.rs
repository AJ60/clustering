use crate::hw_probe::log_event;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThermalState {
    Cool,
    Warn,
    Shed25,
    EmergencyOffload,
}

impl ThermalState {
    pub fn label(&self) -> &'static str {
        match self {
            ThermalState::Cool => "COOL",
            ThermalState::Warn => "WARN",
            ThermalState::Shed25 => "SHED_25",
            ThermalState::EmergencyOffload => "EMERGENCY_OFFLOAD",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThermalLimits {
    pub android_warn_c: f64,
    pub android_shed_c: f64,
    pub android_crit_c: f64,
    pub android_warn_headroom: f64,
    pub android_shed_headroom: f64,
    pub android_crit_headroom: f64,
    pub gpu_warn_c: f64,
    pub gpu_shed_c: f64,
    pub gpu_crit_c: f64,
    pub cpu_warn_c: f64,
    pub cpu_shed_c: f64,
    pub cpu_crit_c: f64,
    pub cooldown_hysteresis_c: f64,
    pub cooldown_hold_secs: u64,
}

impl Default for ThermalLimits {
    fn default() -> Self {
        Self {
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSensorSample {
    pub cpu_temp_c: f64,
    pub gpu_temp_c: f64,
    pub cpu_util_pct: f64,
    pub gpu_util_pct: f64,
    pub thermal_headroom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeThermalStatus {
    pub state: ThermalState,
    pub capacity_scale: f64,
    pub tripped_epoch_s: Option<u64>,
    pub cooldown_remaining_s: u64,
    pub reason: String,
}

#[derive(Debug, Clone)]
struct HysteresisRecord {
    state: ThermalState,
    tripped_epoch_s: Option<u64>,
}

pub struct ThermalBalancer {
    records: HashMap<String, HysteresisRecord>,
}

impl ThermalBalancer {
    pub fn new() -> Self {
        Self {
            records: HashMap::new(),
        }
    }

    /// Evaluates thermal state for a node with hysteresis anti-flapping:
    /// - Enforces critical / shed / warn thresholds for Android, GPU, and Desktop/Pi CPU.
    /// - Once EmergencyOffload triggers, keeps node at 0 layers for at least `cooldown_hold_secs` (30s)
    ///   AND until temperature drops by `cooldown_hysteresis_c` (5.0°C) below warn threshold.
    pub fn evaluate_node(
        &mut self,
        node_id: &str,
        is_android: bool,
        has_gpu: bool,
        cpu_temp_c: f64,
        gpu_temp_c: f64,
        thermal_headroom: f64,
        now_epoch_s: u64,
        limits: &ThermalLimits,
    ) -> NodeThermalStatus {
        let prev = self.records.get(node_id).cloned();

        let (crit_hit, shed_hit, warn_hit, trigger_desc) = if is_android {
            if cpu_temp_c >= limits.android_crit_c || thermal_headroom >= limits.android_crit_headroom {
                (
                    true,
                    false,
                    false,
                    format!("Android temp {cpu_temp_c:.1}°C / headroom {thermal_headroom:.2} >= crit"),
                )
            } else if cpu_temp_c >= limits.android_shed_c || thermal_headroom >= limits.android_shed_headroom {
                (
                    false,
                    true,
                    false,
                    format!("Android temp {cpu_temp_c:.1}°C / headroom {thermal_headroom:.2} >= shed"),
                )
            } else if cpu_temp_c >= limits.android_warn_c || thermal_headroom >= limits.android_warn_headroom {
                (
                    false,
                    false,
                    true,
                    format!("Android temp {cpu_temp_c:.1}°C / headroom {thermal_headroom:.2} >= warn"),
                )
            } else {
                (false, false, false, "Nominal thermal envelope".to_string())
            }
        } else if has_gpu && gpu_temp_c >= limits.gpu_crit_c {
            (
                true,
                false,
                false,
                format!("GPU temp {gpu_temp_c:.1}°C >= crit {:.1}°C", limits.gpu_crit_c),
            )
        } else if cpu_temp_c >= limits.cpu_crit_c {
            (
                true,
                false,
                false,
                format!("CPU temp {cpu_temp_c:.1}°C >= crit {:.1}°C", limits.cpu_crit_c),
            )
        } else if has_gpu && gpu_temp_c >= limits.gpu_shed_c {
            (
                false,
                true,
                false,
                format!("GPU temp {gpu_temp_c:.1}°C >= shed {:.1}°C", limits.gpu_shed_c),
            )
        } else if cpu_temp_c >= limits.cpu_shed_c {
            (
                false,
                true,
                false,
                format!("CPU temp {cpu_temp_c:.1}°C >= shed {:.1}°C", limits.cpu_shed_c),
            )
        } else if (has_gpu && gpu_temp_c >= limits.gpu_warn_c) || cpu_temp_c >= limits.cpu_warn_c {
            (
                false,
                false,
                true,
                format!("Temp warning (CPU {cpu_temp_c:.1}°C / GPU {gpu_temp_c:.1}°C)"),
            )
        } else {
            (false, false, false, "Nominal thermal envelope".to_string())
        };

        // Check existing EmergencyOffload cooldown & 5°C hysteresis band
        if let Some(prev_rec) = &prev {
            if prev_rec.state == ThermalState::EmergencyOffload {
                let tripped_at = prev_rec.tripped_epoch_s.unwrap_or(now_epoch_s);
                let elapsed = now_epoch_s.saturating_sub(tripped_at);
                let hold_remaining = limits.cooldown_hold_secs.saturating_sub(elapsed);

                let cooled_enough = if is_android {
                    cpu_temp_c <= (limits.android_shed_c - limits.cooldown_hysteresis_c)
                        && thermal_headroom <= (limits.android_warn_headroom - 0.10)
                } else {
                    let cpu_ok = cpu_temp_c <= (limits.cpu_shed_c - limits.cooldown_hysteresis_c);
                    let gpu_ok = !has_gpu
                        || gpu_temp_c <= (limits.gpu_shed_c - limits.cooldown_hysteresis_c);
                    cpu_ok && gpu_ok
                };

                if hold_remaining > 0 || !cooled_enough || crit_hit {
                    return NodeThermalStatus {
                        state: ThermalState::EmergencyOffload,
                        capacity_scale: 0.0,
                        tripped_epoch_s: Some(tripped_at),
                        cooldown_remaining_s: hold_remaining,
                        reason: if hold_remaining > 0 {
                            format!(
                                "Anti-flapping hold active ({hold_remaining}s remaining; must cool {:.1}°C below shed)",
                                limits.cooldown_hysteresis_c
                            )
                        } else {
                            format!(
                                "Awaiting {:.1}°C thermal hysteresis band cooldown before re-admission",
                                limits.cooldown_hysteresis_c
                            )
                        },
                    };
                }
            }
        }

        let (state, capacity_scale, tripped_at) = if crit_hit {
            log_event(
                "WARNING",
                node_id,
                "THERMAL",
                "EMERGENCY_OFFLOAD",
                "Node crossed critical thermal envelope; shedding all layers",
                &trigger_desc,
            );
            (ThermalState::EmergencyOffload, 0.0, Some(now_epoch_s))
        } else if shed_hit {
            (ThermalState::Shed25, 0.75, None)
        } else if warn_hit {
            (ThermalState::Warn, 0.90, None)
        } else {
            (ThermalState::Cool, 1.0, None)
        };

        self.records.insert(
            node_id.to_string(),
            HysteresisRecord {
                state,
                tripped_epoch_s: tripped_at,
            },
        );

        NodeThermalStatus {
            state,
            capacity_scale,
            tripped_epoch_s: tripped_at,
            cooldown_remaining_s: 0,
            reason: trigger_desc,
        }
    }
}

/// Computes per-node compute share % and stage latency (ms):
/// - `compute_share_i` weighted by `(alloc_mb_i / total_alloc_mb) * (eff_bw_i / avg_bw)` normalized to 100.0
/// - `stage_ms_i = (alloc_bytes_i / measured_bw_bytes_per_ms) + p95_rtt_ms_i`
pub fn compute_node_attribution(
    alloc_mb: u64,
    total_alloc_mb: u64,
    mem_bw_gbps: f64,
    p95_rtt_ms: f64,
    cluster_tok_s: f64,
    raw_share_sum: f64,
) -> (f64, f64, f64) {
    if alloc_mb == 0 || total_alloc_mb == 0 {
        return (0.0, 0.0, 0.0);
    }
    let layer_frac = (alloc_mb as f64) / (total_alloc_mb as f64);
    let raw_weight = layer_frac * mem_bw_gbps.max(1.0);
    let compute_share_pct = if raw_share_sum > 0.0 {
        ((raw_weight / raw_share_sum) * 1000.0).round() / 10.0
    } else {
        (layer_frac * 1000.0).round() / 10.0
    };
    // Stage forward time estimate for an active slice assuming 5% active weights touched per token pass
    let active_bytes = (alloc_mb as f64) * 1024.0 * 1024.0 * 0.05;
    let bw_bytes_per_ms = (mem_bw_gbps.max(4.0) * 1e9) / 1000.0;
    let stage_ms = ((active_bytes / bw_bytes_per_ms) + p95_rtt_ms).max(0.1);
    let eff_tok_s = ((cluster_tok_s * (compute_share_pct / 100.0)) * 100.0).round() / 100.0;
    (
        compute_share_pct,
        (stage_ms * 100.0).round() / 100.0,
        eff_tok_s,
    )
}

/// Reads real CPU/GPU temp and utilization on Linux/Android/Windows.
pub fn read_local_sensors(is_android: bool) -> LocalSensorSample {
    let mut cpu_temp_c = 42.0;
    let mut gpu_temp_c = 0.0;
    let mut gpu_util_pct = 0.0;
    let mut cpu_util_pct = 12.0;

    // GPU telemetry via nvidia-smi (Linux & Windows)
    if let Ok(out) = Command::new("nvidia-smi")
        .args([
            "--query-gpu=temperature.gpu,utilization.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
    {
        if out.status.success() {
            let line = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if let Some((t_s, u_s)) = line.split_once(',') {
                if let Ok(t) = t_s.trim().parse::<f64>() {
                    gpu_temp_c = t;
                }
                if let Ok(u) = u_s.trim().parse::<f64>() {
                    gpu_util_pct = u;
                }
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // CPU / SoC thermal zones
        if let Ok(entries) = fs::read_dir("/sys/class/thermal") {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with("thermal_zone") {
                    continue;
                }
                if let Ok(raw) = fs::read_to_string(entry.path().join("temp")) {
                    if let Ok(mut val) = raw.trim().parse::<f64>() {
                        if val > 1000.0 {
                            val /= 1000.0;
                        }
                        if (15.0..=110.0).contains(&val) {
                            cpu_temp_c = val;
                            break;
                        }
                    }
                }
            }
        }

        // Android battery/skin fallback
        if is_android {
            if let Ok(raw) = fs::read_to_string("/sys/class/power_supply/battery/temp") {
                if let Ok(mut val) = raw.trim().parse::<f64>() {
                    if val > 200.0 {
                        val /= 10.0;
                    }
                    if (15.0..=80.0).contains(&val) {
                        cpu_temp_c = cpu_temp_c.max(val);
                    }
                }
            }
        }

        // Quick 1-minute loadavg normalized to CPU %
        if let Ok(loadavg) = fs::read_to_string("/proc/loadavg") {
            if let Some(first) = loadavg.split_whitespace().next() {
                if let Ok(l1) = first.parse::<f64>() {
                    let cores = std::thread::available_parallelism()
                        .map(|n| n.get() as f64)
                        .unwrap_or(4.0);
                    cpu_util_pct = ((l1 / cores) * 100.0).clamp(1.0, 100.0);
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
            ])
            .output()
        {
            if out.status.success() {
                if let Ok(pct) = String::from_utf8_lossy(&out.stdout).trim().parse::<f64>() {
                    cpu_util_pct = pct.clamp(1.0, 100.0);
                }
            }
        }
        let _ = is_android;
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "windows")))]
    {
        let _ = is_android;
    }

    let thermal_headroom = if is_android {
        ((cpu_temp_c - 26.0) / (50.0 - 26.0)).clamp(0.0, 1.0)
    } else {
        ((cpu_temp_c.max(gpu_temp_c) - 30.0) / (90.0 - 30.0)).clamp(0.0, 1.0)
    };

    LocalSensorSample {
        cpu_temp_c: (cpu_temp_c * 10.0).round() / 10.0,
        gpu_temp_c: (gpu_temp_c * 10.0).round() / 10.0,
        cpu_util_pct: (cpu_util_pct * 10.0).round() / 10.0,
        gpu_util_pct: (gpu_util_pct * 10.0).round() / 10.0,
        thermal_headroom: (thermal_headroom * 100.0).round() / 100.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_gpu_or_android_headroom_triggers_offload_and_30s_hysteresis_hold() {
        let mut tb = ThermalBalancer::new();
        let limits = ThermalLimits::default();

        // 88°C GPU triggers EmergencyOffload (0 capacity)
        let tripped = tb.evaluate_node("master-gpu", false, true, 62.0, 88.0, 0.90, 1000, &limits);
        assert_eq!(tripped.state, ThermalState::EmergencyOffload);
        assert_eq!(tripped.capacity_scale, 0.0);

        // Even if GPU drops immediately to 79°C 10s later, 30s hold + 5°C hysteresis blocks re-admission
        let too_soon = tb.evaluate_node("master-gpu", false, true, 60.0, 79.0, 0.70, 1010, &limits);
        assert_eq!(too_soon.state, ThermalState::EmergencyOffload);
        assert_eq!(too_soon.cooldown_remaining_s, 20);

        // After 35s AND dropping >=5°C below shed (83 - 5 = 78°C), node re-admits cleanly
        let cooled = tb.evaluate_node("master-gpu", false, true, 58.0, 76.0, 0.55, 1035, &limits);
        assert_eq!(cooled.state, ThermalState::Cool);
        assert_eq!(cooled.capacity_scale, 1.0);

        // Android 0.98 headroom triggers EmergencyOffload
        let droid_hot = tb.evaluate_node("android-1", true, false, 44.0, 0.0, 0.98, 2000, &limits);
        assert_eq!(droid_hot.state, ThermalState::EmergencyOffload);
        assert_eq!(droid_hot.capacity_scale, 0.0);
    }
}
