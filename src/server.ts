import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { homedir } from "node:os";
import { createAnthropicAdapter } from "./adapters/anthropic";
import { createAzureAdapter } from "./adapters/azure";
import { createGoogleAdapter } from "./adapters/google";
import { createOpenAIChatAdapter } from "./adapters/openai-chat";
import { createResponsesAdapter } from "./adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { bridgeToMessagesSSE, buildMessageJSON, formatAnthropicErrorResponse } from "./messages/bridge";
import { classifyError, parseUpstreamErrorDetails, type UpstreamErrorDetails } from "./errors";
import { safeResponseHeaders, type WsData } from "./ws-bridge";
import type { ServerWebSocket } from "bun";
import { DEFAULT_PORT, DEFAULT_SUBAGENT_MODELS, dropRuntimeFixtureProviders, getConfigPath, getWatchdogPidPath, getWatchdogStatusPath, loadConfig, readActivePort, readPid, saveConfig, websocketsEnabled } from "./config";
import { parseRequest } from "./responses/parser";
import { estimateMessagesInputTokens, parseMessagesRequest, buildResponsesBody } from "./messages/parser";
import { materializeModelAliases, type ModelAliasEntry } from "./model-aliases";
import { routeModel, type RouteKind } from "./router";
import { cheapMixTarget, isModelMixingRequest, resolveMix, validMixAgents, type CoordinatorComplete, type MixTarget } from "./model-mixing";
import { computeCallPlan } from "./model-mixing/orchestrate";
import { applyModelMixingPatch, modelMixingSettingsSnapshot } from "./model-mixing/settings";
import { runWithMixing } from "./model-mixing/loop";
import { namespacedToolName } from "./types";
import { signalWithTimeout } from "./abort";
import {
  clearLoginState, getLoginStatus, isOAuthProvider,
  listOAuthProviders, reconcileOAuthProviders, restoreCredentialedOAuthProviderConfigs, startLoginFlow, upsertOAuthProvider,
} from "./oauth/index";
import { isAllowedClaudeGrantBaseUrl, resolveProviderAuth } from "./provider-auth";
import type { CatalogModel } from "./claude-catalog";
import type { ClaudeCodeCatalogRefreshResult, ClaudeCodeGatewayModelsCacheSyncResult } from "./claude-refresh";
import { buildWebSearchTool, planWebSearch, resolveWebSearchLadderPlan, runWithWebSearch } from "./web-search-fallback";
import type { WebSearchUnavailablePlan } from "./web-search-fallback";
import { runWebSearch, type WebSearchFallbackOutcome } from "./web-search-fallback/executor";
import { runSearchApi, type SearchApiOutcome } from "./web-search-fallback/search-api";
import { runNoKeySearch } from "./web-search-fallback/no-key";
import { decideImageFallback, describeImagesInPlace } from "./image-fallback";
import { removeCredential } from "./oauth/store";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "./oauth/key-providers";
import { deriveProviderPresets } from "./providers/derive";
import { getProviderRegistryEntry } from "./providers/registry";
import type { AdapterDiagnostic, AdapterEvent, ClaudeGrantRecord, FrogConfig, FrogMessage, FrogParsedRequest, FrogProviderConfig, FrogTool, FrogUsage } from "./types";
import { appendUsageEntry, readUsageEntries, usageStatusForFinalLog, usageTotalTokens } from "./usage-log";
import { parseRange, summarizeUsage } from "./usage-summary";
import { classifierSettingsSnapshot, validateClassifierModel } from "./classifier-settings";
import { resolveModelCapabilities, supportsImageInput, supportsNativeWebSearch } from "./model-capabilities";
import { isOpenAIResponsesFallbackProvider } from "./fallback-openai-responses";
import { buildAttemptContexts, cloneParsedForAttempt, isSameProviderRetryCandidate, resolvePrimaryRoute, type AttemptContext } from "./provider-fallback";
import { redactConfigForApi, redactProviderForApi } from "./provider-redaction";
import { effectiveKeyCandidates } from "./provider-keys";
import { testProviderConnection as runProviderConnectionTest } from "./provider-test";
import { resolveGuiBuildIdentity } from "./build-identity";
import {
  clearClaudeProjectRoutingProfileHeader,
  injectClaudeProjectSettings,
  readClaudeGatewayState,
  readClaudeProjectGatewayState,
  restoreClaudeProjectSettings,
} from "./claude-settings";
import { DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, setCached } from "./model-cache";
import {
  addClaudeProfile,
  ensureClaudeProfiles,
  expandHomePath,
  listClaudeProfiles,
  markClaudeProfileInjected,
  removeClaudeProfile,
  renameClaudeProfile,
  resolveClaudeProfile,
  updateClaudeProfileAuthState,
} from "./claude-profiles";
import {
  addClaudeProject,
  clearClaudeProjectsForRoutingProfile,
  findClaudeProjectsForRoutingProfile,
  getClaudeProjectGitProtection,
  listClaudeProjects,
  markClaudeProjectEnrolled,
  removeClaudeProject,
  resolveClaudeProject,
} from "./claude-projects";
import { claudeLauncherBinDir, findRealClaudeExecutable, syncClaudeLauncherShims } from "./claude-launchers";
import {
  addClaudeGrant,
  assertClaudeGrantRemovalSafe,
  assertRealClaudeExecutable,
  buildClaudeGrantLoginCommand,
  DEFAULT_GRANT_LOGIN_ARGS,
  expectedKeychainService,
  getClaudeGrantById,
  grantsRoot,
  isValidGrantId,
  listClaudeGrants,
  removeClaudeGrant,
} from "./claude-grants";
import { deleteClaudeGrantCredential, inspectClaudeGrantStatus } from "./claude-grant-auth";
import { ClaudeGrantProbeError, runClaudeGrantLiveProbe, type ClaudeGrantLiveProbeResult } from "./claude-grant-probe";
import { parseEnvFlag, resolveWatchdogEnabled } from "./watchdog";

// Single source of truth = package.json (../ from src/), so /healthz + the GUI badge match the
// installed package version instead of a stale hardcode.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

const SERVER_BUILD_ID = `frogprogsy-server@${VERSION}`;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon",
};

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function findGuiDist(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "gui", "dist"),
    join(import.meta.dir, "..", "..", "gui", "dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

const GUI_DIST = findGuiDist();

export function buildHealthzPayload(uptime = process.uptime()) {
  return {
    status: "ok",
    version: VERSION,
    uptime,
    ...resolveGuiBuildIdentity(GUI_DIST, VERSION, SERVER_BUILD_ID),
  };
}

function serveGuiFile(pathname: string): Response | null {
  if (!GUI_DIST) return null;
  const filePath = pathname === "/" || pathname === ""
    ? join(GUI_DIST, "index.html")
    : join(GUI_DIST, pathname);

  if (!existsSync(filePath)) {
    if (!extname(pathname)) {
      const indexPath = join(GUI_DIST, "index.html");
      if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath), {
          headers: { "Content-Type": "text/html" },
        });
      }
    }
    return null;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": contentType },
  });
}

const ANTHROPIC_WIRE_MODELS: Record<string, Set<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3", "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"]),
};

function resolveWireProtocolOverride(providerName: string, modelId: string, providerConfig: FrogProviderConfig): FrogProviderConfig {
  const overrideSet = ANTHROPIC_WIRE_MODELS[providerName];
  if (overrideSet?.has(modelId) && providerConfig.adapter !== "anthropic") {
    return { ...providerConfig, adapter: "anthropic" };
  }
  return providerConfig;
}

export function resolveAdapter(providerConfig: FrogProviderConfig) {
  switch (providerConfig.adapter) {
    case "openai-chat":
      return createOpenAIChatAdapter(providerConfig);
    case "anthropic":
      return createAnthropicAdapter(providerConfig);
    case "openai-responses":
      return createResponsesAdapter(providerConfig);
    case "google":
      return createGoogleAdapter(providerConfig);
    case "azure":
    case "azure-openai":
      return createAzureAdapter(providerConfig);
    default:
      throw new Error(`Unknown adapter: ${providerConfig.adapter}`);
  }
}

/**
 * Run one non-streaming completion against the mixing coordinator's provider/model and return its
 * text. Owns adapter resolution + auth so the pure `resolveMix` planner can stay network-free.
 */
async function runCoordinatorCompletion(
  config: FrogConfig,
  providerName: string,
  modelId: string,
  messages: FrogMessage[],
  incomingHeaders: Headers,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const prov = config.providers[providerName];
  if (!prov) throw new Error(`coordinator provider '${providerName}' not configured`);
  const provider = await resolveProviderAuth(config, providerName, prov);
  const adapterProvider = resolveWireProtocolOverride(providerName, modelId, provider);
  const adapter = resolveAdapter(adapterProvider);
  if (!adapter.parseResponse) {
    throw new Error(`coordinator adapter '${adapterProvider.adapter}' has no non-streaming mode`);
  }
  const coordParsed: FrogParsedRequest = {
    modelId,
    stream: false,
    context: { messages, tools: [] },
    options: { maxOutputTokens: 1024 },
  };
  if (adapterProvider.adapter === "openai-responses") {
    coordParsed._rawBody = buildResponsesBody(coordParsed, {});
  }
  const request = adapter.buildRequest(coordParsed, { headers: incomingHeaders });
  const linked = signalWithTimeout(timeoutMs, signal);
  try {
    const resp = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: linked.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`coordinator provider error ${resp.status}: ${t.slice(0, 200)}`);
    }
    const events = await adapter.parseResponse(resp);
    let text = "";
    for (const e of events) if (e.type === "text_delta") text += e.text;
    return text;
  } finally {
    linked.cleanup();
  }
}

/** Rewrite a mixing-alias request in place to the coordinator's chosen concrete `provider/model`. */
async function applyModelMixing(
  config: FrogConfig,
  parsed: FrogParsedRequest,
  incomingHeaders: Headers,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!isModelMixingRequest(config, parsed.modelId)) return;
  const complete: CoordinatorComplete = ({ providerName, modelId, messages, timeoutMs, signal: s }) =>
    runCoordinatorCompletion(config, providerName, modelId, messages, incomingHeaders, timeoutMs, s);
  const res = await resolveMix(config, parsed, complete, signal);
  if (res.warning) console.error(`frogprogsy: ${res.warning}`);
  const target = `${res.target.provider}/${res.target.model}`;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    (parsed._rawBody as { model?: string }).model = target;
  }
  parsed.modelId = target;
}

/** No-LLM mixing rewrite for side calls (token counting): first roster agent or default. */
function applyModelMixingCheap(config: FrogConfig, parsed: FrogParsedRequest): void {
  if (!isModelMixingRequest(config, parsed.modelId)) return;
  const t = cheapMixTarget(config);
  const target = `${t.provider}/${t.model}`;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    (parsed._rawBody as { model?: string }).model = target;
  }
  parsed.modelId = target;
}

/**
 * One mixing-turn dispatch (pipeline/fusion): resolves the target's own provider/adapter/auth, then
 * either runs a buffered non-streaming call (panel/judge) or a streamed call that carries the
 * *original* request's context/tools/options with `systemAppend` tacked on as an extra developer
 * message (synthesizer). Buffered pre-final calls may include full context serialized into their
 * prompt messages, but never receive the caller's client tools. Generalizes `runCoordinatorCompletion`
 * to return raw adapter events instead of concatenated text, and to support the streaming leg.
 */
async function runMixTurn(
  config: FrogConfig,
  target: MixTarget,
  parsed: FrogParsedRequest,
  opts: { messages?: FrogMessage[]; systemAppend?: string; stream: boolean; maxTokens?: number; tools?: FrogTool[] },
  incomingHeaders: Headers,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AdapterEvent[] | AsyncGenerator<AdapterEvent>> {
  const prov = config.providers[target.provider];
  if (!prov) throw new Error(`mix target provider '${target.provider}' not configured`);
  const provider = await resolveProviderAuth(config, target.provider, prov);
  const adapterProvider = resolveWireProtocolOverride(target.provider, target.model, provider);
  const adapter = resolveAdapter(adapterProvider);

  const turnParsed: FrogParsedRequest = opts.stream
    ? {
        ...parsed,
        modelId: target.model,
        stream: true,
        context: {
          ...parsed.context,
          messages: opts.systemAppend
            ? [...parsed.context.messages, { role: "developer", content: opts.systemAppend, timestamp: Date.now() } satisfies FrogMessage]
            : parsed.context.messages,
        },
      }
    : {
        modelId: target.model,
        stream: false,
        // Buffered panel/judge calls never receive caller client tools. Only the fusion panel web-search
        // opt-in may pass FrogProgsy's synthetic internal web_search tool through opts.tools.
        context: { messages: opts.messages ?? [], tools: opts.tools ?? [] },
        options: { maxOutputTokens: opts.maxTokens ?? 2048 },
      };

  if (adapterProvider.adapter === "openai-responses") {
    turnParsed._rawBody = buildResponsesBody(turnParsed, {});
  }

  const request = adapter.buildRequest(turnParsed, { headers: incomingHeaders });

  if (opts.stream) {
    // Final streamed leg: no per-stage timeout — bounded only by client abort (linked via
    // linkAbortSignal) and the SSE bridge's own idle timeout. Do not clean up the abort listener
    // here; the returned generator is consumed after this function returns, so a `finally`-based
    // cleanup would detach the abort link before the stream is actually read.
    const ctrl = new AbortController();
    linkAbortSignal(ctrl, signal);
    const resp = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`mix target ${target.provider}/${target.model} error ${resp.status}: ${t.slice(0, 200)}`);
    }
    return adapter.parseStream(resp);
  }

  const linked = signalWithTimeout(timeoutMs, signal);
  try {
    const resp = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: linked.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`mix target ${target.provider}/${target.model} error ${resp.status}: ${t.slice(0, 200)}`);
    }
    if (!adapter.parseResponse) {
      throw new Error(`mix target adapter '${adapterProvider.adapter}' has no non-streaming mode`);
    }
    return await adapter.parseResponse(resp);
  } finally {
    linked.cleanup();
  }
}

async function handleResponses(
  req: Request,
  config: FrogConfig,
  logCtx: RequestLogContext,
  options: { forceEmptyResponseId?: boolean; abortSignal?: AbortSignal; profileId?: string } = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let parsed;
  try {
    parsed = parseRequest(body);
  } catch (err) {
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  // Keep Claude Code-facing response metadata on the requested model/alias. Adapters still receive
  // the routed upstream model below; echoing that upstream id makes Claude Code persist e.g. "gpt-5.5"
  // in transcripts and warn on resume because it is not a built-in Claude Code model.
  const responseModelId = parsed.modelId;
  await applyModelMixing(config, parsed, req.headers, options.abortSignal);
  let route;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  if (isRouteDisabled(config, route.providerName, route.modelId, responseModelId)) {
    return formatErrorResponse(404, "invalid_request_error", `Model "${responseModelId}" is disabled.`);
  }

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace
  // (e.g. "opencode-go/deepseek-v4-pro" → "deepseek-v4-pro"). Adapters read parsed.modelId,
  // and Responses-style adapters serialize parsed._rawBody, so rewrite both.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  setRouteLog(logCtx, route, route.routeKind, route.ambiguousCandidates);

  // OAuth / Claude-grant providers: resolve a fresh access token (auto-refreshed) as the Bearer key
  // through the common auth seam, so the existing openai-chat / anthropic adapters authenticate with
  // no change. Key/forward providers keep their already-resolved provider untouched.
  if (route.provider.authMode === "oauth" || route.provider.authMode === "claude-grant") {
    try {
      route.provider = await resolveProviderAuth(config, route.providerName, route.provider);
    } catch (err) {
      return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  }

  const imageFallback = decideImageFallback(config, route.providerName, route.provider, route.modelId, parsed, req.headers);
  if (imageFallback.action === "reject") {
    return formatErrorResponse(400, "invalid_request_error", imageFallback.message);
  }
  if (imageFallback.action === "describe") {
    await describeImagesInPlace(parsed, imageFallback.forwardProvider, imageFallback.forwardProviderName, req.headers, imageFallback.settings, options.abortSignal);
  }

  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider);

  // Legacy same-wire /v1/responses path: the public route is retired, but tests still exercise this
  // native relay branch. Claude Code's /v1/messages path does not enter here.
  if ("nativeRelay" in adapter && adapter.nativeRelay) {
    const request = adapter.buildRequest(parsed, { headers: req.headers });
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, native relay path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 30_000;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithHeaderTimeout(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }, upstream.signal, connectMs);
    } catch (err) {
      upstream.abort();
      const msg = err instanceof Error && err.name === "TimeoutError"
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return formatErrorResponse(502, "upstream_error", msg);
    }
    const headers = sanitizeRelayedHeaders(upstreamResponse.headers);
    const isEventStream = headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    const body = isEventStream
      ? relaySseWithHeartbeat(upstreamResponse.body, upstream)
      : relayWithAbort(upstreamResponse.body, upstream);
    return new Response(body, {
      status: upstreamResponse.status,
      headers,
    });
  }

  // Web-search fallback: Claude Code enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the configured
  // OpenAI Responses fallback helper, looping until the model answers. Otherwise take the normal path.
  const wsPlan = planWebSearch(config, parsed, false, req.headers, route.providerName, route.provider, route.modelId);
  if (wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    return runWithWebSearch({
      parsed, adapter,
      forwardProvider: wsPlan.forwardProvider,
      forwardProviderName: wsPlan.forwardProviderName,
      hostedTool: wsPlan.hostedTool,
      incomingHeaders: req.headers,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      responseModelId,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
    });
  }

  const upstream = new AbortController();
  linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 30_000;

  const request = adapter.buildRequest(parsed, { headers: req.headers });
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchWithHeaderTimeout(request.url, {
      method: request.method, headers: request.headers, body: request.body,
    }, upstream.signal, connectMs);
  } catch (err) {
    upstream.abort();
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    const err = await providerErrorDetails(upstreamResponse);
    return formatErrorResponse(upstreamResponse.status, err.type, err.message);
  }

  if (parsed.stream) {
    const eventStream = adapter.parseStream(upstreamResponse);
    const toolNsMap = new Map<string, { namespace: string; name: string }>();
    const freeformToolNames = new Set<string>();
    const toolSearchToolNames = new Set<string>();
    for (const t of parsed.context.tools ?? []) {
      if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
      if (t.freeform) freeformToolNames.add(t.name);
      if (t.toolSearch) toolSearchToolNames.add(t.name);
    }
    const sseStream = bridgeToResponsesSSE(
      eventStream, responseModelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
      },
    );
    return new Response(sseStream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (adapter.parseResponse) {
    const events = await adapter.parseResponse(upstreamResponse);
    const toolNsMap = new Map<string, { namespace: string; name: string }>();
    const freeformToolNames = new Set<string>();
    const toolSearchToolNames = new Set<string>();
    for (const t of parsed.context.tools ?? []) {
      if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
      if (t.freeform) freeformToolNames.add(t.name);
      if (t.toolSearch) toolSearchToolNames.add(t.name);
    }
    const json = buildResponseJSON(events, responseModelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
    });
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
}
function webSearchUnavailableText(plan: WebSearchUnavailablePlan): string {
  const reasons = plan.skippedReasonCodes.join(", ");
  return [
    "근거 부족: 요청한 web_search를 실행할 수 있는 검색 경로가 없습니다.",
    `시도한 경로/사유: ${reasons}.`,
    "현재 모델이나 설정에서 native web_search, search fallback model, key-based search API, no-key fallback 중 사용 가능한 경로가 확인되지 않아 최신 정보 주장을 만들지 않았습니다.",
  ].join("\n");
}

