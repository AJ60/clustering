import {
  BackendOsTarget,
  BackendTuningConfig,
  ContextLengthOption,
  GgufModelPreset,
  KvCacheQuantOption,
  PlannedStarNode,
  StarClusterPlan,
  TunedOsBackendProfile,
} from '../types/starCluster';

export function createDefaultBackendTuningConfig(
  model: GgufModelPreset
): BackendTuningConfig {
  return {
    windowsAccelerator: 'CUDA 12.6',
    linuxAccelerator: 'CUDA 12.6',
    contextLength: model.contextLengthDefault ?? 8192,
    kvCacheQuant: model.sizeMb > 16000 ? 'q8_0' : 'f16',
    enableFlashAttn: model.architecture !== 'Ternary',
    moeCpuOffload: model.architecture === 'MoE',
    windowsNoMmap: model.sizeMb <= 20000,
    linuxMlock: model.sizeMb <= 22000,
    linuxNumaInterleave: true,
  };
}

export function estimateKvCacheMb(
  layers: number,
  contextLength: ContextLengthOption,
  kvQuant: KvCacheQuantOption,
  totalParamsB: number
): number {
  // GQA-aware approximation: 2 (K+V) * layers * kvHeads_dim * ctx * bytes
  const bytesPerElem = kvQuant === 'f16' ? 2 : kvQuant === 'q8_0' ? 1.06 : 0.56;
  const gqaScale = totalParamsB >= 50 ? 0.55 : totalParamsB >= 20 ? 0.42 : 0.3;
  const mb = Math.round(((layers * contextLength * gqaScale * bytesPerElem) / 1024) * 0.42);
  return Math.max(128, mb);
}

