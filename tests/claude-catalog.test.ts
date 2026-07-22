import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { augmentRoutedModelsWithJawcodeMetadata, buildCatalogEntries, type CatalogModel, gatherRoutedModels, isMediaGenerationModelId, normalizeRoutedCatalogEntry, orderForSubagents, stripRoutedCatalogEntries } from "../src/claude-catalog";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { clearModelCache, setCached } from "../src/model-cache";
import { assertAllowedClaudeGrantTarget, type ProviderAuthDeps } from "../src/provider-auth";
import { ClaudeGrantError } from "../src/claude-grant-auth";
import { ANTHROPIC_OAUTH_BETA } from "../src/oauth/anthropic";
import { routeModel } from "../src/router";
import { __requestLogTest } from "../src/server";
import { clearLoginState, OAUTH_PROVIDERS } from "../src/oauth";
import { getCredential, removeCredential, saveCredential } from "../src/oauth/store";
import type { FrogConfig, FrogProviderConfig } from "../src/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
});

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Claude Code, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: {
      instructions_template: "You are Claude Code, a coding agent based on GPT-5.",
    },
    tool_mode: "code",
    multi_agent_version: "v2",
    use_responses_lite: true,
    supports_websockets: true,
    web_search_tool_type: "text_and_image",
    supports_search_tool: true,
    additional_speed_tiers: [{ id: "priority" }],
    service_tier: "fast",
    service_tiers: [{ id: "fast" }],
    default_service_tier: "priority",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

