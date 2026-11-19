//! `clusterd` — Production-hardened cross-platform distributed compute & RPC orchestrator.
//! Supports Windows (`GlobalMemoryStatusEx`, Job Objects, ADB/Firewall discovery),
//! Linux/Android (`/proc/meminfo` 40%/50% RAM cap, Big-Core sysfs frequency pinning, ARM HWCAP),
//! Raspberry Pi 400 / ARMv8.0 SBCs (`0xd08` Cortex-A72 detection, `vcgencmd` thermal pruning),
//! macOS/Unix (`sysctl hw.memsize`, `vm_stat`, process-group cleanup),
//! Legacy Hardware & Old Graphics fallback (`-ngl 0`, CPU-safe env guards, ES5 Web UI),
//! Zero-Config `clusterd auto` + UDP LAN Auto-Discovery Beacon (`:50050`),
//! Parallel worker health polling (`std::thread::scope`), and the Embedded Central Control Web UI (`/`).

pub mod protocol;
pub mod sys_probe;
pub mod supervisor;
pub mod orchestrator;
pub mod web_ui;
