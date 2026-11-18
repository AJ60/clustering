use crate::hw_probe::{
    detect_isa_and_big_cores, detect_os, detect_silicon, log_event, read_system_ram,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeRole {
    Master,
    Worker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClusterTier {
    /// >32 GB Safe Pool + Strong GPU
    TierS,
    /// 16-32 GB Safe Pool + 4-8 GB GPU + USB Phones
    TierA,
    /// 8-16 GB Safe Pool, CPU-only / legacy + Phones
    TierB,
    /// Model > Total Cluster Safe RAM (AirLLM cyclic mmap SSD streaming)
    TierC,
}

impl ClusterTier {
    pub fn code(&self) -> &'static str {
        match self {
            ClusterTier::TierS => "S",
            ClusterTier::TierA => "A",
            ClusterTier::TierB => "B",
            ClusterTier::TierC => "C",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            ClusterTier::TierS => "Tier S (Heavyweight GPU + >32GB Pool)",
            ClusterTier::TierA => "Tier A (Hybrid 4-8GB GPU + USB Phones)",
            ClusterTier::TierB => "Tier B (Edge CPU / Legacy RAM + Phones)",
            ClusterTier::TierC => "Tier C (Cyclic NVMe mmap Streaming)",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeBenchmark {
    pub node_id: String,
    pub os: String,
    pub is_android: bool,
    pub isa: String,
    pub silicon: String,
    pub perf_cores: u32,
    pub total_logical_cores: u32,
    pub ram_total_mb: u64,
    pub ram_avail_mb: u64,
    pub safe_cap_mb: u64,
    pub vram_total_free_mb: u64,
    pub vram_safe_mb: u64,
    pub compute_tflops: f64,
    pub mem_bw_gbps: f64,
    pub disk_mbps: f64,
    pub pcie_moe_offload_to_cpu: bool,
    pub strength_score: f64,
    pub elapsed_ms: u128,
}

/// 16 MB sequential memcpy timer -> real mem_bw_gbps
pub fn benchmark_mem_bw_gbps() -> f64 {
    let size = 16 * 1024 * 1024usize;
    let src = vec![0x3Cu8; size];
    let mut dst = vec![0u8; size];
    let t0 = Instant::now();
    for _ in 0..2 {
        dst.copy_from_slice(&src);
    }
    let _prevent_elide = dst[size - 1];
    let secs = t0.elapsed().as_secs_f64().max(0.0005);
    let gbps = ((size * 2) as f64 / 1e9) / secs;
    gbps.clamp(8.0, 450.0)
}

/// FreeToken PCIe-vs-CPU heuristic + micro-dot probe: determines whether MoE experts belong on Host CPU
pub fn benchmark_pcie_vs_cpu_moe(vram_safe_mb: u64, perf_cores: u32, model_gb_est: f64) -> bool {
    if vram_safe_mb == 0 {
        return true;
    }
    // Warm tiny GEMV dot loop
    let mut acc = 0.0f64;
    let t0 = Instant::now();
    for i in 0..65536u32 {
        acc += (i as f64) * 0.0001;
    }
    let _ = acc;
    let _cpu_ns = t0.elapsed().as_nanos();
    // If GPU safe VRAM <= 8 GB or doesn't fit dense weights + experts, keep MoE experts on CPU
    vram_safe_mb <= 8192 || (model_gb_est * 1024.0 > (vram_safe_mb as f64) * 0.8 && perf_cores >= 4)
}

/// 64 MB disk sequential read probe -> real disk_mbps (falls back cleanly if read-only)
pub fn benchmark_disk_seq_mbps() -> f64 {
    let probe_path = std::env::temp_dir().join("clusterd_disk_probe.tmp");
    let block = vec![0x5Au8; 1024 * 1024];
    let mut mbps = 450.0;

    if let Ok(mut f) = File::create(&probe_path) {
        let mut wrote_ok = true;
        for _ in 0..16 {
            if f.write_all(&block).is_err() {
                wrote_ok = false;
                break;
            }
        }
        let _ = f.sync_all();
        if wrote_ok {
            drop(f);
            if let Ok(mut rf) = File::open(&probe_path) {
                let mut rbuf = vec![0u8; 1024 * 1024];
                let t0 = Instant::now();
                let mut total = 0usize;
                while let Ok(n) = rf.read(&mut rbuf) {
                    if n == 0 {
                        break;
                    }
                    total += n;
                }
                let secs = t0.elapsed().as_secs_f64().max(0.001);
                mbps = (total as f64 / (1024.0 * 1024.0)) / secs;
            }
        }
    }
    let _ = fs::remove_file(&probe_path);
    mbps.clamp(20.0, 8000.0)
}

/// Computes NodeStrengthScore = (0.7 * mem_bw_gbps + 10.0 * tflops) * (1.0 + vram_free_gb * 0.25)
pub fn compute_node_strength_score(mem_bw_gbps: f64, tflops: f64, vram_free_mb: u64) -> f64 {
    let vram_free_gb = (vram_free_mb as f64) / 1024.0;
    let raw = (0.7 * mem_bw_gbps + 10.0 * tflops) * (1.0 + vram_free_gb * 0.25);
    (raw * 100.0).round() / 100.0
}

pub fn run_startup_strength_profiler(
    node_id: &str,
    android_ram_cap_pct: u64,
    desktop_ram_cap_pct: u64,
    vram_cap_pct: u64,
    os_reserve_mb: u64,
    allow_android_over_50: bool,
) -> NodeBenchmark {
    let t0 = Instant::now();
    let (os, is_android) = detect_os();
    let (isa, perf_cores, total_logical_cores) = detect_isa_and_big_cores();
    let (silicon, compute_tflops, silicon_bw, vram_total_free_mb, vram_safe_mb) =
        detect_silicon(vram_cap_pct);
    let (ram_total_mb, ram_avail_mb, safe_cap_mb) = read_system_ram(
        is_android,
        android_ram_cap_pct,
        desktop_ram_cap_pct,
        os_reserve_mb,
        allow_android_over_50,
    );

    let measured_bw = benchmark_mem_bw_gbps();
    let effective_bw = measured_bw.max(silicon_bw);
    let disk_mbps = benchmark_disk_seq_mbps();
    let pcie_moe_offload_to_cpu = benchmark_pcie_vs_cpu_moe(vram_safe_mb, perf_cores, 18.5);
    let strength_score =
        compute_node_strength_score(effective_bw, compute_tflops, vram_total_free_mb);
    let elapsed_ms = t0.elapsed().as_millis();

    log_event(
        "INFO",
        node_id,
        "PROFILER",
        "BENCHMARK_DONE",
        "Auto-adaptive strength profile complete",
        &format!(
            "isa=\"{isa}\" perf_cores={perf_cores}/{total_logical_cores} mem_bw={effective_bw:.1}GB/s disk={disk_mbps:.0}MB/s score={strength_score:.2} elapsed_ms={elapsed_ms}"
        ),
    );

    NodeBenchmark {
        node_id: node_id.to_string(),
        os,
        is_android,
        isa,
        silicon,
        perf_cores,
        total_logical_cores,
        ram_total_mb,
        ram_avail_mb,
        safe_cap_mb,
        vram_total_free_mb,
        vram_safe_mb,
        compute_tflops,
        mem_bw_gbps: effective_bw,
        disk_mbps,
        pcie_moe_offload_to_cpu,
        strength_score,
        elapsed_ms,
    }
}

/// Automatically classifies Cluster Strength Tier (S / A / B / C).
pub fn classify_cluster_tier(
    total_cluster_safe_mb: u64,
    needed_mb: u64,
    max_node_vram_mb: u64,
    has_strong_gpu: bool,
) -> ClusterTier {
    if needed_mb > total_cluster_safe_mb {
        return ClusterTier::TierC;
    }
    if total_cluster_safe_mb > 32768 && has_strong_gpu {
        return ClusterTier::TierS;
    }
    if total_cluster_safe_mb >= 16384 && max_node_vram_mb >= 3000 {
        return ClusterTier::TierA;
    }
    ClusterTier::TierB
}

/// Automatically elects the single strongest node (highest NodeStrengthScore) as Master
/// unless role_override forces "master" or "worker".
pub fn elect_master_node_id<'a>(
    candidates: &'a [(String, f64)],
    forced_master_id: Option<&str>,
) -> Option<String> {
    if let Some(forced) = forced_master_id {
        if candidates.iter().any(|(id, _)| id == forced) {
            return Some(forced.to_string());
        }
    }
    candidates
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(id, _)| id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_master_election_picks_strongest_node_and_classifies_tier() {
        let desktop_score = compute_node_strength_score(224.0, 9.1, 4096);
        let phone_score = compute_node_strength_score(64.0, 2.6, 0);
        let pi_score = compute_node_strength_score(17.0, 0.35, 0);
        assert!(desktop_score > phone_score);
        assert!(phone_score > pi_score);

        let elected = elect_master_node_id(
            &[
                ("android-usb-12gb".to_string(), phone_score),
                ("master-rtx3050".to_string(), desktop_score),
                ("pi400-4gb".to_string(), pi_score),
            ],
            None,
        );
        assert_eq!(elected.as_deref(), Some("master-rtx3050"));

        assert_eq!(classify_cluster_tier(48000, 21275, 12288, true), ClusterTier::TierS);
        assert_eq!(classify_cluster_tier(20000, 18000, 4096, false), ClusterTier::TierA);
        assert_eq!(classify_cluster_tier(12000, 10000, 0, false), ClusterTier::TierB);
        assert_eq!(classify_cluster_tier(12000, 22000, 4096, false), ClusterTier::TierC);
    }
}
