//! Strict `#[cfg(target_os = ...)]` Hardware, Physical RAM, Big-Core Pinning,
//! ARMv8 HWCAP, Raspberry Pi 400 (`0xd08` Cortex-A72), Windows `GlobalMemoryStatusEx`,
//! and Cross-Platform LAN IPv4 Auto-Detection Probes.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
#[cfg(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
    target_os = "macos"
))]
use std::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryCapReport {
    pub total_phys_mb: u64,
    pub avail_phys_mb: u64,
    /// Strict safety guardrail:
    /// - Legacy devices (<= 2048 MB RAM): `min(total_phys_mb * 40%, avail_phys_mb.saturating_sub(256))`
    /// - Standard devices (> 2048 MB RAM): `min(total_phys_mb * 50%, avail_phys_mb.saturating_sub(512))`
    pub safe_cap_mb: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CpuTopologyReport {
    pub total_logical_cores: usize,
    pub big_performance_cores: Vec<usize>,
    pub has_arm_dotprod: bool,
    pub has_arm_i8mm: bool,
    pub is_raspberry_pi_400_cortex_a72: bool,
    pub sbc_throttled_bits: u32,
    pub sbc_temp_celsius: Option<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HardwareProfile {
    pub os_name: &'static str,
    pub arch: &'static str,
    pub memory: MemoryCapReport,
    pub cpu: CpuTopologyReport,
    pub lan_ip: Ipv4Addr,
    pub cpu_model: String,
    pub gpu_name: String,
    pub has_vulkan: bool,
    pub is_32_bit: bool,
    pub legacy_hardware: bool,
    pub legacy_graphics: bool,
    pub graphics_tier: &'static str,
    pub recommended_backend: &'static str,
    pub recommended_ngl: u32,
    pub recommended_ctx_size: usize,
}

impl MemoryCapReport {
    pub fn compute_from_raw(total_phys_mb: u64, avail_phys_mb: u64) -> Self {
        let half_total = total_phys_mb / 2;
        let (pct_cap, headroom_mb) = if total_phys_mb <= 2048 {
            (((total_phys_mb * 40) / 100).max(128), 256u64)
        } else {
            (half_total, 512u64)
        };
        let avail_minus_headroom = avail_phys_mb.saturating_sub(headroom_mb).max(128);
        let safe_cap_mb = pct_cap
            .min(avail_minus_headroom)
            .max(128)
            .min(half_total.max(128));
        Self {
            total_phys_mb,
            avail_phys_mb,
            safe_cap_mb,
        }
    }
}

/// Detects old/weak GPUs or software rasterizers that should avoid Vulkan/shader offload (`-ngl 0`).
pub fn is_legacy_gpu_name(gpu_name: &str) -> bool {
    let lower = gpu_name.to_lowercase();
    const LEGACY_GPU_MARKERS: [&str; 26] = [
        "llvmpipe",
        "softpipe",
        "swiftshader",
        "microsoft basic render",
        "basic / legacy",
        "legacy framebuffer",
        "no vulkan",
        "intel gma",
        "hd graphics 2",
        "hd graphics 3",
        "hd graphics 4",
        "hd graphics 5",
        "bay trail",
        "braswell",
        "geforce 8",
        "geforce 9",
        "geforce 2",
        "geforce 4",
        "geforce gt 6",
        "geforce gt 7",
        "radeon hd",
        "adreno 3",
        "adreno 4",
        "mali-4",
        "mali-t6",
        "powervr",
    ];
    LEGACY_GPU_MARKERS.iter().any(|m| lower.contains(m))
}

/// Detects low-power / legacy CPUs (<= 2 cores, ARMv7/32-bit, or early Atom/Celeron/Pentium/Core2/A72).
pub fn is_legacy_cpu_model(cpu_model: &str, logical_cores: usize, has_dotprod: bool) -> bool {
    if logical_cores <= 2 {
        return true;
    }
    let lower = cpu_model.to_lowercase();
    const LEGACY_CPU_MARKERS: [&str; 14] = [
        "core 2",
        "core(tm)2",
        "pentium",
        "celeron",
        "atom",
        "sempron",
        "athlon 64",
        "athlon ii",
        "armv6",
        "armv7",
        "cortex-a7",
        "cortex-a9",
        "cortex-a53",
        "cortex-a72",
    ];
    if LEGACY_CPU_MARKERS.iter().any(|m| lower.contains(m)) {
        return true;
    }
    cfg!(target_pointer_width = "32") || (cfg!(target_arch = "aarch64") && !has_dotprod)
}

/// Child-process environment variables that force CPU-safe software paths on old GPUs.
pub fn recommended_child_env(legacy_graphics: bool) -> Vec<(&'static str, &'static str)> {
    if legacy_graphics {
        vec![
            ("GGML_VK_VISIBLE_DEVICES", ""),
            ("GGML_CUDA_DISABLE", "1"),
            ("LIBGL_ALWAYS_SOFTWARE", "1"),
            ("MESA_GL_VERSION_OVERRIDE", "3.3"),
        ]
    } else {
        Vec::new()
    }
}

/// Detects the host's primary non-loopback LAN IPv4 address using a zero-packet UDP
/// routing table query (works identically on Windows, Linux, macOS, and Android).
/// Falls back to `127.0.0.1` if offline.
pub fn detect_lan_ipv4() -> Ipv4Addr {
    for probe_target in ["192.168.1.1:80", "10.0.0.1:80", "8.8.8.8:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(probe_target).is_ok() {
                if let Ok(local) = sock.local_addr() {
                    if let IpAddr::V4(ip) = local.ip() {
                        if !ip.is_loopback() && !ip.is_unspecified() {
                            return ip;
                        }
                    }
                }
            }
        }
    }
    Ipv4Addr::LOCALHOST
}

