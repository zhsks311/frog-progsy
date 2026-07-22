import { useEffect, useMemo, useRef, useState } from "react";
import Logs from "./Logs";
import { Notice } from "../ui";
import { IconPower } from "../icons";
import { useT, type TKey } from "../i18n";
import type { DeepLinkTarget, Navigate } from "../navigation";
import { ClassifierInfo } from "../components/ClassifierInfo";

interface SettingsData { port: number; hostname: string }
interface FallbackProviderOption { name: string; models: string[]; defaultModel?: string }
interface FallbackData { providers: FallbackProviderOption[]; webSearchProviders?: FallbackProviderOption[]; imageProviders?: FallbackProviderOption[]; webSearch: { enabled: boolean; provider: string; model: string; reasoning: string }; image: { enabled: boolean; provider: string; model: string } }
interface ClassifierProviderOption { name: string; classifierModel: string; models: string[] }
interface ClassifierData { providers: ClassifierProviderOption[]; classifierFallback: { provider: string; model?: string } }
type GitProtectionState = "tracked" | "ignored" | "excluded" | "untracked" | "not_git" | "unwritable" | "unknown";

interface ClaudeProjectDiagnostics {
  root?: string;
  settingsPath?: string;
  gitProtection?: GitProtectionState | string;
  gateway?: { modelDiscoveryReady?: boolean; effectiveSource?: string };
  modelDiscoveryReady?: boolean;
  effectiveSource?: string;
  tokenScope?: string;
  routingProfileId?: string;
  danglingRoutingProfileId?: string;
}
interface ClaudeStatusData {
  claudeCode: {
    injected: boolean;
    expectedBaseUrl: string;
    actualBaseUrl: string | null;
    baseUrlMatchesExpected: boolean;
    gatewayDiscovery: boolean;
    authToken: string;
    modelDiscoveryReady?: boolean;
    discoveryAuth?: string;
  };
  project?: ClaudeProjectDiagnostics | null;
  lastMessages: {
    present: boolean;
    lifecycle?: string;
    status?: number | null;
    route?: { provider?: string; model?: string; adapter?: string; routeKind?: string };
    error?: { kind?: string; code?: string; upstreamStatus?: number } | null;
  };
  runtime: {
    uptimeSeconds: number;
    processPid: number;
    configuredPort: number;
    activePort: number;
    externalSupervisorMode: boolean;
    watchdog: {
      enabled: boolean;
      pid: number | null;
      running: boolean;
      giveUp: { present: boolean; attempts: number | null; gaveUpAt: string | null; unreadable: boolean };
    };
  };
}

type FallbackPatch = { webSearch?: Partial<FallbackData["webSearch"]>; image?: Partial<FallbackData["image"]> };
type SectionError = "load" | "save" | null;

