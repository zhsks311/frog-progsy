import { describe, expect, test } from "bun:test";
import type { AdapterEvent, FrogConfig, FrogParsedRequest, FrogTool } from "../src/types";
import type { MixTarget } from "../src/model-mixing";
import { runWithMixing } from "../src/model-mixing/loop";


let searchQueries: string[] = [];

const executeSearchEvidenceStub: Parameters<typeof runWithMixing>[0]["executeSearchEvidence"] = async opts => {
  searchQueries.push(opts.query);
  return {
    text: `evidence:${opts.query}`,
    sources: [{ url: `https://example.test/${encodeURIComponent(opts.query)}`, title: opts.query }],
    evidence: { coverage: "answer_with_sources", sourceCount: 1, citationCount: 1 },
    tier: "no_key",
    skippedReasonCodes: [],
    latencyMs: 1,
  };
};

function cfg(fusion: NonNullable<NonNullable<FrogConfig["modelMixing"]>["fusion"]> = {}): FrogConfig {
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
      coordinator: { provider: "codex", model: "gpt-5.4-mini" },
      agents: [
        { provider: "codex", model: "gpt-5.4-mini" },
        { provider: "anthropic", model: "claude-opus" },
      ],
      fusion: {
        panel: [
          { provider: "codex", model: "gpt-5.4-mini" },
          { provider: "anthropic", model: "claude-opus" },
        ],
        ...fusion,
      },
      surfaceStages: false,
    },
  };
}

function req(): FrogParsedRequest {
  return {
    modelId: "frogp/mix",
    stream: true,
    context: {
      messages: [{ role: "user", content: "what changed today?", timestamp: 1 }],
      tools: [{ name: "bash", description: "real client tool", parameters: {} }],
    },
    options: {} as FrogParsedRequest["options"],
  };
}