// ============================================================================
// 1. WINDOWS (`#[cfg(target_os = "windows")]`)
//    Uses kernel32.dll `GlobalMemoryStatusEx`, auto-detects `adb.exe`, and
//    verifies Windows Defender Firewall rules for ports 8080,8081,50050-50052.
// ============================================================================
#[cfg(target_os = "windows")]
mod os_impl {
    use super::*;
    use std::env;
    use std::mem;

    #[repr(C)]
    #[allow(non_camel_case_types, dead_code)]
    struct MEMORYSTATUSEX {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MEMORYSTATUSEX) -> i32;
    }

    pub fn probe_physical_memory() -> MemoryCapReport {
        unsafe {
            let mut stat: MEMORYSTATUSEX = mem::zeroed();
            stat.dw_length = mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut stat as *mut MEMORYSTATUSEX) != 0 {
                let total_mb = (stat.ull_total_phys / (1024 * 1024)).max(512);
                let avail_mb = (stat.ull_avail_phys / (1024 * 1024)).max(256);
                return MemoryCapReport::compute_from_raw(total_mb, avail_mb);
            }
        }
        MemoryCapReport::compute_from_raw(8192, 4096)
    }

    pub fn probe_cpu_topology() -> CpuTopologyReport {
        let total = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        // Reserve half of logical threads (physical P-cores equivalent on SMT CPUs)
        let big_count = (total / 2).max(1);
        CpuTopologyReport {
            total_logical_cores: total,
            big_performance_cores: (0..big_count).collect(),
            has_arm_dotprod: false,
            has_arm_i8mm: false,
            is_raspberry_pi_400_cortex_a72: false,
            sbc_throttled_bits: 0,
            sbc_temp_celsius: None,
        }
    }

    /// Auto-detects `adb.exe` in `PATH` or `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
    pub fn find_windows_adb_executable() -> Option<PathBuf> {
        if let Ok(path_var) = env::var("PATH") {
            for dir in env::split_paths(&path_var) {
                let candidate = dir.join("adb.exe");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            let sdk_candidate = PathBuf::from(local_app_data)
                .join("Android")
                .join("Sdk")
                .join("platform-tools")
                .join("adb.exe");
            if sdk_candidate.is_file() {
                return Some(sdk_candidate);
            }
        }
        None
    }

    /// Checks Windows Defender Firewall rules for clusterd ports 8080,8081,50050-50052
    pub fn check_windows_firewall_ports() -> Result<bool, String> {
        let output = Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "show",
                "rule",
                "name=all",
            ])
            .output()
            .map_err(|e| format!("Failed to invoke netsh advfirewall: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let rules_present = stdout.contains("50052")
            || stdout.contains("8080")
            || stdout.contains("ClusterLab");
        Ok(rules_present)
    }

    pub fn probe_cpu_and_gpu_details() -> (String, String, bool) {
        let cpu_model = env::var("PROCESSOR_IDENTIFIER")
            .unwrap_or_else(|_| "Windows x86_64 CPU".to_string());
        let windir = env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
        let vulkan_dll = Path::new(&windir).join("System32").join("vulkan-1.dll");
        let has_vulkan = vulkan_dll.is_file() && cfg!(target_pointer_width = "64");
        let gpu_name = if has_vulkan {
            "Windows Vulkan Adapter".to_string()
        } else {
            "Microsoft Basic / Legacy Display Adapter".to_string()
        };
        (cpu_model, gpu_name, has_vulkan)
    }

    pub fn os_name() -> &'static str {
        "Windows"
    }
}