export function buildTunedOsBackendProfile(
  os: BackendOsTarget,
  model: GgufModelPreset,
  plan: StarClusterPlan,
  config: BackendTuningConfig
): TunedOsBackendProfile {
  const isWindows = os === 'windows';
  const targetNode: PlannedStarNode | undefined =
    plan.nodes.find((n) => n.osType === os) ??
    plan.nodes.find((n) => n.role === 'Master') ??
    plan.nodes[0];

  const vramFreeMb = targetNode?.safeVramMb ?? 0;
  const ramFreeMb = targetNode?.safeRamMb ?? 8192;
  const physicalCores = targetNode?.physicalCores ?? 8;
  const recommendedThreads = Math.max(
    2,
    Math.min(16, isWindows ? Math.min(physicalCores, 12) : physicalCores)
  );

  const accelerator = isWindows ? config.windowsAccelerator : config.linuxAccelerator;
  const usesGpu = !accelerator.startsWith('CPU');
  const kvCacheMb = estimateKvCacheMb(
    model.layers,
    config.contextLength,
    config.kvCacheQuant,
    model.totalParamsB
  );

  // Compute optimal GPU layer count (-ngl) bounded by safe VRAM after KV + WDDM reserve
  const mbPerLayer = model.sizeMb / Math.max(1, model.layers);
  const wddmOrDriverReserve = isWindows ? 450 : 256;
  const gpuBudgetMb = usesGpu
    ? Math.max(0, vramFreeMb - Math.min(kvCacheMb, 1536) - wddmOrDriverReserve)
    : 0;
  const gpuOffloadLayers =
    model.architecture === 'Ternary' && !usesGpu
      ? 0
      : Math.min(model.layers, Math.max(0, Math.floor(gpuBudgetMb / Math.max(1, mbPerLayer))));

  const batchSize = usesGpu ? (model.architecture === 'MoE' ? 2048 : 1024) : 512;
  const ubatchSize = usesGpu ? 512 : 256;

  // Compute expected tokens/sec based on active params (MoE skips inactive experts)
  const effectiveBw = usesGpu
    ? Math.max(targetNode?.memBwGbps ?? 120, 220)
    : targetNode?.memBwGbps ?? 48;
  const bitsPerWeight = model.quant.startsWith('TQ1')
    ? 1.65
    : model.quant.startsWith('Q4')
      ? 4.6
      : model.quant.startsWith('Q5')
        ? 5.6
        : 8.1;
  const activeBytesGb = (model.activeParamsB * bitsPerWeight) / 8;
  const gpuShare = model.layers > 0 ? gpuOffloadLayers / model.layers : 0;
  const blendedBw = effectiveBw * (0.35 + 0.65 * gpuShare);
  const rawTokPerSec = blendedBw / Math.max(0.45, activeBytesGb);
  const clusterEfficiency = plan.nodes.filter((n) => n.allocatedLayers > 0).length > 1 ? 0.86 : 1.0;
  const expectedTokPerSec = Number(
    Math.max(1.2, Math.min(185, rawTokPerSec * clusterEfficiency)).toFixed(1)
  );

  const workerRpcAddrs = plan.nodes
    .filter((n) => n.role === 'Worker' && n.allocatedLayers > 0)
    .map((_n, idx) => `127.0.0.1:${50052 + idx}`);

  const tensorSplitArg =
    plan.nodes.filter((n) => n.allocatedLayers > 0).length > 1
      ? plan.nodes
          .filter((n) => n.allocatedLayers > 0)
          .map((n) => Math.max(1, n.sharePct))
          .join(',')
      : '';

  const modelFileSlug = `${model.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}.${model.quant}.gguf`;

  const cliFlags: string[] = [
    `--model ./models/${modelFileSlug}`,
    `--alias "${model.name}"`,
    `--host 0.0.0.0`,
    `--port 8080`,
    `--ctx-size ${config.contextLength}`,
    `--threads ${recommendedThreads}`,
    `--threads-batch ${recommendedThreads}`,
    `--n-gpu-layers ${gpuOffloadLayers}`,
    `--batch-size ${batchSize}`,
    `--ubatch-size ${ubatchSize}`,
    `--cache-type-k ${config.kvCacheQuant}`,
    `--cache-type-v ${config.kvCacheQuant}`,
  ];

  if (config.enableFlashAttn && usesGpu && model.architecture !== 'Ternary') {
    cliFlags.push('--flash-attn on');
  }
  if (config.moeCpuOffload && model.architecture === 'MoE') {
    cliFlags.push('-ot ".ffn_.*_exps.=CPU"');
  }
  if (isWindows && config.windowsNoMmap && ramFreeMb > model.sizeMb + 4096) {
    cliFlags.push('--no-mmap');
  }
  if (!isWindows && config.linuxMlock && ramFreeMb > model.sizeMb + 2048) {
    cliFlags.push('--mlock');
  }
  if (workerRpcAddrs.length > 0) {
    cliFlags.push(`--rpc ${workerRpcAddrs.join(',')}`);
  }
  if (tensorSplitArg) {
    cliFlags.push(`--tensor-split ${tensorSplitArg}`);
  }

  const envVars: Array<{ key: string; value: string; reason: string }> = isWindows
    ? [
        {
          key: 'GGML_CUDA_NO_PINNED',
          value: ramFreeMb < 16384 ? '1' : '0',
          reason: 'Prevents WDDM pinned host allocation pressure on <= 16 GB Windows systems',
        },
        {
          key: 'GGML_VK_DISABLE_F16',
          value: accelerator === 'Vulkan 1.3' ? '0' : '1',
          reason: 'Controls FP16 coopmat shaders on Vulkan discrete/integrated GPUs',
        },
        {
          key: 'OMP_WAIT_POLICY',
          value: 'PASSIVE',
          reason: 'Eliminates OpenMP spin-wait core contention alongside WDDM DWM compositor',
        },
      ]
    : [
        {
          key: 'GGML_CUDA_ENABLE_UNIFIED_MEMORY',
          value: '0',
          reason: 'Blocks silent slow PCIe unified-memory thrashing; enforces strict VRAM cap',
        },
        {
          key: 'GGML_OPENBLAS_NUM_THREADS',
          value: String(recommendedThreads),
          reason: 'Matches BLAS prefill threads strictly to physical P-cores',
        },
        {
          key: 'MALLOC_ARENA_MAX',
          value: '2',
          reason: 'Tightens glibc heap fragmentation during multi-node tensor shard allocation',
        },
      ];

  const binaryName = isWindows ? '.\\bin\\llama-server.exe' : './bin/llama-server';
  const baseLaunch = `${binaryName} \\\n  ${cliFlags.join(' \\\n  ')}`;
  const launchCommand = isWindows
    ? `${binaryName} ${cliFlags.join(' ')}`
    : `${config.linuxNumaInterleave ? 'numactl --interleave=all ' : ''}${baseLaunch}`;

  const scriptFileName = isWindows ? 'run-cluster-win.ps1' : 'run-cluster-linux.sh';

  const scriptContent = isWindows
    ? [
        `# ClusterLab Windows Tuned Backend Launcher (${model.name})`,
        `# Accelerator: ${accelerator} | Safe VRAM Guard: <=90% (-${wddmOrDriverReserve} MB WDDM floor)`,
        `$ErrorActionPreference = "Stop"`,
        ...envVars.map((e) => `$env:${e.key} = "${e.value}"  # ${e.reason}`),
        ``,
        `# Open LAN ports for OpenAI API (:8080), RPC Worker (:50052), and UDP Auto-Discovery (:50050)`,
        `if (-not (Get-NetFirewallRule -DisplayName "ClusterLab-OpenAI" -ErrorAction SilentlyContinue)) {`,
        `  New-NetFirewallRule -DisplayName "ClusterLab-OpenAI" -Direction Inbound -Protocol TCP -LocalPort 8080,50052 -Action Allow | Out-Null`,
        `  New-NetFirewallRule -DisplayName "ClusterLab-UDP" -Direction Inbound -Protocol UDP -LocalPort 50050 -Action Allow | Out-Null`,
        `}`,
        ``,
        `# Launch llama-server with High Priority (avoids Windows Efficiency Mode throttling)`,
        `$argsList = @(`,
        ...cliFlags.map((f) => `  "${f.replace(/"/g, '`"')}"`),
        `)`,
        `$proc = Start-Process -FilePath "${binaryName}" -ArgumentList $argsList -PassThru -NoNewWindow`,
        `$proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::High`,
        `Write-Host "ClusterLab Windows OpenAI API running at http://127.0.0.1:8080/v1 (PID $($proc.Id))"`,
        `$proc.WaitForExit()`,
      ].join('\n')
    : [
        `#!/usr/bin/env bash`,
        `# ClusterLab Linux Tuned Backend Launcher (${model.name})`,
        `# Accelerator: ${accelerator} | MemAvailable - 1024 MB Guard`,
        `set -euo pipefail`,
        ``,
        ...envVars.map((e) => `export ${e.key}="${e.value}" # ${e.reason}`),
        ``,
        `# Enable Transparent HugePages madvise for large GGUF shard mappings`,
        `if [ -w /sys/kernel/mm/transparent_hugepage/enabled ]; then`,
        `  echo madvise > /sys/kernel/mm/transparent_hugepage/enabled || true`,
        `fi`,
        ``,
        `RUNNER_PREFIX=""`,
        `if command -v numactl >/dev/null 2>&1; then`,
        `  RUNNER_PREFIX="numactl --interleave=all"`,
        `fi`,
        ``,
        `echo "Starting ClusterLab Linux OpenAI API at http://0.0.0.0:8080/v1"`,
        `exec $RUNNER_PREFIX ${binaryName} \\`,
        `  ${cliFlags.join(' \\\n  ')}`,
      ].join('\n');

  const optimizations: string[] = isWindows
    ? [
        `WDDM compositor guard reserves ${wddmOrDriverReserve} MB VRAM to prevent desktop stutter/TDR.`,
        `Process Priority elevated to HIGH_PRIORITY_CLASS with OMP_WAIT_POLICY=PASSIVE.`,
        model.architecture === 'MoE' && config.moeCpuOffload
          ? 'Sparse MoE experts routed to DDR5 system RAM (-ot ".ffn_.*_exps.=CPU"), keeping KV & attention hot in VRAM.'
          : `KV Cache quantized to ${config.kvCacheQuant.toUpperCase()} (${kvCacheMb} MB) at ${config.contextLength.toLocaleString()} context.`,
        `Auto-provisions Windows Firewall rules for OpenAI :8080, RPC :50052, and UDP :50050.`,
      ]
    : [
        `Hard Linux MemAvailable - 1024 MB cap with GGML_CUDA_ENABLE_UNIFIED_MEMORY=0 to prevent OOM swapping.`,
        config.linuxNumaInterleave
          ? 'NUMA memory interleaving enabled (numactl --interleave=all) for balanced multi-channel RAM throughput.'
          : 'Single-socket NUMA affinity active.',
        model.architecture === 'MoE' && config.moeCpuOffload
          ? `MoE active-expert routing keeps only ${model.activeParamsB}B active parameters hot per token.`
          : `Physical P-core thread count locked at ${recommendedThreads} with ${config.kvCacheQuant.toUpperCase()} KV cache (${kvCacheMb} MB).`,
        config.linuxMlock && ramFreeMb > model.sizeMb + 2048
          ? 'Kernel --mlock pinning enabled to prevent Linux page-cache eviction.'
          : 'Zero-copy mmap paging tuned with MALLOC_ARENA_MAX=2.',
      ];

  return {
    os,
    title: isWindows ? 'Windows 10/11 Native Backend' : 'Linux Native Backend',
    accelerator,
    recommendedThreads,
    gpuOffloadLayers,
    vramSafetyReserveMb: wddmOrDriverReserve,
    ramSafetyReserveMb: isWindows ? 1024 : 1024,
    batchSize,
    ubatchSize,
    kvCacheMb,
    expectedTokPerSec,
    envVars,
    cliFlags,
    launchCommand,
    scriptFileName,
    scriptContent,
    optimizations,
  };
}
