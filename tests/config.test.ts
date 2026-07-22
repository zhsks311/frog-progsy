import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential, saveCredential } from "../src/oauth/store";
import { dropRuntimeFixtureProviders, getDefaultConfig, saveConfig } from "../src/config";

describe("frogprogsy config defaults", () => {

  test("fresh install defaults to Anthropic forward auth", () => {
    const config = getDefaultConfig();
    expect(config.defaultProvider).toBe("anthropic");
    expect(config.providers.anthropic).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "forward",
      defaultModel: "claude-sonnet-4-6",
    });
    expect(config.providers.openai).toBeUndefined();
  });

  test("runtime fixture providers are stripped before proxy startup persists config", () => {
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "routed",
      providers: {
        routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "fixture-key" },
        chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/backend-api/codex", authMode: "forward" as const },
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" as const, defaultModel: "claude-sonnet-4-6" },
        anthropicForward: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward" as const },
      },
    };

    expect(dropRuntimeFixtureProviders(config)).toEqual(["routed", "chatgpt", "anthropicForward"]);
    expect(config.providers.routed).toBeUndefined();
    expect(config.providers.chatgpt).toBeUndefined();
    expect(config.providers.anthropicForward).toBeUndefined();
    expect(config.providers.anthropic).toBeDefined();
    expect(config.defaultProvider).toBe("anthropic");
  });

  test("fixture stripping restores native fallback only when nothing real remains", () => {
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "routed",
      providers: {
        routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "fixture-key" },
      },
    };

    expect(dropRuntimeFixtureProviders(config)).toEqual(["routed"]);
    expect(config.defaultProvider).toBe("anthropic");
    expect(config.providers.anthropic?.baseUrl).toBe("https://api.anthropic.com");
  });

  test("test runtime refuses to write to the real frogprogsy home", () => {
    const previous = process.env.FROGPROGSY_HOME;
    try {
      delete process.env.FROGPROGSY_HOME;
      expect(() => saveConfig(getDefaultConfig())).toThrow(/refused to write .*NODE_ENV=test/);
    } finally {
      if (previous === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previous;
    }
  });

  test("OAuth token store follows FROGPROGSY_HOME at call time", () => {
    const previous = process.env.FROGPROGSY_HOME;
    const first = mkdtempSync(join(tmpdir(), "frog-auth-first-"));
    const second = mkdtempSync(join(tmpdir(), "frog-auth-second-"));
    try {
      process.env.FROGPROGSY_HOME = first;
      saveCredential("codex", { access: "first-access", refresh: "first-refresh", expires: Date.now() + 60_000 });

      process.env.FROGPROGSY_HOME = second;
      expect(getCredential("codex")).toBeNull();

      process.env.FROGPROGSY_HOME = first;
      expect(getCredential("codex")?.access).toBe("first-access");
    } finally {
      if (previous === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previous;
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});
