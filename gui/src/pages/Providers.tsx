import { useEffect, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import { Notice } from "../ui";
import { IconPlus, IconTrash, IconLock, IconExternal } from "../icons";
import { useT, type TFn } from "../i18n";
import type { DeepLinkTarget } from "../navigation";
import { providerIsReady, providerNeedsEndpointCheck, providerSetupState, type ProviderSetupState } from "../provider-display";
import { parseGrants, grantStateChip, grantUsable, type ClaudeGrantSummary } from "./ClaudeProfiles";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; defaultModel?: string; authMode?: string; claudeGrantId?: string; hasApiKey?: boolean; keyCount?: number; balanceSupported?: boolean }>;
}

interface OAuthStatus { loggedIn: boolean; error?: string }
interface LoginInfo { provider: string; url?: string; instructions?: string; code?: string; copied?: boolean; copyFailed?: boolean }
interface ProviderTestResult { ok: boolean; code: ProviderTestCode; provider: string; model?: string; upstreamStatus?: number; durationMs?: number }
type ProviderTestCode = "ok" | "unknown_provider" | "model_missing" | "auth_missing" | "timeout" | "request_failed" | "provider_non_2xx" | "bridge_parse_error";
const PROVIDER_TEST_CODE_KEYS: Record<ProviderTestCode, "prov.testCode.ok" | "prov.testCode.unknownProvider" | "prov.testCode.modelMissing" | "prov.testCode.authMissing" | "prov.testCode.timeout" | "prov.testCode.requestFailed" | "prov.testCode.providerNon2xx" | "prov.testCode.bridgeParseError"> = {
  ok: "prov.testCode.ok",
  unknown_provider: "prov.testCode.unknownProvider",
  model_missing: "prov.testCode.modelMissing",
  auth_missing: "prov.testCode.authMissing",
  timeout: "prov.testCode.timeout",
  request_failed: "prov.testCode.requestFailed",
  provider_non_2xx: "prov.testCode.providerNon2xx",
  bridge_parse_error: "prov.testCode.bridgeParseError",
};

// Friendly labels for the OAuth providers the proxy supports.
const OAUTH_LABELS: Record<string, string> = {
  codex: "OpenAI Codex (ChatGPT)",
  xai: "xAI (Grok)",
  kimi: "Kimi (Moonshot)",
};
const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;
function extractDeviceCode(data: { code?: unknown; instructions?: unknown }): string | undefined {
  if (typeof data.code === "string" && data.code.trim()) return data.code.trim();
  if (typeof data.instructions !== "string") return undefined;
  const match = data.instructions.match(/\b(?:code|코드|代码)\s*[:：]\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)/i);
  return match?.[1];
}
export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object") throw new Error("provider state must be an object");
  const data = value as Partial<Config>;
  if (typeof data.port !== "number" || typeof data.defaultProvider !== "string" || !data.providers || typeof data.providers !== "object") {
    throw new Error("invalid provider state");
  }
  const providers: Config["providers"] = {};
  for (const [name, provider] of Object.entries(data.providers)) {
    if (!provider || typeof provider !== "object") throw new Error("invalid provider");
    const row = provider as Partial<Config["providers"][string]>;
    if (typeof row.adapter !== "string" || typeof row.baseUrl !== "string") throw new Error("invalid provider");
    providers[name] = {
      adapter: row.adapter,
      baseUrl: row.baseUrl,
      defaultModel: typeof row.defaultModel === "string" ? row.defaultModel : undefined,
      authMode: typeof row.authMode === "string" ? row.authMode : undefined,
      claudeGrantId: typeof row.claudeGrantId === "string" ? row.claudeGrantId : undefined,
      hasApiKey: row.hasApiKey === true,
      keyCount: typeof (row as { apiKeyCount?: unknown }).apiKeyCount === "number" ? (row as { apiKeyCount: number }).apiKeyCount : undefined,
      balanceSupported: typeof row.balanceSupported === "boolean" ? row.balanceSupported : undefined,
    };
  }
  return { port: data.port, defaultProvider: data.defaultProvider, providers };
}
function setupLabelKey(state: ProviderSetupState): "prov.auth.connected" | "prov.auth.forwardOnly" | "prov.auth.needsSetup" {
  if (state === "connected") return "prov.auth.connected";
  if (state === "forwardOnly") return "prov.auth.forwardOnly";
  return "prov.auth.needsSetup";
}

