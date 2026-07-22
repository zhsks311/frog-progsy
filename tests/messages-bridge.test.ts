import { describe, expect, test } from "bun:test";
import { bridgeToMessagesSSE, buildMessageJSON } from "../src/messages/bridge";
import type { AdapterEvent } from "../src/types";

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

describe("Anthropic Messages bridge", () => {
  test("non-streaming JSON builds text, thinking, tool_use, stop reason, and usage", () => {
    const json = buildMessageJSON([
      { type: "thinking_delta", thinking: "plan" },
      { type: "text_delta", text: "answer" },
      { type: "tool_call_start", id: "toolu_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"README.md\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 8, outputTokens: 5, cachedInputTokens: 2, reasoningOutputTokens: 1 } },
    ], "claude-frogp-test-model");

    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-frogp-test-model",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 8,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        reasoning_output_tokens: 1,
      },
    });
    expect(json.content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
    ]);
  });

  test("streaming emits Anthropic message/content lifecycle and input_json_delta chunks", async () => {
    const frames = await collectSse(bridgeToMessagesSSE(replay([
      { type: "text_delta", text: "before" },
      { type: "tool_call_start", id: "toolu_1", name: "lookup" },
      { type: "tool_call_delta", arguments: "{\"q\":" },
      { type: "tool_call_delta", arguments: "\"docs\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 4 } },
    ]), "model-a"));

    expect(frames.map(frame => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[1].data.content_block).toEqual({ type: "text", text: "" });
    expect(frames[2].data.delta).toEqual({ type: "text_delta", text: "before" });
    expect(frames[4].data.content_block).toEqual({ type: "tool_use", id: "toolu_1", name: "lookup", input: {} });
    expect(frames[5].data.delta).toEqual({ type: "input_json_delta", partial_json: "{\"q\":" });
    expect(frames[6].data.delta).toEqual({ type: "input_json_delta", partial_json: "\"docs\"}" });
    expect(frames[8].data.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
    expect(frames[8].data.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
    for (const frame of frames) {
      expect(frame.data.type).toBe(frame.event);
    }
  });

  test("hideThinkingSummary suppresses Anthropic thinking blocks", async () => {
    const json = buildMessageJSON([
      { type: "thinking_delta", thinking: "hidden" },
      { type: "text_delta", text: "visible" },
      { type: "done" },
    ], "model-a", { hideThinkingSummary: true });
    expect(json.content).toEqual([{ type: "text", text: "visible" }]);

    const frames = await collectSse(bridgeToMessagesSSE(replay([
      { type: "thinking_delta", thinking: "hidden" },
      { type: "text_delta", text: "visible" },
      { type: "done" },
    ]), "model-a", undefined, 2_000, { hideThinkingSummary: true }));
    expect(frames.some(frame => frame.data.content_block && (frame.data.content_block as Record<string, unknown>).type === "thinking")).toBe(false);
    expect(frames.some(frame => (frame.data.delta as Record<string, unknown> | undefined)?.type === "thinking_delta")).toBe(false);
  });
});
