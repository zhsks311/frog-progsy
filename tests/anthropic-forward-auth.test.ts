import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseMessagesRequest } from "../src/messages/parser";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth/anthropic";

/**
 * Anthropic rejects subscription Bearer tokens whose first system block is not the Claude Code
 * identity — surfaced upstream as a misleading 429 rate_limit_error. Forward-mode requests that
 * relay a real Bearer token must therefore use the same request shape as oauth mode (identity
 * system block + oauth beta header), while API-key forwarding stays untouched.
 */

const forwardProvider = { adapter: "anthropic", baseUrl: "https://example.test", authMode: "forward" as const };

function parsedRequest(body: Record<string, unknown> = {}) {
  return parseMessagesRequest({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Solve the hat puzzle." }],
    stream: false,
    max_tokens: 300,
    ...body,
  });
}

function buildForward(incoming: Record<string, string>, body: Record<string, unknown> = {}) {
  const adapter = createAnthropicAdapter(forwardProvider);
  const request = adapter.buildRequest(parsedRequest(body), { headers: new Headers(incoming) }) as {
    headers: Record<string, string>;
    body: string;
  };
  return { headers: request.headers, body: JSON.parse(request.body) as Record<string, unknown> };
}

describe("Anthropic forward auth (header relay)", () => {
  test("forwards real Anthropic auth headers and version to the Messages API", () => {
    const adapter = createAnthropicAdapter(forwardProvider);
    const request = adapter.buildRequest(parsedRequest(), {
      headers: new Headers({
        authorization: "Bearer real-anthropic-token",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "computer-use-2025-01-24",
      }),
    }) as { url: string; headers: Record<string, string> };

    expect(request.url).toBe("https://example.test/v1/messages");
    expect(request.headers.Authorization).toBe("Bearer real-anthropic-token");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    // A forwarded Bearer is a subscription token: the oauth beta marker is prepended to the
    // caller's beta list (behavior change with the forward-mode oauth-shape fix).
    expect(request.headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},computer-use-2025-01-24`);
    expect(request.headers["x-api-key"]).toBeUndefined();
  });

  test("does not leak the local proxy auth sentinel upstream", () => {
    const { headers } = buildForward({ authorization: "Bearer local-frogprogsy" });
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("drops credential-less authorization values instead of forwarding garbage", () => {
    for (const authorization of ["Bearer", "Bearer   ", "   ", "basic "]) {
      const { headers, body } = buildForward({ authorization });
      expect(headers.Authorization).toBeUndefined();
      // No credential means no oauth request shape either.
      expect(body.system).toBeUndefined();
    }
  });

  test("forwards Anthropic x-api-key when supplied by the caller", () => {
    const { headers } = buildForward({ "x-api-key": "sk-ant-real" });
    expect(headers["x-api-key"]).toBe("sk-ant-real");
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("anthropic forward-mode Bearer requests use the Claude OAuth shape", () => {
  test("forwarded Bearer token prepends the identity system block and oauth beta", () => {
    const { headers, body } = buildForward({ authorization: "Bearer real-subscription-token" });
    expect(headers.Authorization).toBe("Bearer real-subscription-token");
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
  });

  test("caller system prompt is preserved after the identity block", () => {
    const { body } = buildForward(
      { authorization: "Bearer real-subscription-token" },
      { system: "Answer tersely." },
    );
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system).toHaveLength(2);
    expect(system[0]!.text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect(system[1]!.text).toContain("Answer tersely.");
  });

  test("system already starting with the identity is not duplicated", () => {
    const { body } = buildForward(
      { authorization: "Bearer real-subscription-token" },
      { system: `${CLAUDE_CODE_SYSTEM_INSTRUCTION}\nExtra caller instructions.` },
    );
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system).toHaveLength(1);
    expect(system[0]!.text.startsWith(CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(true);
    expect(system[0]!.text).toContain("Extra caller instructions.");
  });

  test("incoming anthropic-beta gains the oauth marker instead of being replaced", () => {
    const { headers } = buildForward({
      authorization: "Bearer real-subscription-token",
      "anthropic-beta": "context-1m-2025-08-07",
    });
    expect(headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},context-1m-2025-08-07`);
  });

  test("forwarded x-api-key does not get the oauth shape", () => {
    const { headers, body } = buildForward({ "x-api-key": "sk-ant-real-key" }, { system: "Answer tersely." });
    expect(headers["x-api-key"]).toBe("sk-ant-real-key");
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.system).toBe("Answer tersely.");
  });

  test("placeholder local-frogprogsy bearer is not treated as a subscription token", () => {
    const { headers, body } = buildForward({ authorization: "Bearer local-frogprogsy" });
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.system).toBeUndefined();
  });

  test("oauth mode keeps its existing identity-block behavior", () => {
    const adapter = createAnthropicAdapter({
      adapter: "anthropic",
      baseUrl: "https://example.test",
      authMode: "oauth" as const,
      apiKey: "oauth-access-token",
    });
    const request = adapter.buildRequest(parsedRequest()) as { headers: Record<string, string>; body: string };
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(request.headers.Authorization).toBe("Bearer oauth-access-token");
    expect(request.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
  });
});