describe("Claude Code catalog routed normalization", () => {
  test("normalizeRoutedCatalogEntry strips native-only routed selectors", () => {
    const entry = nativeTemplate();

    normalizeRoutedCatalogEntry(entry);

    expect(entry).not.toHaveProperty("model_messages");
    expect(entry).not.toHaveProperty("tool_mode");
    expect(entry).not.toHaveProperty("multi_agent_version");
    expect(entry).not.toHaveProperty("use_responses_lite");
    expect(entry).not.toHaveProperty("supports_websockets");
    expect(entry).not.toHaveProperty("additional_speed_tiers");
    expect(entry).not.toHaveProperty("service_tier");
    expect(entry).not.toHaveProperty("service_tiers");
    expect(entry).not.toHaveProperty("default_service_tier");
    expect(entry).not.toHaveProperty("web_search_tool_type");
    expect(entry).not.toHaveProperty("supports_search_tool");
  });

  test("buildCatalogEntries strips routed entries cloned from native templates", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], [
      { provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed).toBeDefined();
    expect(routed).not.toHaveProperty("model_messages");
    expect(routed).not.toHaveProperty("tool_mode");
    expect(routed).not.toHaveProperty("multi_agent_version");
    expect(routed).not.toHaveProperty("use_responses_lite");
    expect(routed).not.toHaveProperty("supports_websockets");
    expect(routed).not.toHaveProperty("additional_speed_tiers");
    expect(routed).not.toHaveProperty("service_tier");
    expect(routed).not.toHaveProperty("service_tiers");
    expect(routed).not.toHaveProperty("default_service_tier");
    expect(routed).not.toHaveProperty("web_search_tool_type");
    expect(routed).not.toHaveProperty("supports_search_tool");
    expect(routed?.base_instructions).not.toBe(nativeTemplate().base_instructions);
    expect(routed?.base_instructions).toContain("claude-sonnet-4-6");
    expect(routed?.default_reasoning_level).toBe("medium");
  });

  test("routed entries fill auto compact when context already exists on the template", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 272_000,
    };
    const entries = buildCatalogEntries(template, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(272_000);
    expect(routed?.max_context_window).toBe(272_000);
    expect(routed?.auto_compact_token_limit).toBe(244_800);
  });

  test("buildCatalogEntries preserves native bare GPT template fields", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], []);
    const native = entries.find(e => e.slug === "gpt-5.5");

    expect(native).toBeDefined();
    expect(native).toHaveProperty("model_messages");
    expect(native?.tool_mode).toBe("code");
    expect(native?.multi_agent_version).toBe("v2");
    expect(native?.use_responses_lite).toBe(true);
    // WebSocket advertisement is opt-in; templates must not leak it by default.
    expect(native).not.toHaveProperty("supports_websockets");
    expect(native?.web_search_tool_type).toBe("text_and_image");
    expect(native?.supports_search_tool).toBe(true);
    expect(native?.service_tier).toBe("priority");
    expect(native?.service_tiers).toEqual([{ id: "priority" }]);
  });

  test("buildCatalogEntries never advertises retired Responses WebSocket support", () => {
    const goModels = [{ provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" }];

    const defaultOff = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels);
    expect(defaultOff.find(e => e.slug === "gpt-5.5")).not.toHaveProperty("supports_websockets");
    expect(defaultOff.find(e => e.slug === "anthropic/claude-sonnet-4-6")).not.toHaveProperty("supports_websockets");

    const on = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels, undefined, true);
    expect(on.find(e => e.slug === "gpt-5.5")).not.toHaveProperty("supports_websockets");
    expect(on.find(e => e.slug === "anthropic/claude-sonnet-4-6")).not.toHaveProperty("supports_websockets");

    const off = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels, undefined, false);
    expect(off.find(e => e.slug === "gpt-5.5")).not.toHaveProperty("supports_websockets");
    expect(off.find(e => e.slug === "anthropic/claude-sonnet-4-6")).not.toHaveProperty("supports_websockets");
  });

  test("fallback routed entries do not advertise hosted search by default", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed).not.toHaveProperty("web_search_tool_type");
    expect(routed).not.toHaveProperty("supports_search_tool");
  });

  test("restore helper drops routed slash entries and preserves native catalog rows", () => {
    const result = stripRoutedCatalogEntries({
      version: 1,
      models: [
        { slug: "gpt-5.5", display_name: "gpt-5.5" },
        { slug: "anthropic/claude-sonnet-4-6", display_name: "anthropic/claude-sonnet-4-6" },
        { slug: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5" },
      ],
    });

    expect(result.removed).toBe(1);
    expect(result.kept).toBe(2);
    expect(result.catalog.models?.map(m => m.slug)).toEqual([
      "gpt-5.5",
      "claude-frogp-codex-gpt-5-5",
    ]);
  });

  test("featured list is unbounded: every featured rank sorts before non-featured defaults, no duplicates", () => {
    const goModels = Array.from({ length: 8 }, (_, i) => ({ provider: "p", id: `m${i}`, owned_by: "p" }));
    // 7 featured (> the old cap of 5): 6 routed + 1 native.
    const featured = ["p/m0", "p/m1", "p/m2", "p/m3", "p/m4", "p/m5", "gpt-5.5"];
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5", "gpt-5.4"], goModels, featured);

    // Featuring reassigns priority only — each model appears exactly once.
    const slugs = entries.map(e => e.slug as string);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.filter(s => s === "gpt-5.5")).toHaveLength(1);

    // Every featured entry carries its rank as priority.
    for (const [i, slug] of featured.entries()) {
      expect(entries.find(e => e.slug === slug)?.priority).toBe(i);
    }
    // All non-featured entries (routed AND native) sort strictly after the last featured rank.
    const maxFeatured = featured.length - 1;
    for (const e of entries) {
      if (!featured.includes(e.slug as string)) {
        expect(e.priority as number).toBeGreaterThan(maxFeatured);
      }
    }
  });

  test("liveModels false uses configured provider models without fetching", async () => {
    clearModelCache("static-provider");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "static-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["alpha", "beta"],
          },
        },
      });

      expect(fetchCalls).toBe(0);
      expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
        "static-provider/alpha",
        "static-provider/beta",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("static-provider");
    }
  });

  test("liveModels false ignores a fresh live-model cache", async () => {
    setCached("static-cache", [
      { provider: "static-cache", id: "cached-live-model" },
    ]);
    try {
      const models = await gatherRoutedModels({
        providers: {
          "static-cache": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["configured-only"],
          },
        },
      });

      expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
        "static-cache/configured-only",
      ]);
    } finally {
      clearModelCache("static-cache");
    }
  });

  test("liveModels false does not poison the live-model cache when toggled back on", async () => {
    clearModelCache("static-toggle");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        data: [{ id: "live-after-toggle", owned_by: "provider" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const staticModels = await gatherRoutedModels({
        providers: {
          "static-toggle": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "sk-toggle", // a usable key => authReady, so the live-model toggle actually fetches
            liveModels: false,
            models: ["configured-only"],
          },
        },
      });

      expect(staticModels.map(m => `${m.provider}/${m.id}`)).toEqual([
        "static-toggle/configured-only",
      ]);
      expect(fetchCalls).toBe(0);

      const liveModels = await gatherRoutedModels({
        providers: {
          "static-toggle": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "sk-toggle",
            liveModels: true,
            models: ["configured-only"],
          },
        },
      });

      expect(fetchCalls).toBe(1);
      expect(new Set(liveModels.map(m => `${m.provider}/${m.id}`))).toEqual(new Set([
        "static-toggle/live-after-toggle",
        "static-toggle/configured-only",
      ]));
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("static-toggle");
    }
  });

  test("routed entries receive exact jawcode context metadata", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "opencode-go", id: "deepseek-v4-pro" },
    ]);
    const routed = entries.find(e => e.slug === "opencode-go/deepseek-v4-pro");

    expect(routed?.context_window).toBe(1_000_000);
    expect(routed?.max_context_window).toBe(1_000_000);
    expect(routed?.auto_compact_token_limit).toBe(900_000);
    expect(routed?.input_modalities).toEqual(["text"]);
  });

  test("opencode-go high-risk models use official jawcode metadata in the Claude Code catalog", () => {
    const cases = [
      { id: "glm-5.2", context: 1_000_000, auto: 900_000, input: ["text"] },
      { id: "qwen3.5-plus", context: 1_000_000, auto: 900_000, input: ["text", "image"] },
      { id: "kimi-k2.7-code", context: 262_144, auto: 235_929, input: ["text", "image"] },
      { id: "minimax-m3", context: 512_000, auto: 460_800, input: ["text", "image"] },
      { id: "hy3-preview", context: 256_000, auto: 230_400, input: ["text"] },
    ] as const;
    const entries = buildCatalogEntries(nativeTemplate(), [], cases.map(({ id }) => ({ provider: "opencode-go", id })));

    for (const item of cases) {
      const routed = entries.find(e => e.slug === `opencode-go/${item.id}`);

      expect(routed?.context_window).toBe(item.context);
      expect(routed?.max_context_window).toBe(item.context);
      expect(routed?.auto_compact_token_limit).toBe(item.auto);
      expect(routed?.input_modalities).toEqual(item.input);
      expect(getJawcodeModelMetadata("opencode-go", item.id)?.contextWindow).toBe(item.context);
    }
  });

  test("opencode-go catalog sync appends official rows missing from /v1/models", () => {
    const models = augmentRoutedModelsWithJawcodeMetadata(
      [{ provider: "opencode-go", id: "glm-5.2" }],
      ["opencode-go"],
    );
    const slugs = new Set(models.map(m => `${m.provider}/${m.id}`));

    expect(slugs.has("opencode-go/glm-5.2")).toBe(true);
    expect(slugs.has("opencode-go/qwen3.5-plus")).toBe(true);
    expect(slugs.has("opencode-go/hy3-preview")).toBe(true);
    expect(models.filter(m => `${m.provider}/${m.id}` === "opencode-go/glm-5.2")).toHaveLength(1);
  });

  test("liveModels false disables jawcode metadata augmentation for exact allowlists", async () => {
    const models = await gatherRoutedModels({
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode-go.test/v1",
          apiKey: "sk-test",
          liveModels: false,
          models: ["glm-5.2"],
        },
      },
    });
    const slugs = models.map(m => `${m.provider}/${m.id}`);

    expect(slugs).toEqual(["opencode-go/glm-5.2"]);
  });

  test("liveModels false with no models exposes no augmented provider rows", async () => {
    const models = await gatherRoutedModels({
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode-go.test/v1",
          apiKey: "sk-test",
          liveModels: false,
        },
      },
    });

    expect(models).toEqual([]);
  });

  test("jawcode metadata augmentation inherits key readiness for every added non-forward row", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "glm-5.2" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const base = {
      adapter: "openai-chat" as const,
      baseUrl: "https://opencode-go.test/v1",
      models: ["glm-5.2"],
    };
    clearModelCache("opencode-go");
    try {
      const keyless = await gatherRoutedModels({
        providers: {
          "opencode-go": { ...base, authMode: "key" },
        },
      });
      expect(keyless.length).toBeGreaterThan(1);
      expect(keyless.every(model => model.provider !== "opencode-go" || model.authReady === false)).toBe(true);
      expect(keyless.filter(model => model.authReady !== false).some(model => model.provider === "opencode-go")).toBe(false);

      const keyed = await gatherRoutedModels({
        providers: {
          "opencode-go": { ...base, authMode: "key", apiKey: "sk-ready" },
        },
      });
      expect(keyed.length).toBeGreaterThan(1);
      expect(keyed.every(model => model.provider !== "opencode-go" || model.authReady === true)).toBe(true);
    } finally {
      globalThis.fetch = savedFetch;
      clearModelCache("opencode-go");
    }
  });

  test("anthropic sonnet 4.6 uses the 200k frogprogsy catalog cap", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed?.context_window).toBe(200_000);
    expect(routed?.max_context_window).toBe(200_000);
    expect(routed?.auto_compact_token_limit).toBe(180_000);
    expect(getJawcodeModelMetadata("anthropic", "claude-sonnet-4-6")?.contextWindow).toBe(200_000);
  });

  test("routed entries resolve jawcode provider aliases", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "kimi", id: "kimi-k2.5" },
    ]);
    const routed = entries.find(e => e.slug === "kimi/kimi-k2.5");

    expect(routed?.context_window).toBe(262_144);
    expect(routed?.max_context_window).toBe(262_144);
    expect(routed?.auto_compact_token_limit).toBe(235_929);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("unknown routed entries receive conservative strict catalog defaults", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(128_000);
    expect(routed?.max_context_window).toBe(128_000);
    expect(routed?.auto_compact_token_limit).toBe(115_200);
    expect(routed?.input_modalities).toEqual(["text"]);
    expect(routed?.supports_reasoning_summaries).toBe(true);
    expect(routed?.default_reasoning_summary).toBe("none");
  });

  test("generated jawcode snapshot is restricted to mapped providers", () => {
    expect(resolveJawcodeProvider("kimi")).toBe("moonshot");
    expect(resolveJawcodeProvider("nanogpt")).toBeUndefined();
    expect(getJawcodeModelMetadata("moonshot", "kimi-k2.5")?.contextWindow).toBe(262_144);
    expect(getJawcodeModelMetadata("nanogpt", "some-model")).toBeUndefined();
  });

  test("provider config model metadata reaches Claude Code catalog for static models", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-static",
      providers: {
        "meta-static": {
          adapter: "openai-chat",
          baseUrl: "https://meta-static.test/v1",
          apiKey: "sk-test",
          models: ["static-model"],
          modelContextWindows: { "static-model": 321_000 },
          modelCapabilities: { "static-model": { input: ["text", "image"] } },
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const routed = entries.find(e => e.slug === "meta-static/static-model");

    expect(routed?.context_window).toBe(321_000);
    expect(routed?.max_context_window).toBe(321_000);
    expect(routed?.auto_compact_token_limit).toBe(288_900);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("liveModels false preserves configured catalog metadata without live fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-static-allowlist",
      providers: {
        "meta-static-allowlist": {
          adapter: "openai-chat",
          baseUrl: "https://meta-static.test/v1",
          apiKey: "sk-test",
          liveModels: false,
          models: ["static-model"],
          modelContextWindows: { "static-model": 321_000 },
          modelCapabilities: { "static-model": { input: ["text", "image"] } },
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const routed = entries.find(e => e.slug === "meta-static-allowlist/static-model");

    expect(fetchCalls).toBe(0);
    expect(routed?.context_window).toBe(321_000);
    expect(routed?.max_context_window).toBe(321_000);
    expect(routed?.auto_compact_token_limit).toBe(288_900);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("provider context-window caps lower live metadata without raising smaller live windows", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        {
          id: "wide-model",
          owned_by: "meta-live",
          metadata: {
            limits: { max_context_length: 500_000 },
            capabilities: { vision: true, reasoning_effort: true },
          },
        },
        {
          id: "small-model",
          owned_by: "meta-live",
          metadata: {
            limits: { max_context_length: 64_000 },
            capabilities: { vision: true },
          },
        },
      ],
    }))) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-live",
      providers: {
        "meta-live": {
          adapter: "openai-chat",
          baseUrl: "https://meta-live.test/v1",
          apiKey: "sk-test",
          contextWindow: 128_000,
          modelContextWindows: { "wide-model": 100_000 },
          modelCapabilities: { "wide-model": { input: ["text"] } },
        },
      },
    });

    expect(models.find(m => m.id === "wide-model")).toMatchObject({
      contextWindow: 100_000,
      inputModalities: ["text"],
    });
    expect(models.find(m => m.id === "small-model")?.contextWindow).toBe(64_000);
  });

  test("provider context-window caps apply to stale cached metadata", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{
        id: "cached-model",
        metadata: {
          limits: { max_context_length: 500_000 },
          capabilities: { vision: true },
        },
      }],
    }))) as typeof fetch;

    await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-cache",
      providers: {
        "meta-cache": {
          adapter: "openai-chat",
          baseUrl: "https://meta-cache.test/v1",
          apiKey: "sk-test",
          modelContextWindows: { "cached-model": 120_000 },
        },
      },
    });

    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-cache",
      modelCacheTtlMs: 0,
      providers: {
        "meta-cache": {
          adapter: "openai-chat",
          baseUrl: "https://meta-cache.test/v1",
          apiKey: "sk-test",
          modelContextWindows: { "cached-model": 80_000 },
        },
      },
    });

    expect(models.find(m => m.id === "cached-model")?.contextWindow).toBe(80_000);
  });

  // Injectable provider-auth deps that exercise the real resolveProviderAuth claude-grant dispatch
  // (target guard → grant broker) without a Keychain or the network: the guard admits only reserved
  // `.test`/`.example` hosts (never real DNS, production default stays strict), and the broker is a
  // fake returning/throwing on demand. oauth/key resolvers must never run for a claude-grant provider.
  function grantAuthDeps(resolveGrantToken: () => string): ProviderAuthDeps {
    return {
      getOAuthAccessToken: async () => { throw new Error("oauth broker must not run for a claude-grant provider"); },
      getClaudeGrantAccessToken: async () => resolveGrantToken(),
      resolveEnvValue: value => value,
      validateClaudeGrantTarget: provider => assertAllowedClaudeGrantTarget(provider, { allowReservedTestHosts: true }),
    };
  }

  test("claude-grant discovery fails closed to configured models with zero network when the grant token cannot be resolved", async () => {
    clearModelCache("claude-sub");
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("no live /v1/models fetch may run when grant resolution fails");
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      providers: {
        "claude-sub": {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.test",
          authMode: "claude-grant",
          claudeGrantId: "cg_test",
          models: ["claude-sonnet-4-6", "claude-opus-4-1"],
        },
      },
    }, grantAuthDeps(() => { throw new ClaudeGrantError("reauth_required", "grant reauth required"); }));

    // Fail closed: keep exactly the configured models, never fall back to another credential, no fetch.
    expect(fetchCalls).toBe(0);
    expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
      "claude-sub/claude-opus-4-1",
      "claude-sub/claude-sonnet-4-6",
    ]);
  });

  test("resolved claude-grant token drives a live /v1/models fetch with Bearer + Anthropic OAuth beta and merges live with configured", async () => {
    clearModelCache("claude-sub");
    let fetchCalls = 0;
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        data: [
          { id: "claude-sonnet-4-6", owned_by: "anthropic" },
          { id: "claude-haiku-4-5", owned_by: "anthropic" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      providers: {
        "claude-sub": {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.test",
          authMode: "claude-grant",
          claudeGrantId: "cg_test",
          // Configured-only model absent from the live list — must survive the merge.
          models: ["claude-opus-4-1"],
        },
      },
    }, grantAuthDeps(() => "grant-token-xyz"));

    // Exactly one live fetch, hitting the Anthropic-specific /v1/models endpoint (never /models).
    expect(fetchCalls).toBe(1);
    expect(capturedUrl.startsWith("https://api.anthropic.test/v1/models")).toBe(true);
    expect(capturedUrl).toContain("limit=1000");

    // Subscription (grant) Bearer identity: Authorization Bearer + the required Anthropic OAuth beta and
    // version — and NO x-api-key (an API-key credential must never accompany the subscription Bearer).
    expect(capturedHeaders.get("authorization")).toBe("Bearer grant-token-xyz");
    expect(capturedHeaders.get("anthropic-beta")).toBe(ANTHROPIC_OAUTH_BETA);
    expect(capturedHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(capturedHeaders.get("x-api-key")).toBeNull();

    // Merge: both live models plus the configured-only model, deduped and provider-sorted.
    expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
      "claude-sub/claude-haiku-4-5",
      "claude-sub/claude-opus-4-1",
      "claude-sub/claude-sonnet-4-6",
    ]);
  });
});

