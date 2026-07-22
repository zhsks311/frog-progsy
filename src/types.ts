export interface FrogParsedRequest {
  modelId: string;
  previousResponseId?: string;
  context: FrogContext;
  stream: boolean;
  options: FrogRequestOptions;
  _rawBody?: unknown;
  /**
   * Legacy hosted `{type:"web_search", ...}` tool config from an OpenAI Responses-shaped request.
   * Routed providers cannot run that hosted tool directly, so FrogProgsy may expose a synthetic
   * function tool and execute a configured fallback helper. Absent when not requested.
   */
  _webSearch?: Record<string, unknown>;
  /**
   * Normalized web-search request extracted from the active request wire format. For Claude Code's
   * `/v1/messages` path this preserves Anthropic `web_search_YYYYMMDD` server-tool options without
   * pretending they are ordinary function tools.
   */
  _webSearchRequest?: FrogWebSearchRequest;
  /** Original Anthropic Messages request body owned by the parser; route rewriting may update model. */
  _messagesRawBody?: Record<string, unknown>;
  /**
   * True when Claude Code requested structured output (`text.format` = json_schema/json_object). The
   * web-search tool_result is then rendered as compact JSON instead of markdown prose, so its
   * answer/"Sources:" text can't bleed into and corrupt the model's schema-constrained output.
   */
  _structuredOutput?: boolean;
}
export type FrogWebSearchToolKind = "openai_hosted" | "anthropic_server";
export type FrogWebSearchSource = "openai_responses" | "anthropic_messages";

export interface FrogWebSearchRequest {
  kind: FrogWebSearchToolKind;
  source: FrogWebSearchSource;
  /** Wire tool type, e.g. `web_search` or `web_search_20250305`. */
  type: string;
  /** Wire tool name when present. Anthropic server tools use `web_search`. */
  name?: string;
  /** Original server-tool object, preserved for native pass-through or tier-specific conversion. */
  raw: Record<string, unknown>;
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: Record<string, unknown>;
  searchContextSize?: string;
}

export type FrogWebSearchTier =
  | "native"
  | "fallback_model"
  | "search_api"
  | "no_key"
  | "insufficient"
  | "unavailable";

export type FrogWebSearchSkipReason =
  | "no_web_search_requested"
  | "primary_model_native_web_search_supported"
  | "primary_model_no_native_web_search"
  | "primary_model_web_search_unknown"
  | "primary_provider_not_anthropic_messages"
  | "fallback_model_not_enabled"
  | "fallback_model_forward_auth_missing"
  | "fallback_model_provider_unavailable"
  | "fallback_model_hosted_tool_unavailable"
  | "search_api_not_implemented"
  | "search_api_key_missing"
  | "search_api_provider_unsupported"
  | "search_api_not_configured"
  | "no_key_fallback_not_configured"
  | "no_key_fallback_not_implemented"
  | "evidence_insufficient";

export interface FrogWebSearchNotice {
  tier: Exclude<FrogWebSearchTier, "native">;
  message: string;
  reasonCodes: FrogWebSearchSkipReason[];
}

export interface FrogContext {
  systemPrompt?: string[];
  messages: FrogMessage[];
  tools?: FrogTool[];
}

export type FrogMessage =
  | FrogUserMessage
  | FrogAssistantMessage
  | FrogDeveloperMessage
  | FrogToolResultMessage;

export interface FrogUserMessage {
  role: "user";
  content: string | FrogContentPart[];
  timestamp: number;
}

export interface FrogAssistantMessage {
  role: "assistant";
  content: FrogAssistantContentPart[];
  model?: string;
  timestamp: number;
}

export interface FrogDeveloperMessage {
  role: "developer";
  content: string | FrogContentPart[];
  timestamp: number;
}

export interface FrogToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  /** MCP namespace from the originating tool call, if any. */
  toolNamespace?: string;
  /** Text, or content parts when a tool (e.g. Claude Code view_image) returns an image in its output. */
  content: string | FrogContentPart[];
  isError: boolean;
  timestamp: number;
}

export interface FrogTextContent {
  type: "text";
  text: string;
}

export interface FrogImageContent {
  type: "image";
  /** A `data:` URL (base64) or a remote https URL — passed through from Claude Code verbatim, NEVER inlined as text. */
  imageUrl: string;
  /** Fidelity hint from Claude Code: "low" | "high" | "auto". */
  detail?: string;
}