// ============================================================================
// 2. LINUX & ANDROID (`#[cfg(any(target_os = "linux", target_os = "android"))]`)
//    Strictly parses `/proc/meminfo` (`MemTotal`, `MemAvailable`, ignoring SwapFree/zram),
//    pins Big Performance cores via `/sys/devices/system/cpu/cpuN/cpufreq/cpuinfo_max_freq`,
//    inspects `getauxval(AT_HWCAP)` + `/proc/cpuinfo` for ARM DotProd/i8mm,
//    and detects Raspberry Pi 400 (`CPU part : 0xd08`) + `vcgencmd`.
// ============================================================================
#[cfg(any(target_os = "linux", target_os = "android"))]
mod os_impl {
    use super::*;
    use std::fs;

    #[cfg(target_arch = "aarch64")]
    const AT_HWCAP: u64 = 16;
    #[cfg(target_arch = "aarch64")]
    const AT_HWCAP2: u64 = 26;
    #[cfg(target_arch = "aarch64")]
    const HWCAP_ASIMDDP: u64 = 1 << 20;
    #[cfg(target_arch = "aarch64")]
    const HWCAP2_I8MM: u64 = 1 << 13;

    #[cfg(target_arch = "aarch64")]
    extern "C" {
        fn getauxval(type_: u64) -> u64;
    }

    pub fn probe_physical_memory() -> MemoryCapReport {
        let content = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        parse_proc_meminfo(&content)
    }

    pub fn probe_cpu_topology() -> CpuTopologyReport {
        let total = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);

