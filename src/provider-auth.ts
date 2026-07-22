/**
 * Common async provider-auth resolution seam (Branch-B integration).
 *
 * Every direct provider-auth acquisition point (coordinator, mix turn, Responses, messages/retry,
 * count_tokens, provider availability, and the OpenAI-Responses fallback) resolves a request-scoped
 * access credential through this one function, so auth-mode behavior stays identical across surfaces:
 *
 *   - "oauth":        resolve a stored OAuth access token (auto-refreshed) and use it as the Bearer key.
 *   - "claude-grant": resolve an isolated, config-dir-scoped Claude subscription grant token (auto-refreshed).
 *   - "forward":      no key injection — `apiKey` is cleared; the adapter relays allowlisted caller auth headers.
 *   - "key"/default:  resolve the static key with the established `${ENV}`/`apiKeys` candidate priority.
 *
 * The resolver returns a shallow COPY of the provider with the request-specific `apiKey`; it never
 * mutates the shared config or the input provider. `claude-grant` failures surface as the core's typed
 * `ClaudeGrantError`, whose message is constructed to never contain token/path/credential text.
 *
 * Import direction is one-way (`provider-auth` -> `oauth/index`, `claude-grant-auth`) to avoid cycles:
 * low-level resolvers never import this seam back.
 */
import { resolveEnvValue } from "./config";
import { getClaudeGrantAccessToken, ClaudeGrantError } from "./claude-grant-auth";
import { getValidAccessToken } from "./oauth/index";
import { effectiveKeyCandidates } from "./provider-keys";
import type { FrogConfig, FrogProviderConfig } from "./types";

export interface ProviderAuthDeps {
  /** Resolve a stored OAuth access token (auto-refreshed). */
  getOAuthAccessToken: (providerName: string) => Promise<string>;
  /** Resolve an isolated, config-dir-scoped Claude subscription grant token (auto-refreshed). */
  getClaudeGrantAccessToken: (config: FrogConfig, providerName: string, provider: FrogProviderConfig) => Promise<string>;
  /** Resolve `${ENV}` / `$ENV` static-key references. */
  resolveEnvValue: (value: string | undefined) => string | undefined;
  /** Optional guard asserting a `claude-grant` provider targets only the real Anthropic API, run
   *  BEFORE the broker. Defaults to the strict production check; tests may override to admit fixtures. */
  validateClaudeGrantTarget?: (provider: FrogProviderConfig) => void;
}

const defaultProviderAuthDeps: ProviderAuthDeps = {
  getOAuthAccessToken: getValidAccessToken,
  getClaudeGrantAccessToken,
  resolveEnvValue,
};

/** Options for the claude-grant target guard. `allowReservedTestHosts` is test-only and MUST stay off in production. */
export interface ClaudeGrantTargetOptions {
  /** Admit reserved-for-testing hostnames (`.test` / `.example`) that never resolve in real DNS. Test fixtures only. */
  allowReservedTestHosts?: boolean;
}

// Fixed, redacted message — never interpolates the rejected host, path, port, grant id, or any token.
const CLAUDE_GRANT_INVALID_TARGET_MESSAGE =
  "claude-grant provider is not bound to a valid Claude subscription endpoint.";

/**
 * True only when `provider` is a safe claude-grant target: the `anthropic` adapter over HTTPS to
 * exactly `api.anthropic.com`, with no embedded credentials, the default (or 443) port, no query or
 * fragment, and a path of ``, `/`, or `/v1`. A subscription (grant) Bearer must NEVER be sent to any
 * other Anthropic-compatible host, so everything else is rejected. Reserved `.test`/`.example` hosts
 * are admitted only when `allowReservedTestHosts` is explicitly set (test fixtures), never by default.
 */
export function isAllowedClaudeGrantBaseUrl(provider: FrogProviderConfig, options: ClaudeGrantTargetOptions = {}): boolean {
  if (provider.adapter !== "anthropic") return false;
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  if (url.search !== "" || url.hash !== "") return false;
  if (url.pathname !== "" && url.pathname !== "/" && url.pathname !== "/v1") return false;
  const host = url.hostname.toLowerCase();
  if (host === "api.anthropic.com") return true;
  if (options.allowReservedTestHosts && (host.endsWith(".test") || host.endsWith(".example"))) return true;
  return false;
}

/**
 * Fail closed unless `provider` is an allowed claude-grant target (see `isAllowedClaudeGrantBaseUrl`).
 * Throws the typed, fixed, redacted `ClaudeGrantError` so no rejected host/path/grant material leaks.
 */
export function assertAllowedClaudeGrantTarget(provider: FrogProviderConfig, options: ClaudeGrantTargetOptions = {}): void {
  if (!isAllowedClaudeGrantBaseUrl(provider, options)) {
    throw new ClaudeGrantError("not_bound", CLAUDE_GRANT_INVALID_TARGET_MESSAGE);
  }
}

/**
 * Resolve the request-scoped auth for a provider and return a provider COPY with `apiKey` set.
 *
 * Throws on oauth/claude-grant resolution failure (fail-closed); each callsite keeps its own error
 * contract (401 response, retry log, `auth_missing`, …) by wrapping this call. The returned object is
 * always a fresh copy, so callers may pass a shared config/provider without risking mutation.
 */
export async function resolveProviderAuth(
  config: FrogConfig | undefined,
  providerName: string,
  provider: FrogProviderConfig,
  deps: ProviderAuthDeps = defaultProviderAuthDeps,
): Promise<FrogProviderConfig> {
  // Dereference a `${ENV}` static key once as a base; every mode below overwrites `apiKey` with its
  // own request-scoped credential (`forward` deliberately clears it — see below).
  const resolved: FrogProviderConfig = { ...provider, apiKey: deps.resolveEnvValue(provider.apiKey) };
  switch (provider.authMode) {
    case "oauth":
      resolved.apiKey = await deps.getOAuthAccessToken(providerName);
      break;
    case "claude-grant":
      // A subscription (grant) Bearer must only ever reach the real Anthropic API. Validate the
      // target BEFORE the broker so an invalid / Anthropic-compatible-host binding fails closed with
      // a fixed redacted error and zero broker/network calls.
      (deps.validateClaudeGrantTarget ?? assertAllowedClaudeGrantTarget)(provider);
      if (!config) {
        throw new ClaudeGrantError("not_bound", "claude grant configuration is unavailable", provider.claudeGrantId);
      }
      resolved.apiKey = await deps.getClaudeGrantAccessToken(config, providerName, provider);
      break;
    case "forward":
      // No key injection: explicitly clear any (possibly stale) static key so it can never be
      // injected as a credential; the adapter relays only allowlisted caller auth headers.
      resolved.apiKey = undefined;
      break;
    default:
      // "key"/undefined: resolve the static key through the established `${ENV}` + `apiKeys`
      // candidate priority, so an `apiKeys`-only provider still resolves its first usable key
      // (identical to `effectiveKeyCandidates(provider)[0]`). Never throws.
      resolved.apiKey = effectiveKeyCandidates(provider)[0]?.key;
      break;
  }
  return resolved;
}
