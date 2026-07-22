import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectProviderSecrets,
  normalizeProviderTestError,
  redactConfigForApi,
  redactDiagnosticMessage,
  redactProviderForApi,
} from "../src/provider-redaction";
import { __requestLogTest } from "../src/server";
import type { ClaudeGrantRecord, FrogConfig, FrogProviderConfig } from "../src/types";

const ENV_KEYS = ["FROGP_REDACTION_TEST_API_KEY", "FROGP_REDACTION_TEST_HEADER"] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));

let previousFrogHome: string | undefined;
let testHome = "";

function setupHome(): void {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "frog-provider-redaction-"));
  process.env.FROGPROGSY_HOME = testHome;
  __requestLogTest.clear();
}

function restoreHome(): void {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
  __requestLogTest.clear();
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

function provider(overrides: Partial<FrogProviderConfig> = {}): FrogProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://provider.test/v1",
    defaultModel: "model-a",
    ...overrides,
  };
}

function config(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "primary",
    providers: {
      primary: provider({
        apiKey: "sk-primary-abcdef1234",
        apiKeys: ["short7", "sk-secondary-abcdef5678", "$FROGP_REDACTION_TEST_API_KEY"],
        headers: {
          Authorization: "Bearer sk-header-abcdef9999",
          "x-api-key": "sk-header-key-1111",
          "x-custom-secret": "$FROGP_REDACTION_TEST_HEADER",
        },
      }),
    },
    localAccess: {
      enabled: true,
      keys: [{ id: "local-key", label: "Local key", secretHash: "sha256:local-access-hash-secret-value" }],
    },
    webSearchFallback: {
      searchProviders: {
        brave: { enabled: true, provider: "brave", apiKey: "brave-search-secret-value", baseUrl: "https://token:brave-url-secret@example.test/search?key=brave-url-query-secret" },
      },
    },
  };
}

async function managementJson(path: string, cfg: FrogConfig): Promise<unknown> {
  const res = await __requestLogTest.handleManagementAPI(
    new Request(`http://localhost${path}`),
    new URL(`http://localhost${path}`),
    cfg,
    { saveConfig: () => {} },
  );
  expect(res?.status).toBe(200);
  return res!.json();
}

function expectNoSecrets(serialized: string): void {
  expect(serialized).not.toContain("sk-primary-abcdef1234");
  expect(serialized).not.toContain("sk-secondary-abcdef5678");
  expect(serialized).not.toContain("short7");
  expect(serialized).not.toContain("env-api-key-secret-2222");
  expect(serialized).not.toContain("sk-header-abcdef9999");
  expect(serialized).not.toContain("sk-header-key-1111");
  expect(serialized).not.toContain("env-header-secret-3333");
  expect(serialized).not.toContain("brave-search-secret-value");
  expect(serialized).not.toContain("brave-url-secret");
  expect(serialized).not.toContain("brave-url-query-secret");
  expect(serialized).not.toContain("sha256:local-access-hash-secret-value");
  expect(serialized).not.toContain("abcdef");
}

beforeEach(() => {
  setupHome();
});

afterEach(() => {
  restoreEnv();
  restoreHome();
});

