import { performance } from "node:perf_hooks";
import type { FrogConfig, FrogProviderConfig } from "../types";
import { findForwardProvider } from "./index";
import { runWebSearch, type WebSearchFallbackOutcome, type WebSearchFallbackSettings } from "./executor";
import { formatWebSearchResult } from "./format-result";
import { runNoKeySearch } from "./no-key";
import { resolveSearchApiProvider, runSearchApi, type ResolvedSearchApiProvider, type SearchApiOutcome } from "./search-api";

export type PanelSearchTier = "fallback_model" | "search_api" | "no_key";

export interface SearchEvidence {
  text: string;
  sources: { url: string; title?: string; snippet?: string }[];
  evidence: { coverage: string; sourceCount: number; citationCount: number; insufficientReason?: string };
  tier: PanelSearchTier | "unavailable";
  skippedReasonCodes: string[];
  latencyMs: number;
}

type WebSearchEvidenceCoverage = "none" | "answer_only" | "sources_only" | "answer_with_sources";

interface WebSearchEvidencePacket {
  coverage: WebSearchEvidenceCoverage;
  sourceCount: number;
  citationCount: number;
  insufficient: boolean;
  insufficientReason?: string;
}

const DEFAULT_FALLBACK_MODEL = "gpt-5.4-mini";
const DEFAULT_FALLBACK_REASONING = "low";
const DEFAULT_TIMEOUT_MS = 30_000;
const FALLBACK_HOSTED_TOOL = { type: "web_search" };
const TIER_ORDER: PanelSearchTier[] = ["fallback_model", "search_api", "no_key"];

function hasUsableForwardAuthorization(headers: Headers): boolean {
  const auth = headers.get("authorization") ?? headers.get("x-api-key") ?? headers.get("api-key");
  return typeof auth === "string" && auth.trim().length > 0;
}

function fallbackSettings(cfg: NonNullable<FrogConfig["webSearchFallback"]>): WebSearchFallbackSettings {
  return {
    model: cfg.model ?? DEFAULT_FALLBACK_MODEL,
    reasoning: cfg.reasoning ?? DEFAULT_FALLBACK_REASONING,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    describeImages: false,
  };
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

function evidenceLog(evidence: WebSearchEvidencePacket): SearchEvidence["evidence"] {
  return {
    coverage: evidence.coverage,
    sourceCount: evidence.sourceCount,
    citationCount: evidence.citationCount,
    ...(evidence.insufficientReason ? { insufficientReason: evidence.insufficientReason } : {}),
  };
}

function resultText(query: string, outcome: WebSearchFallbackOutcome | SearchApiOutcome): string {
  if ("text" in outcome) return formatWebSearchResult(query, outcome);
  return formatWebSearchResult(query, { text: outcome.answer, sources: outcome.sources, ...(outcome.error ? { error: outcome.error } : {}) });
}

function resultSources(outcome: WebSearchFallbackOutcome | SearchApiOutcome): SearchEvidence["sources"] {
  return outcome.sources.map(source => ({
    url: source.url,
    ...(source.title ? { title: source.title } : {}),
    ...("snippet" in source && source.snippet ? { snippet: source.snippet } : {}),
  }));
}

function resolveConfiguredSearchApi(cfg: NonNullable<FrogConfig["webSearchFallback"]>): { provider?: ResolvedSearchApiProvider; reason?: string } {
  let reason: string | undefined;
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

function unavailable(query: string, skippedReasonCodes: string[], start: number, insufficientReason = "evidence_insufficient"): SearchEvidence {
  return {
    text: `Web search for "${query}" could not run (${[...skippedReasonCodes, insufficientReason].join(", ")}). Answer from your own knowledge and note that it may be out of date.`,
    sources: [],
    evidence: { coverage: "none", sourceCount: 0, citationCount: 0, insufficientReason },
    tier: "unavailable",
    skippedReasonCodes,
    latencyMs: Math.max(0, Math.round(performance.now() - start)),
  };
}

async function tryFallbackModel(opts: {
  query: string;
  config: FrogConfig;
  incomingHeaders: Headers;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ outcome?: WebSearchFallbackOutcome; reason?: string }> {
  const cfg = opts.config.webSearchFallback ?? {};
  if (cfg.enabled !== true) return { reason: "fallback_model_not_enabled" };
  const provider = findForwardProvider(opts.config, cfg.provider);
  if (!provider) return { reason: "fallback_model_provider_unavailable" };
  if (provider.authMode === "forward" && !hasUsableForwardAuthorization(opts.incomingHeaders)) {
    return { reason: "fallback_model_forward_auth_missing" };
  }
  const settings = { ...fallbackSettings(cfg), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) };
  const outcome = await runWebSearch(
    opts.query,
    FALLBACK_HOSTED_TOOL,
    provider as FrogProviderConfig,
    cfg.provider,
    opts.incomingHeaders,
    settings,
    opts.abortSignal,
  );
  return { outcome };
}

async function trySearchApi(opts: {
  query: string;
  config: FrogConfig;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ outcome?: SearchApiOutcome; reason?: string }> {
  const cfg = opts.config.webSearchFallback ?? {};
  const searchApi = resolveConfiguredSearchApi(cfg);
  if (!searchApi.provider) return { reason: searchApi.reason ?? "search_api_not_configured" };
  const provider = { ...searchApi.provider, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) };
  return { outcome: await runSearchApi(opts.query, provider, opts.abortSignal) };
}

async function tryNoKey(opts: {
  query: string;
  config: FrogConfig;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ outcome?: SearchApiOutcome; reason?: string }> {
  const cfg = opts.config.webSearchFallback ?? {};
  if (cfg.noKey?.enabled !== true) return { reason: "no_key_fallback_not_configured" };
  return { outcome: await runNoKeySearch(opts.query, { ...cfg.noKey, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }, opts.abortSignal) };
}

export async function executeSearchEvidence(opts: {
  query: string;
  config: FrogConfig;
  incomingHeaders: Headers;
  allowedTiers: PanelSearchTier[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<SearchEvidence> {
  const start = performance.now();
  const query = opts.query.trim();
  const skippedReasonCodes: string[] = [];
  if (!query) return unavailable(opts.query, ["empty_query"], start);

  const allowed = new Set(opts.allowedTiers);
  if (allowed.size === 0) return unavailable(query, ["panel_search_no_allowed_tiers"], start);

  for (const tier of TIER_ORDER) {
    if (!allowed.has(tier)) {
      skippedReasonCodes.push(`${tier}_not_allowed`);
      continue;
    }

    const result = tier === "fallback_model"
      ? await tryFallbackModel(opts)
      : tier === "search_api"
        ? await trySearchApi(opts)
        : await tryNoKey(opts);

    if (result.reason) {
      skippedReasonCodes.push(result.reason);
      continue;
    }
    if (!result.outcome) {
      skippedReasonCodes.push(`${tier}_unavailable`);
      continue;
    }

    const evidence = buildWebSearchEvidencePacket(result.outcome);
    if (evidence.insufficient) {
      skippedReasonCodes.push(evidence.insufficientReason ?? "evidence_insufficient");
      continue;
    }

    return {
      text: resultText(query, result.outcome),
      sources: resultSources(result.outcome),
      evidence: evidenceLog(evidence),
      tier,
      skippedReasonCodes,
      latencyMs: Math.max(0, Math.round(performance.now() - start)),
    };
  }

  return unavailable(query, skippedReasonCodes, start, skippedReasonCodes.at(-1) ?? "evidence_insufficient");
}
