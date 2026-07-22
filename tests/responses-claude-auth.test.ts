import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderAuth, assertAllowedClaudeGrantTarget, type ProviderAuthDeps } from "../src/provider-auth";
import {
  ClaudeGrantError,
  getClaudeGrantAccessToken,
  type ClaudeGrantAuthDeps,
} from "../src/claude-grant-auth";
import { addClaudeGrant, expectedKeychainService } from "../src/claude-grants";
import { formatErrorResponse } from "../src/bridge";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseMessagesRequest } from "../src/messages/parser";
import { resolveEnvValue } from "../src/config";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth/anthropic";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

/**
 * `/v1/responses` (handleResponses) Claude-auth contract. handleResponses is not exported, so we
 * exercise the EXACT auth composition it performs (server.ts): resolve `oauth`/`claude-grant`
 * providers through `resolveProviderAuth`, emit the resolved Bearer via the Anthropic adapter on
 * success, and on failure return `formatErrorResponse(401, "authentication_error", err.message)`.
 * All product functions are real; only the grant core's I/O deps (Keychain/file/fetch/lock) are
 * injected. Planted tokens must never appear in the 401 body.
 */

const NOW = 1_800_000_000_000;
const GRANT_ACCESS = "planted-grant-access-token-ACC";
const GRANT_REFRESH = "planted-grant-refresh-token-REF";
const OAUTH_ACCESS = "planted-oauth-access-token-OAT";
// Reserved fixture host (RFC 6761 `.example`) — never resolves in real DNS; admitted only via the
// test-only `allowReservedTestHosts` validator, never by the strict production target guard.
const ANTHROPIC_GRANT_BASE = "https://api.anthropic.example";
const ENV_KEY = "FROGP_RESPONSES_AUTH_TEST_KEY";

const originalHome = process.env.FROGPROGSY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frog-responses-auth-"));
  process.env.FROGPROGSY_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  delete process.env[ENV_KEY];
  rmSync(home, { recursive: true, force: true });
});

// ── grant-core I/O fakes ──────────────────────────────────────────────────────

interface ResponseLike { ok: boolean; status: number; text: () => Promise<string>; }
function jsonResponse(status: number, body: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
function memKeychain(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    read: (service: string) => store.get(service) ?? null,
    write: (service: string, _account: string, secret: string) => { store.set(service, secret); },
  };
}
function memFiles() {
  const store = new Map<string, string>();
  return { store, read: (p: string) => store.get(p) ?? null, write: (p: string, c: string) => { store.set(p, c); } };
}
function cred(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

function grantDeps(overrides: Partial<ClaudeGrantAuthDeps> = {}): Partial<ClaudeGrantAuthDeps> {
  return {
    platform: "darwin",
    keychain: memKeychain(),
    files: memFiles(),
    lock: { acquire: async () => () => {} },
    now: () => NOW,
    fetch: (async () => { throw new Error("no network in test"); }) as ClaudeGrantAuthDeps["fetch"],
    ...overrides,
  };
}

// Seam deps mirroring the responses surface: oauth -> planted token; grant -> real broker (injected I/O).
function seamDeps(grantIO: Partial<ClaudeGrantAuthDeps>): ProviderAuthDeps {
  return {
    getOAuthAccessToken: async () => OAUTH_ACCESS,
    getClaudeGrantAccessToken: (c, n, p) => getClaudeGrantAccessToken(c, n, p, grantIO),
    resolveEnvValue,
    // The claude-grant target guard runs BEFORE the broker; admit the reserved `.example` fixture host.
    validateClaudeGrantTarget: (p) => assertAllowedClaudeGrantTarget(p, { allowReservedTestHosts: true }),
  };
}

function makeConfig(): FrogConfig {
  return { port: 10560, defaultProvider: "claude-sub", providers: {} };
}

/** Mirror the handleResponses auth gate: resolve oauth/claude-grant; map failure to a 401 typed body. */
async function responsesSeamAuth(config: FrogConfig, name: string, provider: FrogProviderConfig, deps: ProviderAuthDeps) {
  if (provider.authMode === "oauth" || provider.authMode === "claude-grant") {
    try {
      return { ok: true as const, resolved: await resolveProviderAuth(config, name, provider, deps) };
    } catch (err) {
      return { ok: false as const, response: formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err)) };
    }
  }
  // key/forward: resolved as-is (env for key, no injection for forward), then used by the adapter.
  return { ok: true as const, resolved: await resolveProviderAuth(config, name, provider, deps) };
}

function anthropicHeaders(provider: FrogProviderConfig, incoming: Record<string, string> = {}) {
  const adapter = createAnthropicAdapter(provider);
  const parsed = parseMessagesRequest({ model: provider.defaultModel ?? "claude-opus", messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 256 });
  const request = adapter.buildRequest(parsed, { headers: new Headers(incoming) }) as { url: string; headers: Record<string, string>; body: string };
  return { url: request.url, headers: request.headers, body: JSON.parse(request.body) as Record<string, unknown> };
}

