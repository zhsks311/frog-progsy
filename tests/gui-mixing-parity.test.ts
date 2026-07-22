import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "../gui/node_modules/react";
import { renderToString } from "../gui/node_modules/react-dom/server";
import { LanguageProvider } from "../gui/src/i18n";
import ModelMixing, { ModelMixingSettingsLoadError, fetchModelMixingSettings, mixMemberReadiness, type SettingsLoadFailure } from "../gui/src/pages/ModelMixing";
import type { ClaudeGrantSummary } from "../gui/src/pages/ClaudeProfiles";

const originalFetch = globalThis.fetch;
const originalNavigatorLanguage = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNavigatorLanguage) Object.defineProperty(globalThis.navigator, "language", originalNavigatorLanguage);
  else Reflect.deleteProperty(globalThis.navigator, "language");
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sentinelSettings() {
  return {
    modelMixing: {
      enabled: false,
      aliasId: "alias-sentinel",
      combine: "fusion",
      agents: [{ provider: "sentinel-provider", model: "sentinel-model" }],
      fusion: {
        judge: { provider: "sentinel-provider", model: "sentinel-model" },
        synthesizer: { provider: "sentinel-provider", model: "sentinel-model" },
        contextMode: "task",
        judgeContextMode: "task",
        panelWebSearch: { enabled: true, maxSearchesPerPanel: 7, maxTotalSearches: 13 },
        multiround: { enabled: true, maxRounds: 2, branchFactor: 3, budgetCalls: 42 },
      },
      stageTimeoutMs: 1234,
      panelTimeoutMs: 5678,
    },
    providers: [{ name: "sentinel-provider", defaultModel: "sentinel-model", models: ["sentinel-model"] }],
    catalogAlias: {
      aliasId: "alias-sentinel",
      namespaced: true,
      provider: "frogprogsy",
      id: "model-mixing",
      exposed: true,
      disabled: false,
      hiddenPolicy: "alias-id-specific" as const,
    },
    presets: [{
      id: "sentinel-preset",
      label: "Sentinel preset",
      description: "Sentinel preset description",
      modelMixing: { enabled: false, aliasId: "alias-sentinel", combine: "fusion", agents: [] },
      callPlan: { calls: 42, searchCalls: 7 },
    }],
    evidence: {
      candidate: "sentinel-candidate",
      baseline: "baseline-sentinel",
      candidateLabel: "sentinel-x9",
      baselineLabel: "baseline-y8",
      qualityDelta: 0.777,
      qualityDeltaCi95: [0.701, 0.888] as const,
      latencyWallClockMs: { p50: 9876, p95: 654321 },
    },
    warnings: [],
  };
}

