import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  RPC_VERSION_PIN,
  LLAMA_TAG_PIN,
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_THERMAL_LIMITS,
  ThermalBalancer,
  ClusterLearner,
  RadixPrefixRouter,
  computeAndroidSafeCap,
  computeDesktopSafeCap,
  computeVramSafeCap,
  computeNodeStrengthScore,
  classifyClusterTier,
  proposeNgramDraft,
  isSymmetricLanTpEligible,
  computeClusterPlan,
  encodePreflightHandshake,
  decodePreflightHandshake,
  buildVirtual4NodeSuite,
  type ClusterConfig,
  type GgufMeta,
  type NodeTelemetry,
} from "../planner.ts";

const baseConfig: ClusterConfig = { ...DEFAULT_CLUSTER_CONFIG };

test("32-byte preflight handshake accepts v1.0.0/RPC v9 and rejects b11429/RPC v8", () => {
  const valid = encodePreflightHandshake(RPC_VERSION_PIN, LLAMA_TAG_PIN);
  assert.equal(valid.subarray(0, 4).toString("ascii"), "GGUF");
  const ok = decodePreflightHandshake(valid);
  assert.equal(ok.ok, true);
  assert.equal(ok.rpcVer, 9);
  assert.equal(ok.gitTag, "v1.0.0");

  const stale = encodePreflightHandshake(8, "b11429");
  const bad = decodePreflightHandshake(stale);
  assert.equal(bad.ok, false);
});

test("50% RAM cap applies strictly to Android; Linux and Windows use MemAvailable - 512 MB", () => {
  // Android 12 GB (8800 avail) -> strictly 50% (6144 MB)
  assert.equal(computeAndroidSafeCap(12288, 8800, 50), 6144);
  assert.equal(computeAndroidSafeCap(4096, 2000, 50), 1488);
  assert.equal(computeAndroidSafeCap(12288, 8800, 80), 6144);

  // Experimental unlock allows up to 85% only when explicitly requested
  assert.equal(computeAndroidSafeCap(12288, 8800, 80, 512, true), 8288);

  // Linux / Windows 16 GB (14336 avail) -> 13824 MB (~84% of physical RAM, NOT 50%)
  assert.equal(computeDesktopSafeCap(14336), 13824);

  const mixedNodes: NodeTelemetry[] = [
    {
      node_id: "win-workstation",
      is_master: true,
      os: "windows",
      silicon: "AMD Ryzen 9",
      ip: "127.0.0.1",
      link_type: "loopback",
      rpc_port: 50052,
      rpc_version: 9,
      git_tag: "v1.0.0",
      ram_total_mb: 16384,
      ram_avail_mb: 14336,
      safe_cap_mb: computeDesktopSafeCap(14336),
      vram_safe_mb: 0,
      compute_tflops: 2.0,
      mem_bw_gbps: 60,
      rtt_ms: 0,
      p95_rtt_ms: 0,
      pkt_loss_pct: 0,
      bandwidth_mbps: 10000,
      temp_c: 45,
      thermal_headroom: 0.3,
      vulkan_active: false,
      execution_backend: "Host CPU",
      handshake_ok: true,
      status: "CONNECTED",
    },
    {
      node_id: "android-phone",
      is_master: false,
      os: "android_apk",
      silicon: "Snapdragon 8 Gen 2",
      ip: "127.0.0.1",
      link_type: "adb_usb",
      rpc_port: 50052,
      rpc_version: 9,
      git_tag: "v1.0.0",
      ram_total_mb: 12288,
      ram_avail_mb: 10000,
      safe_cap_mb: 9000, // Even if raw reported >50%, planner MUST clamp Android to 50%
      vram_safe_mb: 0,
      compute_tflops: 2.6,
      mem_bw_gbps: 64,
      rtt_ms: 0.3,
      p95_rtt_ms: 0.35,
      pkt_loss_pct: 0,
      bandwidth_mbps: 3000,
      temp_c: 38,
      thermal_headroom: 0.25,
      vulkan_active: true,
      execution_backend: "Vulkan 1.4",
      handshake_ok: true,
      status: "CONNECTED",
    },
  ];
  const model: GgufMeta = {
    model_path: "models/Qwen3-30B-A3B-Q4_K_M.gguf",
    file_size_mb: 18500,
    is_moe: true,
    is_ternary: false,
    arch: "qwen3moe",
    quant: "Q4_K_M",
  };
  const plan = computeClusterPlan(mixedNodes, model, baseConfig);
  const win = plan.active_nodes.find((n) => n.node_id === "win-workstation");
  const droid = plan.active_nodes.find((n) => n.node_id === "android-phone");
  assert.ok(win && droid);
  assert.equal(win.safe_cap_mb, 13312);
  assert.ok(win.alloc_mb! > 8192, "Windows workstation should allocate >50% of 16GB RAM");
  assert.equal(droid.safe_cap_mb, 6144, "Android spoke must stay strictly capped at 50% of 12GB RAM");
});

