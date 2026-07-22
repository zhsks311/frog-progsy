import { describe, expect, test } from "bun:test";
import type { AdapterEvent, FrogConfig } from "../src/types";
import type { FrogParsedRequest } from "../src/types";
import {
  buildJudgePrompt,
  buildPanelPrompt,
  buildSynthesisPrompt,
  parseJudgeAnalysis,
  resolveFusionPlan,
  type JudgeAnalysis,
} from "../src/model-mixing/fusion";
import { scanEventsForMix } from "../src/model-mixing/scan";
import { computeCallPlan } from "../src/model-mixing/orchestrate";
import { buildStagePrompt, buildVerifierInstruction, resolvePipelineStages } from "../src/model-mixing/pipeline";
import { resolveRulesTarget } from "../src/model-mixing/rules";
import { resolveMix } from "../src/model-mixing";
import { runWithMixing } from "../src/model-mixing/loop";


function cfg(overrides?: Partial<FrogConfig["modelMixing"]>): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "codex",
    providers: {
      codex: { adapter: "openai-responses", baseUrl: "https://x/codex", defaultModel: "gpt-5.5" },
      anthropic: { adapter: "anthropic", baseUrl: "https://x/anthropic", defaultModel: "claude-opus" },
    },
    modelMixing: {
      enabled: true,
      coordinator: { provider: "codex", model: "gpt-5.4-mini" },
      guidance: "Coding -> opus. Chat -> mini.",
      agents: [
        { provider: "codex", model: "gpt-5.4-mini", tasks: ["chat"], difficulty: ["easy"] },
        { provider: "anthropic", model: "claude-opus", tasks: ["coding"], difficulty: ["hard"] },
      ],
      ...overrides,
    },
  };
}

const fullAnalysis: JudgeAnalysis = {
  consensus: [{ point: "both agree X", supportingModels: ["p1/m1", "p2/m2"] }],
  contradictions: [{ topic: "Y", positions: [{ model: "p1/m1", claim: "a" }] }],
  uniqueInsights: [{ model: "p2/m2", insight: "Z" }],
  blindSpots: ["edge case"],
  confidence: "high",
};

describe("resolveFusionPlan", () => {
  test("panel from config.modelMixing.fusion.panel preserves order", () => {
    const c = cfg({
      fusion: {
        panel: [
          { provider: "anthropic", model: "claude-opus" },
          { provider: "codex", model: "gpt-5.4-mini" },
        ],
      },
    });
    const plan = resolveFusionPlan(c);
    expect(plan.panel).toHaveLength(2);
    expect(plan.panel[0]).toEqual({ provider: "anthropic", model: "claude-opus" });
    expect(plan.panel[1]).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
  });

  test("panel omitted falls back to validMixAgents(config)", () => {
    const c = cfg();
    const plan = resolveFusionPlan(c);
    expect(plan.panel).toHaveLength(2);
    expect(plan.panel[0]).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    expect(plan.panel[1]).toEqual({ provider: "anthropic", model: "claude-opus" });
  });

  test("panel entry with an unconfigured provider is dropped with a warning", () => {
    const c = cfg({
      fusion: {
        panel: [
          { provider: "codex", model: "gpt-5.4-mini" },
          { provider: "ghost", model: "nope" },
        ],
      },
    });
    const plan = resolveFusionPlan(c);
    expect(plan.panel).toHaveLength(1);
    expect(plan.panel[0]).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    expect(plan.warnings.some(w => w.includes("ghost/nope") && w.includes("unconfigured"))).toBe(true);
  });

  test("panel of >8 entries is truncated to 8 with a warning", () => {
    const panel = Array.from({ length: 10 }, (_, i) => ({
      provider: i % 2 === 0 ? "codex" : "anthropic",
      model: i % 2 === 0 ? "gpt-5.4-mini" : "claude-opus",
    }));
    const c = cfg({ fusion: { panel } });
    const plan = resolveFusionPlan(c);
    expect(plan.panel).toHaveLength(8);
    expect(plan.warnings.some(w => w.includes("truncated from 10 to 8"))).toBe(true);
  });

  test("judge/synthesizer omitted default to coordinator", () => {
    const c = cfg();
    const plan = resolveFusionPlan(c);
    expect(plan.judge).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    expect(plan.synthesizer).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
  });
});