const REASONING_LEVELS = ["low", "medium", "high"];
function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.round(seconds)}s`;
}

function gitProtectionKey(state: string | undefined): TKey {
  switch (state) {
    case "tracked": return "claudeProjects.git.tracked";
    case "ignored": return "claudeProjects.git.ignored";
    case "excluded": return "claudeProjects.git.excluded";
    case "untracked": return "claudeProjects.git.untracked";
    case "not_git": return "claudeProjects.git.not_git";
    case "unwritable": return "claudeProjects.git.unwritable";
    default: return "claudeProjects.git.unknown";
  }
}

const COMMANDS: { cmd: string; labelKey: "dash.command.refresh" | "dash.command.restore"; hintKey: "dash.command.refreshHint" | "dash.command.restoreHint" }[] = [
  { cmd: "frogp refresh", labelKey: "dash.command.refresh", hintKey: "dash.command.refreshHint" },
  { cmd: "frogp restore", labelKey: "dash.command.restore", hintKey: "dash.command.restoreHint" },
];

export default function DeveloperDetails({ apiBase, target, navigate }: { apiBase: string; target?: DeepLinkTarget | null; navigate?: Navigate }) {
  const t = useT();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [fallback, setFallback] = useState<FallbackData | null>(null);
  const [classifier, setClassifier] = useState<ClassifierData | null>(null);
  const [fallbackSaving, setFallbackSaving] = useState(false);
  const [classifierSaving, setClassifierSaving] = useState(false);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatusData | null>(null);
  const [stopping, setStopping] = useState(false);
  const [webSearchModelDraft, setWebSearchModelDraft] = useState("");
  const [imageModelDraft, setImageModelDraft] = useState("");
  const [copiedCommand, setCopiedCommand] = useState("");
  const recoveryRef = useRef<HTMLElement | null>(null);
  const debuggingRef = useRef<HTMLElement | null>(null);
  const [settingsError, setSettingsError] = useState<SectionError>(null);
  const [fallbackError, setFallbackError] = useState<SectionError>(null);
  const [classifierError, setClassifierError] = useState<SectionError>(null);
  const [claudeStatusError, setClaudeStatusError] = useState<SectionError>(null);


  useEffect(() => {
    const fetchData = async () => {
      const [settingsResult, fallbackResult, classifierResult, claudeStatusResult] = await Promise.allSettled([
        fetch(`${apiBase}/api/settings`).then(res => {
          if (!res.ok) throw new Error("settings load failed");
          return res.json() as Promise<SettingsData>;
        }),
        fetch(`${apiBase}/api/fallback-settings`).then(res => {
          if (!res.ok) throw new Error("fallback load failed");
          return res.json() as Promise<FallbackData>;
        }),
        fetch(`${apiBase}/api/classifier-settings`).then(res => {
          if (!res.ok) throw new Error("classifier load failed");
          return res.json() as Promise<ClassifierData>;
        }),
        fetch(`${apiBase}/api/claude-status`).then(res => {
          if (!res.ok) throw new Error("claude status load failed");
          return res.json() as Promise<ClaudeStatusData>;
        }),
      ]);

      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value);
        setSettingsError(null);
      } else {
        setSettings(null);
        setSettingsError("load");
      }

      if (fallbackResult.status === "fulfilled") {
        setFallback(fallbackResult.value);
        setFallbackError(null);
      } else {
        setFallback(null);
        setFallbackError("load");
      }

      if (classifierResult.status === "fulfilled") {
        setClassifier(classifierResult.value);
        setClassifierError(null);
      } else {
        setClassifier(null);
        setClassifierError("load");
      }
      if (claudeStatusResult.status === "fulfilled") {
        setClaudeStatus(claudeStatusResult.value);
        setClaudeStatusError(null);
      } else {
        setClaudeStatus(null);
        setClaudeStatusError("load");
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [apiBase]);
  useEffect(() => {
    if (target === "recovery-controls") recoveryRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (target === "debugging-logs") debuggingRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [target]);


  useEffect(() => {
    if (!fallback) return;
    setWebSearchModelDraft(fallback.webSearch.model);
    setImageModelDraft(fallback.image.model);
  }, [fallback?.webSearch.model, fallback?.image.model]);
  const webSearchFallbackProviders = fallback?.webSearchProviders ?? fallback?.providers ?? [];
  const imageFallbackProviders = fallback?.imageProviders ?? fallback?.providers ?? [];

  const fallbackModelOptions = useMemo(() => {
    const values = new Set<string>();
    for (const provider of [...webSearchFallbackProviders, ...imageFallbackProviders]) {
      for (const model of provider.models) values.add(model);
    }
    if (fallback?.webSearch.model) values.add(fallback.webSearch.model);
    if (fallback?.image.model) values.add(fallback.image.model);
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [webSearchFallbackProviders, imageFallbackProviders, fallback?.webSearch.model, fallback?.image.model]);

  const saveFallbacks = async (patch: FallbackPatch) => {
    if (!fallback || fallbackSaving) return;
    const previous = fallback;
    const next = {
      providers: fallback.providers,
      webSearchProviders: webSearchFallbackProviders,
      imageProviders: imageFallbackProviders,
      webSearch: { ...fallback.webSearch, ...patch.webSearch },
      image: { ...fallback.image, ...patch.image },
    };
    setFallbackSaving(true);
    setFallback(next);
    try {
      const res = await fetch(`${apiBase}/api/fallback-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json();
      setFallback({ providers: data.providers ?? previous.providers, webSearchProviders: data.webSearchProviders ?? data.providers ?? previous.webSearchProviders, imageProviders: data.imageProviders ?? data.providers ?? previous.imageProviders, webSearch: data.webSearch, image: data.image });
      setFallbackError(null);
    } catch {
      setFallback(previous);
      setFallbackError("save");
    } finally {
      setFallbackSaving(false);
    }
  };

  const saveClassifier = async (patch: { providers?: Record<string, { classifierModel: string }>; classifierFallback?: { provider: string; model?: string } }) => {
    if (!classifier || classifierSaving) return;
    const previous = classifier;
    setClassifierSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/classifier-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json() as ClassifierData & { ok: boolean; warnings: string[] };
      setClassifier({ providers: data.providers, classifierFallback: data.classifierFallback });
      setClassifierError(null);
      if (Array.isArray(data.warnings) && data.warnings.length > 0) console.warn("frogprogsy: classifier settings warnings:", data.warnings);
    } catch {
      setClassifier(previous);
      setClassifierError("save");
    } finally {
      setClassifierSaving(false);
    }
  };

  const modelsForFallbackProvider = (providerList: FallbackProviderOption[], providerName: string): string[] =>
    providerList.find(provider => provider.name === providerName)?.models ?? [];

  const selectWebSearchProvider = (provider: string) => {
    if (!fallback) return;
    const models = modelsForFallbackProvider(webSearchFallbackProviders, provider);
    const model = models.includes(fallback.webSearch.model) ? fallback.webSearch.model : (models[0] ?? fallback.webSearch.model);
    setWebSearchModelDraft(model);
    saveFallbacks({ webSearch: { provider, model } });
  };

  const selectImageProvider = (provider: string) => {
    if (!fallback) return;
    const models = modelsForFallbackProvider(imageFallbackProviders, provider);
    const model = models.includes(fallback.image.model) ? fallback.image.model : (models[0] ?? fallback.image.model);
    setImageModelDraft(model);
    saveFallbacks({ image: { provider, model } });
  };

  const commitWebSearchModel = () => {
    if (!fallback) return;
    const model = webSearchModelDraft.trim();
    if (!model) return setWebSearchModelDraft(fallback.webSearch.model);
    if (model !== fallback.webSearch.model) saveFallbacks({ webSearch: { model } });
  };

  const commitImageModel = () => {
    if (!fallback) return;
    const model = imageModelDraft.trim();
    if (!model) return setImageModelDraft(fallback.image.model);
    if (model !== fallback.image.model) saveFallbacks({ image: { model } });
  };


  const handleStop = async () => {
    if (!confirm(t("dash.stopConfirm"))) return;
    setStopping(true);
    try { await fetch(`${apiBase}/api/stop`, { method: "POST" }); } catch { /* connection drops */ }
  };

  const copyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard?.writeText(cmd);
      setCopiedCommand(cmd);
      window.setTimeout(() => setCopiedCommand(current => current === cmd ? "" : current), 1800);
    } catch {
      setCopiedCommand("");
    }
  };

  return (
    <>
      <div className="page-head"><h2>{t("nav.developerDetails")}</h2></div>
      <p className="page-sub">{t("dev.subtitle")}</p>
      <datalist id="fallback-model-options">
        {fallbackModelOptions.map(model => <option key={model} value={model} />)}
      </datalist>

      <section ref={recoveryRef} className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("dev.recovery")}</h3><span className="muted" style={{ fontSize: 12 }}>{t("dev.recoveryHint")}</span></div>
        <div className="dashboard-grid">
          <section className="dashboard-card panel-soft">
            <div className="panel-head">
              <h3 className="panel-title">{t("dash.claudeControl")}</h3>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>{t("dash.claudeControlHint")}</p>
            {settingsError && <Notice tone="err">{t("dev.loadSettingsFailed")}</Notice>}
            <div className="mini-list">
              <div><span>{t("dash.host")}</span><code>{settings?.hostname ?? "—"}</code></div>
              <div><span>{t("dash.port")}</span><code>{settings?.port ?? "—"}</code></div>
            </div>
            <button type="button" className="btn btn-danger" onClick={handleStop} disabled={stopping || !settings}>
              <IconPower style={{ width: 15, height: 15 }} /> {stopping ? t("dash.stopping") : t("dash.stop")}
            </button>
          </section>

          <section className="dashboard-card panel-soft">
            <div className="panel-head"><h3 className="panel-title">{t("dash.commandChips")}</h3><span className="muted" style={{ fontSize: 12 }}>{t("dev.commandFallbackHint")}</span></div>
            <div className="command-chip-grid compact">
              {COMMANDS.map(item => (
                <button key={item.cmd} type="button" className="command-chip" onClick={() => copyCommand(item.cmd)} aria-label={t("dash.copyCommand", { cmd: item.cmd })}>
                  <code>{item.cmd}</code>
                  <span>{t(item.labelKey)}</span>
                  <small>{copiedCommand === item.cmd ? t("dash.commandCopied") : t(item.hintKey)}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      </section>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("dev.runtimeDiagnostics")}</h3><span className="muted" style={{ fontSize: 12 }}>{t("dev.runtimeDiagnosticsHint")}</span></div>
        {claudeStatusError && <Notice tone="err">{t("dev.loadClaudeStatusFailed")}</Notice>}
        <div className="dashboard-grid">
          <section className="dashboard-card panel-soft">
            <h3 className="panel-title">{t("dev.claudeInjection")}</h3>
            <div className="mini-list">
              <div><span>{t("dev.injectionState")}</span><code style={{ color: claudeStatus?.claudeCode.injected ? "var(--green)" : "var(--text)" }}>{claudeStatus?.claudeCode.injected ? t("dev.injected") : t("dev.notInjected")}</code></div>
              <div><span>{t("dev.expectedBaseUrl")}</span><code>{claudeStatus?.claudeCode.expectedBaseUrl ?? "—"}</code></div>
              <div><span>{t("dev.actualBaseUrl")}</span><code>{claudeStatus?.claudeCode.actualBaseUrl ?? "—"}</code></div>
              <div><span>{t("dev.gatewayDiscovery")}</span><code>{claudeStatus?.claudeCode.gatewayDiscovery ? t("common.yes") : t("common.no")}</code></div>
              <div><span>{t("dev.authToken")}</span><code>{claudeStatus?.claudeCode.authToken ?? "—"}</code></div>
              <div><span>{t("dev.modelDiscoveryReady")}</span><code>{claudeStatus?.claudeCode.modelDiscoveryReady ? t("common.yes") : t("common.no")}</code></div>
              <div><span>{t("dev.discoveryAuth")}</span><code>{claudeStatus?.claudeCode.discoveryAuth ?? "—"}</code></div>
              <div><span>{t("dev.tokenScope")}</span><code>{claudeStatus?.project?.tokenScope ?? "—"}</code></div>
            </div>
          </section>
          <section className="dashboard-card panel-soft">
            <h3 className="panel-title">{t("dev.projectEnrollment")}</h3>
            <div className="mini-list">
              <div><span>{t("claudeProjects.root")}</span><code className="text-anywhere">{claudeStatus?.project?.root ?? "—"}</code></div>
              <div><span>{t("claudeProjects.settingsPath")}</span><code className="text-anywhere">{claudeStatus?.project?.settingsPath ?? "—"}</code></div>
              <div><span>{t("claudeProjects.gitProtection")}</span><code>{t(gitProtectionKey(claudeStatus?.project?.gitProtection))}</code></div>
              <div><span>{t("dev.modelDiscoveryReady")}</span><code>{(claudeStatus?.project?.gateway?.modelDiscoveryReady ?? claudeStatus?.project?.modelDiscoveryReady) ? t("common.yes") : t("common.no")}</code></div>
              <div><span>{t("claudeProjects.effectiveSource")}</span><code>{claudeStatus?.project?.gateway?.effectiveSource ?? claudeStatus?.project?.effectiveSource ?? "—"}</code></div>
              <div><span>{t("claudeProjects.routingProfile")}</span><code>{claudeStatus?.project?.routingProfileId ?? "—"}</code></div>
            </div>
            {claudeStatus?.project?.gitProtection === "tracked" && <Notice tone="err">{t("claudeProjects.trackedBlock")}</Notice>}
            {claudeStatus?.project?.danglingRoutingProfileId && <Notice tone="err">{t("claudeProjects.danglingRoutingHint")}</Notice>}
          </section>
          <section className="dashboard-card panel-soft">
            <h3 className="panel-title">{t("dev.runtime")}</h3>
            <div className="mini-list">
              <div><span>{t("dev.uptime")}</span><code>{formatUptime(claudeStatus?.runtime.uptimeSeconds)}</code></div>
              <div><span>{t("dev.activePort")}</span><code>{claudeStatus?.runtime.activePort ?? "—"}</code></div>
              <div><span>{t("dev.externalSupervisor")}</span><code>{claudeStatus?.runtime.externalSupervisorMode ? t("common.yes") : t("common.no")}</code></div>
              <div><span>{t("dev.watchdog")}</span><code>{claudeStatus?.runtime.watchdog.enabled ? (claudeStatus.runtime.watchdog.running ? t("dev.watchdogRunning") : t("dev.watchdogEnabled")) : t("dev.watchdogDisabled")}</code></div>
              <div><span>{t("dev.watchdogGiveUp")}</span><code>{claudeStatus?.runtime.watchdog.giveUp.present ? (claudeStatus.runtime.watchdog.giveUp.gaveUpAt ?? t("dev.present")) : t("dev.absent")}</code></div>
            </div>
          </section>
          <section className="dashboard-card panel-soft">
            <h3 className="panel-title">{t("dev.lastMessages")}</h3>
            <div className="mini-list">
              <div><span>{t("dev.lastMessagesSeen")}</span><code>{claudeStatus?.lastMessages.present ? t("common.yes") : t("common.no")}</code></div>
              <div><span>{t("logs.col.status")}</span><code>{claudeStatus?.lastMessages.status ?? claudeStatus?.lastMessages.lifecycle ?? "—"}</code></div>
              <div><span>{t("logs.col.provider")}</span><code>{claudeStatus?.lastMessages.route?.provider ?? "—"}</code></div>
              <div><span>{t("logs.col.model")}</span><code className="text-anywhere">{claudeStatus?.lastMessages.route?.model ?? "—"}</code></div>
              <div><span>{t("logs.col.errorCodes")}</span><code>{claudeStatus?.lastMessages.error?.code ?? "—"}</code></div>
            </div>
          </section>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("dash.fallbackControls")}</h3><span className="muted" style={{ fontSize: 12 }}>{fallbackSaving ? t("prov.savingDefault") : t("dash.fallbackExisting")}</span></div>
        {fallbackError && <Notice tone="err">{t(fallbackError === "save" ? "dev.saveFallbackFailed" : "dev.loadFallbackFailed")}</Notice>}
        <div className="fallback-grid">
          <div className="fallback-row">
            <div><div style={{ fontWeight: 650 }}>{t("dash.searchModel")}</div><div className="muted" style={{ fontSize: 13 }}>{t("dash.searchModelHint")}</div></div>
            <div className="fallback-controls">
              <select className="select-sm" value={fallback?.webSearch.provider ?? ""} disabled={!fallback || fallbackSaving || webSearchFallbackProviders.length === 0} onChange={e => selectWebSearchProvider(e.target.value)} aria-label={t("dash.fallbackProvider")}>
                {webSearchFallbackProviders.length ? webSearchFallbackProviders.map(provider => <option key={provider.name} value={provider.name}>{provider.name}</option>) : <option value="">{fallbackError ? t("dev.loadFailedShort") : t("dash.noFallbackProvider")}</option>}
              </select>
              <input className="select-sm" list="fallback-model-options" value={webSearchModelDraft} disabled={!fallback || fallbackSaving} onChange={e => setWebSearchModelDraft(e.target.value)} onBlur={commitWebSearchModel} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              <button className={`switch ${fallback?.webSearch.enabled ? "on" : ""}`} onClick={() => fallback && saveFallbacks({ webSearch: { enabled: !fallback.webSearch.enabled } })} disabled={!fallback || fallbackSaving} aria-label={t("dash.searchFallbackEnabled")} aria-pressed={fallback?.webSearch.enabled ?? false}><span className="knob" /></button>
              <select className="select-sm" value={fallback?.webSearch.reasoning ?? "low"} disabled={!fallback || fallbackSaving} onChange={e => saveFallbacks({ webSearch: { reasoning: e.target.value } })}>{REASONING_LEVELS.map(r => <option key={r} value={r}>{r}</option>)}</select>
            </div>
          </div>
          <div className="fallback-row">
            <div><div style={{ fontWeight: 650 }}>{t("dash.imageModel")}</div><div className="muted" style={{ fontSize: 13 }}>{t("dash.imageModelHint")}</div></div>
            <div className="fallback-controls">
              <select className="select-sm" value={fallback?.image.provider ?? ""} disabled={!fallback || fallbackSaving || imageFallbackProviders.length === 0} onChange={e => selectImageProvider(e.target.value)} aria-label={t("dash.fallbackProvider")}>
                {imageFallbackProviders.length ? imageFallbackProviders.map(provider => <option key={provider.name} value={provider.name}>{provider.name}</option>) : <option value="">{fallbackError ? t("dev.loadFailedShort") : t("dash.noFallbackProvider")}</option>}
              </select>
              <input className="select-sm" list="fallback-model-options" value={imageModelDraft} disabled={!fallback || fallbackSaving} onChange={e => setImageModelDraft(e.target.value)} onBlur={commitImageModel} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              <button className={`switch ${fallback?.image.enabled ? "on" : ""}`} onClick={() => fallback && saveFallbacks({ image: { enabled: !fallback.image.enabled } })} disabled={!fallback || fallbackSaving} aria-label={t("dash.imageFallbackEnabled")} aria-pressed={fallback?.image.enabled ?? false}><span className="knob" /></button>
            </div>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("dash.classifierTitle")}</h3><span className="muted" style={{ fontSize: 12 }}>{classifierSaving ? t("prov.savingDefault") : t("dash.classifierHint")}</span></div>
        <ClassifierInfo />
        {classifierError && <Notice tone="err">{t(classifierError === "save" ? "dev.saveClassifierFailed" : "dev.loadClassifierFailed")}</Notice>}
        <div className="fallback-grid">
          {(classifier?.providers ?? []).map(prov => (
            <div key={prov.name} className="fallback-row">
              <div><div style={{ fontWeight: 650 }}>{prov.name}</div><div className="muted" style={{ fontSize: 13 }}>{t("dash.classifierProviderHint")}</div></div>
              <div className="fallback-controls">
                <select className="select-sm" value={prov.classifierModel} disabled={!classifier || classifierSaving} onChange={e => saveClassifier({ providers: { [prov.name]: { classifierModel: e.target.value } } })} aria-label={t("dash.classifierModelLabel", { provider: prov.name })}>
                  <option value="">{t("dash.classifierDefault")}</option>
                  {(prov.classifierModel && !prov.models.includes(prov.classifierModel) ? [prov.classifierModel, ...prov.models] : prov.models).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
          ))}
          <div className="fallback-row">
            <div><div style={{ fontWeight: 650 }}>{t("dash.classifierFallbackLabel")}</div><div className="muted" style={{ fontSize: 13 }}>{t("dash.classifierFallbackHint")}</div></div>
            <div className="fallback-controls">
              <select className="select-sm" value={classifier?.classifierFallback.provider ?? ""} disabled={!classifier || classifierSaving} onChange={e => saveClassifier({ classifierFallback: { provider: e.target.value } })} aria-label={t("dash.classifierFallbackProvider")}>
                <option value="">{t("dash.classifierFallbackNone")}</option>
                {(classifier?.providers ?? []).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
              {classifier?.classifierFallback.provider ? (
                <select className="select-sm" value={classifier.classifierFallback.model ?? ""} disabled={!classifier || classifierSaving} onChange={e => saveClassifier({ classifierFallback: { provider: classifier.classifierFallback.provider, model: e.target.value } })} aria-label={t("dash.classifierFallbackModel")}>
                  <option value="">{t("dash.classifierDefault")}</option>
                  {(classifier.providers.find(p => p.name === classifier.classifierFallback.provider)?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section ref={debuggingRef} className="panel">
        <div className="panel-head"><h3 className="panel-title">{t("dev.debugging")}</h3><span className="muted" style={{ fontSize: 12 }}>{t("dash.safeDiagnostics")}</span></div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{t("dev.debuggingHint")}</p>
        <Logs apiBase={apiBase} embedded navigate={navigate} />
      </section>
    </>
  );
}
