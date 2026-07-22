import type {
  FrogConfig,
  FrogParsedRequest,
  FrogProviderConfig,
  FrogWebSearchNotice,
  FrogWebSearchRequest,
  FrogWebSearchSkipReason,
} from "../types";
import { resolveModelCapabilities, supportsImageInput, supportsNativeWebSearch } from "../model-capabilities";
import { isOpenAIResponsesFallbackProvider } from "../fallback-openai-responses";
import type { WebSearchFallbackSettings } from "./executor";
import { resolveSearchApiProvider, type ResolvedSearchApiProvider } from "./search-api";
import { resolveNoKeySettings, type NoKeySearchSettings } from "./no-key";

export { runWithWebSearch } from "./loop";
export { buildWebSearchTool, extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";
export { executeSearchEvidence, type PanelSearchTier, type SearchEvidence } from "./panel-search";

const DEFAULT_FALLBACK_MODEL = "gpt-5.4-mini";
// "low" is the lightest effort the ChatGPT backend allows with web_search ("minimal" is rejected:
// "tools cannot be used with reasoning.effort 'minimal'") — keeps the fallback fast/cheap.
const DEFAULT_FALLBACK_REASONING = "low";
const DEFAULT_MAX_SEARCHES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

function hasUsableForwardAuthorization(headers: Headers): boolean {
  const value = headers.get("authorization")?.trim();
  return !!value && value !== "local-frogprogsy" && !/^Bearer\s+local-frogprogsy$/i.test(value);
}

/** Configured OpenAI Responses helper provider — forward-auth, OAuth, or API-key backed. */
function findForwardProviderEntry(config: FrogConfig, preferredName?: string): { name: string; provider: FrogProviderConfig } | undefined {
  if (preferredName && isOpenAIResponsesFallbackProvider(config.providers[preferredName])) {
    return { name: preferredName, provider: config.providers[preferredName] };
  }
  for (const [name, prov] of Object.entries(config.providers)) {
    if (isOpenAIResponsesFallbackProvider(prov)) return { name, provider: prov };
  }
  return undefined;
}

export function findForwardProvider(config: FrogConfig, preferredName?: string): FrogProviderConfig | undefined {
  return findForwardProviderEntry(config, preferredName)?.provider;
}

export interface WebSearchNativePlan {
  tier: "native";
  request: FrogWebSearchRequest;
  skippedReasonCodes: [];
  nativeCapabilitySource: string;
}

export interface WebSearchFallbackPlan {
  tier: "fallback_model";
  request: FrogWebSearchRequest;
  skippedReasonCodes: FrogWebSearchSkipReason[];
  notice: FrogWebSearchNotice;
  forwardProvider: FrogProviderConfig;
  forwardProviderName: string;
  hostedTool: Record<string, unknown>;
  settings: WebSearchFallbackSettings;
  maxSearches: number;
}

export interface WebSearchUnavailablePlan {
  tier: "unavailable";
  request: FrogWebSearchRequest;
  skippedReasonCodes: FrogWebSearchSkipReason[];
  notice: FrogWebSearchNotice;
}

export interface WebSearchApiPlan {
  tier: "search_api";
  request: FrogWebSearchRequest;
  skippedReasonCodes: FrogWebSearchSkipReason[];
  notice: FrogWebSearchNotice;
  apiProvider: ResolvedSearchApiProvider;
}

export interface WebSearchNoKeyPlan {
  tier: "no_key";
  request: FrogWebSearchRequest;
  skippedReasonCodes: FrogWebSearchSkipReason[];
  notice: FrogWebSearchNotice;
  settings: NoKeySearchSettings;
}

export type WebSearchLadderPlan = WebSearchNativePlan | WebSearchFallbackPlan | WebSearchApiPlan | WebSearchNoKeyPlan | WebSearchUnavailablePlan;

function webSearchRequestFromLegacyHosted(tool: Record<string, unknown>): FrogWebSearchRequest {
  return {
    kind: "openai_hosted",
    source: "openai_responses",
    type: typeof tool.type === "string" ? tool.type : "web_search",
    raw: tool,
    ...(typeof tool.search_context_size === "string" ? { searchContextSize: tool.search_context_size } : {}),
    ...(typeof tool.max_uses === "number" ? { maxUses: tool.max_uses } : {}),
  };
}

function requestedWebSearch(parsed: FrogParsedRequest): FrogWebSearchRequest | undefined {
  return parsed._webSearchRequest ?? (parsed._webSearch ? webSearchRequestFromLegacyHosted(parsed._webSearch) : undefined);
}

function fallbackHostedTool(parsed: FrogParsedRequest, request: FrogWebSearchRequest): Record<string, unknown> | undefined {
  if (parsed._webSearch) return parsed._webSearch;
  if (request.kind === "openai_hosted") return request.raw;
  if (request.kind === "anthropic_server") {
    return {
      type: "web_search",
      ...(request.searchContextSize ? { search_context_size: request.searchContextSize } : {}),
    };
  }
  return undefined;
}

function notice(tier: FrogWebSearchNotice["tier"], reasonCodes: FrogWebSearchSkipReason[]): FrogWebSearchNotice {
  return {
    tier,
    reasonCodes,
    message: tier === "fallback_model"
      ? "Native web_search is unavailable for the selected model; using the configured search fallback model."
      : tier === "search_api"
        ? "Native web_search and fallback-model search are unavailable; using the configured key-based search API."
        : tier === "no_key"
          ? "Native, fallback-model, and key-based search are unavailable; using the in-process no-key best-effort fallback."
          : "web_search could not collect enough usable evidence; the answer must say 근거 부족 with attempted paths and reasons.",
  };
}

function fallbackSettings(
  cfg: NonNullable<FrogConfig["webSearchFallback"]>,
  providerName: string,
  provider: FrogProviderConfig,
  modelId: string,
): WebSearchFallbackSettings {
  return {
    model: cfg.model ?? DEFAULT_FALLBACK_MODEL,
    reasoning: cfg.reasoning ?? DEFAULT_FALLBACK_REASONING,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    describeImages: supportsImageInput(resolveModelCapabilities(providerName, provider, modelId)) === false,
  };
}
function resolveConfiguredSearchApi(cfg: NonNullable<FrogConfig["webSearchFallback"]>): { provider?: ResolvedSearchApiProvider; reason?: FrogWebSearchSkipReason } {
  let reason: FrogWebSearchSkipReason | undefined;
  for (const [key, value] of Object.entries(cfg.searchProviders ?? {})) {
    const resolved = resolveSearchApiProvider(key, value);
    if (!resolved) continue;
    if ("error" in resolved) {
      reason ??= resolved.error === "missing_key" ? "search_api_key_missing" : "search_api_provider_unsupported";
      continue;
    }
    return { provider: resolved };
  }
  return { reason };
}

export function resolveWebSearchLadderPlan(
  config: FrogConfig,
  parsed: FrogParsedRequest,
  incomingHeaders: Headers,
  providerName: string,
  provider: FrogProviderConfig,
  modelId: string,
): WebSearchLadderPlan | undefined {
  const request = requestedWebSearch(parsed);
  if (!request) return undefined;

  const capabilities = resolveModelCapabilities(providerName, provider, modelId);
  const nativeSupported = supportsNativeWebSearch(capabilities);
  const nativeEligible = provider.adapter === "anthropic" && request.kind === "anthropic_server";
  if (nativeEligible && nativeSupported === true) {
    return {
      tier: "native",
      request,
      skippedReasonCodes: [],
      nativeCapabilitySource: capabilities.webSearchSource,
    };
  }

  const skippedReasonCodes: FrogWebSearchSkipReason[] = [];
  if (!nativeEligible) skippedReasonCodes.push("primary_provider_not_anthropic_messages");
  else if (nativeSupported === false) skippedReasonCodes.push("primary_model_no_native_web_search");
  else skippedReasonCodes.push("primary_model_web_search_unknown");

  const cfg = config.webSearchFallback ?? {};
  const hostedTool = fallbackHostedTool(parsed, request);
  if (cfg.enabled === true) {
    const forwardProviderEntry = findForwardProviderEntry(config, cfg.provider);
    if (!forwardProviderEntry) {
      skippedReasonCodes.push("fallback_model_provider_unavailable");
    } else if (forwardProviderEntry.provider.authMode === "forward" && !hasUsableForwardAuthorization(incomingHeaders)) {
      skippedReasonCodes.push("fallback_model_forward_auth_missing");
    } else if (!hostedTool) {
      skippedReasonCodes.push("fallback_model_hosted_tool_unavailable");
    } else {
      return {
        tier: "fallback_model",
        request,
        skippedReasonCodes,
        notice: notice("fallback_model", skippedReasonCodes),
        forwardProvider: forwardProviderEntry.provider,
        forwardProviderName: forwardProviderEntry.name,
        hostedTool,
        settings: fallbackSettings(cfg, providerName, provider, modelId),
        maxSearches: cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES,
      };
    }
  } else {
    skippedReasonCodes.push("fallback_model_not_enabled");
  }

  const searchApi = resolveConfiguredSearchApi(cfg);
  if (searchApi.provider) {
    return {
      tier: "search_api",
      request,
      skippedReasonCodes,
      notice: notice("search_api", skippedReasonCodes),
      apiProvider: searchApi.provider,
    };
  }
  skippedReasonCodes.push(searchApi.reason ?? "search_api_not_configured");
  if (cfg.noKey?.enabled === true) {
    return {
      tier: "no_key",
      request,
      skippedReasonCodes,
      notice: notice("no_key", skippedReasonCodes),
      settings: resolveNoKeySettings(cfg.noKey),
    };
  }
  skippedReasonCodes.push("no_key_fallback_not_configured");

  return {
    tier: "unavailable",
    request,
    skippedReasonCodes,
    notice: notice("unavailable", skippedReasonCodes),
  };
}

/**
 * Plans the optional hosted-search fallback. It is disabled by default and only runs when a caller
 * explicitly enables `webSearchFallback`, requests hosted `web_search`, uses a non-native route,
 * and has an OpenAI Responses forward/OAuth/key helper provider configured.
 */
export function planWebSearch(
  config: FrogConfig,
  parsed: FrogParsedRequest,
  usesNativeWebSearch: boolean,
  incomingHeaders: Headers,
  providerName: string,
  provider: FrogProviderConfig,
  modelId: string,
): WebSearchFallbackPlan | undefined {
  const resolved = resolveWebSearchLadderPlan(config, parsed, incomingHeaders, providerName, provider, modelId);
  if (!resolved || resolved.tier !== "fallback_model" || usesNativeWebSearch) return undefined;
  return resolved;
}
