import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __requestLogTest } from "../src/server";
import type { FrogConfig, FrogProviderConfig } from "../src/types";
import { testProviderConnection } from "../src/provider-test";
import { ClaudeGrantError } from "../src/claude-grant-auth";

let previousFrogHome: string | undefined;
let testHome = "";
let originalFetch: typeof fetch;

interface FetchAttempt {
  url: string;
  method?: string;
  headers: Record<string, string>;
}

function provider(overrides: Partial<FrogProviderConfig> = {}): FrogProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://saved-provider.test/v1",
    apiKey: "sk-saved-secret-1234",
    defaultModel: "model-a",
    models: ["model-a"],
    ...overrides,
  };
}

function config(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "saved",
    providers: {
      saved: provider(),
      forward: provider({
        adapter: "openai-responses",
        baseUrl: "https://forward-provider.test/v1",
        authMode: "forward",
        apiKey: undefined,
      }),
    },
  };
}

function modelsResponse(ids: string[], status = 200): Response {
  return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function upstreamErrorResponse(status: number): Response {
  return new Response(
    JSON.stringify({
      error: "RAW_UPSTREAM_BODY_SENTINEL",
      detail: "https://saved-provider.test/v1/models Authorization Bearer sk-error-secret-9999 x-custom-secret custom-header-secret-8888",
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function installFetchMock(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): FetchAttempt[] {
  const attempts: FetchAttempt[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    attempts.push({
      url,
      method: init?.method,
      headers: Object.fromEntries(headers.entries()),
    });
    return handler(url, init);
  }) as typeof fetch;
  return attempts;
}

async function postProviderTest(cfg: FrogConfig, body: unknown, init: RequestInit = {}): Promise<Response> {
  return (await __requestLogTest.handleManagementAPI(
    new Request("http://localhost/api/providers/test", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    }),
    new URL("http://localhost/api/providers/test"),
    cfg,
    { saveConfig: () => { throw new Error("provider test must not persist config"); } },
  ))!;
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "frog-provider-test-api-"));
  process.env.FROGPROGSY_HOME = testHome;
  originalFetch = globalThis.fetch;
  __requestLogTest.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
  __requestLogTest.clear();
});

