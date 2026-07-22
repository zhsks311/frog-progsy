import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrogConfig } from "../src/types";

const previous = {
  frogHome: process.env.FROGPROGSY_HOME,
  claudeHome: process.env.CLAUDE_HOME,
  externalSupervisor: process.env.FROGP_EXTERNAL_SUPERVISOR,
};

afterEach(() => {
  if (previous.frogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previous.frogHome;
  if (previous.claudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = previous.claudeHome;
  if (previous.externalSupervisor === undefined) delete process.env.FROGP_EXTERNAL_SUPERVISOR;
  else process.env.FROGP_EXTERNAL_SUPERVISOR = previous.externalSupervisor;
});

async function freshServerModule(home: string, claudeHome: string) {
  process.env.FROGPROGSY_HOME = home;
  process.env.CLAUDE_HOME = claudeHome;
  return await import(`../src/server.ts?g006=${crypto.randomUUID()}`) as typeof import("../src/server");
}

function baseConfig(overrides: Partial<FrogConfig> = {}): FrogConfig {
  return {
    port: 4242,
    defaultProvider: "local",
    providers: {
      local: {
        adapter: "openai-chat",
        baseUrl: "https://provider.test/v1",
        apiKey: "sk-secret-provider-key",
        defaultModel: "gpt-test",
      },
    },
    ...overrides,
  };
}

describe("Claude status and provider connection management APIs", () => {
  test("/api/claude-status reports redacted injection/runtime/last-message status", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-g006-status-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-g006-claude-"));
    try {
      writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:4242/",
          ANTHROPIC_AUTH_TOKEN: "secret-token-must-not-leak",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      }), "utf8");
      const { __requestLogTest } = await freshServerModule(home, claudeHome);
      __requestLogTest.clear();
      const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers({ "content-length": "12" }));
      ctx.entry.route.provider = "local";
      ctx.entry.route.routedModelLabel = "gpt-test";
      ctx.entry.route.adapter = "openai-chat";
      ctx.entry.route.routeKind = "client-default";
      ctx.entry.upstream = { status: 200, contentTypeFamily: "json", requestBytes: 87, responseBytes: 32 };
      __requestLogTest.finalizeRequestLog(ctx, "completed", 200);

      const response = await __requestLogTest.handleManagementAPI(
        new Request("http://127.0.0.1/api/claude-status"),
        new URL("http://127.0.0.1/api/claude-status"),
        baseConfig(),
      );
      expect(response?.status).toBe(200);
      const json = await response!.json() as Record<string, any>;
      expect(json.claudeCode).toMatchObject({
        injected: true,
        expectedBaseUrl: "http://localhost:4242",
        actualBaseUrl: "http://localhost:4242",
        authToken: "set_redacted",
        settingsPath: "~/.claude/settings.json",
      });
      expect(json.lastMessages).toMatchObject({
        present: true,
        lifecycle: "completed",
        status: 200,
        route: { provider: "local", model: "gpt-test", adapter: "openai-chat" },
      });
      expect(json.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(json.runtime.watchdog.giveUp).toMatchObject({ present: false, unreadable: false });
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain("secret-token-must-not-leak");
      expect(serialized).not.toContain(claudeHome);
      expect(serialized).not.toContain(home);
      (ctx.entry as Record<string, unknown>).rawBody = "prompt text secret must not leak";
      (ctx.entry as Record<string, unknown>).headers = { Authorization: "Bearer secret" };
      const logsResponse = await __requestLogTest.handleManagementAPI(
        new Request("http://127.0.0.1/api/logs"),
        new URL("http://127.0.0.1/api/logs"),
        baseConfig(),
      );
      const logsSerialized = JSON.stringify(await logsResponse!.json());
      expect(logsSerialized).toContain("gpt-test");
      expect(logsSerialized).not.toContain("prompt text secret");
      expect(logsSerialized).not.toContain("Authorization");
      expect(logsSerialized).not.toContain("Bearer secret");
      const oauthResponse = await __requestLogTest.handleManagementAPI(
        new Request("http://127.0.0.1/api/oauth/status?provider=anthropic"),
        new URL("http://127.0.0.1/api/oauth/status?provider=anthropic"),
        baseConfig(),
      );
      const oauthJson = await oauthResponse!.json() as Record<string, unknown>;
      expect(Object.keys(oauthJson)).toEqual(["loggedIn"]);
      expect(oauthJson.loggedIn).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("provider connection test makes one minimal-token request and returns only enum metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-g006-provider-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-g006-provider-claude-"));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let upstreamBody: Record<string, any> | undefined;
    let upstreamAuthorization = "";
    try {
      const { __requestLogTest } = await freshServerModule(home, claudeHome);
      globalThis.fetch = (async (_url, init) => {
        calls++;
        upstreamAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;

      const response = await __requestLogTest.handleManagementAPI(
        new Request("http://127.0.0.1/api/providers/test", { method: "POST", body: JSON.stringify({ name: "local" }) }),
        new URL("http://127.0.0.1/api/providers/test"),
        baseConfig(),
      );
      const json = await response!.json() as Record<string, any>;
      expect(response?.status).toBe(200);
      expect(json).toMatchObject({ ok: true, code: "ok", provider: "local", model: "gpt-test", upstreamStatus: 200 });
      expect(calls).toBe(1);
      expect(upstreamAuthorization).toBe("Bearer sk-secret-provider-key");
      expect(upstreamBody).toMatchObject({ model: "gpt-test", max_tokens: 1, stream: false });
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain("sk-secret-provider-key");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("provider connection test uses clear error enum and does not retry non-2xx responses", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-g006-provider-fail-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-g006-provider-fail-claude-"));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      const { __requestLogTest } = await freshServerModule(home, claudeHome);
      globalThis.fetch = (async () => {
        calls++;
        return new Response("raw provider error must not leak", { status: 503, headers: { "content-type": "text/plain" } });
      }) as typeof fetch;
      const response = await __requestLogTest.handleManagementAPI(
        new Request("http://127.0.0.1/api/providers/test", { method: "POST", body: JSON.stringify({ name: "local" }) }),
        new URL("http://127.0.0.1/api/providers/test"),
        baseConfig(),
      );
      const json = await response!.json() as Record<string, any>;
      expect(response?.status).toBe(502);
      expect(json).toMatchObject({ ok: false, code: "provider_non_2xx", provider: "local", upstreamStatus: 503 });
      expect(calls).toBe(1);
      expect(JSON.stringify(json)).not.toContain("raw provider error");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});
