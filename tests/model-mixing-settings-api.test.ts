import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { MIX_EVIDENCE, MIX_PRESETS, modelMixingSettingsSnapshot } from "../src/model-mixing/settings";
import { computeCallPlan } from "../src/model-mixing/orchestrate";
import { startServer } from "../src/server";
import type { FrogConfig } from "../src/types";

let testDir = "";
let previousFrogHome: string | undefined;
let previousNoClaudeWrites: string | undefined;

function baseConfig(): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    disabledModels: [],
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-haiku-4-5",
        models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
      },
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com",
        authMode: "forward",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
      },
    },
  } as FrogConfig;
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  previousNoClaudeWrites = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  testDir = mkdtempSync(join(tmpdir(), "frog-mix-settings-"));
  process.env.FROGPROGSY_HOME = testDir;
  process.env.FROGPROGSY_NO_CLAUDE_WRITES = "1";
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (previousNoClaudeWrites === undefined) delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  else process.env.FROGPROGSY_NO_CLAUDE_WRITES = previousNoClaudeWrites;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("modelMixingSettingsSnapshot", () => {
  test("normalizes absent modelMixing and enumerates all providers with sorted known models", () => {
    const snap = modelMixingSettingsSnapshot(baseConfig());
    expect(snap.modelMixing).toMatchObject({ enabled: false, aliasId: "frogp/mix", mode: "coordinator", combine: "route", agents: [], fusion: {} });
    expect(snap.providers.map(p => p.name)).toEqual(["anthropic", "codex"]);
    const codex = snap.providers.find(p => p.name === "codex")!;
    expect(codex.defaultModel).toBe("gpt-5.5");
    expect(codex.models).toEqual([...codex.models].sort());
    expect(codex.models).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]);
  });

  test("exposes only the non-secret Claude grant binding needed for readiness", () => {
    const config = baseConfig();
    config.providers.anthropic.authMode = "claude-grant";
    config.providers.anthropic.claudeGrantId = "cg_test1234";

    const anthropic = modelMixingSettingsSnapshot(config).providers.find(provider => provider.name === "anthropic");
    expect(anthropic).toMatchObject({ authMode: "claude-grant", claudeGrantId: "cg_test1234" });
    expect(anthropic).not.toHaveProperty("apiKey");
    expect(anthropic).not.toHaveProperty("apiKeys");
  });

  test("adds server-computed call plans to preset metadata without mutating the live config", () => {
    const cfg = baseConfig();
    cfg.modelMixing = { enabled: false, aliasId: "team/router", combine: "route", agents: [] };
    const before = JSON.stringify(cfg.modelMixing);

    const snap = modelMixingSettingsSnapshot(cfg);

    expect(cfg.modelMixing).toEqual(JSON.parse(before));
    expect(snap.presets.find(p => p.id === "low")?.callPlan).toEqual({ calls: 4, searchCalls: 0 });
    expect(snap.presets.find(p => p.id === "balanced")?.callPlan).toEqual({ calls: 5, searchCalls: 0 });
    expect(snap.presets.find(p => p.id === "research")?.callPlan).toEqual({ calls: 11, searchCalls: 3 });
  });

  test("exports F3 evidence constants sealed to official artifact values", async () => {
    // The sealed reference is the COMMITTED fixture snapshot of the official acceptance stats
    // (artifacts/eval-runs/ is gitignored runtime output, so fresh clones/CI cannot read it).
    const stats = await Bun.file("evals/fusion/fixtures/local-suite-v1-run-002-f3-stats.json").json() as any;
    // When the live runtime artifact exists locally, it must match the committed snapshot too.
    const live = Bun.file("artifacts/eval-runs/local-suite-v1/run-002-f3/stats.json");
    if (await live.exists()) {
      const liveStats = await live.json() as any;
      expect(liveStats.qualityDelta).toBe(stats.qualityDelta);
      expect(liveStats.qualityDeltaCi95).toEqual(stats.qualityDeltaCi95);
      expect(liveStats.passesPrimaryGate).toBe(stats.passesPrimaryGate);
    }
    expect(MIX_EVIDENCE.candidate).toBe(stats.primaryCandidate);
    expect(MIX_EVIDENCE.baseline).toBe(stats.baselineSelected);
    expect(MIX_EVIDENCE.candidateLabel).toBe(stats.primaryCandidate);
    expect(MIX_EVIDENCE.baselineLabel).toBe("codex/gpt-5.5");
    expect(MIX_EVIDENCE.qualityDelta).toBe(stats.qualityDelta);
    expect(MIX_EVIDENCE.qualityDeltaCi95[0]).toBe(stats.qualityDeltaCi95[0]);
    expect(MIX_EVIDENCE.qualityDeltaCi95[1]).toBe(stats.qualityDeltaCi95[1]);
    expect(MIX_EVIDENCE.passesPrimaryGate).toBe(stats.passesPrimaryGate);
    expect(MIX_EVIDENCE.latencyWallClockMs.p50).toBe(stats.latency.wallClockMs.p50);
    expect(MIX_EVIDENCE.latencyWallClockMs.p95).toBe(stats.latency.wallClockMs.p95);
  });

  test("research preset matches f3-codex profile except enabled and aliasId are omitted for preservation", async () => {
    const profile = await Bun.file("evals/fusion/profiles/f3-codex.json").json() as { modelMixing: Record<string, unknown> };
    const research = MIX_PRESETS.find(p => p.id === "research")!.modelMixing as Record<string, unknown>;
    const { enabled: _enabled, aliasId: _aliasId, ...profileMixing } = profile.modelMixing;
    expect(research).toEqual(profileMixing);

    const cfg = baseConfig();
    cfg.modelMixing = { enabled: false, aliasId: "team/router" };
    cfg.modelMixing = { ...cfg.modelMixing, ...JSON.parse(JSON.stringify(research)) };
    expect(cfg.modelMixing.enabled).toBe(false);
    expect(cfg.modelMixing.aliasId).toBe("team/router");
    expect(computeCallPlan(cfg)).toMatchObject({ calls: 11, searchCalls: 3 });
  });
});

