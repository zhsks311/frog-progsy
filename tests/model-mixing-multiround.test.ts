import { describe, expect, test } from "bun:test";
import type { AdapterEvent, FrogConfig, FrogMessage, FrogModelMixingConfig } from "../src/types";
import type { FrogParsedRequest } from "../src/types";
import { buildRefinePrompt, buildScorePrompt } from "../src/model-mixing/fusion";
import { computeCallPlan } from "../src/model-mixing/orchestrate";
import { runWithMixing } from "../src/model-mixing/loop";

type MultiroundConfig = NonNullable<NonNullable<FrogModelMixingConfig["fusion"]>["multiround"]>;

function cfg(multiround?: MultiroundConfig): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "codex",
    providers: {
      codex: { adapter: "openai-responses", baseUrl: "https://x/codex", defaultModel: "gpt-5.5" },
      anthropic: { adapter: "anthropic", baseUrl: "https://x/anthropic", defaultModel: "claude-opus" },
    },
    modelMixing: {
      enabled: true,
      combine: "fusion",
      coordinator: { provider: "codex", model: "gpt-5.5" },
      fusion: {
        panel: [
          { provider: "codex", model: "gpt-5.5" },
          { provider: "anthropic", model: "claude-opus" },
        ],
        judge: { provider: "codex", model: "gpt-5.5" },
        synthesizer: { provider: "anthropic", model: "claude-opus" },
        ...(multiround ? { multiround } : {}),
      },
    },
  };
}

function req(): FrogParsedRequest {
  return {
    modelId: "frogp/mix",
    stream: true,
    context: { messages: [{ role: "user", content: "solve hard problem", timestamp: 1 }] },
    options: {} as FrogParsedRequest["options"],
  };
}

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const judgeJson = (best = "codex/gpt-5.5") => JSON.stringify({
  consensus: [{ point: `BEST_CANDIDATE:${best}`, supportingModels: [best] }],
  contradictions: [],
  uniqueInsights: [],
  blindSpots: [],
  confidence: "high",
});

function promptText(messages: FrogMessage[]): string {
  return messages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
}

describe("fusion multiround prompt builders", () => {
  test("buildScorePrompt uses JudgeAnalysis-compatible JSON shape and BEST_CANDIDATE marker", () => {
    const text = buildScorePrompt("task", [{ label: "a", text: "answer" }])[0]!.content as string;
    expect(text).toContain("consensus");
    expect(text).toContain("contradictions");
    expect(text).toContain("BEST_CANDIDATE:<label>");
    expect(text).toContain("[a] answer");
  });

  test("buildRefinePrompt includes best candidate, critique, and diversity instruction", () => {
    const text = buildRefinePrompt(
      "task",
      { label: "a", text: "draft" },
      { consensus: [], contradictions: [], uniqueInsights: [], blindSpots: ["gap"], confidence: "low" },
      "try a different derivation",
    )[0]!.content as string;
    expect(text).toContain("CURRENT BEST CANDIDATE [a]:\ndraft");
    expect(text).toContain("gap");
    expect(text).toContain("try a different derivation");
  });
});