test("Advanced RAM/VRAM/reserve tuning dynamically scales node caps while preserving strict safety invariant", () => {
  assert.equal(computeDesktopSafeCap(10240, 80, 1024), 7372);
  assert.equal(computeVramSafeCap(4096, 50), 2048);
  assert.equal(computeVramSafeCap(4096, 90), 3646);
  assert.equal(computeVramSafeCap(4096, 100), 3646);

  const suite = buildVirtual4NodeSuite(50, {
    ...baseConfig,
    desktop_ram_cap_pct: 75,
    vram_cap_pct: 50,
    os_reserve_mb: 1024,
  });

  const master = suite.plan.active_nodes.find((n) => n.node_id === "master-rtx3050");
  assert.ok(master);
  assert.equal(master.safe_cap_mb, computeDesktopSafeCap(10240, 75, 1024));
  assert.equal(master.vram_safe_mb, 2048);
  for (const n of suite.plan.active_nodes) {
    assert.ok((n.alloc_mb ?? 0) <= n.safe_cap_mb + n.vram_safe_mb);
  }
});

test("Advanced execution & sampling tuning flags emit cleanly only when emit_tuning_flags is true", () => {
  const suite = buildVirtual4NodeSuite(50, baseConfig);

  const defaultPlan = computeClusterPlan(suite.nodes, suite.model, baseConfig);
  assert.ok(!defaultPlan.flags.includes("--temp"));
  assert.ok(!defaultPlan.flags.includes("-b"));

  const tunedPlan = computeClusterPlan(suite.nodes, suite.model, {
    ...baseConfig,
    emit_tuning_flags: true,
    kv_quant: "f16",
    batch_size: 4096,
    ubatch_size: 1024,
    threads: 8,
    mlock: true,
    temp: 0.35,
    top_p: 0.95,
    top_k: 32,
    min_p: 0.06,
    repeat_penalty: 1.08,
    seed: 42,
  });

  for (const expected of ["-ctk", "f16", "-b", "4096", "-ub", "1024", "-t", "8", "--mlock", "--temp", "0.35", "--min-p", "0.06", "--seed", "42"]) {
    assert.ok(tunedPlan.flags.includes(expected), `Expected flag ${expected}`);
  }
});

test("Experimental Android >50% cap requires both experimental_fork_enabled and allow_android_over_50", () => {
  const suite = buildVirtual4NodeSuite(50, baseConfig);

  // Without experimental_fork_enabled, android_ram_cap_pct: 75 must still clamp to 50% (6144 MB)
  const blockedPlan = computeClusterPlan(suite.nodes, suite.model, {
    ...baseConfig,
    android_ram_cap_pct: 75,
    allow_android_over_50: true,
    experimental_fork_enabled: false,
  });
  const blockedAndroid = blockedPlan.active_nodes.find((n) => n.node_id === "android-usb-12gb");
  assert.ok(blockedAndroid);
  assert.equal(blockedAndroid.safe_cap_mb, 6144);

  // With both experimental_fork_enabled & allow_android_over_50 enabled, Android uses up to 75% bounded by MemAvail - reserve
  const unlockedPlan = computeClusterPlan(suite.nodes, suite.model, {
    ...baseConfig,
    android_ram_cap_pct: 75,
    allow_android_over_50: true,
    experimental_fork_enabled: true,
  });
  const unlockedAndroid = unlockedPlan.active_nodes.find((n) => n.node_id === "android-usb-12gb");
  assert.ok(unlockedAndroid);
  assert.equal(unlockedAndroid.safe_cap_mb, 8288);
  assert.ok((unlockedAndroid.alloc_mb ?? 0) <= unlockedAndroid.safe_cap_mb);
});