describe("GUI model-mixing parity", () => {
  test("model mixing page source keeps server-owned evidence and preset call plans", () => {
    const source = [
      read("gui/src/pages/ModelMixing.tsx"),
      read("gui/src/i18n/en.ts"),
      read("gui/src/i18n/ko.ts"),
      read("gui/src/i18n/zh.ts"),
    ].join("\n");

    for (const literal of ["F3", "Research/F3", "p50 29", "p95 219", "29초", "219초", "29 秒", "219 秒", "0.1333", "0.0583", "0.2000", "219457", "28766", "4+0", "5+0", "11+3", "품질 델타", "namespaced alias", "local-suite-v1", "stageTimeoutMs와", "stageTimeoutMs and panelTimeoutMs", "aliasId를 보존", "enabled 和 aliasId"]) {
      expect(source).not.toContain(literal);
    }

    expect(source).not.toContain("evidence.qualityDelta");
    expect(source).not.toContain("evidence.qualityDeltaCi95");
    expect(source).not.toContain("evidence.latencyWallClockMs");
    expect(source).toContain("preset.callPlan.calls");
    expect(source).toContain("preset.callPlan.searchCalls");
  });

  test("model mixing docs cover dashboard advanced settings and alias rename in all locales", () => {
    const docs = {
      en: read("docs-site/content/docs/en/guides/model-mixing.md"),
      ko: read("docs-site/content/docs/ko/guides/model-mixing.md"),
      zh: read("docs-site/content/docs/zh-cn/guides/model-mixing.md"),
    };
    expect(docs.en).toContain("## Dashboard advanced settings");
    expect(docs.ko).toContain("## 대시보드 고급 설정");
    expect(docs.zh).toContain("## 仪表盘高级设置");
    for (const text of Object.values(docs)) {
      expect(text).toContain("`aliasId`");
      expect(text).toContain("`stageTimeoutMs`");
      expect(text).toContain("fusion.multiround");
    }
  });

  test("dispatch guidance carries the no-reasoning/math-to-mini rule in the profile and all locales", () => {
    const profile = JSON.parse(read("evals/fusion/profiles/r1-dispatch-mixed.json")) as { modelMixing: { guidance: string } };
    expect(profile.modelMixing.guidance).toContain("Never route reasoning, math, or multi-step logic to codex/gpt-5.4-mini");
    expect(profile.modelMixing.guidance).toContain("never the mini model");

    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");
    expect(en).toContain("never send reasoning/math to the mini model");
    expect(ko).toContain("추론·수학은 절대 mini에게 보내지 마세요");
    expect(zh).toContain("推理和数学绝不交给 mini");
  });

  test("model mixing settings loader classifies old-server, HTTP, network, and timeout failures", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "missing route" }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(fetchModelMixingSettings("http://gui.test/api/model-mixing-settings")).rejects.toMatchObject({
      name: "ModelMixingSettingsLoadError",
      kind: "old-server",
      status: 404,
      detail: "missing route",
    });

    globalThis.fetch = (async () => Response.json({ message: "maintenance" }, { status: 503 })) as typeof fetch;
    await expect(fetchModelMixingSettings("http://gui.test/api/model-mixing-settings")).rejects.toMatchObject({
      kind: "http",
      status: 503,
      detail: "maintenance",
    });

    globalThis.fetch = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
    await expect(fetchModelMixingSettings("http://gui.test/api/model-mixing-settings")).rejects.toMatchObject({
      kind: "network",
    });

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    await expect(fetchModelMixingSettings("http://gui.test/api/model-mixing-settings", 1)).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  test("server-rendered model mixing failure states explain recovery and retry", () => {
    Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });

    const cases: Array<{ failure: SettingsLoadFailure; snippets: string[] }> = [
      { failure: { kind: "old-server", status: 404, detail: "missing route" }, snippets: ["This proxy is too old for the Model Mixing page", "HTTP 404", "frogp refresh"] },
      { failure: { kind: "network" }, snippets: ["Could not reach the local proxy", "frogp status", "frogp refresh"] },
      { failure: { kind: "http", status: 503, detail: "maintenance" }, snippets: ["returned HTTP 503: maintenance", "frogp refresh"] },
      { failure: { kind: "timeout" }, snippets: ["timed out", "frogp status", "frogp refresh"] },
    ];

    for (const { failure, snippets } of cases) {
      const html = renderToString(createElement(
        LanguageProvider,
        null,
        createElement(ModelMixing, {
          apiBase: "http://gui.test",
          navigate: () => undefined,
          initialLoadFailure: failure,
        }),
      ));
      const visible = html.replace(/<!-- -->/g, "");

      for (const snippet of snippets) expect(visible).toContain(snippet);
      expect(visible).toContain("Retry");
      expect(new ModelMixingSettingsLoadError(failure).kind).toBe(failure.kind);
    }
  });

  test("server-rendered model mixing page uses sentinel settings without stale literals", async () => {
    const settings = sentinelSettings();
    const plan = { mode: "sentinel", calls: 42, searchCalls: 7, detail: "sentinel detail 42/7" };
    Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/model-mixing-settings")) return Response.json(settings);
      if (url.includes("/api/model-mixing/call-plan")) return Response.json({ ok: true, plan, warnings: [] });
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;
    const fetchedSettings = await (await fetch("http://gui.test/api/model-mixing-settings")).json();
    const fetchedPlan = (await (await fetch("http://gui.test/api/model-mixing/call-plan?draft=sentinel")).json() as { plan: typeof plan }).plan;

    const html = renderToString(createElement(
      LanguageProvider,
      null,
      createElement(ModelMixing, {
        apiBase: "http://gui.test",
        navigate: () => undefined,
        initialSettings: fetchedSettings,
        initialPlan: fetchedPlan,
      }),
    ));
    const visible = html.replace(/<!-- -->/g, "");

    expect(visible).toContain("per request: 42 answer calls · 7 searches");
    expect(visible).toContain("42 answer calls");
    expect(visible).toContain("7 search calls");
    // labeled number fields sit next to each input
    expect(visible).toContain("per answerer");
    expect(visible).toContain("combined total");
    expect(visible).toContain("drafts per round");
    expect(visible).toContain("whole step");
    // preset text falls back to the server description for unknown preset ids
    expect(visible).toContain("Sentinel preset");
    expect(visible).toContain("Sentinel preset description");
    // alias rename input is prefilled with the current alias id
    expect(visible).toContain(`value="alias-sentinel"`);
    expect(visible).toContain("Save name");

    for (const stale of ["F3", "0.1333", "11+3", "219457", "p95 219s", "+0.7770", "sentinel-x9", "quality delta", "p50 10s", "What our testing showed", "about 10 seconds"]) {
      expect(visible).not.toContain(stale);
    }
  });

  test("route mode shows dispatcher controls and hides fusion-only sections", () => {
    const settings = sentinelSettings() as ReturnType<typeof sentinelSettings> & { modelMixing: Record<string, unknown> };
    settings.modelMixing.combine = "route";
    settings.modelMixing.coordinator = { provider: "sentinel-provider", model: "sentinel-model" };
    settings.modelMixing.guidance = "simple to mini";
    Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });

    const html = renderToString(createElement(
      LanguageProvider,
      null,
      createElement(ModelMixing, {
        apiBase: "http://gui.test",
        navigate: () => undefined,
        initialSettings: settings as never,
        initialPlan: { mode: "route", calls: 2, searchCalls: 0, detail: "coordinator=1 routed=1" },
      }),
    ));
    const visible = html.replace(/<!-- -->/g, "");

    expect(visible).toContain("Dispatcher model");
    expect(visible).toContain("Dispatch rules");
    expect(visible).toContain("simple to mini");
    expect(visible).toContain("note (e.g. hard reasoning)");
    expect(visible).not.toContain("Judge and final answerer");
    expect(visible).not.toContain("What answerers see");
    expect(visible).not.toContain("Rewrite limits");
  });
});