function grantProvider(id: string, overrides: Partial<FrogProviderConfig> = {}): FrogProviderConfig {
  return { adapter: "anthropic", baseUrl: ANTHROPIC_GRANT_BASE, authMode: "claude-grant", claudeGrantId: id, defaultModel: "claude-opus", ...overrides };
}

async function bodyOf(response: Response): Promise<{ status: number; raw: string; json: any }> {
  const raw = await response.text();
  return { status: response.status, raw, json: JSON.parse(raw) };
}

// ── grant success ─────────────────────────────────────────────────────────────

describe("/v1/responses grant success", () => {
  test("resolves the grant Bearer and emits the Claude subscription wire shape", async () => {
    const config = makeConfig();
    const grant = addClaudeGrant(config, { label: "Sub" });
    const service = expectedKeychainService(grant.configDir);
    const provider = grantProvider(grant.id);
    config.providers["claude-sub"] = provider;

    const io = grantDeps({ keychain: memKeychain({ [service]: cred({ accessToken: GRANT_ACCESS, refreshToken: GRANT_REFRESH, expiresAt: NOW + 3_600_000 }) }) });
    const outcome = await responsesSeamAuth(config, "claude-sub", provider, seamDeps(io));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.resolved.apiKey).toBe(GRANT_ACCESS);
    const { url, headers, body } = anthropicHeaders(outcome.resolved);
    expect(url).toBe(`${ANTHROPIC_GRANT_BASE}/v1/messages`);
    expect(headers.Authorization).toBe(`Bearer ${GRANT_ACCESS}`);
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(headers["x-api-key"]).toBeUndefined();
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
  });
});

// ── typed 401 errors + redaction ───────────────────────────────────────────────

describe("/v1/responses grant failures return a typed 401 with no token leakage", () => {
  test("not_bound: provider bound to an unknown grant", async () => {
    const config = makeConfig();
    const provider = grantProvider("cg_ghost99", { apiKey: "leftover-static" });
    config.providers["claude-sub"] = provider;

    const outcome = await responsesSeamAuth(config, "claude-sub", provider, seamDeps(grantDeps()));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const { status, json, raw } = await bodyOf(outcome.response);
    expect(status).toBe(401);
    expect(json.error.type).toBe("authentication_error");
    expect(json.error.code).toBe("invalid_api_key");
    expect(json.error.message).toContain("cg_ghost99"); // names the grant (not a secret)
    expect(raw).not.toContain("leftover-static");
  });

  test("no_credential: bound grant with an empty scoped store", async () => {
    const config = makeConfig();
    const grant = addClaudeGrant(config, { label: "Empty" });
    const provider = grantProvider(grant.id);
    config.providers["claude-sub"] = provider;

    const outcome = await responsesSeamAuth(config, "claude-sub", provider, seamDeps(grantDeps({ keychain: memKeychain() })));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const { status, json } = await bodyOf(outcome.response);
    expect(status).toBe(401);
    expect(json.error.type).toBe("authentication_error");
    expect(json.error.message).toContain(grant.id);
  });

  test("reauth_required: refresh rejected with invalid_grant, planted tokens never surface", async () => {
    const config = makeConfig();
    const grant = addClaudeGrant(config, { label: "Stale" });
    const service = expectedKeychainService(grant.configDir);
    const provider = grantProvider(grant.id);
    config.providers["claude-sub"] = provider;

    // Expired access token + refresh token -> the broker refreshes; upstream rejects with invalid_grant.
    const io = grantDeps({
      keychain: memKeychain({ [service]: cred({ accessToken: GRANT_ACCESS, refreshToken: GRANT_REFRESH, expiresAt: NOW - 1_000 }) }),
      fetch: (async () => jsonResponse(400, { error: "invalid_grant" })) as ClaudeGrantAuthDeps["fetch"],
    });
    const outcome = await responsesSeamAuth(config, "claude-sub", provider, seamDeps(io));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const { status, json, raw } = await bodyOf(outcome.response);
    expect(status).toBe(401);
    expect(json.error.type).toBe("authentication_error");
    // Redaction: neither the stored access token nor the refresh token appears in the 401 body.
    expect(raw).not.toContain(GRANT_ACCESS);
    expect(raw).not.toContain(GRANT_REFRESH);
  });

  test("expired token with no refresh token never sends the stale access token", async () => {
    const config = makeConfig();
    const grant = addClaudeGrant(config, { label: "NoRefresh" });
    const service = expectedKeychainService(grant.configDir);
    const provider = grantProvider(grant.id);
    config.providers["claude-sub"] = provider;

    const io = grantDeps({ keychain: memKeychain({ [service]: cred({ accessToken: GRANT_ACCESS, expiresAt: NOW - 1_000 }) }) });
    const outcome = await responsesSeamAuth(config, "claude-sub", provider, seamDeps(io));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const { status, raw } = await bodyOf(outcome.response);
    expect(status).toBe(401);
    expect(raw).not.toContain(GRANT_ACCESS); // the expired token is never emitted
  });

  test("invalid claude-grant target -> 401 typed body before the broker; seeded token never emitted", async () => {
    const config = makeConfig();
    const grant = addClaudeGrant(config, { label: "BadTarget" });
    const service = expectedKeychainService(grant.configDir);
    // A usable credential exists, so the ONLY reason to fail is the non-official (`.invalid`) target:
    // the target guard rejects before the broker, proving an expired/valid token is never even read.
    const io = grantDeps({ keychain: memKeychain({ [service]: cred({ accessToken: GRANT_ACCESS, refreshToken: GRANT_REFRESH, expiresAt: NOW + 3_600_000 }) }) });
    const provider = grantProvider(grant.id, { baseUrl: "https://api.anthropic.invalid" });
    config.providers["claude-sub"] = provider;

    const outcome = await responsesSeamAuth(config, "claude-sub", provider, seamDeps(io));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const { status, json, raw } = await bodyOf(outcome.response);
    expect(status).toBe(401);
    expect(json.error.type).toBe("authentication_error");
    expect(json.error.message).toMatch(/not bound to a valid Claude subscription endpoint/i);
    // Redaction + fail-closed: the fixed message never leaks the seeded token or the rejected host.
    expect(raw).not.toContain(GRANT_ACCESS);
    expect(raw).not.toContain("api.anthropic.invalid");
  });
});

