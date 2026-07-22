import { describe, expect, test } from "bun:test";
import { buildMessageJSON, bridgeToMessagesSSE, formatAnthropicErrorResponse } from "../src/messages/bridge";
import { estimateMessagesInputTokens, parseMessagesRequest } from "../src/messages/parser";
import { createResponsesAdapter } from "../src/adapters/openai-responses";
import { buildAnthropicModelsListFromAliases } from "../src/server";
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

describe("Claude Messages data plane", () => {
  test("parses Anthropic messages with thinking, tool_use, tool_result, tools, and Responses raw body", () => {
    const parsed = parseMessagesRequest({
      model: "provider/model-a",
      system: [{ type: "text", text: "system" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "plan", signature: "sig" },
          { type: "text", text: "before tool" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      ],
      tools: [{ name: "read_file", description: "Read", input_schema: { type: "object" } }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      max_tokens: 100,
      stream: false,
    });

    expect(parsed.context.systemPrompt).toEqual(["system"]);
    expect(parsed.context.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(parsed.context.tools?.[0]).toMatchObject({ name: "read_file", parameters: { type: "object" } });
    expect(parsed.options.reasoning).toBe("low");
    expect(parsed.options.hideThinkingSummary).toBe(false);

    const raw = parsed._rawBody as Record<string, unknown>;
    expect(raw.model).toBe("provider/model-a");
    expect(raw.instructions).toBe("system");
    expect(raw.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", summary: [{ text: "plan" }], content: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "before tool" }] },
      { type: "function_call", call_id: "toolu_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      { type: "function_call_output", call_id: "toolu_1", output: "ok" },
    ]);
  });

  test("non-streaming bridge returns Anthropic Message JSON with text, thinking, tool_use, and usage", () => {
    const json = buildMessageJSON([
      { type: "thinking_delta", thinking: "plan" },
      { type: "text_delta", text: "Use " },
      { type: "text_delta", text: "tool" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"README.md\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 3 } },
    ], "provider/model-a", { hideThinkingSummary: false });

    expect(json).toMatchObject({ type: "message", role: "assistant", model: "provider/model-a", stop_reason: "tool_use" });
    expect(json.content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Use tool" },
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
    ]);
    expect(json.usage).toMatchObject({ input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 });
  });

  test("streaming bridge emits Anthropic event order and input_json_delta for tool calls", async () => {
    const frames = await collectSse(bridgeToMessagesSSE(replay([
      { type: "text_delta", text: "hi" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":" },
      { type: "tool_call_delta", arguments: "\"README.md\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
    ]), "provider/model-a"));

    expect(frames.map(f => f.event)).toEqual([
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
    expect(frames[5].data.delta).toMatchObject({ type: "input_json_delta", partial_json: "{\"path\":" });
    expect(frames[8].data.delta).toMatchObject({ stop_reason: "tool_use" });
  });

  test("OpenAI Responses adapter parses provider-internal Responses output for Messages responses", async () => {
    const adapter = createResponsesAdapter({ adapter: "openai-responses", baseUrl: "https://api.openai.test/v1", apiKey: "key" });
    const response = new Response(JSON.stringify({
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"x\"}" },
      ],
      usage: { input_tokens: 7, output_tokens: 4 },
    }), { headers: { "content-type": "application/json" } });

    const events = await adapter.parseResponse!(response);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"x\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 7, outputTokens: 4 } },
    ]);
  });

  test("count-token fallback is deterministic and handles images/tools without crashing", () => {
    const parsed = parseMessagesRequest({
      model: "provider/model-a",
      messages: [{ role: "user", content: [
        { type: "text", text: "hello" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }],
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    });
    expect(estimateMessagesInputTokens(parsed)).toBeGreaterThan(1000);
  });

  test("model discovery uses strict Anthropic list envelope", () => {
    const list = buildAnthropicModelsListFromAliases([
      {
        alias: "claude-frogp-provider-model-a",
        provider: "provider",
        model: "model-a",
        routeKey: "provider/model-a",
        displayName: "provider/model-a",
        createdAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
    expect(list).toEqual({
      type: "list",
      data: [
        {
          id: "claude-frogp-provider-model-a",
          type: "model",
          display_name: "provider/model-a",
          created_at: "1970-01-01T00:00:00.000Z",
        },
      ],
      has_more: false,
      first_id: "claude-frogp-provider-model-a",
      last_id: "claude-frogp-provider-model-a",
    });
  });
  test("Anthropic error responses do not leak stacks and keep Anthropic envelope", async () => {
    const response = formatAnthropicErrorResponse(529, "upstream_error", "server is overloaded");
    expect(response.status).toBe(529);
    const json = await response.json() as Record<string, unknown>;
    expect(json).toEqual({ type: "error", error: { type: "overloaded_error", message: "server is overloaded" } });
  });
});
