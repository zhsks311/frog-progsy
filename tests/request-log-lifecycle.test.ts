import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __requestLogTest } from "../src/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let usageHome = "";
let previousFrogHome: string | undefined;

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  usageHome = mkdtempSync(join(tmpdir(), "frog-usage-log-"));
  process.env.FROGPROGSY_HOME = usageHome;
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (usageHome) rmSync(usageHome, { recursive: true, force: true });
  usageHome = "";
});

function asText(value: unknown): string {
  return JSON.stringify(value);
}

describe("privacy-safe request logs", () => {
  test("persisted provider failures store structured codes, not free-form snippets", () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers({ "content-length": "123" }));
    ctx.entry.route.provider = "codex";
    ctx.entry.route.routedModelLabel = "gpt-5.5";
    ctx.entry.upstream = { status: 400, contentTypeFamily: "json" };

    __requestLogTest.finalizeRequestLog(ctx, "provider_non_2xx", 400, {
      kind: "upstream",
      code: "provider_non_2xx",
      upstreamStatus: 400,
    });

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(entry).toMatchObject({
      lifecycle: "provider_non_2xx",
      endpoint: "/v1/messages",
      method: "POST",
      status: 400,
      request: { requestBytes: 123 },
      route: { provider: "codex", routedModelLabel: "gpt-5.5" },
      error: { kind: "upstream", code: "provider_non_2xx", upstreamStatus: 400 },
    });

    expect("timestamp" in entry).toBe(false);
    expect(typeof entry.error).toBe("object");
    const serialized = asText(entry);
    for (const forbidden of [
      "sk-test-secret",
      "Bearer abc.def.ghi",
      "Authorization",
      "cookie=secret",
      "user@example.com",
      "/Users/alice/private-project",
      "prompt text echoed by provider",
      "tool args",
      "provider raw body",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("stream observation finalizes completed lifecycle and byte counts", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("abc"));
        controller.enqueue(encoder.encode("de"));
        controller.close();
      },
    });

    const reader = __requestLogTest.observeLoggedStream(stream, ctx).getReader();
    while (!(await reader.read()).done) {
      // drain
    }

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(entry.lifecycle).toBe("completed");
    expect(entry.status).toBe(200);
    expect(entry.upstream?.responseBytes).toBe(5);
    expect(entry.phases.some(phase => phase.name === "stream_bridge" && phase.status === "ok")).toBe(true);
  });

  test("stream cancellation finalizes client_cancel once", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("chunk"));
      },
    });

    const reader = __requestLogTest.observeLoggedStream(stream, ctx).getReader();
    await reader.read();
    await reader.cancel("client closed");
    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(entry.lifecycle).toBe("client_cancel");
    expect(entry.status).toBe(499);
    expect(entry.error).toEqual({ kind: "internal", code: "client_cancel" });
    expect(entry.phases.filter(phase => phase.name === "finalize")).toHaveLength(1);
  });

  test("management snapshots are defensive copies", () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

    const snapshot = __requestLogTest.requestLogSnapshot();
    snapshot[0].route.provider = "mutated";

    expect(__requestLogTest.requestLogSnapshot()[0].route.provider).toBe("unknown");
  });

  test("non-stream bridge failures finalize without persisting provider body", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("provider raw body with secret-token", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "claude-opus-4-8",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "codex",
          providers: {
            codex: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.test/backend-api/codex",
              defaultModel: "gpt-5.5",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(response.status).toBe(502);
      expect(entry.lifecycle).toBe("bridge_error");
      expect(entry.error).toEqual({ kind: "bridge", code: "bridge_parse_error" });
      expect(entry.phases.some(phase => phase.name === "nonstream_bridge" && phase.status === "error")).toBe(true);
      expect(asText(entry)).not.toContain("provider raw body");
      expect(asText(entry)).not.toContain("secret-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Codex non-stream messages use streaming upstream and bridge back to JSON", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const body = [
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}",
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}",
        "",
      ].join("\n");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-5.5",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          }),
        }),
        {
          port: 10100,
          defaultProvider: "codex",
          providers: {
            codex: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              defaultModel: "gpt-5.5",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      const json = await response.json() as Record<string, unknown>;
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(response.status).toBe(200);
      expect(upstreamBody?.stream).toBe(true);
      expect(json).toMatchObject({
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "OK" }],
        usage: { input_tokens: 3, output_tokens: 1 },
      });
      expect(entry.phases.some(phase => phase.name === "nonstream_bridge" && phase.status === "ok")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("messages preserve safe upstream usage headers and aggregate non-stream usage", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-reset": "2026-06-29T00:00:00Z",
        "x-claude-primary-used-percent": "42",
        "set-cookie": "must-not-leak=true",
      },
    })) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-6",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "anthropic",
          providers: {
            anthropic: {
              adapter: "anthropic",
              baseUrl: "https://api.anthropic.test",
              defaultModel: "claude-sonnet-4-6",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe("2026-06-29T00:00:00Z");
      expect(response.headers.get("x-claude-primary-used-percent")).toBe("42");
      expect(response.headers.get("set-cookie")).toBeNull();

      __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

      const summary = __requestLogTest.usageSummarySnapshot();
      expect(summary.summary).toMatchObject({
        requests: 1,
        reportedRequests: 1,
        unreportedRequests: 0,
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
        totalTokens: 18,
      });
      expect(summary.providers[0]).toMatchObject({ provider: "anthropic", totalTokens: 18 });
      expect(summary.models[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6", inputTokens: 11, outputTokens: 7 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streamed messages aggregate terminal usage", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const body = [
        "event: message_start",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\"}}",
        "",
        "event: content_block_start",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
        "",
        "event: content_block_delta",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}",
        "",
        "event: message_delta",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}",
        "",
        "event: message_stop",
        "data: {\"type\":\"message_stop\"}",
        "",
      ].join("\n");
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "anthropic-ratelimit-unified-remaining": "58",
        },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-6",
            max_tokens: 10,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "anthropic",
          providers: {
            anthropic: {
              adapter: "anthropic",
              baseUrl: "https://api.anthropic.test",
              defaultModel: "claude-sonnet-4-6",
              apiKey: "test-key",
            },
          },
        },
        ctx,
      );

      expect(response.headers.get("anthropic-ratelimit-unified-remaining")).toBe("58");
      const reader = response.body!.getReader();
      while (!(await reader.read()).done) {
        // drain stream so observeLoggedStream finalizes and usage is recorded
      }

      const summary = __requestLogTest.usageSummarySnapshot();
      expect(summary.summary).toMatchObject({
        requests: 1,
        reportedRequests: 1,
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("usage API exposes summary under Claude Code compatible aliases", async () => {
    __requestLogTest.clear();
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    ctx.entry.route.provider = "codex";
    ctx.entry.route.routedModelLabel = "gpt-5.5";
    ctx.entry.upstream = { usage: { inputTokens: 2, outputTokens: 3 } };
    __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

    const config = { port: 10100, defaultProvider: "codex", providers: {} };
    const usageRes = await __requestLogTest.handleManagementAPI(
      new Request("http://127.0.0.1/api/usage"),
      new URL("http://127.0.0.1/api/usage"),
      config,
    );
    const oauthUsageRes = await __requestLogTest.handleManagementAPI(
      new Request("http://127.0.0.1/api/oauth/usage"),
      new URL("http://127.0.0.1/api/oauth/usage"),
      config,
    );

    expect(usageRes?.status).toBe(200);
    expect(oauthUsageRes?.status).toBe(200);
    const usageBody = await usageRes!.json();
    const oauthUsageBody = await oauthUsageRes!.json();
    expect(usageBody).toMatchObject({
      summary: { requests: 1, reportedRequests: 1, totalTokens: 5 },
      providers: [{ provider: "codex", totalTokens: 5 }],
      sourceState: {
        observedUsage: { available: true, source: "local_request_log", authoritative: false },
        sessionLimits: { available: false, source: null, reason: "no_authoritative_source" },
        cost: { available: false, source: null, reason: "no_authoritative_source" },
      },
    });
    expect(oauthUsageBody).toMatchObject({
      summary: { totalTokens: 5 },
      sourceState: {
        sessionLimits: { available: false, reason: "no_authoritative_source" },
        cost: { available: false, reason: "no_authoritative_source" },
      },
    });
  });

  test("count-token upstream fetch observes client aborts", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    const client = new AbortController();
    globalThis.fetch = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      setTimeout(() => client.abort(new DOMException("Client closed", "AbortError")), 0);
    })) as typeof fetch;
    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
      const response = await __requestLogTest.handleCountTokens(
        new Request("http://127.0.0.1/v1/messages/count_tokens", {
          method: "POST",
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-6",
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "anthropic",
          providers: {
            anthropic: {
              adapter: "anthropic",
              baseUrl: "https://api.anthropic.test",
              defaultModel: "claude-sonnet-4-6",
              apiKey: "test-key",
            },
          },
        },
        ctx,
        { abortSignal: client.signal },
      );

      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(response.status).toBe(502);
      expect(entry.lifecycle).toBe("upstream_abort");
      expect(entry.error).toEqual({ kind: "upstream", code: "upstream_unreachable" });
      expect(entry.phases.some(phase => phase.name === "upstream_connect" && phase.status === "error")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("logged data-plane wrapper finalizes thrown handlers generically", async () => {
    __requestLogTest.clear();
    const response = await __requestLogTest.runLoggedDataPlane(
      new Request("http://127.0.0.1/v1/messages", { method: "POST", body: "{}" }),
      "/v1/messages",
      async () => {
        throw new Error("secret-token provider raw body /Users/alice/private.txt");
      },
    );

    const [entry] = __requestLogTest.requestLogSnapshot();
    expect(response.status).toBe(500);
    expect(entry.lifecycle).toBe("internal_error");
    expect(entry.error).toEqual({ kind: "internal", code: "handler_exception" });
    expect(asText(entry)).not.toContain("secret-token");
    expect(asText(entry)).not.toContain("/Users/alice");
    expect(entry.phases.filter(phase => phase.name === "finalize")).toHaveLength(1);
  });
  test("provider fallback logs final provider/model/usage and redacted attempt diagnostics", async () => {
    __requestLogTest.clear();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "quota hit for sk-primary-secret" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        id: "msg_ok",
        type: "message",
        role: "assistant",
        model: "fallback-model",
        content: [{ type: "text", text: "fallback ok" }],
        usage: { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: 2 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
      const response = await __requestLogTest.handleMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "primary/primary-model",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        {
          port: 10100,
          defaultProvider: "primary",
          fallbackProviders: ["fallback"],
          providers: {
            primary: {
              adapter: "anthropic",
              baseUrl: "https://primary.test",
              apiKey: "sk-primary-secret",
              defaultModel: "primary-model",
              models: ["primary-model"],
            },
            fallback: {
              adapter: "anthropic",
              baseUrl: "https://fallback.test",
              apiKey: "sk-fallback-secret",
              defaultModel: "fallback-model",
              models: ["fallback-model"],
            },
          },
        },
        ctx,
      );

      expect(response.status).toBe(200);
      __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(calls).toEqual(["https://primary.test/v1/messages", "https://fallback.test/v1/messages"]);
      expect(entry.route.provider).toBe("fallback");
      expect(entry.route.routedModelLabel).toBe("fallback-model");
      expect(entry.upstream?.usage).toEqual({ inputTokens: 13, outputTokens: 5, cachedInputTokens: 2 });
      expect(entry.attempts).toEqual([
        { provider: "primary", model: "primary-model", source: "primary", keyIndex: 0, status: "error", code: "provider_non_2xx", upstreamStatus: 429 },
        { provider: "fallback", model: "fallback-model", source: "fallback", keyIndex: 0, status: "ok", upstreamStatus: 200 },
      ]);
      expect(entry.lifecycle).toBe("completed");
      expect(entry.status).toBe(200);
      expect(entry.phases.filter(phase => phase.name === "finalize")).toHaveLength(1);
      const serialized = asText(entry);
      expect(serialized).not.toContain("quota hit");
      expect(serialized).not.toContain("sk-primary-secret");
      expect(serialized).not.toContain("sk-fallback-secret");

      const summary = __requestLogTest.usageSummarySnapshot();
      expect(summary.providers[0]).toMatchObject({ provider: "fallback", totalTokens: 18 });
      expect(summary.models[0]).toMatchObject({ provider: "fallback", model: "fallback-model", totalTokens: 18 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