function oauthDisplayState(
  provider: Config["providers"][string] | undefined,
  status: OAuthStatus,
): { connected: boolean; canLogout: boolean; labelKey: "prov.loggedIn" | "prov.auth.connected" | "prov.auth.forwardOnly" | "prov.notLoggedIn" } {
  if (status.loggedIn) return { connected: true, canLogout: true, labelKey: "prov.loggedIn" };
  if (!provider) return { connected: false, canLogout: false, labelKey: "prov.notLoggedIn" };
  const setupState = providerSetupState({ name: "", ...provider }, status);
  if (setupState === "connected") return { connected: true, canLogout: false, labelKey: "prov.auth.connected" };
  if (setupState === "forwardOnly") return { connected: false, canLogout: false, labelKey: "prov.auth.forwardOnly" };
  return { connected: false, canLogout: false, labelKey: "prov.notLoggedIn" };
}


interface ProviderMetadataTestResult {
  status?: "ok" | "error" | "skipped";
  message?: string;
  code?: string;
  modelCount?: number;
}

export function ProviderMetadataList({
  provider,
  testResult,
  setupState,
  endpointCheck,
  t,
}: {
  provider: Config["providers"][string];
  testResult?: ProviderMetadataTestResult;
  setupState?: ProviderSetupState;
  endpointCheck?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <>
      <div className="mini-list">
        <div><span>{t("prov.defaultModel")}</span><code className="text-anywhere">{provider.defaultModel ?? t("prov.noDefaultModel")}</code></div>
        <div><span>{t("prov.authMode")}</span><code>{provider.authMode === "forward" ? t("prov.authMode.forward") : provider.authMode ?? "api-key"}</code></div>
        <div><span>{t("prov.keyCount")}</span><code>{provider.keyCount ?? (provider.hasApiKey ? 1 : 0)}</code></div>
        <div><span>{t("prov.balanceSupport")}</span><code>{provider.balanceSupported === true ? t("prov.balance.supported") : provider.balanceSupported === false ? t("prov.balance.unsupported") : t("prov.balance.notAvailable")}</code></div>
        {setupState === "forwardOnly" && <div><span>{t("prov.nextAction")}</span><code>{t("prov.forwardAction")}</code></div>}
        {endpointCheck && <div><span>{t("prov.nextAction")}</span><code>{t("prov.endpointAction")}</code></div>}
      </div>
      {testResult && (
        <div style={{ marginTop: 8, fontSize: 13, color: testResult.status === "ok" ? "var(--green)" : testResult.status === "skipped" ? "var(--amber)" : "var(--red)" }}>
          <strong>{testResult.status === "ok" ? t("prov.test.ok") : testResult.status === "skipped" ? t("prov.test.skipped") : t("prov.test.error")}</strong>
          {testResult.message ? ` · ${testResult.message}` : ""}
          {testResult.modelCount !== undefined ? ` · ${t("prov.test.modelCount", { n: testResult.modelCount })}` : ""}
          {testResult.code ? ` · ${testResult.code}` : ""}
        </div>
      )}
    </>
  );
}

