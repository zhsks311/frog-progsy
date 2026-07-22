import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCache } from "../src/model-cache";
import { getCredential, saveCredential } from "../src/oauth/store";
import { __requestLogTest } from "../src/server";
import type { FrogConfig } from "../src/types";

let previousFrogHome: string | undefined;
let testHome = "";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testHome = mkdtempSync(join(tmpdir(), "frog-oauth-mgmt-"));
  process.env.FROGPROGSY_HOME = testHome;
  clearModelCache("anthropic");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("anthropic");
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

function baseConfig(): FrogConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "codex",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.test/backend-api/codex",
        authMode: "oauth",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.5"],
      },
    },
  };
}

function saveCredentialFor(provider: string): void {
  saveCredential(provider, {
    access: `${provider}-access`,
    refresh: `${provider}-refresh`,
    expires: Date.now() + 10 * 60_000,
  });
}

describe("OAuth management API reconciliation", () => {
  test("/api/models does not resurrect a stored Anthropic credential as an OAuth provider", async () => {
    saveCredentialFor("anthropic");
    globalThis.fetch = (async () => new Response("upstream unavailable", { status: 500 })) as typeof fetch;
    const cfg = baseConfig();
    let saved: FrogConfig | undefined;

    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/models"),
      new URL("http://localhost/api/models"),
      cfg,
      { saveConfig: config => { saved = JSON.parse(JSON.stringify(config)) as FrogConfig; } },
    );

    expect(res?.status).toBe(200);
    expect(cfg.providers.anthropic).toBeUndefined();
    expect(saved).toBeUndefined();
    const rows = await res!.json() as Array<{ provider: string; id: string; namespaced: string }>;
    expect(rows.some(row => row.provider === "anthropic" || row.namespaced.startsWith("anthropic/"))).toBe(false);
    expect(getCredential("anthropic")).toMatchObject({ access: "anthropic-access" });
  });

  test("deleting a supported OAuth provider removes its dangling credential", async () => {
    saveCredentialFor("codex");
    const cfg = baseConfig();
    cfg.defaultProvider = "anthropic";
    cfg.providers.anthropic = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.test",
      authMode: "forward",
      defaultModel: "claude-sonnet-4-6",
      models: ["claude-sonnet-4-6"],
    };

    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/providers?name=codex", { method: "DELETE" }),
      new URL("http://localhost/api/providers?name=codex"),
      cfg,
      { saveConfig: () => {} },
    );

    expect(res?.status).toBe(200);
    expect(cfg.providers.codex).toBeUndefined();
    expect(getCredential("codex")).toBeNull();
  });
});