describe("media-generation model filtering", () => {
  test("flags image/video generation model ids", () => {
    for (const id of [
      "grok-2-image", "grok-2-image-1212", "grok-2-image-latest", "grok-video",
      "gpt-5-image", "gpt-5-image-mini", "gpt-image-1", "gemini-3-pro-image",
      "dall-e-3", "imagen-4", "sora-2", "veo-3", "flux", "stable-diffusion-3.5", "sdxl", "kling-2",
    ]) {
      expect(isMediaGenerationModelId(id)).toBe(true);
    }
  });

  test("keeps text + vision-input chat model ids", () => {
    for (const id of [
      "grok-4.3", "grok-2-vision", "grok-2-vision-1212", "grok-composer-2.5-fast",
      "gpt-4o", "gpt-5.2", "claude-opus-4-8", "gemini-3-pro-preview",
      "qwen3-vl-30b-a3b-instruct", "openrouter/aurora-alpha", "deepseek-v4-pro", "minimax-m3",
    ]) {
      expect(isMediaGenerationModelId(id)).toBe(false);
    }
  });
});

// ── OAuth readiness split: management registry vs picker export (P3) ────────────
// Injected auth deps keyed by provider so a single gatherRoutedModels call can mix logged-in and
// logged-out oauth providers deterministically, with zero network and zero Keychain access.
function oauthDepsMap(tokens: Record<string, string>): ProviderAuthDeps {
  return {
    getOAuthAccessToken: async (name: string) => {
      const token = tokens[name];
      if (!token) throw new Error(`Not logged in to ${name}. Run: frogp login ${name}`);
      return token;
    },
    getClaudeGrantAccessToken: async () => { throw new Error("grant broker must never run for an oauth provider"); },
    resolveEnvValue: value => value,
  };
}

