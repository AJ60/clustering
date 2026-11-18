use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub os: String,
    pub isa: String,
    pub silicon: String,
    pub perf_cores: u32,
    pub total_logical_cores: u32,
    pub compute_tflops: f64,
    pub mem_bw_gbps: f64,
    pub ram_total_mb: u64,
    pub ram_avail_mb: u64,
    pub safe_cap_mb: u64,
    pub vram_total_free_mb: u64,
    pub vram_safe_mb: u64,
    pub is_android: bool,
}

pub fn log_event(level: &str, node_id: &str, stage: &str, code: &str, msg: &str, kv: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{ts}] [{level}] [{node_id}] [{stage}] [{code}] {msg} | {kv}");
    println!("{line}");
    let _ = fs::create_dir_all("logs");
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("logs/cluster.log")
    {
        let _ = writeln!(f, "{line}");
    }
}

pub fn detect_os() -> (String, bool) {
    #[cfg(target_os = "android")]
    {
        if std::path::Path::new("/data/data/com.termux").exists()
            || std::env::var_os("TERMUX_VERSION").is_some()
        {
            return ("android_termux".to_string(), true);
        }
        return ("android_apk".to_string(), true);
    }

    #[cfg(all(not(target_os = "android"), target_os = "linux"))]
    {
        if std::env::var_os("ANDROID_ROOT").is_some()
            || std::path::Path::new("/system/build.prop").exists()
        {
            if std::path::Path::new("/data/data/com.termux").exists()
                || std::env::var_os("TERMUX_VERSION").is_some()
            {
                return ("android_termux".to_string(), true);
            }
            return ("android_apk".to_string(), true);
        }
        return ("linux".to_string(), false);
    }

    #[cfg(target_os = "windows")]
    {
        return ("windows".to_string(), false);
    }

    #[cfg(target_os = "macos")]
    {
        return ("darwin".to_string(), false);
    }

    #[cfg(not(any(
        target_os = "android",
        target_os = "linux",
        target_os = "windows",
        target_os = "macos"
    )))]
    {
        ("unknown".to_string(), false)
    }
}

/// Computes Android vs Desktop/Pi RAM safe caps:
/// - Android: strictly <= min(cap_pct, 50% unless allow_over_50) of physical MemTotal AND MemAvailable - reserve_mb (ignoring SwapFree/zram)
/// - Desktop/Pi: up to desktop_cap_pct% of (MemAvailable - os_reserve_mb), reserving 1024 MB default OS headroom
pub fn compute_ram_safe_cap(
    total_mb: u64,
    avail_mb: u64,
    is_android: bool,
    android_cap_pct: u64,
    desktop_cap_pct: u64,
    os_reserve_mb: u64,
    allow_android_over_50: bool,
) -> u64 {
    let reserve = os_reserve_mb.max(256);
    if is_android {
        let max_pct = if allow_android_over_50 { 85 } else { 50 };
        let bounded_pct = android_cap_pct.clamp(10, max_pct);
        let pct_cap = (total_mb * bounded_pct) / 100;
        let headroom_cap = avail_mb.saturating_sub(reserve.min(512).max(256));
        pct_cap.min(headroom_cap).max(256)
    } else {
        let bounded_pct = desktop_cap_pct.clamp(10, 100);
        let usable = avail_mb.saturating_sub(reserve).max(512);
        ((usable * bounded_pct) / 100).max(512)
    }
}

/// Computes GPU VRAM safe cap: reserves at least 450 MB on 4-8 GB GPUs (or scales via vram_cap_pct%).
pub fn compute_vram_safe_cap(raw_free_vram_mb: u64, vram_cap_pct: u64) -> u64 {
    if raw_free_vram_mb == 0 {
        return 0;
    }
    let bounded_pct = vram_cap_pct.clamp(10, 100);
    let pct_cap = (raw_free_vram_mb * bounded_pct) / 100;
    if raw_free_vram_mb <= 8192 {
        pct_cap.min(raw_free_vram_mb.saturating_sub(450))
    } else {
        pct_cap
    }
}

