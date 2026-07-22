import { describe, expect, test } from "bun:test";
import { addClaudeProfile, buildClaudeProfileNativeEnv, buildClaudeProfileRunEnv, ensureClaudeProfiles, managedClaudeProfiles, mergeClaudeProfileHeader, removeClaudeProfileHeader, renameClaudeProfile, resolveClaudeProfile } from "../src/claude-profiles";
import type { FrogConfig } from "../src/types";

function baseConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward", defaultModel: "claude-sonnet-4-6" },
    },
  };
}

describe("Claude Code homes", () => {
  test("adds user-named homes with stable ids and rename preserves id", () => {
    const config = baseConfig();
    const profile = addClaudeProfile(config, { id: "cp_work", name: "업무용", claudeHome: "/tmp/.claude-work" });

    expect(profile.id).toBe("cp_work");
    expect(resolveClaudeProfile(config, "업무용").id).toBe("cp_work");

    const renamed = renameClaudeProfile(config, "업무용", "업무용 Claude");
    expect(renamed.id).toBe("cp_work");
    expect(resolveClaudeProfile(config, "업무용 Claude").id).toBe("cp_work");
  });

  test("managed profiles target every configured home", () => {
    const config = baseConfig();
    const profiles = ensureClaudeProfiles(config);
    profiles.profiles[0]!.id = "cp_default";
    profiles.profiles[0]!.name = "기본";
    profiles.profiles[0]!.claudeHome = "/tmp/.claude";
    profiles.defaultProfileId = "cp_default";
    addClaudeProfile(config, { id: "cp_work", name: "업무", claudeHome: "/tmp/.claude-work" });

    expect(managedClaudeProfiles(config).map(p => p.id).sort()).toEqual(["cp_default", "cp_work"]);
  });

  test("profile header merge replaces only frogp profile header and preserves user headers", () => {
    const merged = mergeClaudeProfileHeader("X-User: keep\nX-Frogp-Claude-Profile: old\nX-Trace: yes", "cp_new");
    expect(merged.split("\n")).toEqual(["X-User: keep", "X-Trace: yes", "X-Frogp-Claude-Profile: cp_new"]);
    expect(removeClaudeProfileHeader(merged)).toBe("X-User: keep\nX-Trace: yes");
  });

  test("run env is token-free by default: no sentinel token, gateway routing + profile header preserved", () => {
    const env = buildClaudeProfileRunEnv({ id: "cp_run", name: "Run", claudeHome: "/tmp/.claude-run" }, 10100, "token-free", { ANTHROPIC_CUSTOM_HEADERS: "X-User: keep" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/.claude-run");
    expect(env.CLAUDE_HOME).toBe("/tmp/.claude-run");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:10100");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-User: keep\nX-Frogp-Claude-Profile: cp_run");
  });

  test("run env defaults to token-free when no carrier argument is supplied", () => {
    const env = buildClaudeProfileRunEnv({ id: "cp_run", name: "Run", claudeHome: "/tmp/.claude-run" }, 10100);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:10100");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("run env sentinel rollback restores the exact per-process local gateway token", () => {
    const env = buildClaudeProfileRunEnv({ id: "cp_run", name: "Run", claudeHome: "/tmp/.claude-run" }, 10100, "sentinel", { ANTHROPIC_CUSTOM_HEADERS: "X-User: keep" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/.claude-run");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:10100");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("local-frogprogsy");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-User: keep\nX-Frogp-Claude-Profile: cp_run");
  });

  test("token-free run env strips a stale frogp sentinel but preserves a real user token", () => {
    const stripped = buildClaudeProfileRunEnv({ id: "cp_run", name: "Run", claudeHome: "/tmp/.claude-run" }, 10100, "token-free", { ANTHROPIC_AUTH_TOKEN: "local-frogprogsy" });
    expect(stripped.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const preserved = buildClaudeProfileRunEnv({ id: "cp_run", name: "Run", claudeHome: "/tmp/.claude-run" }, 10100, "token-free", { ANTHROPIC_AUTH_TOKEN: "sk-user-real" });
    expect(preserved.ANTHROPIC_AUTH_TOKEN).toBe("sk-user-real");
  });

  test("native env keeps the selected Claude home without frogp gateway routing", () => {
    const env = buildClaudeProfileNativeEnv(
      { id: "cp_native", name: "Native", claudeHome: "/tmp/.claude-native" },
      {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-User: keep\nX-Frogp-Claude-Profile: cp_old",
      },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/.claude-native");
    expect(env.CLAUDE_HOME).toBe("/tmp/.claude-native");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-User: keep");
  });
});
