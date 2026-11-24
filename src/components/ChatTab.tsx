import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownLeft,
  ImagePlus,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { EngineRuntimeStatus, GgufModelPreset, StarClusterPlan } from '../types/starCluster';
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
  ttftMs?: number;
  tokPerSec?: number;
  totalTokens?: number;
  isError?: boolean;
}

interface ChatTabProps {
  activeModel: GgufModelPreset;
  plan: StarClusterPlan;
  engineStatus?: EngineRuntimeStatus;
  upstreamUrl: string;
  onUpstreamConnected?: (url: string) => void;
  onOpenLoadConfig?: () => void;
  onStopEngine?: () => Promise<{ ok: boolean; message: string }>;
}

const STARTER_PROMPTS = [
  'Explain how Cake sharding distributes transformer layers across devices.',
  'Write a Python script to stream tokens from an OpenAI-compatible endpoint.',
  'What is the difference between Dense and Sparse MoE models for edge inference?',
  'Calculate the VRAM bandwidth needed for 30 tok/s at 4-bit quantization.',
];

/**
 * Minimalist Code Block with syntax tag and 1-Click Copy
 */
const CodeBlock: React.FC<{ code: string; language?: string }> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative my-3 rounded-lg overflow-hidden border border-slate-700/80 bg-[#080C14]">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#0D1524] border-b border-slate-700/60 text-[11px] font-mono text-slate-400">
        <span className="uppercase tracking-wider font-semibold text-slate-300">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-slate-400 hover:text-white transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="p-3.5 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed whitespace-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
};

/**
 * Lightweight parser for text and code blocks
 */
function renderFormattedContent(text: string) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const firstLineEnd = part.indexOf('\n');
      const lang = firstLineEnd > 3 ? part.slice(3, firstLineEnd).trim() : '';
      const code = firstLineEnd > 0 ? part.slice(firstLineEnd + 1, -3) : part.slice(3, -3);
      return <CodeBlock key={idx} code={code} language={lang} />;
    }
    return (
      <span key={idx} className="whitespace-pre-wrap leading-relaxed">
        {part}
      </span>
    );
  });
}

