import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Boxes,
  MessageSquare,
  Moon,
  Network,
  PlugZap,
  Settings,
  Sun,
} from 'lucide-react';
import {
  BackendTuningConfig,
  ClusterMode,
  EngineRuntimeStatus,
  GGUF_MODEL_PRESETS,
  GgufModelPreset,
  LearnedEmaProfile,
  LiveHardwareProbe,
  RuntimeClusterSnapshot,
} from './types/starCluster';
import { createInitialTelemetryState } from './service/nodeClusterService';
import { buildStarClusterNodes, planStarCluster, isSameAndroidWorker } from './domain/starClusterPlanner';
import { createDefaultBackendTuningConfig } from './domain/backendTuner';
import { StarClusterDashboard } from './components/StarClusterDashboard';
import { ModelsHubPage } from './components/ModelsHubPage';
import { ChatAndBrainPage } from './components/ChatAndBrainPage';
import { ApiHarnessConnectPage } from './components/ApiHarnessConnectPage';
import { FloatingResourceHud } from './components/FloatingResourceHud';
import { ModelLoadConfigDrawer } from './components/ModelLoadConfigDrawer';
import { SettingsMenuDialog } from './components/SettingsMenuDialog';
import { JoinWorkerPage } from './components/JoinWorkerPage';

type NavTab = 'cluster' | 'models' | 'chat' | 'connect';

const THEME_STORAGE_KEY = 'silica.theme.v1';
const ONBOARDING_STORAGE_KEY = 'silica.onboarding.dismissed.v1';

function readInitialDarkTheme(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light') return false;
    if (saved === 'dark') return true;
  } catch {
    // ignore
  }
  return true;
}

