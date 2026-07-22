import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __requestLogTest } from "../src/server";
import type { FrogConfig } from "../src/types";

let testHome = "";
let previousFrogHome: string | undefined;

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "frog-provider-fallback-chain-"));
  process.env.FROGPROGSY_HOME = testHome;
  __requestLogTest.clear();
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
  __requestLogTest.clear();
});

function baseConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "primary",
    providers: {
      primary: {
        adapter: "anthropic",
        baseUrl: "https://primary.test",
        apiKey: "sk-primary-secret",
        defaultModel: "primary-default",
        models: ["primary-model", "primary-default"],
      },
      fallback: {
        adapter: "anthropic",
        baseUrl: "https://fallback.test",
        apiKey: "sk-fallback-secret",
        defaultModel: "fallback-default",
        models: ["fallback-default", "fallback-other"],
      },
      later: {
        adapter: "anthropic",
        baseUrl: "https://later.test",
        apiKey: "sk-later-secret",
        defaultModel: "later-default",
        models: ["later-default"],
      },
    },
  };
}

function messagesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "primary/primary-model",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

async function invokeMessages(config: FrogConfig, body: Record<string, unknown> = messagesBody()): Promise<Response> {
  const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
  return __requestLogTest.handleMessages(
    new Request("http://127.0.0.1/v1/messages", { method: "POST", body: JSON.stringify(body) }),
    config,
    ctx,
  );
}

function anthropicOk(text: string, inputTokens = 7, outputTokens = 3): Response {
  return new Response(JSON.stringify({
    id: "msg_ok",
    type: "message",
    role: "assistant",
    model: "upstream-model",
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("provider fallback chain", () => {
  test("provider fallback is a no-op when config is unset", async () => {
    const cfg = baseConfig();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(503);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://primary.test/v1/messages");
      expect(calls[0].body.model).toBe("primary-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses only the first valid fallback provider and its defaultModel", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["missing", "fallback", "later"];
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      if (String(url).startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).startsWith("https://fallback.test")) return anthropicOk("fallback ok");
      throw new Error(`unexpected fallback candidate reached: ${url}`);
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      const json = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(json).toMatchObject({ content: [{ type: "text", text: "fallback ok" }] });
      expect(calls.map(call => call.url)).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      expect(calls[0].body.model).toBe("primary-model");
      expect(calls[1].body.model).toBe("fallback-default");
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.route.provider).toBe("fallback");
      expect(entry.route.routedModelLabel).toBe("fallback-default");
      expect(entry.upstream?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not continue past the first valid fallback provider after fallback failure", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["missing", "fallback", "later"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("https://primary.test")) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "primary down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).startsWith("https://fallback.test")) {
        return new Response(JSON.stringify({ error: { type: "server_error", message: "fallback down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected later fallback reached: ${url}`);
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(503);
      expect(calls).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback.test/v1/messages",
      ]);
      const json = await response.json() as { error?: { message?: string } };
      expect(json.error?.message).toBe("fallback down");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    [400, { error: { type: "invalid_request_error", message: "bad request" } }],
    [400, { error: { type: "invalid_request_error", message: "context_length exceeded" } }],
    [503, { error: { type: "server_error", message: "context_length_exceeded" } }],
    [401, { error: { type: "authentication_error", message: "bad key" } }],
    [402, { error: { type: "billing_error", message: "payment required" } }],
    [403, { error: { type: "permission_error", message: "forbidden" } }],
  ])("status %i is terminal and does not use provider fallback", async (status, payload) => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(status);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("oauth token resolution failure is terminal and does not use provider fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    cfg.providers.primary = { ...cfg.providers.primary, authMode: "oauth", apiKey: undefined };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return anthropicOk("should not be called");
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(401);
      expect(calls).toEqual([]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.attempts).toEqual([
        { provider: "primary", model: "primary-model", source: "primary", status: "error", code: "oauth_missing" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("successful upstream OK and bridge parse errors never trigger fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg);
      expect(response.status).toBe(502);
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.lifecycle).toBe("bridge_error");
      expect(JSON.stringify(entry)).not.toContain("sk-primary-secret");
      expect(JSON.stringify(entry)).not.toContain("sk-fallback-secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stream body start commits the attempt and suppresses fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: content_block_delta\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody({ stream: true }));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      while (!(await reader.read()).done) {
        // drain stream to exercise post-start bridge behavior
      }
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stream errors after body start do not trigger provider fallback", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: content_block_delta\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n"));
          controller.error(new Error("stream exploded after first chunk"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const response = await invokeMessages(cfg, messagesBody({ stream: true }));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      try {
        while (!(await reader.read()).done) {
          // drain until the post-start upstream stream error is surfaced
        }
      } catch {
        // The important contract is that fallback is not attempted after the stream has started.
      }
      expect(calls).toEqual(["https://primary.test/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("count_tokens applies long-context routing before building the upstream count request", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    cfg.longContext = { thresholdTokens: 10, provider: "fallback", model: "fallback-default" };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ input_tokens: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
      const response = await __requestLogTest.handleCountTokens(
        new Request("http://127.0.0.1/v1/messages/count_tokens", {
          method: "POST",
          body: JSON.stringify(messagesBody({ model: "primary-model", messages: [{ role: "user", content: "x".repeat(200) }] })),
        }),
        cfg,
        ctx,
      );
      const json = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(json.input_tokens).toBe(123);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://fallback.test/v1/messages/count_tokens");
      expect(calls[0].body.model).toBe("fallback-default");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("count_tokens does not run provider fallback after count-token upstream failure", async () => {
    const cfg = baseConfig();
    cfg.fallbackProviders = ["fallback"];
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const ctx = __requestLogTest.createRequestLog("/v1/messages/count_tokens", "POST", new Headers());
      const response = await __requestLogTest.handleCountTokens(
        new Request("http://127.0.0.1/v1/messages/count_tokens", { method: "POST", body: JSON.stringify(messagesBody()) }),
        cfg,
        ctx,
      );
      expect(response.status).toBe(429);
      expect(calls).toEqual(["https://primary.test/v1/messages/count_tokens"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
