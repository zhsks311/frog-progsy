import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { ModelMixingInfo } from "../components/ModelMixingInfo";
import { useI18n, type TKey, type TFn } from "../i18n";
import type { Navigate } from "../navigation";
import { Notice, Switch } from "../ui";
import { parseGrants, grantStateChip, grantUsable, type ClaudeGrantSummary } from "./ClaudeProfiles";

type ProviderModel = { provider: string; model: string };
type MixAgent = ProviderModel & { notes?: string; tasks?: string[]; difficulty?: string[]; role?: string };
type PanelWebSearch = { enabled?: boolean; maxSearchesPerPanel?: number; maxTotalSearches?: number; timeoutMs?: number; tiers?: string[] };
type Multiround = { enabled?: boolean; maxRounds?: number; branchFactor?: number; budgetCalls?: number };
type Fusion = { judge?: ProviderModel; synthesizer?: ProviderModel; contextMode?: "task" | "full"; judgeContextMode?: "task" | "full"; panelWebSearch?: PanelWebSearch; multiround?: Multiround; panel?: ProviderModel[] };
type ModelMixingConfig = { enabled?: boolean; aliasId?: string; combine?: string; mode?: string; coordinator?: ProviderModel; guidance?: string; agents?: MixAgent[]; fusion?: Fusion; stageTimeoutMs?: number; panelTimeoutMs?: number };
type ProviderAuthMode = "key" | "forward" | "oauth" | "none";
type ProviderOption = { name: string; defaultModel: string; models: string[]; authMode?: ProviderAuthMode | "claude-grant"; adapter?: string; claudeGrantId?: string };
type Preset = { id: string; label: string; description: string; modelMixing: ModelMixingConfig; callPlan: { calls: number; searchCalls: number } };
type Evidence = { candidate: string; baseline: string; candidateLabel: string; baselineLabel: string; qualityDelta: number; qualityDeltaCi95: readonly [number, number]; latencyWallClockMs: { p50: number; p95: number } };
type CatalogAlias = { aliasId: string; namespaced: boolean; provider: string; id: string; exposed: boolean; disabled: boolean; hiddenPolicy: "alias-id-specific" };
type Settings = { modelMixing: ModelMixingConfig; providers: ProviderOption[]; catalogAlias: CatalogAlias; presets: Preset[]; evidence: Evidence; warnings?: string[] };
type CallPlan = { mode: string; calls: number; searchCalls: number; detail: string };
type CallPlanResponse = { ok: boolean; plan: CallPlan; warnings?: string[] };
type NoticeState = { tone: "ok" | "err"; text: string } | null;
export type SettingsLoadFailureKind = "old-server" | "network" | "http" | "timeout";
export type SettingsLoadFailure = { kind: SettingsLoadFailureKind; status?: number; detail?: string };

export class ModelMixingSettingsLoadError extends Error {
  readonly kind: SettingsLoadFailureKind;
  readonly status?: number;
  readonly detail?: string;

  constructor(failure: SettingsLoadFailure) {
    super(failure.detail ?? failure.kind);
    this.name = "ModelMixingSettingsLoadError";
    this.kind = failure.kind;
    this.status = failure.status;
    this.detail = failure.detail;
  }
}

const LOAD_FAILURE_KEYS: Record<SettingsLoadFailureKind, TKey> = {
  "old-server": "mix.loadFailedOldServer",
  network: "mix.loadFailedNetwork",
  http: "mix.loadFailedHttp",
  timeout: "mix.loadFailedTimeout",
};

type Patch = Partial<ModelMixingConfig>;

const blankModel = (providers: ProviderOption[]): ProviderModel => ({ provider: providers[0]?.name ?? "", model: providers[0]?.models[0] ?? providers[0]?.defaultModel ?? "" });
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function defaultFusion(mm: ModelMixingConfig): Fusion { return mm.fusion ?? {}; }
function defaultWeb(mm: ModelMixingConfig): PanelWebSearch { return defaultFusion(mm).panelWebSearch ?? {}; }
function defaultMulti(mm: ModelMixingConfig): Multiround { return defaultFusion(mm).multiround ?? {}; }

function modelKey(model: ProviderModel) { return `${model.provider}/${model.model}`; }
const AUTH_LABEL_KEYS: Record<ProviderAuthMode, TKey> = {
  key: "mix.auth.key",
  forward: "mix.auth.forward",
  oauth: "mix.auth.oauth",
  none: "mix.auth.none",
};

