import { afterEach, describe, expect, test } from "bun:test";
import { createResponsesAdapter } from "../src/adapters/openai-responses";
import { gatherRoutedModels } from "../src/claude-catalog";
import { parseMessagesRequest } from "../src/messages/parser";
import { buildModelsRequest, clearLoginState, OAUTH_PROVIDERS, startLoginFlow } from "../src/oauth";
import {
  CODEX_BACKEND_BASE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  codexAccountIdFromAccessToken,
  refreshCodexToken,
  requestCodexDeviceCode,
} from "../src/oauth/codex";
import type { FrogParsedRequest, FrogProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function codexToken(accountId = "acct-test"): string {
  return jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

function parsedRequest(): FrogParsedRequest {
  return {
    modelId: "gpt-5.5",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: true,
    options: { reasoning: "xhigh" },
    _rawBody: {
      model: "gpt-5.5",
      input: [{ role: "user", content: "hi" }],
      stream: true,
      max_output_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      tools: [],
      tool_choice: "auto",
      reasoning: { effort: "xhigh" },
      metadata: { session_id: "claude-session" },
      stop: ["END"],
      store: true,
    },
  };
}

describe("Codex OAuth provider", () => {
  test("extracts ChatGPT account id from Codex access token", () => {
    expect(codexAccountIdFromAccessToken(codexToken("acct-123"))).toBe("acct-123");
  });

  test("refreshes Codex OAuth tokens with the OpenAI device-code client id", async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({
        access_token: codexToken("acct-refresh"),
        refresh_token: "refresh-new",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const cred = await refreshCodexToken("refresh-old");

    expect(calls[0].url).toBe(CODEX_OAUTH_TOKEN_URL);
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-old");
    expect(params.get("client_id")).toBe(CODEX_OAUTH_CLIENT_ID);
    expect(cred.refresh).toBe("refresh-new");
    expect(cred.accountId).toBe("acct-refresh");
  });

  test("retries transient network failures while requesting a Codex device code", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("Unable to connect");
      return new Response(JSON.stringify({
        user_code: "RETRY-123",
        device_auth_id: "device-retry",
        interval: 5,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const device = await requestCodexDeviceCode();

    expect(calls).toBe(3);
    expect(device).toEqual({
      userCode: "RETRY-123",
      deviceAuthId: "device-retry",
      intervalMs: 5000,
    });
  });

  test("does not retry a rejected Codex device-code request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;

    await expect(requestCodexDeviceCode()).rejects.toThrow("Codex device-code request failed: 400");
    expect(calls).toBe(1);
  });

  test("builds Codex backend requests that Claude Code can route through", () => {
    const provider: FrogProviderConfig = {
      adapter: "openai-responses",
      baseUrl: CODEX_BACKEND_BASE_URL,
      authMode: "oauth",
      apiKey: codexToken("acct-route"),
    };
    const request = createResponsesAdapter(provider).buildRequest(parsedRequest(), { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(request.url).toBe(`${CODEX_BACKEND_BASE_URL}/responses`);
    expect(request.headers.Authorization).toBe(`Bearer ${provider.apiKey}`);
    expect(request.headers.originator).toBe("codex_cli_rs");
    expect(request.headers["ChatGPT-Account-ID"]).toBe("acct-route");
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.stop).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.store).toBe(false);
    expect((body.reasoning as Record<string, unknown>).effort).toBe("high");
  });

  test("allowlists Codex body fields for raw Responses payloads", () => {
    const provider: FrogProviderConfig = {
      adapter: "openai-responses",
      baseUrl: CODEX_BACKEND_BASE_URL,
      authMode: "oauth",
      apiKey: codexToken("acct-raw"),
    };
    const parsed: FrogParsedRequest = {
      modelId: "gpt-5.5",
      context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        instructions: "system",
        stream: true,
        tools: [
          { type: "function", name: "keep", description: "kept", parameters: { type: "object" }, strict: true },
          { type: "web_search_preview" },
          { type: "custom", name: "patch" },
        ],
        tool_choice: { type: "function", name: "keep" },
        parallel_tool_calls: true,
        previous_response_id: "resp_1",
        prompt_cache_key: "cache-key",
        user: "user-1",
        background: true,
        include: ["reasoning.encrypted_content"],
        prompt: { id: "prompt_1" },
        text: { format: { type: "json_object" } },
        truncation: "auto",
        metadata: { session_id: "claude-session" },
        stop: ["END"],
        max_output_tokens: 8,
        temperature: 0.7,
        store: true,
        future_public_param: true,
      },
    };

    const request = createResponsesAdapter(provider).buildRequest(parsed, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "input",
      "instructions",
      "model",
      "store",
      "stream",
      "tool_choice",
      "tools",
    ]);
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([
      { type: "function", name: "keep", description: "kept", parameters: { type: "object" }, strict: true },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", name: "keep" });
  });

  test("translates Claude Messages requests into Codex Responses calls", () => {
    const provider: FrogProviderConfig = {
      adapter: "openai-responses",
      baseUrl: CODEX_BACKEND_BASE_URL,
      authMode: "oauth",
      apiKey: codexToken("acct-messages"),
    };
    const parsed = parseMessagesRequest({
      model: "gpt-5.5",
      system: "You are concise.",
      messages: [{ role: "user", content: "Read the file." }],
      tools: [{
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
      tool_choice: { type: "auto" },
      thinking: { type: "enabled", budget_tokens: 20_000 },
      max_tokens: 2048,
      stream: true,
    });

    const request = createResponsesAdapter(provider).buildRequest(parsed, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(request.url).toBe(`${CODEX_BACKEND_BASE_URL}/responses`);
    expect(body.instructions).toBe("You are concise.");
    expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "Read the file." }] }]);
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.tools).toEqual([{
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }]);
    expect(body.tool_choice).toBe("auto");
    expect((body.reasoning as Record<string, unknown>).effort).toBe("high");
  });

  test("uses the Codex live model catalog endpoint", () => {
    const { url, headers } = buildModelsRequest({
      adapter: "openai-responses",
      baseUrl: CODEX_BACKEND_BASE_URL,
      authMode: "oauth",
    }, codexToken("acct-models"));

    expect(url).toBe(`${CODEX_BACKEND_BASE_URL}/models?client_version=1.0.0`);
    expect(headers.Authorization).toStartWith("Bearer ");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["ChatGPT-Account-ID"]).toBe("acct-models");
  });

  test("parses the Codex live model catalog shape", async () => {
    const calls: { url: string; headers?: HeadersInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers });
      return new Response(JSON.stringify({
        models: [
          { slug: "hidden-model", visibility: "hidden", priority: 1 },
          { slug: "gpt-live", visibility: "list", priority: 2, context_window: 123456 },
          { slug: "gpt-second", priority: 3 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 0,
      defaultProvider: "codex-test",
      providers: {
        "codex-test": {
          adapter: "openai-responses",
          baseUrl: CODEX_BACKEND_BASE_URL,
          apiKey: codexToken("acct-catalog"),
          models: ["gpt-fallback"],
          modelContextWindows: { "gpt-fallback": 456789 },
        },
      },
    });

    expect(calls[0].url).toBe(`${CODEX_BACKEND_BASE_URL}/models?client_version=1.0.0`);
    expect(models.some(model => model.id === "hidden-model")).toBe(false);
    expect(models.find(model => model.id === "gpt-live")?.contextWindow).toBe(123456);
    expect(models.find(model => model.id === "gpt-fallback")?.contextWindow).toBe(456789);
  });

  test("reuses an active GUI login payload instead of throwing already-in-progress", async () => {
    const provider = "__codex_retry_test__";
    (OAUTH_PROVIDERS as Record<string, unknown>)[provider] = {
      login: (ctrl: { onAuth?: (info: { url: string; instructions?: string; code?: string }) => void }) => {
        ctrl.onAuth?.({ url: "https://auth.example/device", instructions: "Enter code: TEST-123", code: "TEST-123" });
        return new Promise(() => {});
      },
      refresh: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
      providerConfig: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "model" },
      defaultModel: "model",
    };

    try {
      const first = await startLoginFlow(provider);
      const second = await startLoginFlow(provider);
      expect(second).toEqual(first);
      expect(second.code).toBe("TEST-123");
    } finally {
      clearLoginState(provider);
      delete (OAUTH_PROVIDERS as Record<string, unknown>)[provider];
    }
  });

  test("restarts an active GUI login with a fresh auth payload", async () => {
    const provider = "__codex_restart_test__";
    let loginCalls = 0;
    let aborts = 0;
    (OAUTH_PROVIDERS as Record<string, unknown>)[provider] = {
      login: (ctrl: { onAuth?: (info: { url: string; instructions?: string; code?: string }) => void; signal?: AbortSignal }) => {
        loginCalls += 1;
        const code = `RESTART-${loginCalls}`;
        ctrl.onAuth?.({ url: "https://auth.example/device", instructions: `Enter code: ${code}`, code });
        return new Promise((_, reject) => {
          ctrl.signal?.addEventListener("abort", () => {
            aborts += 1;
            reject(new Error("login aborted"));
          }, { once: true });
        });
      },
      refresh: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
      providerConfig: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "model" },
      defaultModel: "model",
    };

    try {
      const first = await startLoginFlow(provider);
      const second = await startLoginFlow(provider, { restart: true });
      const reused = await startLoginFlow(provider);
      await Bun.sleep(0);

      expect(first.code).toBe("RESTART-1");
      expect(second.code).toBe("RESTART-2");
      expect(reused).toEqual(second);
      expect(loginCalls).toBe(2);
      expect(aborts).toBe(1);
    } finally {
      clearLoginState(provider);
      delete (OAUTH_PROVIDERS as Record<string, unknown>)[provider];
    }
  });

  test("expires a stale GUI login before issuing a fresh auth payload", async () => {
    const provider = "__codex_stale_test__";
    let loginCalls = 0;
    (OAUTH_PROVIDERS as Record<string, unknown>)[provider] = {
      login: (ctrl: { onAuth?: (info: { url: string; code?: string }) => void; signal?: AbortSignal }) => {
        loginCalls += 1;
        ctrl.onAuth?.({ url: "https://auth.example/device", code: `STALE-${loginCalls}` });
        return new Promise((_, reject) => {
          ctrl.signal?.addEventListener("abort", () => reject(new Error("login aborted")), { once: true });
        });
      },
      refresh: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
      providerConfig: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "model" },
      defaultModel: "model",
    };

    let now = 1_000;
    try {
      const first = await startLoginFlow(provider, { now: () => now });
      now += 5 * 60_000;
      const second = await startLoginFlow(provider, { now: () => now });

      expect(first.code).toBe("STALE-1");
      expect(second.code).toBe("STALE-2");
      expect(loginCalls).toBe(2);
    } finally {
      clearLoginState(provider);
      delete (OAUTH_PROVIDERS as Record<string, unknown>)[provider];
    }
  });
  test("waits for the first auth payload when duplicate GUI login clicks race", async () => {
    const provider = "__codex_race_test__";
    let loginCalls = 0;
    (OAUTH_PROVIDERS as Record<string, unknown>)[provider] = {
      login: (ctrl: { onAuth?: (info: { url: string; instructions?: string; code?: string }) => void }) => {
        loginCalls += 1;
        setTimeout(() => ctrl.onAuth?.({
          url: "https://auth.example/device",
          instructions: "Enter code: RACE-123",
          code: "RACE-123",
        }), 0);
        return new Promise(() => {});
      },
      refresh: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
      providerConfig: { adapter: "openai-chat", baseUrl: "https://api.example/v1", authMode: "oauth", defaultModel: "model" },
      defaultModel: "model",
    };

    try {
      const [first, second] = await Promise.all([startLoginFlow(provider), startLoginFlow(provider)]);
      expect(first).toEqual(second);
      expect(first.code).toBe("RACE-123");
      expect(loginCalls).toBe(1);
    } finally {
      clearLoginState(provider);
      delete (OAUTH_PROVIDERS as Record<string, unknown>)[provider];
    }
  });
});
