import { describe, expect, test } from "bun:test";
import { createResponsesAdapter } from "../src/adapters/openai-responses";

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

describe("OpenAI Responses upstream body sanitization", () => {
  test("drops raw reasoning input content before native GPT Responses upstream call", () => {
    const adapter = createResponsesAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: [{ type: "reasoning_text", text: "raw routed reasoning" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      content: [],
    });
    expect(body.input[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  test("forces ChatGPT Codex backend requests to stream upstream", () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: { model: "gpt-5.5", input: [], stream: false },
    });
    const body = JSON.parse(request.body) as { stream?: boolean; store?: boolean };

    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  test("collects streaming Responses frames for non-stream callers", async () => {
    const adapter = createResponsesAdapter({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "oauth",
      apiKey: "token",
    });
    const response = new Response([
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}",
      "",
    ].join("\n"));

    await expect(adapter.parseResponse!(response)).resolves.toEqual([
      { type: "text_delta", text: "OK" },
      { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
  });
  test("coerces object-shaped input_image.image_url to a string before relaying", () => {
    const adapter = createResponsesAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              // Chat-Completions object shape mistakenly sent to the Responses endpoint.
              { type: "input_image", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
            ],
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: [
              { type: "input_image", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Array<{ content?: unknown[]; output?: unknown[] }> };

    expect(body.input[0].content![1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
      detail: "high",
    });
    expect(body.input[1].output![0]).toEqual({
      type: "input_image",
      image_url: "https://example.com/a.png",
    });
  });

  test("leaves a string image_url untouched", () => {
    const adapter = createResponsesAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Array<{ content?: unknown[] }> };

    expect(body.input[0].content![0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,BBBB",
    });
  });

});