function readInitialShowOnboarding(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') return false;
    return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

export function App() {
  const [pathname, setPathname] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );
  const [activeTab, setActiveTab] = useState<NavTab>('cluster');
  const [isDarkTheme, setIsDarkTheme] = useState<boolean>(readInitialDarkTheme);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(readInitialShowOnboarding);
  const [hudOpen, setHudOpen] = useState<boolean>(false);
  const [loadConfigOpen, setLoadConfigOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  useEffect(() => {
    const onPopState = () => {
      setPathname(window.location.pathname);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const [activeModel, setActiveModel] = useState<GgufModelPreset>(GGUF_MODEL_PRESETS[0]);
  const [availableModels, setAvailableModels] = useState<GgufModelPreset[]>(GGUF_MODEL_PRESETS);
  const [clusterMode, setClusterMode] = useState<ClusterMode>('LIVE_CLUSTER');
  const [tuningConfig, setTuningConfig] = useState<BackendTuningConfig>(() =>
    createDefaultBackendTuningConfig(GGUF_MODEL_PRESETS[0])
  );
  const [liveHardware, setLiveHardware] = useState<LiveHardwareProbe | undefined>(undefined);
  const [engineStatus, setEngineStatus] = useState<EngineRuntimeStatus>({
    running: false,
    draining: false,
    activeTurns: 0,
    upstreamUrl: null,
    serverType: 'offline',
    hasMmproj: Boolean(GGUF_MODEL_PRESETS[0].mmprojPath),
    mmprojPath: GGUF_MODEL_PRESETS[0].mmprojPath ?? null,
    lastEvent: 'Engine offline — load a GGUF model or connect a local server',
    reloadProgressPct: 0,
  });
  const [upstreamUrl, setUpstreamUrl] = useState<string>('');
  const [learnedProfile, setLearnedProfile] = useState<LearnedEmaProfile | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDarkTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, isDarkTheme ? 'dark' : 'light');
    } catch {
      // ignore
    }
  }, [isDarkTheme]);

  const applyServerSnapshot = useCallback((snap: RuntimeClusterSnapshot) => {
    if (snap.activeModel) setActiveModel(snap.activeModel);
    if (snap.clusterMode) setClusterMode(snap.clusterMode);
    if (snap.tuningConfig) setTuningConfig(snap.tuningConfig);
    if (snap.engineStatus) setEngineStatus(snap.engineStatus);
    if (typeof snap.upstreamBaseUrl === 'string') setUpstreamUrl(snap.upstreamBaseUrl);
    setLearnedProfile(snap.learnedProfile ?? null);
  }, []);

  const refreshHardware = useCallback(async () => {
    try {
      const res = await fetch('/api/cluster/hardware');
      if (res.ok) {
        const hw = (await res.json()) as LiveHardwareProbe;
        setLiveHardware(hw);
      }
    } catch {
      // ignore transient network errors
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const [stateRes, hwRes, modelsRes] = await Promise.all([
        fetch('/api/cluster/state'),
        fetch('/api/cluster/hardware'),
        fetch('/api/models').catch(() => null),
      ]);
      if (stateRes.ok) {
        const snap = (await stateRes.json()) as RuntimeClusterSnapshot;
        applyServerSnapshot(snap);
      }
      if (hwRes.ok) {
        const hw = (await hwRes.json()) as LiveHardwareProbe;
        setLiveHardware(hw);
      }
      if (modelsRes && modelsRes.ok) {
        const mData = (await modelsRes.json()) as { models?: GgufModelPreset[] };
        if (mData.models && mData.models.length > 0) {
          setAvailableModels(mData.models);
        }
      }
    } catch {
      // ignore initial offline probe error
    }
  }, [applyServerSnapshot]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (activeTab !== 'cluster' && !hudOpen) return;
    const timer = window.setInterval(() => {
      refreshHardware();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [activeTab, hudOpen, refreshHardware]);

  const plan = useMemo(() => {
    const telemetry = createInitialTelemetryState(false);
    const nodes = buildStarClusterNodes(telemetry, clusterMode, 0, tuningConfig, liveHardware);
    return planStarCluster(nodes, activeModel, undefined, tuningConfig, learnedProfile);
  }, [clusterMode, tuningConfig, liveHardware, activeModel, learnedProfile]);

  const handleDismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    } catch {
      // ignore
    }
  }, []);

  const handleReopenOnboarding = useCallback(() => {
    setShowOnboarding(true);
    setActiveTab('cluster');
    try {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const handleApplyAndReload = useCallback(
    async (spawnLocalBinary: boolean): Promise<{ ok: boolean; message: string }> => {
      try {
        const res = await fetch('/api/engine/reload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: activeModel,
            tuningConfig,
            spawnLocalBinary,
            binaryPath: tuningConfig.binaryPath?.trim() || undefined,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          message?: string;
          snapshot?: RuntimeClusterSnapshot;
        };
        if (data.snapshot) {
          applyServerSnapshot(data.snapshot);
        }
        if (!res.ok || data.ok === false) {
          return { ok: false, message: data.error || 'Model reload failed.' };
        }
        return {
          ok: true,
          message: data.message || 'Model configuration applied and validated.',
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : 'Unable to reach coordinator.',
        };
      }
    },
    [activeModel, tuningConfig, applyServerSnapshot]
  );

  const handleStopEngine = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const res = await fetch('/api/engine/stop', { method: 'POST' });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        snapshot?: RuntimeClusterSnapshot;
      };
      if (data.snapshot) {
        applyServerSnapshot(data.snapshot);
      }
      return { ok: true, message: data.message || 'Engine stopped cleanly.' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Unable to reach coordinator to stop engine.',
      };
    }
  }, [applyServerSnapshot]);

  const handleSelectModel = useCallback(
    async (model: GgufModelPreset) => {
      setActiveModel(model);
      const nextCfg: BackendTuningConfig = {
        ...createDefaultBackendTuningConfig(model),
        mmprojPath: model.mmprojPath ?? '',
      };
      setTuningConfig(nextCfg);
      try {
        const res = await fetch('/api/models/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, reloadIfRunning: engineStatus?.running }),
        });
        if (res.ok) {
          const data = (await res.json()) as { snapshot?: RuntimeClusterSnapshot };
          if (data.snapshot) applyServerSnapshot(data.snapshot);
        }
        if (engineStatus?.running) {
          await handleApplyAndReload(true);
        }
      } catch {
        // keep optimistic local state
      }
    },
    [applyServerSnapshot, engineStatus?.running, handleApplyAndReload]
  );

  const handleChangeClusterMode = useCallback(
    async (mode: ClusterMode) => {
      setClusterMode(mode);
      try {
        const res = await fetch('/api/cluster/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clusterMode: mode }),
        });
        if (res.ok) {
          const snap = (await res.json()) as RuntimeClusterSnapshot;
          applyServerSnapshot(snap);
        }
      } catch {
        // keep optimistic local state
      }
    },
    [applyServerSnapshot]
  );

  const handleUpdateConfig = useCallback((patch: Partial<BackendTuningConfig>) => {
    setTuningConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleResetDefaults = useCallback(() => {
    setTuningConfig({
      ...createDefaultBackendTuningConfig(activeModel),
      mmprojPath: activeModel.mmprojPath ?? '',
    });
  }, [activeModel]);

  const handleUpstreamConnected = useCallback(
    async (url: string) => {
      setUpstreamUrl(url);
      await refreshState();
    },
    [refreshState]
  );

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode }> = [
    { id: 'cluster', label: 'Cluster', icon: <Network className="w-4 h-4" /> },
    { id: 'models', label: 'Models', icon: <Boxes className="w-4 h-4" /> },
    { id: 'chat', label: 'Chat', icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'connect', label: 'Connect', icon: <PlugZap className="w-4 h-4" /> },
  ];

  const uniqueLiveWorkers = useMemo(() => {
    const raw = plan.nodes.filter(
      (n) => n.role === 'Worker' && n.isConnected && (n.allocatedLayers ?? 0) > 0
    );
    const deduped: typeof raw = [];
    for (const w of raw) {
      if (!deduped.some((ex) => isSameAndroidWorker(ex, w) || (ex.ip === w.ip && ex.rpcPort === w.rpcPort))) {
        deduped.push(w);
      }
    }
    return deduped;
  }, [plan.nodes]);
  const liveWorkerCount = uniqueLiveWorkers.length;

  if (pathname === '/join' || pathname.startsWith('/join/')) {
    return (
      <JoinWorkerPage
        onBackToDashboard={() => {
          window.history.pushState({}, '', '/');
          setPathname('/');
          refreshHardware();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 transition-colors flex flex-col">
      {/* Strict 3-Zone Header Bar */}
      <header className="sticky top-0 z-30 h-14 border-b border-slate-200 dark:border-slate-800/90 bg-white/90 dark:bg-[#0B0F17]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-4">
          {/* Zone 1: Brand */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-600 dark:bg-emerald-500 flex items-center justify-center text-white font-semibold text-sm shadow-sm">
              SC
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
                Silica Cluster
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-num whitespace-nowrap">
                {engineStatus.running ? 'Engine Online' : 'Engine Offline'} · {liveWorkerCount}{' '}
                {liveWorkerCount === 1 ? 'worker' : 'workers'}
              </div>
            </div>
          </div>

          {/* Zone 2: Primary 4-Tab Navigation (No 2D Lab) */}
          <nav
            aria-label="Primary navigation"
            className="flex items-center gap-1 bg-slate-100 dark:bg-[#111827] p-1 rounded-lg border border-slate-200 dark:border-slate-800"
          >
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    active
                      ? 'bg-white dark:bg-[#1E293B] text-slate-950 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Compact Utilities */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setHudOpen((v) => !v)}
              aria-pressed={hudOpen}
              title="Toggle Floating Resource Monitor HUD"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
                hudOpen
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">HUD</span>
            </button>

            <button
              type="button"
              onClick={() => setIsDarkTheme((v) => !v)}
              aria-label={isDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors shrink-0"
            >
              {isDarkTheme ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
            </button>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open Silica Cluster settings"
              title="Settings"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors shrink-0"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Workspace Canvas */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'cluster' && (
          <StarClusterDashboard
            activeModel={activeModel}
            availableModels={availableModels}
            onSelectModel={handleSelectModel}
            clusterMode={clusterMode}
            onChangeClusterMode={handleChangeClusterMode}
            tuningConfig={tuningConfig}
            plan={plan}
            liveHardware={liveHardware}
            engineStatus={engineStatus}
            showOnboarding={showOnboarding}
            onDismissOnboarding={handleDismissOnboarding}
            onRescanDevices={refreshHardware}
            onOpenModels={() => setActiveTab('models')}
            onOpenLoadConfig={() => setLoadConfigOpen(true)}
            onOpenChat={() => setActiveTab('chat')}
            onOpenHud={() => setHudOpen((v) => !v)}
            onApplyAndReload={handleApplyAndReload}
            onStopEngine={handleStopEngine}
          />
        )}

        {activeTab === 'models' && (
          <ModelsHubPage
            activeModel={activeModel}
            plan={plan}
            engineStatus={engineStatus}
            onActivateModel={handleSelectModel}
            onOpenLoadConfig={() => setLoadConfigOpen(true)}
          />
        )}

        {activeTab === 'chat' && (
          <ChatAndBrainPage
            activeModel={activeModel}
            availableModels={availableModels}
            plan={plan}
            engineStatus={engineStatus}
            upstreamUrl={upstreamUrl}
            onUpstreamConnected={handleUpstreamConnected}
            onOpenLoadConfig={() => setLoadConfigOpen(true)}
            onSelectModel={handleSelectModel}
            onApplyAndReload={handleApplyAndReload}
            onStopEngine={handleStopEngine}
          />
        )}

        {activeTab === 'connect' && (
          <ApiHarnessConnectPage
            activeModel={activeModel}
            liveHardware={liveHardware}
            engineStatus={engineStatus}
          />
        )}
      </main>

      {/* Pop-Out Floating Resource Monitor HUD */}
      <FloatingResourceHud open={hudOpen} plan={plan} onClose={() => setHudOpen(false)} />

      {/* LM Studio / Unsloth Studio-Style Model Load Config & Hot-Reload Drawer */}
      <ModelLoadConfigDrawer
        open={loadConfigOpen}
        model={activeModel}
        config={tuningConfig}
        plan={plan}
        engineStatus={engineStatus}
        onUpdateConfig={handleUpdateConfig}
        onApplyAndReload={handleApplyAndReload}
        onResetDefaults={handleResetDefaults}
        onClose={() => setLoadConfigOpen(false)}
      />

      {/* Settings Dialog */}
      <SettingsMenuDialog
        open={settingsOpen}
        isDarkTheme={isDarkTheme}
        hudOpen={hudOpen}
        onToggleTheme={() => setIsDarkTheme((v) => !v)}
        onToggleHud={() => setHudOpen((v) => !v)}
        onReopenOnboarding={handleReopenOnboarding}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

export default App;