export const ChatTab: React.FC<ChatTabProps> = ({
  activeModel,
  plan,
  engineStatus,
  upstreamUrl,
  onOpenLoadConfig,
  onStopEngine,
}) => {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const [liveMetrics, setLiveMetrics] = useState<{
    ttftMs: number;
    tokPerSec: number;
    ramPct: number;
    rttMs: number;
    totalTokens: number;
  }>({
    ttftMs: 0,
    tokPerSec: 0,
    ramPct: 0,
    rttMs: 0.5,
    totalTokens: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isLive = Boolean(engineStatus?.running || upstreamUrl);

  // Compute live cluster RAM usage percentage
  const totalAllocatedMb = plan.nodes.reduce((acc, n) => acc + (n.allocatedMb || 0), 0);
  const totalPoolMb = plan.totalSafePoolMb || 1;
  const currentRamPct = Math.min(100, Math.round((totalAllocatedMb / totalPoolMb) * 100));

  // Avg link RTT across connected workers
  const avgRtt = useMemo(() => {
    const workers = plan.nodes.filter((n) => n.role === 'Worker' && n.isConnected);
    if (workers.length === 0) return 0.5;
    return Number((workers.reduce((a, b) => a + (b.rttMs || 0.8), 0) / workers.length).toFixed(1));
  }, [plan.nodes]);

  useEffect(() => {
    setLiveMetrics((prev) => ({
      ...prev,
      ramPct: currentRamPct,
      rttMs: avgRtt,
    }));
  }, [currentRamPct, avgRtt]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleClearHistory = () => {
    setMessages([]);
    setLiveMetrics({ ttftMs: 0, tokPerSec: 0, ramPct: currentRamPct, rttMs: avgRtt, totalTokens: 0 });
  };

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setSending(false);
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const dataUrl = evt.target?.result as string;
        if (dataUrl) {
          setAttachments((prev) => [...prev, { name: file.name, dataUrl }]);
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  const handleSendMessage = async (textToSend?: string) => {
    const promptText = (textToSend ?? input).trim();
    if (!promptText && attachments.length === 0) return;
    if (sending) return;

    const userTurnId = `u-${Date.now()}`;
    const assistantTurnId = `a-${Date.now() + 1}`;
    const userImages = [...attachments];

    setMessages((prev) => [
      ...prev,
      {
        id: userTurnId,
        role: 'user',
        content: promptText,
        images: userImages.length > 0 ? userImages : undefined,
      },
      {
        id: assistantTurnId,
        role: 'assistant',
        content: '',
      },
    ]);

    setInput('');
    setAttachments([]);
    setSending(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const requestStart = performance.now();
    let firstTokenTime: number | null = null;
    let tokenCount = 0;

    try {
      const payloadMessages = [
        ...messages.map((m) => {
          if (m.images && m.images.length > 0) {
            return {
              role: m.role,
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
        }),
        {
          role: 'user',
          content:
            userImages.length > 0
              ? [
                  { type: 'text', text: promptText },
                  ...userImages.map((img) => ({
                    type: 'image_url',
                    image_url: { url: img.dataUrl },
                  })),
                ]
              : promptText,
        },
      ];

      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel.name || activeModel.id,
          messages: payloadMessages,
          stream: true,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${res.status}: Engine failed`);
      }

      if (!res.body) {
        throw new Error('No streaming response body received from engine');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rawAccumulated = '';
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') break;
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const delta = parsed.choices?.[0]?.delta;
              const chunk = delta?.content || '';
              const reasoningChunk = delta?.reasoning_content || '';

              if (chunk || reasoningChunk) {
                if (firstTokenTime === null) {
                  firstTokenTime = performance.now();
                  const ttft = Math.round(firstTokenTime - requestStart);
                  setLiveMetrics((prev) => ({ ...prev, ttftMs: ttft }));
                }
                tokenCount += 1;
                rawAccumulated += reasoningChunk ? `<think>${reasoningChunk}</think>` : chunk;

                const { reasoning, answer } = splitReasoningContent(rawAccumulated);
                const elapsedSec = (performance.now() - firstTokenTime) / 1000;
                const tokPerSec = elapsedSec > 0 ? Number((tokenCount / elapsedSec).toFixed(1)) : 0;

                setLiveMetrics((prev) => ({
                  ...prev,
                  tokPerSec,
                  totalTokens: tokenCount,
                }));

                setMessages((prev) =>
                  prev.map((turn) =>
                    turn.id === assistantTurnId
                      ? {
                          ...turn,
                          content: answer,
                          reasoning: reasoning || undefined,
                          ttftMs: Math.round((firstTokenTime ?? performance.now()) - requestStart),
                          tokPerSec,
                          totalTokens: tokenCount,
                        }
                      : turn
                  )
                );
              }
            } catch {
              // ignore malformed SSE chunk
            }
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        const errMsg = (err as Error)?.message || 'Generation failed';
        setMessages((prev) =>
          prev.map((turn) =>
            turn.id === assistantTurnId
              ? {
                  ...turn,
                  content: `Error: ${errMsg}`,
                  isError: true,
                }
              : turn
          )
        );
      }
    } finally {
      setSending(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8.5rem)] max-w-5xl mx-auto space-y-3">
      {/* Top Engine Banner */}
      <div className="flex items-center justify-between px-4 py-2.5 rounded-xl border border-slate-800 bg-[#0F172A]/90 backdrop-blur-md shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-200">
              {activeModel.name}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-mono">
              {activeModel.architecture || 'LLM'} · {activeModel.quant || 'Q4_K_M'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          {onOpenLoadConfig && (
            <button
              type="button"
              onClick={onOpenLoadConfig}
              className="px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition-colors inline-flex items-center gap-1.5"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Config</span>
            </button>
          )}
          {engineStatus?.running && onStopEngine && (
            <button
              type="button"
              onClick={onStopEngine}
              className="px-2.5 py-1 rounded-lg border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 transition-colors inline-flex items-center gap-1.5"
            >
              <Square className="w-3 h-3 fill-rose-300" />
              <span>Stop Engine</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleClearHistory}
            title="Clear Chat History"
            className="p-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Chat Thread */}
      <div className="flex-1 rounded-xl border border-slate-800/90 bg-[#0B0F17] flex flex-col overflow-hidden shadow-inner">
        <div className="flex-1 p-4 sm:p-6 space-y-4 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="h-full min-h-[320px] flex flex-col items-center justify-center text-center max-w-lg mx-auto space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-lg">
                <Zap className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-200">
                  {isLive ? `Ready to Infer on ${activeModel.name}` : 'Silica Cluster Engine Offline'}
                </h3>
                <p className="text-xs text-slate-400 max-w-sm">
                  {isLive
                    ? 'Distributed layer streaming with zero-OOM memory caps and persistent flash tensor caching.'
                    : 'Connect or launch the engine to begin high-speed distributed inference.'}
                </p>
              </div>

              {/* Starter Prompt Chips */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 w-full text-left">
                {STARTER_PROMPTS.map((prompt, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleSendMessage(prompt)}
                    className="p-2.5 rounded-lg border border-slate-800 bg-[#0F172A]/70 hover:border-emerald-500/40 hover:bg-[#1E293B] text-xs text-slate-300 transition-all text-left group"
                  >
                    <span className="line-clamp-2">{prompt}</span>
                  </button>
                ))}
              </div>
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
                    className={`max-w-[90%] sm:max-w-[82%] rounded-xl px-4 py-3 text-xs sm:text-sm space-y-2.5 ${
                      turn.role === 'user'
                        ? 'bg-emerald-600 text-white shadow-md'
                        : turn.isError
                          ? 'border border-rose-500/40 bg-rose-500/10 text-rose-300'
                          : 'border border-slate-800 bg-[#111827] text-slate-100 shadow-sm'
                    }`}
                  >
                    {/* User Attached Images */}
                    {turn.images && turn.images.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {turn.images.map((img, i) => (
                          <img
                            key={i}
                            src={img.dataUrl}
                            alt={img.name}
                            className="h-24 w-auto rounded-lg border border-white/20 object-cover"
                          />
                        ))}
                      </div>
                    )}

                    {/* Reasoning Trace Collapsible */}
                    {turn.reasoning && (
                      <div className="rounded-lg border border-slate-800 bg-[#080C14] overflow-hidden">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedReasoning((prev) => ({ ...prev, [turn.id]: !showThink }))
                          }
                          className="w-full px-3 py-1.5 flex items-center justify-between text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <Brain className="w-3.5 h-3.5 text-sky-400" />
                            Reasoning Trace
                          </span>
                          {showThink ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                        {showThink && (
                          <pre className="px-3 pb-2.5 text-[11px] font-mono text-slate-400 whitespace-pre-wrap leading-relaxed border-t border-slate-800">
                            {turn.reasoning}
                          </pre>
                        )}
                      </div>
                    )}

                    {/* Content with Markdown code blocks */}
                    <div className="leading-relaxed">
                      {turn.isError ? (
                        <div className="flex items-center gap-2 text-rose-300">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>{turn.content}</span>
                        </div>
                      ) : (
                        renderFormattedContent(turn.content || (sending ? 'Generating response...' : ''))
                      )}
                    </div>

                    {/* Individual Turn Performance Stamp */}
                    {turn.role === 'assistant' && !turn.isError && (turn.ttftMs || turn.tokPerSec) && (
                      <div className="text-[10px] font-mono text-slate-400 pt-1.5 border-t border-slate-800/80 flex items-center justify-between">
                        <span>TTFT: {turn.ttftMs}ms</span>
                        <span>Speed: {turn.tokPerSec} tok/s</span>
                        {turn.totalTokens && <span>Tokens: {turn.totalTokens}</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div ref={chatBottomRef} />
        </div>

        {/* Real-Time Cake Performance Status Bar */}
        <div className="px-4 py-2 bg-[#090D16] border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-400 overflow-x-auto gap-4">
          <div className="flex items-center gap-4 shrink-0">
            <span className="text-slate-300">
              TTFT: <strong className="text-emerald-400 font-semibold">{liveMetrics.ttftMs > 0 ? `${liveMetrics.ttftMs} ms` : '—'}</strong>
            </span>
            <span className="text-slate-300">
              Speed: <strong className="text-sky-400 font-semibold">{liveMetrics.tokPerSec > 0 ? `${liveMetrics.tokPerSec} tok/s` : '—'}</strong>
            </span>
            <span className="text-slate-300">
              Tokens: <strong className="text-amber-400 font-semibold">{liveMetrics.totalTokens > 0 ? liveMetrics.totalTokens : '—'}</strong>
            </span>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <span className="text-slate-300">
              Cluster RAM: <strong className="text-slate-200 font-semibold">{liveMetrics.ramPct}%</strong>
            </span>
            <span className="text-slate-300">
              Link RTT: <strong className="text-emerald-400 font-semibold">{liveMetrics.rttMs} ms</strong>
            </span>
          </div>
        </div>

        {/* Input Bar */}
        <div className="p-3 bg-[#0D1524] border-t border-slate-800">
          {attachments.length > 0 && (
            <div className="flex items-center gap-2 mb-2 pb-2 border-b border-slate-800 overflow-x-auto">
              {attachments.map((att, idx) => (
                <div key={idx} className="relative group shrink-0">
                  <img
                    src={att.dataUrl}
                    alt={att.name}
                    className="h-14 w-14 rounded-lg object-cover border border-slate-700"
                  />
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                    className="absolute -top-1 -right-1 p-0.5 rounded-full bg-rose-600 text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageSelect}
              accept="image/*"
              multiple
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach Image (--mmproj)"
              className="p-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              <ImagePlus className="w-4 h-4" />
            </button>

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isLive ? 'Type a message (Enter to send)...' : 'Engine offline — load model to chat'}
              disabled={!isLive && !upstreamUrl}
              className="flex-1 bg-[#080C14] border border-slate-700/80 rounded-lg px-3.5 py-2 text-xs sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors disabled:opacity-50"
            />

            {sending ? (
              <button
                type="button"
                onClick={handleStopGeneration}
                className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
              >
                <Square className="w-3.5 h-3.5 fill-white" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={(!input.trim() && attachments.length === 0) || (!isLive && !upstreamUrl)}
                className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
                <span>Send</span>
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};
