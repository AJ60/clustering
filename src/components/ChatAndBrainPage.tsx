import React, { useMemo, useRef, useState } from 'react';
import {
  BackendTuningConfig,
  ContextLengthOption,
  GgufModelPreset,
  KvCacheQuantOption,
  StarClusterPlan,
} from '../types/starCluster';
import {
  Activity,
  Brain,
  Cpu,
  HardDrive,
  Infinity as InfinityIcon,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  Zap,
} from 'lucide-react';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tokPerSec?: number;
  latencyMs?: number;
  activeParamsB?: number;
  tokensCount?: number;
}

interface ChatAndBrainPageProps {
  activeModel: GgufModelPreset;
  clusterPlan: StarClusterPlan;
  tuningConfig: BackendTuningConfig;
  upstreamBaseUrl: string;
  onChangeUpstreamBaseUrl: (url: string) => void;
  onOpenModels: () => void;
  onUpdateTuningConfig?: (patch: Partial<BackendTuningConfig>) => void;
}

const STARTER_PROMPTS = [
  'Whats the issue for long prompts and how does the cluster survive 24hr agentic tasks?',
  'write a 1000 word story about space',
  'Show active parameters and layer split across every Windows & Linux node.',
  'Explain how MoE expert offloading and WDDM VRAM guards improve speed here.',
];

const CONTEXT_OPTIONS: { label: string; value: ContextLengthOption }[] = [
  { label: '4K', value: 4096 },
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
  { label: '128K', value: 131072 },
  { label: '262K', value: 262144 },
];

const KV_OPTIONS: { label: string; value: KvCacheQuantOption; desc: string }[] = [
  { label: 'F16', value: 'f16', desc: 'Full Precision' },
  { label: 'Q8_0', value: 'q8_0', desc: '50% RAM Cut' },
  { label: 'Q4_0', value: 'q4_0', desc: 'TurboQuant · 75% Cut' },
];