// ── key / oauth / forward regression ────────────────────────────────────────────

describe("/v1/responses key/oauth/forward auth still works alongside claude-grant", () => {
  test("oauth resolves a Bearer token via the seam", async () => {
    const config = makeConfig();
    const provider: FrogProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", defaultModel: "claude-opus" };
    config.providers["oauth-prov"] = provider;

    const outcome = await responsesSeamAuth(config, "oauth-prov", provider, seamDeps(grantDeps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.apiKey).toBe(OAUTH_ACCESS);
    const { headers } = anthropicHeaders(outcome.resolved);
    expect(headers.Authorization).toBe(`Bearer ${OAUTH_ACCESS}`);
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
  });

  test("key mode resolves ${ENV} and authenticates with x-api-key (not a subscription Bearer)", async () => {
    process.env[ENV_KEY] = "sk-ant-planted-key";
    const config = makeConfig();
    const provider: FrogProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: `\${${ENV_KEY}}`, defaultModel: "claude-opus" };
    config.providers["key-prov"] = provider;

    const outcome = await responsesSeamAuth(config, "key-prov", provider, seamDeps(grantDeps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.apiKey).toBe("sk-ant-planted-key");
    const { headers } = anthropicHeaders(outcome.resolved);
    expect(headers["x-api-key"]).toBe("sk-ant-planted-key");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  test("forward mode injects no key and relays the caller's Anthropic credentials", async () => {
    const config = makeConfig();
    const provider: FrogProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward", defaultModel: "claude-opus" };
    config.providers["fwd-prov"] = provider;

    const outcome = await responsesSeamAuth(config, "fwd-prov", provider, seamDeps(grantDeps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.apiKey).toBeUndefined();
    const { headers } = anthropicHeaders(outcome.resolved, { "x-api-key": "sk-ant-caller-forwarded" });
    expect(headers["x-api-key"]).toBe("sk-ant-caller-forwarded");
  });

  test("oauth not-logged-in fails closed with a typed 401 and never leaks the planted token", async () => {
    const config = makeConfig();
    const provider: FrogProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", defaultModel: "claude-opus" };
    config.providers["oauth-prov"] = provider;

    // Logged-out oauth: the resolver throws the pinned "Not logged in" guidance (mirrors getValidAccessToken),
    // which the request surface maps to the typed 401 oauth_missing path. The seam's planted OAUTH_ACCESS
    // token is never returned, so it must not appear anywhere in the error body (zero crossover).
    const loggedOut: ProviderAuthDeps = {
      ...seamDeps(grantDeps()),
      getOAuthAccessToken: async () => { throw new Error("Not logged in to oauth-prov. Run: frogp login oauth-prov"); },
    };

    const outcome = await responsesSeamAuth(config, "oauth-prov", provider, loggedOut);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const { status, json, raw } = await bodyOf(outcome.response);
    expect(status).toBe(401);
    expect(json.error.type).toBe("authentication_error");
    expect(json.error.message).toContain("Not logged in"); // login-required guidance, no secret
    expect(raw).not.toContain(OAUTH_ACCESS);
  });
});
