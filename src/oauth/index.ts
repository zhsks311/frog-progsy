import type { OAuthController, OAuthCredentials } from "./types";
import type { FrogConfig, FrogProviderConfig } from "../types";
import { loadConfig, saveConfig } from "../config";
import { getCredential, saveCredential } from "./store";
import { loginXai, refreshXaiToken } from "./xai";
import { ANTHROPIC_OAUTH_BETA } from "./anthropic";
import { loginKimi, refreshKimiToken } from "./kimi";
import { loginCodex, refreshCodexToken, isCodexBackendBaseUrl, codexBackendHeaders } from "./codex";
import { deriveOAuthDefaultModel, deriveOAuthProviderConfig } from "../providers/derive";

const REFRESH_SKEW_MS = 60_000;

interface OAuthProviderDef {
  login(ctrl: OAuthController): Promise<OAuthCredentials>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials>;
  /** provider entry written into config.json on first login. */
  providerConfig: FrogProviderConfig;
  defaultModel: string;
}

function oauthConfig(id: string): FrogProviderConfig {
  const config = deriveOAuthProviderConfig(id);
  if (!config) throw new Error(`OAuth provider missing from registry: ${id}`);
  return config;
}

function oauthDefaultModel(id: string): string {
  const model = deriveOAuthDefaultModel(id);
  if (!model) throw new Error(`OAuth provider missing default model in registry: ${id}`);
  return model;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  codex: {
    login: (ctrl) => loginCodex(ctrl),
    refresh: refreshCodexToken,
    providerConfig: oauthConfig("codex"),
    defaultModel: oauthDefaultModel("codex"),
  },
  xai: {
    login: (ctrl) => loginXai(ctrl, { importLocal: "fallback" }),
    refresh: refreshXaiToken,
    providerConfig: oauthConfig("xai"),
    defaultModel: oauthDefaultModel("xai"),
  },
  kimi: {
    login: (ctrl) => loginKimi(ctrl),
    refresh: refreshKimiToken,
    providerConfig: oauthConfig("kimi"),
    defaultModel: oauthDefaultModel("kimi"),
  },
};

export function isOAuthProvider(name: string): boolean {
  return name in OAUTH_PROVIDERS;
}

/** Provider ids that support real OAuth login (drives the GUI's "Log in with …" buttons). */
export function listOAuthProviders(): string[] {
  return Object.keys(OAUTH_PROVIDERS);
}

export async function refreshOAuthCredential(
  provider: string,
  refreshToken: string,
): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  return def.refresh(refreshToken);
}


/** Return a valid access token, refreshing + persisting if expired. Throws if not logged in. */
export async function getValidAccessToken(provider: string): Promise<string> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  const cred = getCredential(provider);
  if (!cred) throw new Error(`Not logged in to ${provider}. Run: frogp login ${provider}`);
  if (cred.expires > Date.now() + REFRESH_SKEW_MS) return cred.access;
  const fresh = await refreshOAuthCredential(provider, cred.refresh);
  saveCredential(provider, fresh);
  return fresh.access;
}

/**
 * Provider-correct `GET /models` request (URL + headers), so both model-listing paths fetch the
 * LIVE catalog correctly per adapter. Anthropic is the special case: its endpoint is `/v1/models`
 * (not `/models`), it needs `anthropic-version`, and it authenticates with `x-api-key` (key) or
 * `Authorization: Bearer` + the OAuth beta (oauth / claude-grant — both resolve a Claude subscription
 * Bearer token) — not a bare Bearer. Everyone else uses the OpenAI-style `/models` + Bearer. Response
 * shape is `{ data: [{ id, owned_by? }] }` for both.
 */
