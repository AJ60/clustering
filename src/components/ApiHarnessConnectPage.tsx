import React, { useMemo, useState } from 'react';
import { GgufModelPreset, StarClusterPlan } from '../types/starCluster';
import {
  Check,
  Copy,
  Download,
  Play,
  PlugZap,
  Terminal,
} from 'lucide-react';

interface ApiHarnessConnectPageProps {
  activeModel: GgufModelPreset;
  clusterPlan: StarClusterPlan;
  clusterSecret: string;
}

type HarnessId =
  | 'hermes'
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'cline'
  | 'continue'
  | 'aider'
  | 'curl-python';

interface HarnessSpec {
  id: HarnessId;
  name: string;
  subtitle: string;
  oneStepCommand: string;
  configFileName: string;
  configContent: string;
  notes: string;
}

export const ApiHarnessConnectPage: React.FC<ApiHarnessConnectPageProps> = ({
  activeModel,
  clusterPlan,
  clusterSecret,
}) => {
  const [selectedHarness, setSelectedHarness] = useState<HarnessId>('hermes');
  const [targetMode, setTargetMode] = useState<'web-proxy' | 'native-lan'>('web-proxy');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testOutput, setTestOutput] = useState<string | null>(null);

  const originBase =
    typeof window !== 'undefined' ? `${window.location.origin}/v1` : 'http://127.0.0.1:3000/v1';
  const baseUrl = targetMode === 'web-proxy' ? originBase : 'http://127.0.0.1:8080/v1';
  const modelId = activeModel.id;

  const harnesses: HarnessSpec[] = useMemo(
    () => [
      {
        id: 'hermes',
        name: 'Hermes Agent',
        subtitle: 'Nous Research Hermes CLI & tool-calling agent harness',
        oneStepCommand: `OPENAI_BASE_URL="${baseUrl}" OPENAI_API_KEY="${clusterSecret}" hermes --model "${modelId}"`,
        configFileName: 'hermes-config.yaml',
        configContent: `# ~/.hermes/config.yaml — ClusterLab OpenAI Endpoint\nmodel:\n  provider: openai\n  base_url: "${baseUrl}"\n  api_key: "${clusterSecret}"\n  default: "${modelId}"\n  context_length: ${activeModel.contextLengthDefault}\n  supports_tools: true\n`,
        notes:
          'Works directly with /v1/chat/completions tool-use and SSE streaming across all cluster nodes.',
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        subtitle: 'Terminal AI coding agent (opencode.json OpenAI provider)',
        oneStepCommand: `OPENAI_BASE_URL="${baseUrl}" OPENAI_API_KEY="${clusterSecret}" opencode --model "clusterlab/${modelId}"`,
        configFileName: 'opencode.json',
        configContent: JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            provider: {
              clusterlab: {
                npm: '@ai-sdk/openai-compatible',
                name: 'ClusterLab Star Cluster',
                options: {
                  baseURL: baseUrl,
                  apiKey: clusterSecret,
                },
                models: {
                  [modelId]: {
                    name: activeModel.name,
                    limit: {
                      context: activeModel.contextLengthDefault,
                      output: 8192,
                    },
                  },
                },
              },
            },
            model: `clusterlab/${modelId}`,
          },
          null,
          2
        ),
        notes:
          'Drop opencode.json into your repo root or ~/.config/opencode/opencode.json for instant 1-step OpenCode routing.',
      },
      {
        id: 'claude-code',
        name: 'Claude Code Bridge',
        subtitle: 'Point Anthropic-compatible / LiteLLM OpenAI router to ClusterLab',
        oneStepCommand: `OPENAI_API_BASE="${baseUrl}" OPENAI_API_KEY="${clusterSecret}" litellm --model "openai/${modelId}" --port 4000`,
        configFileName: 'claude-code.env',
        configContent: `# Connect Claude Code via local OpenAI->Anthropic bridge (e.g. LiteLLM / claude-code-router)\nOPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=${clusterSecret}\nCLUSTERLAB_MODEL=${modelId}\nANTHROPIC_BASE_URL=http://127.0.0.1:4000\nANTHROPIC_MODEL=openai/${modelId}\n`,
        notes:
          'Pairs cleanly with OpenAI-compatible bridge proxies when using Claude Code against local GGUF clusters.',
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        subtitle: 'OpenAI Codex CLI connected directly to local /v1',
        oneStepCommand: `OPENAI_BASE_URL="${baseUrl}" OPENAI_API_KEY="${clusterSecret}" codex --provider openai --model "${modelId}"`,
        configFileName: 'codex-config.toml',
        configContent: `# ~/.codex/config.toml\nmodel = "${modelId}"\nmodel_provider = "clusterlab"\n\n[model_providers.clusterlab]\nname = "ClusterLab Star"\nbase_url = "${baseUrl}"\nenv_key = "OPENAI_API_KEY"\n`,
        notes:
          'Uses standard OpenAI Chat Completions wire format served by ClusterLab Express or native llama-server.',
      },
      {
        id: 'cline',
        name: 'Cline / Roo Code',
        subtitle: 'VS Code autonomous coding extensions (OpenAI Compatible provider)',
        oneStepCommand: `code --install-extension saoudrizwan.claude-dev && echo "Set Base URL: ${baseUrl} | Model: ${modelId}"`,
        configFileName: 'cline-settings.json',
        configContent: JSON.stringify(
          {
            apiProvider: 'openai',
            openAiBaseUrl: baseUrl,
            openAiApiKey: clusterSecret,
            openAiModelId: modelId,
            openAiModelInfo: {
              maxTokens: 8192,
              contextWindow: activeModel.contextLengthDefault,
              supportsPromptCache: false,
            },
          },
          null,
          2
        ),
        notes:
          'Paste Base URL, API Key, and Model ID in Cline / Roo Code Settings -> API Provider -> OpenAI Compatible.',
      },
      {
        id: 'continue',
        name: 'Continue.dev',
        subtitle: 'IDE autocomplete & chat assistant (~/.continue/config.yaml)',
        oneStepCommand: `mkdir -p ~/.continue && cat <<'EOF' > ~/.continue/config.yaml\nmodels:\n  - name: ${activeModel.name}\n    provider: openai\n    model: ${modelId}\n    apiBase: ${baseUrl}\n    apiKey: ${clusterSecret}\nEOF`,
        configFileName: 'continue-config.yaml',
        configContent: `name: ClusterLab Workspace\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: ${activeModel.name}\n    provider: openai\n    model: ${modelId}\n    apiBase: ${baseUrl}\n    apiKey: ${clusterSecret}\n`,
        notes: 'Supports interactive repo chat, inline edits, and multi-file context.',
      },
      {
        id: 'aider',
        name: 'Aider',
        subtitle: '1-command git pair-programmer connected to /v1',
        oneStepCommand: `OPENAI_API_BASE="${baseUrl}" OPENAI_API_KEY="${clusterSecret}" aider --model "openai/${modelId}"`,
        configFileName: '.aider.conf.yml',
        configContent: `openai-api-base: ${baseUrl}\nopenai-api-key: ${clusterSecret}\nmodel: openai/${modelId}\n`,
        notes: 'Pass --no-show-model-warnings if loading custom Hugging Face GGUF aliases.',
      },
      {
        id: 'curl-python',
        name: 'cURL & Python SDK',
        subtitle: 'Direct OpenAI SDK & HTTP wire verification',
        oneStepCommand: `curl -sS "${baseUrl}/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer ${clusterSecret}" -d '{"model":"${modelId}","messages":[{"role":"user","content":"Check cluster node status"}]}'`,
        configFileName: 'test_clusterlab.py',
        configContent: `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${baseUrl}",\n    api_key="${clusterSecret}",\n)\n\nresp = client.chat.completions.create(\n    model="${modelId}",\n    messages=[{"role": "user", "content": "Inspect active parameters per node"}],\n    stream=True,\n)\nfor chunk in resp:\n    print(chunk.choices[0].delta.content or "", end="", flush=True)\n`,
        notes: 'Drop-in replacement for OpenAI official Python, TypeScript, Go, or Rust SDKs.',
      },
    ],
    [activeModel, baseUrl, clusterSecret, modelId]
  );

  const activeHarness =
    harnesses.find((h) => h.id === selectedHarness) ?? harnesses[0];

  const handleCopy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1600);
  };

  const handleDownloadConfig = (fileName: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runLiveEndpointTest = async () => {
    setIsTesting(true);
    setTestOutput(null);
    const t0 = performance.now();
    try {
      const modelsRes = await fetch('/v1/models');
      const modelsJson = await modelsRes.json();

      const chatRes = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${clusterSecret}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Verify node status and active parameters.' }],
          stream: false,
        }),
      });
      const chatJson = await chatRes.json();
      const ms = Math.round(performance.now() - t0);

      setTestOutput(
        JSON.stringify(
          {
            http_status: chatRes.status,
            latency_ms: ms,
            models_available: modelsJson?.data?.length ?? 0,
            completion_id: chatJson?.id,
            model: chatJson?.model,
            usage: chatJson?.usage,
            x_cluster_trace: chatJson?.x_cluster_trace,
          },
          null,
          2
        )
      );
    } catch (err) {
      setTestOutput(
        `Test failed: ${err instanceof Error ? err.message : 'Unable to reach endpoint'}`
      );
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      {/* 1. OpenAI-Compatible Endpoint Overview & Live Tester */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
              OpenAI Wire Protocol · {activeModel.name} ·{' '}
              {clusterPlan.activeParamsPerTokenB}B active/tok
            </div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
              OpenAI-Compatible Endpoints & 1-Step Harness Connect
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setTargetMode('web-proxy')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 ${
                  targetMode === 'web-proxy'
                    ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                App Server (:3000/v1)
              </button>
              <button
                type="button"
                onClick={() => setTargetMode('native-lan')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 ${
                  targetMode === 'native-lan'
                    ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Native Backend (:8080/v1)
              </button>
            </div>

            <button
              type="button"
              onClick={() => void runLiveEndpointTest()}
              disabled={isTesting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white px-4 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isTesting ? 'Testing...' : 'Test Live /v1 Endpoint'}</span>
            </button>
          </div>
        </div>

        {/* 3 Endpoint Boxes */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            { label: 'Base URL (OPENAI_BASE_URL)', value: baseUrl, key: 'base' },
            { label: 'Chat Completions (POST + SSE)', value: `${baseUrl}/chat/completions`, key: 'chat' },
            { label: 'Models List & API Key', value: `${baseUrl}/models · Key: ${clusterSecret}`, key: 'models' },
          ].map((item) => (
            <div
              key={item.key}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B1120] p-3 flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {item.label}
                </div>
                <div className="text-xs font-mono-num font-semibold text-slate-900 dark:text-slate-100 truncate mt-0.5">
                  {item.value}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(item.key, item.value)}
                title="Copy"
                className="p-1.5 rounded-md text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 shrink-0"
              >
                {copiedKey === item.key ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>

        {testOutput && (
          <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 p-3.5 text-[11px] font-mono-num text-emerald-400 overflow-x-auto max-h-56">
            {testOutput}
          </pre>
        )}
      </section>

      {/* 2. 1-Step Connect Harness Studio */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Harness Picker Sidebar */}
        <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-3 space-y-1">
          <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <PlugZap className="w-3.5 h-3.5 text-blue-500" />
            Select Agent or Coding Harness
          </div>
          {harnesses.map((h) => {
            const active = h.id === activeHarness.id;
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => setSelectedHarness(h.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${
                  active
                    ? 'bg-blue-600/10 border border-blue-500/40 text-blue-700 dark:text-blue-300'
                    : 'border border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-200'
                }`}
              >
                <div className="text-xs font-bold">{h.name}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {h.subtitle}
                </div>
              </button>
            );
          })}
        </div>

        {/* Selected Harness 1-Step Command & Config */}
        <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                1-Step Connect: {activeHarness.name}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {activeHarness.notes}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                handleDownloadConfig(activeHarness.configFileName, activeHarness.configContent)
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download {activeHarness.configFileName}</span>
            </button>
          </div>

          {/* 1-Step Launch Command */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200">
              <span className="flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-teal-500" />
                One-Step Terminal Connect
              </span>
              <button
                type="button"
                onClick={() => handleCopy('cmd', activeHarness.oneStepCommand)}
                className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
              >
                {copiedKey === 'cmd' ? (
                  <>
                    <Check className="w-3.5 h-3.5" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Copy Command
                  </>
                )}
              </button>
            </div>
            <pre className="rounded-lg bg-slate-950 border border-slate-800 p-3.5 text-xs font-mono-num text-emerald-400 overflow-x-auto">
              {activeHarness.oneStepCommand}
            </pre>
          </div>

          {/* Drop-In Config Snippet */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200">
              <span>{activeHarness.configFileName}</span>
              <button
                type="button"
                onClick={() => handleCopy('cfg', activeHarness.configContent)}
                className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
              >
                {copiedKey === 'cfg' ? (
                  <>
                    <Check className="w-3.5 h-3.5" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Copy File
                  </>
                )}
              </button>
            </div>
            <pre className="rounded-lg bg-slate-950 border border-slate-800 p-3.5 text-xs font-mono-num text-slate-200 overflow-x-auto">
              {activeHarness.configContent}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
};
