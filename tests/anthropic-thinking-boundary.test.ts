import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseMessagesRequest } from "../src/messages/parser";

const provider = { adapter: "anthropic", baseUrl: "https://example.test", apiKey: "key" };

/** Build a parsed /v1/messages request the way the data plane does. */
function parsedRequest(body: Record<string, unknown>) {
  return parseMessagesRequest({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Explain quicksort in detail." }],
    stream: false,
    ...body,
  });
}

function buildBody(body: Record<string, unknown>): Record<string, unknown> {
  const adapter = createAnthropicAdapter(provider);
  const request = adapter.buildRequest(parsedRequest(body)) as { body: string };
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("Anthropic max_tokens caller-cap preservation (Bug A)", () => {
  test("max_tokens 20 with thinking enabled keeps cap 20 and omits thinking", () => {
    const body = buildBody({ max_tokens: 20, thinking: { type: "enabled", budget_tokens: 4096 }, temperature: 0.5 });
    expect(body.max_tokens).toBe(20);
    expect(body.thinking).toBeUndefined();
    // Without thinking the request stays a normal capped call: sampling params survive.
    expect(body.temperature).toBe(0.5);
  });

  test("max_tokens 1024 with thinking enabled keeps cap and omits thinking", () => {
    const body = buildBody({ max_tokens: 1024, thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(body.max_tokens).toBe(1024);
    expect(body.thinking).toBeUndefined();
  });

  test("max_tokens 1025 omits thinking instead of starving visible output", () => {
    const body = buildBody({ max_tokens: 1025, thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(body.max_tokens).toBe(1025);
    expect(body.thinking).toBeUndefined();
  });

  test("omitted max_tokens with medium reasoning uses default 8192 and budget 4096", () => {
    const body = buildBody({ thinking: { type: "enabled", budget_tokens: 8192 }, temperature: 0.7, top_p: 0.9 });
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    // Extended thinking disallows sampling params.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test("max_tokens 32000 with high reasoning keeps cap and budget 16384", () => {
    const body = buildBody({ max_tokens: 32_000, thinking: { type: "enabled", budget_tokens: 16_384 } });
    expect(body.max_tokens).toBe(32_000);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });
  });

  test("threshold cap 5120 sends thinking with the minimum viable budget", () => {
    const body = buildBody({ max_tokens: 5120, thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(body.max_tokens).toBe(5120);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("thinking budget always satisfies max_tokens > budget >= 1024 with a 4096 visible floor", () => {
    for (const cap of [5120, 8192, 12_000, 32_000, 64_000]) {
      const body = buildBody({ max_tokens: cap, thinking: { type: "enabled", budget_tokens: 32_000 } });
      const thinking = body.thinking as { budget_tokens: number };
      expect(body.max_tokens).toBe(cap);
      expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
      expect((body.max_tokens as number) - thinking.budget_tokens).toBeGreaterThanOrEqual(4096);
    }
  });
});
