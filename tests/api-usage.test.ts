import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { FrogConfig } from "../src/types";

let testDir = "";
let previousFrogHome: string | undefined;

function baseConfig(): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
      },
    },
  } as FrogConfig;
}

function writeFixture(now: number): void {
  const lines = [
    JSON.stringify({
      requestId: "frog-old",
      timestamp: now - 10 * 86_400_000,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      status: 200,
      durationMs: 12,
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 50 },
      totalTokens: 150,
    }),
    JSON.stringify({
      requestId: "frog-recent",
      timestamp: now - 1 * 86_400_000,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 5 },
      totalTokens: 15,
    }),
    JSON.stringify({
      requestId: "frog-missing",
      timestamp: now - 1 * 86_400_000,
      provider: "codex",
      model: "gpt-5.5",
      status: 200,
      durationMs: 11,
      usageStatus: "unreported",
    }),
  ];
  writeFileSync(join(testDir, "usage.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
}
function expectUsageSourceState(body: any): void {
  expect(body.sourceState).toEqual({
    observedUsage: {
      available: true,
      source: "local_request_log",
      authoritative: false,
      reason: null,
    },
    sessionLimits: {
      available: false,
      source: null,
      reason: "no_authoritative_source",
    },
    cost: {
      available: false,
      source: null,
      reason: "no_authoritative_source",
    },
  });
}

function expectNoDerivedUsageEstimates(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    const dotted = childPath.join(".");
    const keyLower = key.toLowerCase();
    const isAllowedUnavailableSourceState = dotted === "sourceState.sessionLimits" || dotted === "sourceState.cost";
    expect([
      "remaining",
      "limit",
      "reset",
      "resetat",
      "percentused",
      "usedpercent",
      "billing",
      "spend",
      "hardlimit",
      "sessionlimit",
      ...(isAllowedUnavailableSourceState ? [] : ["sessionlimits", "cost"]),
    ]).not.toContain(keyLower);
    expectNoDerivedUsageEstimates(child, childPath);
  }
}


beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "frog-api-usage-"));
  process.env.FROGPROGSY_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("GET /api/usage", () => {
  test("returns documented shape with summary, days, models, providers", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("range");
      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("days");
      expect(body).toHaveProperty("models");
      expect(body).toHaveProperty("providers");
      expect(body).toHaveProperty("sourceState");
      expect(Array.isArray(body.days)).toBe(true);
      expect(Array.isArray(body.models)).toBe(true);
      expect(Array.isArray(body.providers)).toBe(true);
      expectUsageSourceState(body);
      expectNoDerivedUsageEstimates(body);
    } finally {
      await server.stop(true);
    }
  });

  test("range=7d drops entries older than 7 days", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?range=7d", server.url));
      const body = await res.json();
      expect(body.range).toBe("7d");
      expect(body.summary.requests).toBe(2);
      expect(body.summary.totalTokens).toBe(15);
    } finally {
      await server.stop(true);
    }
  });

  test("default range is 30d and includes older entries", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      const body = await res.json();
      expect(body.range).toBe("30d");
      expect(body.summary.requests).toBe(3);
      expect(body.summary.reportedRequests).toBe(2);
      expect(body.summary.unreportedRequests).toBe(1);
      expect(body.summary.totalTokens).toBe(165);
    } finally {
      await server.stop(true);
    }
  });

  test("unknown range falls back to 30d", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?range=quarter", server.url));
      const body = await res.json();
      expect(body.range).toBe("30d");
    } finally {
      await server.stop(true);
    }
  });

  test("missing usage.jsonl returns zeroed summary, not 500", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.requests).toBe(0);
      expect(body.summary.totalTokens).toBe(0);
      expect(body.summary.coverageRatio).toBe(0);
      expectUsageSourceState(body);
      expectNoDerivedUsageEstimates(body);
    } finally {
      await server.stop(true);
    }
  });
  test("groups usage by final successful fallback provider and model only", async () => {
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "primary",
      fallbackProviders: ["fallback"],
      providers: {
        primary: {
          adapter: "anthropic",
          baseUrl: "https://primary.test",
          apiKey: "sk-primary-secret",
          defaultModel: "primary-model",
          models: ["primary-model"],
        },
        fallback: {
          adapter: "anthropic",
          baseUrl: "https://fallback.test",
          apiKey: "sk-fallback-secret",
          defaultModel: "fallback-model",
          models: ["fallback-model"],
        },
      },
    } as FrogConfig);

    const server = startServer(0);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const target = String(url);
      if (target.startsWith(server.url)) return originalFetch(url, init);
      if (target.startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "primary failed with sk-primary-secret" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        id: "msg_ok",
        type: "message",
        role: "assistant",
        model: "fallback-model",
        content: [{ type: "text", text: "fallback ok" }],
        usage: { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: 2 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const messageRes = await originalFetch(new URL("/v1/messages", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "primary/primary-model",
          max_tokens: 10,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(messageRes.status).toBe(200);
      await messageRes.json();

      const res = await originalFetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary).toMatchObject({
        requests: 1,
        reportedRequests: 1,
        totalTokens: 18,
        inputTokens: 13,
        outputTokens: 5,
        cachedInputTokens: 2,
      });
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0]).toMatchObject({ provider: "fallback", totalTokens: 18 });
      expect(body.models).toHaveLength(1);
      expect(body.models[0]).toMatchObject({ provider: "fallback", model: "fallback-model", totalTokens: 18 });
      expect(JSON.stringify(body)).not.toContain("primary");
      expect(JSON.stringify(body)).not.toContain("sk-primary-secret");
      expect(JSON.stringify(body)).not.toContain("sk-fallback-secret");
      expectUsageSourceState(body);
      expectNoDerivedUsageEstimates(body);
    } finally {
      globalThis.fetch = originalFetch;
      await server.stop(true);
    }
  });
});
