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
  testHome = mkdtempSync(join(tmpdir(), "frog-attempt-context-"));
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

function anthropicOk(text = "ok"): Response {
  return new Response(JSON.stringify({
    id: "msg_ok",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input_tokens: 4, output_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function openAiChatOk(text = "ok"): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl_ok",
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function providerFailure(status = 503): Response {
  return new Response(JSON.stringify({ error: { type: "server_error", message: "try fallback" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handle(config: FrogConfig, body: Record<string, unknown>): Promise<Response> {
  const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
  return __requestLogTest.handleMessages(
    new Request("http://127.0.0.1/v1/messages", { method: "POST", body: JSON.stringify(body) }),
    config,
    ctx,
  );
}

describe("AttemptContext isolation", () => {
  test("_rawBody and _messagesRawBody model are rewritten per attempt, not reused from primary", async () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "primary",
      fallbackProviders: ["fallback"],
      providers: {
        primary: {
          adapter: "anthropic",
          baseUrl: "https://primary.test",
          apiKey: "sk-primary",
          defaultModel: "primary-default",
          models: ["primary-routed", "primary-default"],
        },
        fallback: {
          adapter: "anthropic",
          baseUrl: "https://fallback.test",
          apiKey: "sk-fallback",
          defaultModel: "fallback-default",
          models: ["fallback-default"],
        },
      },
    };
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push({ url: String(url), body });
      return String(url).startsWith("https://primary.test") ? providerFailure(503) : anthropicOk("fallback isolated");
    }) as typeof fetch;

    try {
      const response = await handle(cfg, {
        model: "primary/primary-routed",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(response.status).toBe(200);
      expect(bodies.map(call => call.body.model)).toEqual(["primary-routed", "fallback-default"]);
      expect(bodies[1].body.model).not.toBe(bodies[0].body.model);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("native web_search decision is recomputed for fallback provider/model", async () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "primary",
      fallbackProviders: ["fallback"],
      providers: {
        primary: {
          adapter: "anthropic",
          baseUrl: "https://primary.test",
          apiKey: "sk-primary",
          defaultModel: "primary-search",
          models: ["primary-search"],
          modelCapabilities: { "primary-search": { input: ["text"], webSearch: true } },
        },
        fallback: {
          adapter: "anthropic",
          baseUrl: "https://fallback.test",
          apiKey: "sk-fallback",
          defaultModel: "fallback-no-search",
          models: ["fallback-no-search"],
          modelCapabilities: { "fallback-no-search": { input: ["text"], webSearch: false } },
        },
      },
    };
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return String(url).startsWith("https://primary.test") ? providerFailure(503) : anthropicOk("fallback no native search");
    }) as typeof fetch;

    try {
      const response = await handle(cfg, {
        model: "primary/primary-search",
        max_tokens: 10,
        messages: [{ role: "user", content: "search docs" }],
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 1 },
          { name: "read_file", description: "Read", input_schema: { type: "object" } },
        ],
      });
      expect(response.status).toBe(200);
      expect((bodies[0].body.tools as unknown[]).map(tool => (tool as Record<string, unknown>).name ?? (tool as Record<string, unknown>).type)).toEqual([
        "web_search",
        "read_file",
      ]);
      expect(bodies).toHaveLength(1);
      const [entry] = __requestLogTest.requestLogSnapshot();
      expect(entry.fallbacks?.webSearch).toMatchObject({ planned: true, status: "error", tier: "unavailable" });
      expect(entry.attempts?.some(attempt => attempt.provider === "fallback" && attempt.code === "web_search_unavailable")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("wire protocol override is recomputed and does not leak into fallback", async () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "opencode-go",
      fallbackProviders: ["fallback-chat"],
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://primary-chat.test/v1",
          apiKey: "sk-primary",
          defaultModel: "minimax-m2.5",
          models: ["minimax-m2.5"],
        },
        "fallback-chat": {
          adapter: "openai-chat",
          baseUrl: "https://fallback-chat.test/v1",
          apiKey: "sk-fallback",
          defaultModel: "fallback-chat-model",
          models: ["fallback-chat-model"],
        },
      },
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return String(url).includes("primary-chat.test") ? providerFailure(503) : openAiChatOk("chat fallback");
    }) as typeof fetch;

    try {
      const response = await handle(cfg, {
        model: "opencode-go/minimax-m2.5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(response.status).toBe(200);
      expect(calls.map(call => call.url)).toEqual([
        "https://primary-chat.test/v1/messages",
        "https://fallback-chat.test/v1/chat/completions",
      ]);
      expect(calls[0].body.max_tokens).toBe(10);
      expect(calls[0].body.messages).toEqual([{ role: "user", content: "hello" }]);
      expect(calls[1].body.model).toBe("fallback-chat-model");
      expect(calls[1].body.messages).toEqual([{ role: "user", content: "hello" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("image fallback preprocessing on primary is not reused by image-capable fallback", async () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "primary",
      fallbackProviders: ["fallback-vision"],
      providers: {
        primary: {
          adapter: "anthropic",
          baseUrl: "https://primary.test",
          apiKey: "sk-primary",
          defaultModel: "text-only",
          models: ["text-only"],
          modelCapabilities: { "text-only": { input: ["text"], imageFallback: "describe" } },
        },
        "fallback-vision": {
          adapter: "openai-chat",
          baseUrl: "https://fallback-vision.test/v1",
          apiKey: "sk-fallback",
          defaultModel: "vision-model",
          models: ["vision-model"],
          modelCapabilities: { "vision-model": { input: ["text", "image"] } },
        },
        visionHelper: {
          adapter: "openai-responses",
          baseUrl: "https://vision-helper.test/v1",
          apiKey: "sk-vision",
          defaultModel: "vision-helper-model",
          models: ["vision-helper-model"],
          modelCapabilities: { "vision-helper-model": { input: ["text", "image"] } },
        },
      },
      imageFallback: { enabled: true, provider: "visionHelper", model: "vision-helper-model" },
    };
    const mainCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const urlString = String(url);
      if (urlString.startsWith("https://vision-helper.test")) {
        const sse = [
          "event: response.output_text.delta",
          "data: {\"type\":\"response.output_text.delta\",\"delta\":\"described image text\"}",
          "",
          "event: response.completed",
          "data: {\"type\":\"response.completed\",\"response\":{}}",
          "",
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      mainCalls.push({ url: urlString, body });
      return urlString.startsWith("https://primary.test") ? providerFailure(503) : openAiChatOk("vision fallback ok");
    }) as typeof fetch;

    try {
      const response = await handle(cfg, {
        model: "primary/text-only",
        max_tokens: 10,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
          ],
        }],
      });
      expect(response.status).toBe(200);
      expect(mainCalls.map(call => call.url)).toEqual([
        "https://primary.test/v1/messages",
        "https://fallback-vision.test/v1/chat/completions",
      ]);
      expect(JSON.stringify(mainCalls[0].body)).toContain("described image text");
      const fallbackBody = JSON.stringify(mainCalls[1].body);
      expect(fallbackBody).toContain("image_url");
      expect(fallbackBody).toContain("data:image/png;base64,aW1hZ2U=");
      expect(fallbackBody).not.toContain("described image text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
