import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __requestLogTest } from "../src/server";
import { deterministicModelAlias } from "../src/model-aliases";
import type { FrogConfig } from "../src/types";

// AC15 — the Claude Code /v1/messages path must record the REAL routeKind even when the
// resolved provider uses the OpenAI Responses adapter upstream. Claude Code still enters via
// Anthropic Messages; the parser builds a Responses-shaped upstream body before adapter dispatch.

const realFetch = globalThis.fetch;

const responsesConfig: FrogConfig = {
  port: 0,
  defaultProvider: "codex",
  providers: {
    codex: {
      adapter: "openai-responses",
      baseUrl: "https://upstream.test/v1",
      authMode: "key",
      apiKey: "test-key",
      defaultModel: "gpt-5.5",
    },
  },
} as FrogConfig;

describe("Claude Code messages route-log observability", () => {
  let upstreamBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    __requestLogTest.clear();
    upstreamBody = undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        output: [
          { type: "message", content: [{ type: "output_text", text: "pong" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("AC15: /v1/messages records routeKind while translating to OpenAI Responses upstream", async () => {
    const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
    });

    const res = await __requestLogTest.handleMessages(req, responsesConfig, logCtx, {});
    await res.body?.cancel().catch(() => {});

    // gpt-5.5 -> codex via exact defaultModel match; the Claude Code path records the route
    // while the upstream body is the generated OpenAI Responses shape, not raw Anthropic Messages.
    expect(logCtx.entry.route.routeKind).toBe("exact-default");
    expect(logCtx.entry.route.routeKind).not.toBe("configured");
    expect(logCtx.entry.route.provider).toBe("codex");
    expect(logCtx.entry.route.adapter).toBe("openai-responses");
    expect(upstreamBody?.model).toBe("gpt-5.5");
    expect(Array.isArray(upstreamBody?.input)).toBe(true);
    expect(upstreamBody?.messages).toBeUndefined();
  });

  test("preserves Claude-visible alias in streamed responses while upstream uses provider model", async () => {
    const alias = deterministicModelAlias("codex", "gpt-5.5");
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"pong"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const logCtx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: alias,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });

    const res = await __requestLogTest.handleMessages(req, responsesConfig, logCtx, {});
    const body = await res.text();

    expect(logCtx.entry.route.routeKind).toBe("alias");
    expect(upstreamBody?.model).toBe("gpt-5.5");
    expect(body).toContain(`"model":"${alias}"`);
    expect(body).not.toContain('"model":"gpt-5.5"');
  });
});
