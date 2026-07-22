import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildGatewayCacheEntries,
  invalidateClaudeCodeGatewayModelsCache,
  refreshClaudeCodeModelCatalog,
  syncClaudeCodeGatewayModelsCache,
} from "../src/claude-refresh";
import type { CatalogModel } from "../src/claude-catalog";
import type { ModelAliasEntry } from "../src/model-aliases";
import type { FrogConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "anthropic",
  providers: {},
} as FrogConfig;

const EXPECTED_BASE_URL = "http://localhost:10100";

function makeHomes() {
  const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-home-"));
  const frogHome = mkdtempSync(join(tmpdir(), "frogp-home-"));
  const previousFrogHome = process.env.FROGPROGSY_HOME;
  process.env.FROGPROGSY_HOME = frogHome;
  return {
    claudeHome,
    cachePath: join(claudeHome, "cache", "gateway-models.json"),
    cleanup() {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(claudeHome, { recursive: true, force: true });
      rmSync(frogHome, { recursive: true, force: true });
    },
  };
}

function seedCache(cachePath: string, content: string): void {
  mkdirSync(join(cachePath, ".."), { recursive: true });
  writeFileSync(cachePath, content);
}

const anchor = (createdAt = new Date(0).toISOString()): ModelAliasEntry => ({
  alias: "claude-frogp-codex-gpt-5-5",
  provider: "codex",
  model: "gpt-5.5",
  routeKey: "codex/gpt-5.5",
  displayName: "codex/gpt-5.5",
  createdAt,
});

