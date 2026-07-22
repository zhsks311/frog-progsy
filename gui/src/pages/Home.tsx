import { useEffect, useState } from "react";
import { IconAlert } from "../icons";
import { useT } from "../i18n";
import type { Navigate } from "../navigation";
import { providerIsReady, providerNeedsEndpointCheck, providerSetupState } from "../provider-display";

interface HealthData { status: string; version: string; uptime: number }
interface ProviderInfo { name: string; adapter: string; baseUrl: string; authMode?: string; hasApiKey: boolean }
interface ModelInfo { id: string; provider: string; namespaced?: string; disabled?: boolean }
interface SettingsData { port: number; hostname: string }
interface FeaturedModelsResponse { available?: string[]; chosen?: string[] }
interface UsageResponse { summary?: { requests?: number; reportedRequests?: number; totalTokens?: number } }
interface OAuthStatus { loggedIn?: boolean }

type HomeProblem = {
  tone: "ok" | "warn" | "bad";
  titleKey: "home.readyTitle" | "home.proxyProblem" | "home.accountsProblem" | "home.forwardProblem" | "home.endpointProblem" | "home.modelsProblem";
  bodyKey: "home.readyBody" | "home.proxyProblemBody" | "home.accountsProblemBody" | "home.forwardProblemBody" | "home.endpointProblemBody" | "home.modelsProblemBody";
  ctaKey: "home.refreshModels" | "home.openRecovery" | "home.openAccounts" | "home.openProviders" | "home.openModels";
  action: () => void;
};

function formatTokens(n?: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function formatCount(n?: number): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "—";
}


