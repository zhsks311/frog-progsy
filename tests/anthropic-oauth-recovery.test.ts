import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loginProviderGroups } from "../src/oauth/login-cli";
import { OAUTH_PROVIDERS, listOAuthProviders, refreshOAuthCredential } from "../src/oauth";
import { deriveOAuthIds, deriveOAuthProviderConfig, deriveProviderPresets } from "../src/providers/derive";

describe("Anthropic OAuth removal", () => {
  test("does not register Anthropic as an OAuth login or refresh provider", async () => {
    expect(OAUTH_PROVIDERS.anthropic).toBeUndefined();
    expect(listOAuthProviders()).not.toContain("anthropic");
    expect(loginProviderGroups().oauth).not.toContain("anthropic");
    expect(deriveOAuthIds()).not.toContain("anthropic");
    expect(deriveOAuthProviderConfig("anthropic")).toBeUndefined();

    await expect(refreshOAuthCredential("anthropic", "stale-refresh"))
      .rejects.toThrow("Unknown OAuth provider: anthropic");
  });

  test("keeps Anthropic available as Claude Code pass-through guidance", () => {
    const anthropic = deriveProviderPresets().find(preset => preset.id === "anthropic");

    expect(anthropic).toMatchObject({
      id: "anthropic",
      adapter: "anthropic",
      auth: "forward",
    });
    expect(anthropic?.dashboardUrl).toBeUndefined();
    expect(anthropic?.oauthProvider).toBeUndefined();
    expect(anthropic?.note).toContain("Claude Code login");
  });

  test("OAuth registry no longer imports Anthropic login, refresh, or Claude Code recovery helpers", () => {
    const source = readFileSync(join(import.meta.dir, "../src/oauth/index.ts"), "utf8");

    expect(source).not.toContain("loginAnthropic");
    expect(source).not.toContain("refreshAnthropicToken");
    expect(source).not.toContain("recoverAnthropicTokenFromClaudeCode");
  });

  test("does not ship Claude Code keychain import or Anthropic refresh helpers", () => {
    const anthropicSource = readFileSync(join(import.meta.dir, "../src/oauth/anthropic.ts"), "utf8");
    const localTokenSource = readFileSync(join(import.meta.dir, "../src/oauth/local-token-detect.ts"), "utf8");

    expect(anthropicSource).not.toContain("oauth/token");
    expect(anthropicSource).not.toContain("loginAnthropic");
    expect(anthropicSource).not.toContain("refreshAnthropicToken");
    expect(anthropicSource).not.toContain("recoverAnthropicTokenFromClaudeCode");
    expect(localTokenSource).not.toContain("Claude Code-credentials");
    expect(localTokenSource).not.toContain("detectClaudeCodeToken");
  });
});
