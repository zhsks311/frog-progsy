import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { computeModelAliases, deterministicModelAlias, resolveConfiguredModelAlias, resolvePersistedModelAlias, GATEWAY_MODEL_ALIAS_PREFIX, type ModelAliasEntry } from "../src/model-aliases";
import { nativeOpenAiSlugs, syncCatalogModels, type CatalogModel } from "../src/claude-catalog";
import { syncClaudeCodeGatewayModelsCache } from "../src/claude-refresh";
import { routeModel } from "../src/router";
import type { FrogConfig } from "../src/types";

const config: FrogConfig = {
  port: 10100,
  defaultProvider: "provider-a",
  providers: {
    "provider-a": {
      adapter: "openai-chat",
      baseUrl: "https://provider-a.example/v1",
      models: ["Model X/Preview"],
      apiKey: "literal-key",
    },
    "provider-b": {
      adapter: "anthropic",
      baseUrl: "https://provider-b.example",
      defaultModel: "claude-compatible",
    },
  },
};

// --- Behavioral temp-home fixtures for the canonical/subset alias-writer contract ------------------

function makeHomes() {
  const claudeHome = mkdtempSync(join(tmpdir(), "frogp-alias-claude-"));
  const frogHome = mkdtempSync(join(tmpdir(), "frogp-alias-home-"));
  const previousFrogHome = process.env.FROGPROGSY_HOME;
  process.env.FROGPROGSY_HOME = frogHome;
  return {
    claudeHome,
    aliasesPath: join(frogHome, "model-aliases.json"),
    cleanup() {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(claudeHome, { recursive: true, force: true });
      rmSync(frogHome, { recursive: true, force: true });
    },
  };
}

function persistedAliases(aliasesPath: string): Record<string, ModelAliasEntry> {
  return (JSON.parse(readFileSync(aliasesPath, "utf8")) as { aliases: Record<string, ModelAliasEntry> }).aliases;
}

function aliasForRouteKey(aliasesPath: string, routeKey: string): string | undefined {
  return Object.values(persistedAliases(aliasesPath)).find(entry => entry.routeKey === routeKey)?.alias;
}

// A native OpenAI slug from the shared always-latest source. No config below lists it in any `models[]`,
// so it only reaches the alias registry via the canonical native-slug write in syncCatalogModels.
const nativeSlug = nativeOpenAiSlugs()[0]!;

// Native-provider + routed-provider config. `openai` is the native OpenAI provider and contributes no
// routed model of its own (models: []); every routed model comes from `kimi`. Native slugs are therefore
// absent from every provider's `models[]`.
const tokenFreeConfig: FrogConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: {
      adapter: "openai-responses",
      authMode: "key",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "test-key",
      liveModels: false,
      models: [],
    },
    kimi: {
      adapter: "openai-chat",
      authMode: "key",
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: "test-key",
      liveModels: false,
      models: ["frog-kimi-only"],
    },
  },
};

// Canonical-writer-only config: a native `openai` provider with no routed models at all.
const nativeOnlyConfig: FrogConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: {
      adapter: "openai-responses",
      authMode: "key",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "test-key",
      liveModels: false,
      models: [],
    },
  },
};