test("4-node virtual suite never exceeds node safe_cap_mb + vram_safe_mb and normalizes tensor-split to 100.0", () => {
  const suite = buildVirtual4NodeSuite(50, baseConfig);
  assert.equal(suite.passed, true);
  assert.equal(suite.simulated, true);

  for (const n of suite.plan.active_nodes) {
    const capTotal = n.safe_cap_mb + n.vram_safe_mb;
    assert.ok(
      (n.alloc_mb ?? 0) <= capTotal,
      `OOM invariant violated on ${n.node_id}: alloc=${n.alloc_mb} > capTotal=${capTotal}`
    );
  }

  const splitSum = suite.plan.tensor_split.split(",").map(Number).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(splitSum - 100.0) < 0.15, `Expected tensor-split sum ~100.0, got ${splitSum}`);
  assert.equal(suite.plan.mmap_stream, false);
  assert.ok(suite.plan.flags.includes("--no-mmap"));
  assert.ok(!suite.plan.flags.includes("--rpc-async"));
  assert.ok(!suite.plan.flags.includes("--rpc-wire-quant"));
  assert.ok(suite.plan.flags.includes(`"${baseConfig.moe_ot_regex}"`));
});

test("omits --no-mmap and enables mmap_stream when model exceeds cluster safe memory", () => {
  const singleMaster: NodeTelemetry[] = [
    {
      node_id: "master-hub",
      is_master: true,
      os: "linux",
      silicon: "Generic CPU",
      ip: "127.0.0.1",
      link_type: "loopback",
      rpc_port: 50052,
      rpc_version: 9,
      git_tag: "v1.0.0",
      ram_total_mb: 16384,
      ram_avail_mb: 12000,
      safe_cap_mb: computeDesktopSafeCap(12000),
      vram_safe_mb: 0,
      compute_tflops: 1.5,
      mem_bw_gbps: 45,
      rtt_ms: 0,
      p95_rtt_ms: 0,
      pkt_loss_pct: 0,
      bandwidth_mbps: 10000,
      temp_c: 40,
      thermal_headroom: 0.25,
      vulkan_active: false,
      execution_backend: "Host CPU",
      handshake_ok: true,
      status: "CONNECTED",
    },
  ];
  const hugeModel: GgufMeta = {
    model_path: "models/Llama-3.3-70B-Instruct-Q4_K_M.gguf",
    file_size_mb: 40500,
    is_moe: false,
    is_ternary: false,
    arch: "llama",
    quant: "Q4_K_M",
  };

  const plan = computeClusterPlan(singleMaster, hugeModel, baseConfig);
  assert.equal(plan.mmap_stream, true);
  assert.equal(plan.tier_2_ssd_streaming, true);
  assert.equal(plan.cluster_tier, "C");
  assert.ok(!plan.flags.includes("--no-mmap"));
  assert.equal(plan.active_nodes[0].alloc_mb, 10976);
});

test("offline spokes get alloc_mb=0 and are excluded from active_nodes and --rpc", () => {
  const suite = buildVirtual4NodeSuite(50, baseConfig);
  const nodesWithDisconnect = suite.nodes.map((n) =>
    n.node_id === "android-usb-12gb" ? { ...n, status: "OFFLINE" as const, handshake_ok: false } : n
  );

  const plan = computeClusterPlan(nodesWithDisconnect, suite.model, baseConfig);
  const offlineSpoke = plan.pruned_nodes.find((n) => n.node_id === "android-usb-12gb");
  assert.ok(offlineSpoke);
  assert.equal(offlineSpoke.alloc_mb, 0);
  assert.ok(!plan.active_nodes.some((n) => n.node_id === "android-usb-12gb"));
  assert.ok(!plan.rpc_arg.includes("127.0.0.1:50052"));
});

