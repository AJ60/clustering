import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronUp,
  Eye,
  Globe,
  ImagePlus,
  Loader2,
  Play,
  PlugZap,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  EngineRuntimeStatus,
  GGUF_MODEL_PRESETS,
  GgufModelPreset,
  StarClusterPlan,
} from '../types/starCluster';
import { splitReasoningContent } from '../domain/reasoningParser';

interface ChatAttachment {
  name: string;
  dataUrl: string;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  images?: ChatAttachment[];
  toolTrace?: string[];
  ttftMs?: number;
  tokPerSec?: number;
  isError?: boolean;
}

interface ChatAndBrainPageProps {
  activeModel: GgufModelPreset;
  plan: StarClusterPlan;
  engineStatus?: EngineRuntimeStatus;
  upstreamUrl: string;
  onUpstreamConnected: (url: string) => void;
  onOpenLoadConfig: () => void;
  onSelectModel?: (model: GgufModelPreset) => void;
  onApplyAndReload?: (spawnLocalBinary: boolean) => Promise<{ ok: boolean; message: string }>;
  onStopEngine?: () => Promise<{ ok: boolean; message: string }>;
}

const SERVER_PRESETS = [
  { label: 'llama-server :8080', url: 'http://127.0.0.1:8080' },
  { label: 'Ollama :11434', url: 'http://127.0.0.1:11434' },
  { label: 'LM Studio :1234', url: 'http://127.0.0.1:1234' },
];

const WEB_TOOLS_SPEC = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search public web knowledge for up-to-date information.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch public text content from an http(s) URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

