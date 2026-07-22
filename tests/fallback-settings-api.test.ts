import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __requestLogTest } from "../src/server";
import type { FrogConfig } from "../src/types";

let previousFrogHome: string | undefined;
let testHome = "";

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "frog-fallback-settings-"));
  process.env.FROGPROGSY_HOME = testHome;
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

function config(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" },
      chatgpt: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.test/backend-api/codex",
        authMode: "forward",
        defaultModel: "gpt-5.4-mini",
        models: ["gpt-5.5", "gpt-5.4-mini"],
      },
      openaiKey: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.test/v1",
        authMode: "key",
        apiKey: "openai-key",
        defaultModel: "gpt-4.1",
        models: ["gpt-4.1", "gpt-4.1-mini"],
        modelCapabilities: {
          "gpt-4.1": { input: ["text", "image"], webSearch: true },
          "gpt-4.1-mini": { input: ["text"], webSearch: true },
        },
      },
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.test/backend-api/codex",
        authMode: "oauth",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.5", "gpt-5.4-mini"],
        modelCapabilities: {
          "gpt-5.5": { input: ["text", "image"], webSearch: true },
          "gpt-5.4-mini": { input: ["text"], webSearch: true },
        },
      },
      anthropicForward: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward" },
    },
    webSearchFallback: { enabled: true, provider: "chatgpt", model: "gpt-5.5", reasoning: "low", noKey: { enabled: true, maxResults: 6, timeoutMs: 12_000 } },
    imageFallback: { enabled: false, provider: "chatgpt", model: "gpt-5.4-mini" },
  };
}

const noPersist = { saveConfig: (_config: FrogConfig) => {} };

