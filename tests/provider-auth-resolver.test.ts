import { afterEach, describe, expect, test } from "bun:test";
import { resolveProviderAuth, isAllowedClaudeGrantBaseUrl, assertAllowedClaudeGrantTarget, type ProviderAuthDeps } from "../src/provider-auth";
import { ClaudeGrantError } from "../src/claude-grant-auth";
import { resolveEnvValue } from "../src/config";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

// Synthetic (non-secret) fixtures. Never assert with a real credential value.
const OAUTH_TOKEN = "oauth-resolved-access-fixture";
const GRANT_TOKEN = "grant-resolved-access-fixture";
const ENV_KEY = "FROGP_PROVIDER_AUTH_TEST_KEY";

function makeConfig(providers: Record<string, FrogProviderConfig> = {}): FrogConfig {
  return { port: 10999, defaultProvider: "p", providers };
}

function makeProvider(overrides: Partial<FrogProviderConfig> = {}): FrogProviderConfig {
  return { adapter: "anthropic", baseUrl: "https://api.anthropic.com", ...overrides };
}

interface GrantCall {
  config: FrogConfig;
  name: string;
  provider: FrogProviderConfig;
}

interface SpyDeps extends ProviderAuthDeps {
  calls: { oauth: string[]; grant: GrantCall[]; env: Array<string | undefined> };
}

