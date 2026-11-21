import { ContextLengthOption, GgufModelPreset } from '../types/starCluster';

export function inferGgufQuantFromFilename(filename: string): string {
  const match = filename.match(/(IQ[1-4][_-][A-Z0-9]+|Q[0-8][_-][A-Z0-9_]+|FP16|F16|FP32|F32|BF16|TQ[1-2][_-][0-9])/i);
  if (!match) return 'Q4_K_M';
  const raw = match[1].replace('-', '_').toUpperCase();
  if (raw === 'FP16') return 'F16';
  if (raw === 'FP32') return 'F32';
  return raw;
}

export function inferGgufParamsFromFilename(filename: string, sizeMb: number): {
  totalParamsB: number;
  activeParamsB: number;
  architecture: 'MoE' | 'Ternary' | 'Dense';
  layers: number;
} {
  const lower = filename.toLowerCase();
  const isMoe = lower.includes('moe') || lower.includes('mixtral') || lower.includes('a3b');
  const isTernary = lower.includes('bitnet') || lower.includes('tq1') || lower.includes('tq2');

  const paramMatch = filename.match(/([0-9]+(?:\.[0-9]+)?)[bB](?:-|_|\.|$)/);
  let totalParamsB = 0;
  if (paramMatch) {
    totalParamsB = parseFloat(paramMatch[1]);
  } else {
    // Estimate from file size and assumed 4.5 bits-per-weight average
    const approxBytes = sizeMb * 1024 * 1024;
    totalParamsB = parseFloat(((approxBytes * 8) / (4.5 * 1e9)).toFixed(1));
    if (totalParamsB < 1) totalParamsB = 1.5;
  }

  let activeParamsB = totalParamsB;
  if (isMoe) {
    activeParamsB = parseFloat(Math.min(totalParamsB, Math.max(1.8, totalParamsB * 0.12)).toFixed(1));
  }

  // Infer layer count from parameter count
  let layers = 32;
  if (totalParamsB <= 2.0) {
    layers = 28;
  } else if (totalParamsB <= 4.0) {
    layers = 30;
  } else if (totalParamsB <= 9.0) {
    layers = 32;
  } else if (totalParamsB <= 16.0) {
    layers = 40;
  } else if (totalParamsB <= 35.0) {
    layers = isMoe ? 48 : 36;
  } else {
    layers = 80;
  }

  return {
    totalParamsB,
    activeParamsB,
    architecture: isMoe ? 'MoE' : isTernary ? 'Ternary' : 'Dense',
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