/// Strictly parses MemTotal and MemAvailable from /proc/meminfo (ignoring SwapFree/zram).
pub fn parse_proc_meminfo_cap(
    meminfo_text: &str,
    is_android: bool,
    android_cap_pct: u64,
    desktop_cap_pct: u64,
    os_reserve_mb: u64,
    allow_android_over_50: bool,
) -> (u64, u64, u64) {
    let mut mem_total_kb: u64 = 0;
    let mut mem_avail_kb: u64 = 0;
    let mut mem_free_kb: u64 = 0;

    for line in meminfo_text.lines() {
        if let Some((key, rest)) = line.split_once(':') {
            let val_kb = rest
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            match key.trim() {
                "MemTotal" => mem_total_kb = val_kb,
                "MemAvailable" => mem_avail_kb = val_kb,
                "MemFree" => mem_free_kb = val_kb,
                _ => {}
            }
        }
    }

    let total_mb = (mem_total_kb / 1024).max(512);
    let avail_mb = if mem_avail_kb > 0 {
        (mem_avail_kb / 1024).max(256)
    } else {
        (mem_free_kb / 1024).max(256)
    };

    let safe_cap_mb = compute_ram_safe_cap(
        total_mb,
        avail_mb,
        is_android,
        android_cap_pct,
        desktop_cap_pct,
        os_reserve_mb,
        allow_android_over_50,
    );

    (total_mb, avail_mb, safe_cap_mb)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn read_system_ram(
    is_android: bool,
    android_cap_pct: u64,
    desktop_cap_pct: u64,
    os_reserve_mb: u64,
    allow_android_over_50: bool,
) -> (u64, u64, u64) {
    if let Ok(content) = fs::read_to_string("/proc/meminfo") {
        return parse_proc_meminfo_cap(
            &content,
            is_android,
            android_cap_pct,
            desktop_cap_pct,
            os_reserve_mb,
            allow_android_over_50,
        );
    }
    let fallback_total = 4096;
    let fallback_avail = 2048;
    let cap = compute_ram_safe_cap(
        fallback_total,
        fallback_avail,
        is_android,
        android_cap_pct,
        desktop_cap_pct,
        os_reserve_mb,
        allow_android_over_50,
    );
    (fallback_total, fallback_avail, cap)
}

#[cfg(target_os = "windows")]
pub fn read_system_ram(
    is_android: bool,
    android_cap_pct: u64,
    desktop_cap_pct: u64,
    os_reserve_mb: u64,
    allow_android_over_50: bool,
) -> (u64, u64, u64) {
    if let Ok(out) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "$o = Get-CimInstance Win32_OperatingSystem; Write-Output ($o.TotalVisibleMemorySize.ToString() + ',' + $o.FreePhysicalMemory.ToString())",
        ])
        .output()
    {
        if out.status.success() {
            let txt = String::from_utf8_lossy(&out.stdout);
            if let Some((t_str, f_str)) = txt.trim().split_once(',') {
                let total_kb = t_str.trim().parse::<u64>().unwrap_or(16 * 1024 * 1024);
                let free_kb = f_str.trim().parse::<u64>().unwrap_or(8 * 1024 * 1024);
                let total_mb = (total_kb / 1024).max(512);
                let avail_mb = (free_kb / 1024).max(256);
                let cap_mb = compute_ram_safe_cap(
                    total_mb,
                    avail_mb,
                    is_android,
                    android_cap_pct,
                    desktop_cap_pct,
                    os_reserve_mb,
                    allow_android_over_50,
                );
                return (total_mb, avail_mb, cap_mb);
            }
        }
    }
    let cap = compute_ram_safe_cap(
        8192,
        4096,
        is_android,
        android_cap_pct,
        desktop_cap_pct,
        os_reserve_mb,
        allow_android_over_50,
    );
    (8192, 4096, cap)
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "windows")))]
pub fn read_system_ram(
    is_android: bool,
    android_cap_pct: u64,
    desktop_cap_pct: u64,
    os_reserve_mb: u64,
    allow_android_over_50: bool,
) -> (u64, u64, u64) {
    let cap = compute_ram_safe_cap(
        8192,
        4096,
        is_android,
        android_cap_pct,
        desktop_cap_pct,
        os_reserve_mb,
        allow_android_over_50,
    );
    (8192, 4096, cap)
}