function spyDeps(overrides: Partial<ProviderAuthDeps> = {}): SpyDeps {
  const calls: SpyDeps["calls"] = { oauth: [], grant: [], env: [] };
  return {
    calls,
    getOAuthAccessToken: async name => {
      calls.oauth.push(name);
      return OAUTH_TOKEN;
    },
    getClaudeGrantAccessToken: async (config, name, provider) => {
      calls.grant.push({ config, name, provider });
      return GRANT_TOKEN;
    },
    // Delegate to the real resolver so static-key env semantics are exercised end-to-end.
    resolveEnvValue: value => {
      calls.env.push(value);
      return resolveEnvValue(value);
    },
    ...overrides,
  };
}

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolveProviderAuth common seam", () => {
  test("static key: literal apiKey is preserved and no token resolver is invoked", async () => {
    const deps = spyDeps();
    const provider = makeProvider({ authMode: "key", apiKey: "sk-literal-123" });
    const result = await resolveProviderAuth(makeConfig(), "p", provider, deps);

    expect(result.apiKey).toBe("sk-literal-123");
    expect(deps.calls.oauth).toEqual([]);
    expect(deps.calls.grant).toEqual([]);
    // Static-key env resolution is applied through the seam.
    expect(deps.calls.env).toContain("sk-literal-123");
  });

  test("static key: undefined authMode is treated as a static key", async () => {
    const deps = spyDeps();
    const provider = makeProvider({ apiKey: "sk-literal-999" });
    const result = await resolveProviderAuth(makeConfig(), "p", provider, deps);

    expect(result.apiKey).toBe("sk-literal-999");
    expect(deps.calls.oauth).toEqual([]);
    expect(deps.calls.grant).toEqual([]);
  });

  test("static key: ${ENV} reference resolves via the real resolveEnvValue (default deps)", async () => {
    process.env[ENV_KEY] = "sk-from-env";
    const provider = makeProvider({ authMode: "key", apiKey: `\${${ENV_KEY}}` });

    // Default (production) deps: oauth/grant resolvers are never touched for static keys.
    const result = await resolveProviderAuth(makeConfig(), "p", provider);

    expect(result.apiKey).toBe("sk-from-env");
  });

  test("static key: apiKeys-only provider resolves the first apiKeys candidate when apiKey is empty", async () => {
    const deps = spyDeps();
    const provider = makeProvider({ authMode: "key", apiKey: undefined, apiKeys: ["sk-first-777", "sk-second-888"] });
    const result = await resolveProviderAuth(makeConfig(), "p", provider, deps);

    // An empty primary apiKey still resolves the first usable apiKeys entry (effectiveKeyCandidates[0]).
    expect(result.apiKey).toBe("sk-first-777");
    expect(deps.calls.oauth).toEqual([]);
    expect(deps.calls.grant).toEqual([]);
  });

  test("static key: a primary apiKey takes priority over apiKeys entries", async () => {
    const deps = spyDeps();
    const provider = makeProvider({ authMode: "key", apiKey: "sk-primary-111", apiKeys: ["sk-extra-222"] });
    const result = await resolveProviderAuth(makeConfig(), "p", provider, deps);

    expect(result.apiKey).toBe("sk-primary-111");
  });

  test("oauth: resolves through getOAuthAccessToken with the provider name; grant resolver untouched", async () => {
    const deps = spyDeps();
    const provider = makeProvider({ authMode: "oauth", apiKey: "ignored-static" });
    const result = await resolveProviderAuth(makeConfig(), "my-oauth", provider, deps);

    expect(result.apiKey).toBe(OAUTH_TOKEN);
    expect(deps.calls.oauth).toEqual(["my-oauth"]);
    expect(deps.calls.grant).toEqual([]);
  });

  test("claude-grant: resolves through getClaudeGrantAccessToken with (config, name, provider); oauth resolver untouched", async () => {
    const deps = spyDeps();
    const config = makeConfig();
    const provider = makeProvider({ authMode: "claude-grant", claudeGrantId: "cg_abc" });
    const result = await resolveProviderAuth(config, "grant-prov", provider, deps);

    expect(result.apiKey).toBe(GRANT_TOKEN);
    expect(deps.calls.grant.length).toBe(1);
    expect(deps.calls.grant[0]!.name).toBe("grant-prov");
    // The core resolver receives the shared config and the ORIGINAL provider (for claudeGrantId).
    expect(deps.calls.grant[0]!.config).toBe(config);
    expect(deps.calls.grant[0]!.provider).toBe(provider);
    expect(deps.calls.oauth).toEqual([]);
  });

  test("forward: no key injection and neither token resolver is invoked", async () => {
    const deps = spyDeps();
    const withKey = makeProvider({ authMode: "forward", apiKey: "unused" });
    const withKeyResult = await resolveProviderAuth(makeConfig(), "fwd", withKey, deps);
    // forward NEVER injects a credential: any (stale) static key is explicitly cleared so it can
    // never leak as a bearer; the adapter relays only allowlisted caller auth headers.
    expect(withKeyResult.apiKey).toBeUndefined();

    const noKey = makeProvider({ authMode: "forward" });
    const noKeyResult = await resolveProviderAuth(makeConfig(), "fwd", noKey, deps);
    expect(noKeyResult.apiKey).toBeUndefined();

    expect(deps.calls.oauth).toEqual([]);
    expect(deps.calls.grant).toEqual([]);
  });

  test("immutability: the input provider and shared config are not mutated; a fresh copy is returned", async () => {
    const deps = spyDeps();
    const provider = makeProvider({ authMode: "oauth", apiKey: "orig-static", headers: { "x-test": "1" } });
    const config = makeConfig({ p: provider });
    const originalApiKey = provider.apiKey;

    const result = await resolveProviderAuth(config, "p", provider, deps);

    expect(result).not.toBe(provider);
    expect(result.apiKey).toBe(OAUTH_TOKEN);
    // Input provider and the shared config entry keep their original apiKey.
    expect(provider.apiKey).toBe(originalApiKey);
    expect(config.providers.p!.apiKey).toBe(originalApiKey);
  });

  test("error redaction: a claude-grant failure surfaces the typed error verbatim, without credential text", async () => {
    const grantError = new ClaudeGrantError(
      "reauth_required",
      "claude grant cg_abc has no usable credential and cannot be refreshed",
      "cg_abc",
    );
    const deps = spyDeps({
      getClaudeGrantAccessToken: async () => {
        throw grantError;
      },
    });
    const provider = makeProvider({ authMode: "claude-grant", claudeGrantId: "cg_abc" });

    let caught: unknown;
    try {
      await resolveProviderAuth(makeConfig(), "p", provider, deps);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(grantError);
    expect(caught instanceof ClaudeGrantError).toBe(true);
    expect((caught as ClaudeGrantError).code).toBe("reauth_required");
    // The seam must not append token/refresh/credential material to the surfaced message.
    const message = (caught as Error).message;
    expect(message).not.toContain("accessToken");
    expect(message).not.toContain("refreshToken");
    expect(message).not.toContain("claudeAiOauth");
  });

  test("error propagation: an oauth failure rejects with the original error", async () => {
    const oauthError = new Error("Not logged in to p. Run: frogp login p");
    const deps = spyDeps({
      getOAuthAccessToken: async () => {
        throw oauthError;
      },
    });
    const provider = makeProvider({ authMode: "oauth" });

    await expect(resolveProviderAuth(makeConfig(), "p", provider, deps)).rejects.toBe(oauthError);
    expect(deps.calls.grant).toEqual([]);
  });

  test("claude-grant: a look-alike / non-Anthropic target fails closed BEFORE the broker with a fixed redacted error", async () => {
    const deps = spyDeps();
    const provider = makeProvider({
      authMode: "claude-grant",
      claudeGrantId: "cg_secret_id_123",
      baseUrl: "https://api.anthropic.com.attacker.net",
    });

    let caught: unknown;
    try {
      await resolveProviderAuth(makeConfig(), "grant-prov", provider, deps);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ClaudeGrantError);
    expect((caught as ClaudeGrantError).code).toBe("not_bound");
    // Fail-closed: the grant broker never ran (no credential access, no network).
    expect(deps.calls.grant).toEqual([]);
    // Redaction: the fixed message never leaks the rejected host or the grant id.
    const message = (caught as Error).message;
    expect(message).not.toContain("attacker");
    expect(message).not.toContain("cg_secret_id_123");
  });

  test("claude-grant: the allowed real Anthropic target still resolves through the broker", async () => {
    const deps = spyDeps();
    const provider = makeProvider({ authMode: "claude-grant", claudeGrantId: "cg_ok", baseUrl: "https://api.anthropic.com/v1" });
    const result = await resolveProviderAuth(makeConfig(), "grant-prov", provider, deps);

    expect(result.apiKey).toBe(GRANT_TOKEN);
    expect(deps.calls.grant.length).toBe(1);
  });

  test("claude-grant: an injected validateClaudeGrantTarget admits a fixture host the production guard rejects", async () => {
    const deps = spyDeps({ validateClaudeGrantTarget: () => {} });
    const provider = makeProvider({ authMode: "claude-grant", claudeGrantId: "cg_fixture", baseUrl: "https://grant-provider.test" });
    const result = await resolveProviderAuth(makeConfig(), "grant-prov", provider, deps);

    expect(result.apiKey).toBe(GRANT_TOKEN);
    expect(deps.calls.grant.length).toBe(1);
  });
});

