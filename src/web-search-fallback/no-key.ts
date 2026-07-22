import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { signalWithTimeout } from "../abort";
import type { FrogNoKeyWebSearchConfig } from "../types";
import type { SearchApiOutcome, NormalizedSearchApiSource } from "./search-api";

type NoKeyChannel = "ddg" | "npm" | "github" | "arxiv";

interface Candidate extends NormalizedSearchApiSource {
  channel: NoKeyChannel;
  rank: number;
}

export interface NoKeySearchSettings {
  timeoutMs: number;
  maxResults: number;
}

export interface NoKeyQueryPlan {
  queries: string[];
  channels: NoKeyChannel[];
}

interface PublicAddress {
  address: string;
  family: 4 | 6;
}

interface LimitedTextResponse {
  status: number;
  contentType: string;
  location: string | null;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 6;
const FETCH_BYTES = 80_000;
const DIRECT_FETCH_TIMEOUT_MS = 5_000;
const MAX_PER_HOST = 2;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "for", "from", "how", "in", "is", "of", "on", "or", "the", "to", "what", "with",
  "검색", "검색해줘", "찾아줘", "알려줘", "방법", "어떻게", "관련", "대한",
]);

export function resolveNoKeySettings(cfg: FrogNoKeyWebSearchConfig | undefined): NoKeySearchSettings {
  return {
    timeoutMs: cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResults: Math.max(1, Math.min(cfg?.maxResults ?? DEFAULT_MAX_RESULTS, 10)),
  };
}

export function canonicalSearchUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, "$1").split("%", 1)[0];
}

function ipv4Octets(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(part => Number(part));
  return octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : undefined;
}

