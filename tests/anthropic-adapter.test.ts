import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseMessagesRequest } from "../src/messages/parser";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth/anthropic";
import type { AdapterEvent } from "../src/types";

/**
 * `authMode: "claude-grant"` resolves an isolated, config-dir-scoped Claude subscription Bearer
 * token into `provider.apiKey`, exactly like stored `oauth`. The Anthropic adapter must therefore
 * emit a wire-identical request for both: Bearer Authorization, the OAuth `anthropic-beta` marker,
 * the Claude Code identity system block, and `proxy_`-prefixed custom tool names (stripped on the
 * way back). `key`/`forward` keep their existing header + tool-name behavior, and a resolved Bearer
 * identity is never shadowed or duplicated by a custom `x-api-key`/`Authorization` header.
 *
 * All credential values below are synthetic placeholders — no real tokens or user paths.
 */

const GRANT_TOKEN = "grant-subscription-bearer";
const OAUTH_TOKEN = "oauth-subscription-bearer";
const STATIC_KEY = "static-api-key";

const grantProvider = {
  adapter: "anthropic",
  baseUrl: "https://example.test",
  authMode: "claude-grant" as const,
  apiKey: GRANT_TOKEN,
  claudeGrantId: "cg_isolated_test",
};
const oauthProvider = {
  adapter: "anthropic",
  baseUrl: "https://example.test",
  authMode: "oauth" as const,
  apiKey: OAUTH_TOKEN,
};
const keyProvider = {
  adapter: "anthropic",
  baseUrl: "https://example.test",
  apiKey: STATIC_KEY,
};
const forwardProvider = {
  adapter: "anthropic",
  baseUrl: "https://example.test",
  authMode: "forward" as const,
};

type BuiltRequest = { url: string; headers: Record<string, string>; body: string };

function parsedRequest(body: Record<string, unknown> = {}) {
  return parseMessagesRequest({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Solve the hat puzzle." }],
    stream: false,
    max_tokens: 300,
    ...body,
  });
}

function build(
  provider: Parameters<typeof createAnthropicAdapter>[0],
  body: Record<string, unknown> = {},
  incoming?: Record<string, string>,
) {
  const adapter = createAnthropicAdapter(provider);
  const meta = incoming ? { headers: new Headers(incoming) } : undefined;
  const request = adapter.buildRequest(parsedRequest(body), meta) as BuiltRequest;
  return { url: request.url, headers: request.headers, body: JSON.parse(request.body) as Record<string, unknown> };
}

function weatherTool() {
  return { name: "get_weather", description: "Report the weather.", input_schema: { type: "object" } };
}