function providerAuthMode(provider?: ProviderOption): ProviderAuthMode | "claude-grant" {
  return provider?.authMode ?? "none";
}

function providerAuthLabel(t: TFn, provider?: ProviderOption): string {
  const mode = providerAuthMode(provider);
  if (mode === "claude-grant") return t("mix.auth.grant");
  return t(AUTH_LABEL_KEYS[mode]);
}

function providerOptionLabel(t: TFn, provider: ProviderOption): string {
  return `${provider.name} · ${providerAuthLabel(t, provider)}`;
}

function providerAuthBadgeClass(provider?: ProviderOption): string {
  const mode = providerAuthMode(provider);
  if (mode === "forward") return "badge-amber";
  if (mode === "oauth" || mode === "key") return "badge-green";
  return "badge-muted";
}

// Readiness for a single mix-member provider. A grant binding is detected via the grant list's
// boundProviders OR the provider's own authMode/claudeGrantId, then OAuth/forward/key.
export type MixMemberKind = "grant" | "oauth" | "forward" | "key" | "unknown";
export interface MixMemberReadiness {
  provider: string;
  kind: MixMemberKind;
  label: string;
  needsAttention: boolean;
  blocking: boolean;
  cls: string;
}

export function mixMemberReadiness(providerName: string, provider: ProviderOption | undefined, grants: ClaudeGrantSummary[], t?: TFn): MixMemberReadiness {
  // Consistent whether the binding is encoded on the grant (boundProviders) or on the provider
  // (authMode: "claude-grant" + claudeGrantId).
  const grant = grants.find(g => g.boundProviders.includes(providerName))
    ?? (provider?.claudeGrantId ? grants.find(g => g.id === provider.claudeGrantId) : undefined);
  if (grant) {
    const usable = grantUsable(grant);
    return {
      provider: providerName,
      kind: "grant",
      label: t ? t("mix.readiness.grant", { label: grant.label, state: grantStateChip(grant.state, t).label }) : `Claude grant · ${grant.label} · ${grantStateChip(grant.state).label}`,
      needsAttention: !usable,
      blocking: !usable,
      cls: usable ? "badge-green" : "badge-amber",
    };
  }
  // Bound to a claude grant whose record is missing from the current list (removed/dangling, or the
  // grant API is unavailable). Surface it as a blocking grant member rather than "unknown".
  if (provider?.authMode === "claude-grant" || provider?.claudeGrantId) {
    return { provider: providerName, kind: "grant", label: t ? t("mix.readiness.grantUnavailable") : "Claude grant · binding unavailable", needsAttention: true, blocking: true, cls: "badge-amber" };
  }
  const mode = provider?.authMode;
  if (mode === "oauth") return { provider: providerName, kind: "oauth", label: t ? t("mix.readiness.oauth") : "OAuth login required", needsAttention: true, blocking: false, cls: "badge-amber" };
  if (mode === "forward") return { provider: providerName, kind: "forward", label: t ? t("mix.readiness.forward") : "Needs live client auth", needsAttention: true, blocking: false, cls: "badge-amber" };
  if (mode === "key") return { provider: providerName, kind: "key", label: t ? t("mix.readiness.key") : "API key", needsAttention: false, blocking: false, cls: "badge-green" };
  if (!provider) return { provider: providerName, kind: "unknown", label: t ? t("mix.readiness.unknown") : "Unknown provider", needsAttention: true, blocking: false, cls: "badge-muted" };
  return { provider: providerName, kind: "unknown", label: t ? t("mix.readiness.notConfigured") : "Not configured", needsAttention: true, blocking: false, cls: "badge-muted" };
}

function providerModels(providers: ProviderOption[], providerName: string, current?: string): string[] {
  const provider = providers.find(p => p.name === providerName);
  const values = new Set<string>();
  if (current) values.add(current);
  if (provider?.defaultModel) values.add(provider.defaultModel);
  for (const model of provider?.models ?? []) values.add(model);
  return [...values];
}
function allProviderModels(providers: ProviderOption[], current?: ProviderModel): ProviderModel[] {
  const out = new Map<string, ProviderModel>();
  if (current?.provider && current.model) out.set(modelKey(current), current);
  for (const provider of providers) {
    for (const model of providerModels(providers, provider.name)) out.set(`${provider.name}/${model}`, { provider: provider.name, model });
  }
  return [...out.values()];
}
function selectedModel(value: ProviderModel | undefined, providers: ProviderOption[]): ProviderModel {
  return value?.provider && value.model ? value : blankModel(providers);
}

