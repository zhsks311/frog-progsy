import { describe, expect, test } from "bun:test";
import { executeSearchEvidence } from "../src/web-search-fallback/panel-search";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

const routedProvider: FrogProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  apiKey: "routed-key",
};

const fallbackProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://fallback.test/v1",
  apiKey: "fallback-key",
};

function config(overrides: Partial<FrogConfig> = {}): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: routedProvider,
      chatgpt: fallbackProvider,
    },
    ...overrides,
  };
}

function sseResponse(text: string, url = "https://source.test/doc", title = "Source") {
  const payload = {
    type: "response.completed",
    response: {
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text,
          annotations: [{ type: "url_citation", url, title }],
        }],
      }],
    },
  };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("executeSearchEvidence", () => {
  test("runs fallback_model tier as a single hosted web search and records evidence", async () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse("fallback answer");
    }) as typeof fetch;
    try {
      const result = await executeSearchEvidence({
        query: "latest frogprogsy docs",
        config: config({ webSearchFallback: { enabled: true, provider: "chatgpt", model: "gpt-search-test" } }),
        incomingHeaders: new Headers(),
        allowedTiers: ["fallback_model"],
      });

      expect(result.tier).toBe("fallback_model");
      expect(result.evidence).toEqual({ coverage: "answer_with_sources", sourceCount: 1, citationCount: 1 });
      expect(result.sources).toEqual([{ url: "https://source.test/doc", title: "Source" }]);
      expect(result.text).toContain("fallback answer");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://fallback.test/v1/responses");
      expect(calls[0]!.body.tools).toEqual([{ type: "web_search" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("runs search_api tier when it is the allowed ladder intersection", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("https://brave.test/search");
      return Response.json({
        web: {
          results: [{ url: "https://brave.test/result", title: "Brave result", description: "fresh snippet" }],
        },
      });
    }) as typeof fetch;
    try {
      const result = await executeSearchEvidence({
        query: "current release",
        config: config({
          webSearchFallback: {
            enabled: true,
            provider: "chatgpt",
            searchProviders: {
              brave: { enabled: true, provider: "brave", apiKey: "brave-key", baseUrl: "https://brave.test/search", maxResults: 3, timeoutMs: 5000 },
            },
          },
        }),
        incomingHeaders: new Headers(),
        allowedTiers: ["search_api"],
      });

      expect(result.tier).toBe("search_api");
      expect(result.skippedReasonCodes).toEqual(["fallback_model_not_allowed"]);
      expect(result.evidence).toEqual({ coverage: "answer_with_sources", sourceCount: 1, citationCount: 1 });
      expect(result.sources[0]).toMatchObject({ url: "https://brave.test/result", title: "Brave result", snippet: "fresh snippet" });
      expect(result.text).toContain("Search results for \"current release\"");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("falls through failed fallback_model to search_api and records the failure reason", async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("fallback.test")) return new Response("bad gateway", { status: 502 });
      return Response.json({ results: [{ url: "https://tavily.test/result", title: "Tavily", content: "ok" }], answer: "api answer" });
    }) as typeof fetch;
    try {
      const result = await executeSearchEvidence({
        query: "fresh answer",
        config: config({
          webSearchFallback: {
            enabled: true,
            provider: "chatgpt",
            searchProviders: {
              tavily: { enabled: true, provider: "tavily", apiKey: "tavily-key", baseUrl: "https://tavily.test/search" },
            },
          },
        }),
        incomingHeaders: new Headers(),
        allowedTiers: ["fallback_model", "search_api"],
      });

      expect(result.tier).toBe("search_api");
      expect(result.skippedReasonCodes).toContain("search_http_error");
      expect(result.evidence.coverage).toBe("answer_with_sources");
      expect(urls).toEqual(["https://fallback.test/v1/responses", "https://tavily.test/search"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("runs no_key tier through existing timeout, maxResults, and private-address safeguards", async () => {
    const realFetch = globalThis.fetch;
    const fetched: Array<{ url: string; hasSignal: boolean }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push({ url, hasSignal: init?.signal instanceof AbortSignal });
      if (url.startsWith("https://api.duckduckgo.com/")) {
        return Response.json({
          Results: [
            { FirstURL: "http://93.184.216.34/public-a", Text: "Public A - snippet A" },
            { FirstURL: "http://127.0.0.1/private", Text: "Private - should be filtered" },
            { FirstURL: "http://93.184.216.34/public-b", Text: "Public B - snippet B" },
          ],
        });
      }
      if (url.startsWith("https://registry.npmjs.org/") || url.startsWith("https://api.github.com/")) {
        return Response.json(url.includes("github") ? { items: [] } : { objects: [] });
      }
      if (url.startsWith("https://export.arxiv.org/")) {
        return new Response("<feed></feed>", { headers: { "Content-Type": "application/atom+xml" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      const result = await executeSearchEvidence({
        query: "search package docs",
        config: config({ webSearchFallback: { noKey: { enabled: true, maxResults: 2, timeoutMs: 1234 } } }),
        incomingHeaders: new Headers(),
        allowedTiers: ["no_key"],
      });

      expect(result.tier).toBe("no_key");
      expect(result.skippedReasonCodes).toEqual(["fallback_model_not_allowed", "search_api_not_allowed"]);
      expect(result.evidence).toEqual({ coverage: "answer_with_sources", sourceCount: 1, citationCount: 1 });
      expect(result.sources.map(source => source.url)).toEqual(["http://93.184.216.34/public-a"]);
      expect(result.sources.some(source => source.url.includes("127.0.0.1"))).toBe(false);
      expect(fetched.every(call => call.hasSignal)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("returns unavailable with evidence reason when every allowed tier is skipped or insufficient", async () => {
    const result = await executeSearchEvidence({
      query: "anything current",
      config: config(),
      incomingHeaders: new Headers(),
      allowedTiers: ["fallback_model", "search_api", "no_key"],
    });

    expect(result.tier).toBe("unavailable");
    expect(result.sources).toEqual([]);
    expect(result.evidence).toEqual({ coverage: "none", sourceCount: 0, citationCount: 0, insufficientReason: "no_key_fallback_not_configured" });
    expect(result.skippedReasonCodes).toEqual(["fallback_model_not_enabled", "search_api_not_configured", "no_key_fallback_not_configured"]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