describe("isAllowedClaudeGrantBaseUrl", () => {
  test("accepts the anthropic adapter over https to exactly api.anthropic.com with an allowed path", () => {
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com" }))).toBe(true);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com/" }))).toBe(true);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com/v1" }))).toBe(true);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com:443" }))).toBe(true);
  });

  test("rejects wrong adapter, scheme, host, embedded credentials, non-default port, path, or query", () => {
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ adapter: "openai-chat", baseUrl: "https://api.anthropic.com" }))).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "http://api.anthropic.com" }))).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com.attacker.net" }))).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://user:pass@api.anthropic.com" }))).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com:8443" }))).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com/v2" }))).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com/v1/models?x=1" }))).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "not-a-valid-url" }))).toBe(false);
  });

  test("reserved test hosts are rejected by default and admitted only via the explicit option", () => {
    const dotTest = makeProvider({ baseUrl: "https://grant-provider.test" });
    expect(isAllowedClaudeGrantBaseUrl(dotTest)).toBe(false);
    expect(isAllowedClaudeGrantBaseUrl(dotTest, { allowReservedTestHosts: true })).toBe(true);
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://probe.example" }), { allowReservedTestHosts: true })).toBe(true);
    // A non-reserved look-alike is never admitted, even with the test option on.
    expect(isAllowedClaudeGrantBaseUrl(makeProvider({ baseUrl: "https://api.anthropic.com.attacker.net" }), { allowReservedTestHosts: true })).toBe(false);
  });
});

describe("assertAllowedClaudeGrantTarget", () => {
  test("passes an allowed target and throws a fixed redacted ClaudeGrantError otherwise", () => {
    expect(() => assertAllowedClaudeGrantTarget(makeProvider({ baseUrl: "https://api.anthropic.com" }))).not.toThrow();

    let caught: unknown;
    try {
      assertAllowedClaudeGrantTarget(makeProvider({ claudeGrantId: "cg_leak_id", baseUrl: "https://evil.proxy.net" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeGrantError);
    expect((caught as ClaudeGrantError).code).toBe("not_bound");
    const message = (caught as Error).message;
    expect(message).not.toContain("evil.proxy.net");
    expect(message).not.toContain("cg_leak_id");
  });
});
