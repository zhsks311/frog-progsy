import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveKeyCandidates, redactedKeyCandidateMetadata } from "../src/provider-keys";
import { buildAttemptContexts } from "../src/provider-fallback";

import { saveCredential } from "../src/oauth/store";
import { __requestLogTest } from "../src/server";
import type { FrogConfig, FrogParsedRequest, FrogProviderConfig } from "../src/types";

const ENV_KEYS = [
  "FROGP_TEST_PROVIDER_KEY_A",
  "FROGP_TEST_PROVIDER_KEY_B",
  "FROGP_TEST_PROVIDER_KEY_DUP",
  "FROGP_TEST_PROVIDER_KEY_MISSING",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));
let testHome = "";
let previousFrogHome: string | undefined;

function setupHome(): void {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "frog-provider-key-failover-"));
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

function provider(overrides: Partial<FrogProviderConfig>): FrogProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://provider.test",
    ...overrides,
  };
}

afterEach(() => {
  restoreEnv();
  restoreHome();
});

describe("effectiveKeyCandidates", () => {
  test("apiKey만 있으면 후보 1개", () => {
    expect(effectiveKeyCandidates(provider({ apiKey: "sk-primary-0001" }))).toEqual([
      { index: 0, key: "sk-primary-0001" },
    ]);
  });

  test("apiKey + apiKeys 순서 유지와 dedupe", () => {
    expect(effectiveKeyCandidates(provider({
      apiKey: "sk-primary-0001",
      apiKeys: ["sk-secondary-0002", "sk-primary-0001", "sk-third-0003"],
    }))).toEqual([
      { index: 0, key: "sk-primary-0001" },
      { index: 1, key: "sk-secondary-0002" },
      { index: 2, key: "sk-third-0003" },
    ]);
  });

  test("apiKeys만 있으면 배열 순서", () => {
    expect(effectiveKeyCandidates(provider({ apiKeys: ["sk-a-0001", "sk-b-0002"] }))).toEqual([
      { index: 0, key: "sk-a-0001" },
      { index: 1, key: "sk-b-0002" },
    ]);
  });

  test("env 참조 해석", () => {
    process.env.FROGP_TEST_PROVIDER_KEY_A = "sk-env-0001";
    process.env.FROGP_TEST_PROVIDER_KEY_B = "sk-env-0002";

    expect(effectiveKeyCandidates(provider({
      apiKey: "$FROGP_TEST_PROVIDER_KEY_A",
      apiKeys: ["${FROGP_TEST_PROVIDER_KEY_B}"],
    }))).toEqual([
      { index: 0, key: "sk-env-0001" },
      { index: 1, key: "sk-env-0002" },
    ]);
  });

  test("unset env는 건너뛰고 env 해석 후 dedupe", () => {
    delete process.env.FROGP_TEST_PROVIDER_KEY_MISSING;
    process.env.FROGP_TEST_PROVIDER_KEY_DUP = "sk-dup-0001";
    expect(effectiveKeyCandidates(provider({
      apiKey: "$FROGP_TEST_PROVIDER_KEY_MISSING",
      apiKeys: ["$FROGP_TEST_PROVIDER_KEY_DUP", "${FROGP_TEST_PROVIDER_KEY_DUP}", "sk-other-0002"],
    }))).toEqual([
      { index: 0, key: "sk-dup-0001" },
      { index: 1, key: "sk-other-0002" },
    ]);
  });


  test("redacted metadata에 raw key 없음", () => {
    const raw = "sk-secret-abcdef1234";
    const metadata = redactedKeyCandidateMetadata(provider({ apiKey: raw, apiKeys: ["short7"] }));
    expect(metadata).toEqual([
      { index: 0, masked: "sk-...1234" },
      { index: 1, masked: "..." },
    ]);
    expect(JSON.stringify(metadata)).not.toContain(raw);
    expect(JSON.stringify(metadata)).not.toContain("abcdef");
    expect(JSON.stringify(metadata)).not.toContain("short7");
  });


  test("forward/oauth authMode는 빈 배열", () => {
    expect(effectiveKeyCandidates(provider({ authMode: "forward", apiKey: "sk-primary-0001" }))).toEqual([]);
    expect(effectiveKeyCandidates(provider({ authMode: "oauth", apiKeys: ["sk-primary-0001"] }))).toEqual([]);
  });

  test("claude-grant authMode는 빈 배열", () => {
    expect(effectiveKeyCandidates(provider({
      authMode: "claude-grant",
      claudeGrantId: "cg_test",
      apiKey: "sk-primary-0001",
      apiKeys: ["sk-secondary-0002"],
    }))).toEqual([]);
  });
});
function failoverConfig(primaryOverrides: Partial<FrogProviderConfig> = {}): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "primary",
    fallbackProviders: ["fallback"],
    providers: {
      primary: {
        adapter: "anthropic",
        baseUrl: "https://primary.test",
        apiKey: "sk-primary-a",
        apiKeys: ["sk-primary-b", "sk-primary-c"],
        defaultModel: "primary-model",
        models: ["primary-model"],
        ...primaryOverrides,
      },
      fallback: {
        adapter: "anthropic",
        baseUrl: "https://fallback.test",
        apiKey: "sk-fallback",
        defaultModel: "fallback-model",
        models: ["fallback-model"],
      },
    },
  };
}

