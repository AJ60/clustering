//! 32-Byte Deterministic `GGUF` / RPC v9 / `v1.0.0` Handshake & Emergency `SHED_LAYERS` Frame Protocol.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const GGUF_MAGIC: &[u8; 4] = b"GGUF";
pub const RPC_PROTOCOL_VERSION: u32 = 9;
pub const LLAMA_CPP_VERSION_TAG: &[u8; 8] = b"v1.0.0\0\0";

pub const STATUS_READY: u32 = 0;
pub const STATUS_THROTTLED_THERMAL: u32 = 1;
pub const STATUS_SHED_LAYERS: u32 = 2;

pub const FLAG_VULKAN_FP16: u32 = 1 << 0;
pub const FLAG_ARM_DOTPROD: u32 = 1 << 1;
pub const FLAG_ELF_16KB_ALIGNED: u32 = 1 << 2;
pub const FLAG_SBC_CORTEX_A72: u32 = 1 << 3;

// Platform identity bits (backward-compatible extension in bits 4..7 of flags)
pub const FLAG_PLATFORM_WINDOWS: u32 = 1 << 4;
pub const FLAG_PLATFORM_LINUX: u32 = 1 << 5;
pub const FLAG_PLATFORM_ANDROID: u32 = 1 << 6;
pub const FLAG_PLATFORM_MACOS: u32 = 1 << 7;
// Legacy hardware & graphics survival bits (bits 8..9)
pub const FLAG_LEGACY_HARDWARE: u32 = 1 << 8;
pub const FLAG_LEGACY_GRAPHICS: u32 = 1 << 9;

pub const DEFAULT_CLUSTER_SECRET: &str = "clusterd-default-hmac-key";
pub const HANDSHAKE_CHALLENGE: &[u8] = b"GGUF_PROBE_V9";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeFrame {
    pub protocol_version: u32,
    pub llama_version: String,
    pub safe_cap_mb: u32,
    pub big_cores: u32,
    pub flags: u32,
    pub status: u32,
}

impl HandshakeFrame {
    pub fn new(safe_cap_mb: u32, big_cores: u32, flags: u32, status: u32) -> Self {
        Self {
            protocol_version: RPC_PROTOCOL_VERSION,
            llama_version: "v1.0.0".to_string(),
            safe_cap_mb,
            big_cores,
            flags,
            status,
        }
    }

    pub fn is_edge_sbc_a72(&self) -> bool {
        (self.flags & FLAG_SBC_CORTEX_A72) != 0
    }

    pub fn is_vulkan_fp16(&self) -> bool {
        (self.flags & FLAG_VULKAN_FP16) != 0
    }

    pub fn is_legacy_hardware(&self) -> bool {
        (self.flags & FLAG_LEGACY_HARDWARE) != 0
    }

    pub fn is_legacy_graphics(&self) -> bool {
        (self.flags & FLAG_LEGACY_GRAPHICS) != 0
    }

    pub fn status_label(&self) -> &'static str {
        match self.status {
            STATUS_READY => "Ready",
            STATUS_THROTTLED_THERMAL => "Throttled",
            STATUS_SHED_LAYERS => "SheddingMemory",
            _ => "Unknown",
        }
    }

    pub fn platform_label(&self) -> &'static str {
        if self.is_edge_sbc_a72() {
            "Edge SBC (Linux ARM64)"
        } else if (self.flags & FLAG_PLATFORM_WINDOWS) != 0 {
            "Windows"
        } else if (self.flags & FLAG_PLATFORM_ANDROID) != 0 {
            "Android"
        } else if (self.flags & FLAG_PLATFORM_MACOS) != 0 {
            "macOS"
        } else if (self.flags & FLAG_PLATFORM_LINUX) != 0 {
            "Linux"
        } else {
            "Mixed Node"
        }
    }

    pub fn current_os_platform_flag() -> u32 {
        #[cfg(target_os = "windows")]
        {
            FLAG_PLATFORM_WINDOWS
        }
        #[cfg(target_os = "android")]
        {
            FLAG_PLATFORM_ANDROID
        }
        #[cfg(target_os = "linux")]
        {
            FLAG_PLATFORM_LINUX
        }
        #[cfg(target_os = "macos")]
        {
            FLAG_PLATFORM_MACOS
        }
        #[cfg(not(any(
            target_os = "windows",
            target_os = "android",
            target_os = "linux",
            target_os = "macos"
        )))]
        {
            FLAG_PLATFORM_LINUX
        }
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        let mut buf = [0u8; 32];
        buf[0..4].copy_from_slice(GGUF_MAGIC);
        buf[4..8].copy_from_slice(&self.protocol_version.to_le_bytes());
        buf[8..16].copy_from_slice(LLAMA_CPP_VERSION_TAG);
        buf[16..20].copy_from_slice(&self.safe_cap_mb.to_le_bytes());
        buf[20..24].copy_from_slice(&self.big_cores.to_le_bytes());
        buf[24..28].copy_from_slice(&self.flags.to_le_bytes());
        buf[28..32].copy_from_slice(&self.status.to_le_bytes());
        buf
    }

    pub fn from_bytes(buf: &[u8; 32]) -> Result<Self, String> {
        if &buf[0..4] != GGUF_MAGIC {
            return Err(format!("Invalid magic bytes: {:?}", &buf[0..4]));
        }
        let protocol_version = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        if protocol_version != RPC_PROTOCOL_VERSION {
            return Err(format!(
                "RPC protocol version mismatch: expected {}, got {}",
                RPC_PROTOCOL_VERSION, protocol_version
            ));
        }
        let raw_tag = &buf[8..16];
        let nul_pos = raw_tag.iter().position(|&b| b == 0).unwrap_or(raw_tag.len());
        let llama_version = String::from_utf8_lossy(&raw_tag[..nul_pos]).to_string();
        if llama_version != "v1.0.0" {
            return Err(format!(
                "Incompatible llama.cpp version tag: expected 'v1.0.0', got '{}'",
                llama_version
            ));
        }
        let safe_cap_mb = u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]);
        let big_cores = u32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]);
        let flags = u32::from_le_bytes([buf[24], buf[25], buf[26], buf[27]]);
        let status = u32::from_le_bytes([buf[28], buf[29], buf[30], buf[31]]);

        Ok(Self {
            protocol_version,
            llama_version,
            safe_cap_mb,
            big_cores,
            flags,
            status,
        })
    }
}

