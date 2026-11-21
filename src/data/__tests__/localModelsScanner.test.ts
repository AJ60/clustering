import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferGgufQuantFromFilename,
  inferGgufParamsFromFilename,
  parseLocalGgufModel,
} from '../localModelsScanner';

describe('localModelsScanner', () => {
  it('correctly detects quant types from filenames', () => {
    assert.equal(inferGgufQuantFromFilename('Underdog-Saluki-27B-1.0-IQ2-mix.gguf'), 'IQ2_MIX');
    assert.equal(inferGgufQuantFromFilename('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'), 'Q4_K_M');
    assert.equal(inferGgufQuantFromFilename('DeepSeek-R1-Distill-Q8_0.gguf'), 'Q8_0');
    assert.equal(inferGgufQuantFromFilename('model-fp16.gguf'), 'F16');
  });

  it('correctly infers parameters, architecture and layers', () => {
    const saluki = inferGgufParamsFromFilename('Underdog-Saluki-27B-1.0-IQ2-mix.gguf', 8000);
    assert.equal(saluki.totalParamsB, 27);
    assert.equal(saluki.architecture, 'Dense');
    assert.equal(saluki.layers, 36);

    const moe = inferGgufParamsFromFilename('Qwen3-30B-A3B-MoE-Q4_K_M.gguf', 18000);
    assert.equal(moe.totalParamsB, 30);
    assert.equal(moe.architecture, 'MoE');
    assert.equal(moe.activeParamsB, 3.6);
    assert.equal(moe.layers, 48);
  });

  it('parses full local GGUF preset from file path and size', () => {
    const preset = parseLocalGgufModel(
      'C:\\Users\\alojy\\Downloads\\Underdog-Saluki-27B-1.0-IQ2-mix.gguf',
      8472494080 // ~7.89 GB
    );

    assert.equal(preset.isLocal, true);
    assert.ok(preset.localPath?.includes('Underdog-Saluki-27B-1.0-IQ2-mix.gguf'));
    assert.equal(preset.quant, 'IQ2_MIX');
    assert.equal(preset.totalParamsB, 27);
    assert.ok(preset.sizeMb > 7000);
    assert.ok(preset.name.includes('Underdog Saluki 27B'));
  });
});