describe("Claude Code catalog refresh", () => {
  test("replaces Claude Code's models cache whenever the materialized catalog exists", async () => {
    let invalidated = 0;
    let syncedFrom: string | null = null;
    let gatewaySynced = 0;
    const result = await refreshClaudeCodeModelCatalog(config, {
      syncCatalogModels: async () => ({ added: 0, path: "/tmp/frogprogsy-catalog.json" }),
      invalidateClaudeCodeModelsCache: () => { invalidated += 1; },
      syncClaudeCodeGatewayModelsCache: async () => {
        gatewaySynced += 1;
        return { status: "written", path: "/tmp/gateway-models.json", modelCount: 1 };
      },
      syncClaudeCodeModelsCacheFromCatalog: (path) => { syncedFrom = path; },
      existsSync: () => true,
    });

    expect(result).toEqual({
      added: 0,
      path: "/tmp/frogprogsy-catalog.json",
      catalogExists: true,
      cacheSynced: true,
      gatewayCache: { status: "written", path: "/tmp/gateway-models.json", modelCount: 1 },
      warnings: [],
    });
    expect(invalidated).toBe(1);
    expect(gatewaySynced).toBe(1);
    expect(syncedFrom).toBe("/tmp/frogprogsy-catalog.json");
  });

  test("syncs gateway cache but does not touch models cache when no catalog can be materialized", async () => {
    let invalidated = 0;
    let synced = false;
    let gatewaySynced = 0;
    const result = await refreshClaudeCodeModelCatalog(config, {
      syncCatalogModels: async () => ({ added: 0, path: "/tmp/missing-catalog.json" }),
      invalidateClaudeCodeModelsCache: () => { invalidated += 1; },
      syncClaudeCodeGatewayModelsCache: async () => {
        gatewaySynced += 1;
        return { status: "written", path: "/tmp/gateway-models.json", modelCount: 1 };
      },
      syncClaudeCodeModelsCacheFromCatalog: () => { synced = true; },
      existsSync: () => false,
    });

    expect(result.catalogExists).toBe(false);
    expect(result.cacheSynced).toBe(false);
    expect(result.gatewayCache).toEqual({ status: "written", path: "/tmp/gateway-models.json", modelCount: 1 });
    expect(result.warnings).toEqual([]);
    expect(invalidated).toBe(0);
    expect(gatewaySynced).toBe(1);
    expect(synced).toBe(false);
  });

  test("writes Claude Code gateway discovery cache from enabled routed aliases with the exact schema", async () => {
    const { claudeHome, cachePath, cleanup } = makeHomes();
    try {
      const result = await syncClaudeCodeGatewayModelsCache({
        ...config,
        disabledModels: ["codex/gpt-hidden"],
        providers: {
          anthropic: {
            adapter: "anthropic",
            authMode: "forward",
            baseUrl: "https://api.anthropic.com",
            defaultModel: "claude-sonnet-4-6",
            models: ["claude-opus-4-8"],
          },
          codex: {
            adapter: "openai-responses",
            authMode: "key",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            apiKey: "test-key",
            liveModels: false,
            models: ["gpt-5.5", "gpt-hidden"],
          },
        },
      } as FrogConfig, { claudeHome });

      expect(result.status).toBe("written");
      expect(result.path).toBe(cachePath);
      expect(result.modelCount).toBe(1);
      expect(result.warning).toBeUndefined();

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
        baseUrl: string;
        fetchedAt: number;
        models: Array<{ id: string; display_name?: string }>;
      };
      // Exact top-level schema: baseUrl + fetchedAt + models (no legacy `type`/`created_at`).
      expect(Object.keys(cache).sort()).toEqual(["baseUrl", "fetchedAt", "models"]);
      expect(cache.baseUrl).toBe(EXPECTED_BASE_URL);
      expect(typeof cache.fetchedAt).toBe("number");
      expect(cache.fetchedAt).toBeGreaterThan(0);
      // Routed alias only; native/unnamespaced identities never present.
      expect(cache.models).toEqual([{ id: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5" }]);
      expect(Object.keys(cache.models[0]).sort()).toEqual(["display_name", "id"]);
      // POSIX: final on-disk mode is exactly 0600 after rename. Windows cannot represent POSIX bits,
      // so the fail-closed success contract is just a completed atomic write/replace (file present).
      if (process.platform === "win32") {
        expect(existsSync(cachePath)).toBe(true);
      } else {
        expect(statSync(cachePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      cleanup();
    }
  });

  test("filters routed models by CatalogModel.authReady before writing the cache", async () => {
    const { claudeHome, cachePath, cleanup } = makeHomes();
    try {
      const routed: CatalogModel[] = [
        { provider: "codex", id: "gpt-5.5", authReady: true },
        { provider: "codex", id: "gpt-locked", authReady: false },
        { provider: "kimi", id: "kimi-k2.5" },
      ];
      const result = await syncClaudeCodeGatewayModelsCache(config, { claudeHome }, {
        gatherRoutedModels: async () => routed,
      });

      expect(result.status).toBe("written");
      expect(result.modelCount).toBe(2);

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
        models: Array<{ id: string; display_name?: string }>;
      };
      // authReady === false hidden; undefined + true pass.
      expect(cache.models).toEqual([
        { id: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5" },
        { id: "claude-frogp-kimi-kimi-k2-5", display_name: "kimi/kimi-k2.5" },
      ]);
      expect(cache.models.some(m => m.display_name === "codex/gpt-locked")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("enforces the fail-closed cache write contract: 0600 on POSIX, atomic write on Windows", async () => {
    const { claudeHome, cachePath, cleanup } = makeHomes();
    try {
      const result = await syncClaudeCodeGatewayModelsCache(config, { claudeHome }, {
        gatherRoutedModels: async () => [{ provider: "codex", id: "gpt-5.5" }] as CatalogModel[],
      });
      expect(result.status).toBe("written");
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
        baseUrl: "http://localhost:10100",
        models: [{ id: "claude-frogp-codex-gpt-5-5" }],
      });
      expect(
        readdirSync(dirname(cachePath)).filter(
          name => name.startsWith(`${basename(cachePath)}.frogp.`) && name.endsWith(".tmp"),
        ),
      ).toEqual([]);
      // POSIX enforces exact 0600; Windows has no POSIX mode, so the contract is a successful write.
      if (process.platform === "win32") {
        expect(existsSync(cachePath)).toBe(true);
      } else {
        expect(statSync(cachePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      cleanup();
    }
  });

  test("rewrites a legacy (baseUrl-less) gateway cache to the current schema on a successful sync", async () => {
    const { claudeHome, cachePath, cleanup } = makeHomes();
    try {
      seedCache(cachePath, JSON.stringify({
        models: [{ id: "claude-frogp-old", display_name: "codex/old", type: "model", created_at: "1970-01-01T00:00:00.000Z" }],
      }) + "\n");

      const result = await syncClaudeCodeGatewayModelsCache(config, { claudeHome }, {
        gatherRoutedModels: async () => [{ provider: "codex", id: "gpt-5.5" }] as CatalogModel[],
      });

      expect(result.status).toBe("written");
      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { baseUrl: string; models: Array<{ id: string }> };
      // Delete-then-rewrite: legacy content fully replaced by the current schema.
      expect(Object.keys(cache).sort()).toEqual(["baseUrl", "fetchedAt", "models"]);
      expect(cache.baseUrl).toBe(EXPECTED_BASE_URL);
      expect(cache.models).toEqual([{ id: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5" }]);
    } finally {
      cleanup();
    }
  });

  test("retains last-known-good same-baseUrl cache on a transient sync failure", async () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-home-"));
    const cachePath = join(claudeHome, "cache", "gateway-models.json");
    try {
      const good = {
        baseUrl: EXPECTED_BASE_URL,
        fetchedAt: 111,
        models: [{ id: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5" }],
      };
      seedCache(cachePath, JSON.stringify(good) + "\n");

      const result = await refreshClaudeCodeModelCatalog(config, {
        syncCatalogModels: async () => ({ added: 0, path: "/tmp/frogprogsy-catalog.json" }),
        invalidateClaudeCodeModelsCache: () => {},
        syncClaudeCodeGatewayModelsCache: async () => { throw new Error("boom"); },
        syncClaudeCodeModelsCacheFromCatalog: () => {},
        existsSync: () => true,
      }, { claudeHome });

      expect(result.gatewayCache.status).toBe("retained_after_error");
      expect(result.gatewayCache.path).toBe(cachePath);
      expect(result.gatewayCache.warning).toContain("boom");
      expect(result.gatewayCache.warning).toContain("retained last-known-good");
      expect(result.warnings).toEqual([result.gatewayCache.warning]);
      // Cache preserved byte-for-byte (not invalidated).
      expect(existsSync(cachePath)).toBe(true);
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual(good);
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("deletes a legacy (baseUrl-less) cache on a transient failure and never retains it", async () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-home-"));
    const cachePath = join(claudeHome, "cache", "gateway-models.json");
    try {
      seedCache(cachePath, JSON.stringify({
        models: [{ id: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5", type: "model", created_at: "1970-01-01T00:00:00.000Z" }],
      }) + "\n");

      const result = await refreshClaudeCodeModelCatalog(config, {
        syncCatalogModels: async () => ({ added: 0, path: "/tmp/frogprogsy-catalog.json" }),
        invalidateClaudeCodeModelsCache: () => {},
        syncClaudeCodeGatewayModelsCache: async () => { throw new Error("boom"); },
        syncClaudeCodeModelsCacheFromCatalog: () => {},
        existsSync: () => true,
      }, { claudeHome });

      expect(result.gatewayCache.status).toBe("failed");
      expect(result.gatewayCache.status).not.toBe("retained_after_error");
      expect(result.gatewayCache.warning).toContain("boom");
      expect(result.gatewayCache.warning).toContain("stale/legacy cache deleted");
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("deletes a mismatched-baseUrl cache on a transient failure and never retains it", async () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-home-"));
    const cachePath = join(claudeHome, "cache", "gateway-models.json");
    try {
      seedCache(cachePath, JSON.stringify({ baseUrl: "http://localhost:9999", fetchedAt: 5, models: [] }) + "\n");

      const result = await refreshClaudeCodeModelCatalog(config, {
        syncCatalogModels: async () => ({ added: 0, path: "/tmp/frogprogsy-catalog.json" }),
        invalidateClaudeCodeModelsCache: () => {},
        syncClaudeCodeGatewayModelsCache: async () => { throw new Error("boom"); },
        syncClaudeCodeModelsCacheFromCatalog: () => {},
        existsSync: () => true,
      }, { claudeHome });

      expect(result.gatewayCache.status).toBe("failed");
      expect(result.gatewayCache.status).not.toBe("retained_after_error");
      expect(result.gatewayCache.warning).toContain("mismatched baseUrl");
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("deletes malformed current-schema caches on a transient failure and never retains them", async () => {
    const malformedCaches = [
      { baseUrl: EXPECTED_BASE_URL, fetchedAt: null, models: [] },
      { baseUrl: EXPECTED_BASE_URL, fetchedAt: 5, models: [{ id: "", display_name: "codex/gpt-5.5" }] },
      { baseUrl: EXPECTED_BASE_URL, fetchedAt: 5, models: [{ id: "claude-frogp-codex-gpt-5-5", display_name: 55 }] },
      { baseUrl: EXPECTED_BASE_URL, fetchedAt: 5, models: [], legacy: true },
      { baseUrl: EXPECTED_BASE_URL, fetchedAt: 5, models: [{ id: "claude-frogp-codex-gpt-5-5", type: "model" }] },
    ];

    for (const malformed of malformedCaches) {
      const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-home-"));
      const cachePath = join(claudeHome, "cache", "gateway-models.json");
      try {
        seedCache(cachePath, JSON.stringify(malformed) + "\n");
        const result = await refreshClaudeCodeModelCatalog(config, {
          syncCatalogModels: async () => ({ added: 0, path: "/tmp/frogprogsy-catalog.json" }),
          invalidateClaudeCodeModelsCache: () => {},
          syncClaudeCodeGatewayModelsCache: async () => { throw new Error("boom"); },
          syncClaudeCodeModelsCacheFromCatalog: () => {},
          existsSync: () => true,
        }, { claudeHome });

        expect(result.gatewayCache.status).toBe("failed");
        expect(result.gatewayCache.warning).toContain("stale/legacy cache deleted");
        expect(existsSync(cachePath)).toBe(false);
      } finally {
        rmSync(claudeHome, { recursive: true, force: true });
      }
    }
  });

  test("reports failed (not retained) when no last-known-good cache exists on a transient failure", async () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-home-"));
    const cachePath = join(claudeHome, "cache", "gateway-models.json");
    try {
      const result = await refreshClaudeCodeModelCatalog(config, {
        syncCatalogModels: async () => ({ added: 0, path: "/tmp/frogprogsy-catalog.json" }),
        invalidateClaudeCodeModelsCache: () => {},
        syncClaudeCodeGatewayModelsCache: async () => { throw new Error("boom"); },
        syncClaudeCodeModelsCacheFromCatalog: () => {},
        existsSync: () => true,
      }, { claudeHome });

      expect(result.gatewayCache.status).toBe("failed");
      expect(result.gatewayCache.warning).toContain("no last-known-good cache to retain");
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("deletes Claude Code gateway discovery cache on explicit invalidation", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-home-"));
    try {
      const cacheDir = join(claudeHome, "cache");
      mkdirSync(cacheDir);
      const cachePath = join(cacheDir, "gateway-models.json");
      writeFileSync(cachePath, "{}\n");

      const invalidated = invalidateClaudeCodeGatewayModelsCache({ claudeHome });

      expect(invalidated).toMatchObject({ path: cachePath, existed: true, deleted: true });
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("keeps last-known-good semantics as failed when a stale cache cannot be removed", async () => {
    const { claudeHome, cachePath, cleanup } = makeHomes();
    try {
      // Cache path is a directory: unreadable + unremovable, so it is neither retained nor deletable.
      mkdirSync(cachePath, { recursive: true });

      const result = await syncClaudeCodeGatewayModelsCache({
        ...config,
        providers: {
          codex: {
            adapter: "openai-responses",
            authMode: "key",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            apiKey: "test-key",
            liveModels: false,
            models: ["gpt-5.5"],
          },
        },
      } as FrogConfig, { claudeHome });

      expect(result.status).toBe("failed");
      expect(result.status).not.toBe("retained_after_error");
      expect(result.warning).toContain("stale cache may remain");
      expect(result.warning).toContain("invalidation failed");
      expect(existsSync(cachePath)).toBe(true);
    } finally {
      cleanup();
    }
  });

  describe("gateway cache write-time rejection (D-pinned)", () => {
    test("accepts a well-formed namespaced routed alias", () => {
      const { models, warnings } = buildGatewayCacheEntries([anchor()]);
      expect(models).toEqual([{ id: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5" }]);
      expect(warnings).toEqual([]);
    });

    test("rejects a generated id that collides with a native built-in slug (redacted, id-only)", () => {
      const collide: ModelAliasEntry = { ...anchor(), alias: "gpt-5.5" };
      const { models, warnings } = buildGatewayCacheEntries([collide]);
      expect(models).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"gpt-5.5"');
      expect(warnings[0]).toContain("native");
      // Redacted: only the id is surfaced, never the routing display.
      expect(warnings[0]).not.toContain("codex/gpt-5.5");
    });

    test("rejects a generated display that collides with a native built-in slug (redacted, id-only)", () => {
      const collide: ModelAliasEntry = { ...anchor(), displayName: "gpt-5.5" };
      const { models, warnings } = buildGatewayCacheEntries([collide]);
      expect(models).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"claude-frogp-codex-gpt-5-5"');
      expect(warnings[0]).toContain("native");
      // Redacted: the colliding display value is not leaked into the warning.
      expect(warnings[0]).not.toContain("gpt-5.5");
    });

    test("rejects a candidate lacking a namespaced <provider>/<model> routing identity", () => {
      const bare: ModelAliasEntry = { ...anchor(), alias: "claude-frogp-bare", routeKey: "gpt-6", displayName: "gpt-6" };
      const { models, warnings } = buildGatewayCacheEntries([bare]);
      expect(models).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"claude-frogp-bare"');
      expect(warnings[0]).toContain("namespaced");
    });

    test("emits only valid aliases and surfaces one warning per rejected candidate", () => {
      const { models, warnings } = buildGatewayCacheEntries([
        anchor(),
        { ...anchor(), alias: "gpt-5.4", routeKey: "codex/gpt-5.4", displayName: "codex/gpt-5.4" },
        { ...anchor(), alias: "claude-frogp-x", routeKey: "no-slash", displayName: "no-slash" },
      ]);
      expect(models).toEqual([{ id: "claude-frogp-codex-gpt-5-5", display_name: "codex/gpt-5.5" }]);
      expect(warnings).toHaveLength(2);
    });
  });
});