        let mut core_freqs: Vec<(usize, u64)> = Vec::new();
        for core_id in 0..total {
            let path = format!(
                "/sys/devices/system/cpu/cpu{}/cpufreq/cpuinfo_max_freq",
                core_id
            );
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(freq) = raw.trim().parse::<u64>() {
                    if freq > 0 {
                        core_freqs.push((core_id, freq));
                    }
                }
            }
        }

        let big_cores: Vec<usize> = if core_freqs.len() >= 2 {
            let max_freq = core_freqs.iter().map(|(_, f)| *f).max().unwrap_or(0);
            let threshold = (max_freq * 80) / 100;
            let mut filtered: Vec<usize> = core_freqs
                .into_iter()
                .filter(|(_, f)| *f >= threshold)
                .map(|(id, _)| id)
                .collect();
            if filtered.is_empty() {
                filtered.push(0);
            }
            filtered
        } else {
            (0..total).collect()
        };

        let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let cpuinfo_lower = cpuinfo.to_lowercase();

        let mut has_dotprod =
            cpuinfo_lower.contains("asimddp") || cpuinfo_lower.contains("dotprod");
        let mut has_i8mm = cpuinfo_lower.contains("i8mm");

        #[cfg(target_arch = "aarch64")]
        unsafe {
            let hwcap = getauxval(AT_HWCAP);
            let hwcap2 = getauxval(AT_HWCAP2);
            if (hwcap & HWCAP_ASIMDDP) != 0 {
                has_dotprod = true;
            }
            if (hwcap2 & HWCAP2_I8MM) != 0 {
                has_i8mm = true;
            }
        }

        // Detect Raspberry Pi 400 / BCM2711 Cortex-A72 (CPU part == 0xd08, ARMv8.0 without dotprod)
        let is_cortex_a72 = cpuinfo_lower.contains("0xd08") && !has_dotprod;
        let (throttled_bits, temp_c) = if is_cortex_a72 {
            query_raspberry_pi_vcgencmd()
        } else {
            (0, read_linux_sysfs_thermal_celsius())
        };

        CpuTopologyReport {
            total_logical_cores: total,
            big_performance_cores: big_cores,
            has_arm_dotprod: has_dotprod,
            has_arm_i8mm: has_i8mm,
            is_raspberry_pi_400_cortex_a72: is_cortex_a72,
            sbc_throttled_bits: throttled_bits,
            sbc_temp_celsius: temp_c,
        }
    }

    fn query_raspberry_pi_vcgencmd() -> (u32, Option<f32>) {
        let mut throttled = 0u32;
        if let Ok(out) = Command::new("vcgencmd").arg("get_throttled").output() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(hex) = s.trim().strip_prefix("throttled=0x") {
                throttled = u32::from_str_radix(hex, 16).unwrap_or(0);
            }
        }
        let mut temp_c = None;
        if let Ok(out) = Command::new("vcgencmd").arg("measure_temp").output() {
            let s = String::from_utf8_lossy(&out.stdout);
            // Format: temp=51.2'C
            if let Some(inner) = s.trim().strip_prefix("temp=") {
                let num_part = inner.trim_end_matches("'C");
                temp_c = num_part.parse::<f32>().ok();
            }
        }
        if temp_c.is_none() {
            temp_c = read_linux_sysfs_thermal_celsius();
        }
        (throttled, temp_c)
    }

    fn read_linux_sysfs_thermal_celsius() -> Option<f32> {
        let entries = fs::read_dir("/sys/class/thermal").ok()?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("thermal_zone") {
                if let Ok(raw) = fs::read_to_string(entry.path().join("temp")) {
                    if let Ok(val) = raw.trim().parse::<i64>() {
                        let c = if val > 1000 {
                            (val as f32) / 1000.0
                        } else {
                            val as f32
                        };
                        if (15.0..=105.0).contains(&c) {
                            return Some(c);
                        }
                    }
                }
            }
        }
        None
    }

    pub fn probe_cpu_and_gpu_details() -> (String, String, bool) {
        let cpuinfo = fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let mut cpu_model = String::new();
        for line in cpuinfo.lines() {
            if let Some((_, rhs)) = line.split_once(':') {
                let key = line.split(':').next().unwrap_or("").trim();
                if matches!(key, "model name" | "Hardware" | "Processor") {
                    let trimmed = rhs.trim();
                    if !trimmed.is_empty() {
                        cpu_model = trimmed.to_string();
                        break;
                    }
                }
            }
        }
        if cpu_model.is_empty() {
            cpu_model = if cfg!(target_arch = "aarch64") {
                "ARM64 Linux/Android CPU".to_string()
            } else {
                "Linux CPU".to_string()
            };
        }

        let vulkan_paths = [
            "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
            "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
            "/usr/lib/libvulkan.so.1",
            "/usr/lib64/libvulkan.so.1",
            "/system/lib64/libvulkan.so",
            "/system/lib/libvulkan.so",
        ];
        let has_vulkan_loader = vulkan_paths.iter().any(|p| Path::new(p).exists());
        let has_render_node = Path::new("/dev/dri/renderD128").exists()
            || Path::new("/dev/kgsl-3d0").exists()
            || Path::new("/dev/mali0").exists();
        let has_vulkan = has_vulkan_loader && has_render_node;

        let gpu_name = if has_vulkan {
            "DRM / Mobile Vulkan GPU".to_string()
        } else if Path::new("/dev/dri/card0").exists() {
            "Legacy Framebuffer / llvmpipe".to_string()
        } else {
            "Headless / No Vulkan GPU".to_string()
        };

        (cpu_model, gpu_name, has_vulkan)
    }

    pub fn os_name() -> &'static str {
        #[cfg(target_os = "android")]
        {
            "Android"
        }
        #[cfg(not(target_os = "android"))]
        {
            "Linux"
        }
    }
}

