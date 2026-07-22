import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconX, IconLock, IconKey, IconExternal, IconSearch } from "../icons";
import { useT, type TFn, type TKey } from "../i18n";

export interface ProviderConfig {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  apiKeys?: string[];
  defaultModel?: string;
  authMode?: "key" | "forward" | "oauth";
}

interface Preset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  /** "oauth": real account login · "forward": upstream header forwarding · "key": API key. */
  auth: "oauth" | "forward" | "key";
  /** OAuth registry id (for auth === "oauth"). */
  oauthProvider?: string;
  /** Where to create/copy the API key (for auth === "key" catalog providers). */
  dashboardUrl?: string;
  note?: string;
}

const FALLBACK_PRESETS: Preset[] = [
  { id: "custom", label: "Custom provider", adapter: "openai-chat", baseUrl: "", auth: "key" },
];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

interface FormState {
  name: string;
  adapter: string;
  baseUrl: string;
  authMode: "key" | "forward" | "oauth";
  apiKey: string;
  extraApiKeys: string;
  defaultModel: string;
  claudeHome: string;
  setDefault: boolean;
}

type ProviderTestStatus = "ok" | "error" | "skipped";
interface ProviderTestState {
  status: ProviderTestStatus;
  message: string;
  code?: string;
  modelCount?: number;
}

export function parseExtraApiKeys(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(v => v.trim())
    .filter(Boolean);
}

export function sanitizeVisibleText(value: unknown, secrets: string[], fallback: string): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  let safe = text;
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[redacted]");
  }
  return safe;
}

function authBadgeLabel(auth: Preset["auth"], t: TFn): string {
  if (auth === "oauth") return t("modal.auth.oauth");
  if (auth === "forward") return t("modal.auth.forward");
  return t("modal.auth.key");
}

function authBadgeClass(auth: Preset["auth"]): string {
  if (auth === "oauth") return "badge-accent";
  if (auth === "forward") return "badge-amber";
  return "badge-muted";
}