describe("parseJudgeAnalysis", () => {
  test("valid full JSON returns typed object with preserved values", () => {
    const result = parseJudgeAnalysis(JSON.stringify(fullAnalysis));
    expect(result).not.toBeNull();
    expect(Array.isArray(result!.consensus)).toBe(true);
    expect(Array.isArray(result!.contradictions)).toBe(true);
    expect(Array.isArray(result!.uniqueInsights)).toBe(true);
    expect(Array.isArray(result!.blindSpots)).toBe(true);
    expect(result!.confidence).toBe("high");
    expect(result!.consensus[0]!.point).toBe("both agree X");
    expect(result!.blindSpots).toEqual(["edge case"]);
  });

  test("fenced ```json wrapper is parsed", () => {
    const text = "```json\n" + JSON.stringify(fullAnalysis) + "\n```";
    const result = parseJudgeAnalysis(text);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
  });

  test("prose-wrapped JSON is parsed via brace-match", () => {
    const text = `Sure, here is my analysis:\n${JSON.stringify(fullAnalysis)}\nHope that helps!`;
    const result = parseJudgeAnalysis(text);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
  });

  test("missing confidence key returns null", () => {
    const { confidence, ...rest } = fullAnalysis;
    const result = parseJudgeAnalysis(JSON.stringify(rest));
    expect(result).toBeNull();
  });

  test("consensus not an array (top-level shape invalid) returns null", () => {
    const bad = { ...fullAnalysis, consensus: "not an array" };
    const result = parseJudgeAnalysis(JSON.stringify(bad));
    expect(result).toBeNull();
  });

  test("confidence with a bad enum value returns null", () => {
    const bad = { ...fullAnalysis, confidence: "maybe" };
    const result = parseJudgeAnalysis(JSON.stringify(bad));
    expect(result).toBeNull();
  });

  test("wrong-typed nested subfield is coerced, not rejected", () => {
    const bad = {
      ...fullAnalysis,
      consensus: [{ point: "X", supportingModels: "p1/m1" }],
    };
    const result = parseJudgeAnalysis(JSON.stringify(bad));
    expect(result).not.toBeNull();
    expect(result!.consensus).toHaveLength(1);
    expect(Array.isArray(result!.consensus[0]!.supportingModels)).toBe(true);
    expect(result!.consensus[0]!.supportingModels).toEqual([]);
  });

  test("empty arrays for all four list keys with valid confidence is valid", () => {
    const minimal = {
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      confidence: "low",
    };
    const result = parseJudgeAnalysis(JSON.stringify(minimal));
    expect(result).not.toBeNull();
    expect(result).toEqual(minimal as JudgeAnalysis);
  });
});