describe("provider connection test API", () => {
  test("tests a saved provider successfully through the shared models request", async () => {
    const cfg = config();
    const attempts = installFetchMock(() => modelsResponse(["model-a", "model-b"]));

    const res = await postProviderTest(cfg, { name: "saved" });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "ok",
      code: "ok",
      httpStatus: 200,
      modelCount: 2,
      provider: "saved",
      adapter: "openai-chat",
      authMode: "key",
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      url: "https://saved-provider.test/v1/models",
      method: "GET",
    });
    expect(attempts[0]?.headers.authorization).toBe("Bearer sk-saved-secret-1234");
    expect(JSON.stringify(body)).not.toContain("sk-saved-secret-1234");
  });

  test("tests saved provider with apiKeys-only credential without exposing it", async () => {
    const cfg = config();
    cfg.providers.saved = provider({
      apiKey: undefined,
      apiKeys: ["sk-extra-secret-2222", "sk-unused-secret-3333"],
    });
    const attempts = installFetchMock(() => modelsResponse(["model-extra"]));

    const res = await postProviderTest(cfg, { name: "saved" });
    const body = await res.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "ok",
      code: "ok",
      provider: "saved",
      authMode: "key",
      modelCount: 1,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.headers.authorization).toBe("Bearer sk-extra-secret-2222");
    expect(serialized).not.toContain("sk-extra-secret-2222");
    expect(serialized).not.toContain("sk-unused-secret-3333");
  });

  test("tests draft provider with primary apiKey before extra apiKeys without saving", async () => {
    const cfg = config();
    const attempts = installFetchMock(() => modelsResponse(["model-draft"]));

    const res = await postProviderTest(cfg, {
      name: "draft-extra",
      provider: {
        adapter: "openai-chat",
        baseUrl: "https://draft-extra.test/v1",
        apiKey: "sk-draft-primary-1111",
        apiKeys: ["sk-draft-extra-2222"],
      },
    });
    const body = await res.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "ok",
      code: "ok",
      provider: "draft-extra",
      authMode: "key",
      modelCount: 1,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.url).toBe("https://draft-extra.test/v1/models");
    expect(attempts[0]?.headers.authorization).toBe("Bearer sk-draft-primary-1111");
    expect(cfg.providers["draft-extra"]).toBeUndefined();
    expect(serialized).not.toContain("sk-draft-primary-1111");
    expect(serialized).not.toContain("sk-draft-extra-2222");
  });

  test("tests a draft provider successfully without saving it", async () => {
    const cfg = config();
    const attempts = installFetchMock(() => modelsResponse(["claude-model"]));

    const res = await postProviderTest(cfg, {
      name: "draft",
      provider: {
        adapter: "anthropic",
        baseUrl: "https://draft-provider.test",
        apiKey: "sk-draft-secret-5678",
      },
    });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "ok",
      code: "ok",
      provider: "draft",
      adapter: "anthropic",
      authMode: "key",
      modelCount: 1,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.url).toBe("https://draft-provider.test/v1/models?limit=1000");
    expect(attempts[0]?.headers["x-api-key"]).toBe("sk-draft-secret-5678");
    expect(cfg.providers.draft).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sk-draft-secret-5678");
  });

  test("normalizes non-200 responses without raw upstream body, secret, URL, or header echo", async () => {
    const cfg = config();
    cfg.providers.saved = provider({
      apiKey: "sk-error-secret-9999",
      headers: { "x-custom-secret": "custom-header-secret-8888" },
    });
    installFetchMock(() => upstreamErrorResponse(503));

    const res = await postProviderTest(cfg, { name: "saved" });
    const body = await res.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "error",
      code: "http_error",
      httpStatus: 503,
      provider: "saved",
    });
    expect(serialized).not.toContain("RAW_UPSTREAM_BODY_SENTINEL");
    expect(serialized).not.toContain("sk-error-secret-9999");
    expect(serialized).not.toContain("custom-header-secret-8888");
    expect(serialized).not.toContain("https://saved-provider.test");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("x-custom-secret");
  });

  test("skips forward-auth providers without fetching", async () => {
    const cfg = config();
    const attempts = installFetchMock(() => {
      throw new Error("forward provider test must not fetch");
    });

    const res = await postProviderTest(cfg, { name: "forward" });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "skipped",
      provider: "forward",
      adapter: "openai-responses",
      authMode: "forward",
    });
    expect(String(body.code)).toContain("forward_auth");
    expect(attempts).toEqual([]);
  });

  test("rejects malformed provider test requests with 400", async () => {
    const cfg = config();
    installFetchMock(() => {
      throw new Error("malformed request must not fetch");
    });

    const invalidJson = await postProviderTest(cfg, "{");
    expect(invalidJson.status).toBe(400);

    const missingDraftFields = await postProviderTest(cfg, { name: "draft", provider: { adapter: "openai-chat" } });
    expect(missingDraftFields.status).toBe(400);
  });

  test("returns 404 for unknown saved providers", async () => {
    const cfg = config();
    installFetchMock(() => {
      throw new Error("unknown provider must not fetch");
    });

    const res = await postProviderTest(cfg, { name: "missing" });
    const body = await res.json() as { error?: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe("unknown provider");
  });

  test("blocks cross-origin provider test mutations before fetching", async () => {
    const cfg = config();
    const attempts = installFetchMock(() => {
      throw new Error("cross-origin request must not fetch");
    });

    const res = await postProviderTest(cfg, { name: "saved" }, { headers: { Origin: "https://evil.example" } });
    const body = await res.json() as { error?: string };

    expect(res.status).toBe(403);
    expect(body.error).toBe("cross-origin request blocked");
    expect(attempts).toEqual([]);
  });

  test("rejects redacted provider credential placeholders before saving providers", async () => {
    const cfg = config();
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "saved",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://saved-provider.test/v1",
            apiKey: "sk-...1234",
            apiKeys: ["..."],
            headers: { Authorization: "Be...9999" },
          },
        }),
      }),
      new URL("http://localhost/api/providers"),
      cfg,
      { saveConfig: () => { throw new Error("redacted provider placeholders must not persist"); } },
    );
    const body = await res!.json() as { error?: string };

    expect(res?.status).toBe(400);
    expect(body.error).toContain("redacted credential");
    expect(cfg.providers.saved?.apiKey).toBe("sk-saved-secret-1234");
  });
  test("rejects catalog Anthropic pass-through providers without a Claude Code home", async () => {
    const cfg = config();
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "anthropic-work",
          catalogId: "anthropic",
          provider: {
            adapter: "anthropic",
            baseUrl: "https://api.anthropic.com",
            authMode: "forward",
          },
        }),
      }),
      new URL("http://localhost/api/providers"),
      cfg,
      { saveConfig: () => { throw new Error("invalid Anthropic home must not persist"); } },
    );
    const body = await res!.json() as { error?: string };

    expect(res?.status).toBe(400);
    expect(body.error).toBe("Claude Code home path is required");
    expect(cfg.providers["anthropic-work"]).toBeUndefined();
  });
  test("adding renamed Anthropic pass-through provider preserves catalog metadata and registers Claude Code home", async () => {
    const cfg = config();
    const defaultHome = join(testHome, ".claude");
    const workHome = join(testHome, ".claude-work");
    cfg.claudeProfiles = {
      schemaVersion: 1,
      defaultProfileId: "cp_default",
      profiles: [{ id: "cp_default", name: "Default Claude Code", claudeHome: defaultHome, authState: "not_seen" }],
    };

    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "anthropic-work",
          catalogId: "anthropic",
          claudeHome: workHome,
          provider: {
            adapter: "anthropic",
            baseUrl: "https://api.anthropic.com",
            authMode: "forward",
            defaultModel: "claude-sonnet-4-6",
          },
        }),
      }),
      new URL("http://localhost/api/providers"),
      cfg,
      { saveConfig: () => {} },
    );
    const body = await res!.json() as { success?: boolean; name?: string };

    expect(res?.status).toBe(200);
    expect(body).toMatchObject({ success: true, name: "anthropic-work" });
    expect(cfg.providers["anthropic-work"]?.authMode).toBe("forward");
    expect(cfg.providers["anthropic-work"]?.models).toContain("claude-sonnet-4-6");
    expect(cfg.claudeProfiles?.profiles).toContainEqual(expect.objectContaining({
      name: "anthropic-work",
      claudeHome: workHome,
      authState: "not_seen",
    }));
  });
});
describe("claude-grant provider connection test", () => {
  const GRANT_TOKEN = "grant-access-token-SECRET-7777";
  const GRANT_ID = "cg_secret_grant_id_9999";

  function grantProvider(overrides: Partial<FrogProviderConfig> = {}): FrogProviderConfig {
    return provider({
      adapter: "anthropic",
      baseUrl: "https://grant-provider.test",
      apiKey: undefined,
      authMode: "claude-grant",
      claudeGrantId: GRANT_ID,
      defaultModel: "claude-x",
      models: ["claude-x"],
      ...overrides,
    });
  }

  test("missing grant (no config, no resolver) fails closed with auth_missing and zero network calls", async () => {
    const attempts = installFetchMock(() => {
      throw new Error("missing grant must not fetch");
    });

    const result = await testProviderConnection("grant", grantProvider());
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: false,
      status: "error",
      code: "auth_missing",
      provider: "grant",
      adapter: "anthropic",
      authMode: "claude-grant",
    });
    expect(attempts).toEqual([]);
    expect(result.httpStatus).toBeUndefined();
    expect(serialized).not.toContain(GRANT_TOKEN);
    expect(serialized).not.toContain(GRANT_ID);
  });

  test("config-bound default resolveProviderAuth fails closed to auth_missing when the grant is absent, without fetching", async () => {
    const attempts = installFetchMock(() => {
      throw new Error("unresolved grant must not fetch");
    });
    // config() has no claudeGrants, so the real resolveProviderAuth -> getClaudeGrantAccessToken throws
    // not_bound before touching any credential store or the network.
    const result = await testProviderConnection("grant", grantProvider(), { config: config() });

    expect(result).toMatchObject({ ok: false, status: "error", code: "auth_missing", authMode: "claude-grant" });
    expect(attempts).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(GRANT_ID);
  });

  test("not_bound / no_credential map to auth_missing without fetching or leaking raw detail", async () => {
    for (const code of ["not_bound", "no_credential"] as const) {
      const attempts = installFetchMock(() => {
        throw new Error("grant auth failure must not fetch");
      });
      const result = await testProviderConnection("grant", grantProvider(), {
        config: config(),
        resolveAuth: async () => {
          throw new ClaudeGrantError(code, `claude grant ${GRANT_ID} failed (${code})`, GRANT_ID);
        },
      });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ ok: false, status: "error", code: "auth_missing" });
      expect(attempts).toEqual([]);
      expect(serialized).not.toContain(GRANT_ID);
      expect(serialized).not.toContain(code);
    }
  });

  test("reauth_required / refresh_unavailable / unreadable map to typed auth error without fetching or leaking detail", async () => {
    for (const code of ["reauth_required", "refresh_unavailable", "unreadable"] as const) {
      const attempts = installFetchMock(() => {
        throw new Error("grant auth failure must not fetch");
      });
      const result = await testProviderConnection("grant", grantProvider(), {
        config: config(),
        resolveAuth: async () => {
          throw new ClaudeGrantError(code, `claude grant ${GRANT_ID} failed (${code})`, GRANT_ID);
        },
      });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ ok: false, status: "error", code: "auth" });
      expect(attempts).toEqual([]);
      expect(serialized).not.toContain(GRANT_ID);
      expect(serialized).not.toContain(code);
    }
  });

  test("non-typed grant errors degrade to a generic auth error without fetching or leaking the thrown message", async () => {
    const attempts = installFetchMock(() => {
      throw new Error("grant auth failure must not fetch");
    });
    const result = await testProviderConnection("grant", grantProvider(), {
      config: config(),
      resolveAuth: async () => {
        throw new Error(`opaque failure for ${GRANT_ID} token ${GRANT_TOKEN}`);
      },
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ ok: false, status: "error", code: "auth" });
    expect(attempts).toEqual([]);
    expect(serialized).not.toContain(GRANT_ID);
    expect(serialized).not.toContain(GRANT_TOKEN);
  });

  test("successful grant token (resolveProviderAuth seam) uses the Anthropic probe and isolates the token to the request header", async () => {
    const attempts = installFetchMock(() => modelsResponse(["claude-x", "claude-y"]));

    const result = await testProviderConnection("grant", grantProvider(), {
      config: config(),
      resolveAuth: async (_cfg, _name, prov) => ({ ...prov, apiKey: GRANT_TOKEN }),
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: true,
      status: "ok",
      code: "ok",
      httpStatus: 200,
      modelCount: 2,
      provider: "grant",
      adapter: "anthropic",
      authMode: "claude-grant",
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.url).toBe("https://grant-provider.test/v1/models?limit=1000");
    expect(attempts[0]?.method).toBe("GET");
    expect(attempts[0]?.headers.authorization).toBe(`Bearer ${GRANT_TOKEN}`);
    expect(attempts[0]?.headers["anthropic-beta"]).toBeDefined();
    expect(attempts[0]?.headers["x-api-key"]).toBeUndefined();
    expect(serialized).not.toContain(GRANT_TOKEN);
  });
});