export const ChatAndBrainPage: React.FC<ChatAndBrainPageProps> = ({
  activeModel,
  plan,
  engineStatus,
  upstreamUrl,
  onUpstreamConnected,
  onOpenLoadConfig,
  onSelectModel,
  onApplyAndReload,
  onStopEngine,
}) => {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [webToolsEnabled, setWebToolsEnabled] = useState(false);
  const [sending, setSending] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});

  // Local server quick-connect bar
  const [serverUrlInput, setServerUrlInput] = useState(upstreamUrl || 'http://127.0.0.1:8080');
  const [testingConn, setTestingConn] = useState(false);
  const [connFeedback, setConnFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isLive = Boolean(engineStatus?.running);
  const hasVision = Boolean(plan.masterMmprojPath || activeModel.mmprojPath);

  const readFilesToAttachments = (files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setAttachments((prev) => [...prev.slice(-3), { name: file.name || 'pasted-image.png', dataUrl: reader.result as string }]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      readFilesToAttachments(items);
    }
  };

  const testAndConnectServer = async (targetUrl = serverUrlInput) => {
    setTestingConn(true);
    setConnFeedback(null);
    try {
      const res = await fetch('/api/upstream/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl.trim(), apply: true }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        latencyMs?: number;
        serverType?: string;
        models?: string[];
        error?: string;
      };
      if (res.ok && data.ok) {
        setConnFeedback({
          ok: true,
          text: `Connected to ${data.serverType} (${data.latencyMs} ms · ${data.models?.length ?? 0} models)`,
        });
        onUpstreamConnected(targetUrl.trim());
      } else {
        setConnFeedback({ ok: false, text: data.error || 'Unable to reach local server.' });
      }
    } catch {
      setConnFeedback({ ok: false, text: 'Connection check failed.' });
    } finally {
      setTestingConn(false);
    }
  };

  const sendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const prompt = input.trim();
    if ((!prompt && attachments.length === 0) || sending) return;

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: prompt || 'Analyze attached image(s).',
      images: attachments.length > 0 ? [...attachments] : undefined,
    };
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [...prev, userTurn, { id: assistantId, role: 'assistant', content: '' }]);
    setInput('');
    setAttachments([]);
    setSending(true);

    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let rawAnswer = '';
    let rawReasoning = '';
    let tokenChunks = 0;

    try {
      const apiMessages = [...messages, userTurn].map((m) => {
        if (m.role === 'user' && m.images && m.images.length > 0) {
          return {
            role: 'user',
            content: [
              { type: 'text', text: m.content },
              ...m.images.map((img) => ({
                type: 'image_url',
                image_url: { url: img.dataUrl },
              })),
            ],
          };
        }
        return { role: m.role, content: m.content };
      });

      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel.id,
          stream: true,
          messages: apiMessages,
          ...(webToolsEnabled ? { tools: WEB_TOOLS_SPEC, tool_choice: 'auto' } : {}),
        }),
      });

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; code?: string; recovery?: string };
        };
        const msg =
          errJson.error?.message ||
          (res.status === 503
            ? 'Engine offline (HTTP 503). Load a local GGUF model or connect llama-server / Ollama above.'
            : `Inference failed with HTTP ${res.status}.`);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: msg, isError: true } : m))
        );
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const toolCallsAccum: Record<number, { id: string; name: string; args: string }> = {};

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue; // Ignore 10s SSE `: keepalive`
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;

            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>;
              };
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;
              if (firstTokenAt === null && (delta.content || delta.reasoning_content)) {
                firstTokenAt = performance.now();
              }
              if (delta.reasoning_content) {
                rawReasoning += delta.reasoning_content;
                tokenChunks += 1;
              }
              if (delta.content) {
                rawAnswer += delta.content;
                tokenChunks += 1;
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsAccum[idx]) {
                    toolCallsAccum[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
                  }
                  if (tc.function?.name) toolCallsAccum[idx].name += tc.function.name;
                  if (tc.function?.arguments) toolCallsAccum[idx].args += tc.function.arguments;
                }
              }

              const split = splitReasoningContent(rawAnswer, rawReasoning);
              const elapsedS = Math.max(0.05, ((performance.now() - (firstTokenAt ?? startedAt)) / 1000));
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: split.answer,
                        reasoning: split.reasoning || undefined,
                        ttftMs: firstTokenAt ? Math.round(firstTokenAt - startedAt) : undefined,
                        tokPerSec: Number((tokenChunks / elapsedS).toFixed(1)),
                      }
                    : m
                )
              );
            } catch {
              // ignore malformed SSE chunk
            }
          }
        }
      }

      // Execute optional client-requested Web Tools if model emitted tool_calls
      const pendingTools = Object.values(toolCallsAccum).filter((t) => t.name);
      if (webToolsEnabled && pendingTools.length > 0) {
        const traces: string[] = [];
        for (const tc of pendingTools) {
          try {
            const parsedArgs = JSON.parse(tc.args || '{}') as { query?: string; url?: string };
            if (tc.name === 'web_search' && parsedArgs.query) {
              const r = await fetch('/api/tools/web-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: parsedArgs.query }),
              });
              const d = (await r.json()) as { results?: Array<{ title: string; snippet: string }> };
              traces.push(`web_search("${parsedArgs.query}") -> ${d.results?.length ?? 0} result(s)`);
            } else if (tc.name === 'fetch_url' && parsedArgs.url) {
              const r = await fetch('/api/tools/fetch-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: parsedArgs.url }),
              });
              const d = (await r.json()) as { ok?: boolean; status?: number; error?: string };
              traces.push(
                d.ok
                  ? `fetch_url("${parsedArgs.url}") -> HTTP ${d.status}`
                  : `fetch_url blocked: ${d.error}`
              );
            }
          } catch {
            traces.push(`${tc.name}(...) executed`);
          }
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, toolTrace: traces } : m))
        );
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: 'Network error contacting /v1/chat/completions.', isError: true }
            : m
        )
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Engine Status & Connect Local Server Bar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <span
              className={`font-semibold ${
                isLive
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-amber-700 dark:text-amber-400'
              }`}
            >
              {isLive ? `Live (${engineStatus?.serverType})` : 'Offline (HTTP 503)'}
            </span>
            <span className="text-slate-400">·</span>
            {onSelectModel ? (
              <select
                aria-label="Select Model"
                value={activeModel.id}
                onChange={(e) => {
                  const m = GGUF_MODEL_PRESETS.find((x) => x.id === e.target.value);
                  if (m) onSelectModel(m);
                }}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1424] px-2 py-1 text-xs font-semibold text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {GGUF_MODEL_PRESETS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({(m.sizeMb / 1024).toFixed(1)} GB · {m.quant})
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-mono-num text-slate-700 dark:text-slate-300">
                {activeModel.name}
              </span>
            )}
            {hasVision && (
              <>
                <span className="text-slate-400">·</span>
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                  <Eye className="w-3.5 h-3.5" />
                  Vision ready
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isLive ? (
              onStopEngine && (
                <button
                  type="button"
                  onClick={onStopEngine}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 dark:border-rose-900/80 bg-rose-50 dark:bg-rose-950/40 text-xs font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/60 transition-colors"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  Stop Engine
                </button>
              )
            ) : (
              onApplyAndReload && (
                <button
                  type="button"
                  onClick={() => onApplyAndReload(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white shadow-xs transition-colors"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Start Engine
                </button>
              )
            )}
            <button
              type="button"
              onClick={onOpenLoadConfig}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Config
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => setMessages([])}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Connect Local Server Row */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-1.5">
            {SERVER_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setServerUrlInput(p.url);
                  testAndConnectServer(p.url);
                }}
                className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-[11px] font-mono-num text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-1 gap-2">
            <input
              type="url"
              aria-label="Local LLM Server URL"
              value={serverUrlInput}
              onChange={(e) => setServerUrlInput(e.target.value)}
              placeholder="http://127.0.0.1:8080"
              className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1424] px-3 py-1.5 text-xs font-mono-num text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              disabled={testingConn}
              onClick={() => testAndConnectServer(serverUrlInput)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium shrink-0"
            >
              {testingConn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
              Test & Connect
            </button>
          </div>
        </div>

        {connFeedback && (
          <p
            className={`text-xs ${
              connFeedback.ok
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-rose-600 dark:text-rose-400'
            }`}
          >
            {connFeedback.text}
          </p>
        )}
      </div>

      {/* Ollama-style Clean Chat Thread */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] flex flex-col min-h-[480px]">
        <div className="flex-1 p-5 space-y-4 overflow-y-auto max-h-[540px]">
          {messages.length === 0 ? (
            <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-2.5">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {isLive ? `Ready on ${activeModel.name}` : 'No live inference engine loaded'}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isLive
                  ? 'Supports SSE streaming with 10s keepalives, image uploads/paste (--mmproj), separated reasoning (<think>), and optional Web Search / URL Fetch tools.'
                  : 'Silica Cluster never returns fake demo replies. Load a local .gguf via Load Config or connect llama-server, Ollama, or LM Studio above to start chatting.'}
              </p>
            </div>
          ) : (
            messages.map((turn) => {
              const showThink = expandedReasoning[turn.id] ?? false;
              return (
                <div
                  key={turn.id}
                  className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-4 py-3 text-sm space-y-2 ${
                      turn.role === 'user'
                        ? 'bg-emerald-600 text-white'
                        : turn.isError
                          ? 'border border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-300'
                          : 'border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1424] text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    {turn.images && turn.images.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {turn.images.map((img, i) => (
                          <img
                            key={`${turn.id}-img-${i}`}
                            src={img.dataUrl}
                            alt={img.name}
                            className="h-24 w-auto rounded-lg border border-white/20 object-cover"
                          />
                        ))}
                      </div>
                    )}

                    {/* Separated Reasoning / Thinking Collapsible */}
                    {turn.reasoning && (
                      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-[#111827] overflow-hidden">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedReasoning((prev) => ({ ...prev, [turn.id]: !showThink }))
                          }
                          className="w-full px-3 py-1.5 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <Brain className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                            Reasoning Trace
                          </span>
                          {showThink ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                        {showThink && (
                          <pre className="px-3 pb-2.5 text-xs font-mono-num text-slate-600 dark:text-slate-400 whitespace-pre-wrap">
                            {turn.reasoning}
                          </pre>
                        )}
                      </div>
                    )}

                    {turn.toolTrace && turn.toolTrace.length > 0 && (
                      <div className="text-[11px] font-mono-num text-emerald-700 dark:text-emerald-400 space-y-0.5">
                        {turn.toolTrace.map((t, i) => (
                          <p key={i}>Tool: {t}</p>
                        ))}
                      </div>
                    )}

                    <div className="whitespace-pre-wrap leading-relaxed flex items-start gap-2">
                      {turn.isError && <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                      <span>{turn.content || (sending ? 'Prefilling prompt...' : '')}</span>
                    </div>

                    {turn.role === 'assistant' && !turn.isError && (turn.ttftMs || turn.tokPerSec) && (
                      <p className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200/70 dark:border-slate-800">
                        {turn.ttftMs ? `TTFT ${turn.ttftMs} ms` : ''}
                        {turn.ttftMs && turn.tokPerSec ? ' · ' : ''}
                        {turn.tokPerSec ? `${turn.tokPerSec} tok/s` : ''}
                      </p>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Composer with Image Upload/Paste & Web Tools Toggle */}
        <form
          onSubmit={sendMessage}
          className="p-3.5 border-t border-slate-200 dark:border-slate-800 space-y-2.5"
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, idx) => (
                <div
                  key={`${att.name}-${idx}`}
                  className="relative rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden"
                >
                  <img src={att.dataUrl} alt={att.name} className="h-14 w-14 object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove ${att.name}`}
                    onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                    className="absolute top-0.5 right-0.5 p-0.5 rounded bg-slate-900/80 text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => e.target.files && readFilesToAttachments(e.target.files)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach image"
              title="Upload image (or paste into box)"
              className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
            >
              <ImagePlus className="w-4 h-4" />
            </button>

            <button
              type="button"
              aria-pressed={webToolsEnabled}
              onClick={() => setWebToolsEnabled((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-2.5 rounded-lg border text-xs font-medium shrink-0 transition-colors ${
                webToolsEnabled
                  ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Globe className="w-4 h-4" />
              <span className="hidden sm:inline">Web Tools</span>
            </button>

            <textarea
              rows={1}
              aria-label="Chat message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Message Silica Cluster (paste an image or press Enter to send)..."
              className="flex-1 resize-none rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1424] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />

            <button
              type="submit"
              disabled={sending}
              aria-label="Send message"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-semibold shrink-0"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
