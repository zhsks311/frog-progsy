import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ClaudeGrantProbeError,
  runClaudeGrantLiveProbe,
  type ProbeFetch,
  type GrantAccessTokenResolver,
} from "../src/claude-grant-probe";
import { ClaudeGrantError } from "../src/claude-grant-auth";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth/anthropic";
import { assertAllowedClaudeGrantTarget } from "../src/provider-auth";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

// A planted access token that must NEVER appear in any result, error message, or log.
const TOKEN = "PLANTED-ACCESS-TOKEN-DO-NOT-LEAK-abcdef0123456789";
const BASE = "https://api.anthropic.com";

const config: FrogConfig = { port: 10100, defaultProvider: "cg", providers: {} };

function makeProvider(over: Partial<FrogProviderConfig> = {}): FrogProviderConfig {
  return { adapter: "anthropic", baseUrl: BASE, authMode: "claude-grant", claudeGrantId: "cg_probe1", ...over };
}

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}
interface ProbeReturn {
  ok: boolean;
  status: number;
  body?: string;
}
type Handler = (call: FetchCall) => ProbeReturn | Promise<ProbeReturn>;

function probeFetch(handler: Handler) {
  const calls: FetchCall[] = [];
  const fn = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, init });
    const res = await handler({ url, init });
    return { ok: res.ok, status: res.status, text: async () => res.body ?? "" };
  }) as ProbeFetch & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

function modelsBody(ids: string[]): string {
  return JSON.stringify({ data: ids.map(id => ({ id, type: "model", display_name: id })), has_more: false });
}

const okMessage = JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: "max_tokens" });

async function expectProbeError(promise: Promise<unknown>, code: ClaudeGrantProbeError["code"]): Promise<ClaudeGrantProbeError> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ClaudeGrantProbeError);
  expect((error as ClaudeGrantProbeError).code).toBe(code);
  return error as ClaudeGrantProbeError;
}

function leak(error: ClaudeGrantProbeError): string {
  return `${error.message}\n${error.stack ?? ""}\n${String(error)}`;
}

const resolver = async () => TOKEN;

// ── happy path: two real surfaces, OAuth wire shape, redacted metadata ────────