function normalizeSettingsLoadFailure(error: unknown): SettingsLoadFailure {
  if (error instanceof ModelMixingSettingsLoadError) {
    return { kind: error.kind, status: error.status, detail: error.detail };
  }
  return { kind: "network" };
}

function settingsLoadFailureText(t: TFn, failure: SettingsLoadFailure): string {
  return t(LOAD_FAILURE_KEYS[failure.kind], {
    status: failure.status ?? "unknown",
    detail: failure.detail ? `: ${failure.detail}` : "",
    cmd: "frogp refresh",
  });
}

export async function fetchModelMixingSettings(url: string, timeoutMs = 5000): Promise<Settings> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json() as { error?: unknown; message?: unknown };
        detail = typeof body.error === "string"
          ? body.error
          : typeof body.message === "string"
            ? body.message
            : "";
      } catch {
        // Ignore unparseable error bodies; the HTTP status is still useful.
      }
      throw new ModelMixingSettingsLoadError({
        kind: res.status === 404 ? "old-server" : "http",
        status: res.status,
        detail,
      });
    }
    return await res.json() as Settings;
  } catch (error) {
    if (error instanceof ModelMixingSettingsLoadError) throw error;
    if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
      throw new ModelMixingSettingsLoadError({ kind: "timeout" });
    }
    throw new ModelMixingSettingsLoadError({ kind: "network" });
  } finally {
    globalThis.clearTimeout(timer);
  }
}
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function CommitNumberInput({ value, disabled, onCommit }: { value: number | undefined; disabled: boolean; onCommit: (value: number) => void }) {
  const normalized = value ?? 0;
  const [draft, setDraft] = useState(String(normalized));

  useEffect(() => {
    setDraft(String(normalized));
  }, [normalized]);

  const commit = () => {
    const next = Number(draft);
    if (!Number.isFinite(next)) {
      setDraft(String(normalized));
      return;
    }
    if (next !== normalized) onCommit(next);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(String(normalized));
      e.currentTarget.blur();
    }
  };

  return (
    <input
      className="input"
      type="number"
      value={draft}
      disabled={disabled}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
    />
  );
}

function CommitTextInput({ value, disabled, placeholder, ariaLabel, onCommit }: { value: string; disabled: boolean; placeholder?: string; ariaLabel?: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(value);
      e.currentTarget.blur();
    }
  };

  return (
    <input
      className="input"
      type="text"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
    />
  );
}
function changedPresetAreas(current: ModelMixingConfig, preset: ModelMixingConfig): string[] {
  const areas: string[] = [];
  if (hasValue(current.agents) && !sameJson(current.agents, preset.agents ?? [])) areas.push("roster");
  if (hasValue(current.fusion?.judge) && !sameJson(current.fusion?.judge, preset.fusion?.judge)) areas.push("judge");
  if (hasValue(current.fusion?.synthesizer) && !sameJson(current.fusion?.synthesizer, preset.fusion?.synthesizer)) areas.push("synthesizer");
  if ((hasValue(current.fusion?.contextMode) && !sameJson(current.fusion?.contextMode, preset.fusion?.contextMode)) || (hasValue(current.fusion?.judgeContextMode) && !sameJson(current.fusion?.judgeContextMode, preset.fusion?.judgeContextMode))) areas.push("context");
  if (hasValue(current.fusion?.panelWebSearch) && !sameJson(current.fusion?.panelWebSearch, preset.fusion?.panelWebSearch)) areas.push("panel web-search");
  if (hasValue(current.fusion?.multiround) && !sameJson(current.fusion?.multiround, preset.fusion?.multiround)) areas.push("multiround");
  if ((hasValue(current.stageTimeoutMs) && !sameJson(current.stageTimeoutMs, preset.stageTimeoutMs)) || (hasValue(current.panelTimeoutMs) && !sameJson(current.panelTimeoutMs, preset.panelTimeoutMs))) areas.push("timeouts");
  return areas;
}

const PRESET_TEXT: Record<string, { label: TKey; desc: TKey }> = {
  low: { label: "mix.preset.low.label", desc: "mix.preset.low.desc" },
  balanced: { label: "mix.preset.balanced.label", desc: "mix.preset.balanced.desc" },
  research: { label: "mix.preset.research.label", desc: "mix.preset.research.desc" },
};
const presetLabel = (t: TFn, preset: Preset) => PRESET_TEXT[preset.id] ? t(PRESET_TEXT[preset.id].label) : preset.label;
const presetDescription = (t: TFn, preset: Preset) => PRESET_TEXT[preset.id] ? t(PRESET_TEXT[preset.id].desc) : preset.description;

