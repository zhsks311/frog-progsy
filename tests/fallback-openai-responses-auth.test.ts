import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenAIResponsesFallbackFetch,
  isOpenAIResponsesFallbackProvider,
  OpenAIResponsesFallbackAuthError,
  resolveOpenAIResponsesFallbackProvider,
} from "../src/fallback-openai-responses";
import { resolveProviderAuth, type ProviderAuthDeps } from "../src/provider-auth";
import { resolveEnvValue } from "../src/config";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

/**
 * OpenAI-Responses fallback (image describe + web-search) auth contract. Verifies per-mode
 * resolution through the central seam, that a `claude-grant` provider is ineligible AND fail-closed
 * on a direct call (FC5), incoming-header isolation, and that an Anthropic subscription grant token
 * can never leak into a non-Anthropic fallback request. All tokens below are planted (non-secret)
 * fixtures and are asserted absent from every place they must not appear.
 */

const PLANTED_ANTHROPIC_GRANT = "planted-anthropic-grant-DO-NOT-LEAK";
const PLANTED_CODEX_OAUTH = "planted-codex-oauth-DO-NOT-LEAK";
const FALLBACK_KEY = "planted-fallback-key-abc";
const ENV_KEY = "FROGP_FALLBACK_AUTH_TEST_KEY";

const originalHome = process.env.FROGPROGSY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frog-fallback-auth-"));
  process.env.FROGPROGSY_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  delete process.env[ENV_KEY];
  rmSync(home, { recursive: true, force: true });
});

function makeConfig(providers: Record<string, FrogProviderConfig> = {}): FrogConfig {
  return { port: 10321, defaultProvider: "fallback", providers };
}

function respProvider(overrides: Partial<FrogProviderConfig> = {}): FrogProviderConfig {
  return { adapter: "openai-responses", baseUrl: "https://responses.example.com", ...overrides };
}

function headerValues(headers: Record<string, string>): string {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n");
}

// ── per-mode resolution through the central seam ──────────────────────────────

describe("resolveOpenAIResponsesFallbackProvider per auth mode", () => {
  test("key: resolves ${ENV} and matches the central resolveProviderAuth result", async () => {
    process.env[ENV_KEY] = FALLBACK_KEY;
    const provider = respProvider({ authMode: "key", apiKey: `\${${ENV_KEY}}` });

    const resolved = await resolveOpenAIResponsesFallbackProvider("fallback", provider, makeConfig());
    expect(resolved.apiKey).toBe(FALLBACK_KEY);

    // Delegation parity: the fallback funnels through the same seam the primary surfaces use.
    const viaSeam = await resolveProviderAuth(makeConfig(), "fallback", provider);
    expect(resolved.apiKey).toBe(viaSeam.apiKey);
    // The input provider is never mutated.
    expect(provider.apiKey).toBe(`\${${ENV_KEY}}`);
  });

  test("key: a literal api key is preserved (no config passed -> real loadConfig, never a fake)", async () => {
    const provider = respProvider({ authMode: "key", apiKey: FALLBACK_KEY });
    const resolved = await resolveOpenAIResponsesFallbackProvider("fallback", provider);
    expect(resolved.apiKey).toBe(FALLBACK_KEY);
  });

  test("forward: no bearer is acquired and the resolved apiKey is undefined", async () => {
    // Central resolver contract: forward injects no key (its adapter relays only allowlisted caller
    // auth headers), so the resolved apiKey is undefined even when the config carries a base value.
    const provider = respProvider({ authMode: "forward", apiKey: "unused-forward" });
    const resolved = await resolveOpenAIResponsesFallbackProvider("fallback", provider);
    expect(resolved.apiKey).toBeUndefined();
  });

  test("oauth without a provider name fails closed", async () => {
    const provider = respProvider({ authMode: "oauth" });
    await expect(resolveOpenAIResponsesFallbackProvider(undefined, provider, makeConfig()))
      .rejects.toThrow(/requires a provider name/);
  });

  test("oauth with no stored credential fails closed as not-logged-in (never a silent key)", async () => {
    // Hermetic: FROGPROGSY_HOME is a fresh temp dir with no auth store, so getValidAccessToken throws.
    const provider = respProvider({ authMode: "oauth", apiKey: "static-should-be-ignored" });
    await expect(resolveOpenAIResponsesFallbackProvider("codex", provider, makeConfig()))
      .rejects.toThrow(/Not logged in/);
  });
});