/** A user/developer message content part: text or an image (vision). */
export type FrogContentPart = FrogTextContent | FrogImageContent;

export interface FrogThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
  itemId?: string;
}

export interface FrogToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  customWireName?: string;
  thoughtSignature?: string;
  /** MCP namespace (e.g. "mcp__context7") when this call targets a namespaced tool. */
  namespace?: string;
}

export type FrogAssistantContentPart = FrogTextContent | FrogThinkingContent | FrogToolCall;

export interface FrogTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  /** MCP namespace (e.g. "mcp__context7") for tools flattened out of a Responses "namespace" tool. */
  namespace?: string;
  /** Freeform/custom tool (e.g. apply_patch): the model's call must be relayed as a custom_tool_call. */
  freeform?: boolean;
  /** Client-executed tool discovery (tool_search): the model's call must be relayed as a tool_search_call. */
  toolSearch?: boolean;
  /** Synthetic web_search tool: the model's call is executed by FrogProgsy's web-search fallback, not relayed to Claude Code. */
  webSearch?: boolean;
}

/**
 * Wire name a chat model sees for a tool. Namespaced (MCP) tools are flattened to
 * "<namespace>__<name>" so they survive the chat-completions function-tool format;
 * the proxy maps this back to {namespace, name} on the return trip (Claude Code routes MCP
 * calls by an explicit `namespace` field, not by parsing the name).
 */
export function namespacedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

/**
 * Whether `modelId` is in a per-provider model list. Matches the full id, OR — for Ollama-style ids —
 * the family before the ":size" tag, so a `gpt-oss` entry covers `gpt-oss:120b`/`gpt-oss:20b`.
 * Colon-less ids (e.g. `grok-build-0.1`) still match exactly only.
 */
export function modelInList(list: string[] | undefined, modelId: string): boolean {
  if (!list || list.length === 0) return false;
  if (list.includes(modelId)) return true;
  const colon = modelId.indexOf(":");
  return colon > 0 && list.includes(modelId.slice(0, colon));
}

export interface FrogRequestOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  reasoning?: string;
  hideThinkingSummary?: boolean;
  serviceTier?: string;
  presencePenalty?: number;
  frequencyPenalty?: number;
  promptCacheKey?: string;
}

/** Anthropic-compatible stop reasons that may reach clients. */
export type AdapterStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
/** Whether a stop reason came straight from the provider (`approved`) or was normalized from an unknown raw value. */
export type AdapterStopReasonProvenance = "approved" | "unknown_normalized";

/**
 * Request-log-safe adapter diagnostic. Never carries raw provider text — unknown values are
 * preserved as a sha256 hash plus length so repeated provider behavior stays correlatable.
 */
export interface AdapterDiagnostic {
  kind: "adapter";
  code: string;
  provider: string;
  surface: "stream" | "nonstream";
  rawValueHash: string;
  rawValueLength: number;
}

export type AdapterEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "reasoning_raw_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  | { type: "diagnostic"; diagnostic: AdapterDiagnostic }
  | { type: "done"; usage?: FrogUsage; stopReason?: AdapterStopReason; stopReasonProvenance?: AdapterStopReasonProvenance }
  | { type: "error"; message: string };

export interface FrogUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

export type ClaudeProfileAuthState =
  | "not_seen"
  | "seen_no_bearer"
  | "oauth_ok"
  | "oauth_rejected"
  | "cached"
  | "stale"
  | "unknown";


export interface ClaudeProfileRecord {
  /** Stable internal id used in headers, caches, backups, and logs. */
  id: string;
  /** Mutable user-facing label, e.g. "컬리 업무용". */
  name: string;
  /** Claude Code config directory (`CLAUDE_CONFIG_DIR`, commonly ~/.claude-*). */
  claudeHome: string;
  injected?: boolean;
  lastInjectedAt?: string;
  lastSeenAt?: string;
  authState?: ClaudeProfileAuthState;
}

export interface ClaudeProfilesConfig {
  schemaVersion: 1;
  defaultProfileId?: string;
  profiles: ClaudeProfileRecord[];
}
export interface ClaudeProjectRecord {
  /** Stable internal id used for project-scoped enrollment records. */
  id: string;
  /** Mutable user-facing label for the project. */
  name: string;
  /** Canonical project root path. */
  projectPath: string;
  /** Optional routing profile whose header should be injected for this project. */
  routingProfileId?: string;
  enrolled?: boolean;
  lastEnrolledAt?: string;
}