async function* singleTextMessage(text: string, usage: FrogUsage): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text };
  yield { type: "done", usage };
}
function latestUserQuery(parsed: FrogParsedRequest): string {
  for (let i = parsed.context.messages.length - 1; i >= 0; i--) {
    const msg = parsed.context.messages[i];
    if (msg.role !== "user" && msg.role !== "developer") continue;
    return contentToPlainText(msg.content).trim();
  }
  return "";
}

function contentToPlainText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map(part => part.type === "text" ? part.text ?? "" : "[image]").join("");
}

type WebSearchEvidenceCoverage = "none" | "answer_only" | "sources_only" | "answer_with_sources";

interface WebSearchEvidencePacket {
  coverage: WebSearchEvidenceCoverage;
  sourceCount: number;
  citationCount: number;
  insufficient: boolean;
  insufficientReason?: string;
}

function normalizeWebSearchInsufficientReason(outcome: WebSearchFallbackOutcome | SearchApiOutcome, coverage?: WebSearchEvidenceCoverage): string | undefined {
  if (outcome.error) {
    const err = outcome.error.toLowerCase();
    if (err.includes("abort") || err.includes("timeout") || err.includes("timed out")) return "search_timeout";
    if (/\bhttp\s+\d{3}\b/.test(err) || err.includes("status ")) return "search_http_error";
    if (err.includes("unsupported")) return "search_provider_unsupported";
    return "search_execution_error";
  }
  if (coverage === "none") return "evidence_insufficient";
  if (coverage === "answer_only") return "citation_support_missing";
  return undefined;
}

function buildWebSearchEvidencePacket(outcome: WebSearchFallbackOutcome | SearchApiOutcome): WebSearchEvidencePacket {
  const answerText = "text" in outcome ? outcome.text.trim() : outcome.answer.trim();
  const sourceCount = outcome.sources.length;
  const hasAnswer = answerText.length > 0;
  const hasSources = sourceCount > 0;
  const coverage: WebSearchEvidenceCoverage = hasAnswer && hasSources
    ? "answer_with_sources"
    : hasAnswer
      ? "answer_only"
      : hasSources
        ? "sources_only"
        : "none";
  const insufficientReason = normalizeWebSearchInsufficientReason(outcome, coverage);
  return {
    coverage,
    sourceCount,
    citationCount: sourceCount,
    insufficient: !!insufficientReason,
    ...(insufficientReason ? { insufficientReason } : {}),
  };
}

function webSearchEvidenceLog(evidence: WebSearchEvidencePacket) {
  return {
    coverage: evidence.coverage,
    sourceCount: evidence.sourceCount,
    citationCount: evidence.citationCount,
    ...(evidence.insufficientReason ? { insufficientReason: evidence.insufficientReason } : {}),
  };
}

function searchAnswerText(
  tier: "fallback_model" | "search_api" | "no_key",
  reasonCodes: readonly string[],
  query: string,
  outcome: WebSearchFallbackOutcome | SearchApiOutcome,
  evidence: WebSearchEvidencePacket,
): string {
  if (evidence.insufficient) {
    return [
      "근거 부족: 검색 fallback을 실행했지만 충분한 근거를 얻지 못했습니다.",
      `시도한 경로/사유: ${[...reasonCodes, evidence.insufficientReason ?? "evidence_insufficient"].join(", ")}.`,
      `증거 상태: coverage=${evidence.coverage}, sources=${evidence.sourceCount}, citations=${evidence.citationCount}.`,
      "출처가 없는 검색 답변이나 빈 검색 결과는 최신 정보 근거로 사용하지 않았습니다.",
    ].join("\n");
  }
  const answer = "text" in outcome ? outcome.text.trim() : outcome.answer.trim();
  const sources = outcome.sources.slice(0, 8).map((source, index) =>
    `[${index + 1}] ${source.title ? `${source.title} — ` : ""}${source.url}`
  );
  const notice = tier === "fallback_model"
    ? "알림: 선택한 모델의 native web_search를 사용할 수 없어 설정된 search fallback 모델로 검색했습니다."
    : tier === "search_api"
      ? "알림: native/fallback-model 검색을 사용할 수 없어 설정된 key 기반 search API로 검색했습니다."
      : "알림: native/fallback-model/key API 검색을 사용할 수 없어 in-process no-key fallback으로 검색했습니다.";
  return [
    notice,
    `Skipped reasons: ${reasonCodes.join(", ") || "none"}`,
    `Evidence coverage: ${evidence.coverage} (sources=${evidence.sourceCount}, citations=${evidence.citationCount})`,
    "",
    answer || `(검색 API가 "${query}"에 대한 출처만 반환했습니다.)`,
    ...(sources.length > 0 ? ["", "Sources:", ...sources] : []),
  ].join("\n");
}