// ── claude-grant is never eligible and is fail-closed on a direct call (FC5) ──

describe("claude-grant is excluded from the openai-responses fallback", () => {
  test("eligibility gate: a claude-grant provider is never selectable (any adapter)", () => {
    // Even an openai-responses provider is rejected when its authMode is claude-grant: a grant token
    // is bound to its Anthropic provider and must never reach this non-Anthropic surface.
    expect(isOpenAIResponsesFallbackProvider(respProvider({ authMode: "claude-grant", claudeGrantId: "cg_x" }))).toBe(false);
    expect(isOpenAIResponsesFallbackProvider({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "claude-grant", claudeGrantId: "cg_x" })).toBe(false);
  });

  test("direct resolve of a claude-grant provider is rejected with a fixed typed error — zero credential/network access", async () => {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      return realFetch(...args);
    }) as typeof fetch;

    try {
      // The rejection is FIXED: identical regardless of provider name, config presence, or binding
      // state (a real broker path would instead surface a state-dependent ClaudeGrantError).
      const variants: Array<[string | undefined, FrogConfig | undefined]> = [
        ["cg-fallback", makeConfig()],
        [undefined, makeConfig()],
        ["cg-fallback", undefined],
        [undefined, undefined],
      ];
      for (const [name, config] of variants) {
        const provider = respProvider({ authMode: "claude-grant", claudeGrantId: "cg_abc123", apiKey: PLANTED_ANTHROPIC_GRANT });
        let caught: unknown;
        try {
          await resolveOpenAIResponsesFallbackProvider(name, provider, config);
        } catch (err) {
          caught = err;
        }
        // Fixed typed rejection — never a ClaudeGrantError (which would prove the broker was entered).
        expect(caught).toBeInstanceOf(OpenAIResponsesFallbackAuthError);
        expect((caught as OpenAIResponsesFallbackAuthError).code).toBe("claude_grant_not_allowed");
        // Fail-closed: it did not silently degrade to the leftover static apiKey, and no planted
        // grant material appears anywhere in the failure.
        const blob = `${(caught as Error).message}\n${(caught as Error).stack ?? ""}`;
        expect(blob).not.toContain(PLANTED_ANTHROPIC_GRANT);
        // The input provider is never mutated.
        expect(provider.apiKey).toBe(PLANTED_ANTHROPIC_GRANT);
      }
      // Zero network access: the rejection fired before any credential store read or token refresh.
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── incoming-header isolation ─────────────────────────────────────────────────

describe("buildOpenAIResponsesFallbackFetch incoming-header isolation", () => {
  test("key mode: only the fallback's own bearer is set; incoming Anthropic auth is dropped", () => {
    const provider = respProvider({ authMode: "key", apiKey: FALLBACK_KEY });
    const incoming = new Headers({
      authorization: `Bearer ${PLANTED_ANTHROPIC_GRANT}`,
      "x-api-key": PLANTED_ANTHROPIC_GRANT,
      "anthropic-beta": "oauth-2025-04-20",
      "x-claude-turn-state": "should-not-relay-in-key-mode",
    });
    const { url, headers } = buildOpenAIResponsesFallbackFetch(provider, incoming);

    expect(url).toBe("https://responses.example.com/v1/responses");
    expect(headers.Authorization).toBe(`Bearer ${FALLBACK_KEY}`);
    // No incoming header is relayed in key mode.
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(headers["x-claude-turn-state"]).toBeUndefined();
    expect(headerValues(headers)).not.toContain(PLANTED_ANTHROPIC_GRANT);
  });

  test("forward mode: relays only the allowlisted FORWARD_HEADERS, never arbitrary caller headers", () => {
    const provider = respProvider({ authMode: "forward" });
    const incoming = new Headers({
      authorization: `Bearer ${PLANTED_CODEX_OAUTH}`,
      "chatgpt-account-id": "acct-123",
      "x-secret-not-allowlisted": "leak-me",
      cookie: "session=leak-me",
    });
    const { url, headers } = buildOpenAIResponsesFallbackFetch(provider, incoming);

    expect(url).toBe("https://responses.example.com/responses");
    // Forward mode is the ONLY mode that relays caller auth (its documented contract).
    expect(headers.authorization).toBe(`Bearer ${PLANTED_CODEX_OAUTH}`);
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    // But arbitrary non-allowlisted headers are never forwarded.
    expect(headers["x-secret-not-allowlisted"]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });
});

// ── Anthropic grant token never leaks into a non-Anthropic fallback ───────────

describe("Anthropic grant token isolation from the openai-responses fallback", () => {
  test("a resolved oauth fallback carries only the fallback's own token, not an incoming grant bearer", () => {
    // Simulate the post-seam provider (apiKey already resolved to a codex OAuth token).
    const provider = respProvider({ authMode: "oauth", apiKey: PLANTED_CODEX_OAUTH });
    const incoming = new Headers({ authorization: `Bearer ${PLANTED_ANTHROPIC_GRANT}` });
    const { headers } = buildOpenAIResponsesFallbackFetch(provider, incoming);

    expect(headers.Authorization).toBe(`Bearer ${PLANTED_CODEX_OAUTH}`);
    expect(headerValues(headers)).not.toContain(PLANTED_ANTHROPIC_GRANT);
  });

  test("a grant token resolved for an Anthropic provider is never attached to a fallback request", async () => {
    // Resolve an Anthropic claude-grant provider through the seam (injected broker -> grant token).
    const grantDeps: ProviderAuthDeps = {
      getOAuthAccessToken: async () => { throw new Error("oauth resolver must not run"); },
      getClaudeGrantAccessToken: async () => PLANTED_ANTHROPIC_GRANT,
      resolveEnvValue,
    };
    const anthropicGrantProvider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "claude-grant",
      claudeGrantId: "cg_real01",
    };
    const resolvedAnthropic = await resolveProviderAuth(makeConfig(), "claude-sub", anthropicGrantProvider, grantDeps);
    expect(resolvedAnthropic.apiKey).toBe(PLANTED_ANTHROPIC_GRANT);

    // The (separate) openai-responses fallback provider must ignore any incoming grant bearer.
    const fallback = respProvider({ authMode: "key", apiKey: FALLBACK_KEY });
    const incoming = new Headers({ authorization: `Bearer ${resolvedAnthropic.apiKey}` });
    const { headers } = buildOpenAIResponsesFallbackFetch(fallback, incoming);

    expect(headers.Authorization).toBe(`Bearer ${FALLBACK_KEY}`);
    expect(headerValues(headers)).not.toContain(PLANTED_ANTHROPIC_GRANT);
  });

  test("eligibility gate: only forward/oauth/key openai-responses providers are selectable", () => {
    // image/web-search fallback selection is gated by isOpenAIResponsesFallbackProvider, so a grant
    // (Anthropic) provider can never be picked as the non-Anthropic fallback in the first place.
    expect(isOpenAIResponsesFallbackProvider(respProvider({ authMode: "forward" }))).toBe(true);
    expect(isOpenAIResponsesFallbackProvider(respProvider({ authMode: "oauth" }))).toBe(true);
    expect(isOpenAIResponsesFallbackProvider(respProvider({ authMode: "key", apiKey: FALLBACK_KEY }))).toBe(true);
    // key mode with no resolvable key is not eligible.
    expect(isOpenAIResponsesFallbackProvider(respProvider({ authMode: "key" }))).toBe(false);
    // Non-openai-responses adapters are never eligible.
    expect(isOpenAIResponsesFallbackProvider({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward" })).toBe(false);
  });
});
