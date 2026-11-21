import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { parseLocalGgufModel } from '../data/localModelsScanner';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Layers,
  Plus,
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
  localModels?: GgufModelPreset[];
  onRefreshLocalModels?: (dir?: string) => Promise<void>;
  onAddLocalModelPath?: (filePath: string) => Promise<GgufModelPreset | null>;
}

type ModelHubTab = 'local' | 'hf';
type CatalogFilter = 'all' | 'fits' | 'moe' | 'coding' | 'ternary';
type SortMode = 'fit' | 'downloads';

export const ModelsHubPage: React.FC<ModelsHubPageProps> = ({
  clusterPlan,
  activeModel,
  onSelectModel,
  onOpenChat,
  localModels = [],
  onRefreshLocalModels,
  onAddLocalModelPath,
}) => {
  // Navigation & Sub-views
  const [hubTab, setHubTab] = useState<ModelHubTab>(() => (localModels.length > 0 ? 'local' : 'local'));

  // Local Models Directory Scan & File Picker State
  const [scanDirInput, setScanDirInput] = useState('');
  const [manualPathInput, setManualPathInput] = useState('');
  const [isScanningLocal, setIsScanningLocal] = useState(false);
  const [localScanMessage, setLocalScanMessage] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Hugging Face Catalog State
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

  const handleScanDirectory = async (dirToScan?: string) => {
    if (!onRefreshLocalModels) return;
    setIsScanningLocal(true);
    setLocalScanMessage(null);
    try {
      await onRefreshLocalModels(dirToScan || scanDirInput.trim() || undefined);
      setLocalScanMessage(`Scanned successfully.`);
    } catch (err) {
      setLocalScanMessage(err instanceof Error ? err.message : 'Directory scan failed');
    } finally {
      setIsScanningLocal(false);
    }
  };

  const handleAddManualPath = async () => {
    const trimmed = manualPathInput.trim();
    if (!trimmed) return;
    setIsScanningLocal(true);
    setLocalScanMessage(null);
    try {
      if (onAddLocalModelPath) {
        const added = await onAddLocalModelPath(trimmed);
        if (added) {
          onSelectModel(added);
          setLocalScanMessage(`Loaded "${added.name}" into cluster.`);
          setManualPathInput('');
        }
      } else {
        const res = await fetch('/api/local/models/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: trimmed }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.model) {
            onSelectModel(data.model);
            setLocalScanMessage(`Loaded "${data.model.name}" into cluster.`);
            setManualPathInput('');
            if (onRefreshLocalModels) void onRefreshLocalModels();
          }
        } else {
          const err = await res.json();
          setLocalScanMessage(err.error || 'Failed to add model path');
        }
      }
    } catch (err) {
      setLocalScanMessage(err instanceof Error ? err.message : 'Error adding model');
    } finally {
      setIsScanningLocal(false);
    }
  };

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // In modern browsers, file.name and file.size are provided
    // Construct local model preset
    const preset = parseLocalGgufModel(file.name, file.size);
    onSelectModel(preset);
    setLocalScanMessage(`Loaded local file: ${file.name} (${(file.size / (1024 * 1024 * 1024)).toFixed(2)} GB)`);
    // Clear the input value so the same file can be re-selected if desired
    e.target.value = '';
  };

  const handleCopyPath = (path: string) => {
    void navigator.clipboard?.writeText(path);
    setCopiedPath(path);
    window.setTimeout(() => setCopiedPath(null), 1500);
  };

  // Evaluated Hugging Face Models
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
          return (
            model.tags.some((t) => /code|coding|hermes|opencode|tool/i.test(t)) ||
            /coder|code/i.test(model.name)
          );
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

  return (
    <div className="space-y-6 pb-8">
      {/* 1. Main Hub Header & Top Navigation Tabs */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-700 dark:text-slate-300">ClusterLab Model Hub</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num">{activeNodeCount} active node(s)</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num">
                {(clusterPlan.totalSafePoolMb / 1024).toFixed(1)} GB safe RAM/VRAM pool
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num text-emerald-600 dark:text-emerald-400 font-semibold">
                Active: {activeModel.name} ({activeModel.quant})
              </span>
            </div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
              Load & Shard Models Across Your Nodes
            </h1>
          </div>

          {/* Top Tabs: Local Directory vs Hugging Face */}
          <div className="flex items-center gap-2 self-start lg:self-auto">
            <div
              role="tablist"
              aria-label="Model Catalog Source"
              className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800"
            >
              <button
                type="button"
                role="tab"
                aria-selected={hubTab === 'local'}
                onClick={() => setHubTab('local')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors flex items-center gap-1.5 ${
                  hubTab === 'local'
                    ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Folder className="w-3.5 h-3.5 text-amber-500" />
                <span>Local Directory & GGUF ({localModels.length})</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={hubTab === 'hf'}
                onClick={() => setHubTab('hf')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors flex items-center gap-1.5 ${
                  hubTab === 'hf'
                    ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                <span>Hugging Face Catalog</span>
              </button>
            </div>
          </div>
        </div>

        {/* TAB 1: LOCAL DIRECTORY & GGUF MODELS */}
        {hubTab === 'local' && (
          <div className="space-y-4 pt-2 border-t border-slate-200 dark:border-slate-800/80">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  Scan local folders, pick `.gguf` weights directly from disk, or paste an absolute file path.
                  No internet download required.
                </p>
              </div>

              {/* Hidden file picker input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".gguf"
                className="hidden"
                onChange={handleFilePicked}
              />

              <div className="flex items-center gap-2 self-start md:self-auto shrink-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] hover:border-blue-500 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-blue-500" />
                  <span>Browse .gguf File</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleScanDirectory()}
                  disabled={isScanningLocal}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isScanningLocal ? 'animate-spin' : ''}`} />
                  <span>{isScanningLocal ? 'Scanning...' : 'Rescan Folders'}</span>
                </button>
              </div>
            </div>

            {/* Folder Scanner & Path Inputs */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-1">
              <div className="lg:col-span-6 flex gap-2">
                <div className="relative flex-1">
                  <Folder className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={scanDirInput}
                    onChange={(e) => setScanDirInput(e.target.value)}
                    placeholder="Custom folder to scan (e.g. C:\AI\models or ~/models)..."
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500 font-mono-num"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleScanDirectory(scanDirInput.trim())}
                  disabled={isScanningLocal || !scanDirInput.trim()}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 disabled:opacity-50 whitespace-nowrap"
                >
                  Scan Dir
                </button>
              </div>

              <div className="lg:col-span-6 flex gap-2">
                <div className="relative flex-1">
                  <FileText className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={manualPathInput}
                    onChange={(e) => setManualPathInput(e.target.value)}
                    placeholder="Direct .gguf file path (e.g. C:\Downloads\model.gguf)..."
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500 font-mono-num"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAddManualPath}
                  disabled={isScanningLocal || !manualPathInput.trim()}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-3 py-2 text-xs font-semibold whitespace-nowrap flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add File</span>
                </button>
              </div>
            </div>

            {/* Quick folder chips */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">Quick Scan Locations:</span>
              {[
                { label: 'Downloads Folder', path: '' },
                { label: './models', path: './models' },
                { label: 'LM Studio Cache', path: `${process.env.USERPROFILE || 'C:\\Users\\alojy'}\\.cache\\lm-studio\\models` },
              ].map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={() => {
                    setScanDirInput(chip.path);
                    void handleScanDirectory(chip.path);
                  }}
                  className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#0B1120] px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:border-blue-500 transition-colors"
                >
                  {chip.label}
                </button>
              ))}
            </div>

            {localScanMessage && (
              <div className="text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1.5 bg-slate-50 dark:bg-[#0B1120] p-2 rounded-lg border border-slate-200 dark:border-slate-800">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>{localScanMessage}</span>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: HUGGING FACE SEARCH CONTROLS */}
        {hubTab === 'hf' && (
          <div className="space-y-4 pt-2 border-t border-slate-200 dark:border-slate-800/80">
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

                <a
                  href="https://huggingface.co/models?library=gguf&sort=downloads"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 whitespace-nowrap shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Hugging Face Hub</span>
                </a>
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
          </div>
        )}
      </section>

      {/* 2. TAB CONTENT: LOCAL MODELS GRID */}
      {hubTab === 'local' && (
        <section className="space-y-4">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>
              Showing {localModels.length} local `.gguf` file(s) available on this machine
            </span>
            <span>Real safe RAM/VRAM capacity: {(clusterPlan.totalSafePoolMb / 1024).toFixed(1)} GB</span>
          </div>

          {localModels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] p-10 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto text-slate-400">
                <FolderOpen className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="font-display text-base font-bold text-slate-800 dark:text-slate-200">
                  No local .gguf models discovered yet
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                  Click below to browse your hard drive for any downloaded `.gguf` file, or enter a folder path to scan.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-xs font-semibold flex items-center gap-2"
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>Browse .gguf File from Disk</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleScanDirectory('')}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31] px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500"
                >
                  Scan Downloads Folder
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {localModels.map((model) => {
                const isSelected =
                  activeModel.id === model.id ||
                  (model.localPath && activeModel.localPath === model.localPath);
                const sizeGb = (model.sizeMb / 1024).toFixed(1);
                const poolGb = (clusterPlan.totalSafePoolMb / 1024).toFixed(1);
                const canFit = model.sizeMb <= clusterPlan.totalSafePoolMb;
                const coveragePct = Math.min(100, Math.round((model.sizeMb / clusterPlan.totalSafePoolMb) * 100));

                return (
                  <article
                    key={model.id}
                    className={`rounded-xl border p-5 flex flex-col justify-between gap-4 bg-white dark:bg-[#131C31] transition-colors ${
                      isSelected
                        ? 'border-emerald-500 ring-1 ring-emerald-500/30'
                        : 'border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <div className="space-y-3">
                      {/* Top status */}
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 truncate">
                          <span className="font-semibold text-amber-600 dark:text-amber-400">Disk Weight</span>
                          <span aria-hidden="true"> · </span>
                          <span>{model.architecture}</span>
                          <span aria-hidden="true"> · </span>
                          <span className="font-mono-num font-semibold text-slate-700 dark:text-slate-300">
                            {model.quant}
                          </span>
                        </div>
                        <span
                          className={`font-semibold whitespace-nowrap shrink-0 ${
                            canFit
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {canFit ? 'Fits Cleanly' : 'High Memory'}
                        </span>
                      </div>

                      {/* Model Title */}
                      <div>
                        <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 leading-snug">
                          {model.name}
                        </h2>
                        {model.localPath && (
                          <div className="mt-1 flex items-center justify-between gap-1 rounded bg-slate-50 dark:bg-[#0B1120] p-1.5 border border-slate-200 dark:border-slate-800 text-[11px] font-mono-num text-slate-600 dark:text-slate-400">
                            <span className="truncate" title={model.localPath}>
                              {model.localPath}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleCopyPath(model.localPath || '')}
                              title="Copy local path"
                              className="text-slate-400 hover:text-blue-500 p-0.5"
                            >
                              {copiedPath === model.localPath ? (
                                <Check className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Specs Row */}
                      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                        <div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            <Sparkles className="w-3 h-3" /> Active Params
                          </div>
                          <div className="font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                            {model.activeParamsB}B / {model.totalParamsB}B
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            <HardDrive className="w-3 h-3" /> Disk Size
                          </div>
                          <div className="font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                            {sizeGb} GB
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            <Layers className="w-3 h-3" /> Layers
                          </div>
                          <div className="font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                            {model.layers}L
                          </div>
                        </div>
                      </div>

                      {/* Cluster Pool Bar */}
                      <div className="space-y-1.5 pt-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
                          <span>Pool Coverage: {coveragePct}%</span>
                          <span>
                            {sizeGb} GB / {poolGb} GB Safe Pool
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              canFit ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}
                            style={{ width: `${coveragePct}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Card Actions */}
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
                        {isSelected ? 'Currently Sharded' : 'Ready to Load'}
                      </span>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectModel(model)}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                            isSelected
                              ? 'bg-emerald-600 text-white'
                              : 'bg-blue-600 hover:bg-blue-500 text-white'
                          }`}
                        >
                          <Cpu className="w-3.5 h-3.5" />
                          <span>{isSelected ? 'Loaded in Cluster ✓' : 'Load into Cluster'}</span>
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
            </div>
          )}
        </section>
      )}

      {/* 3. TAB CONTENT: HUGGING FACE CATALOG GRID */}
      {hubTab === 'hf' && (
        <>
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
        </>
      )}

      {/* Quiet Footer Note */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" />
          Models are evaluated against your active Safe RAM + VRAM pool ({(clusterPlan.totalSafePoolMb / 1024).toFixed(1)} GB).
        </span>
        <span className="font-mono-num truncate max-w-xs">{activeModel.name} · {activeModel.hfRepo}</span>
      </div>
    </div>
  );
};
