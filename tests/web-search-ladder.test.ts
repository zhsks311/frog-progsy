import { describe, expect, test } from "bun:test";
import { parseMessagesRequest } from "../src/messages/parser";
import { parseRequest } from "../src/responses/parser";
import { planWebSearch, resolveWebSearchLadderPlan } from "../src/web-search-fallback";
import { __requestLogTest } from "../src/server";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

const anthropicNativeProvider: FrogProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.test",
  apiKey: "key",
  modelCapabilities: { "claude-sonnet-test": { input: ["text"], webSearch: true } },
};

const anthropicUnknownProvider: FrogProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.test",
  apiKey: "key",
};

const routedProvider: FrogProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  apiKey: "routed-key",
  modelCapabilities: { "routed-model": { input: ["text"], webSearch: false } },
};

const forwardProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

function config(overrides: Partial<FrogConfig> = {}): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: routedProvider,
      chatgpt: forwardProvider,
    },
    ...overrides,
  };
}

function messagesParsed() {
  return parseMessagesRequest({
    model: "claude-sonnet-test",
    messages: [{ role: "user", content: "Search current docs" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  });
}

function responsesParsed() {
  return parseRequest({
    model: "routed/routed-model",
    input: "Search current docs",
    tools: [{ type: "web_search", search_context_size: "medium" }],
  });
}

describe("web_search ladder resolver", () => {
  test("selects native pass-through only when Anthropic model capability is explicitly true", () => {
    const plan = resolveWebSearchLadderPlan(
      config({ providers: { anthropic: anthropicNativeProvider } }),
      messagesParsed(),
      new Headers(),
      "anthropic",
      anthropicNativeProvider,
      "claude-sonnet-test",
    );

    expect(plan).toMatchObject({
      tier: "native",
      nativeCapabilitySource: "config",
      skippedReasonCodes: [],
      request: { kind: "anthropic_server", type: "web_search_20250305" },
    });
    expect("notice" in (plan ?? {})).toBe(false);
  });

  test("unknown native capability fails closed with machine-readable reasons", () => {
    const plan = resolveWebSearchLadderPlan(
      config({ providers: { anthropic: anthropicUnknownProvider } }),
      messagesParsed(),
      new Headers(),
      "anthropic",
      anthropicUnknownProvider,
      "claude-sonnet-test",
    );

    expect(plan?.tier).toBe("unavailable");
    expect(plan?.skippedReasonCodes).toEqual([
      "primary_model_web_search_unknown",
      "fallback_model_not_enabled",
      "search_api_not_configured",
      "no_key_fallback_not_configured",
    ]);
    expect(plan && "notice" in plan ? plan.notice.message : "").toContain("근거 부족");
  });

  test("configured search API tier resolves when key-backed provider is available", () => {
    const plan = resolveWebSearchLadderPlan(
      config({
        providers: { anthropic: anthropicUnknownProvider },
        webSearchFallback: {
          searchProviders: {
            brave: { enabled: true, provider: "brave", apiKey: "redacted-test-key" },
          },
        },
      }),
      messagesParsed(),
      new Headers(),
      "anthropic",
      anthropicUnknownProvider,
      "claude-sonnet-test",
    );

    expect(plan?.tier).toBe("search_api");
    expect(plan?.skippedReasonCodes).not.toContain("search_api_not_configured");
    if (plan?.tier === "search_api") {
      expect(plan.apiProvider).toMatchObject({ provider: "brave", apiKey: "redacted-test-key" });
    }
  });

  test("search API tier skips invalid slots before using no-key fallback", () => {
    const plan = resolveWebSearchLadderPlan(
      config({
        providers: { anthropic: anthropicUnknownProvider },
        webSearchFallback: {
          searchProviders: {
            tavily: { enabled: true, provider: "tavily" },
            brave: { enabled: true, provider: "brave", apiKey: "brave-key" },
          },
          noKey: { enabled: true },
        },
      }),
      messagesParsed(),
      new Headers(),
      "anthropic",
      anthropicUnknownProvider,
      "claude-sonnet-test",
    );

    expect(plan?.tier).toBe("search_api");
    if (plan?.tier === "search_api") {
      expect(plan.apiProvider).toMatchObject({ provider: "brave", apiKey: "brave-key" });
    }
  });

  test("legacy hosted Responses web_search still resolves to fallback-model tier", () => {
    const parsed = responsesParsed();
    const cfg = config({ webSearchFallback: { enabled: true } });
    const plan = resolveWebSearchLadderPlan(
      cfg,
      parsed,
      new Headers({ authorization: "Bearer chatgpt" }),
      "routed",
      routedProvider,
      "routed-model",
    );

    expect(plan).toMatchObject({
      tier: "fallback_model",
      forwardProvider,
      hostedTool: parsed._webSearch,
      notice: { tier: "fallback_model" },
      skippedReasonCodes: ["primary_provider_not_anthropic_messages"],
    });
    expect(planWebSearch(cfg, parsed, false, new Headers({ authorization: "Bearer chatgpt" }), "routed", routedProvider, "routed-model")?.tier).toBe("fallback_model");
  });

  test("legacy fallback remains suppressed when native path already owns search", () => {
    const parsed = responsesParsed();
    const cfg = config({ webSearchFallback: { enabled: true } });

    expect(planWebSearch(cfg, parsed, true, new Headers({ authorization: "Bearer chatgpt" }), "routed", routedProvider, "routed-model")).toBeUndefined();
  });

  test("Messages handler returns deterministic 근거 부족 when no search tier is available", async () => {
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("unexpected upstream call", { status: 500 });
    }) as typeof fetch;
    try {
      __requestLogTest.clear();
      const cfg = config({
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            ...anthropicUnknownProvider,
            models: ["claude-sonnet-test"],
            defaultModel: "claude-sonnet-test",
          },
        },
      });
      const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const res = await __requestLogTest.handleMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-test",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "Search current docs" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }), cfg, logCtx, {});

      const body = await res.json() as Record<string, unknown>;
      const content = body.content as Array<Record<string, unknown>>;

      expect(fetchCalled).toBe(false);
      expect(res.status).toBe(200);
      expect(content[0].text).toContain("근거 부족");
      expect(content[0].text).toContain("primary_model_web_search_unknown");
      expect(logCtx.entry.fallbacks?.webSearch).toMatchObject({
        planned: true,
        status: "error",
        tier: "unavailable",
        code: "primary_model_web_search_unknown",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Messages handler can answer through configured fallback-model search tier", async () => {
    const realFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const stream = [
        "data: {\"type\":\"response.output_text.done\",\"text\":\"Fallback model answer\"}",
        "",
        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Fallback model answer\",\"annotations\":[{\"type\":\"url_citation\",\"url\":\"https://docs.example/fallback\",\"title\":\"Fallback docs\"}]}]}]}}",
        "",
      ].join("\n");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      __requestLogTest.clear();
      const cfg = config({
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            ...anthropicUnknownProvider,
            models: ["claude-sonnet-test"],
            defaultModel: "claude-sonnet-test",
          },
          chatgpt: forwardProvider,
        },
        webSearchFallback: { enabled: true, model: "gpt-search-test" },
      });
      const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const res = await __requestLogTest.handleMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer chatgpt" },
        body: JSON.stringify({
          model: "claude-sonnet-test",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "Search current docs" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }), cfg, logCtx, {});
      const body = await res.json() as Record<string, unknown>;
      const content = body.content as Array<Record<string, unknown>>;

      expect(requestBody?.model).toBe("gpt-search-test");
      expect(requestBody?.tools).toEqual([{ type: "web_search" }]);
      expect(content[0].text).toContain("Fallback model answer");
      expect(content[0].text).toContain("fallback 모델");
      expect(logCtx.entry.fallbacks?.webSearch).toMatchObject({ tier: "fallback_model", status: "ok", calls: 1, evidence: { coverage: "answer_with_sources", sourceCount: 1, citationCount: 1 } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Messages handler refuses fallback-model answers without citation support", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const stream = [
        "data: {\"type\":\"response.output_text.done\",\"text\":\"Uncited fallback model answer\"}",
        "",
        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Uncited fallback model answer\",\"annotations\":[]}]}]}}",
        "",
      ].join("\n");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      __requestLogTest.clear();
      const cfg = config({
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            ...anthropicUnknownProvider,
            models: ["claude-sonnet-test"],
            defaultModel: "claude-sonnet-test",
          },
          chatgpt: forwardProvider,
        },
        webSearchFallback: { enabled: true, model: "gpt-search-test" },
      });
      const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const res = await __requestLogTest.handleMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer chatgpt" },
        body: JSON.stringify({
          model: "claude-sonnet-test",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "Search current docs" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }), cfg, logCtx, {});
      const body = await res.json() as Record<string, unknown>;
      const content = body.content as Array<Record<string, unknown>>;

      expect(content[0].text).toContain("근거 부족");
      expect(content[0].text).toContain("citation_support_missing");
      expect(content[0].text).toContain("coverage=answer_only");
      expect(logCtx.entry.fallbacks?.webSearch).toMatchObject({
        tier: "fallback_model",
        status: "error",
        calls: 1,
        evidence: { coverage: "answer_only", sourceCount: 0, citationCount: 0, insufficientReason: "citation_support_missing" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Messages handler normalizes raw search errors before user text and logs", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("raw-secret-token should not leak", { status: 502 })) as typeof fetch;
    try {
      __requestLogTest.clear();
      const cfg = config({
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            ...anthropicUnknownProvider,
            models: ["claude-sonnet-test"],
            defaultModel: "claude-sonnet-test",
          },
          chatgpt: forwardProvider,
        },
        webSearchFallback: { enabled: true, model: "gpt-search-test" },
      });
      const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const res = await __requestLogTest.handleMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer chatgpt" },
        body: JSON.stringify({
          model: "claude-sonnet-test",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "Search current docs" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }), cfg, logCtx, {});
      const body = await res.json() as Record<string, unknown>;
      const serializedBody = JSON.stringify(body);
      const serializedLog = JSON.stringify(logCtx.entry.fallbacks?.webSearch);

      expect(serializedBody).toContain("search_http_error");
      expect(serializedBody).not.toContain("raw-secret-token");
      expect(serializedLog).toContain("search_http_error");
      expect(serializedLog).not.toContain("raw-secret-token");
      expect(logCtx.entry.fallbacks?.webSearch).toMatchObject({
        tier: "fallback_model",
        status: "error",
        evidence: { coverage: "none", sourceCount: 0, citationCount: 0, insufficientReason: "search_http_error" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Messages handler can answer through configured key-based search API tier", async () => {
    const realFetch = globalThis.fetch;
    let apiToken = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      apiToken = String((init?.headers as Record<string, string>)["X-Subscription-Token"] ?? "");
      return new Response(JSON.stringify({
        web: {
          results: [
            { title: "Brave result", url: "https://docs.example/brave", description: "Result snippet" },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      __requestLogTest.clear();
      const cfg = config({
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            ...anthropicUnknownProvider,
            models: ["claude-sonnet-test"],
            defaultModel: "claude-sonnet-test",
          },
        },
        webSearchFallback: {
          searchProviders: {
            brave: { enabled: true, provider: "brave", apiKey: "brave-secret", maxResults: 3 },
          },
        },
      });
      const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const res = await __requestLogTest.handleMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-test",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "Search current docs" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }), cfg, logCtx, {});
      const body = await res.json() as Record<string, unknown>;
      const content = body.content as Array<Record<string, unknown>>;

      expect(apiToken).toBe("brave-secret");
      expect(content[0].text).toContain("key 기반 search API");
      expect(content[0].text).toContain("Brave result");
      expect(content[0].text).toContain("https://docs.example/brave");
      expect(logCtx.entry.fallbacks?.webSearch).toMatchObject({ tier: "search_api", status: "ok", calls: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Messages handler can answer through no-key fallback tier", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.duckduckgo.com") {
        return new Response(JSON.stringify({ Heading: "DDG", AbstractURL: "https://example.com/no-key", AbstractText: "No-key abstract" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ objects: [], items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      __requestLogTest.clear();
      const cfg = config({
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            ...anthropicUnknownProvider,
            models: ["claude-sonnet-test"],
            defaultModel: "claude-sonnet-test",
          },
        },
        webSearchFallback: { noKey: { enabled: true, maxResults: 2, timeoutMs: 5000 } },
      });
      const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const res = await __requestLogTest.handleMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-test",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "Search current docs" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }), cfg, logCtx, {});
      const body = await res.json() as Record<string, unknown>;
      const content = body.content as Array<Record<string, unknown>>;

      expect(content[0].text).toContain("no-key fallback");
      expect(content[0].text).toContain("No-key search results");
      expect(logCtx.entry.fallbacks?.webSearch).toMatchObject({ tier: "no_key", status: "ok", calls: 1, evidence: { coverage: "answer_with_sources", sourceCount: 1, citationCount: 1 } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