describe("runClaudeGrantLiveProbe success", () => {
  test("exercises GET /v1/models then POST /v1/messages with OAuth headers + identity body", async () => {
    const fetch = probeFetch(call =>
      call.url.endsWith("/v1/models")
        ? { ok: true, status: 200, body: modelsBody(["claude-z-1", "claude-a-1"]) }
        : { ok: true, status: 200, body: okMessage });

    const result = await runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.messageStatus).toBe(200);
    expect(result.modelCount).toBe(2);
    // Deterministic: no configured model → lexicographically-first response id.
    expect(result.modelId).toBe("claude-a-1");
    expect(result.tokenFingerprint).toEqual({
      sha256_8: createHash("sha256").update(TOKEN).digest("hex").slice(0, 8),
      length: TOKEN.length,
    });

    // Exactly two calls, in order, both against the provider base with the bound Bearer only.
    expect(fetch.calls.length).toBe(2);
    const [get, post] = fetch.calls;

    expect(get.url).toBe(`${BASE}/v1/models`);
    expect(get.init.method).toBe("GET");
    expect(get.init.body).toBeUndefined();
    expect(get.init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(get.init.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(get.init.headers["anthropic-version"]).toBe("2023-06-01");

    expect(post.url).toBe(`${BASE}/v1/messages`);
    expect(post.init.method).toBe("POST");
    expect(post.init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(post.init.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(post.init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(post.init.body!);
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe("claude-a-1");
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);

    // No fallback credential: no api-key header anywhere, only the Bearer identity.
    for (const call of fetch.calls) {
      expect(call.init.headers["x-api-key"]).toBeUndefined();
      expect(call.init.headers["api-key"]).toBeUndefined();
    }

    // Redaction: the raw token never appears in the returned metadata.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test("normalizes a base URL that already ends in /v1", async () => {
    const fetch = probeFetch(call =>
      call.url.endsWith("/v1/models")
        ? { ok: true, status: 200, body: modelsBody(["m"]) }
        : { ok: true, status: 200, body: okMessage });
    await runClaudeGrantLiveProbe(config, "cg", makeProvider({ baseUrl: "https://api.anthropic.com/v1" }), { getAccessToken: resolver, fetch });
    expect(fetch.calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(fetch.calls[1].url).toBe("https://api.anthropic.com/v1/messages");
  });

  test("model selection: configured defaultModel > configured models > sorted response id", async () => {
    // defaultModel wins.
    let fetch = probeFetch(call => call.url.endsWith("/v1/models") ? { ok: true, status: 200, body: modelsBody(["a", "b"]) } : { ok: true, status: 200, body: okMessage });
    let result = await runClaudeGrantLiveProbe(config, "cg", makeProvider({ defaultModel: "cfg-default" }), { getAccessToken: resolver, fetch });
    expect(result.modelId).toBe("cfg-default");
    expect(JSON.parse(fetch.calls[1].init.body!).model).toBe("cfg-default");

    // First configured models entry wins next.
    fetch = probeFetch(call => call.url.endsWith("/v1/models") ? { ok: true, status: 200, body: modelsBody(["a", "b"]) } : { ok: true, status: 200, body: okMessage });
    result = await runClaudeGrantLiveProbe(config, "cg", makeProvider({ models: ["cfg-first", "cfg-second"] }), { getAccessToken: resolver, fetch });
    expect(result.modelId).toBe("cfg-first");

    // Else deterministic lexicographic pick from the response.
    fetch = probeFetch(call => call.url.endsWith("/v1/models") ? { ok: true, status: 200, body: modelsBody(["m-9", "m-1", "m-5"]) } : { ok: true, status: 200, body: okMessage });
    result = await runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch });
    expect(result.modelId).toBe("m-1");
  });
});

// ── fail-closed: every HTTP / network / parse failure is a typed error, no leak ─

describe("runClaudeGrantLiveProbe fails closed", () => {
  test("not_bound from the token resolver makes ZERO network calls", async () => {
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    const err = await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider({ claudeGrantId: undefined }), {
        getAccessToken: async () => { throw new ClaudeGrantError("not_bound", "provider not bound"); },
        fetch,
      }),
      "not_bound",
    );
    expect(fetch.calls.length).toBe(0);
    expect(leak(err)).not.toContain(TOKEN);
  });

  test("a non-not_bound token failure is token_unavailable with ZERO network calls", async () => {
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider(), {
        getAccessToken: async () => { throw new ClaudeGrantError("no_credential", "no cred", "cg_probe1"); },
        fetch,
      }),
      "token_unavailable",
    );
    expect(fetch.calls.length).toBe(0);
  });

  test("GET /v1/models non-2xx fails closed and never sends the message probe", async () => {
    const fetch = probeFetch(() => ({ ok: false, status: 401, body: JSON.stringify({ error: { message: TOKEN } }) }));
    const err = await expectProbeError(runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch }), "models_request_failed");
    expect(fetch.calls.length).toBe(1); // no POST after a failed GET — no fallback
    expect(leak(err)).not.toContain(TOKEN);
  });

  test("GET /v1/models network error fails closed", async () => {
    const fetch = probeFetch(call => { if (call.url.endsWith("/v1/models")) throw new Error(`ECONNRESET ${TOKEN}`); return { ok: true, status: 200, body: okMessage }; });
    const err = await expectProbeError(runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch }), "models_request_failed");
    expect(fetch.calls.length).toBe(1);
    expect(leak(err)).not.toContain(TOKEN);
  });

  test("unreadable /v1/models JSON fails closed as models_unreadable, no message probe", async () => {
    const fetch = probeFetch(call => call.url.endsWith("/v1/models") ? { ok: true, status: 200, body: "not-json <<<" } : { ok: true, status: 200, body: okMessage });
    await expectProbeError(runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch }), "models_unreadable");
    expect(fetch.calls.length).toBe(1);
  });

  test("no selectable model fails closed as no_model, no message probe", async () => {
    const fetch = probeFetch(() => ({ ok: true, status: 200, body: modelsBody([]) }));
    await expectProbeError(runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch }), "no_model");
    expect(fetch.calls.length).toBe(1);
  });

  test("POST /v1/messages non-2xx fails closed as message_request_failed with no fallback retry", async () => {
    const fetch = probeFetch(call => call.url.endsWith("/v1/models")
      ? { ok: true, status: 200, body: modelsBody(["a"]) }
      : { ok: false, status: 429, body: JSON.stringify({ error: { message: TOKEN } }) });
    const err = await expectProbeError(runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch }), "message_request_failed");
    // Exactly the two intended calls: one GET, one POST — never a third fallback attempt.
    expect(fetch.calls.length).toBe(2);
    for (const call of fetch.calls) {
      expect(call.init.headers["x-api-key"]).toBeUndefined();
      expect(call.init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    }
    expect(leak(err)).not.toContain(TOKEN);
  });

  test("POST /v1/messages network error fails closed", async () => {
    const fetch = probeFetch(call => {
      if (call.url.endsWith("/v1/models")) return { ok: true, status: 200, body: modelsBody(["a"]) };
      throw new Error(`socket hang up ${TOKEN}`);
    });
    const err = await expectProbeError(runClaudeGrantLiveProbe(config, "cg", makeProvider(), { getAccessToken: resolver, fetch }), "message_request_failed");
    expect(fetch.calls.length).toBe(2);
    expect(leak(err)).not.toContain(TOKEN);
  });
});

