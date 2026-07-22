import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildProfileFile, buildProviderTableBlock, chooseCatalogPathForInjection, injectClaudeCodeConfig, restoreNativeClaudeCode, stripFrogProgsyConfig } from "../src/claude-inject";
import type { FrogConfig } from "../src/types";

describe("Claude Code config injection", () => {
  test("omits provider-level Responses WebSocket support by default", () => {
    const block = buildProviderTableBlock(10100);

    expect(block).toContain("[model_providers.frogprogsy]");
    expect(block).toContain('wire_api = "messages"');
    expect(block).toContain("requires_openai_auth = true");
    expect(block).not.toContain("supports_websockets");
  });

  test("can suppress provider-level Responses WebSocket support for explicit opt-out", () => {
    const block = buildProviderTableBlock(10100, false);

    expect(block).not.toContain("supports_websockets");
  });

  test("does not advertise retired Responses WebSocket support even for explicit opt-in", () => {
    const block = buildProviderTableBlock(10100, true);

    expect(block).not.toContain("supports_websockets");
  });

  test("removes stale root context-window overrides so catalog limits drive Claude Code", () => {
    const stripped = stripFrogProgsyConfig([
      'model = "gpt-5.5"',
      'model_context_window = 1000000',
      'model_auto_compact_token_limit = 900000',
      'model_catalog_json = "/Users/jun/.claude/frogprogsy-catalog.json"',
      'model_provider = "frogprogsy"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));

    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).not.toContain("model_context_window");
    expect(stripped).not.toContain("model_auto_compact_token_limit");
    expect(stripped).not.toContain("model_provider");
    expect(stripped).not.toContain("model_catalog_json");
  });

  test("removes root routed model names when restoring native Claude Code", () => {
    const stripped = stripFrogProgsyConfig([
      'model = "opencode-go/minimax-m3"',
      'model_verbosity = "high"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));

    expect(stripped).not.toContain('model = "opencode-go/minimax-m3"');
    expect(stripped).toContain('model_verbosity = "high"');
  });

  test("can build fallback profile without a model catalog path", () => {
    const profile = buildProfileFile(10100, null);

    expect(profile).toContain('model_provider = "frogprogsy"');
    expect(profile).not.toContain("model_catalog_json");
  });

  test("honors an explicit unavailable catalog decision", () => {
    const path = chooseCatalogPathForInjection('model_catalog_json = "/tmp/frogprogsy-catalog.json"\n', null);

    expect(path).toBeNull();
  });

  test("native restore path also strips legacy config.toml wiring", async () => {
    const source = await Bun.file(new URL("../src/claude-inject.ts", import.meta.url)).text();

    expect(source).toContain("const toml = restoreClaudeCodeTomlConfig(options);");
    expect(source).toContain("success: settings.success && toml.success");
  });

  test("home injection honors the configured sentinel rollback and token-free default", async () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-inject-claude-"));
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-inject-home-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    try {
      writeFileSync(join(claudeHome, "settings.json"), "{}\n");
      const config = {
        port: 10100,
        defaultProvider: "anthropic",
        providers: {},
        gatewayAuthCarrier: "sentinel",
      } as FrogConfig;

      expect((await injectClaudeCodeConfig(10100, config, { claudeHome, profileId: "cp_inject_test" })).success).toBe(true);
      const sentinelSettings = JSON.parse(await Bun.file(join(claudeHome, "settings.json")).text());
      expect(sentinelSettings.env.ANTHROPIC_AUTH_TOKEN).toBe("local-frogprogsy");

      config.gatewayAuthCarrier = "token-free";
      expect((await injectClaudeCodeConfig(10100, config, { claudeHome, profileId: "cp_inject_test" })).success).toBe(true);
      const tokenFreeSettings = JSON.parse(await Bun.file(join(claudeHome, "settings.json")).text());
      expect(tokenFreeSettings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(claudeHome, { recursive: true, force: true });
      rmSync(frogHome, { recursive: true, force: true });
    }
  });
  test("native restore removes the prewritten gateway model cache", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-restore-claude-"));
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-restore-home-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    const cachePath = join(claudeHome, "cache", "gateway-models.json");
    try {
      mkdirSync(join(claudeHome, "cache"), { recursive: true });
      writeFileSync(join(claudeHome, "settings.json"), "{}\n");
      writeFileSync(cachePath, '{"models":[]}\n');

      const restored = restoreNativeClaudeCode({ claudeHome, profileId: "cp_restore_test" });

      expect(restored.success).toBe(true);
      expect(restored.message).toContain("Removed Claude Code gateway models cache");
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(claudeHome, { recursive: true, force: true });
      rmSync(frogHome, { recursive: true, force: true });
    }
  });
});