// ============================================================================
// 3. MACOS (`#[cfg(target_os = "macos")]`)
//    Uses `sysctl hw.memsize` + `vm_stat` with dynamic page size parsing
//    (4096 bytes on Intel Macs, 16384 bytes on Apple Silicon M1/M2/M3/M4).
// ============================================================================
#[cfg(target_os = "macos")]
mod os_impl {
    use super::*;

    pub fn probe_physical_memory() -> MemoryCapReport {
        let mut total_mb = 8192u64;
        if let Ok(out) = Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
            if let Ok(bytes) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
                total_mb = (bytes / (1024 * 1024)).max(1024);
            }
        }

        let mut avail_mb = total_mb / 2;
        if let Ok(out) = Command::new("vm_stat").output() {
            let text = String::from_utf8_lossy(&out.stdout);
            avail_mb = parse_macos_vm_stat_avail_mb(&text).unwrap_or(total_mb / 2);
        }
        MemoryCapReport::compute_from_raw(total_mb, avail_mb)
    }

    pub fn probe_cpu_topology() -> CpuTopologyReport {
        let total = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        CpuTopologyReport {
            total_logical_cores: total,
            big_performance_cores: (0..total).collect(),
            has_arm_dotprod: cfg!(target_arch = "aarch64"),
            has_arm_i8mm: false,
            is_raspberry_pi_400_cortex_a72: false,
            sbc_throttled_bits: 0,
            sbc_temp_celsius: None,
        }
    }

    pub fn probe_cpu_and_gpu_details() -> (String, String, bool) {
        let mut cpu_model = "Apple Mac CPU".to_string();
        if let Ok(out) = Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !text.is_empty() {
                cpu_model = text;
            }
        }
        let is_apple_silicon = cfg!(target_arch = "aarch64");
        let gpu_name = if is_apple_silicon {
            "Apple Silicon Metal GPU".to_string()
        } else {
            "Intel Mac Graphics (CPU-Safe Fallback)".to_string()
        };
        (cpu_model, gpu_name, is_apple_silicon)
    }

    pub fn os_name() -> &'static str {
        "macOS"
    }
}

// ============================================================================
// 4. OTHER UNIX (FreeBSD / OpenBSD / NetBSD fallback)
// ============================================================================
#[cfg(not(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
    target_os = "macos"
)))]
mod os_impl {
    use super::*;

    pub fn probe_physical_memory() -> MemoryCapReport {
        MemoryCapReport::compute_from_raw(4096, 2048)
    }

    pub fn probe_cpu_topology() -> CpuTopologyReport {
        let total = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        CpuTopologyReport {
            total_logical_cores: total,
            big_performance_cores: (0..total).collect(),
            has_arm_dotprod: false,
            has_arm_i8mm: false,
            is_raspberry_pi_400_cortex_a72: false,
            sbc_throttled_bits: 0,
            sbc_temp_celsius: None,
        }
    }

    pub fn probe_cpu_and_gpu_details() -> (String, String, bool) {
        (
            "Unix CPU".to_string(),
            "Legacy Framebuffer".to_string(),
            false,
        )
    }

    pub fn os_name() -> &'static str {
        "Unix"
    }
}

