import type { FrogAssistantContentPart, FrogConfig, FrogContentPart, FrogParsedRequest, FrogProviderConfig } from "./types";
import { resolveEnvValue } from "./config";
import { deterministicModelAlias, resolveConfiguredModelAlias, GATEWAY_MODEL_ALIAS_PREFIX } from "./model-aliases";

/**
 * Which resolution stage produced a route. Recorded on every route-log entry so "why did this
 * request route here" is answerable from the log. There is intentionally NO `"ambiguous"` value:
 * the routeKind always reports the REAL resolving stage, and a tie-break that chose among >1
 * candidate is recorded separately via `ambiguousCandidates`.
 */
export type RouteKind =
  | "alias"
  | "qualified"
  | "client-default"
  | "exact-default"
  | "exact-model"
  | "family"
  | "default"
  | "long-context";

export interface RouteResult {
  providerName: string;
  provider: FrogProviderConfig;
  modelId: string;
  routeKind: RouteKind;
  /** Sorted candidate provider names when a lexicographic tie-break chose among >1 provider. */
  ambiguousCandidates?: string[];
  /** True when this route was produced by the auto-mode classifier (Haiku-class) resolver. */
  classifierRoute?: boolean;
  /** Non-fatal diagnostic emitted when a haiku-class model fell back to the provider's defaultModel. */
  warning?: string;
}

export interface LongContextRouteInput {
  modelId: string;
  context?: FrogParsedRequest["context"];
  prompt?: string;
  input?: unknown;
  /** Caller-provided model ids/aliases that are already resolved and must not be long-context overridden. */
  protectedModelIds?: string[];
  /** Already-resolved route kind from an outer routing stage; alias/qualified routes remain protected. */
  resolvedRouteKind?: RouteKind;
}


/**
 * Client built-in model-id prefixes. Claude Code emits unqualified `claude-*` ids as its built-in
 * default; when the user's default provider is non-Anthropic those are redirected to the default
 * route. This is a client contract, NOT provider data, so it stays a small explicit constant.
 */
const CLIENT_DEFAULT_PREFIXES = ["claude-"] as const;
const REMOVED_ROUTED_MODEL_PREFIXES = [`claude-${"frogprogsy"}-`, `claude-${"open"}-${"claudecode"}-`] as const;

function isRemovedRoutedModelAlias(modelId: string): boolean {
  return REMOVED_ROUTED_MODEL_PREFIXES.some(prefix => modelId.startsWith(prefix));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function estimateSerializedTokens(value: unknown): number {
  if (typeof value === "string") return estimateTextTokens(value);
  try {
    const serialized = JSON.stringify(value);
    return estimateTextTokens(serialized ?? "");
  } catch {
    return estimateTextTokens(String(value));
  }
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateContentTokens(content: string | (FrogContentPart | FrogAssistantContentPart)[] | undefined): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const part of content) {
    if (part.type === "text") {
      tokens += estimateTextTokens(part.text);
    } else if (part.type === "image") {
      tokens += 256;
    } else if (part.type === "thinking") {
      tokens += estimateTextTokens(part.thinking);
    } else if (part.type === "toolCall") {
      tokens += estimateSerializedTokens(part.arguments);
    }
  }
  return tokens;
}

function estimateInputTokens(input: LongContextRouteInput): number {
  let tokens = 0;
  if (input.prompt) tokens += estimateTextTokens(input.prompt);
  const context = input.context;
  if (context) {
    for (const system of context.systemPrompt ?? []) tokens += estimateTextTokens(system);
    for (const message of context.messages) {
      tokens += estimateContentTokens(message.content);
      if (message.role === "toolResult") {
        tokens += estimateTextTokens(message.toolName);
      }
    }
    for (const tool of context.tools ?? []) {
      tokens += estimateTextTokens(tool.name);
      tokens += estimateTextTokens(tool.description);
      tokens += estimateSerializedTokens(tool.parameters);
    }
  }
  if (input.input !== undefined) tokens += estimateSerializedTokens(input.input);
  return tokens;
}

function isQualifiedConfiguredModel(config: FrogConfig, modelId: string): boolean {
  const slash = modelId.indexOf("/");
  return slash > 0 && config.providers[modelId.slice(0, slash)] !== undefined;
}
function isConfigDerivedModelAlias(config: FrogConfig, alias: string): boolean {
  for (const [provider, cfg] of Object.entries(config.providers)) {
    const candidates = new Set<string>();
    if (cfg.defaultModel) candidates.add(cfg.defaultModel);
    for (const model of cfg.models ?? []) candidates.add(model);
    for (const model of candidates) {
      if (deterministicModelAlias(provider, model) === alias) return true;
    }
  }
  return false;
}

function isResolvedRouteProtected(input: LongContextRouteInput): boolean {
  return input.resolvedRouteKind === "alias" || input.resolvedRouteKind === "qualified";
}

function isProtectedModelId(input: LongContextRouteInput): boolean {
  return input.protectedModelIds?.includes(input.modelId) ?? false;
}