function readinessSettings() {
  return {
    modelMixing: {
      enabled: false,
      aliasId: "alias-sentinel",
      combine: "route",
      coordinator: { provider: "codex", model: "gpt" },
      agents: [
        { provider: "codex", model: "gpt" },
        { provider: "anthropic", model: "claude" },
        { provider: "anthropic-grant", model: "claude" },
      ],
      fusion: {},
    },
    providers: [
      { name: "codex", defaultModel: "gpt", models: ["gpt"], authMode: "oauth", adapter: "openai-responses" },
      { name: "anthropic", defaultModel: "claude", models: ["claude"], authMode: "forward", adapter: "anthropic" },
      { name: "anthropic-grant", defaultModel: "claude", models: ["claude"], authMode: "key", adapter: "anthropic" },
    ],
    catalogAlias: { aliasId: "alias-sentinel", namespaced: true, provider: "frogprogsy", id: "model-mixing", exposed: true, disabled: false, hiddenPolicy: "alias-id-specific" as const },
    presets: [],
    evidence: { candidate: "c", baseline: "b", candidateLabel: "cl", baselineLabel: "bl", qualityDelta: 0.1, qualityDeltaCi95: [0, 0.2] as const, latencyWallClockMs: { p50: 1, p95: 2 } },
    warnings: [],
  };
}

function renderReadiness(grants: ClaudeGrantSummary[], planDetail = "coordinator=1 routed=2") {
  Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });
  const html = renderToString(createElement(
    LanguageProvider,
    null,
    createElement(ModelMixing, {
      apiBase: "http://gui.test",
      navigate: () => undefined,
      initialSettings: readinessSettings() as never,
      initialPlan: { mode: "route", calls: 3, searchCalls: 0, detail: planDetail },
      initialGrants: grants,
    }),
  ));
  return html.replace(/<!-- -->/g, "");
}

