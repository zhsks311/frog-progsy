import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { bridgeToMessagesSSE, buildMessageJSON } from "../src/messages/bridge";
import { __requestLogTest } from "../src/server";
import type { AdapterEvent } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://example.test", apiKey: "key" };
const SENTINEL = "provider_secret_new_stop";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && !frame.startsWith(":"))
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

async function parseAnthropicStream(sse: string[]): Promise<AdapterEvent[]> {
  const adapter = createAnthropicAdapter(provider);
  const response = new Response(sse.join(""));
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(response)) events.push(event);
  return events;
}

describe("Anthropic stop_reason propagation (Bug B)", () => {
  test("streamed max_tokens stop reaches the final Messages SSE message_delta", async () => {
    const events = await parseAnthropicStream([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":5,"output_tokens":300}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens", stopReasonProvenance: "approved" });

    const frames = await collectSse(bridgeToMessagesSSE(replay(events), "claude-opus-4-8"));
    const final = frames.find(f => f.event === "message_delta");
    expect((final?.data.delta as Record<string, unknown>).stop_reason).toBe("max_tokens");
  });

  test("non-streaming max_tokens stop reaches the Messages JSON", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 300 },
    })));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens", stopReasonProvenance: "approved" });

    const json = buildMessageJSON(events, "claude-opus-4-8");
    expect(json.stop_reason).toBe("max_tokens");
  });

  test("stop_sequence passes through on both surfaces", async () => {
    const streamed = await parseAnthropicStream([
      'data: {"type":"message_delta","delta":{"stop_reason":"stop_sequence"},"usage":{"output_tokens":1}}\n\n',
    ]);
    expect(streamed.at(-1)).toMatchObject({ type: "done", stopReason: "stop_sequence" });

    const adapter = createAnthropicAdapter(provider);
    const nonStream = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [], stop_reason: "stop_sequence", usage: { input_tokens: 1, output_tokens: 1 },
    })));
    expect(buildMessageJSON(nonStream, "m").stop_reason).toBe("stop_sequence");
  });

  test("unknown streamed stop reason normalizes to end_turn with a hash/length diagnostic and no raw leak", async () => {
    const events = await parseAnthropicStream([
      `data: {"type":"message_delta","delta":{"stop_reason":"${SENTINEL}"},"usage":{"output_tokens":2}}\n\n`,
    ]);
    const diagnostic = events.find(e => e.type === "diagnostic");
    expect(diagnostic).toMatchObject({
      type: "diagnostic",
      diagnostic: {
        kind: "adapter",
        code: "anthropic_unknown_stop_reason",
        provider: "anthropic",
        surface: "stream",
        rawValueHash: createHash("sha256").update(SENTINEL).digest("hex"),
        rawValueLength: SENTINEL.length,
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn", stopReasonProvenance: "unknown_normalized" });

    const frames = await collectSse(bridgeToMessagesSSE(replay(events), "claude-opus-4-8"));
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain(SENTINEL);
    const final = frames.find(f => f.event === "message_delta");
    expect((final?.data.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
  });

  test("unknown non-streaming stop reason normalizes with surface nonstream and no raw leak", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      stop_reason: SENTINEL,
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    const diagnostic = events.find(e => e.type === "diagnostic");
    expect(diagnostic).toMatchObject({ type: "diagnostic", diagnostic: { surface: "nonstream", rawValueLength: SENTINEL.length } });

    const json = buildMessageJSON(events, "claude-opus-4-8");
    expect(json.stop_reason).toBe("end_turn");
    expect(JSON.stringify(json)).not.toContain(SENTINEL);
  });

  test("amendment: unknown-normalized end_turn never overwrites a locally established tool_use", async () => {
    const events = await parseAnthropicStream([
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'data: {"type":"content_block_stop"}\n\n',
      `data: {"type":"message_delta","delta":{"stop_reason":"${SENTINEL}"},"usage":{"output_tokens":3}}\n\n`,
    ]);
    expect(events.some(e => e.type === "diagnostic")).toBe(true);

    const json = buildMessageJSON(events, "claude-opus-4-8");
    expect(json.stop_reason).toBe("tool_use");
    expect(JSON.stringify(json)).not.toContain(SENTINEL);

    const frames = await collectSse(bridgeToMessagesSSE(replay(events), "claude-opus-4-8"));
    const final = frames.find(f => f.event === "message_delta");
    expect((final?.data.delta as Record<string, unknown>).stop_reason).toBe("tool_use");
    expect(JSON.stringify(frames)).not.toContain(SENTINEL);
  });

  test("empty-string stop reason is malformed-present: normalized to end_turn with a length-0 diagnostic", async () => {
    const streamed = await parseAnthropicStream([
      'data: {"type":"message_delta","delta":{"stop_reason":""},"usage":{"output_tokens":1}}\n\n',
    ]);
    expect(streamed.find(e => e.type === "diagnostic")).toMatchObject({
      type: "diagnostic",
      diagnostic: { code: "anthropic_unknown_stop_reason", surface: "stream", rawValueHash: createHash("sha256").update("").digest("hex"), rawValueLength: 0 },
    });
    expect(streamed.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn", stopReasonProvenance: "unknown_normalized" });

    const adapter = createAnthropicAdapter(provider);
    const nonStream = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [], stop_reason: "", usage: { input_tokens: 1, output_tokens: 1 },
    })));
    expect(nonStream.find(e => e.type === "diagnostic")).toMatchObject({
      type: "diagnostic",
      diagnostic: { surface: "nonstream", rawValueLength: 0 },
    });
    expect(buildMessageJSON(nonStream, "m").stop_reason).toBe("end_turn");
  });

  test("approved provider tool_use and max_tokens always set the final stop reason", async () => {
    // Provider-approved max_tokens wins even when local tool inference happened (mid-tool cutoff).
    const cutoff: AdapterEvent[] = [
      { type: "tool_call_start", id: "toolu_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"pa" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 300 }, stopReason: "max_tokens", stopReasonProvenance: "approved" },
    ];
    expect(buildMessageJSON(cutoff, "m").stop_reason).toBe("max_tokens");

    const toolUse: AdapterEvent[] = [
      { type: "text_delta", text: "calling" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 3 }, stopReason: "tool_use", stopReasonProvenance: "approved" },
    ];
    expect(buildMessageJSON(toolUse, "m").stop_reason).toBe("tool_use");
  });
});