function normalizeLongContextInput(input: FrogParsedRequest | LongContextRouteInput | string): LongContextRouteInput {
  if (typeof input === "string") return { modelId: input };
  return input;
}

export function applyLongContextRoute(
  config: FrogConfig,
  request: FrogParsedRequest | LongContextRouteInput | string,
): RouteResult | null {
  const input = normalizeLongContextInput(request);
  const longContext = config.longContext;
  if (!longContext) return null;
  const threshold = longContext.thresholdTokens;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) return null;
  if (!isNonEmptyString(longContext.provider) || !isNonEmptyString(longContext.model)) return null;
  if (!config.providers[longContext.provider]) return null;
  if (isResolvedRouteProtected(input) || isProtectedModelId(input)) return null;
  if (isQualifiedConfiguredModel(config, input.modelId)) return null;
  if (isConfigDerivedModelAlias(config, input.modelId)) return null;
  if (estimateInputTokens(input) <= threshold) return null;
  return makeRoute(config, longContext.provider, longContext.model, "long-context");
}

interface CuratedFamily {
  family: string;
  /** Model-id prefixes that identify the family (each ends on a boundary char). */
  prefixes: string[];
  /**
   * Explicit, ordered provider-id allowlist. This is the ONLY candidate source for the family
   * fallback (it both restricts and orders). It is NOT provider-name equality on the requested id.
   */
  allowlist: string[];
  /** Adapter sanity guard: an allowlisted provider is skipped unless its adapter is one of these. */
  adapters: string[];
}

/**
 * Curated fallback for bare/undeclared family ids that no provider declares in `models[]`/
 * `defaultModel` (e.g. `gpt-4o`, `llama-3.1-70b`). Replaces the old `MODEL_PROVIDER_PATTERNS`
 * provider-NAME-equality table. Candidates come ONLY from `allowlist`; `adapters` is a guard, never
 * the candidate source — so a bare `gpt-*` can never leak to an unrelated `openai-chat` provider
 * (kimi/ollama/qwen-portal/...). Families with no entry here (gemini/qwen/...) intentionally fall
 * through to the default/throw tail, exactly as before this refactor.
 */
const CURATED_FAMILIES: CuratedFamily[] = [
  {
    family: "openai",
    prefixes: ["gpt-", "o1-", "o3-", "o4-"],
    allowlist: ["openai", "openai-apikey", "codex"],
    adapters: ["openai-responses", "openai-chat"],
  },
  {
    family: "groq",
    prefixes: ["llama-", "mixtral-", "gemma-"],
    allowlist: ["groq"],
    adapters: ["openai-chat"],
  },
  {
    family: "anthropic",
    prefixes: [...CLIENT_DEFAULT_PREFIXES],
    allowlist: ["anthropic"],
    adapters: ["anthropic"],
  },
];


function isAnthropicProviderName(name: string): boolean {
  return name === "anthropic" || name.startsWith("anthropic-");
}

function makeRoute(
  config: FrogConfig,
  providerName: string,
  modelId: string,
  routeKind: RouteKind,
  ambiguousCandidates?: string[],
): RouteResult {
  const provider = config.providers[providerName] as FrogProviderConfig;
  return {
    providerName,
    provider: { ...provider, apiKey: resolveEnvValue(provider.apiKey) },
    modelId,
    routeKind,
    ...(ambiguousCandidates ? { ambiguousCandidates } : {}),
  };
}

/**
 * Resolve a set of candidate provider names to a single deterministic winner.
 * - empty -> `null` (the calling stage is a no-op; resolution falls through; never throws)
 * - single -> that provider, no ambiguity
 * - multiple -> tier (a) the configured default provider if it is among the candidates (no
 *   ambiguity recorded), else tier (b) lexicographic provider-name sort (the sorted list is
 *   recorded as `ambiguousCandidates`). Insertion order is never consulted.
 */
function pickDeterministic(
  config: FrogConfig,
  candidates: string[],
): { providerName: string; ambiguousCandidates?: string[] } | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { providerName: candidates[0]! };
  if (candidates.includes(config.defaultProvider)) {
    return { providerName: config.defaultProvider };
  }
  const sorted = [...candidates].sort();
  return { providerName: sorted[0]!, ambiguousCandidates: sorted };
}
function defaultProviderRoute(config: FrogConfig, modelId: string, useDefaultModel: boolean): RouteResult | null {
  const defaultProv = config.providers[config.defaultProvider];
  if (!defaultProv) return null;
  return makeRoute(config, config.defaultProvider, useDefaultModel ? (defaultProv.defaultModel ?? modelId) : modelId, "client-default");
}

function isHaikuClassModelId(modelId: string): boolean {
  return modelId.startsWith("claude-haiku-") || modelId.startsWith("claude-3-5-haiku");
}

