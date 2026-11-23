import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Play,
  QrCode,
  ShieldCheck,
  Terminal,
  Wifi,
} from 'lucide-react';
import {
  DiagnosticSentinelReport,
  EngineRuntimeStatus,
  GgufModelPreset,
  LiveHardwareProbe,
  WifiDirectQrPayload,
} from '../types/starCluster';

interface ApiHarnessConnectPageProps {
  activeModel: GgufModelPreset;
  liveHardware?: LiveHardwareProbe;
  engineStatus?: EngineRuntimeStatus;
}

interface WifiDirectBridgeStatus {
  platform: string;
  driverAvailable: boolean;
  driverTool: string;
  p2pInterface: string | null;
  linkLocalSubnet: string;
  concurrentInternetPreserved: boolean;
  instructions: string;
}

export const ApiHarnessConnectPage: React.FC<ApiHarnessConnectPageProps> = ({
  activeModel,
  liveHardware,
  engineStatus,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  // Module 3: Wi-Fi Direct P2P QR state
  const [p2pQr, setP2pQr] = useState<WifiDirectQrPayload | null>(null);
  const [p2pStatus, setP2pStatus] = useState<WifiDirectBridgeStatus | null>(null);
  const [verifyingP2p, setVerifyingP2p] = useState(false);
  const [p2pVerifyResult, setP2pVerifyResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Module 6: 6-Check Diagnostic Sentinel state
  const [sentinelReport, setSentinelReport] = useState<DiagnosticSentinelReport | null>(null);
  const [runningSentinel, setRunningSentinel] = useState(false);
  const [sentinelError, setSentinelError] = useState<string | null>(null);

  const origin =
    typeof window !== 'undefined' ? window.location.origin : `http://${liveHardware?.hostIp || '127.0.0.1'}:3000`;
  const v1Base = `${origin}/v1`;
  const joinUrl = `${origin}/join`;

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [qrRes, stRes] = await Promise.all([
          fetch('/api/network/wifi-direct/qr'),
          fetch('/api/network/wifi-direct/status'),
        ]);
        if (!active) return;
        if (qrRes.ok) {
          const data = (await qrRes.json()) as { qr?: WifiDirectQrPayload };
          if (data.qr) setP2pQr(data.qr);
        }
        if (stRes.ok) {
          const data = (await stRes.json()) as { status?: WifiDirectBridgeStatus };
          if (data.status) setP2pStatus(data.status);
        }
      } catch {
        // non-fatal
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // ignore
    }
  };

  const runLiveV1Check = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const res = await fetch('/v1/models');
      const data = await res.json();
      setProbeResult(JSON.stringify(data, null, 2));
    } catch {
      setProbeResult('Error probing /v1/models');
    } finally {
      setProbing(false);
    }
  };

  const handleVerifyP2pPayload = async () => {
    if (!p2pQr) return;
    setVerifyingP2p(true);
    setP2pVerifyResult(null);
    try {
      const res = await fetch('/api/network/wifi-direct/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawPayload: p2pQr.rawPayload }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      setP2pVerifyResult({
        ok: Boolean(res.ok && data.ok),
        text: data.message || data.error || (res.ok ? 'CRC-8 & HMAC-SHA256 P2P payload verified.' : 'Verification failed.'),
      });
    } catch {
      setP2pVerifyResult({ ok: false, text: 'Unable to reach Wi-Fi Direct coordinator endpoint.' });
    } finally {
      setVerifyingP2p(false);
    }
  };

  const runDiagnosticSentinel = useCallback(async () => {
    setRunningSentinel(true);
    setSentinelError(null);
    try {
      const res = await fetch('/api/diagnostics/sentinel');
      if (!res.ok) throw new Error(`Sentinel check failed (HTTP ${res.status})`);
      const report = (await res.json()) as DiagnosticSentinelReport;
      setSentinelReport(report);
    } catch (err) {
      setSentinelError(err instanceof Error ? err.message : 'Unable to execute 6-Check Diagnostic Sentinel.');
    } finally {
      setRunningSentinel(false);
    }
  }, []);

  const snippets = [
    {
      id: 'curl',
      title: 'cURL (Tools + Streaming + 10s SSE Keepalive)',
      code: `curl -N ${v1Base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${activeModel.id}",
    "stream": true,
    "messages": [{"role": "user", "content": "Summarize this repository"}],
    "tools": [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}]
  }'`,
    },
    {
      id: 'aider',
      title: 'Aider / OpenCode / Cline / Continue',
      code: `OPENAI_API_BASE=${v1Base}
OPENAI_API_KEY=silica-local
MODEL=${activeModel.id}
# Supports --jinja delta.tool_calls, image_url vision payloads, and 10s SSE keepalives.`,
    },
    {
      id: 'openai-sdk',
      title: 'OpenAI TypeScript / Python SDK',
      code: `import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${v1Base}", apiKey: "silica-local" });
const stream = await client.chat.completions.create({
  model: "${activeModel.id}",
  stream: true,
  messages: [{ role: "user", content: "Hello Silica Cluster" }],
});`,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Connect OpenAI-Compatible Agents & Edge Workers
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Full <code className="font-mono-num">--jinja</code> tool calling, multimodal{' '}
            <code className="font-mono-num">image_url</code> forwarding, separated{' '}
            <code className="font-mono-num">reasoning_content</code>, WebGPU browser workers, and Wi-Fi Direct P2P pairing.
          </p>
        </div>
        <span className="text-xs font-mono-num text-slate-600 dark:text-slate-300 shrink-0">
          {engineStatus?.running ? `Live · ${engineStatus.upstreamUrl}` : 'Engine Offline (HTTP 503)'}
        </span>
      </div>

      {/* Endpoint bar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs text-slate-500 dark:text-slate-400">OpenAI Base URL</p>
          <p className="text-sm font-mono-num font-semibold text-slate-900 dark:text-slate-100">
            {v1Base}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => copyText('base', v1Base)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            {copiedId === 'base' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === 'base' ? 'Copied' : 'Copy Base URL'}
          </button>
          <button
            type="button"
            disabled={probing}
            onClick={runLiveV1Check}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            {probing ? 'Testing...' : 'Test /v1/models'}
          </button>
        </div>
      </div>

      {probeResult && (
        <pre className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#090D16] font-mono-num text-xs text-slate-700 dark:text-slate-300 overflow-x-auto max-h-64">
          {probeResult}
        </pre>
      )}

      {/* SDK Snippets */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {snippets.map((s) => (
          <div
            key={s.id}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                {s.title}
              </h2>
              <button
                type="button"
                onClick={() => copyText(s.id, s.code)}
                className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                aria-label={`Copy ${s.title}`}
              >
                {copiedId === s.id ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <pre className="flex-1 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#090D16] font-mono-num text-[11px] text-slate-700 dark:text-slate-300 overflow-x-auto">
              {s.code}
            </pre>
          </div>
        ))}
      </div>

      {/* Edge Scaling: Zero-Install WebGPU Worker (/join) & Wi-Fi Direct P2P Mesh */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Wifi className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              Edge Scaling: WebGPU Browser Worker & Wi-Fi Direct P2P Mesh
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Expand your cluster without installing binaries via <code className="font-mono-num">/join</code>, or pair offline Android phones over 5GHz Wi-Fi Direct P2P.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => copyText('join-url', joinUrl)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {copiedId === 'join-url' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedId === 'join-url' ? 'Copied /join URL' : 'Copy /join URL'}
            </button>
            <a
              href="/join"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap shrink-0 hover:opacity-90 transition-opacity"
            >
              Open /join Worker
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* 21x21 CRC-8 SVG QR Matrix */}
          <div className="lg:col-span-4 flex flex-col items-center sm:items-start gap-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
              <QrCode className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              Wi-Fi Direct CRC-8 Pairing Matrix (21×21)
            </div>
            {p2pQr ? (
              <div className="p-3 rounded-lg bg-white border border-slate-200 dark:border-slate-700 inline-block">
                <svg
                  role="img"
                  aria-label="Wi-Fi Direct P2P CRC-8 pairing QR matrix"
                  viewBox="0 0 21 21"
                  className="w-36 h-36"
                  shapeRendering="crispEdges"
                >
                  <rect width="21" height="21" fill="#ffffff" />
                  {p2pQr.matrix21x21.map((row, rIdx) =>
                    row.map((cell, cIdx) =>
                      cell ? <rect key={`${rIdx}-${cIdx}`} x={cIdx} y={rIdx} width={1} height={1} fill="#0f172a" /> : null
                    )
                  )}
                </svg>
              </div>
            ) : (
              <div className="w-40 h-40 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
            )}
          </div>

          {/* P2P Details & Verify Control */}
          <div className="lg:col-span-8 space-y-3">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Zero-Install WebGPU URL</dt>
                <dd className="font-mono-num font-medium text-slate-900 dark:text-slate-100 mt-0.5 break-all">
                  {joinUrl}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Wi-Fi Direct Group SSID</dt>
                <dd className="font-mono-num font-medium text-slate-900 dark:text-slate-100 mt-0.5">
                  {p2pQr ? `${p2pQr.ssid} · CRC-8 ${p2pQr.crc8Hex}` : 'Loading...'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Link-Local RPC Endpoint</dt>
                <dd className="font-mono-num font-medium text-slate-900 dark:text-slate-100 mt-0.5">
                  {p2pQr?.endpoint || '192.168.49.1:50052'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Host P2P Driver Status</dt>
                <dd className="font-mono-num text-slate-700 dark:text-slate-300 mt-0.5">
                  {p2pStatus
                    ? `${p2pStatus.driverAvailable ? 'Ready' : 'LAN / USB Fallback'} · ${p2pStatus.p2pInterface || p2pStatus.driverTool}`
                    : 'Probing wireless interface...'}
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={verifyingP2p || !p2pQr}
                onClick={handleVerifyP2pPayload}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                {verifyingP2p ? 'Verifying CRC-8...' : 'Verify P2P Payload'}
              </button>
              {p2pVerifyResult && (
                <span
                  className={`text-xs font-medium ${
                    p2pVerifyResult.ok
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-rose-700 dark:text-rose-400'
                  }`}
                >
                  {p2pVerifyResult.ok ? 'Verified: ' : 'Rejected: '}
                  {p2pVerifyResult.text}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Module 6: Autonomous 6-Check Diagnostic & LMKD Sentinel */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              Autonomous 6-Check Diagnostic & LMKD Sentinel
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Audits port bindings, ELF 16KB page alignment, Zero-OOM Android RAM caps, thermal headroom, network jitter, and upstream health.
            </p>
          </div>
          <button
            type="button"
            disabled={runningSentinel}
            onClick={runDiagnosticSentinel}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium whitespace-nowrap shrink-0 transition-colors disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {runningSentinel ? 'Running 6 Checks...' : 'Run 6-Check Sentinel'}
          </button>
        </div>

        {sentinelError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300"
          >
            {sentinelError}
          </div>
        )}

        {!sentinelReport && !runningSentinel && (
          <div className="border-t border-slate-100 dark:border-slate-800 pt-4 text-xs text-slate-500 dark:text-slate-400">
            Click <span className="font-medium text-slate-700 dark:text-slate-200">Run 6-Check Sentinel</span> to inspect host binaries, Android LMKD caps, thermal margins, and live inference reachability.
          </div>
        )}

        {runningSentinel && (
          <div className="space-y-2 border-t border-slate-100 dark:border-slate-800 pt-4 animate-pulse">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-9 rounded bg-slate-100 dark:bg-slate-800/80" />
            ))}
          </div>
        )}

        {sentinelReport && !runningSentinel && (
          <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono-num text-slate-600 dark:text-slate-300">
              <span>
                Passed {sentinelReport.passedCount} / {sentinelReport.totalChecks} checks · Overall:{' '}
                <strong
                  className={
                    sentinelReport.overallStatus === 'healthy'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : sentinelReport.overallStatus === 'degraded'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-rose-700 dark:text-rose-400'
                  }
                >
                  {sentinelReport.overallStatus === 'healthy'
                    ? 'Healthy'
                    : sentinelReport.overallStatus === 'degraded'
                      ? 'Degraded'
                      : 'Critical'}
                </strong>
              </span>
              <span className="text-slate-400">
                Audited {new Date(sentinelReport.timestamp).toLocaleTimeString()}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                    <th className="py-2 pr-3 font-medium w-10">#</th>
                    <th className="py-2 px-3 font-medium">Diagnostic Check</th>
                    <th className="py-2 px-3 font-medium w-24">Status</th>
                    <th className="py-2 pl-3 font-medium">Measured Result & Guidance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {sentinelReport.checks.map((chk) => (
                    <tr key={chk.id}>
                      <td className="py-2.5 pr-3 font-mono-num text-slate-400">
                        0{chk.index}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {chk.name}
                      </td>
                      <td className="py-2.5 px-3 font-mono-num font-medium whitespace-nowrap">
                        <span
                          className={
                            chk.status === 'pass'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : chk.status === 'warn'
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-rose-700 dark:text-rose-400'
                          }
                        >
                          {chk.status === 'pass' ? 'Pass' : chk.status === 'warn' ? 'Warn' : 'Fail'}
                        </span>
                      </td>
                      <td className="py-2.5 pl-3 text-slate-600 dark:text-slate-300">
                        <span className="font-medium text-slate-800 dark:text-slate-200">{chk.summary}</span>
                        {chk.detail && (
                          <span className="text-slate-500 dark:text-slate-400"> — {chk.detail}</span>
                        )}
                        {chk.remediation && (
                          <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                            Remediation: {chk.remediation}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

