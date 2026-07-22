import type { FrogSearchApiProviderConfig } from "../types";
import { signalWithTimeout } from "../abort";

export interface ResolvedSearchApiProvider {
  key: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  maxResults: number;
}

export interface NormalizedSearchApiSource {
  title?: string;
  url: string;
  snippet?: string;
}

export interface SearchApiOutcome {
  answer: string;
  sources: NormalizedSearchApiSource[];
  provider: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 5;

export function resolveSearchApiProvider(key: string, cfg: FrogSearchApiProviderConfig): ResolvedSearchApiProvider | { error: "missing_key" | "unsupported_provider" } | undefined {
  if (cfg.enabled === false) return undefined;
  const provider = (cfg.provider ?? key).trim().toLowerCase();
  if (!provider) return undefined;
  if (!cfg.apiKey || cfg.apiKey.trim().length === 0) return { error: "missing_key" };
  if (provider !== "brave" && provider !== "tavily" && provider !== "exa") return { error: "unsupported_provider" };
  return {
    key,
    provider,
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResults: Math.max(1, Math.min(cfg.maxResults ?? DEFAULT_MAX_RESULTS, 10)),
  };
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeSources(items: unknown[]): NormalizedSearchApiSource[] {
  const out: NormalizedSearchApiSource[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const obj = asObj(item);
    if (!obj) continue;
    const url = asString(obj.url) ?? asString(obj.link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = asString(obj.description) ?? asString(obj.snippet) ?? asString(obj.content) ?? asString(obj.text);
    out.push({
      url,
      ...(asString(obj.title) ? { title: asString(obj.title) } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return out;
}

function answerFromSources(query: string, sources: NormalizedSearchApiSource[]): string {
  if (sources.length === 0) return "";
  return [`Search results for \"${query}\":`, ...sources.map((source, i) => `${i + 1}. ${source.title ?? source.url}${source.snippet ? ` — ${source.snippet}` : ""}`)].join("\n");
}

export async function runSearchApi(query: string, provider: ResolvedSearchApiProvider, abortSignal?: AbortSignal): Promise<SearchApiOutcome> {
  const linkedSignal = signalWithTimeout(provider.timeoutMs, abortSignal);
  try {
    if (provider.provider === "brave") return await runBrave(query, provider, linkedSignal.signal);
    if (provider.provider === "tavily") return await runTavily(query, provider, linkedSignal.signal);
    if (provider.provider === "exa") return await runExa(query, provider, linkedSignal.signal);
    return { provider: provider.provider, answer: "", sources: [], error: `unsupported provider ${provider.provider}` };
  } catch (err) {
    return { provider: provider.provider, answer: "", sources: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    linkedSignal.cleanup();
  }
}

async function runBrave(query: string, provider: ResolvedSearchApiProvider, signal: AbortSignal): Promise<SearchApiOutcome> {
  const base = provider.baseUrl ?? "https://api.search.brave.com/res/v1/web/search";
  const url = new URL(base);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(provider.maxResults));
  const response = await fetch(url, { headers: { "Accept": "application/json", "X-Subscription-Token": provider.apiKey }, signal });
  if (!response.ok) return { provider: provider.provider, answer: "", sources: [], error: `search API HTTP ${response.status}` };
  const json = await response.json() as Record<string, unknown>;
  const web = asObj(json.web);
  const sources = normalizeSources(Array.isArray(web?.results) ? web.results : []);
  return { provider: provider.provider, answer: answerFromSources(query, sources), sources };
}

async function runTavily(query: string, provider: ResolvedSearchApiProvider, signal: AbortSignal): Promise<SearchApiOutcome> {
  const url = provider.baseUrl ?? "https://api.tavily.com/search";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: provider.apiKey, query, max_results: provider.maxResults, include_answer: true }),
    signal,
  });
  if (!response.ok) return { provider: provider.provider, answer: "", sources: [], error: `search API HTTP ${response.status}` };
  const json = await response.json() as Record<string, unknown>;
  const sources = normalizeSources(Array.isArray(json.results) ? json.results : []);
  return { provider: provider.provider, answer: asString(json.answer) ?? answerFromSources(query, sources), sources };
}

async function runExa(query: string, provider: ResolvedSearchApiProvider, signal: AbortSignal): Promise<SearchApiOutcome> {
  const url = provider.baseUrl ?? "https://api.exa.ai/search";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": provider.apiKey },
    body: JSON.stringify({ query, numResults: provider.maxResults }),
    signal,
  });
  if (!response.ok) return { provider: provider.provider, answer: "", sources: [], error: `search API HTTP ${response.status}` };
  const json = await response.json() as Record<string, unknown>;
  const sources = normalizeSources(Array.isArray(json.results) ? json.results : []);
  return { provider: provider.provider, answer: answerFromSources(query, sources), sources };
}