describe("model mixing provider readiness strip", () => {
  test("mixMemberReadiness classifies grant / oauth / forward / key / unknown members", () => {
    const grants: ClaudeGrantSummary[] = [
      { id: "cg_ok", label: "sub", state: "ok", boundProviders: ["anthropic-grant"], realClaudeReady: true },
      { id: "cg_bad", label: "old", state: "reauth_required", boundProviders: ["anthropic-stale"], realClaudeReady: true },
    ];
    const codex = { name: "codex", defaultModel: "m", models: ["m"], authMode: "oauth" as const, adapter: "openai-responses" };
    const fwd = { name: "anthropic", defaultModel: "m", models: ["m"], authMode: "forward" as const, adapter: "anthropic" };
    const key = { name: "kimi", defaultModel: "m", models: ["m"], authMode: "key" as const, adapter: "openai-chat" };

    // A grant binding wins over the provider's own authMode, and its usability drives blocking.
    expect(mixMemberReadiness("anthropic-grant", key, grants)).toMatchObject({ kind: "grant", needsAttention: false, blocking: false });
    expect(mixMemberReadiness("anthropic-stale", undefined, grants)).toMatchObject({ kind: "grant", needsAttention: true, blocking: true });
    expect(mixMemberReadiness("codex", codex, grants)).toMatchObject({ kind: "oauth", needsAttention: true, blocking: false });
    expect(mixMemberReadiness("anthropic", fwd, grants)).toMatchObject({ kind: "forward", needsAttention: true, blocking: false });
    expect(mixMemberReadiness("kimi", key, grants)).toMatchObject({ kind: "key", needsAttention: false });
    expect(mixMemberReadiness("ghost", undefined, grants)).toMatchObject({ kind: "unknown", needsAttention: true });
    // provider-side binding: authMode "claude-grant" resolves via claudeGrantId even when the
    // provider name is absent from any grant's boundProviders…
    const grantById = { name: "elsewhere", defaultModel: "m", models: ["m"], authMode: "claude-grant" as const, adapter: "anthropic", claudeGrantId: "cg_ok" };
    expect(mixMemberReadiness("elsewhere", grantById, grants)).toMatchObject({ kind: "grant", needsAttention: false, blocking: false });
    // …and a claude-grant provider whose grant is missing surfaces as a blocking grant member, not "unknown"
    const danglingById = { name: "solo", defaultModel: "m", models: ["m"], authMode: "claude-grant" as const, adapter: "anthropic", claudeGrantId: "cg_missing" };
    expect(mixMemberReadiness("solo", danglingById, [])).toMatchObject({ kind: "grant", needsAttention: true, blocking: true });
    const danglingNoId = { name: "solo2", defaultModel: "m", models: ["m"], authMode: "claude-grant" as const, adapter: "anthropic" };
    expect(mixMemberReadiness("solo2", danglingNoId, [])).toMatchObject({ kind: "grant", needsAttention: true, blocking: true });
  });

  test("server-rendered strip shows bindings, OAuth/forward caveats, and credential-isolation copy", () => {
    const visible = renderReadiness([
      { id: "cg_ok", label: "sub", state: "ok", boundProviders: ["anthropic-grant"], realClaudeReady: true },
    ]);
    expect(visible).toContain("Provider readiness");
    expect(visible).toContain("OAuth login required");
    expect(visible).toContain("Needs live client auth");
    expect(visible).toContain("Claude grant · sub · Ready");
    expect(visible).toContain("never mix");
    // warning lane appears for request-time auth members but does not block saving
    expect(visible).toContain("authenticate at request time");
    expect(visible).toContain("Saving stays allowed");
  });

  test("an unready bound grant surfaces a blocking hint while save rules stay server-owned", () => {
    const visible = renderReadiness([
      { id: "cg_bad", label: "stale", state: "reauth_required", boundProviders: ["anthropic-grant"], realClaudeReady: true },
    ]);
    expect(visible).toContain("the bound Claude grant is not ready");
    // still no secret fields anywhere on the page
    expect(visible).not.toContain('type="password"');
  });
});