function renderInlineFormatting(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      const code = token.slice(1, -1);
      parts.push(
        <code
          key={match.index}
          className="rounded bg-slate-200/90 dark:bg-slate-800 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 font-mono text-[11px] font-medium"
        >
          {code}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const boldText = token.slice(2, -2);
      parts.push(
        <strong key={match.index} className="font-semibold text-slate-900 dark:text-slate-100">
          {boldText}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const italicText = token.slice(1, -1);
      parts.push(
        <em key={match.index} className="italic text-slate-600 dark:text-slate-300">
          {italicText}
        </em>
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 0 ? text : <>{parts}</>;
}

const FormattedMarkdownMessage: React.FC<{ content: string }> = ({ content }) => {
  if (!content) return null;

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 1. Code blocks: ```
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <div key={`code-${i}`} className="my-2 rounded-lg overflow-hidden border border-slate-700 bg-slate-950 text-slate-100">
          {lang && (
            <div className="bg-slate-900 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 border-b border-slate-800">
              {lang}
            </div>
          )}
          <pre className="p-3 text-[11px] font-mono leading-relaxed overflow-x-auto text-emerald-400">
            <code>{codeLines.join('\n')}</code>
          </pre>
        </div>
      );
      continue;
    }

    // 2. Heading 3: ###
    if (trimmed.startsWith('### ')) {
      elements.push(
        <h3
          key={`h3-${i}`}
          className="font-display text-xs font-bold text-slate-900 dark:text-slate-100 mt-2.5 mb-1.5 flex items-center gap-1.5 border-b border-slate-200/80 dark:border-slate-800/80 pb-1"
        >
          {renderInlineFormatting(trimmed.slice(4))}
        </h3>
      );
      i++;
      continue;
    }

    // 3. Heading 4: ####
    if (trimmed.startsWith('#### ')) {
      elements.push(
        <h4
          key={`h4-${i}`}
          className="font-display text-xs font-bold text-amber-500 dark:text-amber-400 mt-2.5 mb-1"
        >
          {renderInlineFormatting(trimmed.slice(5))}
        </h4>
      );
      i++;
      continue;
    }

    // 4. Blockquotes: >
    if (trimmed.startsWith('> ')) {
      elements.push(
        <blockquote
          key={`bq-${i}`}
          className="border-l-2 border-amber-500 bg-amber-500/5 dark:bg-amber-500/10 rounded-r px-3 py-1.5 my-1.5 text-slate-700 dark:text-slate-300 italic"
        >
          {renderInlineFormatting(trimmed.slice(2))}
        </blockquote>
      );
      i++;
      continue;
    }

    // 5. Bullet or Numbered list items
    if (/^(\d+\.|\-|\*)\s+/.test(trimmed)) {
      const listItems: { marker?: string; text: string }[] = [];
      while (i < lines.length && /^(\d+\.|\-|\*)\s+/.test(lines[i].trim())) {
        const itemLine = lines[i].trim();
        const numMatch = itemLine.match(/^(\d+\.)\s+(.*)$/);
        if (numMatch) {
          listItems.push({ marker: numMatch[1], text: numMatch[2] });
        } else {
          listItems.push({ marker: '•', text: itemLine.replace(/^[-*]\s+/, '') });
        }
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="my-1.5 space-y-1.5 pl-1">
          {listItems.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-xs leading-relaxed text-slate-800 dark:text-slate-200">
              <span className="text-amber-500 dark:text-amber-400 font-semibold font-mono text-[11px] select-none mt-0.5 shrink-0">
                {item.marker}
              </span>
              <span className="flex-1">{renderInlineFormatting(item.text)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 6. Empty line: spacer
    if (!trimmed) {
      elements.push(<div key={`empty-${i}`} className="h-1" />);
      i++;
      continue;
    }

    // 7. Regular paragraph
    elements.push(
      <p key={`p-${i}`} className="my-1 text-xs leading-relaxed text-slate-800 dark:text-slate-200">
        {renderInlineFormatting(trimmed)}
      </p>
    );
    i++;
  }

  return <div className="space-y-0.5">{elements}</div>;
};

export const ChatAndBrainPage: React.FC<ChatAndBrainPageProps> = ({
  activeModel,
  clusterPlan,
  tuningConfig,
  upstreamBaseUrl,
  onChangeUpstreamBaseUrl,
  onOpenModels,
  onUpdateTuningConfig,
}) => {
  const [messages, setMessages] = useState<ChatTurn[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `Cluster Brain ready on **${activeModel.name}** (${activeModel.quant}). Currently routing **${clusterPlan.activeParamsPerTokenB}B active** of **${clusterPlan.totalParamsB}B total** parameters across **${clusterPlan.nodes.filter((n) => n.allocatedLayers > 0).length} node(s)** at ~${clusterPlan.estimatedClusterTokPerSec} tok/s.`,
      activeParamsB: clusterPlan.activeParamsPerTokenB,
      tokPerSec: clusterPlan.estimatedClusterTokPerSec,
    },
  ]);
  const [input, setInput] = useState('');
  const [temperature, setTemperature] = useState(0.6);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showUpstreamInput, setShowUpstreamInput] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeNodes = useMemo(
    () => clusterPlan.nodes.filter((n) => n.allocatedLayers > 0),
    [clusterPlan.nodes]
  );

  const activePct = Math.min(
    100,
    Math.round((clusterPlan.activeParamsPerTokenB / Math.max(0.1, clusterPlan.totalParamsB)) * 100)
  );

  const stopGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  };

  const sendMessage = async (promptOverride?: string) => {
    const text = (promptOverride ?? input).trim();
    if (!text || isStreaming) return;

    setErrorMsg(null);
    const userTurn: ChatTurn = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
    };
    const assistantId = `ast-${Date.now()}`;
    const assistantPlaceholder: ChatTurn = {
      id: assistantId,
      role: 'assistant',
      content: '',
      activeParamsB: clusterPlan.activeParamsPerTokenB,
    };

    const historyForApi = [...messages, userTurn].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, userTurn, assistantPlaceholder]);
    if (!promptOverride) setInput('');
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const t0 = performance.now();

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel.id,
          messages: historyForApi,
          temperature,
          stream: true,
          x_upstream_url: upstreamBaseUrl || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Endpoint returned HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let finalTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { completion_tokens?: number };
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              accumulated += delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: accumulated } : m
                )
              );
            }
            if (parsed.usage?.completion_tokens) {
              finalTokens = parsed.usage.completion_tokens;
            }
          } catch {
            // Skip partial chunk lines
          }
        }
      }

      const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
      const approxTokens = finalTokens || Math.max(12, Math.round(accumulated.length / 4));
      const measuredTok = Number(
        Math.max(1, (approxTokens / Math.max(0.05, elapsedMs / 1000))).toFixed(1)
      );

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                latencyMs: elapsedMs,
                tokensCount: approxTokens,
                tokPerSec: Math.min(measuredTok, clusterPlan.estimatedClusterTokPerSec * 4),
              }
            : m
        )
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setErrorMsg(
          err instanceof Error ? err.message : 'Failed to reach /v1/chat/completions'
        );
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start pb-8">
      {/* Left 7 Columns: OpenAI-Compatible Chat Window */}
      <section className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] flex flex-col min-h-[580px] max-h-[780px] overflow-hidden">
        {/* Chat Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                {activeModel.name}
              </h1>
              <span className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
                {activeModel.quant}
              </span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
              POST /v1/chat/completions · {clusterPlan.activeParamsPerTokenB}B active / tok ·{' '}
              {upstreamBaseUrl ? `Upstream: ${upstreamBaseUrl}` : 'Cluster Pipeline Runtime'}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowUpstreamInput((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Upstream</span>
            </button>
            <button
              type="button"
              onClick={onOpenModels}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500"
            >
              Switch Model
            </button>
            <button
              type="button"
              onClick={() => setMessages([])}
              title="Clear Chat"
              className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Optional Live Upstream llama-server URL Bar */}
        {showUpstreamInput && (
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B1120] space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-200">
                Optional Local `llama-server` / `clusterd` OpenAI Base URL
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                Leave blank to use ClusterLab built-in OpenAI runtime
              </span>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={upstreamBaseUrl}
                onChange={(e) => onChangeUpstreamBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:8080/v1"
                className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] px-3 py-1.5 text-xs font-mono-num text-slate-900 dark:text-slate-100"
              />
              <div className="flex items-center gap-2 text-xs">
                <label className="text-slate-500 dark:text-slate-400 font-mono-num">
                  Temp {temperature.toFixed(1)}
                </label>
                <input
                  type="range"
                  min={0}
                  max={1.2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-20 accent-blue-600"
                />
              </div>
            </div>
          </div>
        )}

        {/* Scrollable Message Thread */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center py-10 space-y-3">
              <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                Ready to chat with {activeModel.name}
              </div>
              <div className="flex flex-wrap justify-center gap-2 max-w-md">
                {STARTER_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => void sendMessage(p)}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:border-blue-500 text-left"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[88%] rounded-xl px-4 py-3 text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-amber-500 text-black font-semibold shadow-xs whitespace-pre-wrap'
                    : 'bg-[#0B1120] border border-slate-800 text-slate-100 shadow-xs'
                }`}
              >
                {msg.role === 'user' ? (
                  msg.content
                ) : msg.content ? (
                  <FormattedMarkdownMessage content={msg.content} />
                ) : (
                  <span className="text-slate-400 italic">
                    {isStreaming ? 'Routing across star nodes...' : ''}
                  </span>
                )}
              </div>
              {msg.role === 'assistant' && (msg.tokPerSec || msg.latencyMs) && (
                <div className="mt-1.5 px-1 flex flex-wrap items-center gap-2 text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                  {msg.activeParamsB ? (
                    <span className="inline-flex items-center gap-1 rounded bg-slate-100 dark:bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-700 dark:text-slate-300">
                      <Cpu className="w-3 h-3 text-blue-500" />
                      <span>{msg.activeParamsB}B active</span>
                    </span>
                  ) : null}
                  {msg.tokPerSec ? (
                    <span className="inline-flex items-center gap-1 rounded bg-slate-100 dark:bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                      <Zap className="w-3 h-3 text-emerald-500" />
                      <span>~{msg.tokPerSec} tok/s</span>
                    </span>
                  ) : null}
                  {msg.latencyMs ? (
                    <span className="text-[10px] text-slate-400">
                      {msg.latencyMs}ms
                    </span>
                  ) : null}
                  {msg.tokensCount ? (
                    <span className="text-[10px] text-slate-400">
                      · {msg.tokensCount} tokens
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          ))}

          {errorMsg && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {errorMsg}
            </div>
          )}
        </div>

        {/* Starter Prompts Row + Composer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-[#0B1120]/60 space-y-2.5">
          {messages.length > 0 && messages.length < 3 && (
            <div className="flex flex-wrap gap-1.5">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void sendMessage(p)}
                  disabled={isStreaming}
                  className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] px-2.5 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:border-blue-500 disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Message ${activeModel.name} via /v1/chat/completions...`}
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={stopGeneration}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white px-4 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
              >
                <Square className="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send</span>
              </button>
            )}
          </form>
        </div>
      </section>

      {/* Right 5 Columns: Cluster Brain & Active Parameters Per Node */}
      <aside className="lg:col-span-5 space-y-4">
        {/* Brain Summary Card */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-blue-500" />
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                Cluster Brain & Active Parameters
              </h2>
            </div>
            <span className="text-xs font-mono-num font-semibold text-blue-600 dark:text-blue-400">
              {isStreaming ? 'Streaming Tokens' : 'Ready'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-slate-50 dark:bg-[#0B1120] p-3 border border-slate-200 dark:border-slate-800">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Active / Token
              </div>
              <div className="text-lg font-bold font-mono-num text-slate-900 dark:text-slate-100 mt-0.5">
                {clusterPlan.activeParamsPerTokenB}B{' '}
                <span className="text-xs font-normal text-slate-500">
                  / {clusterPlan.totalParamsB}B
                </span>
              </div>
              <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 mt-0.5">
                {activePct}% weights execute per step
              </div>
            </div>

            <div className="rounded-lg bg-slate-50 dark:bg-[#0B1120] p-3 border border-slate-200 dark:border-slate-800">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                KV Cache & Speed
              </div>
              <div className="text-lg font-bold font-mono-num text-slate-900 dark:text-slate-100 mt-0.5">
                ~{clusterPlan.estimatedClusterTokPerSec} tok/s
              </div>
              <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 mt-0.5">
                {tuningConfig.contextLength.toLocaleString()} ctx · {clusterPlan.kvCacheTotalMb} MB{' '}
                {tuningConfig.kvCacheQuant.toUpperCase()}
              </div>
            </div>
          </div>

          {/* 24h Agentic Longevity & Context Horizon Tuning Controls */}
          {onUpdateTuningConfig && (
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
              {/* Context Length Horizon Selector */}
              <div>
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    Context Horizon
                  </span>
                  <span className="text-[10px] font-mono-num text-slate-500">
                    Max: {(activeModel.maxContextLength || 131072).toLocaleString()} ctx
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {CONTEXT_OPTIONS.filter(
                    (opt) => opt.value <= (activeModel.maxContextLength || 262144)
                  ).map((opt) => {
                    const isSelected = tuningConfig.contextLength === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => onUpdateTuningConfig({ contextLength: opt.value })}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono-num font-semibold transition-all ${
                          isSelected
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* KV Cache Precision Selector */}
              <div>
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    KV Cache Precision
                  </span>
                  <span className="text-[10px] font-mono-num text-slate-500">
                    {clusterPlan.kvCacheTotalMb} MB VRAM/RAM
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {KV_OPTIONS.map((opt) => {
                    const isSelected = tuningConfig.kvCacheQuant === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => onUpdateTuningConfig({ kvCacheQuant: opt.value })}
                        className={`px-2 py-1 rounded text-center transition-all ${
                          isSelected
                            ? 'bg-blue-600/10 border border-blue-500 text-blue-600 dark:text-blue-400'
                            : 'bg-slate-100 dark:bg-slate-800/60 border border-transparent text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700'
                        }`}
                      >
                        <div className="text-[10px] font-bold font-mono-num">{opt.label}</div>
                        <div className="text-[9px] text-slate-500 truncate">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 24-Hour Agentic Longevity Guard Banner */}
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-2.5 flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <div className="space-y-0.5 text-[11px]">
                  <div className="font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                    <span>24h Agentic Longevity Guard: ACTIVE</span>
                    <InfinityIcon className="w-3.5 h-3.5 text-emerald-500" />
                  </div>
                  <div className="text-[10px] text-slate-600 dark:text-slate-300 leading-snug">
                    <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                      --ctx-shift
                    </span>{' '}
                    slides attention window dynamically on overflow. Zero OOM · continuous batching · WDDM & Android safe caps.
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
              <span>Active Expert / Dense Ratio</span>
              <span>{activePct}% active compute</span>
            </div>
            <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-blue-600 dark:bg-blue-400 transition-all"
                style={{ width: `${activePct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Per-Node Brain Breakdown */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-display font-bold text-sm text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-teal-500" />
              Active Parameters by Node ({activeNodes.length})
            </span>
            <span className="font-mono-num text-slate-500 dark:text-slate-400">
              Split: {clusterPlan.tensorSplitLabel}
            </span>
          </div>

          <div className="space-y-3">
            {clusterPlan.nodes.map((node) => {
              const nodeActiveRatio =
                clusterPlan.activeParamsPerTokenB > 0
                  ? Math.min(
                      100,
                      Math.round(
                        (node.activeParamsB / clusterPlan.activeParamsPerTokenB) * 100
                      )
                    )
                  : 0;
              const isNodeIdle = node.allocatedLayers === 0;

              return (
                <div
                  key={node.nodeId}
                  className={`rounded-lg border p-3.5 space-y-2 transition-colors ${
                    isNodeIdle
                      ? 'border-slate-200 dark:border-slate-800 opacity-60 bg-slate-50 dark:bg-[#0B1120]'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B1120]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
                        {node.label}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
                        {node.osType.toUpperCase()} · {node.backendDriver} · {node.linkType}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-bold font-mono-num text-blue-600 dark:text-blue-400">
                        {node.activeParamsB}B active
                      </div>
                      <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                        {node.allocatedLayers > 0
                          ? `L${node.layerStart}–L${node.layerEnd} (${node.allocatedLayers}L)`
                          : '0 layers'}
                      </div>
                    </div>
                  </div>

                  {/* Active Load Bar */}
                  <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        isStreaming && !isNodeIdle
                          ? 'bg-emerald-500'
                          : 'bg-blue-500'
                      }`}
                      style={{ width: `${nodeActiveRatio}%` }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                    <span className="flex items-center gap-1">
                      <HardDrive className="w-3 h-3" />
                      {(node.allocatedMb / 1024).toFixed(1)} GB · KV {node.kvCacheMb} MB
                    </span>
                    <span className="flex items-center gap-1">
                      <Zap className="w-3 h-3" />
                      {node.nglLayers} GPU / {Math.max(0, node.allocatedLayers - node.nglLayers)} CPU ·{' '}
                      {node.estimatedTokPerSec} tok/s
                    </span>
                    <span className="flex items-center gap-1">
                      <Activity className="w-3 h-3" />
                      {node.tempC.toFixed(0)}°C
                    </span>
                  </div>

                  {node.tuningFlags.length > 0 && (
                    <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 truncate">
                      {node.tuningFlags.join(' · ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
};