describe("claude-grant shares the Claude OAuth subscription wire identity", () => {
  test("sends a Bearer Authorization, oauth beta, and the identity system block (no x-api-key)", () => {
    const { url, headers, body } = build(grantProvider);
    expect(url).toBe("https://example.test/v1/messages");
    expect(headers.Authorization).toBe(`Bearer ${GRANT_TOKEN}`);
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(headers["x-api-key"]).toBeUndefined();
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
  });

  test("preserves the caller system prompt after the identity block", () => {
    const { body } = build(grantProvider, { system: "Answer tersely." });
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system).toHaveLength(2);
    expect(system[0]!.text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect(system[1]!.text).toContain("Answer tersely.");
  });

  test("does not duplicate the identity when the caller system already starts with it", () => {
    const { body } = build(grantProvider, { system: `${CLAUDE_CODE_SYSTEM_INSTRUCTION}\nExtra caller instructions.` });
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system).toHaveLength(1);
    expect(system[0]!.text.startsWith(CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(true);
    expect(system[0]!.text).toContain("Extra caller instructions.");
  });

  test("prepends the oauth beta marker to an incoming anthropic-beta instead of replacing it", () => {
    const { headers } = build(grantProvider, {}, { "anthropic-beta": "context-1m-2025-08-07" });
    expect(headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},context-1m-2025-08-07`);
  });

  test("prefixes custom tool names on the wire (toWire) and exempts Anthropic builtins", () => {
    const { body } = build(grantProvider, { tools: [weatherTool(), { name: "web_search", input_schema: {} }] });
    const tools = body.tools as Array<{ name: string }>;
    expect(tools.map(t => t.name)).toEqual(["proxy_get_weather", "web_search"]);
  });

  test("strips the proxy_ prefix from a non-streaming tool_use response (fromWire)", async () => {
    const adapter = createAnthropicAdapter(grantProvider);
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "proxy_get_weather", input: { city: "x" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 7 },
    })));
    expect(events.find(e => e.type === "tool_call_start")).toMatchObject({ id: "toolu_1", name: "get_weather" });
  });

  test("strips the proxy_ prefix from a streamed tool_use response (fromWire)", async () => {
    const adapter = createAnthropicAdapter(grantProvider);
    const response = new Response([
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_2","name":"proxy_get_weather"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
    ].join(""));
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events.find(e => e.type === "tool_call_start")).toMatchObject({ id: "toolu_2", name: "get_weather" });
  });

  test("is byte-for-byte wire-identical to oauth for the same resolved token", () => {
    const grantBase = { adapter: "anthropic", baseUrl: "https://example.test", authMode: "claude-grant" as const, apiKey: "shared-bearer", claudeGrantId: "cg_x" };
    const oauthBase = { adapter: "anthropic", baseUrl: "https://example.test", authMode: "oauth" as const, apiKey: "shared-bearer" };
    const cases: Array<{ body?: Record<string, unknown>; incoming?: Record<string, string> }> = [
      {},
      { body: { system: "Answer tersely." } },
      { body: { tools: [weatherTool()] } },
      { incoming: { "anthropic-beta": "context-1m-2025-08-07", "anthropic-version": "2024-10-22" } },
    ];
    for (const c of cases) {
      const grant = build(grantBase, c.body, c.incoming);
      const oauth = build(oauthBase, c.body, c.incoming);
      expect(grant.url).toBe(oauth.url);
      expect(grant.headers).toEqual(oauth.headers);
      expect(grant.body).toEqual(oauth.body);
    }
  });
});

describe("static key and forward auth remain unchanged", () => {
  test("static key mode keeps x-api-key, plain system, and unprefixed tool names", () => {
    const { headers, body } = build(keyProvider, { system: "Answer tersely.", tools: [weatherTool()] });
    expect(headers["x-api-key"]).toBe(STATIC_KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.system).toBe("Answer tersely.");
    const tools = body.tools as Array<{ name: string }>;
    expect(tools[0]!.name).toBe("get_weather");
  });

  test("forward mode relays a caller x-api-key without adopting the oauth shape", () => {
    const { headers, body } = build(forwardProvider, { system: "Answer tersely." }, { "x-api-key": "sk-ant-forwarded" });
    expect(headers["x-api-key"]).toBe("sk-ant-forwarded");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.system).toBe("Answer tersely.");
  });
});

describe("custom credential headers never shadow a resolved Bearer identity", () => {
  test("grant mode drops a custom x-api-key so no double credential is emitted", () => {
    const { headers } = build({ ...grantProvider, headers: { "x-api-key": "attacker-injected-key" } });
    expect(headers.Authorization).toBe(`Bearer ${GRANT_TOKEN}`);
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("grant mode drops a custom Authorization header (case-insensitive) and keeps the grant Bearer", () => {
    const { headers } = build({ ...grantProvider, headers: { authorization: "Bearer attacker-token" } });
    expect(headers.Authorization).toBe(`Bearer ${GRANT_TOKEN}`);
    expect(headers.authorization).toBeUndefined();
  });

  test("grant mode drops a mixed-case X-Api-Key header", () => {
    const { headers } = build({ ...grantProvider, headers: { "X-Api-Key": "attacker-injected-key" } });
    expect(headers.Authorization).toBe(`Bearer ${GRANT_TOKEN}`);
    expect(headers["X-Api-Key"]).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("oauth mode applies the same credential-header isolation", () => {
    const { headers } = build({ ...oauthProvider, headers: { "x-api-key": "attacker-injected-key" } });
    expect(headers.Authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("grant mode still applies non-credential custom headers", () => {
    const { headers } = build({ ...grantProvider, headers: { "x-trace-id": "trace-123" } });
    expect(headers["x-trace-id"]).toBe("trace-123");
    expect(headers.Authorization).toBe(`Bearer ${GRANT_TOKEN}`);
  });

  test("static key mode preserves the existing custom-header override (no protection)", () => {
    const { headers } = build({ ...keyProvider, headers: { "x-api-key": "operator-override-key" } });
    expect(headers["x-api-key"]).toBe("operator-override-key");
    expect(headers.Authorization).toBeUndefined();
  });
});