export default function Providers({ apiBase, target }: { apiBase: string; target?: DeepLinkTarget | null }) {
  const t = useT();
  const [config, setConfig] = useState<Config | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loginInfo, setLoginInfo] = useState<LoginInfo | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const [grants, setGrants] = useState<ClaudeGrantSummary[]>([]);
  const [grantsFailed, setGrantsFailed] = useState(false);
  const [rawProviders, setRawProviders] = useState<Record<string, Record<string, unknown>>>({});
  const aliveRef = useRef(true);
  const loginRef = useRef<HTMLDivElement | null>(null);
  const providerListRef = useRef<HTMLDivElement | null>(null);


  const notify = (msg: string, ok: boolean) => { setStatus(msg); setStatusOk(ok); };
  const providerTestSummary = (result: ProviderTestResult): string => {
    const label = t(PROVIDER_TEST_CODE_KEYS[result.code] ?? "prov.testCode.requestFailed");
    const suffix = [
      result.model,
      result.upstreamStatus ? `HTTP ${result.upstreamStatus}` : undefined,
      typeof result.durationMs === "number" ? `${Math.round(result.durationMs)}ms` : undefined,
    ].filter(Boolean).join(" · ");
    return suffix ? `${label} · ${suffix}` : label;
  };
  const copyLoginCode = (provider: string, code: string) => {
    const write = navigator.clipboard?.writeText(code);
    if (!write) {
      setLoginInfo(prev => prev?.provider === provider && prev.code === code
        ? { ...prev, copied: false, copyFailed: true }
        : prev);
      return;
    }
    write
      .then(() => {
        if (!aliveRef.current) return;
        setLoginInfo(prev => prev?.provider === provider && prev.code === code
          ? { ...prev, copied: true, copyFailed: false }
          : prev);
      })
      .catch(() => {
        if (!aliveRef.current) return;
        setLoginInfo(prev => prev?.provider === provider && prev.code === code
          ? { ...prev, copied: false, copyFailed: true }
          : prev);
      });
  };


  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${apiBase}/api/provider-state`);
      if (!res.ok) throw new Error("provider state load failed");
      const raw = await res.json();
      setConfig(parseConfig(raw));
      const rawEntries = raw && typeof raw === "object" && (raw as { providers?: unknown }).providers && typeof (raw as { providers?: unknown }).providers === "object"
        ? (raw as { providers: Record<string, Record<string, unknown>> }).providers
        : {};
      setRawProviders(rawEntries);
    } catch {
      setConfig(null);
      notify(t("prov.loadConfigFail"), false);
    }
  };

  // Fail-closed: a grant API failure only disables grant binding, never the page.
  const fetchGrants = async () => {
    try {
      const res = await fetch(`${apiBase}/api/claude-grants`);
      if (!res.ok) throw new Error("grants load failed");
      setGrants(parseGrants(await res.json()).grants);
      setGrantsFailed(false);
    } catch {
      setGrants([]);
      setGrantsFailed(true);
    }
  };

  // Load the list of OAuth-capable providers, then each one's login status.
  const fetchOauth = async () => {
    try {
      const provs: string[] = (await fetch(`${apiBase}/api/oauth/providers`).then(r => r.json())).providers ?? [];
      setOauthProviders(provs);
      const entries = await Promise.all(provs.map(async p => {
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${p}`).then(r => r.json()).catch(() => ({ loggedIn: false }));
        return [p, s] as const;
      }));
      setOauthStatus(Object.fromEntries(entries));
    } catch { /* ignore */ }
  };

  useEffect(() => { fetchConfig(); fetchOauth(); fetchGrants(); }, [apiBase]);
  useEffect(() => {
    if (!loginInfo?.code) return;
    copyLoginCode(loginInfo.provider, loginInfo.code);
  }, [loginInfo?.provider, loginInfo?.code]);

  useEffect(() => {
    if (target === "account-login" || target === "account-api-key" || target === "account-add-provider") loginRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (target === "account-add-provider") setAdding(true);
    if (target === "account-default-model") providerListRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [target]);


  const makeDefault = async (name: string) => {
    setBusy(`default:${name}`);
    try {
      const res = await fetch(`${apiBase}/api/default-provider`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify(data.error || t("prov.defaultFailed", { name }), false);
        return;
      }
      notify(t("prov.defaultUpdated", { name }), true);
      fetchConfig();
    } catch {
      notify(t("prov.defaultFailed", { name }), false);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const loginOAuth = async (provider: string) => {
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, restart: true }),
      });
      const data = await res.json();
      if (!res.ok) { notify(t("prov.loginFailStart", { provider: oauthLabel(provider) }), false); return; }
      // The server opens the browser itself (popup-safe). Show the URL/device code as a fallback.
      if (data.url || data.instructions) setLoginInfo({ provider, url: data.url, instructions: data.instructions, code: extractDeviceCode(data) });
      // Poll until the loopback callback (or device flow) completes.
      for (let i = 0; i < 150 && aliveRef.current; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s: OAuthStatus | null = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).then(r => r.json()).catch(() => null);
        if (!s) continue;
        if (s.loggedIn) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "frogp refresh" }), true);
          setLoginInfo(null);
          fetchConfig();
          break;
        }
        if (s.error) { setOauthStatus(prev => ({ ...prev, [provider]: s })); notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("prov.oauthLoginFailed") }), false); break; }
      }
    } catch {
      notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const logoutOAuth = async (provider: string) => {
    await fetch(`${apiBase}/api/oauth/logout?provider=${provider}`, { method: "POST" }).catch(() => {});
    setOauthStatus(prev => ({ ...prev, [provider]: { loggedIn: false } }));
    notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    fetchConfig();
  };
  const testProvider = async (name: string) => {
    setBusy(`test:${name}`);
    setStatus("");
    try {
      const res = await fetch(`${apiBase}/api/providers/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({ ok: false, code: "request_failed", provider: name })) as ProviderTestResult;
      const result: ProviderTestResult = {
        ok: data.ok === true,
        code: PROVIDER_TEST_CODE_KEYS[data.code] ? data.code : "request_failed",
        provider: typeof data.provider === "string" ? data.provider : name,
        model: typeof data.model === "string" ? data.model : undefined,
        upstreamStatus: typeof data.upstreamStatus === "number" ? data.upstreamStatus : undefined,
        durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
      };
      setTestResults(prev => ({ ...prev, [name]: result }));
      notify(result.ok ? t("prov.testOk", { name }) : t("prov.testFailed", { name, code: providerTestSummary(result) }), result.ok && res.ok);
    } catch {
      const result: ProviderTestResult = { ok: false, code: "request_failed", provider: name };
      setTestResults(prev => ({ ...prev, [name]: result }));
      notify(t("prov.testFailed", { name, code: providerTestSummary(result) }), false);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const removeProvider = async (name: string) => {
    if (!window.confirm(t("prov.removeConfirm", { name }))) return;
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.ok) { notify(t("prov.removed", { name }), true); fetchConfig(); fetchOauth(); }
    else notify(t("prov.removeFail", { name }), false);
  };

  // Persist an Anthropic provider's auth mode. Forward keeps zero Claude-token custody; claude-grant
  // binds an isolated grant. The full (secret-stripped) provider is round-tripped so models/metadata
  // survive the replace; masked keys are never resent as real secrets.
  const saveAnthropicAuth = async (name: string, authMode: string, claudeGrantId: string) => {
    if (authMode === "claude-grant") {
      const trimmed = claudeGrantId.trim();
      if (!trimmed) { notify(t("prov.grant.selectFirst"), false); return; }
      const grant = grants.find(g => g.id === trimmed);
      if (!grant) {
        notify(t("prov.authEditor.dangling"), false);
        return;
      } else if (!grantUsable(grant)) {
        if (!window.confirm(t("prov.grant.notReadyConfirm", { label: grant.label, state: grant.state }))) return;
      }
    }
    const raw = rawProviders[name] ?? {};
    const provider: Record<string, unknown> = { ...raw };
    // Drop GUI-only summary fields and masked secrets so the server never round-trips placeholders.
    for (const key of ["hasApiKey", "apiKeyCount", "keyCount", "balanceSupported", "apiKey", "apiKeys", "headers"]) delete provider[key];
    provider.authMode = authMode;
    if (authMode === "claude-grant") provider.claudeGrantId = claudeGrantId.trim();
    else delete provider.claudeGrantId;

    setBusy(`auth:${name}`);
    try {
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, provider, catalogId: authMode === "claude-grant" ? "anthropic" : undefined }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { notify(data.error || t("prov.saveFailed"), false); return; }
      notify(t("prov.grant.authSaved", { name }), true);
      fetchConfig();
      fetchGrants();
    } catch {
      notify(t("prov.saveFailed"), false);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  if (!config) return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          <button className="btn btn-primary" disabled><IconPlus />{t("prov.add")}</button>
        </div>
      </div>
      <p className="page-sub">{t("prov.subtitle")}</p>
      {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}
      <div className="empty">{t("prov.loadingConfig")}</div>
    </>
  );

  const providerEntries = Object.entries(config.providers);
  const readyProviders = providerEntries.filter(([name, provider]) => providerIsReady({ name, ...provider }, oauthStatus[name])).length;
  const forwardOnlyProviders = providerEntries.filter(([name, provider]) => providerSetupState({ name, ...provider }, oauthStatus[name]) === "forwardOnly").length;
  const endpointCheckProviders = providerEntries.filter(([, provider]) => providerNeedsEndpointCheck(provider)).length;
  const needsAttention = providerEntries.length - readyProviders;
  const defaultProvider = config.providers[config.defaultProvider];
  const accountProviderIds = oauthProviders.filter(p => oauthStatus[p]?.loggedIn || !!config.providers[p]);
  return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          <button className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
        </div>
      </div>
      <p className="page-sub">{t("prov.subtitle")}</p>
      <div className="account-summary-grid">
        <div className="stat"><div className="muted">{t("prov.summary.ready")}</div><div className="stat-value">{readyProviders}/{providerEntries.length}</div></div>
        <div className="stat"><div className="muted">{t("prov.summary.attention")}</div><div className="stat-value">{needsAttention}</div></div>
        <div className="stat"><div className="muted">{t("prov.summary.default")}</div><div className="stat-value mono text-anywhere">{config.defaultProvider}</div><div className="muted text-anywhere" style={{ fontSize: 12 }}>{defaultProvider?.defaultModel ?? t("prov.noDefaultModel")}</div></div>
      </div>

      {forwardOnlyProviders > 0 && <Notice tone="err">{t("prov.forwardNotice", { n: forwardOnlyProviders })}</Notice>}
      {endpointCheckProviders > 0 && <Notice tone="err">{t("prov.endpointNotice", { n: endpointCheckProviders })}</Notice>}
      {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}

      {/* Account login state — show configured OAuth-capable providers, not every possible login target. */}
      <div ref={loginRef} className="panel panel-accent" style={{ marginBottom: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <IconLock style={{ width: 16, height: 16, color: "var(--accent)" }} />
          <span style={{ fontWeight: 600 }}>{t("prov.accountLogin")}</span>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          {accountProviderIds.length === 0 && <span className="muted" style={{ fontSize: 13 }}>{t("prov.noAccountRows")}</span>}
          {accountProviderIds.map(p => {
            const st = oauthStatus[p] ?? { loggedIn: false };
            const configuredProvider = config.providers[p];
            const displayState = oauthDisplayState(configuredProvider, st);
            const isBusy = busy === p;
            return (
              <div key={p} className="oauth-provider-row">
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, minWidth: 170, display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{oauthLabel(p)}</span>
                    {displayState.connected ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--green)" }}>
                        <span className="dot dot-green" />{t(displayState.labelKey)}
                      </span>
                    ) : (
                      <span className="muted">{t(displayState.labelKey)}</span>
                    )}
                  </span>
                  {displayState.canLogout ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => logoutOAuth(p)}>{t("prov.logout")}</button>
                  ) : !displayState.connected ? (
                    <button className="btn btn-primary btn-sm" onClick={() => loginOAuth(p)} disabled={isBusy}>
                      {isBusy ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconLock />{t("prov.loginWith", { provider: oauthLabel(p) })}</>}
                    </button>
                  ) : null}
                </div>
                {loginInfo?.provider === p && (loginInfo.url || loginInfo.instructions) && (
                  <div className="oauth-login-card">
                    {loginInfo.url && (
                      <a href={loginInfo.url} target="_blank" rel="noreferrer" className="oauth-open-link">
                        <IconExternal />{t("prov.didntOpen")}
                      </a>
                    )}
                    {loginInfo.code ? (
                      <button className="oauth-code-card" type="button" onClick={() => copyLoginCode(loginInfo.provider, loginInfo.code!)}>
                        <span className="oauth-code-label">{t("prov.enterCode")}</span>
                        <code>{loginInfo.code}</code>
                        <span className={loginInfo.copyFailed ? "oauth-copy-state oauth-copy-warn" : "oauth-copy-state"}>
                          {loginInfo.copyFailed ? t("prov.copyFailed") : loginInfo.copied ? t("prov.codeCopied") : t("prov.copyingCode")}
                        </span>
                      </button>
                    ) : loginInfo.instructions ? (
                      <span className="oauth-instructions">{loginInfo.instructions}</span>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <section ref={providerListRef} className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <div>
            <h3 className="panel-title">{t("prov.routingTitle")}</h3>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t("prov.routingHint")}</p>
          </div>
          <span className="chip">{t("prov.port")}: {config.port}</span>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {providerEntries.map(([name, prov]) => {
            const isDefault = name === config.defaultProvider;
            const isDefaultBusy = busy === `default:${name}`;
            const isTestBusy = busy === `test:${name}`;
            const testResult = testResults[name];
            const setupState = providerSetupState({ name, ...prov }, oauthStatus[name]);
            const endpointCheck = providerNeedsEndpointCheck(prov);
            const authBadge = setupState === "needsSetup" ? "badge-amber" : setupState === "forwardOnly" ? "badge-amber" : "badge-green";
            return (
              <div key={name} className="card prov-card">
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                    <span className="text-anywhere" style={{ fontWeight: 600 }}>{name}</span>
                    {isDefault && <span className="badge badge-accent">{t("prov.defaultBadge")}</span>}
                    <span className={`badge ${authBadge}`}>{t(setupLabelKey(setupState))}</span>
                    {endpointCheck && <span className="badge badge-amber">{t("prov.endpointCheckBadge")}</span>}
                    {prov.authMode === "oauth" && <span className="badge badge-accent">oauth</span>}
                  </div>
                  <div className="muted text-anywhere" style={{ fontSize: 13 }}>
                    <code className="chip">{prov.adapter}</code> · {prov.baseUrl}
                  </div>
                  <div className="mini-list">
                    <div><span>{t("prov.defaultModel")}</span><code className="text-anywhere">{prov.defaultModel ?? t("prov.noDefaultModel")}</code></div>
                    <div><span>{t("prov.authMode")}</span><code>{prov.authMode === "forward" ? t("prov.authMode.forward") : prov.authMode ?? "api-key"}</code></div>
                    <div><span>{t("prov.keyCount")}</span><code>{prov.keyCount ?? (prov.hasApiKey ? 1 : 0)}</code></div>
                    <div><span>{t("prov.balanceSupport")}</span><code>{prov.balanceSupported === true ? t("prov.balance.supported") : prov.balanceSupported === false ? t("prov.balance.unsupported") : t("prov.balance.notAvailable")}</code></div>
                    {setupState === "forwardOnly" && <div><span>{t("prov.nextAction")}</span><code>{t("prov.forwardAction")}</code></div>}
                    {endpointCheck && <div><span>{t("prov.nextAction")}</span><code>{t("prov.endpointAction")}</code></div>}
                    {testResult && <div><span>{t("prov.testResult")}</span><code className={testResult.ok ? "text-anywhere" : "text-anywhere"} style={{ color: testResult.ok ? "var(--green)" : "var(--red)" }}>{providerTestSummary(testResult)}</code></div>}
                  </div>
                  {prov.adapter === "anthropic" && (
                    <AnthropicAuthEditor
                      t={t}
                      name={name}
                      provider={prov}
                      grants={grants}
                      grantsFailed={grantsFailed}
                      busy={busy === `auth:${name}`}
                      onSave={(mode, grantId) => void saveAnthropicAuth(name, mode, grantId)}
                    />
                  )}
                </div>
                <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => testProvider(name)} disabled={isTestBusy} aria-label={t("prov.testConnectionAria", { name })}>
                    {isTestBusy ? <><span className="spin" />{t("prov.testing")}</> : t("prov.testConnection")}
                  </button>
                  {!isDefault && (
                    <button className="btn btn-ghost btn-sm" onClick={() => makeDefault(name)} disabled={isDefaultBusy}>
                      {isDefaultBusy ? <><span className="spin" />{t("prov.savingDefault")}</> : t("prov.makeDefault")}
                    </button>
                  )}
                  {!isDefault && <button className="btn btn-danger btn-sm" onClick={() => removeProvider(name)} aria-label={t("prov.removeAria", { name })}><IconTrash />{t("common.remove")}</button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      {adding && (
        <AddProviderModal
          apiBase={apiBase}
          existingNames={Object.keys(config.providers)}
          onClose={() => setAdding(false)}
          onAdded={(name) => { setAdding(false); notify(t("prov.added", { name, cmd: "frogp refresh" }), true); fetchConfig(); fetchOauth(); }}
        />
      )}
    </>
  );
}

// Inline auth-mode editor for Anthropic provider rows. Forward keeps zero Claude-token custody;
// API key is the headless alternative (managed in Add provider, never entered here); Claude grant
// binds an isolated subscription grant. Codex/xAI/Kimi/OAuth rows are untouched.
export function AnthropicAuthEditor({
  t, name, provider, grants, grantsFailed, busy, onSave,
}: {
  t: TFn;
  name: string;
  provider: { authMode?: string; claudeGrantId?: string };
  grants: ClaudeGrantSummary[];
  grantsFailed: boolean;
  busy: boolean;
  onSave: (authMode: string, claudeGrantId: string) => void;
}) {
  const currentMode = provider.authMode === "forward" ? "forward" : provider.authMode === "claude-grant" ? "claude-grant" : "key";
  const [mode, setMode] = useState(currentMode);
  const [grantId, setGrantId] = useState(provider.claudeGrantId ?? "");

  useEffect(() => {
    setMode(currentMode);
    setGrantId(provider.claudeGrantId ?? "");
  }, [currentMode, provider.claudeGrantId]);

  const boundGrant = grants.find(g => g.id === (provider.claudeGrantId ?? ""));
  const selectedGrant = grants.find(g => g.id === grantId);
  const changed = mode !== currentMode || (mode === "claude-grant" && grantId !== (provider.claudeGrantId ?? ""));
  const canSave = changed && !busy && mode !== "key" && (mode !== "claude-grant" || grantId.trim().length > 0);

  return (
    <div className="panel-soft" style={{ marginTop: 12 }} data-testid="anthropic-auth-editor">
      <div className="fallback-row" style={{ borderTop: "none", paddingTop: 0 }}>
        <div>
          <div style={{ fontWeight: 650 }}>{t("prov.authEditor.title")}</div>
          <div className="muted" style={{ fontSize: 13 }}>{t("prov.authEditor.hint")}</div>
        </div>
        <div className="fallback-controls">
          <select className="select-sm" value={mode} disabled={busy} onChange={e => { const next = e.target.value; setMode(next); if (next !== "claude-grant") setGrantId(""); }} aria-label={t("prov.authEditor.aria", { name })}>
            <option value="forward">{t("prov.authEditor.forward")}</option>
            <option value="key">{t("prov.authEditor.key")}</option>
            <option value="claude-grant">{t("prov.authEditor.grant")}</option>
          </select>
        </div>
      </div>

      {mode === "forward" && (
        <p className="muted" style={{ fontSize: 13 }}>{t("prov.authEditor.forwardHint")}</p>
      )}

      {mode === "key" && (
        <p className="muted" style={{ fontSize: 13 }}>{t("prov.authEditor.keyHint")}</p>
      )}

      {mode === "claude-grant" && (
        <div style={{ marginTop: 8 }}>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{t("prov.authEditor.grantHint")}</p>
          {grantsFailed
            ? <Notice tone="err">{t("prov.authEditor.unavailable")}</Notice>
            : grants.length === 0
              ? <p className="muted" style={{ fontSize: 13 }}>{t("prov.authEditor.empty")}</p>
              : (
                <div className="fallback-row" style={{ borderTop: "none", paddingTop: 0 }}>
                  <div>
                    <div style={{ fontWeight: 650 }}>{t("prov.authEditor.grantTitle")}</div>
                    <div className="muted" style={{ fontSize: 13 }}>{t("prov.authEditor.bindHint")}</div>
                  </div>
                  <div className="fallback-controls">
                    <select className="select-sm" value={grantId} disabled={busy} onChange={e => setGrantId(e.target.value)} aria-label={t("prov.authEditor.grantAria", { name })}>
                      <option value="">{t("prov.authEditor.select")}</option>
                      {grants.map(g => <option key={g.id} value={g.id}>{g.label} · {grantStateChip(g.state, t).label}</option>)}
                    </select>
                  </div>
                </div>
              )}
          {selectedGrant && !grantUsable(selectedGrant) && (
            <Notice tone="err">{t("prov.authEditor.notReady", { label: selectedGrant.label, state: selectedGrant.state })}</Notice>
          )}
          {grantId && !selectedGrant && !grantsFailed && grants.length > 0 && (
            <Notice tone="err">{t("prov.authEditor.dangling")}</Notice>
          )}
          {(selectedGrant?.statusError || boundGrant?.statusError) && (
            <Notice tone="err">{t("prov.authEditor.statusProblem", { error: selectedGrant?.statusError ?? boundGrant?.statusError ?? "—" })}</Notice>
          )}
        </div>
      )}

      {currentMode === "claude-grant" && (
        <div className="mini-list">
          <div><span>{t("prov.authEditor.boundGrant")}</span><code className="text-anywhere">{boundGrant ? `${boundGrant.label} · ${grantStateChip(boundGrant.state, t).label}` : `${provider.claudeGrantId ?? t("prov.authEditor.none")} (${t("prov.authEditor.danglingSuffix")})`}</code></div>
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
        <button className="btn btn-primary btn-sm" type="button" disabled={!canSave} onClick={() => onSave(mode, grantId)}>
          {busy ? <><span className="spin" />{t("prov.authEditor.saving")}</> : t("prov.authEditor.save")}
        </button>
      </div>
    </div>
  );
}