export interface ClaudeProjectsConfig {
  schemaVersion: 1;
  projects: ClaudeProjectRecord[];
}

export interface ClaudeGrantRecord {
  /** Stable internal id (`cg_...`) used for the scoped config dir, marker binding, and keychain service. */
  id: string;
  /** Mutable user-facing label for the grant. */
  label: string;
  /** Canonical isolated Claude config directory under `<frogprogsy-home>/claude-grants/<id>`. */
  configDir: string;
  createdAt: string;
}

export interface ClaudeGrantsConfig {
  schemaVersion: 1;
  grants: ClaudeGrantRecord[];
}

export type GatewayAuthCarrier = "token-free" | "sentinel";

export interface FrogConfig {
  port: number;
  providers: Record<string, FrogProviderConfig>;
  defaultProvider: string;
  /** Provider failover preference list; only the first valid provider is used. */
  fallbackProviders?: string[];
  longContext?: { thresholdTokens?: number; provider?: string; model?: string };
  providerBalance?: {
    enabled?: boolean;
    cacheTtlMs?: number;
    providers?: Record<string, { enabled?: boolean }>;
  };
  usagePricing?: {
    enabled?: boolean;
    currency?: string;
    prices?: Record<string, {
      inputPerMTok?: number;
      outputPerMTok?: number;
      cachedInputPerMTok?: number;
      reasoningOutputPerMTok?: number;
    }>;
    monthlyDisplayBudget?: number;
  };
  localAccess?: { enabled?: boolean; keys?: LocalAccessKeyConfig[] };
  shadowCompare?: {
    enabled?: boolean;
    secondary?: { provider: string; model: string };
    sampleRate?: number;
    storeText?: boolean;
    maxOutputTokens?: number;
    backgroundTimeoutMs?: number;
    maxConcurrent?: number;
    dropWhenBusy?: boolean;
  };
  /**
   * Ordered model ids (native slug or "<provider>/<model>") to feature FIRST in the injected Claude Code
   * catalog. Unbounded; catalog priority follows this order. Claude Code's spawn_agent still advertises
   * only the first 5 picker-visible entries.
   */
  subagentModels?: string[];
  /** Routed model ids ("<provider>/<model>") hidden from Claude Code (excluded from the catalog + /v1/models). */
  disabledModels?: string[];
  /** Bind hostname. Default "127.0.0.1" (loopback only). Set "0.0.0.0" to expose on all interfaces. */
  hostname?: string;
  /** Upstream stall timeout (seconds). After this many seconds of no upstream data, emits response.incomplete. Default 90. Min 1. */
  stallTimeoutSec?: number;
  /** Connect timeout (ms) for upstream fetch — covers DNS, TCP, TLS, and response header. Default 30000. */
  connectTimeoutMs?: number;
  /** Legacy ignored compatibility flag. Responses WebSocket is retired for the Claude Messages data plane. */
  websockets?: boolean;
  /**
   * Legacy ignored/no-op compatibility flag. Claude Code resume history is left untouched.
   */
  syncResumeHistory?: boolean; // legacy no-op
  /** Freshness window (ms) for the per-provider live `/models` cache. Defaults to 5 min. */
  modelCacheTtlMs?: number;
  /** Web-search fallback helper. Disabled unless explicitly enabled; implemented in-process, not as a separate app. */
  webSearchFallback?: FrogWebSearchFallbackConfig;
  /** Image fallback helper. Disabled unless explicitly enabled; implemented in-process, not as a separate app. */
  imageFallback?: FrogImageFallbackConfig;
  /** Cross-provider override for the auto-mode classifier (Haiku-class) side-queries. Takes precedence over a provider's classifierModel. Lets main=codex while the classifier runs on e.g. anthropic/claude-haiku. */
  classifierFallback?: { provider?: string; model?: string };
  /** Named Claude Code config directories. Claude subscription auth stays pass-through only. */
  claudeProfiles?: ClaudeProfilesConfig;
  /** Project-scoped Claude Code enrollments using <project>/.claude/settings.local.json. */
  claudeProjects?: ClaudeProjectsConfig;
  /**
   * Gateway auth carrier for managed Claude Code enrollment. Absent => "token-free" (default): the
   * launcher/settings write only the frogprogsy base URL and discovery flag, relying on the native OAuth
   * bearer passthrough — no synthetic ANTHROPIC_AUTH_TOKEN is stored in Claude settings. "sentinel" is the
   * explicit rollback that re-injects the local frogprogsy discovery token. Per-invocation
   * `--global-discovery-auth` / `globalDiscoveryAuth` remain explicit sentinel overrides.
   */
  gatewayAuthCarrier?: GatewayAuthCarrier;
  /** Isolated, config-dir-scoped Claude subscription grants (`claude-grant` auth mode). Never touches native Claude homes or the global Keychain service. */
  claudeGrants?: ClaudeGrantsConfig;
  /** Model mixing: a coordinator picks a provider/model per request from an explicit roster + guidance. Disabled unless explicitly enabled; never the auto-mode safety classifier. */
  modelMixing?: FrogModelMixingConfig;
  /**
   * Watchdog sidecar config. Absence = default-ON with built-in defaults.
   * Set enabled:false or export FROGP_NO_WATCHDOG=1 to disable.
   * Set FROGP_EXTERNAL_SUPERVISOR=1 only when an external supervisor already owns restart behavior.
   * Detached `frogp refresh` uses FROGP_DETACHED=1 instead: keep Claude settings injected,
   * but still allow the watchdog to supervise the background proxy.
   */
  watchdog?: {
    /** Disable the watchdog entirely. Default: true (enabled). */
    enabled?: boolean;
    /** Max consecutive crash-restart attempts before give-up. Default: 2. */
    maxAttempts?: number;
    /** Backoff delays (ms) indexed by attempt number. Default: [1000, 5000]. */
    backoffMs?: number[];
    /** After this many ms of healthy /healthz, burst counter resets. Default: 15000. */
    healthyWindowMs?: number;
    /** Watchdog poll interval (ms). Default: 2000. */
    pollIntervalMs?: number;
    /** Max restarts within rollingWindowMs before slow-flap give-up. Default: 5. */
    maxPerWindow?: number;
    /** Rolling window duration (ms) for slow-flap budget. Default: 600000. */
    rollingWindowMs?: number;
    /** Optional TTL (ms) for the shutdown-intent marker — older markers are ignored. */
    markerTtlMs?: number;
  };
}