test("Auto-Master Election, Cluster Strength Tier S/A/B/C classification, and continuous batching flags", () => {
  const desktopScore = computeNodeStrengthScore(224, 9.1, 4096);
  const phoneScore = computeNodeStrengthScore(64, 2.6, 0);
  const piScore = computeNodeStrengthScore(17, 0.35, 0);
  assert.ok(desktopScore > phoneScore);
  assert.ok(phoneScore > piScore);

  assert.equal(classifyClusterTier(48000, 21275, 12288, true).tier, "S");
  assert.equal(classifyClusterTier(20000, 18000, 4096, false).tier, "A");
  assert.equal(classifyClusterTier(12000, 10000, 0, false).tier, "B");
  assert.equal(classifyClusterTier(12000, 22000, 4096, false).tier, "C");

  const suite = buildVirtual4NodeSuite(50, { ...baseConfig, ctx_size: 0 });
  assert.equal(suite.plan.elected_master_id, "master-rtx3050");
  assert.equal(suite.plan.cluster_tier, "A");
  assert.ok(suite.plan.flags.includes("--cont-batching"));
  assert.ok(suite.plan.flags.includes("--cache-reuse"));
  assert.ok(suite.plan.flags.includes("--parallel"));
  assert.ok(suite.plan.auto_ctx_size >= 2048);
  assert.ok(suite.plan.decisions.length >= 5);
});

test("RadixPrefixRouter, Prompt Lookup N-gram drafter, and Symmetric LAN TP detection", () => {
  const router = new RadixPrefixRouter(2);
  const r1 = router.routeSlot("You are a Rust systems architect debugging a GGUF cluster.");
  const r2 = router.routeSlot("You are a Python trainer optimizing CUDA kernels.");
  const r1Repeat = router.routeSlot("You are a Rust systems architect debugging a GGUF cluster.");
  assert.equal(r1.cacheHit, false);
  assert.equal(r2.cacheHit, false);
  assert.equal(r1Repeat.cacheHit, true);
  assert.equal(r1Repeat.slotId, r1.slotId);

  const repeatedPrompt =
    "fn compute_cluster_plan(nodes: &[SpokeTelemetry], cfg: &ClusterConfig) -> ClusterPlan { return plan; } " +
    "explain how fn compute_cluster_plan(nodes: &[SpokeTelemetry], cfg:";
  const draft = proposeNgramDraft(repeatedPrompt, 4);
  assert.ok(draft && draft.length >= 1);
  assert.equal(draft[0], "&ClusterConfig)");

  const suite = buildVirtual4NodeSuite(50, baseConfig);
  assert.equal(isSymmetricLanTpEligible(suite.nodes), false);

  const symNodes: NodeTelemetry[] = [0, 1].map((i) => ({
    ...suite.nodes[0],
    node_id: `lan-box-${i}`,
    is_master: i === 0,
    ram_total_mb: 16384,
    compute_tflops: 2.0,
    bandwidth_mbps: 1000,
  }));
  assert.equal(isSymmetricLanTpEligible(symNodes), true);
});

test("ThermalBalancer enforces 88°C GPU / 0.98 Android emergency offload, 30s hold, and 5.0°C hysteresis band", () => {
  const tb = new ThermalBalancer();
  const hot = tb.evaluateNode("gpu-master", false, true, 62, 88, 0.9, 1000, DEFAULT_THERMAL_LIMITS);
  assert.equal(hot.state, "EMERGENCY_OFFLOAD");
  assert.equal(hot.capacity_scale, 0);

  // Even after dropping to 79°C 10s later, 30s hold + 5°C hysteresis blocks re-admission
  const hold = tb.evaluateNode("gpu-master", false, true, 60, 79, 0.7, 1010, DEFAULT_THERMAL_LIMITS);
  assert.equal(hold.state, "EMERGENCY_OFFLOAD");
  assert.equal(hold.cooldown_remaining_s, 20);

  // After 35s AND dropping >=5°C below shed (83 - 5 = 78°C), node re-admits cleanly
  const cool = tb.evaluateNode("gpu-master", false, true, 58, 76, 0.5, 1035, DEFAULT_THERMAL_LIMITS);
  assert.equal(cool.state, "COOL");
  assert.equal(cool.capacity_scale, 1.0);

  // Android thermal_headroom >= 0.97 triggers EmergencyOffload cleanly in plan
  const suite = buildVirtual4NodeSuite(50, baseConfig);
  const hotAndroid = suite.nodes.map((n) =>
    n.node_id === "android-usb-12gb" ? { ...n, thermal_headroom: 0.98, cpu_temp_c: 44 } : n
  );
  const plan = computeClusterPlan(hotAndroid, suite.model, baseConfig, undefined, {
    thermalBalancer: new ThermalBalancer(),
    clusterTokS: 20,
    nowEpochS: 2000,
  });
  const prunedAndroid = plan.pruned_nodes.find((n) => n.node_id === "android-usb-12gb");
  assert.ok(prunedAndroid);
  assert.equal(prunedAndroid.alloc_mb, 0);
  assert.equal(prunedAndroid.thermal_state, "EMERGENCY_OFFLOAD");
});