function okResponse(text = "ok"): Response {
  return new Response(JSON.stringify({
    id: "msg_ok",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input_tokens: 2, output_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { type: "upstream_error", message: `status ${status}` } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runMessage(config: FrogConfig, model = "primary/primary-model"): Promise<Response> {
  const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
  return __requestLogTest.handleMessages(
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    config,
    ctx,
  );
}

describe("provider key failover attempts", () => {
  test("429 tries remaining same-provider keys in configured order before provider fallback", async () => {
    setupHome();
    const cfg = failoverConfig();
    const attempts: Array<{ url: string; key: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers);
      const key = headers.get("x-api-key");
      attempts.push({ url: String(url), key });
      return String(url).startsWith("https://primary.test") ? errorResponse(429) : okResponse("fallback after keys");
    }) as typeof fetch;

    try {
      const response = await runMessage(cfg);
      expect(response.status).toBe(200);
      expect(attempts).toEqual([
        { url: "https://primary.test/v1/messages", key: "sk-primary-a" },
        { url: "https://primary.test/v1/messages", key: "sk-primary-b" },
        { url: "https://primary.test/v1/messages", key: "sk-primary-c" },
        { url: "https://fallback.test/v1/messages", key: "sk-fallback" },
      ]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.attempts).toEqual([
        { provider: "primary", model: "primary-model", source: "primary", keyIndex: 0, status: "error", code: "provider_non_2xx", upstreamStatus: 429 },
        { provider: "primary", model: "primary-model", source: "primary", keyIndex: 1, status: "error", code: "provider_non_2xx", upstreamStatus: 429 },
        { provider: "primary", model: "primary-model", source: "primary", keyIndex: 2, status: "error", code: "provider_non_2xx", upstreamStatus: 429 },
        { provider: "fallback", model: "fallback-model", source: "fallback", keyIndex: 0, status: "ok", upstreamStatus: 200 },
      ]);
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("sk-primary-a");
      expect(serialized).not.toContain("sk-primary-b");
      expect(serialized).not.toContain("sk-primary-c");
      expect(serialized).not.toContain("sk-fallback");
      expect(serialized).not.toContain("Authorization");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("each new request starts same-provider key failover from the first key", async () => {
    setupHome();
    const cfg = failoverConfig();
    const keys: Array<string | null> = [];
    let requestNumber = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const key = new Headers(init?.headers).get("x-api-key");
      keys.push(key);
      if (requestNumber === 0 && key === "sk-primary-a") return errorResponse(429);
      return okResponse("same provider ok");
    }) as typeof fetch;

    try {
      const first = await runMessage(cfg);
      requestNumber++;
      const second = await runMessage(cfg);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(keys).toEqual(["sk-primary-a", "sk-primary-b", "sk-primary-a"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each(["forward", "oauth"] as const)("%s auth 429 skips same-provider key failover and uses provider fallback", async (authMode) => {
    setupHome();
    const cfg = authMode === "oauth"
      ? {
        ...failoverConfig(),
        defaultProvider: "xai",
        providers: {
          xai: {
            ...failoverConfig().providers.primary,
            authMode,
            apiKey: "sk-ignored-a",
            apiKeys: ["sk-ignored-b"],
          },
          fallback: failoverConfig().providers.fallback,
        },
      } as FrogConfig
      : failoverConfig({ authMode, apiKey: "sk-ignored-a", apiKeys: ["sk-ignored-b"] });
    const model = authMode === "oauth" ? "xai/primary-model" : "primary/primary-model";
    if (authMode === "oauth") {
      saveCredential("xai", { access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 3_600_000 });
    }
    const attempts: Array<{ url: string; key: string | null; authorization: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers);
      attempts.push({
        url: String(url),
        key: headers.get("x-api-key"),
        authorization: headers.get("authorization"),
      });
      return String(url).startsWith("https://primary.test") ? errorResponse(429) : okResponse("provider fallback");
    }) as typeof fetch;

    try {
      const response = await runMessage(cfg, model);
      expect(response.status).toBe(200);
      expect(attempts.map(attempt => attempt.url)).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      expect(attempts[0].key).toBeNull();
      if (authMode === "oauth") {
        expect(attempts[0].authorization).toBe("Bearer oauth-access");
      } else {
        expect(attempts[0].authorization).toBeNull();
      }
      expect(attempts[0].authorization ?? "").not.toContain("sk-ignored");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fallback oauth provider injects bearer token on the fallback attempt", async () => {
    setupHome();
    const cfg = failoverConfig();
    cfg.fallbackProviders = ["xai"];
    cfg.providers.xai = {
      ...cfg.providers.fallback,
      authMode: "oauth",
      apiKey: undefined,
      apiKeys: undefined,
    };
    delete cfg.providers.fallback;
    saveCredential("xai", { access: "fallback-oauth-access", refresh: "fallback-oauth-refresh", expires: Date.now() + 3_600_000 });
    const attempts: Array<{ url: string; key: string | null; authorization: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers);
      attempts.push({
        url: String(url),
        key: headers.get("x-api-key"),
        authorization: headers.get("authorization"),
      });
      return String(url).startsWith("https://primary.test") ? errorResponse(503) : okResponse("oauth fallback");
    }) as typeof fetch;

    try {
      const response = await runMessage(cfg);
      expect(response.status).toBe(200);
      expect(attempts).toEqual([
        { url: "https://primary.test/v1/messages", key: "sk-primary-a", authorization: null },
        { url: "https://fallback.test/v1/messages", key: null, authorization: "Bearer fallback-oauth-access" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["5xx", async () => errorResponse(503)],
    ["unreachable", async () => { throw new TypeError("network unreachable"); }],
    ["timeout", async () => { throw new DOMException("Timeout elapsed", "TimeoutError"); }],
  ] as const)("%s uses provider fallback and skips remaining same-provider keys", async (_label, primaryResult) => {
    setupHome();
    const cfg = failoverConfig();
    const attempts: Array<{ url: string; key: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers);
      attempts.push({ url: String(url), key: headers.get("x-api-key") });
      if (String(url).startsWith("https://primary.test")) return primaryResult();
      return okResponse("provider fallback");
    }) as typeof fetch;

    try {
      const response = await runMessage(cfg);
      expect(response.status).toBe(200);
      expect(attempts).toEqual([
        { url: "https://primary.test/v1/messages", key: "sk-primary-a" },
        { url: "https://fallback.test/v1/messages", key: "sk-fallback" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("claude-grant attempt planning", () => {
  function primaryOf(overrides: Partial<FrogProviderConfig>): FrogProviderConfig {
    return provider({
      adapter: "anthropic",
      baseUrl: "https://primary.test",
      defaultModel: "primary-model",
      models: ["primary-model"],
      ...overrides,
    });
  }

  function keyPrimary(): FrogProviderConfig {
    return primaryOf({ apiKey: "sk-primary-a", apiKeys: ["sk-primary-b"] });
  }

  // A claude-grant provider whose config still carries stale/fake static keys. The runtime central
  // resolver injects a Bearer per request, so these config keys must never become attempt candidates.
  function grantPrimary(): FrogProviderConfig {
    return primaryOf({
      authMode: "claude-grant",
      claudeGrantId: "cg_testplan",
      apiKey: "sk-stale-a",
      apiKeys: ["sk-stale-b"],
    });
  }

  function planConfig(
    primaryProvider: FrogProviderConfig,
    fallbackProviders: string[] = [],
    extraProviders: Record<string, FrogProviderConfig> = {},
  ): FrogConfig {
    return {
      port: 10100,
      defaultProvider: "primary",
      fallbackProviders,
      providers: { primary: primaryProvider, ...extraProviders },
    };
  }

  function planParsed(modelId = "primary/primary-model"): FrogParsedRequest {
    return {
      modelId,
      context: { messages: [{ role: "user", content: "plan", timestamp: 0 }] },
      stream: false,
      options: {} as FrogParsedRequest["options"],
    } as FrogParsedRequest;
  }

  function planKeyIndexes(cfg: FrogConfig, modelId?: string): Array<number | undefined> {
    return buildAttemptContexts(cfg, planParsed(modelId)).attempts.map(attempt => attempt.keyIndex);
  }

  test("claude-grant primary builds exactly one credentialless attempt with no static key index", () => {
    const attempts = buildAttemptContexts(planConfig(grantPrimary()), planParsed()).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].source).toBe("primary");
    expect(attempts[0].providerName).toBe("primary");
    expect(attempts[0].keyIndex).toBeUndefined();
  });

  test("stale config keys on a claude-grant provider are not rotated into attempts", () => {
    // Same static apiKey/apiKeys shape: key mode rotates each key; grant mode makes a single attempt.
    expect(planKeyIndexes(planConfig(keyPrimary()))).toEqual([0, 1]);
    expect(planKeyIndexes(planConfig(grantPrimary()))).toEqual([undefined]);
  });

  test("claude-grant provider is selectable as a secondary fallback provider", () => {
    const cfg = planConfig(keyPrimary(), ["grantFallback"], {
      grantFallback: provider({
        adapter: "anthropic",
        baseUrl: "https://fallback.test",
        authMode: "claude-grant",
        claudeGrantId: "cg_fallbackplan",
        defaultModel: "fallback-model",
        models: ["fallback-model"],
      }),
    });
    const fallback = buildAttemptContexts(cfg, planParsed()).attempts.filter(attempt => attempt.source === "fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0].providerName).toBe("grantFallback");
    expect(fallback[0].modelId).toBe("fallback-model");
    expect(fallback[0].keyIndex).toBeUndefined();
  });

  test("key/oauth/forward attempt planning is unchanged", () => {
    expect(planKeyIndexes(planConfig(keyPrimary()))).toEqual([0, 1]);
    expect(planKeyIndexes(planConfig(primaryOf({
      authMode: "oauth",
      apiKey: "sk-stale-a",
      apiKeys: ["sk-stale-b"],
    })))).toEqual([undefined]);
    expect(planKeyIndexes(planConfig(primaryOf({
      authMode: "forward",
      apiKey: "sk-stale-a",
      apiKeys: ["sk-stale-b"],
    })))).toEqual([undefined]);
  });
});