export function buildModelsRequest(prov: FrogProviderConfig, apiKey: string | undefined): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(prov.headers ?? {}) };
  if (isCodexBackendBaseUrl(prov.baseUrl)) {
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      Object.assign(headers, codexBackendHeaders(apiKey));
    }
    return { url: `${prov.baseUrl.replace(/\/$/, "")}/models?client_version=1.0.0`, headers };
  }
  if (prov.adapter === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (prov.authMode === "oauth" || prov.authMode === "claude-grant") {
      headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    return { url: `${prov.baseUrl}/v1/models?limit=1000`, headers };
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return { url: `${prov.baseUrl}/models`, headers };
}

/**
 * Refresh OAuth-managed provider presets (`models`, `noReasoningModels`, and a stale `defaultModel`)
 * from the registry so a proxy update that revises a provider's models — e.g. dropping deprecated
 * Claude snapshots or adding a new grok endpoint not in the live `/models` — reaches EXISTING
 * configs on the next `frogp start`, instead of only fresh installs. The live `/models` fetch stays
 * the primary source; this keeps the static fallback (and models-not-in-/models) current.
 *
 * Only touches providers that are registry-managed AND still `authMode: "oauth"`, and only the
 * preset fields (never apiKey/baseUrl/user toggles). Persists + returns true when anything changed.
 */
function cloneProviderField(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

const OAUTH_RECONCILE_FIELDS: (keyof FrogProviderConfig)[] = [
  "models",
  "contextWindow",
  "modelContextWindows",
  "modelCapabilities",
  "noReasoningModels",
  "reasoningEfforts",
  "modelReasoningEfforts",
  "reasoningEffortMap",
  "modelReasoningEffortMap",
  "noTemperatureModels",
  "noTopPModels",
  "noPenaltyModels",
  "autoToolChoiceOnlyModels",
  "preserveReasoningContentModels",
];

function hasStoredCredential(provider: string): boolean {
  return !!getCredential(provider);
}

export function restoreCredentialedOAuthProviderConfigs(
  config: FrogConfig,
  hasCredential: (provider: string) => boolean = hasStoredCredential,
): boolean {
  let changed = false;
  for (const [name, def] of Object.entries(OAUTH_PROVIDERS)) {
    if (config.providers[name]) continue;
    if (!hasCredential(name)) continue;
    config.providers[name] = { ...def.providerConfig };
    changed = true;
  }
  return changed;
}

export function reconcileOAuthProviderConfig(
  config: FrogConfig,
  hasCredential: (provider: string) => boolean = hasStoredCredential,
): boolean {
  let changed = restoreCredentialedOAuthProviderConfigs(config, hasCredential);
  for (const [name, prov] of Object.entries(config.providers)) {
    const def = OAUTH_PROVIDERS[name];
    if (!def || prov.authMode !== "oauth") continue;
    const preset = def.providerConfig;
    for (const field of OAUTH_RECONCILE_FIELDS) {
      if (JSON.stringify(prov[field]) === JSON.stringify(preset[field])) continue;
      if (preset[field] !== undefined) {
        prov[field] = cloneProviderField(preset[field]) as never;
      } else {
        delete prov[field];
      }
      changed = true;
    }
    // Heal a defaultModel that no longer exists in the refreshed list (e.g. a deprecated snapshot).
    if (prov.defaultModel && preset.defaultModel && !(prov.models ?? []).includes(prov.defaultModel)) {
      prov.defaultModel = preset.defaultModel;
      changed = true;
    }
  }
  return changed;
}

export function reconcileOAuthProviders(config: FrogConfig): boolean {
  const changed = reconcileOAuthProviderConfig(config);
  if (changed) saveConfig(config);
  return changed;
}

/** Add/refresh an OAuth provider's config entry on a config object (does not persist). */
export function upsertOAuthProvider(config: FrogConfig, provider: string): boolean {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return false;
  const next = { ...def.providerConfig };
  const changed = JSON.stringify(config.providers[provider]) !== JSON.stringify(next);
  config.providers[provider] = next;
  return changed;
}

/**
 * List OAuth-managed provider rows that currently lack stored credentials.
 * Missing credentials should make the route report "not logged in"; they must not
 * erase provider/default settings on start, status polling, or logout.
 */
export function loggedOutOAuthProviders(
  config: FrogConfig,
  hasCredential: (provider: string) => boolean = provider => !!getCredential(provider),
): string[] {
  return Object.entries(config.providers)
    .filter(([provider, prov]) => prov.authMode === "oauth" && !!OAUTH_PROVIDERS[provider] && !hasCredential(provider))
    .map(([provider]) => provider);
}

/** Run the login flow, persist the credential + upsert the provider entry to disk, return cred. */
export async function runLogin(provider: string, ctrl: OAuthController): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  const cred = await def.login(ctrl);
  saveCredential(provider, cred);
  const config = loadConfig();
  upsertOAuthProvider(config, provider);
  saveConfig(config);
  return cred;
}

/**
 * GUI async login: start the flow, return the auth URL EARLY (the flow keeps running in the
 * background until the callback server captures the redirect), with a concurrency guard and an
 * error surfaced via getLoginStatus().
 */
type LoginAuthInfo = { url: string; instructions?: string; code?: string };
interface LoginFlowState {
  attemptId: string;
  startedAt: number;
  controller: AbortController;
  error?: string;
  done: boolean;
  auth?: LoginAuthInfo;
  authPromise: Promise<LoginAuthInfo>;
}
const LOGIN_FLOW_STALE_MS = 5 * 60 * 1000;
const loginState = new Map<string, LoginFlowState>();

export function getLoginStatus(provider: string): { loggedIn: boolean; email?: string; error?: string } {
  const cred = getCredential(provider);
  const st = loginState.get(provider);
  return { loggedIn: !!cred, email: cred?.email, error: st?.error };
}

export function clearLoginState(provider: string): void {
  const state = loginState.get(provider);
  if (state && !state.done) state.controller.abort("login_state_cleared");
  loginState.delete(provider);
}

export async function startLoginFlow(
  provider: string,
  opts: { onComplete?: () => void | Promise<void>; restart?: boolean; now?: () => number } = {},
): Promise<LoginAuthInfo> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);

  const now = opts.now ?? Date.now;
  const existing = loginState.get(provider);
  if (existing && !existing.done) {
    const stale = now() - existing.startedAt >= LOGIN_FLOW_STALE_MS;
    if (!opts.restart && !stale) {
      if (existing.auth) return existing.auth;
      return existing.authPromise;
    }
    existing.controller.abort(opts.restart ? "login_restarted" : "login_timed_out");
    loginState.delete(provider);
  }

  let resolveAuth!: (info: LoginAuthInfo) => void;
  let rejectAuth!: (err: unknown) => void;
  const authPromise = new Promise<LoginAuthInfo>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });
  const controller = new AbortController();
  const state: LoginFlowState = {
    attemptId: crypto.randomUUID(),
    startedAt: now(),
    controller,
    done: false,
    authPromise,
  };
  loginState.set(provider, state);

  let urlResolved = false;
  const ctrl: OAuthController = {
    onAuth: ({ url, instructions, code }) => {
      if (loginState.get(provider)?.attemptId !== state.attemptId) return;
      urlResolved = true;
      const auth = { url, instructions, ...(code ? { code } : {}) };
      state.auth = auth;
      resolveAuth(auth);
    },
    onProgress: () => {},
    signal: controller.signal,
  };

  // Background: runLogin persists the credential + upserts the provider entry to disk config.
  runLogin(provider, ctrl)
    .then(async () => {
      if (loginState.get(provider)?.attemptId !== state.attemptId) return;
      await opts.onComplete?.();
      state.done = true;
      // Local-token import for providers that support it completes WITHOUT firing onAuth —
      // resolve so the GUI call returns instead of hanging.
      if (!urlResolved) resolveAuth({ url: "", instructions: "Logged in via an existing local CLI token — no browser needed." });
    })
    .catch((e: unknown) => {
      if (!urlResolved) rejectAuth(e);
      if (loginState.get(provider)?.attemptId !== state.attemptId) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Raw provider error bodies stay on stderr only; management responses get an enum code.
      console.error(`[oauth] ${provider} login failed: ${msg}`);
      state.done = true;
      state.error = "oauth_login_failed";
    });
  return authPromise;
}