const DOCS_PREFIX: Record<string, string> = { en: "", ko: "ko/", zh: "zh-cn/" };
const mixingDocsUrl = (locale: string) => `https://zhsks311.github.io/frog-progsy/${DOCS_PREFIX[locale] ?? ""}guides/model-mixing/`;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${url}`);
  return await res.json() as T;
}

export default function ModelMixing({ apiBase, navigate, initialSettings, initialPlan, initialLoadFailure, initialGrants }: { apiBase: string; navigate: Navigate; initialSettings?: Settings; initialPlan?: CallPlan; initialLoadFailure?: SettingsLoadFailure; initialGrants?: ClaudeGrantSummary[] }) {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(initialSettings ?? null);
  const [plan, setPlan] = useState<CallPlan | null>(initialPlan ?? null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!initialSettings && !initialLoadFailure);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loadFailure, setLoadFailure] = useState<SettingsLoadFailure | null>(initialSettings ? null : initialLoadFailure ?? null);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const [grants, setGrants] = useState<ClaudeGrantSummary[]>(initialGrants ?? []);

  // Fail-closed: a grant API failure just empties the readiness strip; the page keeps working.
  useEffect(() => {
    if (initialGrants) return;
    let cancelled = false;
    fetch(`${apiBase}/api/claude-grants`)
      .then(res => { if (!res.ok) throw new Error("grants load failed"); return res.json(); })
      .then(data => { if (!cancelled) setGrants(parseGrants(data).grants); })
      .catch(() => { if (!cancelled) setGrants([]); });
    return () => { cancelled = true; };
  }, [apiBase, initialGrants]);

  const loadSettings = async () => fetchModelMixingSettings(`${apiBase}/api/model-mixing-settings`);

  useEffect(() => {
    if (initialSettings || initialLoadFailure) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailure(null);
    loadSettings()
      .then(data => {
        if (!cancelled) {
          setSettings(data);
          setLoadFailure(null);
        }
      })
      .catch(error => {
        if (!cancelled) setLoadFailure(normalizeSettingsLoadFailure(error));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiBase, initialSettings, initialLoadFailure]);

  const retrySettingsLoad = () => {
    setLoading(true);
    setNotice(null);
    setLoadFailure(null);
    loadSettings()
      .then(data => {
        setSettings(data);
        setLoadFailure(null);
      })
      .catch(error => {
        setLoadFailure(normalizeSettingsLoadFailure(error));
      })
      .finally(() => setLoading(false));
  };

  const draftPatch = useMemo(() => settings ? {
    combine: settings.modelMixing.combine,
    agents: settings.modelMixing.agents ?? [],
    fusion: settings.modelMixing.fusion ?? {},
    stageTimeoutMs: settings.modelMixing.stageTimeoutMs,
    panelTimeoutMs: settings.modelMixing.panelTimeoutMs,
  } : null, [settings]);

  useEffect(() => {
    if (!draftPatch || initialPlan) return;
    let cancelled = false;
    const timeout = setTimeout(() => {
      const query = encodeURIComponent(JSON.stringify(draftPatch));
      fetchJson<CallPlanResponse>(`${apiBase}/api/model-mixing/call-plan?draft=${query}`)
        .then(data => { if (!cancelled) setPlan(data.plan); })
        .catch(() => { if (!cancelled) setPlan(null); });
    }, 500);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [apiBase, draftPatch, initialPlan]);

  const savePatch = async (patch: Patch, successText = t("mix.saved"), refreshModels = false) => {
    if (!settings || saving) return false;
    const previous = settings;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/model-mixing-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelMixing: patch }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json() as Settings & { ok?: boolean; warnings?: string[] };
      setSettings(data);
      if (refreshModels) await fetch(`${apiBase}/api/models`).catch(() => undefined);
      setNotice({ tone: data.warnings?.length ? "err" : "ok", text: data.warnings?.length ? `${successText} ${data.warnings.join("; ")}` : successText });
      return true;
    } catch {
      setSettings(previous);
      setNotice({ tone: "err", text: t("mix.saveFailed") });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const updateLocal = (patch: Patch) => setSettings(current => current ? { ...current, modelMixing: { ...current.modelMixing, ...patch, fusion: patch.fusion ? { ...(current.modelMixing.fusion ?? {}), ...patch.fusion } : current.modelMixing.fusion } } : current);
  const saveFusionPatch = (fusion: Fusion) => savePatch({ fusion });
  const applyPreset = (preset: Preset) => {
    if (!settings) return;
    const areas = changedPresetAreas(settings.modelMixing, preset.modelMixing);
    if (areas.length > 0 && !window.confirm(t("mix.presetOverwriteConfirm", { areas: areas.join(", ") }))) return;
    void savePatch(preset.modelMixing, t("mix.presetApplied", { name: presetLabel(t, preset) }));
  };
  const toggleEnabled = (next: boolean) => {
    if (!settings) return;
    if (next) {
      const p = plan;
      const msg = t("mix.enableConfirm", { calls: p?.calls ?? 0, searchCalls: p?.searchCalls ?? 0, detail: p?.detail ?? "—" });
      if (!window.confirm(msg)) return;
    }
    void savePatch({ enabled: next }, next ? t("mix.enabledSaved") : t("mix.disabledSaved"), true);
  };

  if (loading) return <><div className="page-head"><h2>{t("nav.modelMixing")}</h2></div><div className="empty">{t("common.loading")}</div></>;
  if (!settings) return (
    <>
      <div className="page-head"><h2>{t("nav.modelMixing")}</h2></div>
      <p className="page-sub">{t("mix.subtitle")}</p>
      <Notice tone="err">
        {loadFailure ? settingsLoadFailureText(t, loadFailure) : t("mix.loadFailed")}
        <button type="button" className="link-btn" onClick={retrySettingsLoad} style={{ marginLeft: 8 }}>{t("mix.loadRetry")}</button>
      </Notice>
    </>
  );

  const mm = settings.modelMixing;
  const fusion = defaultFusion(mm);
  const web = defaultWeb(mm);
  const multi = defaultMulti(mm);
  const roster = mm.agents ?? [];
  const combine = mm.combine === "fusion" ? "fusion" : "route";
  const coordinator = selectedModel(mm.coordinator, settings.providers);
  const judge = selectedModel(fusion.judge, settings.providers);
  const synth = selectedModel(fusion.synthesizer, settings.providers);
  const providerByName = new Map(settings.providers.map(provider => [provider.name, provider]));
  const hasForwardProviders = settings.providers.some(provider => providerAuthMode(provider) === "forward");
  const selectedForwardCount = roster.filter(row => providerAuthMode(providerByName.get(row.provider)) === "forward").length;

  // Distinct providers the enabled mix would call: roster + the active combine's coordinator/judge/synth.
  const memberProviderNames = (() => {
    const names = new Set<string>();
    for (const row of roster) if (row.provider) names.add(row.provider);
    if (combine === "route") { if (coordinator.provider) names.add(coordinator.provider); }
    else { if (judge.provider) names.add(judge.provider); if (synth.provider) names.add(synth.provider); }
    return [...names];
  })();
  const memberReadiness = memberProviderNames.map(name => mixMemberReadiness(name, providerByName.get(name), grants, t));
  const attentionMembers = memberReadiness.filter(m => m.needsAttention);
  const blockingMembers = memberReadiness.filter(m => m.blocking);

  const setRoster = (agents: MixAgent[]) => { updateLocal({ agents }); void savePatch({ agents }); };
  const updateRoster = (index: number, patch: Partial<MixAgent>) => {
    const next = roster.map((row, i) => i === index ? { ...row, ...patch } : row);
    setRoster(next);
  };
  const addRoster = () => setRoster([...roster, blankModel(settings.providers)]);
  const removeRoster = (index: number) => setRoster(roster.filter((_, i) => i !== index));
  const selectProviderModel = (key: "judge" | "synthesizer", raw: string) => {
    const slash = raw.indexOf("/");
    const value = { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
    void saveFusionPatch({ [key]: value });
  };

  const aliasCurrent = mm.aliasId ?? settings.catalogAlias.aliasId;
  const aliasValue = aliasDraft ?? aliasCurrent;
  const aliasChanged = aliasValue.trim().length > 0 && aliasValue.trim() !== aliasCurrent;
  const saveAlias = async () => {
    const ok = await savePatch({ aliasId: aliasValue.trim() }, t("mix.aliasSaved"), true);
    if (ok) setAliasDraft(null);
  };

  return (
    <>
      <div className="page-head"><h2>{t("nav.modelMixing")}</h2></div>
      <p className="page-sub">{t("mix.subtitle")}</p>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.boundaryTitle")}</h3><span className="badge badge-amber">{t("mix.notClassifier")}</span></div>
        <ModelMixingInfo />
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.enableTitle")}</h3><span className="muted" style={{ fontSize: 12 }}>{saving ? t("prov.savingDefault") : t("mix.patchOnly")}</span></div>
        <div className="fallback-row">
          <div><div style={{ fontWeight: 650 }}>{mm.aliasId ?? settings.catalogAlias.aliasId}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.enableHint")}</div></div>
          <div className="fallback-controls"><Switch on={mm.enabled === true} onClick={() => toggleEnabled(mm.enabled !== true)} disabled={saving} label={t("mix.enableTitle")} /></div>
        </div>
        <div className="mix-call-plan">
          <span className="chip">{t("mix.calls", { n: plan?.calls ?? 0 })}</span>
          <span className="chip">{t("mix.searchCalls", { n: plan?.searchCalls ?? 0 })}</span>
          <span className="chip text-anywhere">{plan?.detail ?? "—"}</span>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.combineTitle")}</h3></div>
        <div className="fallback-row">
          <div><div style={{ fontWeight: 650 }}>{combine === "route" ? t("mix.combineRoute") : t("mix.combineFusion")}</div><div className="muted" style={{ fontSize: 13 }}>{combine === "route" ? t("mix.combineRouteHint") : t("mix.combineFusionHint")}</div></div>
          <div className="fallback-controls">
            <select className="select-sm" value={combine} disabled={saving} onChange={e => void savePatch({ combine: e.target.value })} aria-label={t("mix.combineTitle")}>
              <option value="route">{t("mix.combineRoute")}</option>
              <option value="fusion">{t("mix.combineFusion")}</option>
            </select>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.presetsTitle")}</h3><span className="muted" style={{ fontSize: 12 }}>{t("mix.presetsHint")}</span></div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{t("mix.presetsIntro")}</p>
        <div className="mix-preset-grid">
          {settings.presets.map(preset => (
            <button key={preset.id} type="button" className="list-row mix-preset-card" disabled={saving} onClick={() => applyPreset(preset)}>
              <span><strong>{presetLabel(t, preset)}</strong><small>{presetDescription(t, preset)}</small><span className="chip">{t("mix.presetCalls", { calls: preset.callPlan.calls, search: preset.callPlan.searchCalls })}</span></span>
              <span className="badge badge-accent">{t("mix.applyPreset")}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="mix-readiness-title">
        <div className="panel-head">
          <h3 className="panel-title" id="mix-readiness-title">{t("mix.readiness.title")}</h3>
          {attentionMembers.length > 0 && <span className="badge badge-amber">{t("mix.readiness.attention", { n: attentionMembers.length })}</span>}
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {t("mix.readiness.hint")}
        </p>
        {memberReadiness.length === 0
          ? <div className="empty">{t("mix.readiness.empty")}</div>
          : (
            <div className="chip-cloud">
              {memberReadiness.map(m => (
                <span key={m.provider} className="chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <span className="text-anywhere" style={{ fontWeight: 650 }}>{m.provider}</span>
                  <span className={`badge ${m.cls}`}>{m.label}</span>
                </span>
              ))}
            </div>
          )}
        {attentionMembers.some(m => !m.blocking) && (
          <Notice tone="err">
            {t("mix.readiness.requestTimeWarning")}
          </Notice>
        )}
        {blockingMembers.length > 0 && (
          <Notice tone="err">
            {t("mix.readiness.grantBlocking", { providers: blockingMembers.map(m => m.provider).join(", ") })}
          </Notice>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.rosterTitle")}</h3><button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={addRoster}>{t("mix.addRow")}</button></div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{combine === "route" ? t("mix.rosterHintRoute") : t("mix.rosterHint")}</p>
        {hasForwardProviders && (
          <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>
            <span className="badge badge-amber">{t("mix.auth.forward")}</span>{" "}
            {selectedForwardCount > 0 ? t("mix.forwardSelectedNote", { n: selectedForwardCount }) : t("mix.forwardAvailableNote")}
          </p>
        )}
        <div className="fallback-grid">
          {roster.length === 0 ? <div className="empty">{t("mix.noRoster")}</div> : roster.map((row, index) => (
            <div key={`${index}-${row.provider}-${row.model}`} className="fallback-row">
              <div className="fallback-controls" style={{ justifyContent: "flex-start" }}>
                <select className="select-sm" value={row.provider} disabled={saving} onChange={e => updateRoster(index, { provider: e.target.value, model: providerModels(settings.providers, e.target.value)[0] ?? "" })}>
                  {!settings.providers.some(p => p.name === row.provider) && <option value={row.provider}>{row.provider} ({t("mix.unknown")})</option>}
                  {settings.providers.map(provider => <option key={provider.name} value={provider.name}>{providerOptionLabel(t, provider)}</option>)}
                </select>
                <select className="select-sm" value={row.model} disabled={saving} onChange={e => updateRoster(index, { model: e.target.value })}>
                  {providerModels(settings.providers, row.provider, row.model).map(model => <option key={model} value={model}>{model}</option>)}
                </select>
                {combine === "route" && <CommitTextInput value={row.notes ?? ""} disabled={saving} placeholder={t("mix.agentNotes")} ariaLabel={t("mix.agentNotes")} onCommit={notes => updateRoster(index, { notes })} />}
              </div>
              <div className="fallback-controls">
                <span className="chip text-anywhere">{modelKey(row)}</span>
                {providerByName.has(row.provider) && <span className={`badge ${providerAuthBadgeClass(providerByName.get(row.provider))}`}>{providerAuthLabel(t, providerByName.get(row.provider))}</span>}
                <button className="btn btn-danger btn-sm" type="button" disabled={saving} onClick={() => removeRoster(index)}>{t("common.remove")}</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {combine === "route" && <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.dispatcherTitle")}</h3></div>
        <div className="fallback-grid">
          <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.dispatcher")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.dispatcherHint")}</div></div><div className="fallback-controls"><select className="select-sm" value={modelKey(coordinator)} disabled={saving} onChange={e => { const raw = e.target.value; const slash = raw.indexOf("/"); void savePatch({ coordinator: { provider: raw.slice(0, slash), model: raw.slice(slash + 1) } }); }}>{allProviderModels(settings.providers, coordinator).map(model => { const provider = providerByName.get(model.provider); return <option key={modelKey(model)} value={modelKey(model)}>{modelKey(model)} · {providerAuthLabel(t, provider)}</option>; })}</select></div></div>
          <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.guidance")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.guidanceHint")}</div></div><div className="fallback-controls"><CommitTextInput value={mm.guidance ?? ""} disabled={saving} placeholder={t("mix.guidancePlaceholder")} ariaLabel={t("mix.guidance")} onCommit={guidance => void savePatch({ guidance })} /></div></div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}><a className="link-btn" href={mixingDocsUrl(locale)} target="_blank" rel="noreferrer">{t("mix.docsLink")}</a></p>
      </section>}

      {combine === "fusion" && <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.judgeSynthTitle")}</h3></div>
        <div className="fallback-grid">
          <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.judge")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.judgeHint")}</div></div><div className="fallback-controls"><select className="select-sm" value={modelKey(judge)} disabled={saving} onChange={e => selectProviderModel("judge", e.target.value)}>{allProviderModels(settings.providers, judge).map(model => { const provider = providerByName.get(model.provider); return <option key={modelKey(model)} value={modelKey(model)}>{modelKey(model)} · {providerAuthLabel(t, provider)}</option>; })}</select></div></div>
          <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.synth")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.synthHint")}</div></div><div className="fallback-controls"><select className="select-sm" value={modelKey(synth)} disabled={saving} onChange={e => selectProviderModel("synthesizer", e.target.value)}>{allProviderModels(settings.providers, synth).map(model => { const provider = providerByName.get(model.provider); return <option key={modelKey(model)} value={modelKey(model)}>{modelKey(model)} · {providerAuthLabel(t, provider)}</option>; })}</select></div></div>
        </div>
      </section>}

      {combine === "fusion" && <section className="panel" style={{ marginTop: 16 }}>
        <details className="setup-guide" open>
          <summary>{t("mix.advancedTitle")}</summary>
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{t("mix.advancedHint")}</p>
          <div className="fallback-grid" style={{ marginTop: 12 }}>
            <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.contextMode")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.contextModeHint")}</div></div><div className="fallback-controls"><select className="select-sm" value={fusion.contextMode ?? "task"} disabled={saving} onChange={e => void saveFusionPatch({ contextMode: e.target.value as "task" | "full" })}><option value="task">{t("mix.ctxTask")}</option><option value="full">{t("mix.ctxFull")}</option></select></div></div>
            <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.judgeContextMode")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.judgeContextModeHint")}</div></div><div className="fallback-controls"><select className="select-sm" value={fusion.judgeContextMode ?? "task"} disabled={saving} onChange={e => void saveFusionPatch({ judgeContextMode: e.target.value as "task" | "full" })}><option value="task">{t("mix.ctxTask")}</option><option value="full">{t("mix.ctxFull")}</option></select></div></div>
            <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.panelWebSearch")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.panelWebSearchHint")}</div></div><div className="fallback-controls"><Switch on={web.enabled === true} disabled={saving} onClick={() => void saveFusionPatch({ panelWebSearch: { enabled: web.enabled !== true } })} label={t("mix.panelWebSearch")} /></div></div>
            <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.webCaps")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.webCapsHint")}</div></div><div className="fallback-controls"><label className="mix-num-field"><span>{t("mix.webCapPerPanel")}</span><CommitNumberInput value={web.maxSearchesPerPanel} disabled={saving} onCommit={value => void saveFusionPatch({ panelWebSearch: { maxSearchesPerPanel: value } })} /></label><label className="mix-num-field"><span>{t("mix.webCapTotal")}</span><CommitNumberInput value={web.maxTotalSearches} disabled={saving} onCommit={value => void saveFusionPatch({ panelWebSearch: { maxTotalSearches: value } })} /></label></div></div>
            <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.multiround")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.multiroundHint")}</div></div><div className="fallback-controls"><Switch on={multi.enabled === true} disabled={saving} onClick={() => void saveFusionPatch({ multiround: { enabled: multi.enabled !== true } })} label={t("mix.multiround")} /></div></div>
            <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.multiroundBudget")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.multiroundBudgetHint")}</div></div><div className="fallback-controls"><label className="mix-num-field"><span>{t("mix.mrRounds")}</span><CommitNumberInput value={multi.maxRounds} disabled={saving} onCommit={value => void saveFusionPatch({ multiround: { maxRounds: value } })} /></label><label className="mix-num-field"><span>{t("mix.mrBranch")}</span><CommitNumberInput value={multi.branchFactor} disabled={saving} onCommit={value => void saveFusionPatch({ multiround: { branchFactor: value } })} /></label><label className="mix-num-field"><span>{t("mix.mrBudget")}</span><CommitNumberInput value={multi.budgetCalls} disabled={saving} onCommit={value => void saveFusionPatch({ multiround: { budgetCalls: value } })} /></label></div></div>
            <div className="fallback-row"><div><div style={{ fontWeight: 650 }}>{t("mix.timeouts")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.timeoutsHint")}</div></div><div className="fallback-controls"><label className="mix-num-field"><span>{t("mix.timeoutStage")}</span><CommitNumberInput value={mm.stageTimeoutMs} disabled={saving} onCommit={value => void savePatch({ stageTimeoutMs: value })} /></label><label className="mix-num-field"><span>{t("mix.timeoutPanel")}</span><CommitNumberInput value={mm.panelTimeoutMs} disabled={saving} onCommit={value => void savePatch({ panelTimeoutMs: value })} /></label></div></div>
          </div>
          <p className="muted" style={{ fontSize: 12 }}><a className="link-btn" href={mixingDocsUrl(locale)} target="_blank" rel="noreferrer">{t("mix.docsLink")}</a></p>
        </details>
      </section>}

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h3 className="panel-title">{t("mix.aliasTitle")}</h3><span className={`badge ${settings.catalogAlias.exposed ? "badge-green" : "badge-muted"}`}>{settings.catalogAlias.exposed ? t("mix.aliasExposed") : t("mix.aliasHidden")}</span></div>
        <div className="fallback-row">
          <div><div style={{ fontWeight: 650 }}>{t("mix.aliasId")}</div><div className="muted" style={{ fontSize: 13 }}>{t("mix.aliasNamespaceHint")}</div></div>
          <div className="fallback-controls">
            <input className="input" value={aliasValue} disabled={saving} onChange={e => setAliasDraft(e.target.value)} aria-label={t("mix.aliasId")} />
            <button className="btn btn-sm" type="button" disabled={saving || !aliasChanged} onClick={() => void saveAlias()}>{t("mix.aliasSave")}</button>
          </div>
        </div>
        <div className="mini-list">
          <div><span>{t("mix.aliasVisibility")}</span><code>{settings.catalogAlias.disabled ? t("models.hiddenBadge") : t("models.visibleBadge")}</code></div>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>{t("mix.aliasPolicyText")}</p>
        <button className="link-btn" type="button" onClick={() => navigate("models", "model-visibility-row")}>{t("mix.openModelPicker")}</button>
      </section>
    </>
  );
}
