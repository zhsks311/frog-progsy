import { describe, expect, test } from "bun:test";
import {
  analyzeRequest,
  assertNoLeak,
  buildProbeCache,
  buildTokenFreeEnv,
  buildNativeEnv,
  CACHE_SCHEMA,
  computeVerdict,
  fingerprint,
  FORBIDDEN_AUTH_ENV,
  parseMcpConnectors,
  PROBE_MODEL_DISPLAY,
  PROBE_MODEL_ID,
  redactHash,
  sanitize,
  SENTINEL,
  serializeProbeCache,
  type Gate,
} from "../scripts/claude-passthrough-probe";

const TOKEN = "sk-ant-oat01-PLANTED-ACCESS-TOKEN-DO-NOT-LEAK-abcdef0123456789";

describe("fingerprint / redaction", () => {
  test("fingerprint is sha256[:8]:byteLength and never contains the raw value", () => {
    const fp = fingerprint(TOKEN);
    expect(fp).toMatch(/^[0-9a-f]{8}:\d+$/);
    expect(fp).not.toContain("PLANTED");
    const [, len] = fp.split(":");
    expect(Number(len)).toBe(Buffer.byteLength(TOKEN, "utf8"));
  });

  test("redactHash exposes only sha256_8 + length", () => {
    const r = redactHash(TOKEN);
    expect(r.sha256_8).toMatch(/^[0-9a-f]{8}$/);
    expect(r.length).toBe(Buffer.byteLength(TOKEN, "utf8"));
    expect(JSON.stringify(r)).not.toContain("PLANTED");
  });

  test("sanitize redacts secrets, home, username, and long token runs", () => {
    const out = sanitize(`home=/Users/alice token=${TOKEN} user=alice`, ["/Users/alice", "alice"]);
    expect(out).not.toContain("/Users/alice");
    expect(out).not.toContain("PLANTED");
    expect(out).toContain("<redacted");
  });

  test("assertNoLeak throws on planted secret, JWT, or PEM", () => {
    expect(() => assertNoLeak(`{"x":"${TOKEN}"}`, [TOKEN])).toThrow();
    expect(() => assertNoLeak('{"x":"eyJhbGciOiJIUzI1Niature.payloadsegmenthere"}', [])).toThrow();
    expect(() => assertNoLeak('{"x":"-----BEGIN PRIVATE KEY-----"}', [])).toThrow();
    expect(() => assertNoLeak('{"ok":true,"fp":"deadbeef:108"}', [TOKEN])).not.toThrow();
  });
});

describe("probe cache schema (exact P1 byte shape)", () => {
  test("shape is {baseUrl,fetchedAt,models:[{id,display_name}]}", () => {
    const cache = buildProbeCache("http://127.0.0.1:5555", 1234);
    expect(Object.keys(cache)).toEqual(["baseUrl", "fetchedAt", "models"]);
    expect(cache.models).toEqual([{ id: PROBE_MODEL_ID, display_name: PROBE_MODEL_DISPLAY }]);
    expect(cache.fetchedAt).toBe(1234);
    expect(CACHE_SCHEMA).toBe("{baseUrl,fetchedAt,models:[{id,display_name?}]}");
    expect(PROBE_MODEL_ID).toBe("claude-frogp-probe-model");
    expect(PROBE_MODEL_DISPLAY).toBe("probe/local-model");
  });

  test("serialize is pretty JSON + trailing newline", () => {
    const s = serializeProbeCache(buildProbeCache("http://x", 1));
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s).models[0].id).toBe(PROBE_MODEL_ID);
  });
});

describe("token-free env", () => {
  test("sets base url + discovery, pins real home, removes forbidden auth carriers", () => {
    const base = {
      PATH: "/usr/bin",
      ANTHROPIC_AUTH_TOKEN: "leak",
      ANTHROPIC_API_KEY: "leak",
      CLAUDE_CODE_OAUTH_TOKEN: "leak",
      CLAUDECODE: "1",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    } as NodeJS.ProcessEnv;
    const env = buildTokenFreeEnv("/Users/probe", "probe", "http://127.0.0.1:9", base);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.HOME).toBe("/Users/probe");
    for (const k of FORBIDDEN_AUTH_ENV) expect(env[k]).toBeUndefined();
    // does not inherit the caller's CLAUDECODE marker
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("native env carries no gateway base url and no forbidden auth carriers", () => {
    const env = buildNativeEnv("/Users/probe", "probe", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/Users/probe");
  });
});

describe("request analysis", () => {
  const nativeBearer = "native-oauth-access-token-value";
  const nativeFp = fingerprint(nativeBearer);

  test("captures bearer fingerprint, anthropic headers, oauth beta; no raw token", () => {
    const facts = analyzeRequest(
      "POST",
      "/v1/messages",
      {
        Authorization: `Bearer ${nativeBearer}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
      },
      JSON.stringify({ model: PROBE_MODEL_ID, stream: true }),
    );
    expect(facts.authScheme).toBe("bearer");
    expect(facts.bearerFingerprint).toBe(nativeFp);
    expect(facts.anthropicVersionPresent).toBe(true);
    expect(facts.anthropicBetaHasOAuth).toBe(true);
    expect(facts.xApiKeyPresent).toBe(false);
    expect(facts.sentinelPresent).toBe(false);
    expect(facts.modelInBody).toBe(PROBE_MODEL_ID);
    expect(JSON.stringify(facts)).not.toContain(nativeBearer);
  });

  test("detects x-api-key and the frogprogsy sentinel", () => {
    const facts = analyzeRequest(
      "POST",
      "/v1/messages",
      { "x-api-key": SENTINEL },
      JSON.stringify({ model: "m", auth: SENTINEL }),
    );
    expect(facts.authScheme).toBe("x-api-key");
    expect(facts.xApiKeyPresent).toBe(true);
    expect(facts.sentinelPresent).toBe(true);
  });

  test("no auth headers => scheme none", () => {
    const facts = analyzeRequest("GET", "/v1/models", {}, "");
    expect(facts.authScheme).toBe("none");
    expect(facts.bearerFingerprint).toBeNull();
  });
});

describe("connector eligibility parsing (redacted booleans)", () => {
  test("connected claude.ai connectors => enabled, disabled-warning absent", () => {
    const c = parseMcpConnectors(
      "claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected\nclaude.ai Slack: ... - ! Needs authentication",
    );
    expect(c.claudeAiConnectorsPresent).toBe(true);
    expect(c.anyConnectorConnected).toBe(true);
    expect(c.connectorsDisabledWarningAbsent).toBe(true);
  });

  test("explicit disabled warning is detected", () => {
    const c = parseMcpConnectors("Connectors are disabled for this organization.");
    expect(c.connectorsDisabledWarningPresent).toBe(true);
    expect(c.connectorsDisabledWarningAbsent).toBe(false);
  });
});

describe("verdict", () => {
  test("all pass => PASS; any fail => FAIL", () => {
    const ok: Gate[] = [
      { id: "a", pass: true, detail: "" },
      { id: "b", pass: true, detail: "" },
    ];
    expect(computeVerdict(ok)).toBe("PASS");
    expect(computeVerdict([...ok, { id: "c", pass: false, detail: "" }])).toBe("FAIL");
  });
});
