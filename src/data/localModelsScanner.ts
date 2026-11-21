import { ContextLengthOption, GgufArchitecture, GgufModelPreset } from '../types/starCluster';

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
    // Looped models have 12 to 24 distinct layers repeated in loop iterations
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

export function parseLocalGgufModel(filePath: string, sizeBytes: number): GgufModelPreset {
  // Extract clean filename from Windows or Unix path
  const filename = filePath.split(/[/\\]/).pop() || 'model.gguf';
  const sizeMb = Math.max(10, Math.round(sizeBytes / (1024 * 1024)));
  const quant = inferGgufQuantFromFilename(filename);
  const { totalParamsB, activeParamsB, architecture, layers } = inferGgufParamsFromFilename(filename, sizeMb);

  const cleanName = filename
    .replace(/\.gguf$/i, '')
    .replace(/[-_](iq[1-4]|q[0-8]|f16|f32|bf16)[a-z0-9_.-]*/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  const id = `local-${filename.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  let contextLengthDefault: ContextLengthOption = 8192;
  if (totalParamsB <= 2) contextLengthDefault = 8192;
  else if (totalParamsB >= 30) contextLengthDefault = 4096;

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
    summary: `${(sizeMb / 1024).toFixed(2)} GB · ${layers} layers · Local file on disk`,
    tags: ['local', 'disk', quant.toLowerCase()],
    isLocal: true,
    localPath: filePath,
  };
}