test("Self-Learning ClusterLearner updates 0.7/0.3 EMA, downscales on throttle, and persists cluster_history.json", () => {
  const tmpFile = path.join(os.tmpdir(), `cluster_history_test_${process.pid}.json`);
  try {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    const learner = new ClusterLearner(tmpFile);

    // < 50 tokens ignored
    const skipped = learner.recordCompletedSession({
      nodeId: "android-usb-12gb",
      silicon: "SD8Gen2",
      modelArch: "qwen3moe",
      quantType: "Q4_K_M",
      linkType: "adb_usb",
      tokensGenerated: 24,
      observedPerformanceScore: 100,
      observedTokSPerGb: 2.5,
      thermalRiseCPerMin: 0.5,
      maxSafeSlope: 6.0,
      speculativeAlpha: 0.75,
      hitThermalWarnOrThrottle: false,
      nowEpochS: 100,
    });
    assert.equal(skipped, null);

    // First valid session sets baseline 100.0
    const p1 = learner.recordCompletedSession({
      nodeId: "android-usb-12gb",
      silicon: "SD8Gen2",
      modelArch: "qwen3moe",
      quantType: "Q4_K_M",
      linkType: "adb_usb",
      tokensGenerated: 120,
      observedPerformanceScore: 100,
      observedTokSPerGb: 2.5,
      thermalRiseCPerMin: 1.0,
      maxSafeSlope: 6.0,
      speculativeAlpha: 0.78,
      hitThermalWarnOrThrottle: false,
      nowEpochS: 110,
    });
    assert.ok(p1);
    assert.equal(p1.learned_score, 100);
    assert.equal(p1.recommended_load_scale, 1.0);

    // Second session hits thermal throttle -> 0.7 * 100 + 0.3 * 60 = 88.0 & downscales load_scale
    const p2 = learner.recordCompletedSession({
      nodeId: "android-usb-12gb",
      silicon: "SD8Gen2",
      modelArch: "qwen3moe",
      quantType: "Q4_K_M",
      linkType: "adb_usb",
      tokensGenerated: 150,
      observedPerformanceScore: 60,
      observedTokSPerGb: 1.4,
      thermalRiseCPerMin: 4.5,
      maxSafeSlope: 6.0,
      speculativeAlpha: 0.72,
      hitThermalWarnOrThrottle: true,
      nowEpochS: 200,
    });
    assert.ok(p2);
    assert.ok(Math.abs(p2.learned_score - 88.0) < 0.01);
    assert.ok(p2.recommended_load_scale < 1.0);
    assert.equal(p2.oom_or_throttle_count, 1);

    // Reload from disk & verify persistence + reset
    const reloaded = new ClusterLearner(tmpFile);
    const found = reloaded.lookup("android-usb-12gb", "SD8Gen2", "qwen3moe", "Q4_K_M", "adb_usb");
    assert.ok(found);
    assert.equal(found.sessions_observed, 2);
    reloaded.reset();
    assert.equal(reloaded.allProfiles().length, 0);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test("Per-node overrides disable spokes or scale weight and threads cleanly", () => {
  const suite = buildVirtual4NodeSuite(50, baseConfig);
  const plan = computeClusterPlan(suite.nodes, suite.model, {
    ...baseConfig,
    node_overrides: {
      "pi400-4gb": { disabled: true },
    },
  });
  const pi = plan.pruned_nodes.find((n) => n.node_id === "pi400-4gb");
  assert.ok(pi);
  assert.equal(pi.alloc_mb, 0);
  assert.equal(pi.prune_reason, "Disabled via node override");
});