function directMessageResponse(text: string, parsed: FrogParsedRequest, responseModelId: string, logCtx: RequestLogContext): Response {
  const usage: FrogUsage = {
    inputTokens: estimateMessagesInputTokens(parsed),
    outputTokens: Math.max(1, Math.ceil(text.length / 4)),
  };
  const events: AdapterEvent[] = [
    { type: "text_delta", text },
    { type: "done", usage },
  ];
  if (parsed.stream) {
    const sseStream = bridgeToMessagesSSE(
      singleTextMessage(text, usage),
      responseModelId,
      undefined,
      2_000,
      { hideThinkingSummary: true },
    );
    return new Response(observeLoggedStream(sseStream, logCtx), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }
  recordUsageFromEvents(logCtx, events);
  recordLogPhase(logCtx, "nonstream_bridge", "ok");
  finalizeRequestLog(logCtx, "completed", 200);
  const json = buildMessageJSON(events, responseModelId, { hideThinkingSummary: true });
  return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
}

async function handleMessages(
  req: Request,
  config: FrogConfig,
  logCtx: RequestLogContext,
  options: { abortSignal?: AbortSignal; profileId?: string } = {},
): Promise<Response> {
  const parseStarted = Date.now();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    recordLogPhase(logCtx, "read_request", "error", "invalid_json", parseStarted);
    finalizeRequestLog(logCtx, "internal_error", 400, { kind: "validation", code: "invalid_json" });
    return formatAnthropicErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let parsed: FrogParsedRequest;
  try {
    parsed = parseMessagesRequest(body);
    setParsedLog(logCtx, parsed);
    recordLogPhase(logCtx, "parse", "ok", undefined, parseStarted);
  } catch (err) {
    recordLogPhase(logCtx, "parse", "error", "parse_error", parseStarted);
    finalizeRequestLog(logCtx, "internal_error", 400, { kind: "validation", code: "parse_error" });
    return formatAnthropicErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  // Keep Claude Code-facing response metadata on the requested model/alias; only upstream calls use
  // the resolved provider model. Otherwise resumed sessions persist unsupported ids like "gpt-5.5".
  const responseModelId = parsed.modelId;
  if (isModelDisabled(config, responseModelId)) {
    finalizeRequestLog(logCtx, "internal_error", 404, { kind: "routing", code: "model_disabled" });
    return formatAnthropicErrorResponse(404, "invalid_request_error", `Model "${responseModelId}" is disabled.`);
  }
  if (isModelMixingRequest(config, parsed.modelId) && (config.modelMixing?.combine === "fusion" || config.modelMixing?.combine === "pipeline")) {
    // Buffered panel/judge/pipeline pre-final timeout only. The final streamed synthesizer is not
    // bounded by stageTimeoutMs/panelTimeoutMs; it follows client abort + SSE idle timeout.
    const mixTimeoutMs = config.modelMixing?.stageTimeoutMs ?? config.modelMixing?.timeoutMs ?? 15000;
    const mixHideThinking = config.modelMixing?.surfaceStages !== false ? false : parsed.options.hideThinkingSummary;

    // Mixing bypasses normal routing, so pick a representative target purely to evaluate image
    // fallback policy (vision support / describe-in-place) before dispatching to any mix stage.
    const repTarget = validMixAgents(config)[0] ?? { provider: config.defaultProvider, model: config.providers[config.defaultProvider]?.defaultModel ?? parsed.modelId };
    const repProvider = config.providers[repTarget.provider];
    if (repProvider) {
      const imageFallback = decideImageFallback(config, repTarget.provider, repProvider, repTarget.model, parsed, req.headers);
      logCtx.entry.fallbacks = {
        ...(logCtx.entry.fallbacks ?? {}),
        image: imageFallback.action === "describe"
          ? { planned: true, status: "ok", imageCount: logCtx.entry.request.imageCount, modelHash: imageFallback.settings.model }
          : { planned: imageFallback.action === "reject", status: imageFallback.action === "reject" ? "error" : "skipped", code: imageFallback.action === "reject" ? imageFallback.code : undefined },
      };
      if (imageFallback.action === "reject") {
        finalizeRequestLog(logCtx, "internal_error", 400, { kind: "validation", code: imageFallback.code });
        return formatAnthropicErrorResponse(400, "invalid_request_error", imageFallback.message);
      }
      if (imageFallback.action === "describe") {
        await describeImagesInPlace(parsed, imageFallback.forwardProvider, imageFallback.forwardProviderName, req.headers, imageFallback.settings, options.abortSignal);
      }
    }

    const mixedEvents = await runWithMixing({
      config,
      parsed,
      incomingHeaders: req.headers,
      abortSignal: options.abortSignal,
      dispatchBuffered: (target, messages, maxTokens, timeoutMs, tools) =>
        runMixTurn(config, target, parsed, { messages, stream: false, maxTokens, tools }, req.headers, timeoutMs ?? mixTimeoutMs, options.abortSignal) as Promise<AdapterEvent[]>,
      dispatchFinalStream: (target, systemAppend) =>
        runMixTurn(config, target, parsed, { systemAppend, stream: true }, req.headers, mixTimeoutMs, options.abortSignal) as Promise<AsyncGenerator<AdapterEvent>>,
    });

    if (parsed.stream) {
      const eventStream = observeUsageEvents(mixedEvents, logCtx);
      const sseStream = bridgeToMessagesSSE(
        eventStream,
        responseModelId,
        () => {/* client abort is propagated to in-flight mix stage fetches via linkAbortSignal */},
        2_000,
        { hideThinkingSummary: mixHideThinking },
      );
      return new Response(observeLoggedStream(sseStream, logCtx), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
    }
    const events: AdapterEvent[] = [];
    for await (const e of mixedEvents) events.push(e);
    recordUsageFromEvents(logCtx, events);
    const json = buildMessageJSON(events, responseModelId, { hideThinkingSummary: mixHideThinking });
    recordLogPhase(logCtx, "nonstream_bridge", "ok");
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  await applyModelMixing(config, parsed, req.headers, options.abortSignal);

  const routeStarted = Date.now();
  let attempts: AttemptContext[] = [];
  try {
    const built = buildAttemptContexts(config, parsed);
    if (isRouteDisabled(config, built.primaryRoute.providerName, built.primaryRoute.modelId, responseModelId)) {
      recordLogPhase(logCtx, "route", "error", "model_disabled", routeStarted);
      finalizeRequestLog(logCtx, "internal_error", 404, { kind: "routing", code: "model_disabled" });
      return formatAnthropicErrorResponse(404, "invalid_request_error", `Model "${responseModelId}" is disabled.`);
    }
    attempts = built.attempts.filter(attempt => !isRouteDisabled(config, attempt.providerName, attempt.modelId, responseModelId));
    setRouteLog(logCtx, built.primaryRoute, built.primaryRoute.routeKind, built.primaryRoute.ambiguousCandidates);
    if (built.primaryRoute.warning) console.error(`frogprogsy: ${built.primaryRoute.warning}`);
    recordLogPhase(logCtx, "route", "ok", undefined, routeStarted);
  } catch (err) {
    recordLogPhase(logCtx, "route", "error", "route_not_found", routeStarted);
    finalizeRequestLog(logCtx, "internal_error", 404, { kind: "routing", code: "route_not_found" });
    return formatAnthropicErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  const connectMs = config.connectTimeoutMs ?? 30_000;
  for (let attemptIndex = 0; attemptIndex < attempts.length;) {
    const attempt = attempts[attemptIndex]!;
    const attemptParsed = cloneParsedForAttempt(parsed, attempt);
    let attemptProvider = attempt.provider;
    setRouteLog(logCtx, { providerName: attempt.providerName, provider: attemptProvider, modelId: attempt.modelId }, attempt.routeKind, attempt.ambiguousCandidates);
    recordAttemptLog(logCtx, attempt, "started");

    const oauthStarted = Date.now();
    const grantAuth = attemptProvider.authMode === "claude-grant";
    const authPhase: RequestLogPhaseName = grantAuth ? "claude_auth" : "oauth";
    const authErrorCode = grantAuth ? "claude_auth_missing" : "oauth_missing";
    if (attemptProvider.authMode === "oauth" || attemptProvider.authMode === "claude-grant") {
      try {
        attemptProvider = await resolveProviderAuth(config, attempt.providerName, attemptProvider);
        setRouteLog(logCtx, { providerName: attempt.providerName, provider: attemptProvider, modelId: attempt.modelId }, attempt.routeKind, attempt.ambiguousCandidates);
        recordLogPhase(logCtx, authPhase, "ok", undefined, oauthStarted);
      } catch (err) {
        recordLogPhase(logCtx, authPhase, "error", authErrorCode, oauthStarted);
        recordAttemptLog(logCtx, attempt, "error", authErrorCode);
        finalizeRequestLog(logCtx, "internal_error", 401, { kind: "authentication", code: authErrorCode });
        return formatAnthropicErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
      }
    } else {
      recordLogPhase(logCtx, "oauth", "skipped", undefined, oauthStarted);
    }

    const imageFallback = decideImageFallback(config, attempt.providerName, attemptProvider, attempt.modelId, attemptParsed, req.headers);
    logCtx.entry.fallbacks = {
      ...(logCtx.entry.fallbacks ?? {}),
      image: imageFallback.action === "describe"
        ? { planned: true, status: "ok", imageCount: logCtx.entry.request.imageCount, modelHash: imageFallback.settings.model }
        : { planned: imageFallback.action === "reject", status: imageFallback.action === "reject" ? "error" : "skipped", code: imageFallback.action === "reject" ? imageFallback.code : undefined },
    };
    if (imageFallback.action === "reject") {
      recordAttemptLog(logCtx, attempt, "error", imageFallback.code);
      finalizeRequestLog(logCtx, "internal_error", 400, { kind: "validation", code: imageFallback.code });
      return formatAnthropicErrorResponse(400, "invalid_request_error", imageFallback.message);
    }
    const webSearchPlan = resolveWebSearchLadderPlan(config, attemptParsed, req.headers, attempt.providerName, attemptProvider, attempt.modelId);
    if (webSearchPlan) {
      logCtx.entry.fallbacks = {
        ...(logCtx.entry.fallbacks ?? {}),
        webSearch: webSearchPlan.tier === "native"
          ? { planned: false, status: "ok", tier: webSearchPlan.tier }
          : {
            planned: true,
            status: webSearchPlan.tier === "unavailable" ? "error" : "skipped",
            tier: webSearchPlan.tier,
            reasons: webSearchPlan.skippedReasonCodes,
            code: webSearchPlan.skippedReasonCodes[0],
            ...(webSearchPlan.tier === "fallback_model" ? { maxSearches: webSearchPlan.maxSearches, modelHash: webSearchPlan.settings.model } : {}),
          },
      };
    }
    if (webSearchPlan?.tier === "fallback_model" || webSearchPlan?.tier === "search_api" || webSearchPlan?.tier === "no_key") {
      const query = latestUserQuery(attemptParsed) || "current information request";
      const outcome = webSearchPlan.tier === "fallback_model"
        ? await runWebSearch(query, webSearchPlan.hostedTool, webSearchPlan.forwardProvider, webSearchPlan.forwardProviderName, req.headers, webSearchPlan.settings, options.abortSignal)
        : webSearchPlan.tier === "search_api"
          ? await runSearchApi(query, webSearchPlan.apiProvider, options.abortSignal)
          : await runNoKeySearch(query, config.webSearchFallback?.noKey, options.abortSignal);
      const evidence = buildWebSearchEvidencePacket(outcome);
      const ok = !evidence.insufficient;
      logCtx.entry.fallbacks = {
        ...(logCtx.entry.fallbacks ?? {}),
        webSearch: {
          ...(logCtx.entry.fallbacks?.webSearch ?? { planned: true, status: "skipped" }),
          planned: true,
          status: ok ? "ok" : "error",
          calls: 1,
          evidence: webSearchEvidenceLog(evidence),
        },
      };
      recordAttemptLog(logCtx, attempt, ok ? "ok" : "error", ok ? undefined : evidence.insufficientReason ?? "evidence_insufficient");
      recordLogPhase(logCtx, "web_search_fallback", ok ? "ok" : "error", ok ? undefined : evidence.insufficientReason ?? "evidence_insufficient");
      return directMessageResponse(
        searchAnswerText(webSearchPlan.tier, webSearchPlan.skippedReasonCodes, query, outcome, evidence),
        attemptParsed,
        responseModelId,
        logCtx,
      );
    }
    if (webSearchPlan?.tier === "unavailable") {
      recordAttemptLog(logCtx, attempt, "error", "web_search_unavailable");
      recordLogPhase(logCtx, "web_search_fallback", "error", "web_search_unavailable");
      return directMessageResponse(webSearchUnavailableText(webSearchPlan), attemptParsed, responseModelId, logCtx);
    }
    if (imageFallback.action === "describe") {
      await describeImagesInPlace(attemptParsed, imageFallback.forwardProvider, imageFallback.forwardProviderName, req.headers, imageFallback.settings, options.abortSignal);
    }

    recordLogPhase(logCtx, "adapter_build", "ok");
    const adapterProvider = resolveWireProtocolOverride(attempt.providerName, attempt.modelId, attemptProvider);
    const adapter = resolveAdapter(adapterProvider);
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);

    const request = adapter.buildRequest(attemptParsed, { headers: req.headers });
    let upstreamResponse: Response;
    const upstreamStarted = Date.now();
    try {
      upstreamResponse = await fetchWithHeaderTimeout(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }, upstream.signal, connectMs);
      logCtx.entry.upstream = {
        ...(logCtx.entry.upstream ?? {}),
        status: upstreamResponse.status,
        contentTypeFamily: contentTypeFamily(upstreamResponse.headers),
        requestBytes: request.body.length,
      };
      recordLogPhase(logCtx, "upstream_connect", upstreamResponse.ok ? "ok" : "error", upstreamResponse.ok ? undefined : "provider_non_2xx", upstreamStarted);
    } catch (err) {
      upstream.abort();
      const timeout = err instanceof Error && err.name === "TimeoutError";
      const code = timeout ? "connect_timeout" : "upstream_unreachable";
      recordLogPhase(logCtx, "upstream_connect", "error", code, upstreamStarted);
      recordAttemptLog(logCtx, attempt, "error", code);
      const nextIndex = nextAttemptIndexAfterConnectError(attempts, attemptIndex);
      if (nextIndex < attempts.length) {
        for (let skipped = attemptIndex + 1; skipped < nextIndex; skipped++) {
          recordAttemptLog(logCtx, attempts[skipped]!, "skipped", code);
        }
        attemptIndex = nextIndex;
        continue;
      }
      const msg = timeout
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      finalizeRequestLog(logCtx, timeout ? "timeout" : "upstream_abort", 502, { kind: timeout ? "timeout" : "upstream", code });
      return formatAnthropicErrorResponse(502, "upstream_error", msg);
    }

    if (!upstreamResponse.ok) {
      const err = await providerErrorDetails(upstreamResponse);
      recordAttemptLog(logCtx, attempt, "error", err.code ?? "provider_non_2xx", upstreamResponse.status);
      const nextIndex = nextAttemptIndexAfterHttp(attempts, attemptIndex, upstreamResponse.status, err);
      if (nextIndex < attempts.length) {
        for (let skipped = attemptIndex + 1; skipped < nextIndex; skipped++) {
          recordAttemptLog(logCtx, attempts[skipped]!, "skipped", err.code ?? "provider_non_2xx");
        }
        attemptIndex = nextIndex;
        continue;
      }
      finalizeRequestLog(logCtx, "provider_non_2xx", upstreamResponse.status, { kind: "upstream", code: "provider_non_2xx", upstreamStatus: upstreamResponse.status });
      return formatAnthropicErrorResponse(upstreamResponse.status, err.type, err.message);
    }

    recordAttemptLog(logCtx, attempt, "ok", undefined, upstreamResponse.status);
    if (attemptParsed.stream) {
      const eventStream = observeUsageEvents(adapter.parseStream(upstreamResponse), logCtx);
      const sseStream = bridgeToMessagesSSE(
        eventStream,
        responseModelId,
        () => upstream.abort(),
        2_000,
        { hideThinkingSummary: attemptParsed.options.hideThinkingSummary },
      );
      return new Response(observeLoggedStream(sseStream, logCtx), {
        headers: responseHeadersFromUpstream(upstreamResponse, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" }),
      });
    }
    if (!adapter.parseResponse) {
      return formatAnthropicErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
    }
    try {
      const events = await adapter.parseResponse(upstreamResponse);
      recordUsageFromEvents(logCtx, events);
      const json = buildMessageJSON(events, responseModelId, { hideThinkingSummary: attemptParsed.options.hideThinkingSummary });
      recordLogPhase(logCtx, "nonstream_bridge", "ok");
      return new Response(JSON.stringify(json), { headers: responseHeadersFromUpstream(upstreamResponse, { "Content-Type": "application/json" }) });
    } catch {
      recordLogPhase(logCtx, "nonstream_bridge", "error", "bridge_parse_error");
      finalizeRequestLog(logCtx, "bridge_error", 502, { kind: "bridge", code: "bridge_parse_error" });
      return formatAnthropicErrorResponse(502, "upstream_error", "Provider response bridge failed");
    }
  }

  finalizeRequestLog(logCtx, "internal_error", 502, { kind: "upstream", code: "provider_attempts_exhausted" });
  return formatAnthropicErrorResponse(502, "upstream_error", "Provider attempts exhausted");
}

function buildCountTokensFallback(parsed: FrogParsedRequest): Response {
  return new Response(JSON.stringify({ input_tokens: estimateMessagesInputTokens(parsed) }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleCountTokens(
  req: Request,
  config: FrogConfig,
  logCtx: RequestLogContext,
  options: { abortSignal?: AbortSignal; profileId?: string } = {},
): Promise<Response> {
  const parseStarted = Date.now();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    recordLogPhase(logCtx, "read_request", "error", "invalid_json", parseStarted);
    finalizeRequestLog(logCtx, "internal_error", 400, { kind: "validation", code: "invalid_json" });
    return formatAnthropicErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let parsed: FrogParsedRequest;
  try {
    parsed = parseMessagesRequest(body);
    setParsedLog(logCtx, parsed);
    recordLogPhase(logCtx, "parse", "ok", undefined, parseStarted);
  } catch (err) {
    recordLogPhase(logCtx, "parse", "error", "parse_error", parseStarted);
    finalizeRequestLog(logCtx, "internal_error", 400, { kind: "validation", code: "parse_error" });
    return formatAnthropicErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  applyModelMixingCheap(config, parsed);
  const routeStarted = Date.now();
  let route;
  try {
    route = resolvePrimaryRoute(config, parsed);
    if (isRouteDisabled(config, route.providerName, route.modelId, parsed.modelId)) {
      recordLogPhase(logCtx, "route", "error", "model_disabled", routeStarted);
      finalizeRequestLog(logCtx, "internal_error", 404, { kind: "routing", code: "model_disabled" });
      return formatAnthropicErrorResponse(404, "invalid_request_error", `Model "${parsed.modelId}" is disabled.`);
    }
    setRouteLog(logCtx, route, route.routeKind, route.ambiguousCandidates);
    recordLogPhase(logCtx, "route", "ok", undefined, routeStarted);
  } catch (err) {
    recordLogPhase(logCtx, "route", "error", "route_not_found", routeStarted);
    finalizeRequestLog(logCtx, "internal_error", 404, { kind: "routing", code: "route_not_found" });
    return formatAnthropicErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  setRouteLog(logCtx, route, route.routeKind, route.ambiguousCandidates);

  const oauthStarted = Date.now();
  const grantAuth = route.provider.authMode === "claude-grant";
  const authPhase: RequestLogPhaseName = grantAuth ? "claude_auth" : "oauth";
  const authErrorCode = grantAuth ? "claude_auth_missing" : "oauth_missing";
  if (route.provider.authMode === "oauth" || route.provider.authMode === "claude-grant") {
    try {
      route.provider = await resolveProviderAuth(config, route.providerName, route.provider);
      setRouteLog(logCtx, route, route.routeKind, route.ambiguousCandidates);
      recordLogPhase(logCtx, authPhase, "ok", undefined, oauthStarted);
    } catch (err) {
      recordLogPhase(logCtx, authPhase, "error", authErrorCode, oauthStarted);
      finalizeRequestLog(logCtx, "internal_error", 401, { kind: "authentication", code: authErrorCode });
      return formatAnthropicErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  } else {
    recordLogPhase(logCtx, "oauth", "skipped", undefined, oauthStarted);
  }

  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  if (adapterProvider.adapter !== "anthropic") {
    recordLogPhase(logCtx, "count_tokens", "skipped", "fallback_estimate");
    return buildCountTokensFallback(parsed);
  }

  const adapter = resolveAdapter(adapterProvider);
  recordLogPhase(logCtx, "adapter_build", "ok");
  const request = adapter.buildRequest({ ...parsed, stream: false }, { headers: req.headers });
  let countBody: string;
  try {
    const payload = JSON.parse(request.body) as Record<string, unknown>;
    delete payload.stream;
    delete payload.max_tokens;
    delete payload.temperature;
    delete payload.top_p;
    delete payload.stop_sequences;
    delete payload.tool_choice;
    countBody = JSON.stringify(payload);
  } catch {
    recordLogPhase(logCtx, "count_tokens", "skipped", "fallback_estimate");
    return buildCountTokensFallback(parsed);
  }

  const upstream = new AbortController();
  linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 30_000;
  const countUrl = request.url.replace(/\/v1\/messages$/, "/v1/messages/count_tokens");
  let upstreamResponse: Response;
  const upstreamStarted = Date.now();
  try {
    upstreamResponse = await fetchWithHeaderTimeout(countUrl, {
      method: "POST",
      headers: request.headers,
      body: countBody,
    }, upstream.signal, connectMs);
    logCtx.entry.upstream = {
      ...(logCtx.entry.upstream ?? {}),
      status: upstreamResponse.status,
      contentTypeFamily: contentTypeFamily(upstreamResponse.headers),
      requestBytes: countBody.length,
    };
    recordLogPhase(logCtx, "upstream_connect", upstreamResponse.ok ? "ok" : "error", upstreamResponse.ok ? undefined : "provider_non_2xx", upstreamStarted);
  } catch (err) {
    upstream.abort();
    const timeout = err instanceof Error && err.name === "TimeoutError";
    const msg = timeout
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    recordLogPhase(logCtx, "upstream_connect", "error", timeout ? "connect_timeout" : "upstream_unreachable", upstreamStarted);
    finalizeRequestLog(logCtx, timeout ? "timeout" : "upstream_abort", 502, { kind: timeout ? "timeout" : "upstream", code: timeout ? "connect_timeout" : "upstream_unreachable" });
    return formatAnthropicErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    const err = await providerErrorDetails(upstreamResponse);
    finalizeRequestLog(logCtx, "provider_non_2xx", upstreamResponse.status, { kind: "upstream", code: "provider_non_2xx", upstreamStatus: upstreamResponse.status });
    return formatAnthropicErrorResponse(upstreamResponse.status, err.type, err.message);
  }

  const json = await upstreamResponse.json().catch(() => undefined) as { input_tokens?: unknown } | undefined;
  if (typeof json?.input_tokens === "number") {
    logCtx.entry.upstream = {
      ...(logCtx.entry.upstream ?? {}),
      usage: { inputTokens: json.input_tokens },
    };
    recordLogPhase(logCtx, "count_tokens", "ok");
    return new Response(JSON.stringify({ input_tokens: json.input_tokens }), {
      headers: responseHeadersFromUpstream(upstreamResponse, { "Content-Type": "application/json" }),
    });
  }
  recordLogPhase(logCtx, "count_tokens", "skipped", "fallback_estimate");
  return buildCountTokensFallback(parsed);
}

export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): void {
  if (!signal) return;
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return;
  }
  signal.addEventListener("abort", () => upstream.abort(signal.reason), { once: true });
}

async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.any([abortSignal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function providerErrorDetails(response: Response, fallbackMessage = `Provider error ${response.status}`) {
  const bodyText = await response.text().catch(() => "");
  return parseUpstreamErrorDetails(response.status, "upstream_error", fallbackMessage, bodyText);
}

function recordAttemptLog(ctx: RequestLogContext, attempt: AttemptContext, status: "started" | "ok" | "skipped" | "error", code?: string, upstreamStatus?: number): void {
  const attempts = ctx.entry.attempts ?? [];
  const existing = attempts.find(entry => entry.provider === attempt.providerName && entry.model === attempt.modelId && entry.source === attempt.source && entry.keyIndex === attempt.keyIndex);
  const entry = {
    provider: attempt.providerName,
    model: attempt.modelId,
    source: attempt.source,
    ...(attempt.keyIndex !== undefined ? { keyIndex: attempt.keyIndex } : {}),
    status,
    ...(code ? { code } : {}),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  };
  if (existing) {
    Object.assign(existing, entry);
  } else {
    attempts.push(entry);
    ctx.entry.attempts = attempts;
  }
}

function nextFallbackAttemptIndex(attempts: AttemptContext[], currentIndex: number): number {
  const current = attempts[currentIndex]!;
  const nextFallback = attempts.findIndex((attempt, index) => index > currentIndex && !isSameProviderRetryCandidate(current, attempt));
  return nextFallback >= 0 ? nextFallback : attempts.length;
}

function nextAttemptIndexAfterHttp(attempts: AttemptContext[], currentIndex: number, status: number, err: UpstreamErrorDetails): number {
  if (isTerminalProviderHttpError(status, err)) return attempts.length;
  if (status === 429) return currentIndex + 1;
  if (status >= 500) return nextFallbackAttemptIndex(attempts, currentIndex);
  return attempts.length;
}

function nextAttemptIndexAfterConnectError(attempts: AttemptContext[], currentIndex: number): number {
  return nextFallbackAttemptIndex(attempts, currentIndex);
}

function isTerminalProviderHttpError(status: number, err: UpstreamErrorDetails): boolean {
  if (status === 400 || status === 401 || status === 402 || status === 403) return true;
  return classifyError(status, err.type, err.message).code === "context_length_exceeded";
}

type ProviderConnectionTestCode =
  | "ok"
  | "unknown_provider"
  | "model_missing"
  | "auth_missing"
  | "timeout"
  | "request_failed"
  | "provider_non_2xx"
  | "bridge_parse_error";

interface ProviderConnectionTestResult {
  ok: boolean;
  code: ProviderConnectionTestCode;
  provider: string;
  model?: string;
  upstreamStatus?: number;
  durationMs?: number;
}

function hasForwardedAuthHeader(headers: Record<string, string>): boolean {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return ["authorization", "x-api-key", "api-key", "chatgpt-account-id"].some(key => {
    const value = lower.get(key)?.trim();
    return !!value && value !== "local-frogprogsy" && !/^Bearer\s+local-frogprogsy$/i.test(value);
  });
}

async function testProviderConnection(config: FrogConfig, providerName: string, incomingHeaders: Headers): Promise<ProviderConnectionTestResult> {
  const providerConfig = config.providers[providerName];
  if (!providerConfig) return { ok: false, code: "unknown_provider", provider: providerName };
  const model = providerConfig.defaultModel?.trim() || providerConfig.models?.find(candidate => candidate.trim())?.trim();
  if (!model) return { ok: false, code: "model_missing", provider: providerName };

  let provider: FrogProviderConfig;
  try {
    provider = await resolveProviderAuth(config, providerName, providerConfig);
  } catch {
    return { ok: false, code: "auth_missing", provider: providerName, model };
  }

  const parsed = parseMessagesRequest({
    model,
    max_tokens: 1,
    stream: false,
    messages: [{ role: "user", content: "ping" }],
  });
  const adapterProvider = resolveWireProtocolOverride(providerName, model, provider);
  const adapter = resolveAdapter(adapterProvider);
  const request = adapter.buildRequest(parsed, { headers: incomingHeaders });
  if (provider.authMode === "forward" && !hasForwardedAuthHeader(request.headers)) {
    return { ok: false, code: "auth_missing", provider: providerName, model };
  }

  const startedAt = Date.now();
  const upstream = new AbortController();
  try {
    const response = await fetchWithHeaderTimeout(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    }, upstream.signal, config.connectTimeoutMs ?? 30_000);
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (!response.ok) {
      return { ok: false, code: "provider_non_2xx", provider: providerName, model, upstreamStatus: response.status, durationMs };
    }
    if (adapter.parseResponse) {
      try {
        await adapter.parseResponse(response.clone());
      } catch {
        return { ok: false, code: "bridge_parse_error", provider: providerName, model, upstreamStatus: response.status, durationMs };
      }
    }
    return { ok: true, code: "ok", provider: providerName, model, upstreamStatus: response.status, durationMs };
  } catch (err) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, code: timeout ? "timeout" : "request_failed", provider: providerName, model, durationMs };
  } finally {
    upstream.abort();
  }
}

type RequestLifecycle =
  | "in_progress"
  | "completed"
  | "client_cancel"
  | "upstream_abort"
  | "timeout"
  | "provider_non_2xx"
  | "bridge_error"
  | "internal_error";

type RequestLogPhaseName =
  | "read_request"
  | "parse"
  | "route"
  | "oauth"
  | "claude_auth"
  | "image_fallback"
  | "adapter_build"
  | "web_search_fallback"
  | "upstream_connect"
  | "stream_bridge"
  | "nonstream_bridge"
  | "count_tokens"
  | "finalize";

interface RequestLogPhase {
  name: RequestLogPhaseName;
  startedAt: number;
  durationMs?: number;
  status: "ok" | "skipped" | "error";
  code?: string;
}

interface RequestLogEntry {
  id: string;
  startedAt: number;
  finalizedAt?: number;
  lifecycle: RequestLifecycle;
  endpoint: string;
  method: string;
  status?: number;
  durationMs?: number;
  request: {
    requestBytes?: number;
    stream?: boolean;
    messageCount?: number;
    toolDefinitionCount?: number;
    toolResultCount?: number;
    imageCount?: number;
    hasSystemPrompt?: boolean;
  };
  route: {
    requestedModelLabel?: string;
    routedModelLabel?: string;
    provider: string;
    adapter?: string;
    authMode?: string;
    routeKind?: string;
    ambiguousCandidates?: string[];
  };
  attempts?: Array<{
    provider: string;
    model: string;
    source: "primary" | "fallback";
    keyIndex?: number;
    status: "started" | "ok" | "skipped" | "error";
    code?: string;
    upstreamStatus?: number;
  }>;
  phases: RequestLogPhase[];
  fallbacks?: {
    image?: { planned: boolean; status: "ok" | "skipped" | "error"; imageCount?: number; modelHash?: string; code?: string };
    webSearch?: { planned: boolean; status: "ok" | "skipped" | "error"; maxSearches?: number; calls?: number; modelHash?: string; code?: string; tier?: string; reasons?: string[]; evidence?: { coverage: WebSearchEvidenceCoverage; sourceCount: number; citationCount: number; insufficientReason?: string } };
  };
  upstream?: {
    status?: number;
    contentTypeFamily?: "sse" | "json" | "text" | "binary" | "unknown";
    requestBytes?: number;
    responseBytes?: number;
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number };
  };
  error?: {
    kind: "validation" | "routing" | "authentication" | "origin" | "timeout" | "upstream" | "bridge" | "internal";
    code: string;
    upstreamStatus?: number;
  };
  /** Request-log-safe adapter diagnostics (code/provider/surface/hash/length only — never raw provider text). */
  diagnostics?: AdapterDiagnostic[];
}

/** Bound the per-entry diagnostics list so a misbehaving upstream cannot grow log entries unboundedly. */
const MAX_DIAGNOSTICS_PER_ENTRY = 8;

function recordLogDiagnostic(ctx: RequestLogContext, diagnostic: AdapterDiagnostic): void {
  const list = ctx.entry.diagnostics ?? (ctx.entry.diagnostics = []);
  if (list.length >= MAX_DIAGNOSTICS_PER_ENTRY) return;
  list.push({ ...diagnostic });
}

interface RequestLogContext {
  entry: RequestLogEntry;
  finalized: boolean;
  model: string;
  provider: string;
}

const requestLog: RequestLogEntry[] = [];
const MAX_LOG_SIZE = 200;

function addRequestLog(entry: RequestLogEntry) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_SIZE) requestLog.shift();
}

function requestLogSnapshot(): RequestLogEntry[] {
  return requestLog.map(entry => structuredClone(entry));
}
function requestLogManagementSnapshot() {
  return requestLog.map(entry => ({
    id: entry.id,
    startedAt: entry.startedAt,
    ...(entry.finalizedAt !== undefined ? { finalizedAt: entry.finalizedAt } : {}),
    lifecycle: entry.lifecycle,
    endpoint: entry.endpoint,
    method: entry.method,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    request: {
      ...(entry.request.requestBytes !== undefined ? { requestBytes: entry.request.requestBytes } : {}),
      ...(entry.request.stream !== undefined ? { stream: entry.request.stream } : {}),
      ...(entry.request.messageCount !== undefined ? { messageCount: entry.request.messageCount } : {}),
      ...(entry.request.toolDefinitionCount !== undefined ? { toolDefinitionCount: entry.request.toolDefinitionCount } : {}),
      ...(entry.request.toolResultCount !== undefined ? { toolResultCount: entry.request.toolResultCount } : {}),
      ...(entry.request.imageCount !== undefined ? { imageCount: entry.request.imageCount } : {}),
      ...(entry.request.hasSystemPrompt !== undefined ? { hasSystemPrompt: entry.request.hasSystemPrompt } : {}),
    },
    route: {
      ...(entry.route.requestedModelLabel !== undefined ? { requestedModelLabel: entry.route.requestedModelLabel } : {}),
      ...(entry.route.routedModelLabel !== undefined ? { routedModelLabel: entry.route.routedModelLabel } : {}),
      provider: entry.route.provider,
      ...(entry.route.adapter !== undefined ? { adapter: entry.route.adapter } : {}),
      ...(entry.route.authMode !== undefined ? { authMode: entry.route.authMode } : {}),
      ...(entry.route.routeKind !== undefined ? { routeKind: entry.route.routeKind } : {}),
      ...(entry.route.ambiguousCandidates !== undefined ? { ambiguousCandidates: [...entry.route.ambiguousCandidates] } : {}),
    },
    phases: entry.phases.map(phase => ({ ...phase })),
    ...(entry.fallbacks !== undefined ? { fallbacks: structuredClone(entry.fallbacks) } : {}),
    ...(entry.upstream !== undefined ? { upstream: structuredClone(entry.upstream) } : {}),
    ...(entry.error !== undefined ? { error: { ...entry.error } } : {}),
    ...(entry.diagnostics !== undefined ? { diagnostics: entry.diagnostics.map(d => ({ ...d })) } : {}),
  }));
}
function jsonObjectFromFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isPlainJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function integerFromFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function localClaudeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    return local ? `${url.protocol}//${url.host}` : "set_non_local_redacted";
  } catch {
    return "set_unparseable_redacted";
  }
}

function lastMessagesStatusSnapshot() {
  const entry = [...requestLog].reverse().find(item => item.endpoint === "/v1/messages");
  if (!entry) return { present: false };
  return {
    present: true,
    startedAt: new Date(entry.startedAt).toISOString(),
    finalizedAt: entry.finalizedAt ? new Date(entry.finalizedAt).toISOString() : null,
    lifecycle: entry.lifecycle,
    status: entry.status ?? null,
    route: {
      provider: entry.route.provider,
      model: entry.route.routedModelLabel ?? entry.route.requestedModelLabel ?? "unknown",
      adapter: entry.route.adapter,
      routeKind: entry.route.routeKind,
    },
    upstream: entry.upstream ? {
      status: entry.upstream.status,
      contentTypeFamily: entry.upstream.contentTypeFamily,
      requestBytes: entry.upstream.requestBytes,
      responseBytes: entry.upstream.responseBytes,
      usage: entry.upstream.usage,
    } : null,
    error: entry.error ? {
      kind: entry.error.kind,
      code: entry.error.code,
      upstreamStatus: entry.error.upstreamStatus,
    } : null,
  };
}

function readWatchdogGiveUpSnapshot() {
  const statusPath = getWatchdogStatusPath();
  const raw = jsonObjectFromFile(statusPath);
  if (!existsSync(statusPath)) {
    return { present: false, attempts: null, gaveUpAt: null, unreadable: false };
  }
  if (!raw) return { present: true, attempts: null, gaveUpAt: null, unreadable: true };
  return {
    present: true,
    attempts: typeof raw.attempts === "number" && Number.isFinite(raw.attempts) ? raw.attempts : null,
    gaveUpAt: typeof raw.gaveUpAt === "string" ? raw.gaveUpAt : null,
    unreadable: false,
  };
}

function claudeInjectionSnapshot(config: FrogConfig) {
  const activePort = readActivePort() ?? config.port ?? DEFAULT_PORT;
  const state = readClaudeGatewayState(activePort);
  return {
    settingsPath: "~/.claude/settings.json",
    settingsFound: state.settingsFound,
    injected: state.applied,
    expectedBaseUrl: state.expectedBaseUrl,
    actualBaseUrl: localClaudeBaseUrl(state.actualBaseUrl),
    baseUrlMatchesExpected: state.baseUrlMatchesExpected,
    gatewayDiscovery: state.gatewayDiscovery,
    authToken: state.authToken,
    modelDiscoveryReady: state.modelDiscoveryReady,
    carrier: state.carrier,
    discoveryAuth: state.modelDiscoveryReady ? "settings" : state.applied ? "launcher" : "direct",
  };
}

function profileGatewayApplied(config: FrogConfig, profile: { id: string; claudeHome: string }): boolean {
  const activePort = readActivePort() ?? config.port ?? DEFAULT_PORT;
  return readClaudeGatewayState(activePort, { claudeHome: profile.claudeHome, profileId: profile.id }).applied;
}
function profileGatewaySnapshot(config: FrogConfig, profile: { id: string; claudeHome: string }) {
  const activePort = readActivePort() ?? config.port ?? DEFAULT_PORT;
  const state = readClaudeGatewayState(activePort, { claudeHome: profile.claudeHome, profileId: profile.id });
  return {
    settingsFound: state.settingsFound,
    injected: state.applied,
    gatewayDiscovery: state.gatewayDiscovery,
    modelDiscoveryReady: state.modelDiscoveryReady,
    carrier: state.carrier,
    discoveryAuth: state.modelDiscoveryReady ? "settings" : state.applied ? "launcher" : "direct",
  };
}

function projectGatewaySnapshot(config: FrogConfig, project: { projectPath: string; routingProfileId?: string; enrolled?: boolean }) {
  const activePort = readActivePort() ?? config.port ?? DEFAULT_PORT;
  const state = readClaudeProjectGatewayState(activePort, { projectPath: project.projectPath, routingProfileId: project.routingProfileId });
  return {
    settingsPath: state.settingsPath,
    settingsFound: state.settingsFound,
    enrolled: project.enrolled === true,
    applied: state.applied,
    gatewayDiscovery: state.gatewayDiscovery,
    modelDiscoveryReady: state.modelDiscoveryReady,
    carrier: state.carrier,
    tokenScope: state.authToken === "set_redacted" ? "project" : "none",
    effectiveSource: state.modelDiscoveryReady ? "project.local.settings" : state.applied ? "project.local.settings.partial" : "none",
    routingProfileId: project.routingProfileId,
  };
}

function claudeProjectsSnapshot(config: FrogConfig, root?: string | null) {
  const projects = listClaudeProjects(config)
    .filter(project => {
      if (!root) return true;
      try {
        return resolveClaudeProject(config, root).id === project.id;
      } catch {
        return false;
      }
    })
    .map(project => {
      const gateway = projectGatewaySnapshot(config, project);
      return {
        ...project,
        root: project.projectPath,
        settingsPath: gateway.settingsPath,
        gitProtection: project.gitProtection.status,
        gitProtectionDetail: project.gitProtection,
        gateway,
        note: "Project enrollment does not choose the Claude account or Claude Code home.",
      };
    });
  if (root && projects.length === 0) {
    const activePort = readActivePort() ?? config.port ?? DEFAULT_PORT;
    const state = readClaudeProjectGatewayState(activePort, { projectPath: root });
    const gateway = {
      settingsPath: state.settingsPath,
      settingsFound: state.settingsFound,
      enrolled: false,
      applied: state.applied,
      gatewayDiscovery: state.gatewayDiscovery,
      modelDiscoveryReady: state.modelDiscoveryReady,
      carrier: state.carrier,
      tokenScope: state.authToken === "set_redacted" ? "project" : "none",
      effectiveSource: state.modelDiscoveryReady ? "project.local.settings" : "none",
    };
    let gitProtectionDetail: ReturnType<typeof getClaudeProjectGitProtection> | undefined;
    try { gitProtectionDetail = getClaudeProjectGitProtection(root); } catch { gitProtectionDetail = undefined; }
    return {
      projects: [],
      current: {
        root,
        settingsPath: state.settingsPath,
        settingsFound: state.settingsFound,
        gitProtection: gitProtectionDetail?.status ?? "unknown",
        ...(gitProtectionDetail ? { gitProtectionDetail } : {}),
        enrolled: false,
        applied: state.applied,
        modelDiscoveryReady: state.modelDiscoveryReady,
        carrier: state.carrier,
        tokenScope: state.authToken === "set_redacted" ? "project" : "none",
        effectiveSource: state.modelDiscoveryReady ? "project.local.settings" : "none",
        gateway,
        note: "Project enrollment does not choose the Claude account or Claude Code home.",
      },
    };
  }
  return { projects };
}

function cleanupProjectsForRemovedProfile(config: FrogConfig, profileId: string): { success: boolean; error?: string; projects: string[] } {
  const projects = findClaudeProjectsForRoutingProfile(config, profileId);
  for (const project of projects) {
    const cleared = clearClaudeProjectRoutingProfileHeader(project.projectPath, profileId);
    if (!cleared.success) return { success: false, error: cleared.message, projects: projects.map(item => item.projectPath) };
  }
  clearClaudeProjectsForRoutingProfile(config, profileId);
  return { success: true, projects: projects.map(item => item.projectPath) };
}

function syncClaudeLaunchersBestEffort(config: FrogConfig): { success: boolean; error?: string } {
  try {
    syncClaudeLauncherShims(config);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}


function runtimeDiagnosticsSnapshot(config: FrogConfig) {
  const watchdogPid = integerFromFile(getWatchdogPidPath());
  const proxyPid = readPid();
  const externalSupervisorMode = parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR);
  return {
    uptimeSeconds: Math.round(process.uptime()),
    processPid: process.pid,
    configuredPort: config.port ?? DEFAULT_PORT,
    activePort: readActivePort() ?? config.port ?? DEFAULT_PORT,
    proxyPidFile: {
      present: proxyPid !== null,
      matchesCurrentProcess: proxyPid === process.pid,
    },
    externalSupervisorMode,
    watchdog: {
      enabled: resolveWatchdogEnabled(config, process.env as Record<string, string | undefined>),
      pid: watchdogPid,
      running: processIsAlive(watchdogPid),
      giveUp: readWatchdogGiveUpSnapshot(),
    },
  };
}

function claudeStatusSnapshot(config: FrogConfig) {
  return {
    ok: true,
    claudeCode: claudeInjectionSnapshot(config),
    claudeProjects: claudeProjectsSnapshot(config).projects,
    lastMessages: lastMessagesStatusSnapshot(),
    runtime: runtimeDiagnosticsSnapshot(config),
  };
}

function recordLogUsage(ctx: RequestLogContext, usage: FrogUsage | undefined): void {
  if (!usage) return;
  ctx.entry.upstream = {
    ...(ctx.entry.upstream ?? {}),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    },
  };
}

async function* observeUsageEvents(events: AsyncGenerator<AdapterEvent>, ctx: RequestLogContext): AsyncGenerator<AdapterEvent> {
  for await (const event of events) {
    if (event.type === "done") recordLogUsage(ctx, event.usage);
    if (event.type === "diagnostic") recordLogDiagnostic(ctx, event.diagnostic);
    yield event;
  }
}

function recordUsageFromEvents(ctx: RequestLogContext, events: AdapterEvent[]): void {
  for (const event of events) {
    if (event.type === "done") recordLogUsage(ctx, event.usage);
    if (event.type === "diagnostic") recordLogDiagnostic(ctx, event.diagnostic);
  }
}

function responseHeadersFromUpstream(upstream: Response, base: Record<string, string>): Headers {
  const headers = new Headers(safeResponseHeaders(upstream.headers));
  for (const [name, value] of Object.entries(base)) headers.set(name, value);
  return headers;
}

function usageSummarySnapshot(configOrRange?: FrogConfig | string | null, rangeInput?: string | null) {
  const config = typeof configOrRange === "object" && configOrRange !== null ? configOrRange : undefined;
  const rangeValue = config ? rangeInput : typeof configOrRange === "string" || configOrRange === null ? configOrRange : undefined;
  const range = parseRange(rangeValue);
  const pricingConfig = config?.usagePricing;
  const now = Date.now();
  try {
    return summarizeUsage(readUsageEntries(), range, now, pricingConfig);
  } catch {
    return summarizeUsage([], range, now, pricingConfig);
  }
}

function usagePricingSnapshot(config: FrogConfig, rangeInput?: string | null) {
  const summary = usageSummarySnapshot(config, rangeInput);
  return {
    range: summary.range,
    since: summary.since,
    generatedAt: summary.generatedAt,
    sourceState: summary.sourceState,
    pricing: summary.pricing,
  };
}

function createRequestLog(endpoint: string, method: string, headers: Headers): RequestLogContext {
  const contentLength = headers.get("content-length");
  const requestBytes = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined;
  const entry: RequestLogEntry = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    lifecycle: "in_progress",
    endpoint,
    method,
    request: { ...(requestBytes !== undefined ? { requestBytes } : {}) },
    route: { provider: "unknown" },
    phases: [],
  };
  addRequestLog(entry);
  return { entry, finalized: false, model: "unknown", provider: "unknown" };
}

