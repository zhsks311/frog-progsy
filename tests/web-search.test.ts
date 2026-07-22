import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { planWebSearch } from "../src/web-search-fallback";
import { runWebSearch } from "../src/web-search-fallback/executor";
import { saveCredential } from "../src/oauth/store";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

const routedProvider: FrogProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "routed-key",
};

const forwardProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};
const preferredForwardProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://preferred-chatgpt.test/v1",
  authMode: "forward",
  models: ["gpt-5.5", "gpt-5.4-mini"],
};
const keyProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.test/v1",
  authMode: "key",
  apiKey: "openai-key",
  models: ["gpt-4.1"],
};
const oauthProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/backend-api/codex",
  authMode: "oauth",
  models: ["gpt-5.5"],
};




const anthropicForwardProvider: FrogProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
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

function parsedWithWebSearch() {
  return parseRequest({
    model: "routed/model",
    input: "Search for current docs",
    stream: true,
    tools: [
      { type: "web_search", search_context_size: "medium" },
      { type: "function", name: "read_file", description: "Read file", parameters: {} },
    ],
  });
}

function plan(cfg: FrogConfig, parsed = parsedWithWebSearch(), native = false, headers = new Headers({ authorization: "Bearer chatgpt" })) {
  return planWebSearch(cfg, parsed, native, headers, "routed", routedProvider, "model");
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("web-search fallback planning", () => {
  test("parseRequest stashes hosted web_search while keeping normal tools", () => {
    const parsed = parsedWithWebSearch();

    expect(parsed._webSearch).toEqual({ type: "web_search", search_context_size: "medium" });
    expect(parsed.context.tools?.map(t => t.name)).toEqual(["read_file"]);
  });

  test("planWebSearch activates with forward auth and incoming authorization", () => {
    const parsed = parsedWithWebSearch();
    const searchPlan = plan(config({ webSearchFallback: { enabled: true } }), parsed);

    expect(searchPlan).toBeDefined();
    expect(searchPlan?.forwardProvider).toBe(forwardProvider);
    expect(searchPlan?.hostedTool).toEqual(parsed._webSearch);
    expect(searchPlan?.settings.model).toBe("gpt-5.4-mini");
  });

  test("planWebSearch uses the configured fallback provider", () => {
    const cfg = config({
      webSearchFallback: { enabled: true, provider: "preferred" },
      providers: { routed: routedProvider, chatgpt: forwardProvider, preferred: preferredForwardProvider },
    });

    const searchPlan = plan(cfg, parsedWithWebSearch());

    expect(searchPlan?.forwardProvider).toBe(preferredForwardProvider);
  });

  test("planWebSearch uses configured OpenAI Responses key provider without forwarded authorization", () => {
    const cfg = config({
      webSearchFallback: { enabled: true, provider: "openaiKey" },
      providers: { routed: routedProvider, chatgpt: forwardProvider, openaiKey: keyProvider },
    });

    const searchPlan = plan(cfg, parsedWithWebSearch(), false, new Headers());

    expect(searchPlan?.forwardProvider).toBe(keyProvider);
  });

  test("planWebSearch uses configured OpenAI Responses OAuth provider without forwarded authorization", () => {
    const cfg = config({
      webSearchFallback: { enabled: true, provider: "codex" },
      providers: { routed: routedProvider, chatgpt: forwardProvider, codex: oauthProvider },
    });

    const searchPlan = plan(cfg, parsedWithWebSearch(), false, new Headers());

    expect(searchPlan?.forwardProvider).toBe(oauthProvider);
    expect(searchPlan?.forwardProviderName).toBe("codex");
  });

  test("runWebSearch resolves OAuth fallback provider tokens", async () => {
    const previousHome = process.env.FROGPROGSY_HOME;
    const home = mkdtempSync(join(tmpdir(), "frog-websearch-oauth-"));
    let authorization = "";
    try {
      process.env.FROGPROGSY_HOME = home;
      saveCredential("codex", { access: "oauth-access", refresh: "refresh-token", expires: Date.now() + 10 * 60_000 });
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response([
          'data: {"type":"response.output_text.done","text":"searched"}',
          "",
        ].join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;

      const outcome = await runWebSearch(
        "current docs",
        { type: "web_search" },
        oauthProvider,
        "codex",
        new Headers(),
        { model: "gpt-5.5", reasoning: "low", timeoutMs: 30_000 },
      );

      expect(outcome.error).toBeUndefined();
      expect(outcome.text).toBe("searched");
      expect(authorization).toBe("Bearer oauth-access");
    } finally {
      if (previousHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("planWebSearch suppresses fallback predictably when prerequisites are absent", () => {
    const parsed = parsedWithWebSearch();
    const enabled = config({ webSearchFallback: { enabled: true } });

    expect(plan(config(), parsed)).toBeUndefined();
    expect(plan(enabled, parsed, true)).toBeUndefined();
    expect(plan(enabled, parsed, false, new Headers())).toBeUndefined();
    expect(plan(config({ webSearchFallback: { enabled: true }, providers: { routed: routedProvider } }), parsed)).toBeUndefined();
    expect(plan(config({ webSearchFallback: { enabled: false } }), parsed)).toBeUndefined();
    expect(plan(enabled, { ...parsed, _webSearch: undefined })).toBeUndefined();
    expect(plan(config({ webSearchFallback: { enabled: true }, providers: { routed: routedProvider, anthropic: anthropicForwardProvider } }), parsed)).toBeUndefined();
    expect(plan(enabled, parsed, false, new Headers({ authorization: "Bearer local-frogprogsy" }))).toBeUndefined();
  });
});