function resolveClassifierRoute(config: FrogConfig): RouteResult | null {
  const fb = config.classifierFallback;
  if (fb?.provider && fb.model) {
    const prov = config.providers[fb.provider];
    if (prov) {
      return { providerName: fb.provider, provider: { ...prov, apiKey: resolveEnvValue(prov.apiKey) }, modelId: fb.model, routeKind: "client-default", classifierRoute: true };
    }
  }
  const defaultProv = config.providers[config.defaultProvider];
  if (defaultProv?.classifierModel) {
    return { providerName: config.defaultProvider, provider: { ...defaultProv, apiKey: resolveEnvValue(defaultProv.apiKey) }, modelId: defaultProv.classifierModel, routeKind: "client-default", classifierRoute: true };
  }
  return null;
}



export function routeModel(config: FrogConfig, modelId: string): RouteResult {
  const providerNames = Object.keys(config.providers);

  // Claude Code's model picker can submit the literal "default" sentinel; map it to the configured
  // default provider's defaultModel when available.
  if (modelId === "default") {
    const defaultProv = config.providers[config.defaultProvider];
    if (defaultProv) {
      return makeRoute(config, config.defaultProvider, defaultProv.defaultModel ?? modelId, "client-default");
    }
  }

  if (isRemovedRoutedModelAlias(modelId)) {
    throw new Error(`Removed routed model alias "${modelId}" is not supported. Use a current gateway alias or provider/model namespace.`);
  }

  // s1. Configured model alias (deterministic frogprogsy alias or persisted alias).
  const alias = resolveConfiguredModelAlias(config, modelId);
  if (alias && config.providers[alias.provider]) {
    return makeRoute(config, alias.provider, alias.model, "alias");
  }

  // s1b. Fail closed on the gateway alias namespace. Any id carrying the current gateway alias
  //      prefix that did NOT resolve to a configured/persisted alias above (unknown, stale, or
  //      fabricated) must not drift into client-default/family/default routing — that would silently
  //      serve an unrelated model for a gateway id the client believes is exact. Throw a fixed,
  //      redacted error (no raw id echoed) so the request surface maps it to a typed 404.
  if (modelId.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) {
    throw new Error("Unknown gateway model alias. Choose a model from the gateway catalog.");
  }

  // s2. Explicit "<provider>/<model>" namespace, only when the prefix is a configured provider.
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const provName = modelId.slice(0, slash);
    if (config.providers[provName]) {
      return makeRoute(config, provName, modelId.slice(slash + 1), "qualified");
    }
  }

  // s3. Claude Code built-in `claude-*` ids: when the default provider is non-Anthropic, redirect
  //     to the default route (its defaultModel) instead of consuming Anthropic quota. Explicit
  //     `anthropic/<model>` still wins via s2.
  if (
    CLIENT_DEFAULT_PREFIXES.some(prefix => modelId.startsWith(prefix)) &&
    !isAnthropicProviderName(config.defaultProvider)
  ) {
    if (isHaikuClassModelId(modelId)) {
      const cls = resolveClassifierRoute(config);
      if (cls) return cls;
      const route = defaultProviderRoute(config, modelId, true);
      if (route) return { ...route, warning: `haiku-class classifier '${modelId}' fell back to defaultModel '${route.modelId}' (no classifierModel/classifierFallback configured)` };
    } else {
      const route = defaultProviderRoute(config, modelId, true);
      if (route) return route;
    }
  }

  // s4. Exact `defaultModel` match across providers.
  const exactDefault = providerNames.filter(name => config.providers[name]!.defaultModel === modelId);
  const r4 = pickDeterministic(config, exactDefault);
  if (r4) return makeRoute(config, r4.providerName, modelId, "exact-default", r4.ambiguousCandidates);

  // s5. Exact `models[]` membership across providers.
  const exactModels = providerNames.filter(name => {
    const models = config.providers[name]!.models;
    return Array.isArray(models) && models.includes(modelId);
  });
  const r5 = pickDeterministic(config, exactModels);
  if (r5) return makeRoute(config, r5.providerName, modelId, "exact-model", r5.ambiguousCandidates);


  // s6. Curated family fallback (allowlist-driven). Pick the family whose prefix longest-matches,
  //     then the first configured + adapter-guarded provider in that family's explicit allowlist.
  let bestFamilyPrefixLen = -1;
  let bestFamily: CuratedFamily | null = null;
  for (const family of CURATED_FAMILIES) {
    for (const prefix of family.prefixes) {
      if (modelId.startsWith(prefix) && prefix.length > bestFamilyPrefixLen) {
        bestFamilyPrefixLen = prefix.length;
        bestFamily = family;
      }
    }
  }
  if (bestFamily) {
    const familyCandidate = bestFamily.allowlist.find(name => {
      const prov = config.providers[name];
      return prov !== undefined && bestFamily!.adapters.includes(prov.adapter);
    });
    if (familyCandidate) {
      return makeRoute(config, familyCandidate, modelId, "family");
    }
  }


  // s7. Default-provider fallback (passes the requested id through unchanged).
  if (config.providers[config.defaultProvider]) {
    return makeRoute(config, config.defaultProvider, modelId, "default");
  }

  throw new Error(
    `No provider configured for model "${modelId}". Tried stages: alias, provider/model, ` +
      `client-default, exact defaultModel, exact models[], curated family, ` +
      `default provider. Configured providers: ${providerNames.join(", ") || "(none)"}.`,
  );
}