describe("Claude catalog OAuth readiness split", () => {
  test("logged-out oauth keeps a management-visible authReady:false registry that the picker export hides", async () => {
    clearModelCache("codex");
    clearModelCache("local");
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        codex: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "gpt-5.5", liveModels: false, models: ["gpt-5.5", "gpt-5.4"] },
        local: { adapter: "openai-chat", baseUrl: "https://local.test/v1", authMode: "key", apiKey: "sk-local", liveModels: false, models: ["qwen3-coder"] },
      },
    };

    const models = await gatherRoutedModels(config, oauthDepsMap({})); // codex logged OUT

    // Management registry (doctor/GUI/api view): the logged-out oauth provider is RETAINED and tagged
    // authReady:false — never dropped — so login management/guidance still sees it.
    const codex = models.filter(m => m.provider === "codex");
    expect(codex.map(m => m.id).sort()).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(codex.every(m => m.authReady === false)).toBe(true);
    // A key provider with a resolvable key is authReady:true, so it survives the picker readiness filter.
    const local = models.find(m => m.provider === "local");
    expect(local).toBeDefined();
    expect(local?.authReady).toBe(true);

    // Picker export applies the exact readiness filter the proxy /v1/models handler uses.
    const picker = models.filter(m => m.authReady !== false);
    expect(picker.some(m => m.provider === "codex")).toBe(false); // logged-out codex is hidden
    expect(picker.some(m => m.provider === "local")).toBe(true);   // key provider stays

    // The Claude Code catalog export (buildCatalogEntries over the filtered picks) omits every codex slug
    // but still ships the native bare gpt-5.5 and the routed key alias.
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], orderForSubagents(picker, undefined));
    const slugs = entries.map(e => e.slug as string);
    expect(slugs).not.toContain("codex/gpt-5.5");
    expect(slugs).not.toContain("codex/gpt-5.4");
    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("local/qwen3-coder");
  });

  test("logged-in oauth tags fetched/configured models authReady:true and the picker export includes them", async () => {
    clearModelCache("codex");
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        codex: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "gpt-5.5", liveModels: false, models: ["gpt-5.5", "gpt-5.4"] },
      },
    };

    const models = await gatherRoutedModels(config, oauthDepsMap({ codex: "codex-oauth-token" })); // logged IN
    const codex = models.filter(m => m.provider === "codex");
    expect(codex.length).toBe(2);
    expect(codex.every(m => m.authReady === true)).toBe(true);

    const picker = models.filter(m => m.authReady !== false);
    const slugs = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], orderForSubagents(picker, undefined)).map(e => e.slug as string);
    expect(slugs).toContain("codex/gpt-5.5");
    expect(slugs).toContain("codex/gpt-5.4");
  });

  test("auth state changes only readiness, never the exact namespaced alias id (no name/price guessing)", async () => {
    clearModelCache("codex");
    const cfg = (): FrogConfig => ({
      port: 10100,
      defaultProvider: "codex",
      providers: { codex: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "gpt-5.5", liveModels: false, models: ["gpt-5.5"] } },
    });

    const loggedOut = await gatherRoutedModels(cfg(), oauthDepsMap({}));
    clearModelCache("codex");
    const loggedIn = await gatherRoutedModels(cfg(), oauthDepsMap({ codex: "tok" }));

    const idOf = (ms: CatalogModel[]) => ms.filter(m => m.provider === "codex").map(m => `${m.provider}/${m.id}`);
    expect(idOf(loggedOut)).toEqual(["codex/gpt-5.5"]);
    expect(idOf(loggedIn)).toEqual(["codex/gpt-5.5"]); // identical exact id; only authReady flips
    expect(loggedOut.find(m => m.provider === "codex")?.authReady).toBe(false);
    expect(loggedIn.find(m => m.provider === "codex")?.authReady).toBe(true);
  });

  test("a planted oauth token never crosses into the serialized registry or a logged-out sibling", async () => {
    clearModelCache("codex");
    clearModelCache("other");
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        codex: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "gpt-5.5", liveModels: false, models: ["gpt-5.5"] },
        other: { adapter: "openai-chat", baseUrl: "https://other.test/v1", authMode: "oauth", defaultModel: "o1", liveModels: false, models: ["o1"] },
      },
    };
    const PLANTED = "planted-codex-oauth-secret-XYZ";

    const models = await gatherRoutedModels(config, oauthDepsMap({ codex: PLANTED })); // codex IN, other OUT

    // The resolved subscription bearer never lands in any model row (FC5 redaction / zero crossover).
    expect(JSON.stringify(models)).not.toContain(PLANTED);
    // codex's credential readiness never bleeds onto the logged-out sibling.
    expect(models.find(m => m.provider === "codex")?.authReady).toBe(true);
    expect(models.find(m => m.provider === "other")?.authReady).toBe(false);
  });

  test("claude-grant readiness gates the picker: unresolvable grant is management-kept authReady:false, resolvable is authReady:true", async () => {
    clearModelCache("claude-sub");
    const config = (): FrogConfig => ({
      port: 10100,
      defaultProvider: "claude-sub",
      providers: {
        "claude-sub": { adapter: "anthropic", baseUrl: "https://api.anthropic.test", authMode: "claude-grant", claudeGrantId: "cg_test", liveModels: false, models: ["claude-sonnet-4-6"] },
      },
    });
    const grantDeps = (resolve: () => string): ProviderAuthDeps => ({
      getOAuthAccessToken: async () => { throw new Error("oauth broker must not run for a claude-grant provider"); },
      getClaudeGrantAccessToken: async () => resolve(),
      resolveEnvValue: value => value,
      validateClaudeGrantTarget: provider => assertAllowedClaudeGrantTarget(provider, { allowReservedTestHosts: true }),
    });

    let fetchCalls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (() => { fetchCalls += 1; throw new Error("no live fetch may run for a fail-closed grant"); }) as typeof fetch;
    try {
      // Resolver FAILS (fail closed): keep the configured registry, no live fetch, tagged authReady:false.
      const failed = await gatherRoutedModels(config(), grantDeps(() => { throw new ClaudeGrantError("reauth_required", "grant reauth required"); }));
      const failedSub = failed.find(m => m.provider === "claude-sub");
      expect(fetchCalls).toBe(0);
      expect(failedSub?.id).toBe("claude-sonnet-4-6");           // management-preserved
      expect(failedSub?.authReady).toBe(false);
      expect(failed.filter(m => m.authReady !== false).some(m => m.provider === "claude-sub")).toBe(false); // export-filtered

      clearModelCache("claude-sub");
      // Resolver SUCCEEDS: the configured registry is authReady:true and stays in the picker export.
      const ok = await gatherRoutedModels(config(), grantDeps(() => "grant-token-xyz"));
      const okSub = ok.find(m => m.provider === "claude-sub");
      expect(okSub?.authReady).toBe(true);
      expect(ok.filter(m => m.authReady !== false).some(m => m.provider === "claude-sub")).toBe(true);
    } finally {
      globalThis.fetch = savedFetch;
      clearModelCache("claude-sub");
    }
  });

  test("key providers gate the picker on a resolvable key: keyless is management-kept authReady:false, keyed is authReady:true", async () => {
    clearModelCache("keyless");
    clearModelCache("keyed");
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "keyed",
      providers: {
        keyless: { adapter: "openai-chat", baseUrl: "https://keyless.test/v1", authMode: "key", liveModels: false, models: ["free-1"] },
        keyed: { adapter: "openai-chat", baseUrl: "https://keyed.test/v1", authMode: "key", apiKey: "sk-present", liveModels: false, models: ["paid-1"] },
      },
    };

    // Production key resolution (no injected deps): a static apiKey resolves; a keyless provider does not.
    const models = await gatherRoutedModels(config);

    // Keyless key provider: no usable credential => kept in the management registry, tagged authReady:false.
    const keyless = models.find(m => m.provider === "keyless");
    expect(keyless?.id).toBe("free-1");
    expect(keyless?.authReady).toBe(false);
    // Keyed provider: resolvable key => authReady:true.
    const keyed = models.find(m => m.provider === "keyed");
    expect(keyed?.authReady).toBe(true);

    // Picker export hides the keyless provider, keeps the keyed one.
    const picker = models.filter(m => m.authReady !== false);
    expect(picker.some(m => m.provider === "keyless")).toBe(false);
    expect(picker.some(m => m.provider === "keyed")).toBe(true);
  });

  test("routeModel resolves exact namespaced aliases and defers unknown ids without guessing or auth fallback", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "local",
      providers: {
        codex: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "gpt-5.5", models: ["gpt-5.5"] },
        local: { adapter: "openai-chat", baseUrl: "https://local.test/v1", authMode: "key", apiKey: "sk-local", defaultModel: "qwen3-coder", models: ["qwen3-coder"] },
      },
    };

    // Deterministic exact-id routing: the namespaced alias resolves to that provider's exact model.
    const exact = routeModel(config, "codex/gpt-5.5");
    expect(exact.providerName).toBe("codex");
    expect(exact.modelId).toBe("gpt-5.5");

    // An unknown provider-qualified alias is NEVER invented into the oauth route; it defers to the
    // configured default provider (no silent auth fallback, no name/price guessing).
    const unknown = routeModel(config, "ghost/does-not-exist");
    expect(unknown.providerName).toBe("local");
  });
});