describe("fusion context prompts", () => {
  test("task/default panel and judge prompts remain byte-identical fixtures", () => {
    const panel = buildPanelPrompt("summarize the repo", "Use concise bullets.")[0]!.content;
    expect(panel).toBe(
      [
        "You are one of several independent models answering the same task. Answer directly and completely;",
        "you will not see the other answers. Do not mention that you are part of a panel.",
        "",
        "GUIDANCE:",
        "Use concise bullets.",
        "",
        "TASK:",
        "summarize the repo",
      ].join("\n"),
    );

    const judge = buildJudgePrompt("summarize the repo", [
      { label: "p1/m1", text: "a" },
      { label: "p2/m2", text: "b" },
    ])[0]!.content;
    expect(judge).toBe(
      [
        "You are an impartial analyst comparing N independent model answers to the SAME task.",
        "Produce ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys:",
        "{",
        '  "consensus": [{"point": string, "supportingModels": [modelLabel,...]}],',
        '  "contradictions": [{"topic": string, "positions": [{"model": modelLabel, "claim": string}]}],',
        '  "uniqueInsights": [{"model": modelLabel, "insight": string}],',
        '  "blindSpots": [string],',
        '  "confidence": "low" | "medium" | "high"',
        "}",
        'Rules: cite panel answers by their given label (e.g. "p1/m1"). consensus = points >=2 answers agree on.',
        "contradictions = points where answers directly conflict. uniqueInsights = correct/valuable points only one",
        "answer raised. blindSpots = important aspects of the TASK that NO answer addressed. confidence = your overall",
        "confidence that a correct synthesized answer is derivable from these answers. Output JSON ONLY.",
        "",
        "TASK:",
        "summarize the repo",
        "",
        "PANEL ANSWERS:",
        "[p1/m1] a",
        "[p2/m2] b",
      ].join("\n"),
    );
  });

  test("full panel prompt includes system prompt and full history without client tool definitions", () => {
    const messages = buildPanelPrompt("current task", undefined, {
      contextMode: "full",
      context: {
        systemPrompt: ["System says preserve context."],
        messages: [
          { role: "user", content: "old user turn", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "old assistant turn" }], timestamp: 2 },
          { role: "user", content: "current task", timestamp: 3 },
        ],
        tools: [{ name: "bash", description: "Bash tool desc", parameters: {} }],
      },
    });
    const text = messages[0]!.content as string;
    expect(text).toContain("FULL CONTEXT:");
    expect(text).toContain("System says preserve context.");
    expect(text).toContain("--- message 1: user ---");
    expect(text).toContain("old assistant turn");
    expect(text).toContain("CURRENT TASK:\ncurrent task");
    expect(text).toContain("Client tools are intentionally not available");
    expect(text).not.toContain("Bash tool desc");
  });

  test("judge full prompt includes full context and panel answers", () => {
    const messages = buildJudgePrompt(
      "current task",
      [{ label: "p1/m1", text: "panel answer" }],
      {
        contextMode: "full",
        context: {
          systemPrompt: ["System judge context."],
          messages: [{ role: "user", content: "prior request", timestamp: 1 }],
          tools: [{ name: "edit", description: "Edit tool desc", parameters: {} }],
        },
      },
    );
    const text = messages[0]!.content as string;
    expect(text).toContain("System judge context.");
    expect(text).toContain("prior request");
    expect(text).toContain("CURRENT TASK:\ncurrent task");
    expect(text).toContain("[p1/m1] panel answer");
    expect(text).not.toContain("Edit tool desc");
  });

  test("runWithMixing applies panel contextMode but leaves judgeContextMode independently task by default", async () => {
    const c = cfg({
      combine: "fusion",
      fusion: {
        panel: [{ provider: "codex", model: "gpt-5.4-mini" }],
        contextMode: "full",
      },
      surfaceStages: false,
    });
    const parsed: FrogParsedRequest = {
      modelId: "frogp/mix",
      stream: true,
      context: {
        systemPrompt: ["System available to full-context panel."],
        messages: [
          { role: "user", content: "old turn", timestamp: 1 },
          { role: "user", content: "current task", timestamp: 2 },
        ],
        tools: [{ name: "bash", description: "Bash tool desc", parameters: {} }],
      },
      options: {} as FrogParsedRequest["options"],
    };
    const captured: string[] = [];
    const gen = await runWithMixing({
      config: c,
      parsed,
      incomingHeaders: new Headers(),
      dispatchBuffered: async (_target, messages): Promise<AdapterEvent[]> => {
        captured.push(messages.map(m => m.content).join("\n"));
        if (captured.length === 1) return [{ type: "text_delta", text: "panel answer" }, { type: "done" }];
        return [{ type: "text_delta", text: JSON.stringify(fullAnalysis) }, { type: "done" }];
      },
      dispatchFinalStream: async function* (): AsyncGenerator<AdapterEvent> {
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
    });
    for await (const _event of gen) {
      // consume generator
    }
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("System available to full-context panel.");
    expect(captured[0]).toContain("old turn");
    expect(captured[0]).not.toContain("Bash tool desc");
    expect(captured[1]).toContain("TASK:\ncurrent task");
    expect(captured[1]).not.toContain("FULL CONTEXT:");
    expect(captured[1]).not.toContain("System available to full-context panel.");
  });
});

describe("buildJudgePrompt", () => {
  test("contains both labels, task text, and a JSON-only instruction", () => {
    const messages = buildJudgePrompt("summarize the repo", [
      { label: "p1/m1", text: "a" },
      { label: "p2/m2", text: "b" },
    ]);
    expect(messages).toHaveLength(1);
    const text = messages[0]!.content as string;
    expect(text).toContain("p1/m1");
    expect(text).toContain("p2/m2");
    expect(text).toContain("summarize the repo");
    expect(text).toContain("consensus");
    expect(text).toContain("blindSpots");
    expect(text).toContain("JSON");
  });
});