describe("provider redaction helpers", () => {
  test("provider API redaction hides apiKey, apiKeys, authorization, custom header, and env-resolved values", () => {
    process.env.FROGP_REDACTION_TEST_API_KEY = "env-api-key-secret-2222";
    process.env.FROGP_REDACTION_TEST_HEADER = "env-header-secret-3333";

    const redacted = redactProviderForApi(config().providers.primary!);
    const serialized = JSON.stringify(redacted);

    expectNoSecrets(serialized);
    expect(redacted.apiKey).toBe("sk-...1234");
    expect(redacted.apiKeys).toEqual(["...", "sk-...5678", "env...2222"]);
    expect(redacted.headers?.Authorization).toBe("Bea...9999");
    expect(redacted.headers?.["x-api-key"]).toBe("sk-...1111");
    expect(redacted.headers?.["x-custom-secret"]).toBe("env...3333");
  });

  test("config API-shaped redaction hides provider, web search, and local access secret material", () => {
    process.env.FROGP_REDACTION_TEST_API_KEY = "env-api-key-secret-2222";
    process.env.FROGP_REDACTION_TEST_HEADER = "env-header-secret-3333";

    const redacted = redactConfigForApi(config());
    const serialized = JSON.stringify(redacted);

    expectNoSecrets(serialized);
    expect(redacted.providers.primary?.apiKey).toBe("sk-...1234");
    expect(redacted.providers.primary?.headers?.["x-custom-secret"]).toBe("env...3333");
    expect(redacted.localAccess?.keys?.[0]?.secretHash).toBe("[REDACTED]");
    expect((redacted.webSearchFallback?.searchProviders?.brave as { hasApiKey?: boolean } | undefined)?.hasApiKey).toBe(true);
    expect((redacted.webSearchFallback?.searchProviders?.brave as { hasBaseUrl?: boolean; baseUrl?: string } | undefined)?.hasBaseUrl).toBe(true);
    expect((redacted.webSearchFallback?.searchProviders?.brave as { baseUrl?: string } | undefined)?.baseUrl).toBeUndefined();
  });

  test("management snapshots use shared redaction for config, provider-state, and providers", async () => {
    process.env.FROGP_REDACTION_TEST_API_KEY = "env-api-key-secret-2222";
    process.env.FROGP_REDACTION_TEST_HEADER = "env-header-secret-3333";
    const cfg = config();

    const snapshots = [
      await managementJson("/api/config", cfg),
      await managementJson("/api/provider-state", cfg),
      await managementJson("/api/providers", cfg),
    ];

    for (const snapshot of snapshots) expectNoSecrets(JSON.stringify(snapshot));
    const providerState = snapshots[1] as { providers?: Record<string, { apiKeyCount?: unknown; balanceSupported?: unknown; hasApiKey?: unknown; apiKey?: unknown; apiKeys?: unknown[] }> };
    const providers = snapshots[2] as Array<{ name?: string; apiKeyCount?: unknown; balanceSupported?: unknown; hasApiKey?: unknown; apiKey?: unknown; apiKeys?: unknown[] }>;
    expect(providerState.providers?.primary?.hasApiKey).toBe(true);
    expect(providerState.providers?.primary?.apiKeyCount).toBe(4);
    expect(providerState.providers?.primary?.balanceSupported).toBe(false);
    expect(providers.find(provider => provider.name === "primary")).toMatchObject({
      hasApiKey: true,
      apiKeyCount: 4,
      balanceSupported: false,
    });
  });

  test("diagnostic redaction replaces longer overlapping secrets first", () => {
    const redacted = redactDiagnosticMessage("failed with sk-secret-long and short sk-secret", ["sk-secret", "sk-secret-long"]);

    expect(redacted).toBe("failed with [REDACTED] and short [REDACTED]");
    expect(redacted).not.toContain("long");
    expect(redacted).not.toContain("sk-secret");
  });

  test("normalized diagnostics redact secrets and URLs without leaking raw headers", () => {
    const prov = provider({
      apiKey: "sk-normalize-secret-4444",
      headers: { Authorization: "Bearer sk-normalize-header-5555" },
    });
    const normalized = normalizeProviderTestError(
      new Error("GET https://secret-provider.test/v1/models failed Authorization Bearer sk-normalize-header-5555 sk-normalize-secret-4444"),
      { provider: prov, secrets: collectProviderSecrets(prov), httpStatus: 502 },
    );
    const serialized = JSON.stringify(normalized);

    expect(normalized).toMatchObject({ code: "http_error", httpStatus: 502 });
    expect(serialized).not.toContain("https://secret-provider.test");
    expect(serialized).not.toContain("sk-normalize-secret-4444");
    expect(serialized).not.toContain("sk-normalize-header-5555");
    expect(serialized).not.toContain("Authorization Bearer");
  });

  test("claude-grant provider redaction exposes grant id + auth mode but never a token, service, or absolute path", async () => {
    const grantProvider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "claude-grant",
      claudeGrantId: "cg_redact01",
      defaultModel: "claude-sonnet-4-6",
    };

    const redacted = redactProviderForApi(grantProvider);
    expect(redacted.authMode).toBe("claude-grant");
    expect(redacted.claudeGrantId).toBe("cg_redact01");
    const redactedSerialized = JSON.stringify(redacted);
    expect(redactedSerialized).not.toContain("/Users/");
    expect(redactedSerialized).not.toContain("Claude Code-credentials");
    expect(redactedSerialized).not.toContain("accessToken");

    const cfg = config();
    cfg.providers.granted = grantProvider;

    const providerState = await managementJson("/api/provider-state", cfg) as { providers?: Record<string, { authMode?: string; claudeGrantId?: string }> };
    expect(providerState.providers?.granted?.authMode).toBe("claude-grant");
    expect(providerState.providers?.granted?.claudeGrantId).toBe("cg_redact01");

    const providers = await managementJson("/api/providers", cfg) as Array<{ name?: string; authMode?: string; claudeGrantId?: string }>;
    const granted = providers.find(entry => entry.name === "granted");
    expect(granted?.authMode).toBe("claude-grant");
    expect(granted?.claudeGrantId).toBe("cg_redact01");

    const combined = JSON.stringify([providerState, providers]);
    expect(combined).not.toContain(testHome);
    expect(combined).not.toContain("Claude Code-credentials");
    expect(combined).not.toContain("accessToken");
  });

  test("generic config redaction strips grant configDir/secret paths but keeps id/label and provider binding", async () => {
    const grantConfigDir = join(testHome, "claude-grants", "cg_plant01");
    const grantRecord = {
      id: "cg_plant01",
      label: "Planted grant",
      configDir: grantConfigDir,
      createdAt: "2026-07-14T00:00:00.000Z",
      // Simulated secret-bearing metadata the allowlist must drop and never serialize.
      credentialPath: join(grantConfigDir, "Claude Code-credentials.json"),
      serviceName: "Claude Code-credentials-cg_plant01",
      accessToken: "grant-access-token-secret-7777",
      refreshToken: "grant-refresh-token-secret-8888",
      markerPath: join(grantConfigDir, ".frogprogsy-grant-marker"),
    } as unknown as ClaudeGrantRecord;

    const cfg = config();
    cfg.claudeGrants = { schemaVersion: 1, grants: [grantRecord] };
    cfg.providers.granted = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "claude-grant",
      claudeGrantId: "cg_plant01",
      defaultModel: "claude-sonnet-4-6",
    };

    const redacted = redactConfigForApi(cfg);
    const grants = redacted.claudeGrants as {
      schemaVersion?: number;
      grants?: Array<Record<string, unknown>>;
    } | undefined;
    expect(grants?.schemaVersion).toBe(1);
    expect(grants?.grants?.[0]?.id).toBe("cg_plant01");
    expect(grants?.grants?.[0]?.label).toBe("Planted grant");
    expect(grants?.grants?.[0]?.createdAt).toBe("2026-07-14T00:00:00.000Z");
    expect(grants?.grants?.[0]?.configDir).toBeUndefined();
    expect(grants?.grants?.[0]?.accessToken).toBeUndefined();
    expect(grants?.grants?.[0]?.serviceName).toBeUndefined();

    const snapshots = [
      redacted,
      await managementJson("/api/config", cfg),
      await managementJson("/api/provider-state", cfg),
    ];
    for (const snapshot of snapshots) {
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(testHome);
      expect(serialized).not.toContain("Claude Code-credentials");
      expect(serialized).not.toContain("grant-access-token-secret-7777");
      expect(serialized).not.toContain("grant-refresh-token-secret-8888");
      expect(serialized).not.toContain(".frogprogsy-grant-marker");
    }

    const apiConfig = snapshots[1] as { providers?: Record<string, { authMode?: string; claudeGrantId?: string }> };
    expect(apiConfig.providers?.granted?.authMode).toBe("claude-grant");
    expect(apiConfig.providers?.granted?.claudeGrantId).toBe("cg_plant01");

    const providerState = snapshots[2] as { providers?: Record<string, { authMode?: string; claudeGrantId?: string }> };
    expect(providerState.providers?.granted?.authMode).toBe("claude-grant");
    expect(providerState.providers?.granted?.claudeGrantId).toBe("cg_plant01");
  });
});