/// Pure parser for macOS `vm_stat` output supporting both 4096-byte (x86_64)
/// and 16384-byte (Apple Silicon) page sizes.
pub fn parse_macos_vm_stat_avail_mb(vm_stat_output: &str) -> Option<u64> {
    let mut page_size: u64 = 4096;
    if let Some(first_line) = vm_stat_output.lines().next() {
        if let Some(pos) = first_line.find("page size of ") {
            let rest = &first_line[pos + "page size of ".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(parsed) = digits.parse::<u64>() {
                if parsed >= 4096 {
                    page_size = parsed;
                }
            }
        }
    }
    let mut free_pages = 0u64;
    for line in vm_stat_output.lines() {
        if line.starts_with("Pages free:") || line.starts_with("Pages inactive:") {
            let digits: String = line.chars().filter(|c| c.is_ascii_digit()).collect();
            if let Ok(p) = digits.parse::<u64>() {
                free_pages += p;
            }
        }
    }
    if free_pages > 0 {
        Some(((free_pages * page_size) / (1024 * 1024)).max(512))
    } else {
        None
    }
}

/// Pure parser for `/proc/meminfo` that strictly reads `MemTotal` and `MemAvailable`
/// while ignoring `SwapFree`, `SwapTotal`, and `zram`.
pub fn parse_proc_meminfo(meminfo_content: &str) -> MemoryCapReport {
    let mut total_kb: u64 = 4_194_304;
    let mut avail_kb: u64 = 2_097_152;

    for line in meminfo_content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            if let Some(tok) = rest.split_whitespace().next() {
                if let Ok(v) = tok.parse::<u64>() {
                    total_kb = v;
                }
            }
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            if let Some(tok) = rest.split_whitespace().next() {
                if let Ok(v) = tok.parse::<u64>() {
                    avail_kb = v;
                }
            }
        }
        // SwapFree / SwapTotal / Zram are intentionally ignored
    }

    let total_mb = (total_kb / 1024).max(256);
    let avail_mb = (avail_kb / 1024).max(128);
    MemoryCapReport::compute_from_raw(total_mb, avail_mb)
}

pub fn probe_system_memory() -> MemoryCapReport {
    os_impl::probe_physical_memory()
}

pub fn probe_system_cpu() -> CpuTopologyReport {
    os_impl::probe_cpu_topology()
}

pub fn current_os_name() -> &'static str {
    os_impl::os_name()
}

/// Checks Windows Defender Firewall rules (no-op `Ok(true)` on Unix/Linux/macOS/Android).
pub fn check_windows_firewall_ports() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        os_impl::check_windows_firewall_ports()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(true)
    }
}

/// Builds a unified hardware & legacy-survival profile (used by `probe`, `worker`, `master`, `auto`).
pub fn probe_hardware_profile() -> HardwareProfile {
    let memory = probe_system_memory();
    let cpu = probe_system_cpu();
    let lan_ip = detect_lan_ipv4();
    let (cpu_model, gpu_name, has_vulkan) = os_impl::probe_cpu_and_gpu_details();
    let is_32_bit = cfg!(target_pointer_width = "32");

    let force_legacy_hw = matches!(
        std::env::var("CLUSTERD_LEGACY_HARDWARE").as_deref(),
        Ok("1" | "true" | "TRUE")
    );
    let force_legacy_gfx = matches!(
        std::env::var("CLUSTERD_LEGACY_GRAPHICS").as_deref(),
        Ok("1" | "true" | "TRUE")
    );

    let legacy_hardware = force_legacy_hw
        || memory.total_phys_mb <= 3072
        || cpu.is_raspberry_pi_400_cortex_a72
        || is_32_bit
        || is_legacy_cpu_model(&cpu_model, cpu.total_logical_cores, cpu.has_arm_dotprod);

    let legacy_graphics =
        force_legacy_gfx || !has_vulkan || is_legacy_gpu_name(&gpu_name) || legacy_hardware;

    let graphics_tier = if legacy_graphics {
        "legacy-cpu-safe"
    } else {
        "vulkan-accelerated"
    };
    let recommended_backend = if legacy_graphics {
        "cpu-only (-ngl 0)"
    } else {
        "vulkan-hybrid (-ngl 99)"
    };
    let recommended_ngl = if legacy_graphics { 0 } else { 99 };
    let recommended_ctx_size = if legacy_hardware { 1024 } else { 2048 };

    HardwareProfile {
        os_name: current_os_name(),
        arch: std::env::consts::ARCH,
        memory,
        cpu,
        lan_ip,
        cpu_model,
        gpu_name,
        has_vulkan,
        is_32_bit,
        legacy_hardware,
        legacy_graphics,
        graphics_tier,
        recommended_backend,
        recommended_ngl,
        recommended_ctx_size,
    }
}