describe("Claude-visible model aliases", () => {
  test("deterministic aliases are hashless, start with claude, and are stable", () => {
    const alias = deterministicModelAlias("provider-a", "Model X/Preview");
    expect(alias).toBe("claude-frogp-provider-a-model-x-preview");

    const reordered = deterministicModelAlias("provider-a", "Model X/Preview");
    expect(reordered).toBe(alias);
  });

  test("collision suffix appears only when distinct route keys share a slug base", () => {
    // Both sanitize to the same base: "." and "-" fold to the same slug.
    const colliding = computeModelAliases([
      { provider: "p", model: "gpt-5.5" },
      { provider: "p", model: "gpt-5-5" },
      { provider: "p", model: "unrelated" },
    ]);
    const a = colliding.get("p/gpt-5.5")!;
    const b = colliding.get("p/gpt-5-5")!;
    expect(a).toMatch(/^claude-frogp-p-gpt-5-5-[a-f0-9]{6}$/);
    expect(b).toMatch(/^claude-frogp-p-gpt-5-5-[a-f0-9]{6}$/);
    expect(a).not.toBe(b);
    expect(colliding.get("p/unrelated")).toBe("claude-frogp-p-unrelated");

    // Colliding statically configured models still reverse-map to their exact route keys.
    const collidingConfig: FrogConfig = {
      port: 10100,
      defaultProvider: "p",
      providers: {
        p: { adapter: "openai-chat", baseUrl: "https://p.example/v1", models: ["gpt-5.5", "gpt-5-5"] },
      },
    };
    expect(resolveConfiguredModelAlias(collidingConfig, a)).toMatchObject({ provider: "p", model: "gpt-5.5" });
    expect(resolveConfiguredModelAlias(collidingConfig, b)).toMatchObject({ provider: "p", model: "gpt-5-5" });
  });


  test("configured aliases reverse-map to exact provider/model without persisted state", () => {
    const alias = deterministicModelAlias("provider-a", "Model X/Preview");
    const entry = resolveConfiguredModelAlias(config, alias);

    expect(entry).toMatchObject({
      alias,
      provider: "provider-a",
      model: "Model X/Preview",
      routeKey: "provider-a/Model X/Preview",
      displayName: "provider-a/Model X/Preview",
    });
  });

  test("router accepts Claude-visible aliases and routes to the original provider model", () => {
    const alias = deterministicModelAlias("provider-a", "Model X/Preview");
    const route = routeModel(config, alias);

    expect(route.providerName).toBe("provider-a");
    expect(route.modelId).toBe("Model X/Preview");
    expect(route.provider.apiKey).toBe("literal-key");
  });

  test("retired alias-shaped Claude ids do not fall through to client-default routing", () => {
    const retired = `claude-${"frogprogsy"}-provider-a-model-x-preview`;

    expect(resolveConfiguredModelAlias(config, retired)).toBeUndefined();
    expect(() => routeModel(config, retired)).toThrow(/Removed routed model alias/);
  });

  test("unknown current-prefix gateway alias fails closed instead of falling through to default", () => {
    // Carries the live gateway alias prefix but names a provider/model that resolves to nothing.
    const unknown = `${GATEWAY_MODEL_ALIAS_PREFIX}provider-a-does-not-exist`;

    expect(unknown.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)).toBe(true); // premise
    expect(resolveConfiguredModelAlias(config, unknown)).toBeUndefined();
    // Must NOT drift to provider-a (the default) — throws so the request surface maps it to a 404.
    expect(() => routeModel(config, unknown)).toThrow(/Unknown gateway model alias/);
  });

  test("native Claude fallback model routes through non-Anthropic default provider", () => {
    const routed: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-haiku-4-5-20251001"],
        },
        codex: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "gpt-5.5",
          models: ["gpt-5.5"],
        },
      },
    };

    const route = routeModel(routed, "claude-haiku-4-5-20251001");

    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
  });

  test("explicit Anthropic namespace still routes to Anthropic", () => {
    const routed: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-haiku-4-5-20251001"],
        },
        codex: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "gpt-5.5",
          models: ["gpt-5.5"],
        },
      },
    };

    const route = routeModel(routed, "anthropic/claude-haiku-4-5-20251001");

    expect(route.providerName).toBe("anthropic");
    expect(route.modelId).toBe("claude-haiku-4-5-20251001");
  });

  test("canonical registry persists native aliases with no catalog file and no routed export", async () => {
    const { claudeHome, aliasesPath, cleanup } = makeHomes();
    try {
      // No catalog file (empty claudeHome) and no routed models: syncCatalogModels contributes nothing
      // to any catalog, but must still write the canonical alias registry BEFORE its early return.
      const result = await syncCatalogModels(nativeOnlyConfig, { claudeHome });
      expect(result.added).toBe(0);

      const nativeAlias = aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`);
      expect(nativeAlias).toBeDefined();
      expect(resolvePersistedModelAlias(nativeAlias!)).toMatchObject({
        provider: "openai",
        model: nativeSlug,
        routeKey: `openai/${nativeSlug}`,
      });

      const route = routeModel(nativeOnlyConfig, nativeAlias!);
      expect(route.providerName).toBe("openai");
      expect(route.modelId).toBe(nativeSlug);
    } finally {
      cleanup();
    }
  });

  test("subset gateway-cache materialization does not prune canonical native aliases", async () => {
    const { claudeHome, aliasesPath, cleanup } = makeHomes();
    try {
      // Canonical full-registry write: native OpenAI slugs + the routed kimi model.
      await syncCatalogModels(tokenFreeConfig, { claudeHome });
      const nativeAlias = aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`);
      const routedAlias = aliasForRouteKey(aliasesPath, "kimi/frog-kimi-only");
      expect(nativeAlias).toBeDefined();
      expect(routedAlias).toBeDefined();

      // A subset publisher (gateway cache) that only sees the kimi routed model must NOT delete the
      // native OpenAI aliases (nor the untouched routed alias) owned by the canonical writer.
      const result = await syncClaudeCodeGatewayModelsCache(tokenFreeConfig, { claudeHome }, {
        gatherRoutedModels: async () => [{ provider: "kimi", id: "frog-kimi-only", authReady: true }] as CatalogModel[],
      });
      expect(result.status).toBe("written");

      // Identity preserved exactly: the same alias strings still map to the same routeKeys.
      expect(aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`)).toBe(nativeAlias);
      expect(aliasForRouteKey(aliasesPath, "kimi/frog-kimi-only")).toBe(routedAlias);
    } finally {
      cleanup();
    }
  });

  test("aliases advertised before a subset refresh still routeModel-resolve after it", async () => {
    const { claudeHome, aliasesPath, cleanup } = makeHomes();
    try {
      await syncCatalogModels(tokenFreeConfig, { claudeHome });
      const nativeAlias = aliasForRouteKey(aliasesPath, `openai/${nativeSlug}`)!;
      const routedAlias = aliasForRouteKey(aliasesPath, "kimi/frog-kimi-only")!;
      expect(nativeAlias).toBeDefined();
      expect(routedAlias).toBeDefined();

      // Premise: the native slug is genuinely absent from every configured models[].
      for (const prov of Object.values(tokenFreeConfig.providers)) {
        expect(prov.models ?? []).not.toContain(nativeSlug);
      }

      // Both advertised aliases resolve before the refresh.
      expect(routeModel(tokenFreeConfig, nativeAlias)).toMatchObject({ providerName: "openai", modelId: nativeSlug });
      expect(routeModel(tokenFreeConfig, routedAlias)).toMatchObject({ providerName: "kimi", modelId: "frog-kimi-only" });

      // Refresh via the subset gateway-cache writer (only the kimi routed model is visible).
      await syncClaudeCodeGatewayModelsCache(tokenFreeConfig, { claudeHome }, {
        gatherRoutedModels: async () => [{ provider: "kimi", id: "frog-kimi-only", authReady: true }] as CatalogModel[],
      });

      // Both advertised aliases STILL resolve to the exact same route after the refresh — including the
      // native OpenAI slug that never appeared in config.models.
      expect(routeModel(tokenFreeConfig, nativeAlias)).toMatchObject({ providerName: "openai", modelId: nativeSlug });
      expect(routeModel(tokenFreeConfig, routedAlias)).toMatchObject({ providerName: "kimi", modelId: "frog-kimi-only" });
    } finally {
      cleanup();
    }
  });
});
