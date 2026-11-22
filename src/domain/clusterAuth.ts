/**
 * Bit-exact TypeScript mirror of Rust `silica-core::protocol::compute_cluster_auth_token`
 * and Android Kotlin `RpcService.computeClusterAuthToken` for 32-byte keyed GGUF/RPC v9 handshakes.
 */

export const HANDSHAKE_CHALLENGE = new TextEncoder().encode('GGUF_PROBE_V9');
export const RPC_PROTOCOL_VERSION = 9;

const MASK_64 = (1n << 64n) - 1n;

function rotl64(x: bigint, k: bigint): bigint {
  return (((x << k) & MASK_64) | (x >> (64n - k))) & MASK_64;
}

function rotr64(x: bigint, k: bigint): bigint {
  return ((x >> k) | ((x << (64n - k)) & MASK_64)) & MASK_64;
}

export function computeClusterAuthToken(
  secret: string,
  challenge: Uint8Array = HANDSHAKE_CHALLENGE
): Uint8Array {
  const state = [
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
  ];
  const secretBytes = new TextEncoder().encode(secret);
  const totalLen = secretBytes.length + challenge.length;

  for (let i = 0; i < totalLen; i++) {
    const b = BigInt(i < secretBytes.length ? secretBytes[i] : challenge[i - secretBytes.length]);
    const lane = i & 3;
    const nextLane = (lane + 1) & 3;
    const mixed = rotl64((state[lane] + ((b * 0x9e3779b97f4a7c15n) & MASK_64)) & MASK_64, 13n);
    state[lane] = (mixed ^ state[nextLane]) & MASK_64;
  }

  for (let round = 0n; round < 8n; round++) {
    for (let lane = 0; lane < 4; lane++) {
      const mul = (state[lane] * 0xbf58476d1ce4e5b9n) & MASK_64;
      state[lane] = rotr64((mul + round) & MASK_64, 17n);
    }
  }

  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let idx = 0; idx < 4; idx++) {
    view.setBigUint64(idx * 8, state[idx], true);
  }
  return out;
}

export function verifyClusterAuthToken(secret: string, received: Uint8Array): boolean {
  if (received.length < 32) return false;
  const expected = computeClusterAuthToken(secret, HANDSHAKE_CHALLENGE);
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= expected[i] ^ received[i];
  }
  return diff === 0;
}

export interface DecodedGgufHandshake {
  rpcVersion: number;
  versionTag: string;
  safeCapMb: number;
  bigCores: number;
  flags: number;
  status: 'READY' | 'THROTTLED' | 'SHED_LAYERS';
}

export function decodeGgufHandshakeFrame(buf: Uint8Array): DecodedGgufHandshake | null {
  if (buf.length < 32) return null;
  if (buf[0] !== 0x47 || buf[1] !== 0x47 || buf[2] !== 0x55 || buf[3] !== 0x46) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rpcVersion = view.getUint32(4, true);
  if (rpcVersion !== RPC_PROTOCOL_VERSION) return null;
  const versionTag = new TextDecoder()
    .decode(buf.subarray(8, 16))
    .replace(/\0+$/, '');
  const safeCapMb = view.getUint32(16, true);
  const bigCores = view.getUint32(20, true);
  const flags = view.getUint32(24, true);
  const rawStatus = view.getUint32(28, true);
  const status = rawStatus === 0 ? 'READY' : rawStatus === 1 ? 'THROTTLED' : 'SHED_LAYERS';
  return { rpcVersion, versionTag, safeCapMb, bigCores, flags, status };
}