/// Detects CPU ISA and Big-Core (P-core) thread count, excluding HyperThreads and slow E-cores.
pub fn detect_isa_and_big_cores() -> (String, u32, u32) {
    let logical = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4);

    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default().to_lowercase();
        let isa = if cpuinfo.contains("avx512f") {
            if cpuinfo.contains("amx_tile") {
                "AVX-512 / AMX"
            } else {
                "AVX-512"
            }
        } else if cpuinfo.contains("avx2") {
            "AVX2 / FMA"
        } else if cpuinfo.contains("i8mm") && cpuinfo.contains("asimddp") {
            "ARMv8.2+ DotProd/i8mm"
        } else if cpuinfo.contains("asimddp") {
            "ARMv8.2+ DotProd"
        } else if cfg!(target_arch = "aarch64") {
            "ARMv8.0 NEON"
        } else {
            "x86_64 Baseline"
        }
        .to_string();

        // Check max frequency per core to exclude efficiency E-cores on big.LITTLE / Intel hybrid
        let mut freqs = Vec::new();
        for idx in 0..logical.min(128) {
            let p = format!("/sys/devices/system/cpu/cpu{idx}/cpufreq/cpuinfo_max_freq");
            if let Ok(raw) = fs::read_to_string(&p) {
                if let Ok(khz) = raw.trim().parse::<u64>() {
                    freqs.push(khz);
                }
            }
        }
        let perf_cores = if !freqs.is_empty() {
            let max_khz = *freqs.iter().max().unwrap_or(&0);
            let big = freqs
                .iter()
                .filter(|&&f| f * 100 >= max_khz * 82)
                .count() as u32;
            big.max(1)
        } else if cpuinfo.contains("ht ") || cpuinfo.contains("siblings") {
            (logical / 2).max(2)
        } else {
            logical.max(1)
        };

        return (isa, perf_cores.min(logical), logical);
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let isa = if cfg!(target_arch = "x86_64") {
            "AVX2 / FMA"
        } else if cfg!(target_arch = "aarch64") {
            "ARMv8.2+ NEON"
        } else {
            "Generic"
        }
        .to_string();
        let perf = (logical / 2).max(2).min(logical);
        (isa, perf, logical)
    }
}