describe("unknown stop-reason diagnostics in request logs", () => {
  test("diagnostic events land in request-log snapshots as hash/length only, never the raw value", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    ctx.entry.route.provider = "anthropic";

    const events = await parseAnthropicStream([
      `data: {"type":"message_delta","delta":{"stop_reason":"${SENTINEL}"},"usage":{"output_tokens":2}}\n\n`,
    ]);
    const observed: AdapterEvent[] = [];
    for await (const event of __requestLogTest.observeUsageEvents(replay(events), ctx)) observed.push(event);
    // Observation is transparent: every event still flows to the bridge.
    expect(observed).toEqual(events);

    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);
    const [entry] = __requestLogTest.requestLogSnapshot() as Array<Record<string, unknown>>;
    expect(entry.diagnostics).toEqual([{
      kind: "adapter",
      code: "anthropic_unknown_stop_reason",
      provider: "anthropic",
      surface: "stream",
      rawValueHash: createHash("sha256").update(SENTINEL).digest("hex"),
      rawValueLength: SENTINEL.length,
    }]);
    expect(JSON.stringify(entry)).not.toContain(SENTINEL);

    const [managed] = (__requestLogTest.requestLogManagementSnapshot as () => Array<Record<string, unknown>>)();
    expect(JSON.stringify(managed)).toContain("anthropic_unknown_stop_reason");
    expect(JSON.stringify(managed)).not.toContain(SENTINEL);
    __requestLogTest.clear();
  });

  test("non-stream diagnostics are recorded via recordUsageFromEvents and bounded per entry", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    ctx.entry.route.provider = "anthropic";

    const adapter = createAnthropicAdapter(provider);
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [], stop_reason: SENTINEL, usage: { input_tokens: 1, output_tokens: 1 },
    })));
    for (let i = 0; i < 12; i++) __requestLogTest.recordUsageFromEvents(ctx, events);

    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);
    const [entry] = __requestLogTest.requestLogSnapshot() as Array<{ diagnostics?: Array<Record<string, unknown>> }>;
    expect(Array.isArray(entry.diagnostics)).toBe(true);
    const diagnostics = entry.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.length).toBeLessThanOrEqual(8);
    // Non-stream diagnostics carry the same independent hash/length/surface evidence as stream ones.
    expect(diagnostics[0]).toEqual({
      kind: "adapter",
      code: "anthropic_unknown_stop_reason",
      provider: "anthropic",
      surface: "nonstream",
      rawValueHash: createHash("sha256").update(SENTINEL).digest("hex"),
      rawValueLength: SENTINEL.length,
    });
    expect(JSON.stringify(entry)).not.toContain(SENTINEL);
    __requestLogTest.clear();
  });
});