export interface LocalAccessKeyConfig {
  id: string;
  secretHash: string;
  label?: string;
  requestLimit?: { windowSec: number; maxRequests: number };
  providers?: string[];
  models?: string[];
}


export type FrogInputModality = "text" | "image";
export type FrogImageFallbackPolicy = "reject" | "describe";

export interface FrogModelCapabilities {
  /** Provider/model input support. Omit when unknown; unknown models are tried natively. */
  input?: FrogInputModality[];
  /** Per-model image fallback policy for text-only models. Default comes from `imageFallback.enabled`. */
  imageFallback?: FrogImageFallbackPolicy;
  /** Native provider/model server-side web search support. Unknown is intentionally not optimistic. */
  webSearch?: boolean;
}

export interface FrogImageFallbackConfig {
  /** Master switch. Default false: text-only image requests fail clearly instead of silently using another model. */
  enabled?: boolean;
  /** Optional configured provider name for the helper. Must resolve to an OpenAI Responses forward/OAuth/key provider. */
  provider?: string;
  /** Vision-capable helper model used only when `enabled` and the target model is text-only. */
  model?: string;
  /** Helper fetch timeout (ms). */
  timeoutMs?: number;
}

export interface FrogWebSearchFallbackConfig {
  /** Master switch for the tier-2 fallback-model helper. Default false. */
  enabled?: boolean;
  /** Optional configured provider name for the tier-2 helper. Must resolve to an OpenAI Responses forward/OAuth/key provider. */
  provider?: string;
  /** Helper model that can run web search. */
  model?: string;
  /** Reasoning effort for the helper — "low" is the lightest effort accepted with web_search. */
  reasoning?: string;
  /** Max searches executed per main-model turn (loop guard). */
  maxSearchesPerTurn?: number;
  /** Helper fetch timeout (ms). */
  timeoutMs?: number;
  /** Optional tier-3 key-based search provider slots. Concrete execution is provider-specific. */
  searchProviders?: Record<string, FrogSearchApiProviderConfig>;
  /** Optional tier-4 strict no-key fallback controls. */
  noKey?: FrogNoKeyWebSearchConfig;
}
export interface FrogSearchApiProviderConfig {
  enabled?: boolean;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxResults?: number;
}

export interface FrogNoKeyWebSearchConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxResults?: number;
}

/** How selected mixing agents combine. "route" picks one agent; "pipeline" chains role stages; "fusion" runs a panel+judge+synthesizer. All three are implemented and shipping. */
export type FrogModelMixingCombine = "route" | "pipeline" | "fusion";

/** Mixing decision source. "coordinator": an LLM reads roster+guidance. "rules": deterministic table match, no LLM. Both are implemented and shipping. */
export type FrogModelMixingMode = "coordinator" | "rules";

/** One dispatchable agent in the mixing roster, annotated by strengths the coordinator reads. */
export interface FrogModelMixingAgent {
  /** Configured provider name (must exist in `providers`). */
  provider: string;
  /** Concrete model id at that provider. */
  model: string;
  /** Task-type labels this agent is good at (e.g. "coding", "chat", "debug"). Freeform; only meaningful to the coordinator. */
  tasks?: string[];
  /** Difficulty tiers this agent suits (e.g. "easy", "medium", "hard"). Freeform. */
  difficulty?: string[];
  /** Reserved for pipeline/fusion role assignment (thinker/worker/verifier). Unused in route mode. */
  role?: string;
  /** Optional freeform per-agent hint surfaced to the coordinator. */
  notes?: string;
}

export interface FrogModelMixingConfig {
  /** Master switch. Default false: absent/false leaves routing identical to today. */
  enabled?: boolean;
  /** Model id that triggers mixing when Claude Code targets it. Default "frogp/mix" (namespaced so it rides the routed-catalog lifecycle). */
  aliasId?: string;
  /** Decision source. Default "coordinator". */
  mode?: FrogModelMixingMode;
  /** How selected agents combine. Default "route" (pick one). */
  combine?: FrogModelMixingCombine;
  /** Coordinator model (coordinator mode). A cheap/fast model is fine. Must resolve to a configured provider. */
  coordinator?: { provider?: string; model?: string };
  /** Candidate agents the coordinator may dispatch to. */
  agents?: FrogModelMixingAgent[];
  /** Freeform natural-language guidance the coordinator reads ("when X use Y"). */
  guidance?: string;
  /** Coordinator call timeout (ms). Default 15000. */
  timeoutMs?: number;
  /** Explicit pipeline role assignment (combine="pipeline"). Explicit array wins over inferring roles from `agents[].role`. */
  pipeline?: { role: "thinker" | "worker" | "verifier"; provider: string; model: string }[];
  /** Fusion roster (combine="fusion"): panel of independent answerers, a judge that analyzes them, and a synthesizer that produces the final answer. */
  fusion?: {
    /** 1-8 panel members; truncated (with a warning) beyond 8. Defaults to `validMixAgents(config)` when absent. */
    panel?: { provider: string; model: string }[];
    /** Analyzes panel answers into a `JudgeAnalysis`. Defaults to `coordinator`. */
    judge?: { provider: string; model: string };
    /** Produces the final answer from the judge analysis + panel answers. Defaults to `coordinator`, else the first panel member. */
    synthesizer?: { provider: string; model: string };
    /** Panel prompt context. "task" preserves current latest-user-message-only prompt bytes; "full" embeds system prompt and full message history. Default "task". */
    contextMode?: "task" | "full";
    /** Judge prompt context. Independent from `contextMode`; default "task" even when panel context is full. */
    judgeContextMode?: "task" | "full";
    /** Opt-in synthetic/internal web_search for fusion panel members only. Default disabled; never exposes client tools to panel/judge. */
    panelWebSearch?: {
      enabled?: boolean;
      maxSearchesPerPanel?: number;
      maxTotalSearches?: number;
      timeoutMs?: number;
      tiers?: ("fallback_model" | "search_api" | "no_key")[];
    };
    /** Opt-in bounded multiround branch/refine/score loop after the initial panel. Default disabled. Recommended starting budget: maxRounds=2, branchFactor=2, budgetCalls=12. */
    multiround?: {
      enabled?: boolean;
      maxRounds?: number;
      branchFactor?: number;
      budgetCalls?: number;
    };
  };
  /** Deterministic routing table (mode="rules"): first fully-matched entry wins, no coordinator LLM call. */
  rules?: { match?: { taskKeywords?: string[]; difficulty?: string; hint?: string }; provider: string; model: string }[];
  /** Per-stage dispatch timeout (ms) for buffered pipeline/fusion pre-final stages. Falls back to `timeoutMs`; never bounds the final streamed stage. */
  stageTimeoutMs?: number;
  /** Per-panel-member dispatch timeout (ms) for buffered fusion panel calls. Falls back to `stageTimeoutMs`/`timeoutMs`; never bounds the final streamed stage. */
  panelTimeoutMs?: number;
  /** Stream intermediate stage output as live `thinking` blocks. Default true (opt-out). */
  surfaceStages?: boolean;
}

