import React, { useEffect, useMemo, useState } from 'react';
import {
  CURATED_HF_GGUF_CATALOG,
  catalogModelToPreset,
  evaluateModelAgainstCluster,
} from '../data/hfModelsCatalog';
import {
  GgufModelPreset,
  HfCatalogModel,
  StarClusterPlan,
} from '../types/starCluster';
import {
  ArrowRight,
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  Layers,
  RefreshCw,
  Search,
  Sparkles,
  Zap,
} from 'lucide-react';

interface ModelsHubPageProps {
  clusterPlan: StarClusterPlan;
  activeModel: GgufModelPreset;
  onSelectModel: (preset: GgufModelPreset) => void;
  onOpenChat: () => void;
}

type CatalogFilter = 'all' | 'fits' | 'moe' | 'coding' | 'ternary';
type SortMode = 'fit' | 'downloads';

export const ModelsHubPage: React.FC<ModelsHubPageProps> = ({
  clusterPlan,
  activeModel,
  onSelectModel,
  onOpenChat,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('fit');
  const [models, setModels] = useState<HfCatalogModel[]>(CURATED_HF_GGUF_CATALOG);
  const [selectedQuants, setSelectedQuants] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [syncSource, setSyncSource] = useState<'curated' | 'huggingface' | 'curated-fallback'>('curated');
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const fetchHuggingFaceModels = async (query: string) => {
    setIsLoading(true);
    setSyncMessage(null);
    try {
      const res = await fetch(`/api/hf/models?q=${encodeURIComponent(query)}&limit=18`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        source: 'huggingface' | 'curated-fallback';
        warning?: string;
        models: HfCatalogModel[];
      };

      const incoming = Array.isArray(data.models) ? data.models : [];
      if (query.trim()) {
        setModels(incoming.length > 0 ? incoming : CURATED_HF_GGUF_CATALOG);
      } else {
        // Merge curated verified specs first, then unique live Hugging Face repos
        const seen = new Set(CURATED_HF_GGUF_CATALOG.map((m) => m.hfRepo.toLowerCase()));
        const extras = incoming.filter((m) => !seen.has(m.hfRepo.toLowerCase()));
        setModels([...CURATED_HF_GGUF_CATALOG, ...extras]);
      }

      setSyncSource(data.source);
      if (data.warning) {
        setSyncMessage(`Using offline GGUF catalog (${data.warning})`);
      } else if (data.source === 'huggingface') {
        setSyncMessage(`Synced ${incoming.length} GGUF repos from Hugging Face Hub`);
      }
    } catch {
      setSyncSource('curated-fallback');
      setModels(CURATED_HF_GGUF_CATALOG);
      setSyncMessage('Hugging Face unreachable — showing verified offline GGUF catalog.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchHuggingFaceModels('');
  }, []);

  const evaluatedList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const rows = models
      .map((model) => {
        const chosenQuant = selectedQuants[model.id] ?? model.defaultQuant;
        const variant =
          model.quantOptions.find((v) => v.quant === chosenQuant) ??
          model.quantOptions[0] ?? {
            quant: model.defaultQuant,
            sizeMb: model.sizeMb,
            bpw: 4.8,
          };
        const fit = evaluateModelAgainstCluster(model, variant.sizeMb, clusterPlan);
        return { model, variant, fit };
      })
      .filter(({ model, fit }) => {
        if (q) {
          const hay = `${model.name} ${model.hfRepo} ${model.architecture} ${model.tags.join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (filter === 'fits') return fit.canLoadCleanly;
        if (filter === 'moe') return model.architecture === 'MoE';
        if (filter === 'ternary') return model.architecture === 'Ternary';
        if (filter === 'coding') {
          return model.tags.some((t) => /code|coding|hermes|opencode|tool/i.test(t)) ||
            /coder|code/i.test(model.name);
        }
        return true;
      });

    rows.sort((a, b) => {
      if (sortMode === 'downloads') {
        return b.model.downloads - a.model.downloads;
      }
      const rank = { Fast: 3, 'Best Fit': 2, Streaming: 1, 'Too Large': 0 };
      const diff = rank[b.fit.fitStatus] - rank[a.fit.fitStatus];
      if (diff !== 0) return diff;
      return b.fit.estimatedTokPerSec - a.fit.estimatedTokPerSec;
    });

    return rows;
  }, [models, selectedQuants, clusterPlan, searchQuery, filter, sortMode]);

  const activeNodeCount = clusterPlan.nodes.filter((n) => n.effectiveCapMb > 0).length;
  const supportedCount = evaluatedList.filter((r) => r.fit.canLoadCleanly).length;

  return (
    <div className="space-y-6 pb-8">
      {/* 1. Resource-Aware Header & Hugging Face Search */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>Hugging Face GGUF Catalog</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num">{activeNodeCount} active node(s)</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num">
                {(clusterPlan.totalSafePoolMb / 1024).toFixed(1)} GB safe RAM/VRAM pool
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num">
                {supportedCount} fit cleanly now
              </span>
            </div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
              Supported Models for Your Compute Nodes
            </h1>
          </div>

          <a
            href="https://huggingface.co/models?library=gguf&sort=downloads"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 whitespace-nowrap shrink-0 self-start lg:self-auto"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Browse Hugging Face GGUF</span>
          </a>
        </div>

        {/* Search & Filter Controls */}
        <div className="flex flex-col lg:flex-row gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void fetchHuggingFaceModels(searchQuery);
            }}
            className="flex-1 flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search Hugging Face GGUF (e.g. Qwen3, Llama-3.3, DeepSeek, BitNet, Coder)..."
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white px-4 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>{isLoading ? 'Syncing...' : 'Search HF'}</span>
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800">
              {(
                [
                  ['all', 'All'],
                  ['fits', 'Fits Cluster'],
                  ['moe', 'MoE'],
                  ['coding', 'Coding'],
                  ['ternary', 'Ternary'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                    filter === key
                      ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              aria-label="Sort models"
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              <option value="fit">Sort: Cluster Fit & Speed</option>
              <option value="downloads">Sort: HF Downloads</option>
            </select>
          </div>
        </div>

        {syncMessage && (
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2">
            <span>{syncMessage}</span>
            <span className="font-mono-num">
              Source: {syncSource === 'huggingface' ? 'huggingface.co/api' : 'Local Verified Catalog'}
            </span>
          </div>
        )}
      </section>

      {/* 2. Model Cards Grid */}
      {isLoading && evaluatedList.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="h-56 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] animate-pulse p-5"
            />
          ))}
        </div>
      ) : evaluatedList.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-8 text-center space-y-3">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            No models matched &ldquo;{searchQuery}&rdquo; under the selected filter.
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              setFilter('all');
              void fetchHuggingFaceModels('');
            }}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-xs font-semibold"
          >
            Reset Filters & Show All GGUF Models
          </button>
        </div>
      ) : (
        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {evaluatedList.map(({ model, variant, fit }) => {
            const isSelected =
              activeModel.hfRepo.toLowerCase() === model.hfRepo.toLowerCase() ||
              activeModel.id === model.id;

            const fitColor =
              fit.fitStatus === 'Fast'
                ? 'text-emerald-600 dark:text-emerald-400'
                : fit.fitStatus === 'Best Fit'
                  ? 'text-blue-600 dark:text-blue-400'
                  : fit.fitStatus === 'Streaming'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-red-600 dark:text-red-400';

            return (
              <article
                key={model.id}
                className={`rounded-xl border p-5 flex flex-col justify-between gap-4 bg-white dark:bg-[#131C31] transition-colors ${
                  isSelected
                    ? 'border-blue-500 ring-1 ring-blue-500/30'
                    : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                <div className="space-y-3">
                  {/* Card Top Metadata Line (Zero-Pill Discipline) */}
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="text-slate-500 dark:text-slate-400 truncate">
                      <span>{model.author}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{model.architecture}</span>
                      {model.downloads > 0 && (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span className="font-mono-num">
                            {model.downloads >= 1000
                              ? `${Math.round(model.downloads / 1000)}k dl`
                              : `${model.downloads} dl`}
                          </span>
                        </>
                      )}
                    </div>
                    <span className={`font-semibold whitespace-nowrap shrink-0 ${fitColor}`}>
                      {fit.fitStatus}
                    </span>
                  </div>

                  {/* Title + HF External Link */}
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 leading-snug">
                      {model.name}
                    </h2>
                    <a
                      href={model.hfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${model.hfRepo} on Hugging Face`}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>

                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    {model.summary}
                  </p>

                  {/* Resource Metrics Row */}
                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                    <div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" /> Active / Total
                      </div>
                      <div className="font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                        {model.activeParamsB}B / {model.totalParamsB}B
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <HardDrive className="w-3 h-3" /> Size / Pool
                      </div>
                      <div className="font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                        {(variant.sizeMb / 1024).toFixed(1)} GB
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <Zap className="w-3 h-3" /> Est. Speed
                      </div>
                      <div className="font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                        ~{fit.estimatedTokPerSec} tok/s
                      </div>
                    </div>
                  </div>

                  {/* Resource Fit Bar + Quant Picker */}
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
                      <span className="flex items-center gap-1">
                        <Layers className="w-3 h-3" />
                        {model.layers}L · Pool coverage {fit.coveragePct}%
                      </span>
                      <span>
                        {fit.headroomMb >= 0
                          ? `+${(fit.headroomMb / 1024).toFixed(1)} GB free`
                          : `${Math.abs(fit.headroomMb / 1024).toFixed(1)} GB over cap`}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          fit.fitStatus === 'Fast'
                            ? 'bg-emerald-500'
                            : fit.fitStatus === 'Best Fit'
                              ? 'bg-blue-500'
                              : fit.fitStatus === 'Streaming'
                                ? 'bg-amber-500'
                                : 'bg-red-500'
                        }`}
                        style={{ width: `${fit.coveragePct}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Card Footer: Quantization + Actions */}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <select
                    value={variant.quant}
                    onChange={(e) =>
                      setSelectedQuants((prev) => ({
                        ...prev,
                        [model.id]: e.target.value,
                      }))
                    }
                    aria-label={`Quantization for ${model.name}`}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono-num font-semibold text-slate-800 dark:text-slate-200"
                  >
                    {model.quantOptions.map((opt) => (
                      <option key={opt.quant} value={opt.quant}>
                        {opt.quant} ({(opt.sizeMb / 1024).toFixed(1)} GB)
                      </option>
                    ))}
                  </select>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectModel(catalogModelToPreset(model, variant.quant));
                      }}
                      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                        isSelected
                          ? 'bg-emerald-600 text-white'
                          : 'bg-blue-600 hover:bg-blue-500 text-white'
                      }`}
                    >
                      <Cpu className="w-3.5 h-3.5" />
                      <span>{isSelected ? 'Loaded in Cluster' : 'Load & Tune'}</span>
                    </button>

                    {isSelected && (
                      <button
                        type="button"
                        onClick={onOpenChat}
                        title="Open Chat & Brain Window"
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 whitespace-nowrap shrink-0"
                      >
                        <span>Chat</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* Quiet Footer Note */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" />
          Models are auto-ranked against your active Safe RAM + VRAM pool ({(clusterPlan.totalSafePoolMb / 1024).toFixed(1)} GB).
        </span>
        <span className="font-mono-num">{activeModel.hfRepo}</span>
      </div>
    </div>
  );
};