function recordLogPhase(ctx: RequestLogContext, name: RequestLogPhaseName, status: "ok" | "skipped" | "error" = "ok", code?: string, startedAt = Date.now()): void {
  ctx.entry.phases.push({
    name,
    startedAt,
    durationMs: Math.max(0, Date.now() - startedAt),
    status,
    ...(code ? { code } : {}),
  });
}

function contentTypeFamily(headers: Headers): "sse" | "json" | "text" | "binary" | "unknown" {
  const value = headers.get("content-type")?.toLowerCase() ?? "";
  if (!value) return "unknown";
  if (value.includes("text/event-stream")) return "sse";
  if (value.includes("json")) return "json";
  if (value.startsWith("text/")) return "text";
  return "binary";
}


function countImages(content: string | import("./types").FrogContentPart[]): number {
  return Array.isArray(content) ? content.filter(part => part.type === "image").length : 0;
}

function setParsedLog(ctx: RequestLogContext, parsed: FrogParsedRequest): void {
  ctx.entry.request.stream = parsed.stream;
  ctx.entry.request.messageCount = parsed.context.messages.length;
  ctx.entry.request.toolDefinitionCount = parsed.context.tools?.length ?? 0;
  ctx.entry.request.toolResultCount = parsed.context.messages.filter(message => message.role === "toolResult").length;
  ctx.entry.request.imageCount = parsed.context.messages.reduce((sum, message) => {
    if (message.role === "assistant") return sum;
    return sum + countImages(message.content);
  }, 0);
  ctx.entry.request.hasSystemPrompt = (parsed.context.systemPrompt?.length ?? 0) > 0;
  ctx.entry.route.requestedModelLabel = parsed.modelId;
}

function setRouteLog(
  ctx: RequestLogContext,
  route: { providerName: string; modelId: string; provider: FrogProviderConfig },
  routeKind: RouteKind,
  ambiguousCandidates?: string[],
): void {
  ctx.model = route.modelId;
  ctx.provider = route.providerName;
  ctx.entry.route.provider = route.providerName;
  ctx.entry.route.routedModelLabel = route.modelId;
  ctx.entry.route.adapter = route.provider.adapter;
  ctx.entry.route.authMode = route.provider.authMode ?? (route.provider.apiKey ? "key" : "none");
  ctx.entry.route.routeKind = routeKind;
  if (ambiguousCandidates && ambiguousCandidates.length > 0) {
    ctx.entry.route.ambiguousCandidates = ambiguousCandidates;
  } else {
    delete ctx.entry.route.ambiguousCandidates;
  }
}

function usageFromLogEntry(entry: RequestLogEntry): FrogUsage | undefined {
  const usage = entry.upstream?.usage;
  if (typeof usage?.inputTokens !== "number" || typeof usage.outputTokens !== "number") return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(typeof usage.reasoningOutputTokens === "number" ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
  };
}

function appendFinalUsageLogEntry(ctx: RequestLogContext): void {
  if (ctx.entry.endpoint !== "/v1/messages") return;
  const usage = usageFromLogEntry(ctx.entry);
  try {
    appendUsageEntry({
      requestId: ctx.entry.id,
      timestamp: ctx.entry.startedAt,
      provider: ctx.entry.route.provider || ctx.provider || "unknown",
      model: ctx.entry.route.routedModelLabel ?? ctx.entry.route.requestedModelLabel ?? ctx.model ?? "unknown",
      status: ctx.entry.status ?? 0,
      durationMs: ctx.entry.durationMs ?? 0,
      usageStatus: usageStatusForFinalLog(usage),
      ...(usage ? { usage, totalTokens: usageTotalTokens(usage) } : {}),
    });
  } catch {
    /* usage accounting must never break the data plane */
  }
}

function finalizeRequestLog(
  ctx: RequestLogContext,
  lifecycle: Exclude<RequestLifecycle, "in_progress">,
  status?: number,
  error?: RequestLogEntry["error"],
): void {
  if (ctx.finalized) return;
  ctx.finalized = true;
  const finalizedAt = Date.now();
  ctx.entry.finalizedAt = finalizedAt;
  ctx.entry.durationMs = Math.max(0, finalizedAt - ctx.entry.startedAt);
  ctx.entry.lifecycle = lifecycle;
  if (status !== undefined) ctx.entry.status = status;
  if (error) ctx.entry.error = error;
  recordLogPhase(ctx, "finalize", error ? "error" : "ok", error?.code, finalizedAt);
  appendFinalUsageLogEntry(ctx);
}

function finalizeFromResponse(ctx: RequestLogContext, response: Response): void {
  if (ctx.finalized) return;
  const isStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
  if (isStream) return;
  if (response.status >= 400) {
    finalizeRequestLog(ctx, "internal_error", response.status, { kind: "internal", code: "response_error" });
  } else {
    finalizeRequestLog(ctx, "completed", response.status);
  }
}

async function runLoggedDataPlane(
  req: Request,
  endpoint: string,
  handler: (logCtx: RequestLogContext) => Promise<Response>,
): Promise<Response> {
  const logCtx = createRequestLog(endpoint, req.method, req.headers);
  try {
    const response = await handler(logCtx);
    finalizeFromResponse(logCtx, response);
    return response;
  } catch {
    finalizeRequestLog(logCtx, "internal_error", 500, { kind: "internal", code: "handler_exception" });
    return formatAnthropicErrorResponse(500, "internal_error", "Internal proxy error");
  }
}