async function consume(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const judgeAnalysis = JSON.stringify({ consensus: [], contradictions: [], uniqueInsights: [], blindSpots: [], confidence: "medium" });

function toolUse(id: string, query: string): AdapterEvent[] {
  return [
    { type: "tool_call_start", id, name: "web_search" },
    { type: "tool_call_delta", arguments: JSON.stringify({ query }) },
    { type: "tool_call_end" },
    { type: "done" },
  ];
}

describe("fusion panel synthetic web_search", () => {
  test("disabled panelWebSearch is byte-equivalent to absent config for buffered panel dispatch", async () => {
    async function capture(config: FrogConfig) {
      const calls: { target: MixTarget; body: string; tools: FrogTool[] | undefined }[] = [];
      const gen = await runWithMixing({
        config,
        parsed: req(),
        incomingHeaders: new Headers(),
        dispatchBuffered: async (target, messages, _max, _timeout, tools) => {
          calls.push({ target, body: JSON.stringify(messages).replace(/"timestamp":\d+/g, '"timestamp":0'), tools });
          return calls.length <= 2
            ? [{ type: "text_delta", text: `panel-${calls.length}` }, { type: "done" }]
            : [{ type: "text_delta", text: judgeAnalysis }, { type: "done" }];
        },
        dispatchFinalStream: async function* () {
          yield { type: "text_delta", text: "final" };
          yield { type: "done" };
        },
      });
      await consume(gen);
      return calls.slice(0, 2);
    }

    const absent = await capture(cfg());
    const disabled = await capture(cfg({ panelWebSearch: { enabled: false, maxSearchesPerPanel: 9, maxTotalSearches: 9 } }));
    expect(disabled).toEqual(absent);
  });

  test("warns loudly when unsupported panelWebSearch tiers are removed", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      const gen = await runWithMixing({
        config: cfg({ panelWebSearch: { enabled: true, maxSearchesPerPanel: 0, maxTotalSearches: 0, tiers: ["no_key", "bogus"] as NonNullable<NonNullable<FrogConfig["modelMixing"]>["fusion"]>["panelWebSearch"]["tiers"] } }),
        parsed: req(),
        incomingHeaders: new Headers(),
        dispatchBuffered: async (): Promise<AdapterEvent[]> => [{ type: "text_delta", text: "panel" }, { type: "done" }],
        dispatchFinalStream: async function* () {
          yield { type: "text_delta", text: "final" };
          yield { type: "done" };
        },
      });

      await consume(gen);

      expect(errors.some(e => e.includes("panelWebSearch.tiers removed unsupported tier(s): bogus"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("detects web_search tool_use, injects toolResult, and redispatches the panel member", async () => {
    searchQueries = [];
    const panelCalls: { messages: unknown; tools: FrogTool[] | undefined }[] = [];
    const gen = await runWithMixing({
      config: cfg({ panel: [{ provider: "codex", model: "gpt-5.4-mini" }], panelWebSearch: { enabled: true, maxSearchesPerPanel: 1, maxTotalSearches: 1, tiers: ["no_key"] } }),
      parsed: req(),
      incomingHeaders: new Headers(),
      executeSearchEvidence: executeSearchEvidenceStub,
      dispatchBuffered: async (_target, messages, _max, _timeout, tools) => {
        panelCalls.push({ messages, tools });
        if (panelCalls.length === 1) return toolUse("search-1", "latest bun release");
        if (panelCalls.length === 2) return [{ type: "text_delta", text: "panel answer after evidence" }, { type: "done" }];
        return [{ type: "text_delta", text: judgeAnalysis }, { type: "done" }];
      },
      dispatchFinalStream: async function* () {
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
    });

    await consume(gen);
    expect(searchQueries).toEqual(["latest bun release"]);
    expect(panelCalls[0]!.tools?.map(t => t.name)).toEqual(["web_search"]);
    expect(JSON.stringify(panelCalls[1]!.messages)).toContain("evidence:latest bun release");
  });

  test("caps total search executions and short-circuits over-budget panel calls", async () => {
    searchQueries = [];
    const redispatchBodies: string[] = [];
    const gen = await runWithMixing({
      config: cfg({ panelWebSearch: { enabled: true, maxSearchesPerPanel: 1, maxTotalSearches: 1, tiers: ["no_key"] } }),
      parsed: req(),
      incomingHeaders: new Headers(),
      executeSearchEvidence: executeSearchEvidenceStub,
      dispatchBuffered: async (target, messages) => {
        const isRedispatch = messages.some(m => m.role === "toolResult");
        if (isRedispatch) {
          redispatchBodies.push(JSON.stringify(messages));
          return [{ type: "text_delta", text: `answer ${target.provider}` }, { type: "done" }];
        }
        if (target.provider === "codex") return toolUse("search-a", "query A");
        if (target.provider === "anthropic") return toolUse("search-b", "query B");
        return [{ type: "text_delta", text: judgeAnalysis }, { type: "done" }];
      },
      dispatchFinalStream: async function* () {
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
    });

    await consume(gen);
    expect(searchQueries).toHaveLength(1);
    expect(redispatchBodies.join("\n")).toContain("max_total_searches_exceeded");
  });

  test("real client tools never reach panel/judge and synthetic web_search never reaches output events", async () => {
    searchQueries = [];
    const bufferedTools: (FrogTool[] | undefined)[] = [];
    const config = cfg({ panel: [{ provider: "codex", model: "gpt-5.4-mini" }], panelWebSearch: { enabled: true, maxSearchesPerPanel: 1, maxTotalSearches: 1, tiers: ["no_key"] } });
    config.modelMixing!.surfaceStages = true;
    const gen = await runWithMixing({
      config,
      parsed: req(),
      incomingHeaders: new Headers(),
      executeSearchEvidence: executeSearchEvidenceStub,
      dispatchBuffered: async (_target, messages, _max, _timeout, tools) => {
        bufferedTools.push(tools);
        if (bufferedTools.length === 1) return toolUse("search-1", "today");
        if (messages.some(m => m.role === "toolResult")) return [{ type: "text_delta", text: "panel answer" }, { type: "done" }];
        return [{ type: "text_delta", text: judgeAnalysis }, { type: "done" }];
      },
      dispatchFinalStream: async function* () {
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
    });

    const events = await consume(gen);
    expect(bufferedTools[0]?.map(t => t.name)).toEqual(["web_search"]);
    expect(bufferedTools.every(tools => !tools?.some(t => t.name === "bash"))).toBe(true);
    expect(events.some(e => e.type === "tool_call_start" || e.type === "tool_call_delta" || e.type === "tool_call_end")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("evidence:today");
  });
});