describe("fallback settings API", () => {
  test("GET exposes selectable models from registered OpenAI Responses forward/key/oauth providers", async () => {
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/fallback-settings"),
      new URL("http://localhost/api/fallback-settings"),
      config(),
      noPersist,
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      providers: Array<{ name: string; models: string[] }>;
      webSearchProviders: Array<{ name: string; models: string[] }>;
      imageProviders: Array<{ name: string; models: string[] }>;
      webSearch: { provider: string; model: string; noKey: { enabled: boolean; maxResults?: number; timeoutMs?: number } };
      image: { provider: string; model: string };
    };

    expect(body.providers.map(provider => provider.name)).toEqual(["chatgpt", "openaiKey", "codex"]);
    expect(body.webSearchProviders).toEqual([
      { name: "chatgpt", models: ["gpt-5.4-mini", "gpt-5.5"], defaultModel: "gpt-5.4-mini" },
      { name: "openaiKey", models: ["gpt-4.1", "gpt-4.1-mini"], defaultModel: "gpt-4.1" },
      { name: "codex", models: ["gpt-5.4-mini", "gpt-5.5"], defaultModel: "gpt-5.5" },
    ]);
    expect(body.imageProviders).toEqual([
      { name: "chatgpt", models: ["gpt-5.4-mini", "gpt-5.5"], defaultModel: "gpt-5.4-mini" },
      { name: "openaiKey", models: ["gpt-4.1"], defaultModel: "gpt-4.1" },
      { name: "codex", models: ["gpt-5.5"], defaultModel: "gpt-5.5" },
    ]);
    expect(body.webSearch).toMatchObject({ provider: "chatgpt", model: "gpt-5.5" });
    expect(body.image).toMatchObject({ provider: "chatgpt", model: "gpt-5.4-mini" });
    expect(body.webSearch.noKey).toEqual({ enabled: true, maxResults: 6, timeoutMs: 12000 });
  });

  test("GET does not invent fallback models when provider has none registered", async () => {
    const cfg = config();
    cfg.providers.chatgpt = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.test/backend-api/codex",
      authMode: "forward",
    };
    delete cfg.providers.openaiKey;
    delete cfg.providers.codex;
    cfg.webSearchFallback = { enabled: false, provider: "chatgpt" };
    cfg.imageFallback = { enabled: false, provider: "chatgpt" };

    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/fallback-settings"),
      new URL("http://localhost/api/fallback-settings"),
      cfg,
      noPersist,
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      providers: Array<{ name: string; models: string[] }>;
      webSearch: { provider: string; model: string };
      image: { provider: string; model: string };
    };

    expect(body.providers).toEqual([{ name: "chatgpt", models: [] }]);
    expect(body.webSearch).toMatchObject({ provider: "chatgpt", model: "" });
    expect(body.image).toMatchObject({ provider: "chatgpt", model: "" });
  });

  test("PUT accepts OpenAI Responses key providers for feature fallback helpers", async () => {
    const cfg = config();
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/fallback-settings", {
        method: "PUT",
        body: JSON.stringify({
          webSearch: { provider: "openaiKey", model: "gpt-4.1-mini" },
          image: { provider: "openaiKey", model: "gpt-4.1" },
        }),
      }),
      new URL("http://localhost/api/fallback-settings"),
      cfg,
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      webSearch: { provider: string; model: string };
      image: { provider: string; model: string };
    };
    expect(body.webSearch).toMatchObject({ provider: "openaiKey", model: "gpt-4.1-mini" });
    expect(body.image).toMatchObject({ provider: "openaiKey", model: "gpt-4.1" });
    expect(cfg.webSearchFallback?.provider).toBe("openaiKey");
    expect(cfg.imageFallback?.provider).toBe("openaiKey");
  });

  test("PUT accepts OpenAI Responses OAuth providers for feature fallback helpers", async () => {
    const cfg = config();
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/fallback-settings", {
        method: "PUT",
        body: JSON.stringify({
          webSearch: { provider: "codex", model: "gpt-5.4-mini" },
          image: { provider: "codex", model: "gpt-5.5" },
        }),
      }),
      new URL("http://localhost/api/fallback-settings"),
      cfg,
      noPersist,
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      webSearch: { provider: string; model: string };
      image: { provider: string; model: string };
    };
    expect(body.webSearch).toMatchObject({ provider: "codex", model: "gpt-5.4-mini" });
    expect(body.image).toMatchObject({ provider: "codex", model: "gpt-5.5" });
    expect(cfg.webSearchFallback?.provider).toBe("codex");
    expect(cfg.imageFallback?.provider).toBe("codex");
  });

  test("GET redacts key-based search provider settings", async () => {
    const cfg = config();
    cfg.webSearchFallback = {
      ...cfg.webSearchFallback,
      searchProviders: {
        brave: { enabled: true, provider: "brave", apiKey: "secret-key", baseUrl: "https://token:secret-url@example.test/search?key=secret-query", maxResults: 3, timeoutMs: 5000 },
      },
    };

    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/fallback-settings"),
      new URL("http://localhost/api/fallback-settings"),
      cfg,
      noPersist,
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      webSearch: { searchProviders: Record<string, { provider: string; hasApiKey: boolean; apiKey?: string; hasBaseUrl?: boolean; baseUrl?: string; maxResults?: number; timeoutMs?: number }> };
    };
    expect(body.webSearch.searchProviders.brave).toMatchObject({
      provider: "brave",
      hasApiKey: true,
      maxResults: 3,
      timeoutMs: 5000,
    });
    expect(body.webSearch.searchProviders.brave.apiKey).toBeUndefined();
    expect(body.webSearch.searchProviders.brave.hasBaseUrl).toBe(true);
    expect(body.webSearch.searchProviders.brave.baseUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret-url");
    expect(JSON.stringify(body)).not.toContain("secret-query");
  });

  test("PUT updates no-key fallback controls without requiring API keys", async () => {
    const cfg = config();
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/fallback-settings", {
        method: "PUT",
        body: JSON.stringify({ webSearch: { noKey: { enabled: true, maxResults: 4, timeoutMs: 7000 } } }),
      }),
      new URL("http://localhost/api/fallback-settings"),
      cfg,
      noPersist,
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      webSearch: { noKey: { enabled: boolean; maxResults?: number; timeoutMs?: number } };
    };
    expect(body.webSearch.noKey).toEqual({ enabled: true, maxResults: 4, timeoutMs: 7000 });
    expect(cfg.webSearchFallback?.noKey).toEqual({ enabled: true, maxResults: 4, timeoutMs: 7000 });
  });

  test("config API also redacts key-based search provider secrets", async () => {
    const cfg = config();
    cfg.webSearchFallback = {
      ...cfg.webSearchFallback,
      searchProviders: {
        brave: { enabled: true, provider: "brave", apiKey: "secret-key", baseUrl: "https://token:secret-url@example.test/search?key=secret-query" },
      },
    };

    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/config"),
      new URL("http://localhost/api/config"),
      cfg,
      noPersist,
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      webSearchFallback: { searchProviders: Record<string, { hasApiKey: boolean; apiKey?: string; hasBaseUrl?: boolean; baseUrl?: string }> };
    };
    expect(body.webSearchFallback.searchProviders.brave.hasApiKey).toBe(true);
    expect(body.webSearchFallback.searchProviders.brave.apiKey).toBeUndefined();
    expect(body.webSearchFallback.searchProviders.brave.hasBaseUrl).toBe(true);
    expect(body.webSearchFallback.searchProviders.brave.baseUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret-url");
    expect(JSON.stringify(body)).not.toContain("secret-query");
  });
});
