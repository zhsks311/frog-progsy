import { buildModelsRequest } from "./oauth/index";
import { collectProviderSecrets, normalizeProviderTestError, redactProviderForApi } from "./provider-redaction";
import { ClaudeGrantError } from "./claude-grant-auth";
import { resolveProviderAuth } from "./provider-auth";
import type { FrogConfig, FrogProviderConfig } from "./types";

export type ProviderConnectionTestStatus = "ok" | "error" | "skipped";

export interface ProviderConnectionTestResult {
  ok: boolean;
  status: ProviderConnectionTestStatus;
  code: string;
  message: string;
  provider: string;
  adapter: string;
  authMode: FrogProviderConfig["authMode"] | "none";
  httpStatus?: number;
  modelCount?: number;
}

interface ProviderModelsResponse {
  data?: unknown;
  models?: unknown;
}

/**
 * Injectable seam for the shared provider-auth resolution. Production uses resolveProviderAuth
 * (config-dir-scoped grant / oauth / static dispatch); tests override it to exercise the grant
 * success and failure paths without touching a real Keychain or the network.
 */
export type ProviderAuthResolver = (config: FrogConfig | undefined, name: string, provider: FrogProviderConfig) => Promise<FrogProviderConfig>;

export interface ProviderConnectionTestOptions {
  /** Config used to resolve a `claude-grant` provider's scoped token through resolveProviderAuth; callers without it fail closed. */
  config?: FrogConfig;
  /** Test-only override for the provider-auth resolution seam; defaults to resolveProviderAuth. */
  resolveAuth?: ProviderAuthResolver;
}

type GrantAuthOutcome =
  | { ok: true; token: string }
  | { ok: false; code: "auth_missing" | "auth"; message: string };

function authModeFor(provider: FrogProviderConfig): ProviderConnectionTestResult["authMode"] {
  return provider.authMode ?? (provider.apiKey || provider.apiKeys?.length ? "key" : "none");
}

function baseResult(name: string, provider: FrogProviderConfig): Omit<ProviderConnectionTestResult, "ok" | "status" | "code" | "message"> {
  return {
    provider: name,
    adapter: provider.adapter,
    authMode: authModeFor(provider),
  };
}

function modelItemsFromResponse(json: ProviderModelsResponse): unknown[] | undefined {
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.models)) return json.models;
  return undefined;
}

async function responseMessage(response: Response): Promise<string> {
  return `Provider models request failed with HTTP ${response.status}`;
}

/**
 * Map a claude-grant resolution failure to a typed, fail-closed provider-test error. Messages are
 * fixed constants so no grant id, token, path, or other raw detail can leak into API responses.
 */
function classifyGrantAuthError(error: unknown): { code: "auth_missing" | "auth"; message: string } {
  if (error instanceof ClaudeGrantError) {
    if (error.code === "not_bound" || error.code === "no_credential") {
      return { code: "auth_missing", message: "Claude grant is not bound or has no stored credential." };
    }
    return { code: "auth", message: "Claude grant credential needs re-authentication and could not be refreshed." };
  }
  return { code: "auth", message: "Claude grant authentication failed." };
}

/**
 * Resolve a claude-grant provider's token through the shared resolveProviderAuth seam, failing closed
 * (never attempting a network fetch) on a missing config or any resolution error.
 */
async function resolveGrantAuth(name: string, provider: FrogProviderConfig, options: ProviderConnectionTestOptions): Promise<GrantAuthOutcome> {
  if (!options.config) {
    return { ok: false, code: "auth_missing", message: "Claude grant is not available for this provider connection test." };
  }
  const resolveAuth = options.resolveAuth ?? resolveProviderAuth;
  try {
    const resolved = await resolveAuth(options.config, name, provider);
    const token = resolved.apiKey;
    if (!token) return { ok: false, code: "auth_missing", message: "Claude grant did not return an access token." };
    return { ok: true, token };
  } catch (error) {
    return { ok: false, ...classifyGrantAuthError(error) };
  }
}

export async function testProviderConnection(name: string, provider: FrogProviderConfig, options: ProviderConnectionTestOptions = {}): Promise<ProviderConnectionTestResult> {
  const resultBase = baseResult(name, provider);
  const redactedProvider = redactProviderForApi(provider);

  if (provider.authMode === "forward") {
    return {
      ...resultBase,
      ok: false,
      status: "skipped",
      code: "forward_auth_unsupported",
      message: "Forward-auth providers require caller credentials and cannot be tested from saved provider configuration.",
    };
  }

  let apiKey: string | undefined;
  if (provider.authMode === "claude-grant") {
    const grant = await resolveGrantAuth(name, provider, options);
    if (!grant.ok) {
      return {
        ...resultBase,
        ok: false,
        status: "error",
        code: grant.code,
        message: grant.message,
      };
    }
    apiKey = grant.token;
  } else {
    // key/oauth route through the central resolveProviderAuth seam (identical dispatch to the
    // primary surfaces). `key` never throws (resolves the `${ENV}`/`apiKeys` candidate); `oauth`
    // fails closed when not logged in — surface the existing skipped code instead of a probe.
    const resolveAuth = options.resolveAuth ?? resolveProviderAuth;
    try {
      apiKey = (await resolveAuth(options.config, name, provider)).apiKey;
    } catch {
      apiKey = undefined;
    }
    if (provider.authMode === "oauth" && !apiKey) {
      return {
        ...resultBase,
        ok: false,
        status: "skipped",
        code: "oauth_not_logged_in",
        message: "OAuth provider is not logged in.",
      };
    }
  }

  const request = buildModelsRequest(provider, apiKey);
  const secrets = collectProviderSecrets(provider, [apiKey ?? "", ...Object.values(request.headers)]);

  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const normalized = normalizeProviderTestError(await responseMessage(response), {
        provider,
        secrets,
        httpStatus: response.status,
      });
      return {
        ...resultBase,
        ok: false,
        status: "error",
        code: normalized.code,
        httpStatus: response.status,
        message: normalized.message,
      };
    }

    const json = await response.json().catch(error => {
      throw new Error(`Provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }) as ProviderModelsResponse;
    const models = modelItemsFromResponse(json);
    if (!models) {
      return {
        ...resultBase,
        ok: false,
        status: "error",
        code: "invalid_models_response",
        httpStatus: response.status,
        message: "Provider models response did not include a data or models array.",
      };
    }

    return {
      ...resultBase,
      ok: true,
      status: "ok",
      code: "ok",
      httpStatus: response.status,
      modelCount: models.length,
      message: `Connected to ${redactedProvider.adapter} provider and read ${models.length} model${models.length === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    const normalized = normalizeProviderTestError(error, { provider, secrets });
    return {
      ...resultBase,
      ok: false,
      status: "error",
      code: normalized.code,
      message: normalized.message,
      ...(normalized.httpStatus !== undefined ? { httpStatus: normalized.httpStatus } : {}),
    };
  }
}