describe("provider connection test auth-mode invariance", () => {
  test("forward providers stay skipped without fetching", async () => {
    const attempts = installFetchMock(() => {
      throw new Error("forward provider must not fetch");
    });
    const result = await testProviderConnection("forward", provider({
      adapter: "openai-responses",
      authMode: "forward",
      apiKey: undefined,
    }));

    expect(result).toMatchObject({ ok: false, status: "skipped", code: "forward_auth_unsupported", authMode: "forward" });
    expect(attempts).toEqual([]);
  });

  test("oauth providers without a stored credential stay skipped without fetching", async () => {
    const attempts = installFetchMock(() => {
      throw new Error("logged-out oauth provider must not fetch");
    });
    const result = await testProviderConnection("saved", provider({ authMode: "oauth", apiKey: undefined }));

    expect(result).toMatchObject({ ok: false, status: "skipped", code: "oauth_not_logged_in", authMode: "oauth" });
    expect(attempts).toEqual([]);
  });

  test("static key providers still probe with their configured key without leaking it", async () => {
    const attempts = installFetchMock(() => modelsResponse(["model-a"]));
    const result = await testProviderConnection("saved", provider());
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ ok: true, status: "ok", code: "ok", authMode: "key", modelCount: 1 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.headers.authorization).toBe("Bearer sk-saved-secret-1234");
    expect(serialized).not.toContain("sk-saved-secret-1234");
  });

  test("static key providers using apiKeys array still probe with the first key without leaking it", async () => {
    const attempts = installFetchMock(() => modelsResponse(["model-extra"]));
    const result = await testProviderConnection("saved", provider({
      apiKey: undefined,
      apiKeys: ["sk-extra-secret-2222", "sk-unused-secret-3333"],
    }));
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ ok: true, status: "ok", code: "ok", authMode: "key", modelCount: 1 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.headers.authorization).toBe("Bearer sk-extra-secret-2222");
    expect(serialized).not.toContain("sk-extra-secret-2222");
    expect(serialized).not.toContain("sk-unused-secret-3333");
  });
});

describe("claude-grant provider connection test API route", () => {
  test("route delegates to fail-closed auth_missing for a saved grant provider without any network call", async () => {
    const cfg = config();
    cfg.providers.grant = {
      adapter: "anthropic",
      baseUrl: "https://grant-provider.test",
      authMode: "claude-grant",
      claudeGrantId: "cg_secret_grant_id_9999",
      defaultModel: "claude-x",
      models: ["claude-x"],
    };
    const attempts = installFetchMock(() => {
      throw new Error("grant provider route must not fetch");
    });

    const res = await postProviderTest(cfg, { name: "grant" });
    const body = await res.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "error",
      code: "auth_missing",
      provider: "grant",
      adapter: "anthropic",
      authMode: "claude-grant",
    });
    expect(attempts).toEqual([]);
    expect(serialized).not.toContain("cg_secret_grant_id_9999");
  });
});