describe("buildSynthesisPrompt", () => {
  test("contains the rendered analysis, panel answers, and a do-not-summarize instruction", () => {
    const panelAnswers = [
      { label: "p1/m1", text: "answer one" },
      { label: "p2/m2", text: "answer two" },
    ];
    const { instruction } = buildSynthesisPrompt(fullAnalysis, panelAnswers);
    expect(instruction).toContain("both agree X");
    expect(instruction).toContain("[p1/m1] answer one");
    expect(instruction).toContain("[p2/m2] answer two");
    expect(instruction).toContain("Do NOT describe or summarize the panel or the analysis.");
  });

  test("analysis=null path still contains the raw panel answers", () => {
    const panelAnswers = [{ label: "p1/m1", text: "answer one" }];
    const { instruction } = buildSynthesisPrompt(null, panelAnswers);
    expect(instruction).toContain("[p1/m1] answer one");
    expect(instruction).toContain("ANALYSIS: (unavailable");
  });
});

describe("scanEventsForMix", () => {
  test("text_delta + done only: forwarded equals input, hasRealToolCall false", () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "text_delta", text: " there" },
      { type: "done" },
    ];
    const { forwarded, hasRealToolCall } = scanEventsForMix(events);
    expect(forwarded).toEqual(events);
    expect(hasRealToolCall).toBe(false);
  });

  test("tool_call_start/delta/end: hasRealToolCall true, order preserved", () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "pre" },
      { type: "tool_call_start", id: "1", name: "bash" },
      { type: "tool_call_delta", arguments: '{"cmd":"ls"}' },
      { type: "tool_call_end" },
      { type: "text_delta", text: "post" },
      { type: "done" },
    ];
    const { forwarded, hasRealToolCall } = scanEventsForMix(events);
    expect(forwarded).toEqual(events);
    expect(hasRealToolCall).toBe(true);
  });
});

describe("computeCallPlan", () => {
  test("combine route with coordinator mode -> 2 calls", () => {
    const c = cfg({ combine: "route" });
    const plan = computeCallPlan(c);
    expect(plan.mode).toBe("route");
    expect(plan.calls).toBe(2);
  });

  test("mode rules -> 1 call", () => {
    const c = cfg({ combine: "route", mode: "rules" });
    const plan = computeCallPlan(c);
    expect(plan.mode).toBe("route");
    expect(plan.calls).toBe(1);
  });

  test("combine fusion with panel length 3 -> 5 calls", () => {
    const c = cfg({
      combine: "fusion",
      fusion: {
        panel: [
          { provider: "codex", model: "gpt-5.4-mini" },
          { provider: "anthropic", model: "claude-opus" },
          { provider: "codex", model: "gpt-5.5" },
        ],
      },
    });
    const plan = computeCallPlan(c);
    expect(plan.mode).toBe("fusion");
    expect(plan.calls).toBe(5);
  });

  test("combine pipeline with a 3-role pipeline[] -> 3 calls", () => {
    const c = cfg({
      combine: "pipeline",
      pipeline: [
        { role: "thinker", provider: "codex", model: "gpt-5.4-mini" },
        { role: "worker", provider: "anthropic", model: "claude-opus" },
        { role: "verifier", provider: "codex", model: "gpt-5.5" },
      ],
    });
    const plan = computeCallPlan(c);
    expect(plan.mode).toBe("pipeline");
    expect(plan.calls).toBe(3);
  });
});

