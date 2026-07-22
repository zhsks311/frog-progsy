import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAdapter } from "../src/server";
import { resolveProviderAuth, assertAllowedClaudeGrantTarget, type ProviderAuthDeps } from "../src/provider-auth";
import {
  ClaudeGrantError,
  getClaudeGrantAccessToken,
  type ClaudeGrantAuthDeps,
} from "../src/claude-grant-auth";
import {
  addClaudeGrant,
  expectedKeychainService,
  NATIVE_KEYCHAIN_SERVICE,
} from "../src/claude-grants";
import { parseMessagesRequest } from "../src/messages/parser";
import { resolveEnvValue } from "../src/config";
import { ANTHROPIC_OAUTH_BETA } from "../src/oauth/anthropic";
import { CODEX_BACKEND_BASE_URL } from "../src/oauth/codex";
import type { FrogConfig, FrogParsedRequest, FrogProviderConfig } from "../src/types";

/**
 * Dual-auth model mixing: a Codex OAuth provider and an Anthropic claude-grant provider on the same
 * roster must use different Bearer tokens, route to their own upstreams, and never cross-contaminate
 * auth. Two distinct grants must use distinct tokens + lock contexts, and a missing/dangling grant
 * must fail closed (never a forwarded header, another grant, or an API key).
 *
 * This mirrors the server's per-target dispatch (resolveProviderAuth -> resolveAdapter ->
 * buildRequest -> fetch) and captures the outgoing request through a mock global fetch. All tokens
 * are planted (non-secret) fixtures asserted absent where they must not appear.
 */

const NOW = 1_800_000_000_000;
const CODEX_TOKEN = "planted-codex-oauth-token-CDX";
const GRANT_TOKEN = "planted-anthropic-grant-token-GNT";
// Reserved fixture host (RFC 6761 `.example`) — never resolves in real DNS; admitted only via the
// test-only `allowReservedTestHosts` validator option, never by the strict production guard.
const ANTHROPIC_GRANT_BASE = "https://api.anthropic.example";

const originalHome = process.env.FROGPROGSY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frog-mix-dualauth-"));
  process.env.FROGPROGSY_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// ── mock fetch capture ────────────────────────────────────────────────────────

interface CapturedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