async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${url}`);
  return await res.json() as T;
}


export default function Home({ apiBase, navigate }: { apiBase: string; navigate: Navigate }) {
  const t = useT();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [featured, setFeatured] = useState<FeaturedModelsResponse>({ available: [], chosen: [] });
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setHealth(await fetchJson<HealthData>(`${apiBase}/healthz`));
        setError(false);
      } catch {
        setHealth(null);
        setError(true);
      }

      const [providerResult, settingsResult, modelsResult, featuredResult, usageResult] = await Promise.allSettled([
        fetchJson<ProviderInfo[]>(`${apiBase}/api/providers`),
        fetchJson<SettingsData>(`${apiBase}/api/settings`),
        fetchJson<ModelInfo[]>(`${apiBase}/api/models`),
        fetchJson<FeaturedModelsResponse>(`${apiBase}/api/subagent-models`),
        fetchJson<UsageResponse>(`${apiBase}/api/usage?range=30d`),
      ]);

      const providerData = providerResult.status === "fulfilled" ? providerResult.value : [];
      setProviders(providerData);
      setSettings(settingsResult.status === "fulfilled" ? settingsResult.value : null);
      setModels(modelsResult.status === "fulfilled" ? modelsResult.value : []);
      setFeatured(featuredResult.status === "fulfilled" ? featuredResult.value : { available: [], chosen: [] });
      setUsage(usageResult.status === "fulfilled" ? usageResult.value : null);

      const oauthEntries = await Promise.all(providerData
        .filter(provider => provider.authMode === "oauth")
        .map(async provider => {
          const status = await fetchJson<OAuthStatus>(`${apiBase}/api/oauth/status?provider=${encodeURIComponent(provider.name)}`)
            .catch(() => ({ loggedIn: false }));
          return [provider.name, status] as const;
        }));
      setOauthStatus(Object.fromEntries(oauthEntries));
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [apiBase]);

  const online = health?.status === "ok";
  const readyProviders = providers.filter(provider => providerIsReady(provider, oauthStatus[provider.name])).length;
  const forwardOnlyProviders = providers.filter(provider => providerSetupState(provider, oauthStatus[provider.name]) === "forwardOnly").length;
  const endpointCheckProviders = providers.filter(providerNeedsEndpointCheck).length;
  const activeModels = models.filter(model => !model.disabled).length;
  const hiddenModels = Math.max(models.length - activeModels, 0);
  const featuredChosen = featured.chosen ?? [];
  const visibleModelNames = featuredChosen.length > 0
    ? featuredChosen
    : models.filter(model => !model.disabled).slice(0, 5).map(model => model.namespaced ?? model.id);

  const status: HomeProblem = error || !online
    ? {
      tone: "bad",
      titleKey: "home.proxyProblem",
      bodyKey: "home.proxyProblemBody",
      ctaKey: "home.openRecovery",
      action: () => navigate("developerDetails", "recovery-controls"),
    }
    : providers.length === 0
      ? {
        tone: "warn",
        titleKey: "home.accountsProblem",
        bodyKey: "home.accountsProblemBody",
        ctaKey: "home.openAccounts",
        action: () => navigate("accounts", "account-add-provider"),
      }
      : readyProviders === 0
        ? {
          tone: "warn",
          titleKey: "home.accountsProblem",
          bodyKey: "home.accountsProblemBody",
          ctaKey: "home.openAccounts",
          action: () => navigate("accounts", "account-login"),
        }
        : endpointCheckProviders > 0
          ? {
            tone: "warn",
            titleKey: "home.endpointProblem",
            bodyKey: "home.endpointProblemBody",
            ctaKey: "home.openProviders",
            action: () => navigate("accounts", "account-login"),
          }
          : forwardOnlyProviders > 0
            ? {
              tone: "warn",
              titleKey: "home.forwardProblem",
              bodyKey: "home.forwardProblemBody",
              ctaKey: "home.openProviders",
              action: () => navigate("accounts", "account-login"),
            }
            : activeModels === 0
              ? {
                tone: "warn",
                titleKey: "home.modelsProblem",
                bodyKey: "home.modelsProblemBody",
                ctaKey: "home.openModels",
                action: () => navigate("models", "model-visibility-row"),
              }
              : {
                tone: "ok",
                titleKey: "home.readyTitle",
                bodyKey: "home.readyBody",
                ctaKey: "home.refreshModels",
                action: () => navigate("models", "model-refresh"),
              };
  const setupIncomplete = status.tone !== "ok";

  return (
    <>
      <div className="page-head"><h2>{t("nav.dashboard")}</h2></div>
      <p className="page-sub">{t("home.subtitle")}</p>

      <section className={`panel panel-accent dashboard-hero home-hero home-hero-${status.tone}`}>
        <div>
          <div className="eyebrow">{t("home.eyebrow")}</div>
          <h3>{t(status.titleKey)}</h3>
          <p>{t(status.bodyKey)}</p>
          <div className="action-row">
            <button className="btn btn-primary" type="button" onClick={status.action}>{t(status.ctaKey)}</button>
            <button className="btn btn-ghost" type="button" onClick={() => navigate("developerDetails", "debugging-logs")}>{t("home.openDetails")}</button>
          </div>
        </div>
        <div className="dashboard-hero-meta">
          <span className={`badge ${online ? "badge-green" : "badge-amber"}`}><span className={`dot ${online ? "dot-green" : "dot-red"}`} />{online ? t("home.claudeConnected") : t("home.claudeNeedsCheck")}</span>
          <span className="chip">{settings ? `${settings.hostname}:${settings.port}` : "—"}</span>
          <span className="chip">v{health?.version ?? "—"}</span>
        </div>
      </section>

      {setupIncomplete && (
        <section className="panel home-onboarding" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <div>
              <h3 className="panel-title">{t("home.setupChecklistTitle")}</h3>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t("home.setupChecklistHint")}</p>
            </div>
            <span className="badge badge-amber">{t("home.setupChecklistBadge")}</span>
          </div>
          <div className="fallback-grid" style={{ marginTop: 12 }}>
            <div className="fallback-row">
              <div><strong>{t("home.setupProxy")}</strong><div className="muted" style={{ fontSize: 13 }}>{online ? t("home.setupDone") : t("home.proxyProblemBody")}</div></div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate("developerDetails", "recovery-controls")}>{t("home.openRecovery")}</button>
            </div>
            <div className="fallback-row">
              <div><strong>{t("home.setupAccount")}</strong><div className="muted" style={{ fontSize: 13 }}>{readyProviders > 0 ? t("home.setupDone") : t("home.accountsProblemBody")}</div></div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate("accounts", providers.length === 0 ? "account-add-provider" : "account-login")}>{t("home.openAccounts")}</button>
            </div>
            <div className="fallback-row">
              <div><strong>{t("home.setupModels")}</strong><div className="muted" style={{ fontSize: 13 }}>{activeModels > 0 ? t("home.setupDone") : t("home.modelsProblemBody")}</div></div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate("models", activeModels > 0 ? "model-refresh" : "model-visibility-row")}>{t("home.openModels")}</button>
            </div>
          </div>
        </section>
      )}

      <div className="dashboard-grid home-grid">
        <section className="panel dashboard-card home-card-wide">
          <div className="panel-head"><h3 className="panel-title">{t("home.visibleModels")}</h3><span className="count mono">{activeModels}/{models.length}</span></div>
          <p className="muted" style={{ fontSize: 13 }}>{t("home.visibleModelsHint")}</p>
          <div className="chip-cloud" style={{ marginTop: 12 }}>
            {visibleModelNames.length === 0 ? <span className="muted">{t("models.noRouted")}</span> : visibleModelNames.map(model => <span key={model} className="chip text-anywhere">{model}</span>)}
            {hiddenModels > 0 ? <span className="badge badge-amber">{t("dash.hiddenModels", { n: hiddenModels })}</span> : null}
          </div>
          <button className="link-btn" type="button" onClick={() => navigate("models", "model-visibility-row")}>{t("home.changeModels")}</button>
        </section>

        <section className="panel dashboard-card">
          <div className="panel-head"><h3 className="panel-title">{t("home.accounts")}</h3><span className="count mono">{readyProviders}/{providers.length}</span></div>
          <div className="mini-list">
            {providers.length === 0 ? <div><span>{t("home.noAccounts")}</span><code>{t("home.connectAccount")}</code></div> : providers.slice(0, 4).map(provider => {
              const setupState = providerSetupState(provider, oauthStatus[provider.name]);
              const stateKey = providerNeedsEndpointCheck(provider)
                ? "home.endpointCheck"
                : setupState === "connected"
                  ? "home.connected"
                  : setupState === "forwardOnly"
                    ? "home.forwardOnly"
                    : "home.needsSetup";
              return <div key={provider.name}><span>{provider.name}</span><code>{t(stateKey)}</code></div>;
            })}
          </div>
          <button className="link-btn" type="button" onClick={() => navigate("accounts", providers.length === 0 ? "account-add-provider" : "account-login")}>{t("home.manageAccounts")}</button>
        </section>

        <section className="panel dashboard-card">
          <div className="panel-head"><h3 className="panel-title">{t("home.observedUsage")}</h3><span className="muted" style={{ fontSize: 12 }}>{t("home.observedOnly")}</span></div>
          <div className="mini-list">
            <div><span>{t("dash.requests30dLabel")}</span><code>{formatCount(usage?.summary?.requests)}</code></div>
            <div><span>{t("dash.reported30d")}</span><code>{formatCount(usage?.summary?.reportedRequests)}</code></div>
            <div><span>{t("dash.totalTokens30d")}</span><code>{formatTokens(usage?.summary?.totalTokens)}</code></div>
          </div>
          <button className="link-btn" type="button" onClick={() => navigate("activity", "usage-source-state")}>{t("home.openUsage")}</button>
        </section>

        <section className="panel dashboard-card">
          <div className="panel-head"><h3 className="panel-title">{t("home.advanced")}</h3>{status.tone !== "ok" && <IconAlert style={{ width: 18, height: 18, color: "var(--amber)" }} />}</div>
          <p className="muted" style={{ fontSize: 13 }}>{status.tone !== "ok" ? t("home.advancedHintProblem") : t("home.advancedHint")}</p>
          <div className="mini-list">
            <div><span>{t("dev.debugging")}</span><code>{t("home.safeLogs")}</code></div>
            <div><span>{t("dev.recovery")}</span><code>{t("home.advancedRecovery")}</code></div>
          </div>
          <button className="link-btn" type="button" onClick={() => navigate("developerDetails", "recovery-controls")}>{t("home.openDetails")}</button>
        </section>
      </div>
    </>
  );
}
