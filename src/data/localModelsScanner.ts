import { ContextLengthOption, GgufArchitecture, GgufModelPreset } from '../types/starCluster';

export interface GgufHeaderMetadata {
  magic: string;
  version: number;
  tensorCount: number;
  kvCount: number;
  name?: string;
  architecture?: string;
  layers?: number;
  contextLength?: number;
  expertCount?: number;
  expertUsedCount?: number;
}

/**
 * Parses binary GGUF header bytes (first 32KB - 128KB) to read true model card metadata.
 * Works isomorphically in Node.js and in the browser (via Uint8Array / DataView).
 */
export function parseGgufBinaryHeader(bytes: Uint8Array): GgufHeaderMetadata | null {
  if (bytes.length < 24) return null;
  // Magic bytes: 'GGUF' (0x47, 0x47, 0x55, 0x46)
  if (bytes[0] !== 0x47 || bytes[1] !== 0x47 || bytes[2] !== 0x55 || bytes[3] !== 0x46) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const tensorCount = Number(view.getBigUint64(8, true));
  const kvCount = Number(view.getBigUint64(16, true));

  let name: string | undefined;
  let architecture: string | undefined;
  let layers: number | undefined;
  let contextLength: number | undefined;
  let expertCount: number | undefined;
  let expertUsedCount: number | undefined;

  const maxSearch = Math.min(bytes.length - 8, 131072);
  const textDecoder = new TextDecoder('utf-8');

  function findSubstr(needle: string): number {
    const needleBytes = new TextEncoder().encode(needle);
    outer: for (let i = 24; i <= maxSearch - needleBytes.length; i++) {
      for (let j = 0; j < needleBytes.length; j++) {
        if (bytes[i + j] !== needleBytes[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  // 1. Look for block_count (layers)
  const blockIdx = findSubstr('block_count');
  if (blockIdx !== -1) {
    const valOffset = blockIdx + 11 + 4;
    if (valOffset + 4 <= bytes.length) {
      const val = view.getUint32(valOffset, true);
      if (val > 0 && val <= 256) layers = val;
    }
  }

  // 2. Look for context_length
  const ctxIdx = findSubstr('context_length');
  if (ctxIdx !== -1) {
    const valOffset = ctxIdx + 14 + 4;
    if (valOffset + 4 <= bytes.length) {
      const val = view.getUint32(valOffset, true);
      if (val >= 512 && val <= 1048576) contextLength = val;
    }
  }

  // 3. Look for expert_count / expert_used_count (MoE architecture)
  const expIdx = findSubstr('expert_count');
  if (expIdx !== -1) {
    const valOffset = expIdx + 12 + 4;
    if (valOffset + 4 <= bytes.length) {
      const val = view.getUint32(valOffset, true);
      if (val > 0 && val <= 512) expertCount = val;
    }
  }
  const expUsedIdx = findSubstr('expert_used_count');
  if (expUsedIdx !== -1) {
    const valOffset = expUsedIdx + 17 + 4;
    if (valOffset + 4 <= bytes.length) {
      const val = view.getUint32(valOffset, true);
      if (val > 0 && val <= 64) expertUsedCount = val;
    }
  }

  // 4. Look for general.name
  const nameIdx = findSubstr('general.name');
  if (nameIdx !== -1) {
    const lenOffset = nameIdx + 12 + 4;
    if (lenOffset + 8 <= bytes.length) {
      const len = Number(view.getBigUint64(lenOffset, true));
      const start = lenOffset + 8;
      if (len > 0 && len < 128 && start + len <= bytes.length) {
        name = textDecoder.decode(bytes.subarray(start, start + len)).trim();
      }
    }
  }

  // 5. Look for general.architecture
  const archIdx = findSubstr('general.architecture');
  if (archIdx !== -1) {
    const lenOffset = archIdx + 20 + 4;
    if (lenOffset + 8 <= bytes.length) {
      const len = Number(view.getBigUint64(lenOffset, true));
      const start = lenOffset + 8;
      if (len > 0 && len < 64 && start + len <= bytes.length) {
        architecture = textDecoder.decode(bytes.subarray(start, start + len)).trim();
      }
    }
  }

  return {
    magic: 'GGUF',
    version,
    tensorCount,
    kvCount,
    name,
    architecture,
    layers,
    contextLength,
    expertCount,
    expertUsedCount,
  };
}

export function inferGgufQuantFromFilename(filename: string): string {
  const match = filename.match(
    /(IQ[1-4][_-][A-Z0-9]+|Q[0-8][_-][A-Z0-9_]+|Q[0-8]_[01]|FP16|F16|FP32|F32|BF16|TQ[1-2][_-][0-9]|BITNET|1\.58B|B1\.58|TURBOQUANT|TURBO|VQ[_-][0-9A-Z]+)/i
  );
  if (!match) return 'Q4_K_M';
  const raw = match[1].replace('-', '_').toUpperCase();
  if (raw === 'FP16') return 'F16';
  if (raw === 'FP32') return 'F32';
  if (raw.includes('BITNET') || raw.includes('1.58')) return 'BITNET_1.58B';
  return raw;
}

export function estimateBpwFromQuant(quant: string, arch: GgufArchitecture): number {
  const q = quant.toUpperCase();
  if (arch === 'Ternary' || q.includes('BITNET') || q.includes('1.58') || q.startsWith('TQ1')) return 1.58;
  if (arch === 'TurboQuant' || q.includes('TURBO')) return 2.2;
  if (q.includes('IQ1')) return 1.75;
  if (q.includes('IQ2') || q.includes('Q2')) return 2.6;
  if (q.includes('IQ3') || q.includes('Q3')) return 3.4;
  if (q.includes('IQ4') || q.includes('Q4')) return 4.5;
  if (q.includes('Q5')) return 5.5;
  if (q.includes('Q6')) return 6.6;
  if (q.includes('Q8')) return 8.5;
  if (q.includes('F16') || q.includes('BF16')) return 16.0;
  if (q.includes('F32')) return 32.0;
  return 4.5;
}

export function inferGgufParamsFromFilename(filename: string, sizeMb: number): {
  totalParamsB: number;
  activeParamsB: number;
  architecture: GgufArchitecture;
  layers: number;
} {
  const lower = filename.toLowerCase();
  const isLooped =
    lower.includes('looped') ||
    lower.includes('recursive') ||
    lower.includes('weight-tied') ||
    lower.includes('tied') ||
    lower.includes('universal') ||
    lower.includes('ut-');
  const isTurbo =
    lower.includes('turboquant') ||
    lower.includes('turbo') ||
    lower.includes('tq-') ||
    lower.includes('vq-');
  const isTernary =
    lower.includes('bitnet') ||
    lower.includes('1.58b') ||
    lower.includes('b1.58') ||
    lower.includes('tq1') ||
    lower.includes('tq2') ||
    lower.includes('ternary');
  const isMoe =
    lower.includes('moe') ||
    lower.includes('mixtral') ||
    lower.includes('a3b') ||
    lower.includes('dbrx') ||
    lower.includes('deepseek');

  const architecture: GgufArchitecture = isLooped
    ? 'Looped'
    : isTurbo
      ? 'TurboQuant'
      : isTernary
        ? 'Ternary'
        : isMoe
          ? 'MoE'
          : 'Dense';

  const quant = inferGgufQuantFromFilename(filename);
  const bpw = estimateBpwFromQuant(quant, architecture);

  const paramMatch = filename.match(/([0-9]+(?:\.[0-9]+)?)[bB](?:-|_|\.|$)/);
  let totalParamsB = 0;
  if (paramMatch) {
    totalParamsB = parseFloat(paramMatch[1]);
  } else {
    // Estimate total parameters from disk size and detected BPW
    const approxBytes = sizeMb * 1024 * 1024;
    totalParamsB = parseFloat(((approxBytes * 8) / (bpw * 1e9)).toFixed(1));
    if (totalParamsB < 1) totalParamsB = 1.5;
  }

  let activeParamsB = totalParamsB;
  if (architecture === 'MoE') {
    activeParamsB = parseFloat(Math.min(totalParamsB, Math.max(1.8, totalParamsB * 0.12)).toFixed(1));
  } else if (architecture === 'Looped') {
    // In Looped models, active params equal single-pass physical layer weight footprint
    activeParamsB = parseFloat((totalParamsB * 0.5).toFixed(1));
  }

  // Infer layer count from parameter count and architecture
  let layers = 32;
  if (architecture === 'Looped') {
    layers = totalParamsB <= 7 ? 16 : 24;
  } else if (totalParamsB <= 2.0) {
    layers = 28;
  } else if (totalParamsB <= 4.0) {
    layers = 30;
  } else if (totalParamsB <= 9.0) {
    layers = 32;
  } else if (totalParamsB <= 16.0) {
    layers = 40;
  } else if (totalParamsB <= 35.0) {
    layers = architecture === 'MoE' ? 48 : 36;
  } else {
    layers = 80;
  }

  return {
    totalParamsB,
    activeParamsB,
    architecture,
    layers,
  };
}

export function parseLocalGgufModel(
  filePath: string,
  sizeBytes: number,
  headerBytes?: Uint8Array
): GgufModelPreset {
  // Extract clean filename from Windows or Unix path
  const filename = filePath.split(/[/\\]/).pop() || 'model.gguf';
  const sizeMb = Math.max(10, Math.round(sizeBytes / (1024 * 1024)));
  const quant = inferGgufQuantFromFilename(filename);

  // Fallback heuristic estimation
  const inferred = inferGgufParamsFromFilename(filename, sizeMb);
  let totalParamsB = inferred.totalParamsB;
  let activeParamsB = inferred.activeParamsB;
  let architecture = inferred.architecture;
  let layers = inferred.layers;
  let rawName: string | undefined;
  let detectedCtx: number | undefined;

  // Try extracting binary header metadata if provided
  if (headerBytes && headerBytes.length >= 24) {
    const meta = parseGgufBinaryHeader(headerBytes);
    if (meta) {
      if (meta.name) rawName = meta.name;
      if (meta.layers && meta.layers > 0) layers = meta.layers;
      if (meta.contextLength && meta.contextLength > 0) detectedCtx = meta.contextLength;

      // Detect architecture from GGUF metadata
      if (meta.expertCount && meta.expertCount > 0) {
        architecture = 'MoE';
        const activeExperts = meta.expertUsedCount || 8;
        activeParamsB = parseFloat(
          Math.min(totalParamsB, Math.max(1.5, totalParamsB * (activeExperts / meta.expertCount) * 1.5)).toFixed(1)
        );
      } else if (meta.architecture?.includes('moe')) {
        architecture = 'MoE';
        activeParamsB = parseFloat(Math.min(totalParamsB, Math.max(1.8, totalParamsB * 0.12)).toFixed(1));
      } else if (meta.architecture?.includes('bitnet') || meta.architecture?.includes('ternary')) {
        architecture = 'Ternary';
      }
    }
  }

  const cleanName = rawName || filename
    .replace(/\.gguf$/i, '')
    .replace(/[-_](iq[1-4]|q[0-8]|f16|f32|bf16)[a-z0-9_.-]*/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  const id = `local-${filename.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  let contextLengthDefault: ContextLengthOption = 8192;
  if (detectedCtx) {
    contextLengthDefault = detectedCtx >= 32768 ? 16384 : detectedCtx >= 16384 ? 16384 : detectedCtx >= 8192 ? 8192 : 4096;
  } else if (totalParamsB <= 2) {
    contextLengthDefault = 8192;
  } else if (totalParamsB >= 30) {
    contextLengthDefault = 4096;
  }

  const archLabel = architecture === 'MoE' ? 'Sparse MoE' : architecture;

  return {
    id,
    name: cleanName || filename.replace(/\.gguf$/i, ''),
    quant,
    architecture,
    sizeMb,
    layers,
    totalParamsB,
    activeParamsB,
    contextLengthDefault,
    hfRepo: `local/${filename}`,
    hfUrl: `file://${filePath.replace(/\\/g, '/')}`,
    summary: `${(sizeMb / 1024).toFixed(2)} GB · ${layers}L · ${archLabel} · Local PC GGUF`,
    tags: ['local', 'disk', quant.toLowerCase(), architecture.toLowerCase()],
    isLocal: true,
    localPath: filePath,
  };
}