function nextProviderName(base: string, existingNames: string[]): string {
  if (!existingNames.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existingNames.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function usesClaudeCodeAuth(preset: Preset | null, form: FormState | null): boolean {
  return preset?.id === "anthropic" && form?.adapter === "anthropic" && form.authMode === "forward";
}

const PRESET_NOTE_KEYS: Record<string, TKey> = {
  anthropic: "modal.anthropicClaudeCodeNotice",
  ollama: "modal.note.localKeyBlank",
  vllm: "modal.note.localKeyBlank",
  "lm-studio": "modal.note.localNoKey",
  "opencode-go": "modal.note.opencodeGo",
};

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const t = useT();
  const [oauthMsgTone, setOauthMsgTone] = useState<"info" | "warn">("info");
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [initialForm, setInitialForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [oauthSupported, setOauthSupported] = useState<string[]>([]);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthMsg, setOauthMsg] = useState("");
  const [presets, setPresets] = useState<Preset[]>(FALLBACK_PRESETS);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<ProviderTestState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const aliveRef = useRef(true);

  const isDirty = form !== null && initialForm !== null && JSON.stringify(form) !== JSON.stringify(initialForm);
  const confirmDiscard = useCallback(() => !isDirty || window.confirm(t("modal.discardConfirm")), [isDirty, t]);
  const close = useCallback(() => {
    if (confirmDiscard()) onClose();
  }, [confirmDiscard, onClose]);

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => () => { aliveRef.current = false; }, []); // stop the OAuth poll if the modal unmounts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
        .filter(el => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (cardRef.current && !cardRef.current.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  useEffect(() => {
    fetch(`${apiBase}/api/oauth/providers`).then(r => r.json()).then(d => setOauthSupported(d.providers ?? [])).catch(() => {});
  }, [apiBase]);
  useEffect(() => {
    fetch(`${apiBase}/api/provider-presets`).then(r => r.json()).then((d: { providers?: Preset[] }) => {
      if (Array.isArray(d.providers) && d.providers.length > 0) setPresets(d.providers);
    }).catch(() => {});
  }, [apiBase]);
  const presetLabel = (p: Preset) => p.id === "custom" ? t("modal.customProvider") : p.label;
  const presetNote = (p: Preset) => {
    if (p.auth === "oauth") return t("modal.oauthNote");
    const noteKey = PRESET_NOTE_KEYS[p.id];
    return noteKey ? t(noteKey) : "";
  };
  const setOAuthMessage = (message: string, tone: "info" | "warn" = "info") => {
    setOauthMsg(message);
    setOauthMsgTone(tone);
  };


  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    // Match by visible provider name/id — not adapter, since most share "openai-chat" and would all match.
    return presets.filter(p => presetLabel(p).toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [query, presets, t]);

  const choosePreset = (p: Preset) => {
    const usesClaudeHome = p.id === "anthropic";
    const nextForm = {
      name: p.id === "custom" ? "" : usesClaudeHome ? nextProviderName(p.id, existingNames) : p.id,
      adapter: p.adapter,
      baseUrl: p.baseUrl,
      authMode: usesClaudeHome ? "forward" as const : p.auth,
      apiKey: "",
      extraApiKeys: "",
      defaultModel: p.defaultModel ?? "",
      claudeHome: usesClaudeHome ? "~/.claude" : "",
      setDefault: existingNames.length === 0,
    };
    setPreset(p);
    setForm(nextForm);
    setInitialForm(nextForm);
    setError(""); setOAuthMessage(""); setTestState(null);
  };

  const buildProvider = (f: FormState): ProviderConfig => {
    const provider: ProviderConfig = { adapter: f.adapter.trim(), baseUrl: f.baseUrl.trim() };
    if (f.authMode === "forward") provider.authMode = "forward";
    else {
      const primaryKey = f.apiKey.trim();
      const extraKeys = parseExtraApiKeys(f.extraApiKeys);
      if (primaryKey) provider.apiKey = primaryKey;
      if (extraKeys.length > 0) provider.apiKeys = extraKeys;
    }
    if (f.defaultModel.trim()) provider.defaultModel = f.defaultModel.trim();
    return provider;
  };

  const testDraftProvider = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { setError(t("modal.nameRequired")); return; }
    if (!form.baseUrl.trim()) { setError(t("modal.baseUrlRequired")); return; }
    if (usesClaudeCodeAuth(preset, form) && !form.claudeHome.trim()) { setError(t("modal.claudeHomeRequired")); return; }
    if (usesClaudeCodeAuth(preset, form)) {
      setTestState({ status: "skipped", message: t("modal.anthropicClaudeCodeTestSkipped") });
      return;
    }
    const provider = buildProvider(form);
    const secrets = [form.apiKey.trim(), ...parseExtraApiKeys(form.extraApiKeys)].filter(Boolean);
    setTesting(true);
    setError("");
    setTestState(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, provider }),
      });
      const data = await res.json().catch(() => ({}));
      const status: ProviderTestStatus = data?.status === "skipped" ? "skipped" : data?.ok ? "ok" : "error";
      const fallback = res.ok ? t("prov.test.completed") : t("prov.test.failedStatus", { status: res.status });
      setTestState({
        status,
        message: sanitizeVisibleText(data?.message ?? data?.error, secrets, fallback),
        code: typeof data?.code === "string" ? sanitizeVisibleText(data.code, secrets, "") : undefined,
        modelCount: typeof data?.modelCount === "number" ? data.modelCount : undefined,
      });
    } catch {
      setTestState({ status: "error", message: t("modal.networkError") });
    } finally {
      if (aliveRef.current) setTesting(false);
    }
  };

  const back = () => {
    if (!confirmDiscard()) return;
    setPreset(null); setForm(null); setInitialForm(null); setError(""); setOAuthMessage("");
  };

  const submit = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { setError(t("modal.nameRequired")); return; }
    if (!form.baseUrl.trim()) { setError(t("modal.baseUrlRequired")); return; }
    if (usesClaudeCodeAuth(preset, form) && !form.claudeHome.trim()) { setError(t("modal.claudeHomeRequired")); return; }
    const provider = buildProvider(form);
    const secrets = [form.apiKey.trim(), ...parseExtraApiKeys(form.extraApiKeys)].filter(Boolean);

    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          provider,
          setDefault: form.setDefault,
          catalogId: preset?.id === "custom" ? undefined : preset?.id,
          claudeHome: usesClaudeCodeAuth(preset, form) ? form.claudeHome.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(sanitizeVisibleText(data.error, secrets, t("modal.failedStatus", { status: res.status })));
        return;
      }
      onAdded(name);
    } catch {
      setError(t("modal.networkError"));
    } finally {
      setSaving(false);
    }
  };

  // Real OAuth login: open the provider's auth page in a new tab, poll until the proxy stores the token.
  const loginOAuth = async (providerId: string) => {
    setOauthBusy(true);
    setOAuthMessage("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!aliveRef.current) return;
      if (!res.ok) {
        setOAuthMessage(data.error === "unknown oauth provider"
          ? t("modal.oauthUnsupported", { label: preset ? presetLabel(preset) : providerId })
          : t("modal.loginFailStart"), "warn");
        return;
      }
      // A non-empty url = browser/device flow (the server also opens it). An EMPTY url with a 200 =
      // a local-token import that needs no browser — just poll status until the credential lands.
      // Don't treat empty url as a failure.
      if (data.url) { window.open(data.url, "_blank"); setOAuthMessage(t("modal.waitingLogin")); }
      else { setOAuthMessage(t("modal.loggingIn")); }
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (!aliveRef.current) return; // modal closed → stop polling, don't fire onAdded
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}`).then(r => r.json()).catch(() => null);
        if (!aliveRef.current) return;
        if (s?.loggedIn) { onAdded(providerId); return; }
        if (s?.error) { setOAuthMessage(t("modal.loginFailStart"), "warn"); return; }
      }
      setOAuthMessage(t("modal.loginTimeout"), "warn");
    } catch {
      if (aliveRef.current) setOAuthMessage(t("modal.networkError"), "warn");
    } finally {
      if (aliveRef.current) setOauthBusy(false);
    }
  };

  const dup = form ? existingNames.includes(form.name.trim()) && form.name.trim() !== "" : false;
  const isCustom = preset?.id === "custom";
  const selectedPresetLabel = preset ? presetLabel(preset) : "";
  const selectedPresetNote = preset ? presetNote(preset) : "";

  return (
    <div role="dialog" aria-modal="true" aria-label={t("modal.title")} className="modal-overlay" onClick={close}>
      <div ref={cardRef} className="modal-card provider-modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head provider-modal-head">
          <div>
            <h3>{preset ? t("modal.connectNamed", { label: selectedPresetLabel }) : t("modal.title")}</h3>
            {!preset && <p>{t("modal.subtitle")}</p>}
          </div>
          <button className="btn btn-ghost btn-icon modal-close" aria-label={t("common.cancel")} onClick={close}><IconX /></button>
        </div>

        {!preset ? (
          <>
            <div className="provider-search">
              <IconSearch />
              <input
                ref={searchRef}
                className="input"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t("modal.search")}
              />
            </div>
            <div className="preset-list">
              {filtered.map(p => (
                <button key={p.id} className="preset-row" onClick={() => choosePreset(p)}>
                  <span className="preset-avatar">{presetLabel(p).slice(0, 1).toUpperCase()}</span>
                  <span className="preset-main">
                    <span className="preset-title">{presetLabel(p)}</span>
                    <span className="preset-sub"><code className="chip">{p.adapter}</code>{presetNote(p) ? ` · ${presetNote(p)}` : ""}</span>
                  </span>
                  <span className={`badge ${authBadgeClass(p.auth)}`}>{authBadgeLabel(p.auth, t)}</span>
                </button>
              ))}
              {filtered.length === 0 && <div className="empty preset-empty">{t("modal.noMatch")}</div>}
            </div>
          </>
        ) : form && (
          preset.auth === "oauth" && form.authMode === "oauth" ? (
            // OAuth login pane
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="muted" style={{ fontSize: 13 }}>{selectedPresetNote || t("modal.oauthNote")}</div>
              {oauthSupported.includes(preset.oauthProvider ?? "") ? (
                <button className="btn btn-primary" onClick={() => loginOAuth(preset.oauthProvider!)} disabled={oauthBusy}
                  style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>
                  <IconLock />{oauthBusy ? t("modal.waitingBrowser") : t("modal.logInWith", { label: selectedPresetLabel })}
                </button>
              ) : (
                <div style={{ fontSize: 13, color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
                  {t("modal.oauthUnsupported", { label: selectedPresetLabel })}
                </div>
              )}
              {oauthMsg && <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: oauthMsgTone === "warn" ? "var(--amber)" : "var(--accent-hover)" }}>{oauthMsg}</div>}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                <button className="link-btn" onClick={() => { setForm({ ...form, authMode: "key" }); setOAuthMessage(""); }}>{t("modal.useApiKeyInstead")}</button>
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost" onClick={back}>{t("modal.back")}</button>
              </div>
            </div>
          ) : (
            // API key / advanced forward-auth form
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {!isCustom && preset.auth === "key" && selectedPresetNote && preset.dashboardUrl && (
                <details className="setup-guide">
                  <summary>{t("modal.setupGuide")}</summary>
                  <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
                    <li>{t("modal.setupStepOpen")} <a href={preset.dashboardUrl} target="_blank" rel="noreferrer">{t("modal.providerDashboard", { label: selectedPresetLabel })}</a> {t("modal.setupStepCopy")}</li>
                    <li>{t("modal.setupStepPaste")}</li>
                    <li>{t("modal.setupStepAdd")}</li>
                  </ol>
                  {selectedPresetNote && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, fontStyle: "italic" }}>{selectedPresetNote}</div>}
                </details>
              )}
              {usesClaudeCodeAuth(preset, form) && (
                <details className="setup-guide" open>
                  <summary>{t("modal.anthropicClaudeCodeTitle")}</summary>
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
                    <p style={{ margin: "0 0 6px" }}>{t("modal.anthropicClaudeCodeIntro")}</p>
                    <code className="chip">claude login</code>
                    <p style={{ margin: "8px 0 6px" }}>{t("modal.anthropicClaudeCodeMulti")}</p>
                    <div className="mini-list">
                      <div><span>{t("modal.anthropicClaudeCodeStep1")}</span><code>CLAUDE_CONFIG_DIR=~/.claude-work claude login</code></div>
                      <div><span>{t("modal.anthropicClaudeCodeStep2")}</span><code>frogp claude add work --home ~/.claude-work</code></div>
                      <div><span>{t("modal.anthropicClaudeCodeStep3")}</span><code>frogp claude run work -- "hello"</code></div>
                    </div>
                  </div>
                </details>
              )}
              <Field label={t("modal.providerName")}>
                <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t("modal.placeholderProviderName")} />
              </Field>
              {dup && <div style={{ fontSize: 12, color: "var(--amber)" }}>{t("modal.duplicateProvider", { name: form.name.trim() })}</div>}
              <Field label={t("modal.adapter")}>
                <select className="input" value={form.adapter} onChange={e => setForm({ ...form, adapter: e.target.value })}>
                  {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai"].map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label={t("modal.baseUrl")}>
                <input className="input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder={t("modal.baseUrlPlaceholder")} />
              </Field>
              {usesClaudeCodeAuth(preset, form) && (
                <Field label={t("modal.claudeHome")}>
                  <input className="input" value={form.claudeHome} onChange={e => setForm({ ...form, claudeHome: e.target.value })} placeholder="~/.claude" />
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t("modal.claudeHomeHint")}</div>
                </Field>
              )}
              {form.authMode === "forward" ? (
                <div style={{ fontSize: 12, color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "8px 10px" }}>
                  {usesClaudeCodeAuth(preset, form) ? t("modal.anthropicClaudeCodeNotice") : t("modal.forwardNotice")}
                </div>
              ) : (
                <>
                  {preset.dashboardUrl && (
                    <a href={preset.dashboardUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <IconKey style={{ width: 14, height: 14 }} />{t("modal.getApiKey", { label: selectedPresetLabel })}<IconExternal style={{ width: 13, height: 13 }} />
                    </a>
                  )}
                  <Field label={t("modal.apiKey")}>
                    <input className="input" type="password" value={form.apiKey} onChange={e => { setForm({ ...form, apiKey: e.target.value }); setTestState(null); }} placeholder={t("modal.apiKeyPlaceholder")} />
                  </Field>
                  <Field label={t("prov.modal.extraApiKeys")}>
                    <input className="input" type="password" value={form.extraApiKeys} onChange={e => { setForm({ ...form, extraApiKeys: e.target.value }); setTestState(null); }} placeholder={t("prov.modal.extraApiKeysPlaceholder")} />
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t("prov.modal.extraApiKeysHint")}</div>
                  </Field>
                </>
              )}
              <Field label={t("modal.defaultModel")}>
                <input className="input" value={form.defaultModel} onChange={e => setForm({ ...form, defaultModel: e.target.value })} placeholder={t("modal.defaultModelPlaceholder")} />
              </Field>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={form.setDefault} onChange={e => setForm({ ...form, setDefault: e.target.checked })} />
                {t("modal.defaultProviderCheckbox")}
              </label>
              {testState && (
                <div style={{ fontSize: 13, color: testState.status === "ok" ? "var(--green)" : testState.status === "skipped" ? "var(--amber)" : "var(--red)", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "8px 10px" }}>
                  <strong>{testState.status === "ok" ? t("prov.test.ok") : testState.status === "skipped" ? t("prov.test.skipped") : t("prov.test.error")}</strong>
                  {testState.message ? ` · ${testState.message}` : ""}
                  {testState.modelCount !== undefined ? ` · ${t("prov.test.modelCount", { n: testState.modelCount })}` : ""}
                  {testState.code ? ` · ${testState.code}` : ""}
                </div>
              )}
              {error && <div role="alert" style={{ fontSize: 13, color: "var(--red)" }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                <button className="btn btn-ghost" onClick={testDraftProvider} disabled={testing || saving}>{testing ? <><span className="spin" />{t("prov.test.testing")}</> : t("prov.test.action")}</button>
                <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? t("modal.adding") : t("modal.add")}</button>
                {preset.auth === "oauth" && <button className="link-btn" onClick={() => { setForm({ ...form, authMode: "oauth" }); setError(""); }}>{t("modal.useOAuthLogin")}</button>}
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost" onClick={back}>{t("modal.back")}</button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