function observeLoggedStream(body: ReadableStream<Uint8Array>, ctx: RequestLogContext, successStatus = 200): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  ctx.entry.upstream = { ...(ctx.entry.upstream ?? {}), responseBytes: ctx.entry.upstream?.responseBytes ?? 0 };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          recordLogPhase(ctx, "stream_bridge", "ok");
          finalizeRequestLog(ctx, "completed", successStatus);
          controller.close();
          return;
        }
        ctx.entry.upstream!.responseBytes = (ctx.entry.upstream!.responseBytes ?? 0) + value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        recordLogPhase(ctx, "stream_bridge", "error", "bridge_parse_error");
        finalizeRequestLog(ctx, "bridge_error", 500, { kind: "bridge", code: "bridge_parse_error" });
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      recordLogPhase(ctx, "stream_bridge", "error", "client_cancel");
      finalizeRequestLog(ctx, "client_cancel", 499, { kind: "internal", code: "client_cancel" });
      reader.cancel(reason).catch(() => {});
    },
  });
}
export const __requestLogTest = {
  createRequestLog,
  finalizeRequestLog,
  observeLoggedStream,
  requestLogSnapshot,
  requestLogManagementSnapshot,
  observeUsageEvents,
  recordUsageFromEvents,
  handleMessages,
  usageSummarySnapshot,
  handleManagementAPI,
  handleCountTokens,
  runLoggedDataPlane,
  effectiveModelView,
  requestClaudeProfileId,
  isNativeSlugHidden,
  noteClaudeProfileRequest,
  clear() {
    requestLog.length = 0;
  },
};

/**
 * Relay an upstream body verbatim while wiring client-cancel -> upstream.abort(). A body returned
 * directly from fetch does NOT propagate the consumer's cancel to a signalled fetch, so a client
 * disconnect would leak the upstream connection. Pumping through this stream (whose cancel() aborts
 * the upstream) fixes the leak with zero byte changes — native relay fidelity is preserved (RC2).
 */
export function relayWithAbort(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      // Client disconnected: abort the upstream fetch and release the reader so we do not leak it.
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function relaySseWithHeartbeat(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
  heartbeatMs = 15_000,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  const heartbeat = new TextEncoder().encode(": frogprogsy keepalive\n\n");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(heartbeat);
        } catch {
          cleanup();
        }
      }, heartbeatMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        cleanup();
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      cleanup();
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Bun's fetch auto-decompresses the response body but leaves the upstream `content-encoding`
 * (and a now-stale `content-length`) on `response.headers`. Relaying those with the already-decoded
 * body makes the caller double-decode / truncate → "stream error" on every native relayed response.
 * Drop encoding + hop-by-hop headers; relay everything else (content-type, etc.) verbatim.
 */
export function sanitizeRelayedHeaders(upstream: Headers): Headers {
  const DROP = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
  ]);
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!DROP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

let _corsOrigin = `http://localhost:${DEFAULT_PORT}`;
function setCorsOrigin(port: number): void { _corsOrigin = `http://localhost:${port}`; }
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": _corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isLocalOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  try {
    const url = new URL(origin || req.url);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

interface ManagementAPIDeps {
  saveConfig?: (config: FrogConfig) => void;
  /** Branch-B claude-grant management fixtures (keep the API off real network/Keychain/native homes in tests). */
  claudeGrants?: ClaudeGrantManagementDeps;
}

// ── Branch-B claude-grant management API: metadata / lifecycle / provider binding (fail-closed) ──
type ClaudeGrantStatusState = "none" | "ok" | "expiring" | "reauth_required" | "unreadable";
interface ClaudeGrantStatusValue {
  state: ClaudeGrantStatusState;
  /** Epoch ms (core) or ISO string (fixtures); never a token/refresh/path/service/secret. */
  expiresAt?: number | string;
}
/** Read-only status inspector matching core `inspectClaudeGrantStatus(config, grant)`; scoped-origin only. */
type ClaudeGrantStatusInspector = (
  config: FrogConfig,
  grant: ClaudeGrantRecord,
) => ClaudeGrantStatusValue | Promise<ClaudeGrantStatusValue>;
/** Tier-2 live probe seam mirroring core `runClaudeGrantLiveProbe(config, name, provider)`. */
type ClaudeGrantLiveProbe = (
  config: FrogConfig,
  providerName: string,
  provider: FrogProviderConfig,
) => ClaudeGrantLiveProbeResult | Promise<ClaudeGrantLiveProbeResult>;
interface ClaudeGrantManagementDeps {
  /** Injected read-only status inspector; defaults to the core `inspectClaudeGrantStatus`. */
  inspectStatus?: ClaudeGrantStatusInspector;
  /** Override the real-executable resolver used to validate guided-login readiness. */
  resolveRealClaude?: (skipDirs: string[]) => string;
  /** Fixed real Claude executable path (still asserted as a REAL executable). */
  realClaude?: string;
  /** Tier-2 consented live verification; defaults to the core `runClaudeGrantLiveProbe`. */
  liveProbe?: ClaudeGrantLiveProbe;
  /** Scoped-credential deletion seam; defaults to the core `deleteClaudeGrantCredential`. */
  deleteCredential?: (grant: ClaudeGrantRecord) => void | Promise<void>;
  /** Official-target validator for grant bindings; defaults to core `isAllowedClaudeGrantBaseUrl`. */
  validateGrantTarget?: (provider: FrogProviderConfig) => boolean;
}
interface GrantStatusView {
  state: ClaudeGrantStatusState;
  source: "inspector" | "unavailable";
  statusError?: "status_unavailable";
  expiresAt?: number | string;
}

const CLAUDE_GRANT_STATES = new Set<ClaudeGrantStatusState>([
  "none", "ok", "expiring", "reauth_required", "unreadable",
]);

/**
 * Resolve the read-only grant status inspector. Prefers an injected fixture; otherwise uses the
 * statically-imported core `inspectClaudeGrantStatus`. Always returns a function — status is now a
 * static dependency (no dynamic import, no fail-closed `status_unavailable` placeholder).
 */
function resolveGrantStatusInspector(
  deps?: ClaudeGrantManagementDeps,
): ClaudeGrantStatusInspector {
  return deps?.inspectStatus ?? (inspectClaudeGrantStatus as unknown as ClaudeGrantStatusInspector);
}

function coerceGrantStatus(raw: unknown): GrantStatusView {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (typeof record.state === "string" && CLAUDE_GRANT_STATES.has(record.state as ClaudeGrantStatusState)) {
      const view: GrantStatusView = { state: record.state as ClaudeGrantStatusState, source: "inspector" };
      if (typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)) view.expiresAt = record.expiresAt;
      else if (typeof record.expiresAt === "string" && record.expiresAt) view.expiresAt = record.expiresAt;
      return view;
    }
  }
  return { state: "unreadable", source: "unavailable", statusError: "status_unavailable" };
}

async function grantStatusView(
  inspector: ClaudeGrantStatusInspector,
  config: FrogConfig,
  grant: ClaudeGrantRecord,
): Promise<GrantStatusView> {
  try {
    return coerceGrantStatus(await inspector(config, grant));
  } catch {
    return { state: "unreadable", source: "unavailable", statusError: "status_unavailable" };
  }
}

/** Providers bound to a grant id via `claude-grant` auth mode (drives dangling warnings). */
function grantBoundProviders(config: FrogConfig, grantId: string): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.authMode === "claude-grant" && provider.claudeGrantId === grantId)
    .map(([name]) => name)
    .sort();
}

/** Anthropic `claude-grant` providers bound to this grant id (tier-2 live-probe candidates). */
function grantProbeProviders(config: FrogConfig, grantId: string): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.authMode === "claude-grant" && provider.claudeGrantId === grantId && provider.adapter === "anthropic")
    .map(([name]) => name)
    .sort();
}

/**
 * Resolve the REAL Claude executable used for guided login, independent of any single grant. Mirrors
 * the resolution inside `buildClaudeGrantLoginCommand` (caller-provided path, else a resolver that
 * skips the launcher bin + grants root) and asserts it is a real executable (never a bare basename or
 * a managed frogprogsy shim). Throws when no safe real executable is available.
 */
function resolveRealClaudeExecutable(deps?: ClaudeGrantManagementDeps): string {
  const resolver = deps?.resolveRealClaude ?? ((skip: string[]) => findRealClaudeExecutable(skip));
  const candidate = deps?.realClaude ?? resolver([claudeLauncherBinDir(), grantsRoot()]);
  return assertRealClaudeExecutable(candidate);
}

/**
 * Render an absolute path as a `$HOME/…` token when it is under the user home so responses never leak
 * the literal home directory / username. Paths outside the home are returned verbatim (a system path
 * such as `/usr/local/bin/claude` carries no PII); a bare basename is never produced here.
 */
function homeTokenizePath(absPath: string): string {
  const home = (process.env.HOME?.trim() || homedir() || "").replace(/[/\\]+$/, "");
  if (home && (absPath === home || absPath.startsWith(`${home}${sep}`))) {
    return `$HOME${absPath.slice(home.length)}`;
  }
  return absPath;
}

/** Double-quote a shell token, keeping a leading literal `$HOME` expandable by the shell. */
function grantShellDoubleQuote(token: string): string {
  const hasHome = token.startsWith("$HOME");
  const rest = hasHome ? token.slice("$HOME".length) : token;
  const escaped = rest.replace(/(["\\$`])/g, "\\$1");
  return `"${hasHome ? "$HOME" : ""}${escaped}"`;
}
/** Double-quote a PowerShell token, preserving only a leading literal `$HOME` expansion. */
function grantPowerShellDoubleQuote(token: string): string {
  const hasHome = token.startsWith("$HOME");
  const rest = hasHome ? token.slice("$HOME".length) : token;
  const escaped = rest.replace(/([`"$])/g, "`$1");
  return `"${hasHome ? "$HOME" : ""}${escaped}"`;
}

/** Real-executable readiness + `$HOME`-tokenized display name for the GUI (never a bare `claude`). */
function realClaudeInfo(deps?: ClaudeGrantManagementDeps): { ready: boolean; name?: string } {
  try {
    return { ready: true, name: homeTokenizePath(resolveRealClaudeExecutable(deps)) };
  } catch {
    return { ready: false };
  }
}

/**
 * Guided-login setup for a freshly created grant. `command` is a copy-pasteable POSIX-shell line on
 * POSIX and a PowerShell line on Windows. It uses the VALIDATED real executable path and a
 * `$HOME`-tokenized scoped `CLAUDE_CONFIG_DIR`; it is never a bare basename and carries no
 * token/credential (a guided-login command never does).
 */
function grantSetup(record: ClaudeGrantRecord, realExecutable: string): {
  command: string; argv: string[]; env: { CLAUDE_CONFIG_DIR: string }; expectedService: string;
} {
  const configDirToken = homeTokenizePath(record.configDir);
  const exeToken = homeTokenizePath(realExecutable);
  const args = [...DEFAULT_GRANT_LOGIN_ARGS];
  const command = process.platform === "win32"
    ? `$env:CLAUDE_CONFIG_DIR=${grantPowerShellDoubleQuote(configDirToken)}; & ${grantPowerShellDoubleQuote(exeToken)} ${args.join(" ")}`
    : `CLAUDE_CONFIG_DIR=${grantShellDoubleQuote(configDirToken)} ${grantShellDoubleQuote(exeToken)} ${args.join(" ")}`;
  return {
    command,
    argv: [exeToken, ...args],
    env: { CLAUDE_CONFIG_DIR: configDirToken },
    expectedService: expectedKeychainService(record.configDir),
  };
}

/** Real-executable readiness + scoped-service meta for a grant — never leaks an absolute path. */
function grantExecutableView(
  grant: ClaudeGrantRecord,
  deps?: ClaudeGrantManagementDeps,
): { executable: { ready: boolean; display?: string }; service?: string } {
  let service: string | undefined;
  try { service = expectedKeychainService(grant.configDir); } catch { /* ignore */ }
  try {
    const command = buildClaudeGrantLoginCommand({
      grant: { id: grant.id, configDir: grant.configDir },
      realClaude: deps?.realClaude,
      resolveRealClaude: deps?.resolveRealClaude,
    });
    return { executable: { ready: true, display: basename(command.command) || "claude" }, service: service ?? command.expectedService };
  } catch {
    return { executable: { ready: false }, ...(service ? { service } : {}) };
  }
}

function mapGrantExecutableError(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("managed frogprogsy launcher") || message.includes("launcher directory") || message.includes("source directory")) {
    return { code: "managed_executable_rejected", message: "refusing a managed frogprogsy launcher/shim; guided login requires a real Claude executable" };
  }
  return { code: "real_executable_unavailable", message: "no real Claude executable is available on PATH for guided login; install Claude Code and retry" };
}

function mapGrantRemovalError(err: unknown): { status: number; code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("marker id")) {
    return { status: 409, code: "grant_marker_mismatch", message: "grant directory marker does not bind this grant id" };
  }
  if (message.includes("outside the claude-grants root") || message.includes("does not match the expected") || message.includes("equals the claude-grants root")) {
    return { status: 400, code: "grant_path_invariant", message: "grant directory failed the claude-grants root safety check" };
  }
  return { status: 409, code: "grant_remove_failed", message: "grant could not be removed" };
}

/**
 * Hard validation for `claude-grant` provider bindings on create/update. Beyond adapter + known-grant
 * checks, the base URL MUST pass the official-target validator so a grant token can only ever be sent
 * to the official Anthropic API endpoint. `validateTarget` defaults to provider-auth's
 * `isAllowedClaudeGrantBaseUrl` and is injectable for tests.
 */
function validateClaudeGrantProviderBinding(
  config: FrogConfig,
  provider: FrogProviderConfig,
  validateTarget: (provider: FrogProviderConfig) => boolean = isAllowedClaudeGrantBaseUrl,
): { ok: true } | { ok: false; message: string } {
  if (provider.authMode !== "claude-grant") return { ok: true };
  if (provider.adapter !== "anthropic") {
    return { ok: false, message: "claude-grant auth mode is only valid for the anthropic adapter" };
  }
  const id = typeof provider.claudeGrantId === "string" ? provider.claudeGrantId.trim() : "";
  if (!id) return { ok: false, message: "claude-grant auth mode requires claudeGrantId" };
  if (!isValidGrantId(id)) return { ok: false, message: "claudeGrantId is not a valid claude grant id" };
  if (!getClaudeGrantById(config, id)) return { ok: false, message: "claudeGrantId does not match a known claude grant" };
  if (!validateTarget(provider)) {
    return { ok: false, message: "claude-grant providers may only target the official Anthropic API endpoint" };
  }
  return { ok: true };
}
function claudeWritesBlocked(reason: string): boolean {
  if (process.env.FROGPROGSY_NO_CLAUDE_WRITES !== "1") return false;
  console.error(`frogprogsy: blocked Claude Code environment write (${reason}); FROGPROGSY_NO_CLAUDE_WRITES=1`);
  return true;
}

type ClaudeModelReloadStatus = "synced" | "partial" | "skipped" | "failed" | "unknown";

interface ClaudeModelReloadMetadata {
  schemaVersion: 1;
  action: "claude-model-reload";
  profileId: string;
  command: string;
  attempted: boolean;
  writeBlocked: boolean;
  status: ClaudeModelReloadStatus;
  catalog: {
    path?: string;
    added?: number;
    exists: boolean | null;
    cacheSynced: boolean;
  };
  gatewayCache: ClaudeCodeGatewayModelsCacheSyncResult;
  proxy: {
    checked: false;
    running: null;
    guidance: string;
  };
  nextStep: {
    requiresClaudeCodeStartOrResume: true;
    hotReloadSupported: false;
    guidance: string;
    reason: "claude-code-2.1.202-start-resume-observed";
  };
  warnings: string[];
}

function claudeModelReloadMetadata(
  profileId: string,
  params: {
    attempted: boolean;
    writeBlocked: boolean;
    status: ClaudeModelReloadStatus;
    catalog?: ClaudeModelReloadMetadata["catalog"];
    gatewayCache?: ClaudeCodeGatewayModelsCacheSyncResult;
    warnings?: string[];
  },
): ClaudeModelReloadMetadata {
  const warningSet = new Set(params.warnings ?? []);
  if (params.gatewayCache?.warning) warningSet.add(params.gatewayCache.warning);
  return {
    schemaVersion: 1,
    action: "claude-model-reload",
    profileId,
    command: `frogp claude reload-models ${profileId}`,
    attempted: params.attempted,
    writeBlocked: params.writeBlocked,
    status: params.status,
    catalog: params.catalog ?? { exists: null, cacheSynced: false },
    gatewayCache: params.gatewayCache ?? { status: "unknown" },
    proxy: {
      checked: false,
      running: null,
      guidance: "Run frogp refresh if the proxy is not answering.",
    },
    nextStep: {
      requiresClaudeCodeStartOrResume: true,
      hotReloadSupported: false,
      reason: "claude-code-2.1.202-start-resume-observed",
      guidance: "Start or resume Claude Code so it refetches /v1/models; already-open /model pickers are not hot-reloaded.",
    },
    warnings: [...warningSet],
  };
}

function claudeModelReloadStatus(refreshed: ClaudeCodeCatalogRefreshResult): ClaudeModelReloadStatus {
  if (refreshed.gatewayCache.status === "failed") return "failed";
  if (refreshed.warnings.length > 0) return "partial";
  if (refreshed.cacheSynced && refreshed.gatewayCache.status === "written") return "synced";
  if (refreshed.cacheSynced || refreshed.gatewayCache.status === "written") return "partial";
  return "unknown";
}

const ANTHROPIC_PROFILE_MODELS_CACHE_PREFIX = "anthropic-profile";

function isRealForwardAuthValue(value: string | undefined | null): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return trimmed !== "local-frogprogsy" && !/^Bearer\s+local-frogprogsy$/i.test(trimmed);
}

function profileRequestHasForwardAuth(headers: Headers): boolean {
  return isRealForwardAuthValue(headers.get("authorization")) || isRealForwardAuthValue(headers.get("x-api-key"));
}

function disabledModels(config: FrogConfig): Set<string> {
  return new Set(config.disabledModels ?? []);
}

function isModelDisabled(config: FrogConfig, modelId: string): boolean {
  return disabledModels(config).has(modelId);
}

function isRouteDisabled(config: FrogConfig, providerName: string, modelId: string, requestedModelId?: string): boolean {
  const disabled = disabledModels(config);
  const namespaced = `${providerName}/${modelId}`;
  return disabled.has(namespaced) || disabled.has(modelId) || (requestedModelId ? disabled.has(requestedModelId) : false);
}
function isCatalogModelHidden(config: FrogConfig, model: CatalogModel): boolean {
  return isRouteDisabled(config, model.provider, model.id, `${model.provider}/${model.id}`);
}
function isNativeSlugHidden(config: FrogConfig, slug: string): boolean {
  const disabled = disabledModels(config);
  return disabled.has(slug) || disabled.has(`openai/${slug}`);
}

function profileModelsCacheKey(profileId: string): string {
  return `${ANTHROPIC_PROFILE_MODELS_CACHE_PREFIX}:${profileId}`;
}

function anthropicForwardProvider(config: FrogConfig): [string, FrogProviderConfig] | null {
  const named = config.providers.anthropic;
  if (named?.adapter === "anthropic" && named.authMode === "forward") return ["anthropic", named];
  return Object.entries(config.providers).find((entry): entry is [string, FrogProviderConfig] => {
    const [, provider] = entry;
    return provider.adapter === "anthropic" && provider.authMode === "forward";
  }) ?? null;
}

function parseAnthropicModelList(providerName: string, json: unknown): CatalogModel[] {
  const data = json && typeof json === "object"
    ? (json as { data?: unknown; models?: unknown }).data ?? (json as { data?: unknown; models?: unknown }).models
    : undefined;
  const items = Array.isArray(data) ? data : [];
  const out: CatalogModel[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) continue;
    out.push({ id: id.trim(), provider: providerName, owned_by: "anthropic" });
  }
  return out;
}
function configuredForwardCatalogModels(config: FrogConfig): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (provider.authMode !== "forward") continue;
    const ids = new Set<string>();
    if (provider.defaultModel?.trim()) ids.add(provider.defaultModel.trim());
    for (const model of provider.models ?? []) {
      if (model.trim()) ids.add(model.trim());
    }
    for (const id of ids) out.push({ id, provider: providerName, owned_by: provider.adapter });
  }
  return out;
}