// ── pre-broker target guard: authMode + official Anthropic endpoint, zero-call ─

describe("runClaudeGrantLiveProbe target guard runs before the broker", () => {
  // A resolver that records whether it was ever reached (must stay 0 when the guard rejects).
  function trackedResolver() {
    const state = { calls: 0 };
    const fn = (async () => { state.calls++; return TOKEN; }) as GrantAccessTokenResolver & { state: { calls: number } };
    fn.state = state;
    return fn;
  }

  test("authMode other than claude-grant is not_bound with zero broker/network calls", async () => {
    const getAccessToken = trackedResolver();
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    const err = await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider({ authMode: "forward" }), { getAccessToken, fetch }),
      "not_bound",
    );
    expect(getAccessToken.state.calls).toBe(0);
    expect(fetch.calls.length).toBe(0);
    expect(leak(err)).not.toContain(TOKEN);
  });

  test("a non-anthropic adapter is invalid_target with zero broker/network calls", async () => {
    const getAccessToken = trackedResolver();
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    const err = await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider({ adapter: "openai-chat" }), { getAccessToken, fetch }),
      "invalid_target",
    );
    expect(getAccessToken.state.calls).toBe(0);
    expect(fetch.calls.length).toBe(0);
    expect(leak(err)).not.toContain(TOKEN);
  });

  test("a non-https scheme is invalid_target with zero broker/network calls", async () => {
    const getAccessToken = trackedResolver();
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider({ baseUrl: "http://api.anthropic.com" }), { getAccessToken, fetch }),
      "invalid_target",
    );
    expect(getAccessToken.state.calls).toBe(0);
    expect(fetch.calls.length).toBe(0);
  });

  test("a custom (non-api.anthropic.com) host is invalid_target with zero broker/network calls", async () => {
    const getAccessToken = trackedResolver();
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider({ baseUrl: "https://gateway.not-anthropic.io" }), { getAccessToken, fetch }),
      "invalid_target",
    );
    expect(getAccessToken.state.calls).toBe(0);
    expect(fetch.calls.length).toBe(0);
  });

  test("a disallowed path is invalid_target with zero broker/network calls", async () => {
    const getAccessToken = trackedResolver();
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider({ baseUrl: "https://api.anthropic.com/v1/beta" }), { getAccessToken, fetch }),
      "invalid_target",
    );
    expect(getAccessToken.state.calls).toBe(0);
    expect(fetch.calls.length).toBe(0);
  });

  test("an embedded credential in the base URL is invalid_target and never leaked", async () => {
    const getAccessToken = trackedResolver();
    const fetch = probeFetch(() => { throw new Error("must not fetch"); });
    const err = await expectProbeError(
      runClaudeGrantLiveProbe(config, "cg", makeProvider({ baseUrl: "https://prober:PLANTED-URL-PASSWORD-LEAK@api.anthropic.com" }), { getAccessToken, fetch }),
      "invalid_target",
    );
    expect(getAccessToken.state.calls).toBe(0);
    expect(fetch.calls.length).toBe(0);
    // The fixed, redacted error must not surface the rejected URL or its embedded credential.
    expect(leak(err)).not.toContain("PLANTED-URL-PASSWORD-LEAK");
    expect(leak(err)).not.toContain("api.anthropic.com");
  });

  test("an injected validateTarget seam can admit a reserved-host fixture and the probe proceeds", async () => {
    const getAccessToken = trackedResolver();
    const fetch = probeFetch(call =>
      call.url.endsWith("/v1/models")
        ? { ok: true, status: 200, body: modelsBody(["claude-x"]) }
        : { ok: true, status: 200, body: okMessage });
    const result = await runClaudeGrantLiveProbe(config, "cg", makeProvider({ baseUrl: "https://api.gateway.test" }), {
      getAccessToken,
      fetch,
      validateTarget: provider => assertAllowedClaudeGrantTarget(provider, { allowReservedTestHosts: true }),
    });
    expect(result.ok).toBe(true);
    expect(getAccessToken.state.calls).toBe(1);
    expect(fetch.calls.length).toBe(2);
    expect(fetch.calls[0].url).toBe("https://api.gateway.test/v1/models");
  });
});