/// Computes a deterministic 32-byte keyed auth token for Wi-Fi `cluster_secret` authentication
/// using only the Rust standard library. Bit-exact mirror exists in Android `RpcService.kt`.
pub fn compute_cluster_auth_token(secret: &str, challenge: &[u8]) -> [u8; 32] {
    let mut state: [u64; 4] = [
        0x6a09e667f3bcc908,
        0xbb67ae8584caa73b,
        0x3c6ef372fe94f82b,
        0xa54ff53a5f1d36f1,
    ];
    for (i, &b) in secret.as_bytes().iter().chain(challenge.iter()).enumerate() {
        let lane = i & 3;
        state[lane] = state[lane]
            .wrapping_add((b as u64).wrapping_mul(0x9e3779b97f4a7c15))
            .rotate_left(13)
            ^ state[(lane + 1) & 3];
    }
    for round in 0..8 {
        for lane in 0..4 {
            state[lane] = state[lane]
                .wrapping_mul(0xbf58476d1ce4e5b9)
                .wrapping_add(round as u64)
                .rotate_right(17);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[i * 8..(i + 1) * 8].copy_from_slice(&word.to_le_bytes());
    }
    out
}

/// Constant-time comparison of two 32-byte auth tokens.
pub fn verify_cluster_auth_token(secret: &str, received: &[u8]) -> bool {
    if received.len() != 32 {
        return false;
    }
    let expected = compute_cluster_auth_token(secret, HANDSHAKE_CHALLENGE);
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= expected[i] ^ received[i];
    }
    diff == 0
}

pub fn probe_worker_handshake(
    addr: SocketAddr,
    cluster_secret: Option<&str>,
    timeout: Duration,
) -> io::Result<HandshakeFrame> {
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let _ = stream.set_nodelay(true);

    let token = compute_cluster_auth_token(
        cluster_secret.unwrap_or(DEFAULT_CLUSTER_SECRET),
        HANDSHAKE_CHALLENGE,
    );
    stream.write_all(&token)?;
    stream.flush()?;

    let mut resp = [0u8; 32];
    stream.read_exact(&mut resp)?;
    HandshakeFrame::from_bytes(&resp).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_32_byte_gguf_handshake_roundtrip_and_platform_flags() {
        let frame = HandshakeFrame::new(
            1850,
            4,
            FLAG_ARM_DOTPROD | FLAG_ELF_16KB_ALIGNED | FLAG_PLATFORM_ANDROID,
            STATUS_READY,
        );
        let bytes = frame.to_bytes();
        assert_eq!(bytes.len(), 32);
        assert_eq!(&bytes[0..4], b"GGUF");

        let decoded = HandshakeFrame::from_bytes(&bytes).expect("valid 32-byte frame");
        assert_eq!(decoded, frame);
        assert_eq!(decoded.platform_label(), "Android");

        let win_frame = HandshakeFrame::new(4096, 8, FLAG_PLATFORM_WINDOWS, STATUS_READY);
        assert_eq!(win_frame.platform_label(), "Windows");

        let linux_frame = HandshakeFrame::new(2048, 6, FLAG_PLATFORM_LINUX, STATUS_READY);
        assert_eq!(linux_frame.platform_label(), "Linux");

        let sbc_frame = HandshakeFrame::new(1500, 4, FLAG_SBC_CORTEX_A72 | FLAG_PLATFORM_LINUX, STATUS_READY);
        assert_eq!(sbc_frame.platform_label(), "Edge SBC (Linux ARM64)");
    }

    #[test]
    fn test_rejects_mismatched_version() {
        let mut bytes = HandshakeFrame::new(1024, 2, 0, STATUS_READY).to_bytes();
        bytes[4] = 8; // Old protocol v8
        assert!(HandshakeFrame::from_bytes(&bytes).is_err());
    }

    #[test]
    fn test_auth_token_verification() {
        let token = compute_cluster_auth_token("my-secret", HANDSHAKE_CHALLENGE);
        assert!(verify_cluster_auth_token("my-secret", &token));
        assert!(!verify_cluster_auth_token("wrong-secret", &token));
        assert!(!verify_cluster_auth_token("my-secret", &token[..31]));
    }

    #[test]
    fn test_legacy_hardware_and_graphics_flags_roundtrip() {
        let frame = HandshakeFrame::new(
            768,
            2,
            FLAG_PLATFORM_LINUX | FLAG_LEGACY_HARDWARE | FLAG_LEGACY_GRAPHICS,
            STATUS_READY,
        );
        let bytes = frame.to_bytes();
        let decoded = HandshakeFrame::from_bytes(&bytes).expect("decode legacy frame");
        assert!(decoded.is_legacy_hardware());
        assert!(decoded.is_legacy_graphics());
        assert!(!decoded.is_vulkan_fp16());
        assert_eq!(decoded.status_label(), "Ready");
    }
}