function mappedIpv4Octets(ip: string): number[] | undefined {
  const normalized = normalizeHost(ip);
  const suffix = normalized.match(/^::ffff:(.+)$/)?.[1];
  if (!suffix) return undefined;
  const dotted = ipv4Octets(suffix);
  if (dotted) return dotted;
  const hextets = suffix.split(":").filter(Boolean);
  if (hextets.length < 2) return undefined;
  const high = Number.parseInt(hextets[hextets.length - 2], 16);
  const low = Number.parseInt(hextets[hextets.length - 1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) return undefined;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function isPrivateIp(ip: string): boolean {
  const normalized = normalizeHost(ip);
  const octets = mappedIpv4Octets(normalized) ?? ipv4Octets(normalized);
  if (octets) {
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return false;
  }
  if (normalized === "::" || normalized === "::1") return true;
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (Number.isInteger(first)) {
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if ((first & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  }
  if (normalized.startsWith("2001:db8:") || normalized === "2001:db8::") return true;
  return false;
}

async function resolvePublicDns(host: string): Promise<PublicAddress[]> {
  const normalized = normalizeHost(host);
  const literalFamily = isIP(normalized);
  if (literalFamily) {
    if (isPrivateIp(normalized)) throw new Error("blocked private IP");
    return [{ address: normalized, family: literalFamily as 4 | 6 }];
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) throw new Error("blocked local hostname");
  const records = await lookup(normalized, { all: true, verbatim: true });
  if (records.length === 0) throw new Error("hostname has no DNS records");
  const publicRecords = records.filter(record => !isPrivateIp(record.address));
  if (publicRecords.length !== records.length) throw new Error("blocked private DNS address");
  return publicRecords.map(record => ({ address: record.address, family: record.family as 4 | 6 }));
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const canonical = canonicalSearchUrl(raw);
  if (!canonical) throw new Error("unsupported URL scheme");
  const url = new URL(canonical);
  await resolvePublicDns(url.hostname);
  return url;
}

export function buildNoKeyQueryVariants(query: string): string[] {
  const base = query.replace(/\s+/g, " ").trim();
  if (!base) return [];
  const stripped = base
    .replace(/^(please\s+)?(search|find|look\s+up|what\s+is|how\s+to|tell\s+me\s+about)\s+/i, "")
    .replace(/^(검색해줘|검색|찾아줘|알려줘)\s*/u, "")
    .trim();
  const keyword = base
    .split(/[^\p{L}\p{N}_./:@+-]+/u)
    .map(part => part.trim())
    .filter(part => part.length > 1 && !STOPWORDS.has(part.toLowerCase()))
    .slice(0, 10)
    .join(" ");
  return [...new Set([base, stripped, keyword].filter(Boolean))].slice(0, 3);
}

export function planNoKeySearch(query: string): NoKeyQueryPlan {
  const queries = buildNoKeyQueryVariants(query);
  const lower = query.toLowerCase();
  const channels: NoKeyChannel[] = ["ddg"];
  const wantsPackage = /\b(npm|package|library|dependency|sdk|라이브러리|패키지)\b/u.test(lower);
  const wantsCode = /\b(github|repo|repository|source|code|mcp|cli|api|typescript|javascript|python|코드|깃허브)\b/u.test(lower);
  const wantsResearch = /\b(arxiv|paper|papers|research|study|논문|연구)\b/u.test(lower);
  if (wantsPackage) channels.push("npm");
  if (wantsCode || wantsPackage) channels.push("github");
  if (wantsResearch) channels.push("arxiv");
  if (channels.length === 1) channels.push("github", "npm", "arxiv");
  return { queries, channels: [...new Set(channels)] };
}

export function rrfFuse(lists: Candidate[][], limit: number): Candidate[] {
  const byUrl = new Map<string, Candidate & { score: number }>();
  for (const list of lists) {
    list.forEach((candidate, index) => {
      const url = canonicalSearchUrl(candidate.url);
      if (!url) return;
      const score = 1 / (60 + index + 1);
      const existing = byUrl.get(url);
      if (existing) {
        existing.score += score;
        if (!existing.snippet && candidate.snippet) existing.snippet = candidate.snippet;
      } else {
        byUrl.set(url, { ...candidate, url, score });
      }
    });
  }
  const hostCounts = new Map<string, number>();
  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .filter(candidate => {
      const host = new URL(candidate.url).hostname;
      const count = hostCounts.get(host) ?? 0;
      if (count >= MAX_PER_HOST) return false;
      hostCounts.set(host, count + 1);
      return true;
    })
    .slice(0, limit);
}

export async function runNoKeySearch(query: string, cfg: FrogNoKeyWebSearchConfig | undefined, abortSignal?: AbortSignal): Promise<SearchApiOutcome> {
  const settings = resolveNoKeySettings(cfg);
  const linked = signalWithTimeout(settings.timeoutMs, abortSignal);
  try {
    const plan = planNoKeySearch(query);
    const jobs = plan.channels.flatMap(channel =>
      plan.queries.slice(0, channel === "ddg" ? 2 : 1).map(plannedQuery => runChannelSearch(channel, plannedQuery, linked.signal))
    );
    const settled = await Promise.allSettled(jobs);
    const lists = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const fused = rrfFuse(lists, settings.maxResults);
    const sources = await enrichSources(fused.slice(0, settings.maxResults), linked.signal);
    return { provider: "no-key", answer: answerFromSources(query, sources), sources };
  } catch (err) {
    return { provider: "no-key", answer: "", sources: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    linked.cleanup();
  }
}

function runChannelSearch(channel: NoKeyChannel, query: string, signal: AbortSignal): Promise<Candidate[]> {
  switch (channel) {
    case "ddg": return searchDuckDuckGo(query, signal);
    case "npm": return searchNpm(query, signal);
    case "github": return searchGithub(query, signal);
    case "arxiv": return searchArxiv(query, signal);
  }
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) return undefined;
  return await response.json().catch(() => undefined);
}

function pushDdgTopic(topic: unknown, out: Candidate[]): void {
  const item = topic as { FirstURL?: unknown; Text?: unknown; Result?: unknown; Topics?: unknown };
  if (typeof item.FirstURL === "string") {
    out.push({ channel: "ddg", rank: out.length + 1, url: item.FirstURL, title: typeof item.Text === "string" ? item.Text.split(" - ", 1)[0] : undefined, snippet: typeof item.Text === "string" ? item.Text : undefined });
  }
  if (Array.isArray(item.Topics)) item.Topics.forEach(child => pushDdgTopic(child, out));
}

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<Candidate[]> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("no_redirect", "1");
  const json = await fetchJson(url.toString(), signal) as Record<string, unknown> | undefined;
  if (!json) return [];
  const out: Candidate[] = [];
  const abstractUrl = typeof json.AbstractURL === "string" ? json.AbstractURL : "";
  if (abstractUrl) out.push({ channel: "ddg", rank: 1, url: abstractUrl, title: typeof json.Heading === "string" ? json.Heading : undefined, snippet: typeof json.AbstractText === "string" ? json.AbstractText : undefined });
  if (Array.isArray(json.Results)) json.Results.forEach(topic => pushDdgTopic(topic, out));
  if (Array.isArray(json.RelatedTopics)) json.RelatedTopics.forEach(topic => pushDdgTopic(topic, out));
  return out;
}

async function searchNpm(query: string, signal: AbortSignal): Promise<Candidate[]> {
  const url = new URL("https://registry.npmjs.org/-/v1/search");
  url.searchParams.set("text", query);
  url.searchParams.set("size", "5");
  const json = await fetchJson(url.toString(), signal) as { objects?: Array<{ package?: { name?: string; description?: string; links?: { npm?: string; repository?: string } } }> } | undefined;
  return (json?.objects ?? []).map((item, index) => ({
    channel: "npm",
    rank: index + 1,
    url: item.package?.links?.repository ?? item.package?.links?.npm ?? `https://www.npmjs.com/package/${item.package?.name ?? ""}`,
    title: item.package?.name,
    snippet: item.package?.description,
  }));
}

async function searchGithub(query: string, signal: AbortSignal): Promise<Candidate[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "5");
  const json = await fetchJson(url.toString(), signal) as { items?: Array<{ html_url?: string; full_name?: string; description?: string }> } | undefined;
  return (json?.items ?? []).map((item, index) => ({ channel: "github", rank: index + 1, url: item.html_url ?? "", title: item.full_name, snippet: item.description }));
}

async function searchArxiv(query: string, signal: AbortSignal): Promise<Candidate[]> {
  const base = "https://export." + "arxiv.org";
  const url = new URL(["api", "query"].join("/"), `${base}/`);
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "5");
  const response = await fetch(url, { signal, headers: { Accept: "application/atom+xml" } });
  if (!response.ok) return [];
  const text = await response.text();
  return [...text.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<id>(.*?)<\/id>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/entry>/g)]
    .map((match, index) => ({ channel: "arxiv", rank: index + 1, title: cleanXml(match[1]), url: cleanXml(match[2]), snippet: cleanXml(match[3]) }));
}