async function fetchAnthropicProfileModels(config: FrogConfig, profileId: string | undefined, headers?: Headers): Promise<CatalogModel[]> {
  if (!profileId) return [];
  const cacheKey = profileModelsCacheKey(profileId);
  const ttlMs = config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  const fresh = getFreshCached(cacheKey, ttlMs);
  if (fresh) return fresh;

  const forwardedAuthorization = headers?.get("authorization")?.trim();
  const forwardedApiKey = headers?.get("x-api-key")?.trim();
  const authHeader = isRealForwardAuthValue(forwardedApiKey)
    ? { name: "x-api-key", value: forwardedApiKey! }
    : isRealForwardAuthValue(forwardedAuthorization)
      ? { name: "Authorization", value: forwardedAuthorization! }
      : null;

  if (!authHeader) return getStaleCached(cacheKey) ?? [];

  const providerEntry = anthropicForwardProvider(config);
  if (!providerEntry) return getStaleCached(cacheKey) ?? [];
  const [providerName, provider] = providerEntry;
  const base = provider.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const requestHeaders: Record<string, string> = {
    ...(provider.headers ?? {}),
    "anthropic-version": headers?.get("anthropic-version")?.trim() || "2023-06-01",
    [authHeader.name]: authHeader.value,
  };
  const incomingBeta = headers?.get("anthropic-beta")?.trim();
  if (incomingBeta) requestHeaders["anthropic-beta"] = incomingBeta;

  try {
    const res = await fetch(`${base}/v1/models?limit=1000`, { headers: requestHeaders, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) updateClaudeProfileAuthState(config, profileId, "oauth_rejected");
      return getStaleCached(cacheKey) ?? [];
    }
    const models = parseAnthropicModelList(providerName, await res.json());
    setCached(cacheKey, models);
    return models;
  } catch {
    return getStaleCached(cacheKey) ?? [];
  }
}

function mergeCatalogModels(models: CatalogModel[]): CatalogModel[] {
  const out = new Map<string, CatalogModel>();
  for (const model of models) out.set(`${model.provider}/${model.id}`, model);
  return [...out.values()].sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
}

async function effectiveModelView(config: FrogConfig, options: { profileId?: string; headers?: Headers; includeConfiguredForwardModels?: boolean } = {}): Promise<{
  models: CatalogModel[];
  enabledModels: CatalogModel[];
  disabled: Set<string>;
  featured: string[] | undefined;
}> {
  const models = mergeCatalogModels([
    ...await fetchAllModels(config),
    ...(options.includeConfiguredForwardModels ? configuredForwardCatalogModels(config) : []),
    ...await fetchAnthropicProfileModels(config, options.profileId, options.headers),
  ]);
  const disabled = disabledModels(config);
  return {
    models,
    enabledModels: models.filter(model => !isCatalogModelHidden(config, model)),
    disabled,
    featured: config.subagentModels,
  };
}
function requestClaudeProfileId(req: Request, config: FrogConfig): string | undefined {
  const raw = req.headers.get("x-frogp-claude-profile")?.trim() || undefined;
  if (!raw) return undefined;
  return resolveClaudeProfile(config, raw).id;
}


function noteClaudeProfileRequest(config: FrogConfig, profileId: string | undefined, headers: Headers, status?: "oauth_ok" | "oauth_rejected"): void {
  if (!profileId) return;
  updateClaudeProfileAuthState(config, profileId, status ?? (profileRequestHasForwardAuth(headers) ? "oauth_ok" : "seen_no_bearer"));
}


