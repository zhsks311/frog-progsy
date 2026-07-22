import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { MIX_PRESETS, applyModelMixingPatch } from "../src/model-mixing/settings";
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
        models: ["claude-haiku-4-5", "claude-sonnet-4-5"],
      },
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com",
        authMode: "forward",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
      },
    },
  } as FrogConfig;
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  previousNoClaudeWrites = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  testDir = mkdtempSync(join(tmpdir(), "frog-mix-settings-adv-"));
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

describe("model mixing settings adversarial contracts", () => {
  test("alias hidden state is alias-id-specific and is not migrated when aliasId changes", async () => {
    const config = baseConfig();
    config.modelMixing = { enabled: true, aliasId: "frogp/mix" };
    config.disabledModels = ["frogp/mix"];
    saveConfig(config);

    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/model-mixing-settings", server.url));
      const firstBody = await first.json() as any;
      expect(firstBody.catalogAlias).toMatchObject({ aliasId: "frogp/mix", exposed: true, disabled: true, hiddenPolicy: "alias-id-specific" });

      const put = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelMixing: { aliasId: "team/router" } }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json() as any;
      expect(putBody.catalogAlias).toMatchObject({ aliasId: "team/router", provider: "team", id: "router", exposed: true, disabled: false, hiddenPolicy: "alias-id-specific" });
      expect(loadConfig().disabledModels).toEqual(["frogp/mix"]);
    } finally {
      await server.stop(true);
    }
  });

  test("research preset patch preserves enabled and aliasId while producing the required 11+3 call plan", async () => {
    const config = baseConfig();
    config.modelMixing = { enabled: false, aliasId: "team/router", combine: "route" };
    const research = MIX_PRESETS.find(p => p.id === "research")!.modelMixing;
    const warnings = applyModelMixingPatch(config, research);
    expect(warnings).toEqual([]);
    expect(config.modelMixing?.enabled).toBe(false);
    expect(config.modelMixing?.aliasId).toBe("team/router");
    expect(computeCallPlan(config)).toMatchObject({ mode: "fusion", calls: 11, searchCalls: 3 });
  });

  test("call-plan draft preview is non-persistent and malformed draft JSON returns 400", async () => {
    const server = startServer(0);
    try {
      const research = MIX_PRESETS.find(p => p.id === "research")!.modelMixing;
      const res = await fetch(new URL(`/api/model-mixing/call-plan?draft=${encodeURIComponent(JSON.stringify(research))}`, server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({ ok: true, plan: { mode: "fusion", calls: 11, searchCalls: 3 }, warnings: [] });
      expect(loadConfig().modelMixing).toBeUndefined();

      const current = await fetch(new URL("/api/model-mixing/call-plan", server.url));
      const currentBody = await current.json() as any;
      expect(currentBody.plan).toMatchObject({ mode: "route", calls: 2, searchCalls: 0 });

      const malformed = await fetch(new URL(`/api/model-mixing/call-plan?draft=${encodeURIComponent("{ nope")}`, server.url));
      expect(malformed.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("call-plan draft semantic problems are warnings, not 400, and do not mutate saved config", async () => {
    const server = startServer(0);
    try {
      const draft = { enabled: "true", combine: "fusion", agents: [{ provider: "missing", model: "ghost" }], fusion: { panel: [{ provider: "codex", model: "unknown" }] } };
      const res = await fetch(new URL(`/api/model-mixing/call-plan?draft=${encodeURIComponent(JSON.stringify(draft))}`, server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.warnings.length).toBeGreaterThanOrEqual(2);
      expect(loadConfig().modelMixing).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("arrays replace only when present; nested object patches preserve sibling fields", () => {
    const config = baseConfig() as any;
    config.modelMixing = {
      agents: [{ provider: "codex", model: "gpt-5.5" }],
      pipeline: [{ role: "worker", provider: "codex", model: "gpt-5.4" }],
      rules: [{ provider: "codex", model: "gpt-5.5" }],
      fusion: {
        panel: [{ provider: "codex", model: "gpt-5.4-mini" }],
        judge: { provider: "codex", model: "gpt-5.5" },
        panelWebSearch: { enabled: true, maxSearchesPerPanel: 1, maxTotalSearches: 4, timeoutMs: 10000, tiers: ["no_key"] },
      },
    };
    const before = JSON.parse(JSON.stringify(config.modelMixing));
    const warnings = applyModelMixingPatch(config, { fusion: { panelWebSearch: { timeoutMs: 20000 } } });
    expect(warnings).toEqual([]);
    expect(config.modelMixing.agents).toEqual(before.agents);
    expect(config.modelMixing.pipeline).toEqual(before.pipeline);
    expect(config.modelMixing.rules).toEqual(before.rules);
    expect(config.modelMixing.fusion.panel).toEqual(before.fusion.panel);
    expect(config.modelMixing.fusion.judge).toEqual(before.fusion.judge);
    expect(config.modelMixing.fusion.panelWebSearch).toEqual({ ...before.fusion.panelWebSearch, timeoutMs: 20000 });
  });

  test("invalid numeric ranges are ignored with warnings and preserve existing values", async () => {
    const config = baseConfig();
    config.modelMixing = {
      timeoutMs: 30000,
      stageTimeoutMs: 60000,
      panelTimeoutMs: 60000,
      fusion: {
        panelWebSearch: { maxSearchesPerPanel: 1, maxTotalSearches: 4, timeoutMs: 10000 },
        multiround: { maxRounds: 2, branchFactor: 2, budgetCalls: 12 },
      },
    } as any;
    saveConfig(config);

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelMixing: {
            timeoutMs: -1,
            stageTimeoutMs: 0,
            panelTimeoutMs: -5,
            fusion: {
              panelWebSearch: { maxSearchesPerPanel: -1, maxTotalSearches: 1.5, timeoutMs: 0 },
              multiround: { maxRounds: -1, branchFactor: 0, budgetCalls: 2.5 },
            },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("modelMixing.timeoutMs ignored"),
        expect.stringContaining("modelMixing.stageTimeoutMs ignored"),
        expect.stringContaining("modelMixing.panelTimeoutMs ignored"),
        expect.stringContaining("modelMixing.fusion.panelWebSearch.maxSearchesPerPanel ignored"),
        expect.stringContaining("modelMixing.fusion.panelWebSearch.maxTotalSearches ignored"),
        expect.stringContaining("modelMixing.fusion.panelWebSearch.timeoutMs ignored"),
        expect.stringContaining("modelMixing.fusion.multiround.maxRounds ignored"),
        expect.stringContaining("modelMixing.fusion.multiround.branchFactor ignored"),
        expect.stringContaining("modelMixing.fusion.multiround.budgetCalls ignored"),
      ]));
      expect(loadConfig().modelMixing).toMatchObject(config.modelMixing);
    } finally {
      await server.stop(true);
    }
  });

  test("valid JSON non-object PUT body is a 200 no-op with warning", async () => {
    const config = baseConfig();
    config.modelMixing = { enabled: true, aliasId: "frogp/mix", timeoutMs: 30000 };
    saveConfig(config);

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.warnings).toEqual(expect.arrayContaining([expect.stringContaining("body ignored")]));
      expect(loadConfig().modelMixing).toEqual(config.modelMixing);
    } finally {
      await server.stop(true);
    }
  });

  test("unsafe merge keys are warned and not persisted", async () => {
    const config = baseConfig();
    config.modelMixing = { fusion: { panelWebSearch: { timeoutMs: 10000, safeSibling: { keep: true } } } } as any;
    saveConfig(config);

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/model-mixing-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: `{
          "modelMixing": {
            "__proto__": { "polluted": true },
            "constructor": { "polluted": true },
            "prototype": { "polluted": true },
            "custom": { "__proto__": { "polluted": true }, "safe": true },
            "fusion": {
              "prototype": { "polluted": true },
              "panelWebSearch": {
                "__proto__": { "polluted": true },
                "safeSibling": { "added": true }
              }
            }
          }
        }`,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("modelMixing.__proto__ ignored"),
        expect.stringContaining("modelMixing.constructor ignored"),
        expect.stringContaining("modelMixing.prototype ignored"),
        expect.stringContaining("modelMixing.custom.__proto__ ignored"),
        expect.stringContaining("modelMixing.fusion.prototype ignored"),
        expect.stringContaining("modelMixing.fusion.panelWebSearch.__proto__ ignored"),
      ]));
      const saved = loadConfig().modelMixing as any;
      expect(Object.prototype).not.toHaveProperty("polluted");
      expect(Object.prototype.hasOwnProperty.call(saved, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(saved, "constructor")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(saved, "prototype")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(saved.fusion, "prototype")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(saved.fusion.panelWebSearch, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(saved.custom, "__proto__")).toBe(false);
      expect(saved.custom.safe).toBe(true);
      expect(saved.fusion.panelWebSearch.safeSibling).toEqual({ keep: true, added: true });
    } finally {
      await server.stop(true);
    }
  });
});