// ── Readiness refresh hooks driven through the real management endpoints (P3) ───
describe("Claude catalog readiness refresh hooks", () => {
  const originalHome = process.env.FROGPROGSY_HOME;
  const originalNoWrites = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "frog-catalog-readiness-"));
    process.env.FROGPROGSY_HOME = home;
    // Never touch a real Claude home while the login/logout refresh hooks fire (guarded no-op).
    process.env.FROGPROGSY_NO_CLAUDE_WRITES = "1";
    clearModelCache();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
    else process.env.FROGPROGSY_HOME = originalHome;
    if (originalNoWrites === undefined) delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
    else process.env.FROGPROGSY_NO_CLAUDE_WRITES = originalNoWrites;
    clearModelCache();
    rmSync(home, { recursive: true, force: true });
  });

  function oauthProviderConfig(): FrogProviderConfig {
    return { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "gpt-5.5", liveModels: false, models: ["gpt-5.5"] };
  }

  test("/api/models retains the logged-out oauth registry tagged authReady:false", async () => {
    const cfg: FrogConfig = { port: 10100, defaultProvider: "codex", providers: { codex: oauthProviderConfig() } };
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/models", { headers: { Origin: "http://localhost:10100" } }),
      new URL("http://localhost/api/models"),
      cfg,
      { saveConfig: () => {} },
    );
    expect(res?.status).toBe(200);
    const models = await res!.json() as Array<{ namespaced: string; authReady?: boolean }>;
    const codex = models.find(m => m.namespaced === "codex/gpt-5.5");
    expect(codex).toBeDefined();
    expect(codex?.authReady).toBe(false); // management keeps the logged-out provider, tagged not-ready
  });

  test("logout hides an oauth provider from the picker while /api/models keeps it", async () => {
    const cfg: FrogConfig = { port: 10100, defaultProvider: "codex", providers: { codex: oauthProviderConfig() } };
    saveCredential("codex", { access: "acc", refresh: "ref", expires: Date.now() + 3_600_000 });

    const before = await __requestLogTest.effectiveModelView(cfg);
    expect(before.models.find(m => m.provider === "codex")?.authReady).toBe(true);
    expect(before.enabledModels.filter(m => m.authReady !== false).some(m => m.provider === "codex")).toBe(true);

    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/oauth/logout?provider=codex", { method: "POST", headers: { Origin: "http://localhost:10100" } }),
      new URL("http://localhost/api/oauth/logout?provider=codex"),
      cfg,
      { saveConfig: () => {} },
    );
    expect(res?.status).toBe(200);
    expect(getCredential("codex")).toBeNull();

    // After the explicit logout refresh hook: still present in the management registry (authReady:false),
    // absent from the readiness-filtered picker export.
    const after = await __requestLogTest.effectiveModelView(cfg);
    expect(after.models.find(m => m.provider === "codex")?.authReady).toBe(false);
    expect(after.enabledModels.filter(m => m.authReady !== false).some(m => m.provider === "codex")).toBe(false);
  });

  test("re-login of an already-configured oauth provider completes and becomes picker-visible without a config change", async () => {
    const provider = "__frogp_relogin_test__";
    const providerConfig: FrogProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "m1", liveModels: false, models: ["m1"] };
    (OAUTH_PROVIDERS as Record<string, unknown>)[provider] = {
      // Local-token style completion: resolves a credential without an interactive auth URL, so the
      // endpoint never opens a browser and onComplete runs before the request resolves.
      login: async () => ({ access: "relogin-access", refresh: "relogin-refresh", expires: Date.now() + 3_600_000 }),
      refresh: async () => ({ access: "relogin-access", refresh: "relogin-refresh", expires: Date.now() + 3_600_000 }),
      providerConfig,
      defaultModel: "m1",
    };
    // Already configured => upsertOAuthProvider reports NO change. The old refresh-on-config-change hook
    // would have skipped the picker refresh here; the unconditional login-complete hook must not.
    const cfg: FrogConfig = { port: 10100, defaultProvider: provider, providers: { [provider]: { ...providerConfig } } };
    let saves = 0;
    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/oauth/login", {
          method: "POST",
          headers: { Origin: "http://localhost:10100", "content-type": "application/json" },
          body: JSON.stringify({ provider }),
        }),
        new URL("http://localhost/api/oauth/login"),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(res?.status).toBe(200);

      // Login completed (onComplete is awaited before the endpoint resolves): the credential is stored,
      // while the provider config was UNCHANGED, so the persist path was correctly skipped.
      expect(getCredential(provider)).not.toBeNull();
      expect(saves).toBe(0);

      // The re-logged-in provider is now authReady and visible in the readiness-filtered picker view —
      // the observable effect of the unconditional login-complete refresh.
      const view = await __requestLogTest.effectiveModelView(cfg);
      expect(view.models.find(m => m.provider === provider && m.id === "m1")?.authReady).toBe(true);
      expect(view.enabledModels.filter(m => m.authReady !== false).some(m => m.provider === provider)).toBe(true);
    } finally {
      removeCredential(provider);
      clearLoginState(provider);
      delete (OAUTH_PROVIDERS as Record<string, unknown>)[provider];
    }
  });
});
