import { describe, expect, test } from "bun:test";
import type { FrogConfig, FrogParsedRequest } from "../src/types";
import {
  buildCoordinatorPrompt,
  extractTaskText,
  isModelMixingRequest,
  mixAliasId,
  parseCoordinatorChoice,
  rosterText,
  validMixAgents,
} from "../src/model-mixing/select";
import { resolveMix, type CoordinatorComplete } from "../src/model-mixing";
import { mixingRoutedModel } from "../src/claude-catalog";

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

function req(userText: string): FrogParsedRequest {
  return {
    modelId: "frogp/mix",
    stream: false,
    context: { messages: [{ role: "user", content: userText, timestamp: 1 }] },
    options: {} as FrogParsedRequest["options"],
  };
}

describe("mix gating", () => {
  test("aliasId defaults to frogp/mix and honors override", () => {
    expect(mixAliasId(undefined)).toBe("frogp/mix");
    expect(mixAliasId({ aliasId: "  " })).toBe("frogp/mix");
    expect(mixAliasId({ aliasId: "mix" })).toBe("mix");
  });

  test("isModelMixingRequest only when enabled and id matches", () => {
    const c = cfg();
    expect(isModelMixingRequest(c, "frogp/mix")).toBe(true);
    expect(isModelMixingRequest(c, "gpt-5.5")).toBe(false);
    const disabled = cfg({ enabled: false });
    expect(isModelMixingRequest(disabled, "frogp/mix")).toBe(false);
    const noMix: FrogConfig = { port: 1, defaultProvider: "codex", providers: {} };
    expect(isModelMixingRequest(noMix, "frogp/mix")).toBe(false);
  });

  test("validMixAgents drops agents whose provider is not configured", () => {
    const c = cfg({
      agents: [
        { provider: "codex", model: "gpt-5.4-mini" },
        { provider: "ghost", model: "nope" },
        { provider: "anthropic", model: "" },
      ],
    });
    const valid = validMixAgents(c);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.provider).toBe("codex");
  });
});

describe("task + prompt", () => {
  test("extractTaskText returns the latest user message text", () => {
    const r: FrogParsedRequest = {
      modelId: "frogp-mix",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "old", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
          { role: "user", content: [{ type: "text", text: "fix the bug" }], timestamp: 3 },
        ],
      },
      options: {} as FrogParsedRequest["options"],
    };
    expect(extractTaskText(r)).toBe("fix the bug");
  });

  test("prompt embeds roster, guidance, task, and JSON instruction", () => {
    const c = cfg();
    const prompt = buildCoordinatorPrompt(c.modelMixing!.agents!, c.modelMixing!.guidance, "write a parser");
    expect(prompt).toContain("#0: codex/gpt-5.4-mini");
    expect(prompt).toContain("#1: anthropic/claude-opus");
    expect(prompt).toContain("Coding -> opus");
    expect(prompt).toContain("write a parser");
    expect(prompt).toContain('{"agent": <index>}');
  });

  test("rosterText numbers agents with their annotations", () => {
    const text = rosterText([{ provider: "p", model: "m", tasks: ["a"], difficulty: ["hard"] }]);
    expect(text).toBe("#0: p/m  tasks=[a]  difficulty=[hard]");
  });
});

describe("parseCoordinatorChoice", () => {
  const agents = cfg().modelMixing!.agents!;

  test("index picks the roster entry", () => {
    expect(parseCoordinatorChoice('{"agent": 1}', agents)).toBe(agents[1]!);
    expect(parseCoordinatorChoice('{"index": 0}', agents)).toBe(agents[0]!);
  });

  test("provider/model match picks the entry", () => {
    expect(parseCoordinatorChoice('{"provider":"anthropic","model":"claude-opus"}', agents)).toBe(agents[1]!);
  });

  test("strips code fences", () => {
    expect(parseCoordinatorChoice('```json\n{"agent": 1}\n```', agents)).toBe(agents[1]!);
  });

  test("out-of-range, unknown, or prose -> null", () => {
    expect(parseCoordinatorChoice('{"agent": 9}', agents)).toBeNull();
    expect(parseCoordinatorChoice('{"provider":"x","model":"y"}', agents)).toBeNull();
    expect(parseCoordinatorChoice("I think opus is best", agents)).toBeNull();
    expect(parseCoordinatorChoice("", agents)).toBeNull();
  });
});

describe("resolveMix", () => {
  const constComplete = (reply: string): CoordinatorComplete => async () => reply;

  test("coordinator choice routes to the chosen agent", async () => {
    const res = await resolveMix(cfg(), req("write code"), constComplete('{"agent": 1}'));
    expect(res.source).toBe("coordinator");
    expect(res.target).toEqual({ provider: "anthropic", model: "claude-opus" });
    expect(res.warning).toBeUndefined();
  });

  test("unparseable reply falls back to first agent with warning", async () => {
    const res = await resolveMix(cfg(), req("hi"), constComplete("no idea"));
    expect(res.source).toBe("fallback");
    expect(res.target).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    expect(res.warning).toContain("unparseable");
  });

  test("coordinator call error falls back to first agent with warning", async () => {
    const throwing: CoordinatorComplete = async () => {
      throw new Error("boom");
    };
    const res = await resolveMix(cfg(), req("hi"), throwing);
    expect(res.source).toBe("fallback");
    expect(res.target.provider).toBe("codex");
    expect(res.warning).toContain("boom");
  });

  test("missing coordinator config falls back to first agent", async () => {
    const c = cfg({ coordinator: undefined });
    const res = await resolveMix(c, req("hi"), constComplete('{"agent": 1}'));
    expect(res.source).toBe("fallback");
    expect(res.target.provider).toBe("codex");
    expect(res.warning).toContain("coordinator model not configured");
  });

  test("empty roster falls back to default provider", async () => {
    const c = cfg({ agents: [] });
    const res = await resolveMix(c, req("hi"), constComplete('{"agent": 0}'));
    expect(res.source).toBe("fallback");
    expect(res.target).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(res.warning).toContain("no routable agents");
  });
});

describe("mixingRoutedModel (catalog exposure)", () => {
  test("returns the namespaced routed entry when enabled", () => {
    expect(mixingRoutedModel(cfg())).toEqual({ provider: "frogp", id: "mix", owned_by: "frogprogsy-mixing" });
  });

  test("null when disabled", () => {
    expect(mixingRoutedModel(cfg({ enabled: false }))).toBeNull();
  });

  test("null for a bare (non-namespaced) alias id", () => {
    expect(mixingRoutedModel(cfg({ aliasId: "frogp-mix" }))).toBeNull();
  });

  test("honors a custom namespaced alias id", () => {
    expect(mixingRoutedModel(cfg({ aliasId: "team/router" }))).toEqual({
      provider: "team",
      id: "router",
      owned_by: "frogprogsy-mixing",
    });
  });
});