async function withCapturedFetch<T>(fn: (captured: CapturedFetch[]) => Promise<T>): Promise<{ result: T; captured: CapturedFetch[] }> {
  const captured: CapturedFetch[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await fn(captured);
    return { result, captured };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function buildParsed(model: string): FrogParsedRequest {
  const parsed = parseMessagesRequest({
    model,
    messages: [{ role: "user", content: "route me" }],
    stream: false,
    max_tokens: 256,
  });
  // openai-responses adapters serialize _rawBody; anthropic ones read context.messages.
  parsed._rawBody = { model, input: [] };
  return parsed;
}

/** Mirror the server seam for one roster target and capture the upstream request. */
async function dispatchTarget(
  config: FrogConfig,
  name: string,
  model: string,
  deps: ProviderAuthDeps,
): Promise<CapturedFetch> {
  const prov = config.providers[name]!;
  const { captured } = await withCapturedFetch(async () => {
    const resolved = await resolveProviderAuth(config, name, prov, deps);
    const adapter = resolveAdapter(resolved);
    const request = adapter.buildRequest(buildParsed(model), { headers: new Headers() });
    await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

function headerBlob(c: CapturedFetch): string {
  return `${c.url}\n${Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}\n${c.body ?? ""}`;
}

function mixConfig(): FrogConfig {
  return {
    port: 10450,
    defaultProvider: "codex",
    providers: {
      codex: { adapter: "openai-responses", baseUrl: CODEX_BACKEND_BASE_URL, authMode: "oauth", defaultModel: "gpt-5.5" },
      "claude-sub": { adapter: "anthropic", baseUrl: ANTHROPIC_GRANT_BASE, authMode: "claude-grant", claudeGrantId: "cg_bound01", defaultModel: "claude-opus" },
    },
    modelMixing: {
      enabled: true,
      coordinator: { provider: "codex", model: "gpt-5.5" },
      guidance: "chat -> codex; coding -> claude",
      agents: [
        { provider: "codex", model: "gpt-5.5", tasks: ["chat"] },
        { provider: "claude-sub", model: "claude-opus", tasks: ["coding"] },
      ],
    },
  };
}

// Seam deps that hand back distinct planted tokens per auth mode (mirrors the primary surfaces).
function tokenSeamDeps(): ProviderAuthDeps & { oauthCalls: string[]; grantCalls: string[] } {
  const oauthCalls: string[] = [];
  const grantCalls: string[] = [];
  return {
    oauthCalls,
    grantCalls,
    getOAuthAccessToken: async (name) => { oauthCalls.push(name); return CODEX_TOKEN; },
    getClaudeGrantAccessToken: async (_config, name) => { grantCalls.push(name); return GRANT_TOKEN; },
    resolveEnvValue,
    // The claude-grant target guard runs BEFORE the broker; admit the reserved `.example` fixture host.
    validateClaudeGrantTarget: (p) => assertAllowedClaudeGrantTarget(p, { allowReservedTestHosts: true }),
  };
}

// ── grant-core I/O fakes ──────────────────────────────────────────────────────

interface ResponseLike { ok: boolean; status: number; text: () => Promise<string>; }
function jsonResponse(status: number, body: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
function memKeychain(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const writes: { service: string; secret: string }[] = [];
  const reads: string[] = [];
  return {
    store, writes, reads,
    read: (service: string) => { reads.push(service); return store.get(service) ?? null; },
    write: (service: string, _account: string, secret: string) => { writes.push({ service, secret }); store.set(service, secret); },
  };
}
function memFiles() {
  const store = new Map<string, string>();
  return { store, read: (p: string) => store.get(p) ?? null, write: (p: string, c: string) => { store.set(p, c); } };
}
function cred(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("cross-provider Bearer isolation on one roster", () => {
  test("Codex OAuth and Anthropic grant targets use different Bearers with no cross-contamination", async () => {
    const config = mixConfig();
    const deps = tokenSeamDeps();

    const codex = await dispatchTarget(config, "codex", "gpt-5.5", deps);
    const claude = await dispatchTarget(config, "claude-sub", "claude-opus", deps);

    // Distinct tokens were resolved per mode.
    expect(deps.oauthCalls).toEqual(["codex"]);
    expect(deps.grantCalls).toEqual(["claude-sub"]);
    expect(CODEX_TOKEN).not.toBe(GRANT_TOKEN);

    // Codex request: its own OAuth Bearer + Codex backend route/headers.
    expect(codex.url).toBe(`${CODEX_BACKEND_BASE_URL}/responses`);
    expect(codex.headers["authorization"]).toBe(`Bearer ${CODEX_TOKEN}`);
    expect(codex.headers["originator"]).toBe("codex_cli_rs");

    // Anthropic request: the grant Bearer + subscription wire shape (oauth beta), no x-api-key.
    expect(claude.url).toBe(`${ANTHROPIC_GRANT_BASE}/v1/messages`);
    expect(claude.headers["authorization"]).toBe(`Bearer ${GRANT_TOKEN}`);
    expect(claude.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(claude.headers["x-api-key"]).toBeUndefined();

    // No token bleeds across providers, and neither speaks the other's wire protocol.
    expect(headerBlob(codex)).not.toContain(GRANT_TOKEN);
    expect(headerBlob(codex)).not.toContain(ANTHROPIC_OAUTH_BETA);
    expect(headerBlob(claude)).not.toContain(CODEX_TOKEN);
    expect(headerBlob(claude)).not.toContain("originator");
  });
});

describe("two Anthropic grants use distinct token + lock contexts", () => {
  test("distinct grant ids resolve distinct tokens, scoped services, and lock keys on refresh", async () => {
    const config = mixConfig();
    const grantA = addClaudeGrant(config, { label: "Grant A" });
    const grantB = addClaudeGrant(config, { label: "Grant B" });
    const serviceA = expectedKeychainService(grantA.configDir);
    const serviceB = expectedKeychainService(grantB.configDir);
    config.providers["cgA"] = { adapter: "anthropic", baseUrl: ANTHROPIC_GRANT_BASE, authMode: "claude-grant", claudeGrantId: grantA.id };
    config.providers["cgB"] = { adapter: "anthropic", baseUrl: ANTHROPIC_GRANT_BASE, authMode: "claude-grant", claudeGrantId: grantB.id };

    // Stale (within-skew) credentials with distinct refresh tokens force a keyed refresh.
    const keychain = memKeychain({
      [serviceA]: cred({ accessToken: "OLD-A", refreshToken: "REF-A", expiresAt: NOW + 60_000 }),
      [serviceB]: cred({ accessToken: "OLD-B", refreshToken: "REF-B", expiresAt: NOW + 60_000 }),
    });
    const rotated: Record<string, string> = { "REF-A": "TOKEN-A-NEW", "REF-B": "TOKEN-B-NEW" };
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const rt = JSON.parse(init.body).refresh_token as string;
      return jsonResponse(200, { access_token: rotated[rt], refresh_token: `${rt}-rot`, expires_in: 3600 });
    }) as ClaudeGrantAuthDeps["fetch"];
    const lockKeys: string[] = [];
    const grantDeps: Partial<ClaudeGrantAuthDeps> = {
      platform: "darwin",
      keychain,
      files: memFiles(),
      lock: { acquire: async (key: string) => { lockKeys.push(key); return () => {}; } },
      now: () => NOW,
      fetch: fetchFn,
    };

    const tokenA = await getClaudeGrantAccessToken(config, "cgA", config.providers["cgA"]!, grantDeps);
    const tokenB = await getClaudeGrantAccessToken(config, "cgB", config.providers["cgB"]!, grantDeps);

    // Distinct tokens, distinct lock contexts (per grant id), distinct scoped services written.
    expect(tokenA).toBe("TOKEN-A-NEW");
    expect(tokenB).toBe("TOKEN-B-NEW");
    expect(tokenA).not.toBe(tokenB);
    expect(lockKeys).toEqual([grantA.id, grantB.id]);
    expect(grantA.id).not.toBe(grantB.id);
    expect(keychain.writes.map(w => w.service).sort()).toEqual([serviceA, serviceB].sort());
    // Never the native/unscoped service.
    expect(keychain.store.has(NATIVE_KEYCHAIN_SERVICE)).toBe(false);
    // Grant A's material never landed in grant B's scoped store and vice versa.
    expect(keychain.store.get(serviceA)).toContain("TOKEN-A-NEW");
    expect(keychain.store.get(serviceA)).not.toContain("TOKEN-B-NEW");
    expect(keychain.store.get(serviceB)).toContain("TOKEN-B-NEW");
    expect(keychain.store.get(serviceB)).not.toContain("TOKEN-A-NEW");
  });

  test("fresh distinct credentials resolve distinct tokens without any refresh or lock", async () => {
    const config = mixConfig();
    const grantA = addClaudeGrant(config, { label: "A" });
    const grantB = addClaudeGrant(config, { label: "B" });
    const serviceA = expectedKeychainService(grantA.configDir);
    const serviceB = expectedKeychainService(grantB.configDir);
    config.providers["cgA"] = { adapter: "anthropic", baseUrl: ANTHROPIC_GRANT_BASE, authMode: "claude-grant", claudeGrantId: grantA.id };
    config.providers["cgB"] = { adapter: "anthropic", baseUrl: ANTHROPIC_GRANT_BASE, authMode: "claude-grant", claudeGrantId: grantB.id };
    const keychain = memKeychain({
      [serviceA]: cred({ accessToken: "FRESH-A", refreshToken: "REF-A", expiresAt: NOW + 3_600_000 }),
      [serviceB]: cred({ accessToken: "FRESH-B", refreshToken: "REF-B", expiresAt: NOW + 3_600_000 }),
    });
    const lockKeys: string[] = [];
    const grantDeps: Partial<ClaudeGrantAuthDeps> = {
      platform: "darwin",
      keychain,
      files: memFiles(),
      lock: { acquire: async (key: string) => { lockKeys.push(key); return () => {}; } },
      now: () => NOW,
      fetch: (async () => { throw new Error("must not refresh a fresh token"); }) as ClaudeGrantAuthDeps["fetch"],
    };

    const tokenA = await getClaudeGrantAccessToken(config, "cgA", config.providers["cgA"]!, grantDeps);
    const tokenB = await getClaudeGrantAccessToken(config, "cgB", config.providers["cgB"]!, grantDeps);

    expect(tokenA).toBe("FRESH-A");
    expect(tokenB).toBe("FRESH-B");
    expect(keychain.reads).toContain(serviceA);
    expect(keychain.reads).toContain(serviceB);
    expect(lockKeys).toEqual([]);        // no refresh -> no lock acquisition
    expect(keychain.writes).toEqual([]); // no write on a fresh token
  });
});

describe("missing / dangling grant fails closed", () => {
  test("a dangling grant binding throws not_bound and resolves NO token (no key/forward/other-grant fallback)", async () => {
    const config = mixConfig();
    // A valid, seeded grant coexists to prove the dangling one never borrows its token.
    const grantA = addClaudeGrant(config, { label: "A" });
    const serviceA = expectedKeychainService(grantA.configDir);
    const keychain = memKeychain({ [serviceA]: cred({ accessToken: "OTHER-GRANT-TOKEN", refreshToken: "REF-A", expiresAt: NOW + 3_600_000 }) });
    // Provider bound to a grant id that is NOT in config, plus a leftover static key.
    const dangling: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: ANTHROPIC_GRANT_BASE,
      authMode: "claude-grant",
      claudeGrantId: "cg_ghost99",
      apiKey: "leftover-static-key-should-never-be-used",
    };
    config.providers["dangling"] = dangling;

    let caught: unknown;
    const { captured } = await withCapturedFetch(async () => {
      const grantDeps: Partial<ClaudeGrantAuthDeps> = {
        platform: "darwin", keychain, files: memFiles(),
        lock: { acquire: async () => () => {} }, now: () => NOW,
        fetch: (async () => { throw new Error("must not fetch"); }) as ClaudeGrantAuthDeps["fetch"],
      };
      const seamDeps: ProviderAuthDeps = {
        getOAuthAccessToken: async () => { throw new Error("oauth resolver must not run"); },
        getClaudeGrantAccessToken: (c, n, p) => getClaudeGrantAccessToken(c, n, p, grantDeps),
        resolveEnvValue,
        // Admit the reserved fixture host so the not_bound comes from the missing BINDING, not target.
        validateClaudeGrantTarget: (p) => assertAllowedClaudeGrantTarget(p, { allowReservedTestHosts: true }),
      };
      try {
        await resolveProviderAuth(config, "dangling", dangling, seamDeps);
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(ClaudeGrantError);
    expect((caught as ClaudeGrantError).code).toBe("not_bound");
    expect(captured).toEqual([]); // fail-closed: no upstream request was ever made
    const blob = `${(caught as ClaudeGrantError).message}\n${(caught as ClaudeGrantError).stack ?? ""}`;
    expect(blob).not.toContain("OTHER-GRANT-TOKEN");   // never the other grant's token
    expect(blob).not.toContain("leftover-static-key"); // never the leftover API key
  });

  test("a bound grant with no stored credential throws no_credential, never another provider's token", async () => {
    const config = mixConfig();
    const grant = addClaudeGrant(config, { label: "Empty" });
    const provider: FrogProviderConfig = { adapter: "anthropic", baseUrl: ANTHROPIC_GRANT_BASE, authMode: "claude-grant", claudeGrantId: grant.id };
    config.providers["cg"] = provider;

    const grantDeps: Partial<ClaudeGrantAuthDeps> = {
      platform: "darwin", keychain: memKeychain() /* empty */, files: memFiles(),
      lock: { acquire: async () => () => {} }, now: () => NOW,
      fetch: (async () => { throw new Error("must not fetch"); }) as ClaudeGrantAuthDeps["fetch"],
    };
    let caught: unknown;
    try {
      await getClaudeGrantAccessToken(config, "cg", provider, grantDeps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeGrantError);
    expect((caught as ClaudeGrantError).code).toBe("no_credential");
    expect(CODEX_TOKEN).not.toBe((caught as ClaudeGrantError).message);
  });

  test("an invalid claude-grant target fails closed BEFORE the broker — zero broker + zero network", async () => {
    const config = mixConfig();
    // Anthropic-adapter grant provider pointed at a NON-official host (RFC 6761 `.invalid` never
    // resolves and is admitted by neither the strict nor the reserved-test validator). A subscription
    // Bearer must never be sent here, so the target guard must reject it before touching the broker.
    const provider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.invalid",
      authMode: "claude-grant",
      claudeGrantId: "cg_bound01",
      apiKey: "leftover-static-key-should-never-be-used",
    };
    config.providers["evil"] = provider;

    let brokerCalls = 0;
    let caught: unknown;
    const { captured } = await withCapturedFetch(async () => {
      // Default (strict) target guard — no allowReservedTestHosts override. The broker spy throws if
      // ever reached, proving the guard fired first.
      const seamDeps: ProviderAuthDeps = {
        getOAuthAccessToken: async () => { throw new Error("oauth resolver must not run"); },
        getClaudeGrantAccessToken: async () => { brokerCalls++; throw new Error("broker must not be called"); },
        resolveEnvValue,
      };
      try {
        await resolveProviderAuth(config, "evil", provider, seamDeps);
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(ClaudeGrantError);
    expect((caught as ClaudeGrantError).code).toBe("not_bound");
    // Fixed, redacted target-rejection message — never interpolates the rejected host or a token.
    expect((caught as ClaudeGrantError).message).toMatch(/not bound to a valid Claude subscription endpoint/i);
    expect((caught as ClaudeGrantError).message).not.toContain("api.anthropic.invalid");
    expect(brokerCalls).toBe(0);   // zero broker calls
    expect(captured).toEqual([]);  // zero network calls
    expect(`${(caught as ClaudeGrantError).message}\n${(caught as ClaudeGrantError).stack ?? ""}`).not.toContain("leftover-static-key");
  });
});