/// Auto-discovers `adb` / `adb.exe` across Windows, Linux, and macOS for plug-and-play
/// USB `adb forward tcp:50052 tcp:50052` tunneling.
pub fn locate_adb_binary() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return os_impl::find_windows_adb_executable();
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join("adb");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let linux_sdk = PathBuf::from(&home).join("Android/Sdk/platform-tools/adb");
            if linux_sdk.is_file() {
                return Some(linux_sdk);
            }
            let mac_sdk = PathBuf::from(&home).join("Library/Android/sdk/platform-tools/adb");
            if mac_sdk.is_file() {
                return Some(mac_sdk);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strict_50_percent_ram_cap_ignores_swap() {
        let sample = "\
MemTotal:        4096000 kB
MemFree:          450000 kB
MemAvailable:    3200000 kB
SwapTotal:       4096000 kB
SwapFree:        4096000 kB
";
        let report = parse_proc_meminfo(sample);
        assert_eq!(report.total_phys_mb, 4000);
        assert_eq!(report.avail_phys_mb, 3125);
        assert_eq!(report.safe_cap_mb, 2000);
        assert!(report.safe_cap_mb <= report.total_phys_mb / 2);
    }

    #[test]
    fn test_low_available_ram_subtracts_512mb_headroom() {
        let sample = "\
MemTotal:        4096000 kB
MemAvailable:    1536000 kB
SwapFree:        8192000 kB
";
        let report = parse_proc_meminfo(sample);
        assert_eq!(report.total_phys_mb, 4000);
        assert_eq!(report.avail_phys_mb, 1500);
        assert_eq!(report.safe_cap_mb, 988);
    }

    #[test]
    fn test_macos_apple_silicon_16kb_vm_stat_parsing() {
        let sample = "\
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               131072.
Pages inactive:                           131072.
";
        // 262144 pages * 16384 bytes = 4096 MB
        let avail_mb = parse_macos_vm_stat_avail_mb(sample).expect("parse vm_stat");
        assert_eq!(avail_mb, 4096);
    }

    #[test]
    fn test_live_os_memory_probe_never_exceeds_50_percent() {
        let report = probe_system_memory();
        assert!(report.total_phys_mb >= 256);
        assert!(report.safe_cap_mb <= report.total_phys_mb / 2);
    }

    #[test]
    fn test_live_os_cpu_topology_probe() {
        let cpu = probe_system_cpu();
        assert!(cpu.total_logical_cores >= 1);
        assert!(!cpu.big_performance_cores.is_empty());
    }

    #[test]
    fn test_legacy_hardware_40_percent_ram_cap_and_gpu_detection() {
        let report = MemoryCapReport::compute_from_raw(1024, 768);
        assert_eq!(report.safe_cap_mb, 409);
        assert!(report.safe_cap_mb <= (report.total_phys_mb * 40) / 100);

        assert!(is_legacy_gpu_name("Intel(R) HD Graphics 4000"));
        assert!(is_legacy_gpu_name("llvmpipe (LLVM 15.0.7, 256 bits)"));
        assert!(!is_legacy_gpu_name("NVIDIA GeForce RTX 4070"));

        assert!(is_legacy_cpu_model("Intel(R) Core(TM)2 Duo CPU", 2, false));
        assert!(!recommended_child_env(true).is_empty());
        assert!(recommended_child_env(false).is_empty());

        let profile = probe_hardware_profile();
        assert!(!profile.arch.is_empty());
        assert!(check_windows_firewall_ports().is_ok());
    }
}
