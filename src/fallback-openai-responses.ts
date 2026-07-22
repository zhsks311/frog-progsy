import { FORWARD_HEADERS } from "./adapters/openai-responses";
import { resolveEnvValue } from "./config";
import { codexBackendHeaders, isCodexBackendBaseUrl } from "./oauth/codex";
import { resolveProviderAuth } from "./provider-auth";
import type { FrogConfig, FrogProviderConfig } from "./types";

/**
 * Thrown when a `claude-grant` provider is (wrongly) routed to the openai-responses image/web-search
 * fallback. FC5 credential isolation: an Anthropic subscription grant token is bound to its Anthropic
 * provider only and MUST NEVER be attached to this non-Anthropic fallback. The fallback rejects the
 * mode outright — before any credential store or network access — and never degrades to another
 * credential/provider. The message carries no token, path, or credential text.
 */
export class OpenAIResponsesFallbackAuthError extends Error {
  readonly code = "claude_grant_not_allowed" as const;
  constructor() {
    super("openai-responses fallback does not accept claude-grant auth; a Claude subscription grant is bound to its Anthropic provider only");
    this.name = "OpenAIResponsesFallbackAuthError";
  }
}

/**
 * The openai-responses image/web-search fallback accepts only `forward`, `oauth`, and static `key`
 * providers. A `claude-grant` provider is deliberately EXCLUDED (FC5): its grant token belongs to the
 * bound Anthropic provider and must never reach this non-Anthropic surface, so it is never selectable
 * as a fallback in the first place.
 */
export function isOpenAIResponsesFallbackProvider(provider: FrogProviderConfig | undefined): provider is FrogProviderConfig {
  if (!provider || provider.adapter !== "openai-responses") return false;
  if (provider.authMode === "claude-grant") return false;
  if (provider.authMode === "forward" || provider.authMode === "oauth") return true;
  return !!resolveEnvValue(provider.apiKey);
}

/**
 * Resolve the request-scoped auth for an openai-responses fallback provider through the common
 * `resolveProviderAuth` seam, so `key`/`oauth`/`forward` behave identically to the primary surfaces:
 * `key` keeps its `${ENV}`/`apiKeys` static resolution, `oauth` resolves a stored token (and requires
 * a provider name), and `forward` injects no key (its adapter relays only allowlisted caller headers).
 *
 * FC5 fail-closed: a `claude-grant` provider is rejected here with a fixed typed error BEFORE any
 * credential store or network access, and never falls back to another credential/provider. Selection
 * already excludes it (`isOpenAIResponsesFallbackProvider`); this is defense-in-depth for a direct
 * caller. Non-grant modes do not consume config; callers may omit it without loading unrelated global state.
 */
export function resolveOpenAIResponsesFallbackProvider(
  providerName: string | undefined,
  provider: FrogProviderConfig,
  config?: FrogConfig,
): Promise<FrogProviderConfig> {
  if (provider.authMode === "claude-grant") {
    return Promise.reject(new OpenAIResponsesFallbackAuthError());
  }
  if (provider.authMode === "oauth" && !providerName) {
    return Promise.reject(new Error("oauth fallback provider requires a provider name"));
  }
  return resolveProviderAuth(config, providerName ?? "", provider);
}

export function buildOpenAIResponsesFallbackFetch(
  provider: FrogProviderConfig,
  incomingHeaders: Headers,
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.headers) Object.assign(headers, provider.headers);

  const codexBackend = isCodexBackendBaseUrl(provider.baseUrl);
  const base = provider.baseUrl.replace(/\/$/, "");
  const url = provider.authMode === "forward" || codexBackend
    ? `${base}/responses`
    : `${provider.baseUrl.replace(/\/v1\/?$/, "")}/v1/responses`;

  if (provider.authMode === "forward") {
    for (const header of FORWARD_HEADERS) {
      const value = incomingHeaders.get(header);
      if (value) headers[header] = value;
    }
  } else {
    const apiKey = resolveEnvValue(provider.apiKey);
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      if (codexBackend) Object.assign(headers, codexBackendHeaders(apiKey));
    }
  }

  return { url, headers };
}