describe("GET/PUT /api/model-mixing-settings", () => {
  test("GET returns normalized settings, provider roster, catalog alias status, presets, and evidence", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/model-mixing-settings", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.modelMixing.enabled).toBe(false);
      expect(body.modelMixing.aliasId).toBe("frogp/mix");
      expect(body.providers.map((p: any) => p.name)).toContain("codex");
      expect(body.catalogAlias).toMatchObject({ aliasId: "frogp/mix", namespaced: true, provider: "frogp", id: "mix", exposed: false, disabled: false, hiddenPolicy: "alias-id-specific" });
      expect(body.presets.map((p: any) => p.id)).toEqual(["low", "balanced", "research"]);
      expect(body.evidence.candidate).toBe("f3-codex");
      expect(body.evidence.candidateLabel).toBe("f3-codex");
      expect(body.evidence.baselineLabel).toBe("codex/gpt-5.5");
      expect(body.presets.find((p: any) => p.id === "low").callPlan).toEqual({ calls: 4, searchCalls: 0 });
      expect(body.presets.find((p: any) => p.id === "balanced").callPlan).toEqual({ calls: 5, searchCalls: 0 });
      expect(body.presets.find((p: any) => p.id === "research").callPlan).toEqual({ calls: 11, searchCalls: 3 });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT round-trips GUI-owned fields and persists unknown model strings with warnings", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelMixing: { combine: "fusion", agents: [{ provider: "codex", model: "not-a-real-model" }] } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as any;
      expect(body.ok).toBe(true);
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.modelMixing.combine).toBe("fusion");
      expect(body.modelMixing.agents).toEqual([{ provider: "codex", model: "not-a-real-model" }]);

      const get = await fetch(new URL("/api/model-mixing-settings", server.url));
      const getBody = await get.json() as any;
      expect(getBody.modelMixing.agents[0].model).toBe("not-a-real-model");
    } finally {
      await server.stop(true);
    }
  });

  test("PUT ignores wrong field shapes with warnings and only malformed JSON returns 400", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelMixing: { enabled: "yes", agents: { provider: "codex" }, fusion: { contextMode: "huge" } } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as any;
      expect(body.ok).toBe(true);
      expect(body.warnings.length).toBeGreaterThanOrEqual(3);
      expect(body.modelMixing.enabled).toBe(false);
      expect(body.modelMixing.agents).toEqual([]);

      const bad = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json {{",
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("partial PUT recursively merges and preserves unknown future keys plus GUI-unowned fields", async () => {
    const config = baseConfig() as any;
    config.modelMixing = {
      enabled: false,
      aliasId: "frogp/mix",
      combine: "fusion",
      unknownFutureKey: { nested: { keep: true } },
      rules: [{ match: { taskKeywords: ["debug"] }, provider: "codex", model: "gpt-5.5" }],
      pipeline: [{ role: "worker", provider: "codex", model: "gpt-5.4" }],
      surfaceStages: false,
      guidance: "keep this guidance",
      timeoutMs: 12345,
      fusion: {
        panel: [{ provider: "codex", model: "gpt-5.5" }],
        panelWebSearch: { enabled: false, maxTotalSearches: 9 },
      },
    };
    saveConfig(config);

    const preserved = JSON.parse(JSON.stringify(config.modelMixing));
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelMixing: { fusion: { contextMode: "full" } } }),
      });
      expect(put.status).toBe(200);
      const saved = loadConfig() as any;
      expect(saved.modelMixing.fusion.contextMode).toBe("full");
      expect(saved.modelMixing.fusion.panel).toEqual(preserved.fusion.panel);
      expect(saved.modelMixing.fusion.panelWebSearch).toEqual(preserved.fusion.panelWebSearch);
      for (const key of ["unknownFutureKey", "rules", "pipeline", "surfaceStages", "guidance", "timeoutMs"]) {
        expect(saved.modelMixing[key]).toEqual(preserved[key]);
      }
    } finally {
      await server.stop(true);
    }
  });
});