async function handleManagementAPI(req: Request, url: URL, config: FrogConfig, deps: ManagementAPIDeps = {}): Promise<Response | null> {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !isLocalOrigin(req)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403);
  }
  const persistConfig = deps.saveConfig ?? saveConfig;
  async function refreshClaudeCodeCatalogBestEffort(profile?: { claudeHome?: string; profileId?: string }): Promise<void> {
    if (claudeWritesBlocked("catalog refresh")) return;
    try {
      const { refreshClaudeCodeModelCatalog } = await import("./claude-refresh");
      await refreshClaudeCodeModelCatalog(config, undefined, profile);
    } catch {
      /* catalog absent */
    }
  }

  async function persistProviderConfigIfChanged(changed: boolean): Promise<void> {
    if (!changed) return;
    persistConfig(config);
    await refreshClaudeCodeCatalogBestEffort();
  }

  await persistProviderConfigIfChanged(restoreCredentialedOAuthProviderConfigs(config));

  const providerSummaries = () => Object.entries(config.providers).map(([name, p]) => ({
    name,
    ...redactProviderForApi(p),
    hasApiKey: effectiveKeyCandidates(p).length > 0,
    apiKeyCount: effectiveKeyCandidates(p).length,
    balanceSupported: false,
  }));

  const isRedactedCredentialPlaceholder = (value: unknown): boolean =>
    typeof value === "string" && (value === "..." || value === "[REDACTED]" || /^.{3}\.\.\..{4}$/.test(value));

  const hasRedactedProviderCredentials = (provider: FrogProviderConfig): boolean =>
    isRedactedCredentialPlaceholder(provider.apiKey) ||
    (provider.apiKeys ?? []).some(isRedactedCredentialPlaceholder) ||
    Object.values(provider.headers ?? {}).some(isRedactedCredentialPlaceholder);

  const ensureClaudeCodeHomeForProvider = (providerName: string, claudeHome: string): void => {
    const normalizedHome = expandHomePath(claudeHome);
    const profiles = ensureClaudeProfiles(config);
    if (profiles.profiles.some(profile => expandHomePath(profile.claudeHome) === normalizedHome)) return;

    let profileName = providerName;
    for (let i = 2; profiles.profiles.some(profile => profile.name === profileName); i++) {
      profileName = `${providerName}-${i}`;
    }
    addClaudeProfile(config, { name: profileName, claudeHome: normalizedHome });
  };

  type FallbackFeature = "webSearch" | "image";
  type FallbackProviderOption = { name: string; models: string[]; defaultModel?: string };

  const allFallbackModels = (provider: FrogProviderConfig, extraModel?: string): string[] => {
    const models = new Set<string>();
    if (provider.defaultModel) models.add(provider.defaultModel);
    for (const model of provider.models ?? []) models.add(model);
    if (extraModel) models.add(extraModel);
    return [...models].sort((a, b) => a.localeCompare(b));
  };

  const featureFallbackModels = (
    feature: FallbackFeature,
    providerName: string,
    provider: FrogProviderConfig,
    extraModel?: string,
  ): string[] => {
    const models = allFallbackModels(provider, extraModel);
    const supported = models.filter(model => {
      const capabilities = resolveModelCapabilities(providerName, provider, model);
      return feature === "image"
        ? supportsImageInput(capabilities) === true
        : supportsNativeWebSearch(capabilities) === true;
    });
    return supported.length > 0 ? supported : models;
  };

  const fallbackProviderOptions = (
    feature: FallbackFeature,
    extraModels: Record<string, string | undefined> = {},
  ): FallbackProviderOption[] => Object.entries(config.providers)
    .filter(([, provider]) => isOpenAIResponsesFallbackProvider(provider))
    .map(([name, provider]) => ({
      name,
      models: featureFallbackModels(feature, name, provider, extraModels[name]),
      defaultModel: provider.defaultModel,
    }));

  const mergeProviderOptions = (...groups: FallbackProviderOption[][]): FallbackProviderOption[] => {
    const byName = new Map<string, FallbackProviderOption>();
    for (const group of groups) {
      for (const provider of group) {
        const prev = byName.get(provider.name);
        if (!prev) {
          byName.set(provider.name, { ...provider, models: [...provider.models] });
        } else {
          const models = new Set([...prev.models, ...provider.models]);
          byName.set(provider.name, {
            ...prev,
            defaultModel: prev.defaultModel ?? provider.defaultModel,
            models: [...models].sort((a, b) => a.localeCompare(b)),
          });
        }
      }
    }
    return [...byName.values()];
  };

  const selectedFallbackProvider = (configuredName: string | undefined, providers: FallbackProviderOption[]): string => {
    if (configuredName && providers.some(provider => provider.name === configuredName)) return configuredName;
    return providers[0]?.name ?? "";
  };

  const fallbackSettingsSnapshot = (includeOk = false) => {
    const ws = config.webSearchFallback ?? {};
    const img = config.imageFallback ?? {};
    const webSearchProviders = fallbackProviderOptions("webSearch", ws.provider ? { [ws.provider]: ws.model } : {});
    const imageProviders = fallbackProviderOptions("image", img.provider ? { [img.provider]: img.model } : {});
    const webSearchProvider = selectedFallbackProvider(ws.provider, webSearchProviders);
    const imageProvider = selectedFallbackProvider(img.provider, imageProviders);
    const providers = mergeProviderOptions(webSearchProviders, imageProviders);
    const modelsFor = (providerList: FallbackProviderOption[], providerName: string, current: string | undefined): string[] =>
      providerList.find(provider => provider.name === providerName)?.models
        ?? (current ? [current] : providerList[0]?.models ?? []);
    const defaultModelFor = (providerList: FallbackProviderOption[], providerName: string, current: string | undefined): string =>
      current ?? modelsFor(providerList, providerName, undefined)[0] ?? "";
    return {
      ...(includeOk ? { ok: true } : {}),
      providers,
      webSearchProviders,
      imageProviders,
      webSearch: {
        enabled: ws.enabled === true,
        provider: webSearchProvider,
        model: defaultModelFor(webSearchProviders, webSearchProvider, ws.model),
        reasoning: ws.reasoning ?? "low",
        searchProviders: Object.fromEntries(Object.entries(ws.searchProviders ?? {}).map(([name, provider]) => [name, {
          enabled: provider.enabled !== false,
          provider: provider.provider ?? name,
          hasApiKey: !!provider.apiKey,
          hasBaseUrl: !!provider.baseUrl,
          ...(provider.maxResults !== undefined ? { maxResults: provider.maxResults } : {}),
          ...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
        }])),
        noKey: {
          enabled: ws.noKey?.enabled === true,
          ...(ws.noKey?.maxResults !== undefined ? { maxResults: ws.noKey.maxResults } : {}),
          ...(ws.noKey?.timeoutMs !== undefined ? { timeoutMs: ws.noKey.timeoutMs } : {}),
        },
      },
      image: {
        enabled: img.enabled === true,
        provider: imageProvider,
        model: defaultModelFor(imageProviders, imageProvider, img.model),
      },
    };
  };
  const redactedWebSearchFallback = () => redactConfigForApi(config).webSearchFallback;
  async function readOptionalJsonBody(): Promise<Record<string, unknown>> {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) return {};
    try {
      const body = await req.json();
      return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  if (url.pathname.startsWith("/api/claude-projects") && !isLocalOrigin(req)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403);
  }

  if (url.pathname === "/api/claude-projects" && req.method === "GET") {
    return jsonResponse(claudeProjectsSnapshot(config, url.searchParams.get("root")));
  }

  if (url.pathname === "/api/claude-projects" && req.method === "POST") {
    let body: { root?: unknown; routingProfileId?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const root = typeof body.root === "string" ? body.root.trim() : "";
    const routingProfileId = typeof body.routingProfileId === "string" && body.routingProfileId.trim() ? body.routingProfileId.trim() : undefined;
    if (!root) return jsonResponse({ error: "root is required" }, 400);
    if (routingProfileId) {
      try { resolveClaudeProfile(config, routingProfileId); } catch { return jsonResponse({ error: "unknown Claude Code home" }, 404); }
    }
    try {
      let project;
      try {
        project = resolveClaudeProject(config, root);
        project.routingProfileId = routingProfileId;
      } catch {
        project = addClaudeProject(config, { projectPath: root, routingProfileId });
      }
      const result = injectClaudeProjectSettings(config.port ?? DEFAULT_PORT, {
        projectPath: project.projectPath,
        routingProfileId: project.routingProfileId,
        gatewayAuthCarrier: config.gatewayAuthCarrier,
      });
      if (!result.success) return jsonResponse({ success: false, error: result.message }, 409);
      markClaudeProjectEnrolled(config, project.id, true);
      persistConfig(config);
      return jsonResponse({ success: true, message: result.message, project: { ...project, gateway: projectGatewaySnapshot(config, project) } }, 201);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Claude project could not be enrolled" }, 409);
    }
  }

  if (url.pathname.startsWith("/api/claude-projects/")) {
    const parts = url.pathname.split("/");
    const selector = decodeURIComponent(parts[3] ?? "");
    const action = parts[4];
    let project;
    try {
      project = resolveClaudeProject(config, selector);
    } catch {
      return jsonResponse({ error: "unknown Claude project" }, 404);
    }

    if (action === "restore" && req.method === "POST") {
      const result = restoreClaudeProjectSettings(project.projectPath);
      if (!result.success) return jsonResponse({ success: false, error: result.message }, 500);
      project.enrolled = false;
      persistConfig(config);
      return jsonResponse({ success: true, message: result.message, project: { ...project, gateway: projectGatewaySnapshot(config, project) } });
    }

    if (!action && req.method === "DELETE") {
      const result = restoreClaudeProjectSettings(project.projectPath);
      if (!result.success) return jsonResponse({ success: false, error: result.message }, 500);
      const removed = removeClaudeProject(config, project.id);
      persistConfig(config);
      return jsonResponse({ success: true, removed });
    }
  }

  if (url.pathname === "/api/claude-profiles" && req.method === "GET") {
    ensureClaudeProfiles(config);
    const profiles = listClaudeProfiles(config).map(profile => {
      const gateway = profileGatewaySnapshot(config, profile);
      return { ...profile, injected: gateway.injected, gateway };
    });
    return jsonResponse({ profiles });
  }

  if (url.pathname === "/api/claude-profiles" && req.method === "POST") {
    let body: { name?: unknown; claudeHome?: unknown; home?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const claudeHome = typeof body.claudeHome === "string" ? body.claudeHome : typeof body.home === "string" ? body.home : "";
    if (!name || !claudeHome) return jsonResponse({ error: "name and claudeHome are required" }, 400);
    try {
      const profile = addClaudeProfile(config, { name, claudeHome });
      persistConfig(config);
      const launcherSync = syncClaudeLaunchersBestEffort(config);
      return jsonResponse({ profile, launcherSync }, 201);
    } catch {
      return jsonResponse({ error: "Claude Code home could not be added" }, 409);
    }
  }

  if (url.pathname.startsWith("/api/claude-profiles/")) {
    const parts = url.pathname.split("/");
    const profileSelector = decodeURIComponent(parts[3] ?? "");
    const action = parts[4];
    let profile;
    try {
      profile = resolveClaudeProfile(config, profileSelector);
    } catch {
      return jsonResponse({ error: "unknown Claude Code home" }, 404);
    }

    if (!action && req.method === "PATCH") {
      let body: { name?: unknown };
      try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
      if (typeof body.name === "string") profile = renameClaudeProfile(config, profile.id, body.name);
      persistConfig(config);
      const launcherSync = syncClaudeLaunchersBestEffort(config);
      await refreshClaudeCodeCatalogBestEffort({ claudeHome: profile.claudeHome, profileId: profile.id });
      return jsonResponse({ profile, launcherSync });
    }

    if (!action && req.method === "DELETE") {
      try {
        if (ensureClaudeProfiles(config).profiles.length <= 1) {
          return jsonResponse({ error: "Cannot remove the only Claude Code home" }, 409);
        }
        if (profile.injected === true || profileGatewayApplied(config, profile)) {
          if (claudeWritesBlocked("Claude Code home remove restore")) {
            return jsonResponse({ error: "restore this gateway-applied Claude Code home before removing it" }, 409);
          }
          const { restoreNativeClaudeCode } = await import("./claude-inject");
          const restored = restoreNativeClaudeCode({ claudeHome: profile.claudeHome, profileId: profile.id });
          if (!restored.success) return jsonResponse({ error: restored.message }, 500);
          profile.injected = false;
        }
        const projectCleanup = cleanupProjectsForRemovedProfile(config, profile.id);
        if (!projectCleanup.success) return jsonResponse({ error: projectCleanup.error ?? "project profile cleanup failed", projects: projectCleanup.projects }, 409);
        const removed = removeClaudeProfile(config, profile.id);
        persistConfig(config);
        const launcherSync = syncClaudeLaunchersBestEffort(config);
        return jsonResponse({ removed, launcherSync });
      } catch {
        return jsonResponse({ error: "Claude Code home could not be removed" }, 409);
      }
    }

    if ((action === "inject" || action === "refresh") && req.method === "POST") {
      const actionBody = await readOptionalJsonBody();
      const includeAuthToken = actionBody.globalDiscoveryAuth === true;
      if (claudeWritesBlocked(`Claude Code home ${action}`)) {
        const message = `Claude Code environment writes disabled; home ${action} skipped.`;
        if (action !== "refresh") return jsonResponse({ success: true, message });
        const warning = "Claude Code environment writes disabled; model reload skipped.";
        return jsonResponse({
          success: true,
          message,
          profile,
          modelReload: claudeModelReloadMetadata(profile.id, {
            attempted: false,
            writeBlocked: true,
            status: "skipped",
            gatewayCache: { status: "skipped", warning },
            warnings: [warning],
          }),
        });
      }
      const { injectClaudeCodeConfig } = await import("./claude-inject");
      let catalogPath: string | null | undefined;
      let modelReload: ClaudeModelReloadMetadata | undefined;
      if (action === "refresh") {
        const { refreshClaudeCodeModelCatalog } = await import("./claude-refresh");
        const refreshed = await refreshClaudeCodeModelCatalog(config, undefined, { claudeHome: profile.claudeHome, profileId: profile.id });
        catalogPath = refreshed.catalogExists ? refreshed.path : undefined;
        modelReload = claudeModelReloadMetadata(profile.id, {
          attempted: true,
          writeBlocked: false,
          status: claudeModelReloadStatus(refreshed),
          catalog: {
            path: refreshed.path,
            added: refreshed.added,
            exists: refreshed.catalogExists,
            cacheSynced: refreshed.cacheSynced,
          },
          gatewayCache: refreshed.gatewayCache,
          warnings: refreshed.warnings,
        });
      }
      const result = await injectClaudeCodeConfig(config.port ?? DEFAULT_PORT, config, { catalogPath, claudeHome: profile.claudeHome, profileId: profile.id, includeAuthToken });
      if (!result.success) return jsonResponse({ success: false, error: result.message }, 500);
      markClaudeProfileInjected(config, profile.id, true);
      persistConfig(config);
      return jsonResponse({ success: true, message: result.message, profile, ...(modelReload ? { modelReload } : {}) });
    }

    if (action === "restore" && req.method === "POST") {
      if (claudeWritesBlocked("Claude Code home restore")) return jsonResponse({ success: true, message: "Claude Code environment writes disabled; home restore skipped." });
      const { restoreNativeClaudeCode } = await import("./claude-inject");
      const result = restoreNativeClaudeCode({ claudeHome: profile.claudeHome, profileId: profile.id });
      if (!result.success) return jsonResponse({ success: false, error: result.message }, 500);
      profile.injected = false;
      profile.lastInjectedAt = new Date().toISOString();
      persistConfig(config);
      return jsonResponse({ success: true, message: result.message, profile });
    }
  }
  if (url.pathname === "/api/claude-status" && req.method === "GET") {
    return jsonResponse(claudeStatusSnapshot(config));
  }

  // ── Branch-B claude-grant management API (local-origin only; fail-closed; no credential/path leaks) ──
  if (url.pathname.startsWith("/api/claude-grants") && !isLocalOrigin(req)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403);
  }

  if (url.pathname === "/api/claude-grants" && req.method === "GET") {
    const inspector = resolveGrantStatusInspector(deps.claudeGrants);
    const realClaude = realClaudeInfo(deps.claudeGrants);
    // Build each grant's guided re-auth command server-side via the authoritative grantSetup()
    // builder so the GUI never reconstructs a scoped CLAUDE_CONFIG_DIR path. Resolve the validated
    // real executable once; when unavailable (null) the command is simply omitted, mirroring
    // realClaude.ready. The command is $HOME-tokenized and carries no token/credential.
    let realExecutable: string | null = null;
    try { realExecutable = resolveRealClaudeExecutable(deps.claudeGrants); } catch { realExecutable = null; }
    const grants = await Promise.all(listClaudeGrants(config).map(async grant => {
      const status = await grantStatusView(inspector, config, grant);
      const entry: Record<string, unknown> = {
        id: grant.id,
        label: grant.label,
        state: status.state,
        boundProviders: grantBoundProviders(config, grant.id),
        realClaudeReady: realClaude.ready,
      };
      if (realExecutable) entry.reauthCommand = grantSetup(grant, realExecutable).command;
      if (status.expiresAt !== undefined) {
        entry.expiresAt = typeof status.expiresAt === "number" ? new Date(status.expiresAt).toISOString() : status.expiresAt;
      }
      if (status.statusError) entry.statusError = status.statusError;
      return entry;
    }));
    return jsonResponse({ grants, realClaude, statusAvailable: true });
  }

  if (url.pathname === "/api/claude-grants" && req.method === "POST") {
    let body: { label?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) return jsonResponse({ error: "label is required" }, 400);

    // Resolve + assert the real executable BEFORE mutating/persisting config, so a missing or unsafe
    // executable can never leave a persisted grant that could never complete guided login (no crash
    // orphan window). Only after this succeeds do we create + persist the grant record.
    let realExecutable: string;
    try {
      realExecutable = resolveRealClaudeExecutable(deps.claudeGrants);
    } catch (err) {
      return jsonResponse({ error: mapGrantExecutableError(err) }, 409);
    }

    let record: ClaudeGrantRecord;
    try {
      record = addClaudeGrant(config, { label });
    } catch {
      return jsonResponse({ error: "claude grant could not be created" }, 409);
    }
    persistConfig(config);

    return jsonResponse({
      grant: { id: record.id, label: record.label, createdAt: record.createdAt },
      boundProviders: [],
      setup: grantSetup(record, realExecutable),
      nextStep: "run the printed setup.command yourself to complete guided login; frogprogsy never launches it or automates a browser",
    }, 201);
  }

  if (url.pathname.startsWith("/api/claude-grants/")) {
    const parts = url.pathname.split("/");
    const grantId = decodeURIComponent(parts[3] ?? "");
    const grantAction = parts[4];
    const grant = getClaudeGrantById(config, grantId);
    if (!grant) return jsonResponse({ error: "unknown claude grant" }, 404);

    if (!grantAction && req.method === "DELETE") {
      const bound = grantBoundProviders(config, grant.id);
      const confirmed = url.searchParams.get("confirm") === "true";
      if (bound.length > 0 && !confirmed) {
        return jsonResponse({
          error: {
            code: "grant_bound",
            message: `grant is bound to ${bound.length} provider(s); resend with ?confirm=true to delete and leave the binding(s) dangling`,
          },
          boundProviders: bound,
        }, 409);
      }
      try {
        assertClaudeGrantRemovalSafe(config, grant.id);
      } catch (err) {
        const mapped = mapGrantRemovalError(err);
        return jsonResponse({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
      }
      // Scoped-credential cleanup MUST succeed before we drop the metadata/dir so removal never
      // orphans a local secret. On failure the record/dir/config are left intact (fixed 409). This
      // touches ONLY the grant's scoped origin — never a native/global Keychain login or other grant.
      const deleteCredential = deps.claudeGrants?.deleteCredential ?? ((g: ClaudeGrantRecord) => deleteClaudeGrantCredential(g));
      try {
        await deleteCredential(grant);
      } catch {
        return jsonResponse({ error: { code: "credential_cleanup_failed", message: "the grant's scoped credential could not be removed; the grant was left intact — retry" } }, 409);
      }
      let removed: ClaudeGrantRecord;
      try {
        removed = removeClaudeGrant(config, grant.id);
      } catch (err) {
        const mapped = mapGrantRemovalError(err);
        return jsonResponse({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
      }
      persistConfig(config);
      return jsonResponse({
        removed: { id: removed.id, label: removed.label },
        danglingProviders: bound,
        ...(bound.length > 0
          ? { warning: `${bound.length} provider(s) still reference this grant id and will fail auth until rebound; frogprogsy did not modify or rebind them` }
          : {}),
      });
    }

    if (grantAction === "probe" && req.method === "POST") {
      const probeBody = await readOptionalJsonBody();
      const tier = probeBody.tier === undefined ? 1 : probeBody.tier;
      if (tier !== 1 && tier !== 2) return jsonResponse({ error: "tier must be 1 or 2" }, 400);

      const inspector = resolveGrantStatusInspector(deps.claudeGrants);
      const status = await grantStatusView(inspector, config, grant);

      if (tier === 1) {
        const exe = grantExecutableView(grant, deps.claudeGrants);
        // Local-only meta: status + real-executable readiness + scoped-service; no network, no secrets.
        const tier1: Record<string, unknown> = {
          tier: 1,
          id: grant.id,
          state: status.state,
          statusSource: status.source,
          executable: exe.executable,
          network: false,
        };
        if (status.expiresAt !== undefined) tier1.expiresAt = status.expiresAt;
        if (status.statusError) tier1.statusError = status.statusError;
        if (exe.service) tier1.service = exe.service;
        return jsonResponse(tier1);
      }

      // tier === 2: consented live authenticated verification against the official Anthropic API.
      if (probeBody.confirm !== true) {
        return jsonResponse({
          error: {
            code: "confirmation_required",
            message: "tier-2 probe performs a live authenticated request to Anthropic that may consume quota and is subject to your account's Terms of Service; resend with { tier: 2, confirm: true } to proceed",
          },
        }, 400);
      }

      // Resolve the exact provider whose grant token will be exercised. An explicit provider MUST be
      // bound to THIS grant; otherwise exactly one anthropic claude-grant provider must be bound
      // (0 or many → provider_required so the token target is never ambiguous).
      const explicitProvider = typeof probeBody.provider === "string" ? probeBody.provider.trim() : "";
      let probeProviderName: string;
      if (explicitProvider) {
        const candidate = config.providers[explicitProvider];
        if (!candidate || candidate.authMode !== "claude-grant" || candidate.claudeGrantId !== grant.id) {
          return jsonResponse({ error: { code: "provider_not_bound", message: "the named provider is not bound to this claude grant" } }, 400);
        }
        probeProviderName = explicitProvider;
      } else {
        const candidates = grantProbeProviders(config, grant.id);
        if (candidates.length !== 1) {
          return jsonResponse({ error: { code: "provider_required", message: "specify which anthropic provider bound to this grant should be probed" } }, 400);
        }
        probeProviderName = candidates[0]!;
      }
      const probeProvider = config.providers[probeProviderName]!;
      // A grant token may only ever be sent to the official Anthropic API endpoint.
      const validateTarget = deps.claudeGrants?.validateGrantTarget ?? isAllowedClaudeGrantBaseUrl;
      if (probeProvider.adapter !== "anthropic" || !validateTarget(probeProvider)) {
        return jsonResponse({ error: { code: "provider_target_invalid", message: "the bound provider must target the official Anthropic API endpoint" } }, 400);
      }

      const liveProbe = deps.claudeGrants?.liveProbe ?? runClaudeGrantLiveProbe;
      try {
        const result = await liveProbe(config, probeProviderName, probeProvider);
        // Whitelist ONLY redacted fields; never echo a raw body, token, header, or path.
        const tier2: Record<string, unknown> = { tier: 2, ok: true };
        const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
        if (typeof r.status === "number") tier2.status = r.status;
        if (typeof r.modelCount === "number") tier2.modelCount = r.modelCount;
        if (typeof r.modelId === "string") tier2.modelId = r.modelId;
        if (typeof r.messageStatus === "number") tier2.messageStatus = r.messageStatus;
        if (r.tokenFingerprint && typeof r.tokenFingerprint === "object") {
          const fp = r.tokenFingerprint as Record<string, unknown>;
          if (typeof fp.sha256_8 === "string" && typeof fp.length === "number") {
            tier2.tokenFingerprint = { sha256_8: fp.sha256_8, length: fp.length };
          }
        }
        return jsonResponse(tier2, 200);
      } catch (err) {
        const code = err instanceof ClaudeGrantProbeError ? err.code : "live_probe_failed";
        return jsonResponse({ tier: 2, ok: false, error: { code, message: "tier-2 live verification failed" } }, 502);
      }
    }

    return jsonResponse({ error: "unsupported claude grant operation" }, 405);
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    return jsonResponse(redactConfigForApi(config));
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    return jsonResponse({ error: "Full config PUT is disabled. Use /api/providers POST for provider changes." }, 405);
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    return jsonResponse({
      port: config.port,
      hostname: config.hostname ?? "127.0.0.1",
    });
  }

  if (url.pathname === "/api/fallback-settings" && req.method === "GET") {
    return jsonResponse(fallbackSettingsSnapshot());
  }

  if (url.pathname === "/api/fallback-settings" && req.method === "PUT") {
    let body: {
      webSearch?: {
        enabled?: boolean;
        provider?: string;
        model?: string;
        reasoning?: string;
        searchProviders?: Record<string, { enabled?: boolean; provider?: string; apiKey?: string; baseUrl?: string; maxResults?: number; timeoutMs?: number }>;
        noKey?: { enabled?: boolean; maxResults?: number; timeoutMs?: number };
      };
      image?: { enabled?: boolean; provider?: string; model?: string };
    };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.webSearch) {
      config.webSearchFallback = { ...config.webSearchFallback };
      if (typeof body.webSearch.enabled === "boolean") config.webSearchFallback.enabled = body.webSearch.enabled;
      if (typeof body.webSearch.provider === "string") {
        const providerName = body.webSearch.provider.trim();
        if (providerName && !isOpenAIResponsesFallbackProvider(config.providers[providerName])) {
          return jsonResponse({ error: "webSearch.provider must be an OpenAI Responses forward/OAuth/key provider" }, 400);
        }
        if (providerName) config.webSearchFallback.provider = providerName;
        else delete config.webSearchFallback.provider;
      }
      if (typeof body.webSearch.model === "string") config.webSearchFallback.model = body.webSearch.model;
      if (typeof body.webSearch.reasoning === "string") config.webSearchFallback.reasoning = body.webSearch.reasoning;
      if (body.webSearch.searchProviders && typeof body.webSearch.searchProviders === "object") {
        config.webSearchFallback.searchProviders = { ...(config.webSearchFallback.searchProviders ?? {}) };
        for (const [name, entry] of Object.entries(body.webSearch.searchProviders)) {
          if (!entry || typeof entry !== "object") continue;
          const current = { ...(config.webSearchFallback.searchProviders[name] ?? {}) };
          if (typeof entry.enabled === "boolean") current.enabled = entry.enabled;
          if (typeof entry.provider === "string") current.provider = entry.provider.trim();
          if (typeof entry.apiKey === "string") {
            const apiKey = entry.apiKey.trim();
            if (apiKey) current.apiKey = apiKey;
            else delete current.apiKey;
          }
          if (typeof entry.baseUrl === "string") {
            const baseUrl = entry.baseUrl.trim();
            if (baseUrl) current.baseUrl = baseUrl;
            else delete current.baseUrl;
          }
          if (typeof entry.maxResults === "number") current.maxResults = entry.maxResults;
          if (typeof entry.timeoutMs === "number") current.timeoutMs = entry.timeoutMs;
          config.webSearchFallback.searchProviders[name] = current;
        }
      }
      if (body.webSearch.noKey && typeof body.webSearch.noKey === "object") {
        const current = { ...(config.webSearchFallback.noKey ?? {}) };
        if (typeof body.webSearch.noKey.enabled === "boolean") current.enabled = body.webSearch.noKey.enabled;
        if (typeof body.webSearch.noKey.maxResults === "number") current.maxResults = body.webSearch.noKey.maxResults;
        if (typeof body.webSearch.noKey.timeoutMs === "number") current.timeoutMs = body.webSearch.noKey.timeoutMs;
        config.webSearchFallback.noKey = current;
      }
    }
    if (body.image) {
      config.imageFallback = { ...config.imageFallback };
      if (typeof body.image.enabled === "boolean") config.imageFallback.enabled = body.image.enabled;
      if (typeof body.image.provider === "string") {
        const providerName = body.image.provider.trim();
        if (providerName && !isOpenAIResponsesFallbackProvider(config.providers[providerName])) {
          return jsonResponse({ error: "image.provider must be an OpenAI Responses forward/OAuth/key provider" }, 400);
        }
        if (providerName) config.imageFallback.provider = providerName;
        else delete config.imageFallback.provider;
      }
      if (typeof body.image.model === "string") config.imageFallback.model = body.image.model;
    }
    persistConfig(config);
    return jsonResponse(fallbackSettingsSnapshot(true));
  }

  if (url.pathname === "/api/classifier-settings" && req.method === "GET") {
    return jsonResponse(classifierSettingsSnapshot(config));
  }

  if (url.pathname === "/api/classifier-settings" && req.method === "PUT") {
    let body: { providers?: Record<string, { classifierModel?: string }>; classifierFallback?: { provider?: string; model?: string } };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const warnings: string[] = [];
    if (body.providers && typeof body.providers === "object") {
      for (const [name, entry] of Object.entries(body.providers)) {
        if (typeof entry !== "object" || entry === null) continue;
        if (!config.providers[name]) {
          warnings.push(`provider "${name}" not found in config — skipped`);
          continue;
        }
        if (typeof entry.classifierModel === "string") {
          const trimmed = entry.classifierModel.trim();
          if (!trimmed) {
            delete config.providers[name]!.classifierModel;
          } else {
            config.providers[name]!.classifierModel = trimmed;
            const w = validateClassifierModel(config, name, trimmed);
            if (w) warnings.push(w);
          }
        }
      }
    }
    if (body.classifierFallback && typeof body.classifierFallback === "object") {
      const { provider, model } = body.classifierFallback;
      const providerTrimmed = typeof provider === "string" ? provider.trim() : undefined;
      if (providerTrimmed === "") {
        delete config.classifierFallback;
      } else if (providerTrimmed) {
        const modelTrimmed = typeof model === "string" ? model.trim() : undefined;
        config.classifierFallback = { provider: providerTrimmed, ...(modelTrimmed ? { model: modelTrimmed } : {}) };
        if (!config.providers[providerTrimmed]) {
          warnings.push(`classifierFallback provider "${providerTrimmed}" not found in config`);
        } else if (modelTrimmed) {
          const w = validateClassifierModel(config, providerTrimmed, modelTrimmed);
          if (w) warnings.push(w);
        }
      }
    }
    persistConfig(config);
    return jsonResponse({ ...classifierSettingsSnapshot(config), ok: true, warnings });
  }

  if (url.pathname === "/api/model-mixing-settings" && req.method === "GET") {
    return jsonResponse(modelMixingSettingsSnapshot(config));
  }

  if (url.pathname === "/api/model-mixing-settings" && req.method === "PUT") {
    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }

    const warnings: string[] = [];
    const bodyPatch = isPlainJsonObject(body)
      ? body.modelMixing ?? {}
      : (warnings.push("body ignored: expected object"), {});
    const beforeEnabled = config.modelMixing?.enabled === true;
    const beforeAliasId = config.modelMixing?.aliasId?.trim() || "frogp/mix";
    warnings.push(...applyModelMixingPatch(config, bodyPatch));
    const afterEnabled = config.modelMixing?.enabled === true;
    const afterAliasId = config.modelMixing?.aliasId?.trim() || "frogp/mix";

    persistConfig(config);
    if (beforeEnabled !== afterEnabled || beforeAliasId !== afterAliasId) {
      await refreshClaudeCodeCatalogBestEffort();
    }
    return jsonResponse({ ...modelMixingSettingsSnapshot(config), ok: true, warnings });
  }

  if (url.pathname === "/api/model-mixing/call-plan" && req.method === "GET") {
    const draft = url.searchParams.get("draft");
    // Draft preview must not mutate the live config, but computeCallPlan only reads modelMixing —
    // clone just that subtree instead of deep-copying the full config (which carries secrets).
    const effectiveConfig = draft === null
      ? config
      : { ...config, modelMixing: structuredClone(config.modelMixing) } as FrogConfig;
    const warnings: string[] = [];
    if (draft !== null) {
      let patch: unknown;
      try { patch = JSON.parse(draft); } catch { return jsonResponse({ error: "invalid draft JSON" }, 400); }
      warnings.push(...applyModelMixingPatch(effectiveConfig, patch));
    }
    return jsonResponse({ ok: true, plan: computeCallPlan(effectiveConfig), warnings });
  }

  if (url.pathname === "/api/logs" && req.method === "GET") {
    return jsonResponse(requestLogManagementSnapshot());
  }

  if ((url.pathname === "/api/usage" || url.pathname === "/api/oauth/usage") && req.method === "GET") {
    return jsonResponse(usageSummarySnapshot(config, url.searchParams.get("range")));
  }

  if (url.pathname === "/api/usage-pricing" && req.method === "GET") {
    return jsonResponse(usagePricingSnapshot(config, url.searchParams.get("range")));
  }

  if (url.pathname === "/api/provider-state" && req.method === "GET") {
    return jsonResponse({
      port: config.port,
      defaultProvider: config.defaultProvider,
      providers: Object.fromEntries(providerSummaries().map(({ name, ...provider }) => [name, provider])),
    });
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(providerSummaries());
  }
  if (url.pathname === "/api/providers/test" && req.method === "POST") {
    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainJsonObject(body)) return jsonResponse({ error: "request body must be an object" }, 400);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return jsonResponse({ error: "name is required" }, 400);

    let provider: FrogProviderConfig | undefined;
    const testingDraftProvider = body.provider !== undefined;
    if (testingDraftProvider) {
      if (!isPlainJsonObject(body.provider)) return jsonResponse({ error: "provider must be an object" }, 400);
      provider = structuredClone(body.provider) as unknown as FrogProviderConfig;
      if (typeof provider.adapter !== "string" || typeof provider.baseUrl !== "string" || !provider.adapter.trim() || !provider.baseUrl.trim()) {
        return jsonResponse({ error: "provider.adapter and provider.baseUrl are required" }, 400);
      }
      provider.adapter = provider.adapter.trim();
      provider.baseUrl = provider.baseUrl.trim();
      enrichProviderFromCatalog(name, provider);
    } else {
      provider = config.providers[name];
      if (!provider) return jsonResponse({ error: "unknown provider" }, 404);
    }

    if (!testingDraftProvider && (!provider.models || provider.models.length === 0)) {
      const legacyResult = await testProviderConnection(config, name, req.headers);
      const status = legacyResult.ok ? 200 : legacyResult.code === "unknown_provider" ? 404 : legacyResult.code === "auth_missing" || legacyResult.code === "model_missing" ? 409 : 502;
      return jsonResponse(legacyResult, status);
    }

    return jsonResponse(await runProviderConnectionTest(name, provider, { config }));
  }

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: string; provider?: FrogProviderConfig; setDefault?: boolean; catalogId?: string; claudeHome?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = body.name?.trim();
    const prov = body.provider;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    if (hasRedactedProviderCredentials(prov)) {
      return jsonResponse({ error: "provider contains redacted credential placeholders; re-enter secrets before saving" }, 400);
    }
    const catalogId = typeof body.catalogId === "string" ? body.catalogId.trim() : "";
    // Catalog providers (e.g. ollama-cloud, or renamed entries like anthropic-work) carry models
    // plus provider/model capability metadata the GUI doesn't send — merge it in so fallback and
    // reasoning policy are gated correctly.
    enrichProviderFromCatalog(catalogId || name, prov);
    // Hard-validate claude-grant bindings before persisting: unknown/missing id or a non-Anthropic
    // adapter is rejected. oauth/key/forward save + masking paths are untouched.
    const grantBinding = validateClaudeGrantProviderBinding(config, prov, deps.claudeGrants?.validateGrantTarget);
    if (!grantBinding.ok) return jsonResponse({ error: grantBinding.message }, 400);
    const isAnthropicClaudeCodeProvider = prov.adapter === "anthropic" && prov.authMode === "forward";
    if (catalogId === "anthropic" && isAnthropicClaudeCodeProvider && !(typeof body.claudeHome === "string" && body.claudeHome.trim())) {
      return jsonResponse({ error: "Claude Code home path is required" }, 400);
    }
    if (isAnthropicClaudeCodeProvider && typeof body.claudeHome === "string" && body.claudeHome.trim()) {
      try {
        ensureClaudeCodeHomeForProvider(name, body.claudeHome);
      } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : "invalid Claude Code home" }, 400);
      }
    }

    config.providers[name] = prov;
    if (body.setDefault) config.defaultProvider = name;
    persistConfig(config);
    await refreshClaudeCodeCatalogBestEffort();
    return jsonResponse({ success: true, name });
  }

  if (url.pathname === "/api/default-provider" && req.method === "PUT") {
    let body: { name?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || !config.providers[name]) return jsonResponse({ error: "unknown provider" }, 404);

    config.defaultProvider = name;
    persistConfig(config);
    await refreshClaudeCodeCatalogBestEffort();
    return jsonResponse({ success: true, defaultProvider: name });
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !config.providers[name]) return jsonResponse({ error: "unknown provider" }, 404);
    if (name === config.defaultProvider) {
      return jsonResponse({ error: "cannot remove the default provider; select another default first" }, 409);
    }

    const removedProvider = config.providers[name];
    delete config.providers[name];
    if (removedProvider?.authMode === "oauth" && isOAuthProvider(name)) {
      removeCredential(name);
      clearLoginState(name);
    }
    persistConfig(config);
    // Drop its models from Claude Code's catalog immediately (re-sync + cache bust) so removal is live.
    await refreshClaudeCodeCatalogBestEffort();
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    const profileId = url.searchParams.get("profileId") ?? undefined;
    const view = await effectiveModelView(config, { profileId, includeConfiguredForwardModels: true });
    return jsonResponse(view.models.map(m => {
      const namespaced = `${m.provider}/${m.id}`;
      return { ...m, namespaced, disabled: isCatalogModelHidden(config, m) };
    }));
  }

  // Enable/disable models: which routed models Claude Code sees. PUT hides them from the catalog +
  // /v1/models and invalidates Claude Code's 5-min models cache so it applies on the next turn.
  if (url.pathname === "/api/disabled-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const disabled = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    config.disabledModels = disabled;

    persistConfig(config);
    await refreshClaudeCodeCatalogBestEffort();
    return jsonResponse({ ok: true, disabled });
  }

  // Which providers support real OAuth login (drives the GUI's "Log in with …" buttons).
  if (url.pathname === "/api/oauth/providers" && req.method === "GET") {
    return jsonResponse({ providers: listOAuthProviders() });
  }

  // API-key "login" providers (open dashboard → paste key). Drives the GUI's key-provider picker.
  if (url.pathname === "/api/key-providers" && req.method === "GET") {
    return jsonResponse({ providers: listKeyLoginProviders() });
  }

  // Complete GUI picker presets, derived from the canonical provider registry. The GUI is a
  // standalone Vite package, so it consumes this runtime view instead of importing repo-root src.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }

  // Subagent model picker: the ordered models Claude Code shows first. PUT reorders the injected
  // catalog so the chosen ones lead by priority (spawn_agent still advertises only the first 5).
  if (url.pathname === "/api/subagent-models" && req.method === "GET") {
    const profileId = url.searchParams.get("profileId") ?? undefined;
    const view = await effectiveModelView(config, { profileId, includeConfiguredForwardModels: true });
    const chosen = view.featured ?? [];
    // Native gpt/claude slugs are also valid subagent picks — they're picker-visible models in the catalog,
    // just buried by priority. List them first so the user can feature them over routed.
    const { listCatalogNativeSlugs } = await import("./claude-catalog");
    const nativeAvailable = listCatalogNativeSlugs().filter(slug => !isNativeSlugHidden(config, slug));
    const routedAvailable = view.models
      .map(m => `${m.provider}/${m.id}`)
      .filter(ns => !view.disabled.has(ns));
    const available = [...nativeAvailable, ...routedAvailable];
    return jsonResponse({ chosen, available });
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const chosen = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    config.subagentModels = chosen;

    persistConfig(config);
    await refreshClaudeCodeCatalogBestEffort();
    return jsonResponse({ ok: true, applied: chosen });
  }

  // OAuth login starts a browser/device flow and returns the auth URL/code immediately.
  // The provider is only added to active routing after credentials are actually stored.
  // The GUI opens the URL and polls /api/oauth/status.
  if (url.pathname === "/api/oauth/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string; restart?: boolean };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    try {
      const { url: authUrl, instructions } = await startLoginFlow(provider, {
        onComplete: async () => {
          // Persist the provider entry only when it actually changed, but ALWAYS refresh the readiness-
          // filtered Claude catalog on login completion — including re-login of an already-configured
          // provider, where upsert reports no change yet the now-authReady aliases must reappear in the
          // picker. Refresh targets the default claudeHome; secondary profiles refresh at pre-launch.
          if (upsertOAuthProvider(config, provider)) persistConfig(config);
          await refreshClaudeCodeCatalogBestEffort();
        },
        restart: body.restart === true,
      });
      if (authUrl) {
        // Open the browser server-side (the proxy runs on the user's machine) — the GUI's
        // window.open is popup-blocked because it runs after an await, not a direct click.
        const { openUrl } = await import("./open-url");
        openUrl(authUrl);
      }
      return jsonResponse({ url: authUrl, instructions });
    } catch (err) {
      // Raw login errors can embed provider response bodies; keep them on stderr only.
      console.error(`[oauth] ${provider} login start failed: ${err instanceof Error ? err.message : String(err)}`);
      return jsonResponse({ error: "oauth_login_failed" }, 409);
    }
  }

  if (url.pathname === "/api/oauth/status" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    const status = getLoginStatus(provider);
    // Privacy boundary: never forward raw login error messages (they can embed
    // provider response bodies). The GUI localizes the enum code.
    return jsonResponse({
      loggedIn: status.loggedIn === true,
      ...(status.error ? { error: "oauth_login_failed" } : {}),
    });
  }

  if (url.pathname === "/api/oauth/logout" && req.method === "POST") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    removeCredential(provider);
    clearLoginState(provider);
    await refreshClaudeCodeCatalogBestEffort();
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/stop" && req.method === "POST") {
    if (claudeWritesBlocked("restore native Claude Code")) {
      return jsonResponse({ success: true, message: "Claude Code environment writes disabled; stop restore skipped." });
    }
    const { restoreManagedClaudeRouting } = await import("./claude-routing-lifecycle");
    const { removePid, removeActivePort, readPid, writeShutdownIntent } = await import("./config");
    // Follow the stopped proxy on disk: restore managed Claude homes AND every enrolled project via the
    // canonical lifecycle (no per-endpoint loop). Enrollment intent is retained; only explicit
    // per-project restore flips `enrolled`. Persist after the aggregate attempt so partial progress sticks.
    const restore = restoreManagedClaudeRouting(config);
    persistConfig(config);
    if (!restore.success) return jsonResponse({ success: false, error: restore.message }, 500);
    const proxyPid = readPid();
    if (proxyPid !== null) writeShutdownIntent(proxyPid); // signal watchdog: graceful GUI stop
    removePid();
    removeActivePort();
    setTimeout(() => process.exit(0), 200);
    return jsonResponse({ success: true, message: `Proxy stopping, Claude Code routing restored.\n${restore.message}` });
  }

  return null;
}