export interface FrogProviderConfig {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  /** Key auth only: configured-order stateless failover candidates after apiKey. */
  apiKeys?: string[];
  defaultModel?: string;
  /** Lightweight model id for Claude Code Haiku-class background/classifier side-queries routed to this provider (auto-mode permission classifier). Undefined -> falls back to defaultModel. */
  classifierModel?: string;
  models?: string[];
  /**
   * Fetch the provider's live `/models` endpoint. Defaults to true.
   * Set false when `models` is an intentional allowlist or a provider's live catalog is too large
   * or too flaky for startup/catalog sync.
   */
  liveModels?: boolean;
  /** Provider-wide Claude Code-visible context-window cap for routed catalog entries. */
  contextWindow?: number;
  /** Model-specific Claude Code-visible context-window caps. Values cap live metadata, never raise it. */
  modelContextWindows?: Record<string, number>;
  /** Provider/model capability map, e.g. `{ "model-a": { input: ["text", "image"] } }`. */
  modelCapabilities?: Record<string, FrogModelCapabilities>;
  headers?: Record<string, string>;
  /**
   * "key" (default): authenticate upstream with `apiKey`.
   * "forward": relay allowlisted caller auth headers already present on the incoming request.
   * "oauth": resolve a stored OAuth access token (auto-refreshed) and use it as the Bearer key.
   * "claude-grant": resolve an isolated, config-dir-scoped Claude subscription grant token
   *   (auto-refreshed) and use it as the Bearer key. Requires `claudeGrantId`. Never touches
   *   native Claude homes or the global Keychain service.
   * Anthropic and openai-responses implement "forward"; openai-chat uses its own key/token.
   */
  authMode?: "key" | "forward" | "oauth" | "claude-grant";
  /** Claude grant id (`cg_...`) bound to this provider when `authMode` is `"claude-grant"`. */
  claudeGrantId?: string;
  /**
   * Provider-wide Claude Code-visible reasoning tiers for routed models. Use only Claude Code-supported labels
   * here (`low`, `medium`, `high`, `xhigh`); translate to provider-specific wire values with
   * `reasoningEffortMap` / `modelReasoningEffortMap` below.
   */
  reasoningEfforts?: string[];
  /** Model-specific Claude Code-visible reasoning tiers. An empty array means “do not expose effort”. */
  modelReasoningEfforts?: Record<string, string[]>;
  /** Provider-wide mapping from Claude Code effort labels to upstream `reasoning_effort` values. */
  reasoningEffortMap?: Record<string, string>;
  /** Model-specific mapping from Claude Code effort labels to upstream `reasoning_effort` values. */
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  /**
   * Model ids that do NOT support a reasoning/thinking parameter. The openai-chat adapter drops
   * reasoning_effort for these even when Claude Code selects a reasoning level (e.g. xAI grok-build-0.1).
   */
  noReasoningModels?: string[];
  /** Model ids that reject caller-specified temperature. */
  noTemperatureModels?: string[];
  /** Model ids that reject caller-specified top_p. */
  noTopPModels?: string[];
  /** Model ids that reject caller-specified presence/frequency penalty values. */
  noPenaltyModels?: string[];
  /** Model ids whose tool_choice only accepts `auto` or `none`; forced/named choices are downgraded. */
  autoToolChoiceOnlyModels?: string[];
  /** Model ids that expect prior assistant `reasoning_content` to be preserved in chat history. */
  preserveReasoningContentModels?: string[];
  /** Anthropic-compatible gateways that need custom tool names escaped on the wire. */
  escapeBuiltinToolNames?: boolean;
}