describe("pipeline", () => {
  describe("resolvePipelineStages", () => {
    test("explicit pipeline resolves stages in order with no warnings", () => {
      const c = cfg({
        pipeline: [
          { role: "thinker", provider: "codex", model: "gpt-5.5" },
          { role: "worker", provider: "codex", model: "gpt-5.5" },
          { role: "verifier", provider: "anthropic", model: "claude-opus" },
        ],
      });
      const { stages, warnings } = resolvePipelineStages(c);
      expect(stages.length).toBe(3);
      expect(stages.map(s => s.role)).toEqual(["thinker", "worker", "verifier"]);
      expect(warnings).toEqual([]);
    });

    test("drops explicit stage with unconfigured provider and warns", () => {
      const c = cfg({
        pipeline: [
          { role: "thinker", provider: "ghost", model: "gpt-5.5" },
          { role: "worker", provider: "codex", model: "gpt-5.5" },
        ],
      });
      const { stages, warnings } = resolvePipelineStages(c);
      expect(stages.map(s => s.role)).toEqual(["worker"]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("thinker/ghost/gpt-5.5");
      expect(warnings[0]).toContain("unconfigured");
    });

    test("dedupes duplicate role (first kept) and caps at 3 stages", () => {
      const c = cfg({
        pipeline: [
          { role: "thinker", provider: "codex", model: "gpt-5.5" },
          { role: "thinker", provider: "anthropic", model: "claude-opus" },
          { role: "worker", provider: "codex", model: "gpt-5.5" },
          { role: "verifier", provider: "anthropic", model: "claude-opus" },
          { role: "verifier", provider: "codex", model: "gpt-5.5" },
        ],
      });
      const { stages, warnings } = resolvePipelineStages(c);
      expect(stages.length).toBe(3);
      expect(stages.map(s => s.role)).toEqual(["thinker", "worker", "verifier"]);
      expect(stages[0].provider).toBe("codex");
      expect(warnings.some(w => w.includes("role thinker duplicated"))).toBe(true);
    });

    test("infers stages from agents[].role when no explicit pipeline is set, skipping unmatched roles", () => {
      const c = cfg({
        agents: [
          { provider: "codex", model: "gpt-5.5", role: "thinker" },
          { provider: "anthropic", model: "claude-opus", role: "verifier" },
        ],
      });
      const { stages, warnings } = resolvePipelineStages(c);
      expect(stages.map(s => s.role)).toEqual(["thinker", "verifier"]);
      expect(stages[0]).toEqual({ role: "thinker", provider: "codex", model: "gpt-5.5" });
      expect(stages[1]).toEqual({ role: "verifier", provider: "anthropic", model: "claude-opus" });
      expect(warnings).toEqual([]);
    });

    test("no resolvable stages yields empty stages and a fallback warning", () => {
      const c = cfg({
        pipeline: [],
        agents: [{ provider: "codex", model: "gpt-5.5", tasks: ["chat"], difficulty: ["easy"] }],
      });
      const { stages, warnings } = resolvePipelineStages(c);
      expect(stages).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("no pipeline stages resolved");
    });
  });

  describe("buildStagePrompt", () => {
    test("worker prompt includes task text, prior thinker output, and worker instruction", () => {
      const msgs = buildStagePrompt("worker", "do X", [{ role: "thinker", text: "plan" }], "guide");
      expect(msgs.length).toBe(1);
      expect(msgs[0].role).toBe("user");
      const text = msgs[0].content as string;
      expect(text).toContain("do X");
      expect(text).toContain("[thinker] plan");
      expect(text).toContain("WORKER stage of a multi-model pipeline");
      expect(text).toContain("GUIDANCE:");
      expect(text).toContain("guide");
    });

    test("thinker prompt with no prior stages omits the prior-output section", () => {
      const msgs = buildStagePrompt("thinker", "do Y", []);
      const text = msgs[0].content as string;
      expect(text).toContain("do Y");
      expect(text).toContain("THINKER stage of a multi-model pipeline");
      expect(text).not.toContain("PRIOR STAGE OUTPUT:");
      expect(text).not.toContain("GUIDANCE:");
    });
  });

  describe("buildVerifierInstruction", () => {
    test("includes both prior stage outputs and a review/finalize instruction", () => {
      const instruction = buildVerifierInstruction([
        { role: "thinker", text: "a" },
        { role: "worker", text: "b" },
      ]);
      expect(instruction).toContain("[thinker] a");
      expect(instruction).toContain("[worker] b");
      expect(instruction).toContain("Review the following draft work and produce the final, corrected answer");
      expect(instruction).toContain("do not narrate the review");
    });
  });
});

function req(userText: string): FrogParsedRequest {
  return {
    modelId: "frogp/mix",
    stream: false,
    context: { messages: [{ role: "user", content: userText, timestamp: 1 }] },
    options: {} as FrogParsedRequest["options"],
  };
}

describe("rules mode", () => {
  test("keyword match picks that rule's target", () => {
    const c = cfg({
      mode: "rules",
      rules: [
        { match: { taskKeywords: ["refactor"] }, provider: "anthropic", model: "claude-opus" },
        { match: { taskKeywords: ["chat"] }, provider: "codex", model: "gpt-5.4-mini" },
      ],
    });
    const r = resolveRulesTarget(c, req("please refactor this module"));
    expect(r).toEqual({ target: { provider: "anthropic", model: "claude-opus" }, source: "coordinator" });
  });

  test("difficulty+keyword AND: matches only when both substrings present", () => {
    const c = cfg({
      mode: "rules",
      rules: [{ match: { taskKeywords: ["bug"], difficulty: "hard" }, provider: "anthropic", model: "claude-opus" }],
    });
    const missingDifficulty = resolveRulesTarget(c, req("fix this bug"));
    expect(missingDifficulty.source).toBe("fallback");
    const missingKeyword = resolveRulesTarget(c, req("this is a hard task"));
    expect(missingKeyword.source).toBe("fallback");
    const both = resolveRulesTarget(c, req("fix this hard bug"));
    expect(both).toEqual({ target: { provider: "anthropic", model: "claude-opus" }, source: "coordinator" });
  });

  test("hint substring match", () => {
    const c = cfg({
      mode: "rules",
      rules: [{ match: { hint: "use opus" }, provider: "anthropic", model: "claude-opus" }],
    });
    const r = resolveRulesTarget(c, req("please use opus for this one"));
    expect(r).toEqual({ target: { provider: "anthropic", model: "claude-opus" }, source: "coordinator" });
  });

  test("first-match-wins when two rules could match", () => {
    const c = cfg({
      mode: "rules",
      rules: [
        { match: { taskKeywords: ["bug"] }, provider: "codex", model: "gpt-5.4-mini" },
        { match: { taskKeywords: ["bug"] }, provider: "anthropic", model: "claude-opus" },
      ],
    });
    const r = resolveRulesTarget(c, req("fix this bug"));
    expect(r).toEqual({ target: { provider: "codex", model: "gpt-5.4-mini" }, source: "coordinator" });
  });

  test("matching rule with unconfigured provider is skipped and falls through", () => {
    const c = cfg({
      mode: "rules",
      rules: [
        { match: { taskKeywords: ["bug"] }, provider: "ghost", model: "ghost-model" },
        { match: { taskKeywords: ["bug"] }, provider: "anthropic", model: "claude-opus" },
      ],
    });
    const r = resolveRulesTarget(c, req("fix this bug"));
    expect(r).toEqual({ target: { provider: "anthropic", model: "claude-opus" }, source: "coordinator" });
  });

  test("no match falls back to first validMixAgents with a warning", () => {
    const c = cfg({
      mode: "rules",
      rules: [{ match: { taskKeywords: ["nonexistent-keyword"] }, provider: "anthropic", model: "claude-opus" }],
    });
    const r = resolveRulesTarget(c, req("totally unrelated task"));
    expect(r.source).toBe("fallback");
    expect(r.target).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    expect(r.warning).toContain("no rules matched task");
  });

  test("absent/empty match object acts as a catch-all default", () => {
    const c = cfg({
      mode: "rules",
      rules: [
        { match: { taskKeywords: ["bug"] }, provider: "codex", model: "gpt-5.4-mini" },
        { provider: "anthropic", model: "claude-opus" },
      ],
    });
    const r = resolveRulesTarget(c, req("totally unrelated task"));
    expect(r).toEqual({ target: { provider: "anthropic", model: "claude-opus" }, source: "coordinator" });

    const c2 = cfg({
      mode: "rules",
      rules: [{ match: {}, provider: "anthropic", model: "claude-opus" }],
    });
    const r2 = resolveRulesTarget(c2, req("anything at all"));
    expect(r2).toEqual({ target: { provider: "anthropic", model: "claude-opus" }, source: "coordinator" });
  });

  test("resolveMix short-circuits on mode:'rules' without invoking the coordinator complete callback", async () => {
    const c = cfg({
      mode: "rules",
      rules: [{ match: { taskKeywords: ["bug"] }, provider: "anthropic", model: "claude-opus" }],
    });
    const complete = () => {
      throw new Error("complete should not be called in rules mode");
    };
    const r = await resolveMix(c, req("fix this bug"), complete);
    expect(r).toEqual({ target: { provider: "anthropic", model: "claude-opus" }, source: "coordinator" });
  });
});
