//! Bit-exact 32-byte GGUF / RPC v9 / v1.0.0 handshake & keyed authentication protocol.
//! Matches Android Kotlin `RpcService.computeClusterAuthToken` and `build32ByteGgufHandshake`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub const HANDSHAKE_CHALLENGE: &[u8] = b"GGUF_PROBE_V9";
pub const RPC_PROTOCOL_VERSION: u32 = 9;
pub const STOCK_VERSION_TAG: &[u8; 8] = b"v1.0.0\0\0";

pub const FLAG_VULKAN_FP16: u32 = 1 << 0;
pub const FLAG_ARM_DOTPROD: u32 = 1 << 1;
pub const FLAG_ELF_16KB_ALIGNED: u32 = 1 << 2;
pub const FLAG_SBC_CORTEX_A72: u32 = 1 << 3;
pub const FLAG_PLATFORM_WINDOWS: u32 = 1 << 4;
pub const FLAG_PLATFORM_LINUX: u32 = 1 << 5;
pub const FLAG_PLATFORM_ANDROID: u32 = 1 << 6;
pub const FLAG_PLATFORM_MACOS: u32 = 1 << 7;
pub const FLAG_LEGACY_HARDWARE: u32 = 1 << 8;
pub const FLAG_LEGACY_GRAPHICS: u32 = 1 << 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerHandshakeStatus {
    Ready = 0,
    Throttled = 1,
    ShedLayers = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GgufHandshakeFrame {
    pub rpc_version: u32,
    pub version_tag: String,
    pub safe_cap_mb: u32,
    pub big_cores: u32,
    pub flags: u32,
    pub status: WorkerHandshakeStatus,
}

/// Bit-exact Rust reference implementation of the 32-byte keyed auth token.
pub fn compute_cluster_auth_token(secret: &str, challenge: &[u8]) -> [u8; 32] {
    let mut state: [u64; 4] = [
        0x6a09e667f3bcc908u64,
        0xbb67ae8584caa73bu64,
        0x3c6ef372fe94f82bu64,
        0xa54ff53a5f1d36f1u64,
    ];

    let secret_bytes = secret.as_bytes();
    let total_len = secret_bytes.len() + challenge.len();
    for i in 0..total_len {
        let b = if i < secret_bytes.len() {
            secret_bytes[i]
        } else {
            challenge[i - secret_bytes.len()]
        } as u64;
        let lane = i & 3;
        let next_lane = (lane + 1) & 3;
        let mixed = state[lane]
            .wrapping_add(b.wrapping_mul(0x9e3779b97f4a7c15u64))
            .rotate_left(13);
        state[lane] = mixed ^ state[next_lane];
    }

    for round in 0u64..8u64 {
        for lane in 0..4 {
            state[lane] = state[lane]
                .wrapping_mul(0xbf58476d1ce4e5b9u64)
                .wrapping_add(round)
                .rotate_right(17);
        }
    }

    let mut out = [0u8; 32];
    for (idx, word) in state.iter().enumerate() {
        out[idx * 8..(idx + 1) * 8].copy_from_slice(&word.to_le_bytes());
    }
    out
}

/// Constant-time 32-byte verification.
pub fn verify_cluster_auth_token(secret: &str, received: &[u8]) -> bool {
    if received.len() < 32 {
        return false;
    }
    let expected = compute_cluster_auth_token(secret, HANDSHAKE_CHALLENGE);
    let mut diff: u8 = 0;
    for i in 0..32 {
        diff |= expected[i] ^ received[i];
    }
    diff == 0
}

pub fn encode_handshake_frame(
    safe_cap_mb: u32,
    big_cores: u32,
    flags: u32,
    status: WorkerHandshakeStatus,
) -> [u8; 32] {
    let mut buf = [0u8; 32];
    buf[0..4].copy_from_slice(b"GGUF");
    buf[4..8].copy_from_slice(&RPC_PROTOCOL_VERSION.to_le_bytes());
    buf[8..16].copy_from_slice(STOCK_VERSION_TAG);
    buf[16..20].copy_from_slice(&safe_cap_mb.to_le_bytes());
    buf[20..24].copy_from_slice(&big_cores.to_le_bytes());
    buf[24..28].copy_from_slice(&flags.to_le_bytes());
    buf[28..32].copy_from_slice(&(status as u32).to_le_bytes());
    buf
}

pub fn decode_handshake_frame(raw: &[u8; 32]) -> Result<GgufHandshakeFrame, String> {
    if &raw[0..4] != b"GGUF" {
        return Err("Invalid handshake magic (expected GGUF)".to_string());
    }
    let rpc_version = u32::from_le_bytes(raw[4..8].try_into().unwrap());
    if rpc_version != RPC_PROTOCOL_VERSION {
        return Err(format!(
            "Unsupported RPC protocol version {} (expected {})",
            rpc_version, RPC_PROTOCOL_VERSION
        ));
    }
    let version_tag = String::from_utf8_lossy(&raw[8..16])
        .trim_end_matches('\0')
        .to_string();
    let safe_cap_mb = u32::from_le_bytes(raw[16..20].try_into().unwrap());
    let big_cores = u32::from_le_bytes(raw[20..24].try_into().unwrap());
    let flags = u32::from_le_bytes(raw[24..28].try_into().unwrap());
    let status = match u32::from_le_bytes(raw[28..32].try_into().unwrap()) {
        0 => WorkerHandshakeStatus::Ready,
        1 => WorkerHandshakeStatus::Throttled,
        _ => WorkerHandshakeStatus::ShedLayers,
    };
    Ok(GgufHandshakeFrame {
        rpc_version,
        version_tag,
        safe_cap_mb,
        big_cores,
        flags,
        status,
    })
}

/// Performs a live TCP + 32-byte keyed GGUF/RPC v9/v1.0.0 handshake probe against a worker.
pub fn probe_worker_handshake(
    addr: SocketAddr,
    secret: &str,
    timeout: Duration,
) -> Result<(GgufHandshakeFrame, f64), String> {
    let start = Instant::now();
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("TCP connect failed to {}: {}", addr, e))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let token = compute_cluster_auth_token(secret, HANDSHAKE_CHALLENGE);
    stream
        .write_all(&token)
        .map_err(|e| format!("Failed writing 32-byte auth token: {}", e))?;
    let _ = stream.flush();

    let mut reply = [0u8; 32];
    stream
        .read_exact(&mut reply)
        .map_err(|e| format!("Failed reading 32-byte GGUF handshake reply: {}", e))?;

    let rtt_ms = start.elapsed().as_secs_f64() * 1000.0;
    let frame = decode_handshake_frame(&reply)?;
    Ok((frame, rtt_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_token_is_deterministic_and_verifies() {
        let token_a = compute_cluster_auth_token("clusterd-default-hmac-key", HANDSHAKE_CHALLENGE);
        let token_b = compute_cluster_auth_token("clusterd-default-hmac-key", HANDSHAKE_CHALLENGE);
        assert_eq!(token_a, token_b);
        assert!(verify_cluster_auth_token("clusterd-default-hmac-key", &token_a));
        assert!(!verify_cluster_auth_token("wrong-secret", &token_a));
    }

    #[test]
    fn handshake_frame_roundtrips() {
        let encoded = encode_handshake_frame(
            2048,
            4,
            FLAG_PLATFORM_ANDROID | FLAG_ARM_DOTPROD | FLAG_ELF_16KB_ALIGNED,
            WorkerHandshakeStatus::Ready,
        );
        let decoded = decode_handshake_frame(&encoded).expect("valid frame");
        assert_eq!(decoded.rpc_version, 9);
        assert_eq!(decoded.version_tag, "v1.0.0");
        assert_eq!(decoded.safe_cap_mb, 2048);
        assert_eq!(decoded.big_cores, 4);
        assert_eq!(decoded.status, WorkerHandshakeStatus::Ready);
    }
}
