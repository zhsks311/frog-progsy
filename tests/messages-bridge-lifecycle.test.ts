import { describe, expect, test } from "bun:test";
import { bridgeToMessagesSSE } from "../src/messages/bridge";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("Anthropic Messages bridge lifecycle", () => {
  test("client cancellation invokes upstream cancellation hook", async () => {
    let cancelled = false;
    async function* slowEvents(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "partial" };
      await new Promise(() => undefined);
    }

    const stream = bridgeToMessagesSSE(slowEvents(), "model-a", () => { cancelled = true; });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("client closed");

    expect(cancelled).toBe(true);
  });

  test("adapter error emits Anthropic error event and closes without message_stop", async () => {
    const text = await collectText(bridgeToMessagesSSE(replay([
      { type: "text_delta", text: "before" },
      { type: "error", message: "upstream exploded" },
    ]), "model-a"));

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain("event: content_block_stop");
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"api_error"');
    expect(text).toContain("upstream exploded");
    expect(text).not.toContain("event: message_stop");
  });

  test("terminal done without content still emits message_delta and message_stop", async () => {
    const text = await collectText(bridgeToMessagesSSE(replay([
      { type: "done", usage: { inputTokens: 1, outputTokens: 0 } },
    ]), "model-a"));

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_delta");
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('"input_tokens":1');
    expect(text).toContain("event: message_stop");
  });
});
