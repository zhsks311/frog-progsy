import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { FrogConfig, FrogUsage } from "../src/types";
import type { PersistedUsageEntry } from "../src/usage-log";
import { buildUsagePricing, usagePriceKeyCandidates } from "../src/usage-pricing";

let testDir = "";
let previousFrogHome: string | undefined;

const defaultUsage: FrogUsage = {
  inputTokens: 1_000,
  outputTokens: 2_000,
  cachedInputTokens: 200,
  reasoningOutputTokens: 300,
};

function baseConfig(usagePricing?: FrogConfig["usagePricing"]): FrogConfig {
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
    ...(usagePricing ? { usagePricing } : {}),
  } as FrogConfig;
}

function entry(id: string, overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId: id,
    timestamp: 1_800_000_000_000,
    provider: "anthropic",
    model: "claude-sonnet",
    status: 200,
    durationMs: 25,
    usageStatus: "reported",
    usage: { ...defaultUsage },
    totalTokens: 3_000,
    ...overrides,
  } as PersistedUsageEntry;
}

function withoutUsage(id: string): PersistedUsageEntry {
  const item = entry(id);
  delete item.usage;
  delete item.totalTokens;
  return item;
}

function writeUsageLog(entries: PersistedUsageEntry[]): void {
  writeFileSync(join(testDir, "usage.jsonl"), `${entries.map(e => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "frog-usage-pricing-"));
  process.env.FROGPROGSY_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("usage pricing", () => {
  test("disabled pricing is unavailable and performs no display-cost math", () => {
    const summary = buildUsagePricing([entry("ok")], {
      enabled: false,
      prices: { "anthropic/claude-sonnet": { inputPerMTok: 3, outputPerMTok: 15 } },
      monthlyDisplayBudget: 1,
    });

    expect(summary).toMatchObject({
      available: false,
      source: null,
      reason: "disabled",
      currency: "USD",
      totalCost: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
      excludedRequests: 0,
    });
    expect(summary.budget).toBeUndefined();
  });

  test("prices only reported final successful primary usage and excludes failed, missing, unreported, estimated, unsupported, and shadow entries", () => {
    const failed = entry("failed", { status: 500 });
    const missing = withoutUsage("missing");
    const summary = buildUsagePricing([
      entry("priced"),
      entry("unpriced", { provider: "xai", model: "grok", resolvedModel: "grok-4", usage: { inputTokens: 50, outputTokens: 25 }, totalTokens: 75 }),
      entry("unreported", { usageStatus: "unreported" }),
      entry("unsupported", { usageStatus: "unsupported" }),
      entry("estimated", { usageStatus: "estimated" }),
      failed,
      entry("shadow", { source: "shadow" }),
      missing,
    ], {
      enabled: true,
      currency: "USD",
      prices: {
        "anthropic/claude-sonnet": {
          inputPerMTok: 3,
          outputPerMTok: 15,
          cachedInputPerMTok: 0.3,
          reasoningOutputPerMTok: 20,
        },
      },
      monthlyDisplayBudget: 0.05,
    });

    expect(summary.available).toBe(true);
    expect(summary.source).toBe("local_price_table");
    expect(summary.reason).toBe("display_only_not_billing");
    expect(summary.pricedRequests).toBe(1);
    expect(summary.pricedTokens).toBe(3_000);
    expect(summary.inputCost).toBe(0.0024);
    expect(summary.outputCost).toBe(0.03);
    expect(summary.cachedInputCost).toBe(0.00006);
    expect(summary.reasoningOutputCost).toBe(0.006);
    expect(summary.totalCost).toBe(0.03846);
    expect(summary.unpricedRequests).toBe(1);
    expect(summary.unpricedTokens).toBe(75);
    expect(summary.unpriced).toEqual([{ 
      provider: "xai",
      model: "grok",
      resolvedModel: "grok-4",
      requests: 1,
      inputTokens: 50,
      outputTokens: 25,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 75,
      priceKeyCandidates: ["xai/grok", "xai/grok-4", "grok", "grok-4"],
      reason: "price_missing",
    }]);
    expect(summary.excludedRequests).toBe(6);
    expect(summary.excludedByReason).toEqual({
      unreported: 1,
      unsupported: 1,
      estimated: 1,
      failed: 1,
      shadow: 1,
      missing_usage: 1,
    });
    expect(summary.budget).toEqual({
      amount: 0.05,
      used: 0.03846,
      remaining: 0.01154,
      ratio: 0.7692,
      displayOnly: true,
    });
  });

  test("uses final fallback provider and routed model price keys instead of guessed primary keys", () => {
    const finalEntry = entry("fallback", {
      provider: "fallback",
      model: "final-model",
      resolvedModel: "upstream-final-model",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      totalTokens: 1_500_000,
    });
    const summary = buildUsagePricing([finalEntry], {
      enabled: true,
      prices: {
        "primary/requested-model": { inputPerMTok: 100, outputPerMTok: 100 },
        "fallback/final-model": { inputPerMTok: 1, outputPerMTok: 2 },
      },
    });

    expect(usagePriceKeyCandidates(finalEntry)).toEqual([
      "fallback/final-model",
      "fallback/upstream-final-model",
      "final-model",
      "upstream-final-model",
    ]);
    expect(summary.pricedRequests).toBe(1);
    expect(summary.totalCost).toBe(2);
    expect(summary.unpricedRequests).toBe(0);
  });

  test("GET /api/usage-pricing exposes the display-only pricing snapshot without changing /api/usage source semantics", async () => {
    saveConfig(baseConfig({
      enabled: true,
      currency: "USD",
      prices: { "fallback/final-model": { inputPerMTok: 1, outputPerMTok: 2 } },
      monthlyDisplayBudget: 10,
    }));
    writeUsageLog([entry("api-priced", {
      provider: "fallback",
      model: "final-model",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      totalTokens: 1_500_000,
    })]);

    const server = startServer(0);
    try {
      const pricingRes = await fetch(new URL("/api/usage-pricing?range=all", server.url));
      expect(pricingRes.status).toBe(200);
      const pricingBody = await pricingRes.json();
      expect(pricingBody.range).toBe("all");
      expect(pricingBody.pricing).toMatchObject({
        available: true,
        source: "local_price_table",
        reason: "display_only_not_billing",
        totalCost: 2,
        pricedRequests: 1,
        budget: { amount: 10, used: 2, remaining: 8, ratio: 0.2, displayOnly: true },
      });
      expect(pricingBody.sourceState.cost).toEqual({
        available: true,
        source: "local_price_table",
        authoritative: false,
        reason: "display_only_not_billing",
      });

      const usageRes = await fetch(new URL("/api/usage?range=all", server.url));
      expect(usageRes.status).toBe(200);
      const usageBody = await usageRes.json();
      expect(usageBody.summary.totalTokens).toBe(1_500_000);
      expect(usageBody.sourceState.observedUsage).toMatchObject({ available: true, source: "local_request_log", authoritative: false });
      expect(usageBody.sourceState.sessionLimits).toMatchObject({ available: false, reason: "no_authoritative_source" });
      expect(usageBody.sourceState.cost).toMatchObject({ available: true, authoritative: false, reason: "display_only_not_billing" });
      expect(usageBody.pricing.totalCost).toBe(2);
    } finally {
      await server.stop(true);
    }
  });
});