/**
 * Live routed-provider models for the proxy's /api/* and /v1/models endpoints. Delegates to the
 * canonical, TTL-cached `gatherRoutedModels` (single source of truth) — so the GUI/claude endpoints
 * share the same fetch, the same per-provider cache (dedups Claude Code's frequent /v1/models polling),
 * and the same stale fallback when a provider blips, instead of a parallel uncached copy.
 */
async function fetchAllModels(config: FrogConfig): Promise<CatalogModel[]> {
  const { gatherRoutedModels } = await import("./claude-catalog");
  return gatherRoutedModels(config);
}

export function buildAnthropicModelsListFromAliases(aliasEntries: ModelAliasEntry[]): Record<string, unknown> {
  const data = aliasEntries.map(entry => ({
    id: entry.alias,
    type: "model",
    display_name: entry.displayName,
    created_at: entry.createdAt,
  }));
  return {
    type: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

export function buildAnthropicModelsList(
  nativeModels: { provider: string; model: string }[],
  routedModels: Pick<CatalogModel, "provider" | "id">[],
): Record<string, unknown> {
  const aliasEntries = materializeModelAliases([
    ...nativeModels,
    ...routedModels.map(m => ({ provider: m.provider, model: m.id })),
  ]);
  return buildAnthropicModelsListFromAliases(aliasEntries);
}

export function startServer(port?: number) {
  const config = loadConfig();
  const removedFixtures = dropRuntimeFixtureProviders(config);
  if (removedFixtures.length > 0) {
    saveConfig(config);
    console.error(`frogprogsy: removed runtime fixture provider(s) from config: ${removedFixtures.join(", ")}`);
  }
  // Refresh OAuth provider presets (models/noReasoningModels) from the registry so a proxy update
  // adding/dropping models reaches existing configs on start — not just fresh installs.
  reconcileOAuthProviders(config);
  // Seed default featured subagent models on first run only (UNSET → defaults). A user-set list,
  // even [], is left alone so GUI removals persist.
  if (config.subagentModels === undefined) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
    saveConfig(config);
  }
  const classifierBackfilled: string[] = [];
  for (const [name, prov] of Object.entries(config.providers)) {
    if (prov.classifierModel) continue;
    const seedModel = getProviderRegistryEntry(name)?.classifierModel;
    if (seedModel) { prov.classifierModel = seedModel; classifierBackfilled.push(`${name}=${seedModel}`); }
  }
  if (classifierBackfilled.length > 0) {
    saveConfig(config);
    console.error(`frogprogsy: set auto-mode classifierModel for ${classifierBackfilled.join(", ")}. Edit ${getConfigPath()} or the dashboard to change.`);
  }
  const listenPort = port ?? config.port ?? DEFAULT_PORT;
  setCorsOrigin(listenPort);

  const server = Bun.serve<WsData>({
    port: listenPort,
    hostname: config.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // Responses WebSocket is a Codex/OpenAI Responses-only behavior and is retired for the
      // Claude Messages data plane. Keep the old path explicit instead of silently inventing a
      // Claude Code WebSocket equivalent.
      if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!isLocalOrigin(req)) {
          return formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin");
        }
        return formatErrorResponse(410, "unsupported_endpoint", "Responses WebSocket is retired; use POST /v1/messages streaming SSE.");
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        return jsonResponse(buildHealthzPayload());
      }

      if (url.pathname.startsWith("/api/")) {
        const mgmtResponse = await handleManagementAPI(req, url, config);
        return mgmtResponse ?? jsonResponse({ error: `Unknown API endpoint: ${req.method} ${url.pathname}` }, 404);
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        let profileId: string | undefined;
        try {
          profileId = requestClaudeProfileId(req, config);
        } catch (err) {
          return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
        }
        noteClaudeProfileRequest(config, profileId, req.headers);
        const view = await effectiveModelView(config, { profileId, headers: req.headers });
        if (profileId) saveConfig(config);
        const { buildCatalogEntries, loadCatalogTemplate, nativeOpenAiSlugs, orderForSubagents } = await import("./claude-catalog");
        const nativeSlugs = nativeOpenAiSlugs().filter(slug => !isNativeSlugHidden(config, slug));
        // Picker/export readiness filter: hide any provider whose configured credential is not ready
        // (`authReady === false`) from BOTH Claude Code catalog shapes. Management/doctor keep the full
        // authReady-tagged registry via /api/models so login and key/grant repair remain visible.
        const goOrdered = orderForSubagents(view.enabledModels.filter(m => m.authReady !== false), view.featured);
        if (url.searchParams.has("client_version")) {
          // Claude Code client → Claude Code catalog shape: native gpt + namespaced routed models,
          // cloned from a native template so required fields (base_instructions, etc.) are present.
          // Pass the subagent picks so featured models lead by priority (matches the on-disk file).
          return jsonResponse({ models: buildCatalogEntries(loadCatalogTemplate(), nativeSlugs, goOrdered, view.featured, websocketsEnabled(config)) });
        }
        // Strict Claude-visible aliases for the Messages data plane; display_name preserves
        // the exact provider/model route key for reverse mapping and GUI clarity.
        const nativeModels = config.providers.openai
          ? nativeSlugs.map(model => ({ provider: "openai", model }))
          : [];
        return jsonResponse(buildAnthropicModelsList(nativeModels, goOrdered));
      }

      if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
        if (!isLocalOrigin(req)) {
          return formatAnthropicErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked");
        }
        let profileId: string | undefined;
        try {
          profileId = requestClaudeProfileId(req, config);
        } catch (err) {
          return formatAnthropicErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
        }
        noteClaudeProfileRequest(config, profileId, req.headers);
        const response = await runLoggedDataPlane(req, url.pathname, logCtx => handleCountTokens(req, config, logCtx, { abortSignal: req.signal, profileId }));
        if (profileId && response.status === 401) noteClaudeProfileRequest(config, profileId, req.headers, "oauth_rejected");
        if (profileId) saveConfig(config);
        return response;
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        if (!isLocalOrigin(req)) {
          return formatAnthropicErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked");
        }
        let profileId: string | undefined;
        try {
          profileId = requestClaudeProfileId(req, config);
        } catch (err) {
          return formatAnthropicErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
        }
        noteClaudeProfileRequest(config, profileId, req.headers);
        const response = await runLoggedDataPlane(req, url.pathname, logCtx => handleMessages(req, config, logCtx, { abortSignal: req.signal, profileId }));
        if (profileId && response.status === 401) noteClaudeProfileRequest(config, profileId, req.headers, "oauth_rejected");
        if (profileId) saveConfig(config);
        return response;
      }
      if (url.pathname === "/v1/responses" && req.method === "POST") {
        if (!isLocalOrigin(req)) {
          return formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked");
        }
        return formatErrorResponse(410, "unsupported_endpoint", "OpenAI Responses inbound route is retired for Claude Code; use POST /v1/messages.");
      }

      if (url.pathname === "/usage" && req.method === "GET") {
        return jsonResponse(usageSummarySnapshot(config, url.searchParams.get("range")));
      }

      const guiFile = serveGuiFile(url.pathname);
      if (guiFile) return guiFile;

      return formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`);
    },
    websocket: {
      message(ws: ServerWebSocket<WsData>) {
        ws.data.cancel?.();
        ws.close(1008, "Responses WebSocket is retired; use POST /v1/messages streaming SSE.");
      },
      close(ws: ServerWebSocket<WsData>) {
        ws.data.cancel?.();
      },
    },
  });

  console.log(`🚀 frogprogsy proxy running on http://localhost:${listenPort}`);
  console.log(`   POST /v1/messages  → provider translation`);
  console.log(`   POST /v1/messages/count_tokens → token estimate`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);
  console.log(`   GET  /             → GUI dashboard`);

  return server;
}