pub fn detect_silicon(vram_cap_pct: u64) -> (String, f64, f64, u64, u64) {
    if let Ok(out) = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.free",
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
            if let Some((gpu_name, vram_str)) = line.split_once(',') {
                let raw_vram_mb = vram_str.trim().parse::<u64>().unwrap_or(4096);
                let vram_safe_mb = compute_vram_safe_cap(raw_vram_mb, vram_cap_pct);
                return (
                    format!("NVIDIA {}", gpu_name.trim()),
                    12.0,
                    250.0,
                    raw_vram_mb,
                    vram_safe_mb,
                );
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    let cpuinfo = fs::read_to_string("/proc/cpuinfo")
        .unwrap_or_default()
        .to_lowercase();
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let cpuinfo = String::new();

    if cpuinfo.contains("sm8650") || cpuinfo.contains("snapdragon 8 gen 3") {
        return ("Snapdragon 8 Gen 3/Adreno 750".into(), 3.4, 77.0, 0, 0);
    }
    if cpuinfo.contains("sm8550") || cpuinfo.contains("snapdragon 8 gen 2") {
        return ("Snapdragon 8 Gen 2/Adreno 740".into(), 2.6, 64.0, 0, 0);
    }
    if cpuinfo.contains("snapdragon") || cpuinfo.contains("qcom") {
        return ("Snapdragon/Adreno".into(), 1.85, 34.0, 0, 0);
    }
    if cpuinfo.contains("tensor") || cpuinfo.contains("zuma") {
        return ("Google Tensor/Mali".into(), 2.2, 64.0, 0, 0);
    }
    if cpuinfo.contains("dimensity") || cpuinfo.contains("mtk") {
        return ("MediaTek Dimensity/Mali".into(), 2.4, 60.0, 0, 0);
    }
    if cpuinfo.contains("exynos") || cpuinfo.contains("xclipse") {
        return ("Samsung Exynos/Xclipse".into(), 2.0, 64.0, 0, 0);
    }
    if cfg!(target_os = "macos") {
        return ("Apple Silicon (Metal)".into(), 4.5, 100.0, 0, 0);
    }
    if cfg!(target_os = "windows") {
        let proc_id = std::env::var("PROCESSOR_IDENTIFIER")
            .unwrap_or_default()
            .to_lowercase();
        if proc_id.contains("amd") {
            return ("AMD Ryzen/x86_64".into(), 1.8, 50.0, 0, 0);
        }
        return ("Intel Core/x86_64".into(), 1.5, 45.0, 0, 0);
    }
    if cpuinfo.contains("ryzen") || cpuinfo.contains("amd") {
        return ("AMD Ryzen/Radeon".into(), 1.8, 50.0, 0, 0);
    }
    if cpuinfo.contains("intel") {
        return ("Intel Core/Xeon".into(), 1.5, 45.0, 0, 0);
    }
    if cfg!(target_arch = "aarch64") || cpuinfo.contains("cortex") {
        return ("ARM Cortex-A72".into(), 0.35, 17.0, 0, 0);
    }
    ("Generic CPU".into(), 0.5, 25.0, 0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_50_pct_android_ram_cap_ignoring_zram() {
        let mock_meminfo = "\
MemTotal:        8388608 kB
MemFree:         1048576 kB
MemAvailable:    5242880 kB
SwapTotal:       4194304 kB
SwapFree:        4194304 kB
";
        let (total, avail, cap) = parse_proc_meminfo_cap(mock_meminfo, true, 50, 100, 1024, false);
        assert_eq!(total, 8192);
        assert_eq!(avail, 5120);
        assert_eq!(cap, 4096);
    }

    #[test]
    fn enforces_headroom_floor_on_tight_android_ram() {
        let mock_meminfo = "\
MemTotal:        4194304 kB
MemAvailable:    2048000 kB
SwapFree:        4194304 kB
";
        let (total, avail, cap) = parse_proc_meminfo_cap(mock_meminfo, true, 50, 100, 1024, false);
        assert_eq!(total, 4096);
        assert_eq!(avail, 2000);
        assert_eq!(cap, 1488);
    }

    #[test]
    fn desktop_reserves_1024mb_and_is_not_capped_at_50_pct() {
        let mock_meminfo = "\
MemTotal:        16777216 kB
MemAvailable:    14680064 kB
";
        let (total, avail, cap) = parse_proc_meminfo_cap(mock_meminfo, false, 50, 100, 1024, false);
        assert_eq!(total, 16384);
        assert_eq!(avail, 14336);
        assert_eq!(cap, 13312);
        assert!(cap > total / 2);
    }

    #[test]
    fn vram_safety_reserves_450mb_on_4_to_8gb_gpus() {
        assert_eq!(compute_vram_safe_cap(4096, 90), 3646);
        assert_eq!(compute_vram_safe_cap(4096, 100), 3646);
        assert_eq!(compute_vram_safe_cap(4096, 50), 2048);
    }
}