describe("runWithMixing multiround", () => {
  test("disabled multiround preserves fusion dispatch order and prompt bytes", async () => {
    async function run(config: FrogConfig) {
      const calls: string[] = [];
      const gen = await runWithMixing({
        config,
        parsed: req(),
        incomingHeaders: new Headers(),
        dispatchBuffered: async (target, messages): Promise<AdapterEvent[]> => {
          calls.push(`${target.provider}/${target.model}:${promptText(messages)}`);
          if (calls.length <= 2) return [{ type: "text_delta", text: `panel-${calls.length}` }, { type: "done" }];
          return [{ type: "text_delta", text: judgeJson() }, { type: "done" }];
        },
        dispatchFinalStream: async (_target, instruction) => (async function* () {
          calls.push(`final:${instruction}`);
          yield { type: "text_delta", text: "final" };
          yield { type: "done" };
        })(),
      });
      const events = await collect(gen);
      return { calls, events };
    }

    const base = await run(cfg());
    const disabled = await run(cfg({ enabled: false, maxRounds: 2, branchFactor: 2, budgetCalls: 12 }));
    expect(disabled.calls).toEqual(base.calls);
    expect(disabled.events).toEqual(base.events);
  });

  test("runs score then refine variants and synthesizes selected survivor", async () => {
    const calls: string[] = [];
    const gen = await runWithMixing({
      config: cfg({ enabled: true, maxRounds: 1, branchFactor: 2, budgetCalls: 8 }),
      parsed: req(),
      incomingHeaders: new Headers(),
      dispatchBuffered: async (target, messages): Promise<AdapterEvent[]> => {
        const text = promptText(messages);
        calls.push(text);
        if (text.includes("You are scoring")) return [{ type: "text_delta", text: judgeJson("anthropic/claude-opus") }, { type: "done" }];
        if (text.includes("You are refining")) return [{ type: "text_delta", text: `refined by ${target.provider}` }, { type: "done" }];
        if (text.includes("impartial analyst")) return [{ type: "text_delta", text: judgeJson("codex/gpt-5.5") }, { type: "done" }];
        return [{ type: "text_delta", text: `${target.provider}/${target.model} initial` }, { type: "done" }];
      },
      dispatchFinalStream: async (_target, instruction) => (async function* () {
        calls.push(`FINAL:${instruction}`);
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      })(),
    });

    const events = await collect(gen);
    const joined = calls.join("\n---\n");
    expect(calls.filter(c => c.includes("You are scoring"))).toHaveLength(1);
    expect(calls.filter(c => c.includes("You are refining"))).toHaveLength(2);
    expect(joined).toContain("CURRENT BEST CANDIDATE [anthropic/claude-opus]");
    expect(joined).toContain("[round1/refine1] refined by anthropic");
    expect(events.some(e => e.type === "thinking_delta" && e.thinking.includes("[round 1 score]"))).toBe(true);
    expect(events.some(e => e.type === "thinking_delta" && e.thinking.includes("[round 1 refine]"))).toBe(true);
  });

  test("budgetCalls excess aborts multiround loop loudly and falls back to current best synthesis", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      const calls: string[] = [];
      const gen = await runWithMixing({
        config: cfg({ enabled: true, maxRounds: 2, branchFactor: 2, budgetCalls: 4 }),
        parsed: req(),
        incomingHeaders: new Headers(),
        dispatchBuffered: async (_target, messages): Promise<AdapterEvent[]> => {
          const text = promptText(messages);
          calls.push(text);
          if (text.includes("impartial analyst")) return [{ type: "text_delta", text: judgeJson() }, { type: "done" }];
          if (text.includes("You are scoring") || text.includes("You are refining")) throw new Error("budget should prevent this call");
          return [{ type: "text_delta", text: "panel" }, { type: "done" }];
        },
        dispatchFinalStream: async () => (async function* () {
          yield { type: "text_delta", text: "final" };
          yield { type: "done" };
        })(),
      });
      const events = await collect(gen);
      expect(calls.some(c => c.includes("You are scoring"))).toBe(false);
      expect(calls.some(c => c.includes("You are refining"))).toBe(false);
      expect(events.some(e => e.type === "text_delta" && e.text === "final")).toBe(true);
      expect(errors.some(e => e.includes("multiround budgetCalls exceeded before round 1"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("respects maxRounds", async () => {
    const calls: string[] = [];
    const gen = await runWithMixing({
      config: cfg({ enabled: true, maxRounds: 2, branchFactor: 1, budgetCalls: 10 }),
      parsed: req(),
      incomingHeaders: new Headers(),
      dispatchBuffered: async (_target, messages): Promise<AdapterEvent[]> => {
        const text = promptText(messages);
        calls.push(text);
        if (text.includes("You are scoring")) return [{ type: "text_delta", text: judgeJson() }, { type: "done" }];
        if (text.includes("You are refining")) return [{ type: "text_delta", text: "refined" }, { type: "done" }];
        if (text.includes("impartial analyst")) return [{ type: "text_delta", text: judgeJson() }, { type: "done" }];
        return [{ type: "text_delta", text: "panel" }, { type: "done" }];
      },
      dispatchFinalStream: async () => (async function* () {
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      })(),
    });
    await collect(gen);
    expect(calls.filter(c => c.includes("You are scoring"))).toHaveLength(2);
    expect(calls.filter(c => c.includes("You are refining"))).toHaveLength(2);
  });

  test("computeCallPlan reports multiround answer calls under budget and search calls separately", () => {
    const config = cfg({ enabled: true, maxRounds: 2, branchFactor: 2, budgetCalls: 7 });
    config.modelMixing!.fusion!.panelWebSearch = { enabled: true, maxSearchesPerPanel: 3, maxTotalSearches: 4, tiers: ["no_key"] };

    const plan = computeCallPlan(config);

    expect(plan.mode).toBe("fusion");
    expect(plan.calls).toBe(7);
    expect(plan.searchCalls).toBe(4);
    expect(plan.detail).toContain("generate=2");
    expect(plan.detail).toContain("score=2");
    expect(plan.detail).toContain("refine=4");
    expect(plan.detail).toContain("synthesize=1");
    expect(plan.detail).toContain("searchCalls=4");
    expect(plan.detail).toContain("maxTotalSearches=4");
    expect(plan.detail).toContain("budgetCalls=7");
    expect(plan.detail).toContain("worstCaseAnswerCalls=10");
  });

  test("computeCallPlan does not spend multiround budgetCalls on search calls", () => {
    const config = cfg({ enabled: true, maxRounds: 2, branchFactor: 2, budgetCalls: 3 });
    config.modelMixing!.fusion!.panelWebSearch = { enabled: true, maxSearchesPerPanel: 3, maxTotalSearches: 4, tiers: ["no_key"] };

    const plan = computeCallPlan(config);

    expect(plan.calls).toBe(3);
    expect(plan.searchCalls).toBe(4);
    expect(plan.detail).toContain("budgetCalls=3");
    expect(plan.detail).toContain("searchCalls=4");
  });
});