function cleanXml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchPublicText(url: URL, signal: AbortSignal, limit: number): Promise<LimitedTextResponse> {
  const [pinned] = await resolvePublicDns(url.hostname);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | undefined, value?: LimitedTextResponse) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value!);
    };
    const lookupPinned: NonNullable<RequestOptions["lookup"]> = (hostname, _options, callback) => {
      if (normalizeHost(hostname) !== normalizeHost(url.hostname)) {
        callback(new Error("blocked DNS rebinding host mismatch"), "", 0);
        return;
      }
      callback(null, pinned.address, pinned.family);
    };
    const req = request(url, {
      headers: { Accept: "text/html,text/plain" },
      lookup: lookupPinned,
      signal,
      timeout: DIRECT_FETCH_TIMEOUT_MS,
    }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes >= limit) return;
        const remaining = limit - bytes;
        const slice = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
        chunks.push(slice);
        bytes += slice.byteLength;
        if (bytes >= limit) response.destroy();
      });
      response.on("end", () => done(undefined, {
        status: response.statusCode ?? 0,
        contentType: response.headers["content-type"]?.toString() ?? "",
        location: response.headers.location?.toString() ?? null,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("close", () => {
        if (!settled) done(undefined, {
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"]?.toString() ?? "",
          location: response.headers.location?.toString() ?? null,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", err => done(err instanceof Error ? err : new Error(String(err))));
    });
    req.on("timeout", () => req.destroy(new Error("direct fetch timed out")));
    req.on("error", err => done(err instanceof Error ? err : new Error(String(err))));
    req.end();
  });
}

async function enrichSources(sources: Candidate[], signal: AbortSignal): Promise<NormalizedSearchApiSource[]> {
  const out: NormalizedSearchApiSource[] = [];
  for (const source of sources) {
    let url: URL;
    try {
      url = await assertPublicHttpUrl(source.url);
    } catch {
      continue;
    }
    if (source.snippet) {
      out.push(source);
      continue;
    }
    try {
      const response = await fetchPublicText(url, signal, FETCH_BYTES);
      if (response.status >= 300 && response.status < 400) {
        if (response.location) await assertPublicHttpUrl(new URL(response.location, url).toString());
        out.push(source);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        out.push(source);
        continue;
      }
      const type = response.contentType;
      if (!type.includes("text/html") && !type.includes("text/plain")) {
        out.push(source);
        continue;
      }
      const text = response.text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      out.push({ ...source, snippet: text.slice(0, 300) });
    } catch {
      out.push(source);
    }
  }
  return out;
}

function answerFromSources(query: string, sources: NormalizedSearchApiSource[]): string {
  if (sources.length === 0) return "";
  return [`No-key search results for \"${query}\":`, ...sources.map((source, index) => `${index + 1}. ${source.title ?? source.url}${source.snippet ? ` — ${source.snippet}` : ""}`)].join("\n");
}
