import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCodeEnv, injectClaudeCodeSettings, injectClaudeProjectSettings, mergeClaudeCodeSettings, mergeClaudeProjectSettings, readClaudeGatewayState, readClaudeProjectGatewayState, removeOrphanedFrogProgsySettings, restoreClaudeCodeSettings, restoreClaudeCodeSettingsFromBackup, restoreClaudeProjectSettings } from "../src/claude-settings";
import { ensureClaudeProjectSettingsExcluded, getClaudeProjectGitProtection } from "../src/claude-projects";

describe("Claude Code settings injection", () => {
  test("builds token-free native OAuth gateway discovery env by default", () => {
    expect(buildClaudeCodeEnv(10100)).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:10100",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });
  });

  test("edits only owned env keys, removes the settings-scoped local discovery token, and stores exact backup", () => {
    const original = {
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        UNRELATED: "keep",
      },
      permissions: { allow: ["Bash(ls)"] },
    };
    const previousBackup = {
      schemaVersion: 1 as const,
      settingsPath: "/tmp/settings.json",
      env: {
        ANTHROPIC_BASE_URL: { existed: true, value: "https://api.anthropic.com" },
        ANTHROPIC_AUTH_TOKEN: { existed: false },
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: { existed: false },
      },
    };

    const { settings, backup } = mergeClaudeCodeSettings(original, 10100, previousBackup);

    expect(settings).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        UNRELATED: "keep",
      },
      permissions: { allow: ["Bash(ls)"] },
    });
    expect(backup.env.ANTHROPIC_BASE_URL).toEqual({ existed: true, value: "https://api.anthropic.com" });
    expect(backup.env.ANTHROPIC_AUTH_TOKEN).toEqual({ existed: false });
    expect(backup.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toEqual({ existed: false });
  });

  test("can opt into the settings-scoped sentinel rollback carrier when explicitly requested", () => {
    expect(buildClaudeCodeEnv(10100, { includeAuthToken: true })).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:10100",
      ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });
  });

  test("treats an absent carrier as token-free and injects the sentinel only for an explicit sentinel carrier", () => {
    expect(buildClaudeCodeEnv(10100, { gatewayAuthCarrier: "token-free" })).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:10100",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });
    expect(buildClaudeCodeEnv(10100, { gatewayAuthCarrier: "sentinel" })).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:10100",
      ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });
    // Per-call includeAuthToken override wins even when the configured carrier is token-free.
    expect(buildClaudeCodeEnv(10100, { gatewayAuthCarrier: "token-free", includeAuthToken: true })).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
    });
  });

  test("restore returns exact prior values and removes keys that did not exist", () => {
    const { settings, backup } = mergeClaudeCodeSettings({ env: { ANTHROPIC_BASE_URL: "native", OTHER: "x" } }, 10100);
    const restored = restoreClaudeCodeSettingsFromBackup(settings, backup);

    expect(restored).toEqual({ env: { ANTHROPIC_BASE_URL: "native", OTHER: "x" } });
  });

  test("restore drops routed default model aliases but keeps native models", () => {
    const backup = {
      schemaVersion: 1 as const,
      settingsPath: "/tmp/settings.json",
      env: {
        ANTHROPIC_BASE_URL: { existed: false },
        ANTHROPIC_AUTH_TOKEN: { existed: false },
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: { existed: false },
      },
    };


    expect(restoreClaudeCodeSettingsFromBackup({
      model: "claude-frogp-codex-gpt-5-5",
    }, backup)).toEqual({});

    expect(restoreClaudeCodeSettingsFromBackup({
      model: "claude-sonnet-4-6",
    }, backup)).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("no-backup cleanup removes only orphaned routed settings", () => {
    expect(removeOrphanedFrogProgsySettings({
      model: "claude-frogp-codex-gpt-5-5",
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        UNRELATED: "keep",
      },
    })).toEqual({
      changed: true,
      settings: {
        env: { UNRELATED: "keep" },
      },
    });

    expect(removeOrphanedFrogProgsySettings({
      model: "claude-sonnet-4-6",
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      },
    })).toEqual({
      changed: false,
      settings: {
        model: "claude-sonnet-4-6",
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      },
    });

    expect(removeOrphanedFrogProgsySettings({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:9999",
        UNRELATED: "keep",
      },
    })).toEqual({
      changed: false,
      settings: {
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:9999",
          UNRELATED: "keep",
        },
      },
    });
  });

  test("repeated injection preserves the first backup", () => {
    const first = mergeClaudeCodeSettings({ env: { ANTHROPIC_BASE_URL: "native" } }, 10100);
    const second = mergeClaudeCodeSettings(first.settings, 20200, first.backup);

    expect(second.settings.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://localhost:20200" });
    expect(second.backup.env.ANTHROPIC_BASE_URL).toEqual({ existed: true, value: "native" });
  });

  test("repeated injection preserves current routed default model aliases", () => {
    const backup = {
      schemaVersion: 1 as const,
      settingsPath: "/tmp/settings.json",
      env: {
        ANTHROPIC_BASE_URL: { existed: false },
        ANTHROPIC_AUTH_TOKEN: { existed: false },
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: { existed: false },
        ANTHROPIC_CUSTOM_HEADERS: { existed: false },
      },
    };

    expect(mergeClaudeCodeSettings({
      model: "claude-frogp-codex-gpt-5-5",
      env: { UNRELATED: "keep" },
    }, 10100, backup).settings).toEqual({
      model: "claude-frogp-codex-gpt-5-5",
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        UNRELATED: "keep",
      },
    });

  });

  test("profile injection replaces orphaned routing headers without clobbering user headers", () => {
    const { settings, backup } = mergeClaudeCodeSettings({
      env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-User: keep\nX-Frogp-Claude-Profile: old",
      },
    }, 10100, null, { profileId: "cp_work" });

    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://localhost:10100",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ANTHROPIC_CUSTOM_HEADERS: "X-User: keep\nX-Frogp-Claude-Profile: cp_work",
    });
    expect(backup.env.ANTHROPIC_CUSTOM_HEADERS).toEqual({ existed: true, value: "X-User: keep" });
    expect(restoreClaudeCodeSettingsFromBackup(settings, backup)).toEqual({
      env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-User: keep",
      },
    });
  });

  test("file injection and restore target only the selected profile home", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frog-settings-profile-"));
    const workHome = mkdtempSync(join(tmpdir(), "frog-claude-work-"));
    const personalHome = mkdtempSync(join(tmpdir(), "frog-claude-personal-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    try {
      writeFileSync(join(workHome, "settings.json"), JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: "X-User: keep" } }, null, 2));
      writeFileSync(join(personalHome, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "native", UNRELATED: "personal" } }, null, 2));

      const injected = injectClaudeCodeSettings(10100, { claudeHome: workHome, profileId: "cp_work" });
      expect(injected.success).toBe(true);

      const workInjected = JSON.parse(readFileSync(join(workHome, "settings.json"), "utf8")) as Record<string, any>;
      const personalUnchanged = JSON.parse(readFileSync(join(personalHome, "settings.json"), "utf8")) as Record<string, any>;
      expect(workInjected.env).toMatchObject({
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-User: keep\nX-Frogp-Claude-Profile: cp_work",
      });
      expect(readClaudeGatewayState(10100, { claudeHome: workHome, profileId: "cp_work" })).toMatchObject({
        applied: true,
        baseUrlMatchesExpected: true,
        gatewayDiscovery: true,
        profileHeaderMatches: true,
        carrier: "token-free",
        modelDiscoveryReady: true,
      });
      expect(readClaudeGatewayState(10100, { claudeHome: workHome, profileId: "cp_other" }).applied).toBe(false);
      expect(readClaudeGatewayState(20200, { claudeHome: workHome, profileId: "cp_work" }).applied).toBe(false);
      expect(personalUnchanged.env).toEqual({ ANTHROPIC_BASE_URL: "native", UNRELATED: "personal" });

      const restored = restoreClaudeCodeSettings({ claudeHome: workHome, profileId: "cp_work" });
      expect(restored.success).toBe(true);
      const workRestored = JSON.parse(readFileSync(join(workHome, "settings.json"), "utf8")) as Record<string, any>;
      expect(workRestored.env).toEqual({ ANTHROPIC_CUSTOM_HEADERS: "X-User: keep" });
      expect(readClaudeGatewayState(10100, { claudeHome: workHome, profileId: "cp_work" }).applied).toBe(false);
      expect(JSON.parse(readFileSync(join(personalHome, "settings.json"), "utf8"))).toEqual(personalUnchanged);
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(workHome, { recursive: true, force: true });
      rmSync(personalHome, { recursive: true, force: true });
    }
  });
  test("project enrollment is token-free by default and injects the sentinel only under an explicit sentinel carrier", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frog-project-settings-"));
    const project = mkdtempSync(join(tmpdir(), "frog-project-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "frog-home-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    try {
      writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "native-home" } }, null, 2));
      const injected = injectClaudeProjectSettings(10100, { projectPath: project, routingProfileId: "cp_work" });
      expect(injected.success).toBe(true);

      const settingsPath = join(project, ".claude", "settings.local.json");
      const projectSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
      expect(projectSettings.env).toMatchObject({
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_work",
      });
      expect(projectSettings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(readClaudeProjectGatewayState(10100, { projectPath: project, routingProfileId: "cp_work" })).toMatchObject({
        applied: true,
        carrier: "token-free",
        authToken: "not_set",
        modelDiscoveryReady: true,
      });
      // home settings remain untouched by project enrollment
      expect(JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: "native-home" } });

      // explicit sentinel rollback re-injects the local discovery token
      const sentinel = injectClaudeProjectSettings(10100, { projectPath: project, routingProfileId: "cp_work", gatewayAuthCarrier: "sentinel" });
      expect(sentinel.success).toBe(true);
      const sentinelSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
      expect(sentinelSettings.env).toMatchObject({
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_work",
      });
      expect(readClaudeProjectGatewayState(10100, { projectPath: project, routingProfileId: "cp_work" })).toMatchObject({
        applied: true,
        carrier: "sentinel",
        authToken: "set_redacted",
        modelDiscoveryReady: true,
      });
      // home settings still untouched after the sentinel rollback
      expect(JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: "native-home" } });
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("project settings keep one pristine backup across routing profile switches and stay token-free by default", () => {
    const project = mkdtempSync(join(tmpdir(), "frog-project-backup-"));
    const first = mergeClaudeProjectSettings({
      env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-User: keep",
        UNRELATED: "keep",
      },
    }, 10100, null, { projectPath: project, routingProfileId: "cp_work" });
    const second = mergeClaudeProjectSettings(first.settings, 20200, first.backup, { projectPath: project, routingProfileId: "cp_personal" });

    expect(second.backup).toEqual(first.backup);
    expect(second.settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://localhost:20200",
      ANTHROPIC_CUSTOM_HEADERS: "X-User: keep\nX-Frogp-Claude-Profile: cp_personal",
    });
    expect((second.settings.env as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const third = mergeClaudeProjectSettings(second.settings, 30300, second.backup, { projectPath: project });
    expect(third.settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://localhost:30300",
      ANTHROPIC_CUSTOM_HEADERS: "X-User: keep",
    });
    expect((third.settings.env as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    // Explicit sentinel carrier re-introduces the local discovery token without disturbing the pristine backup.
    const sentinel = mergeClaudeProjectSettings(third.settings, 30300, second.backup, { projectPath: project, gatewayAuthCarrier: "sentinel" });
    expect(sentinel.backup).toEqual(first.backup);
    expect(sentinel.settings.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
    });

    const restored = restoreClaudeCodeSettingsFromBackup(second.settings, second.backup);
    expect(restored).toEqual({
      env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-User: keep",
        UNRELATED: "keep",
      },
    });
    rmSync(project, { recursive: true, force: true });
  });

  test("project gateway state rejects stale profile headers when no routing profile is configured", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frog-project-stale-header-"));
    const project = mkdtempSync(join(tmpdir(), "frog-project-stale-header-target-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    try {
      expect(injectClaudeProjectSettings(10100, { projectPath: project, routingProfileId: "cp_work" }).success).toBe(true);
      const settingsPath = join(project, ".claude", "settings.local.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Frogp-Claude-Profile: cp_work");
      expect(readClaudeProjectGatewayState(10100, { projectPath: project }).modelDiscoveryReady).toBe(false);
      expect(readClaudeProjectGatewayState(10100, { projectPath: project }).profileHeaderMatches).toBe(false);
      expect(injectClaudeProjectSettings(10100, { projectPath: project }).success).toBe(true);
      const cleared = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
      expect(cleared.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(readClaudeProjectGatewayState(10100, { projectPath: project }).modelDiscoveryReady).toBe(true);
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("project restore does not resurrect local token or stale profile header when baseline lacked them", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frog-project-restore-"));
    const project = mkdtempSync(join(tmpdir(), "frog-project-restore-target-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    try {
      writeFileSync(join(project, ".claude-settings-placeholder"), "");
      expect(injectClaudeProjectSettings(10100, { projectPath: project, routingProfileId: "cp_work" }).success).toBe(true);
      const settingsPath = join(project, ".claude", "settings.local.json");
      const switched = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
      switched.env.ANTHROPIC_CUSTOM_HEADERS = "X-Frogp-Claude-Profile: cp_other";
      writeFileSync(settingsPath, JSON.stringify(switched, null, 2));
      expect(restoreClaudeProjectSettings(project).success).toBe(true);
      const restored = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
      expect(restored.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(restored.env?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("project git protection appends only exact settings.local.json exclude entry once", () => {
    const project = mkdtempSync(join(tmpdir(), "frog-project-git-"));
    try {
      execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
      const first = ensureClaudeProjectSettingsExcluded(project);
      const second = ensureClaudeProjectSettingsExcluded(project);
      expect(first.status).toBe("excluded");
      expect(second.status).toBe("excluded");
      const exclude = readFileSync(join(project, ".git", "info", "exclude"), "utf8");
      expect(exclude.split(/\r?\n/).filter(line => line === ".claude/settings.local.json")).toHaveLength(1);
      expect(exclude.includes(".claude/\n")).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("project git protection uses repo-relative exclude entries for nested projects", () => {
    const repo = mkdtempSync(join(tmpdir(), "frog-project-git-nested-"));
    const project = join(repo, "packages", "app");
    try {
      mkdirSync(project, { recursive: true });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      const first = ensureClaudeProjectSettingsExcluded(project);
      const second = getClaudeProjectGitProtection(project);
      expect(first.status).toBe("excluded");
      expect(second.status).toBe("excluded");
      const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
      expect(exclude.split(/\r?\n/).filter(line => line === "packages/app/.claude/settings.local.json")).toHaveLength(1);
      expect(exclude.split(/\r?\n/).filter(line => line === ".claude/settings.local.json")).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("project git protection blocks tracked settings in nested projects before excludes", () => {
    const repo = mkdtempSync(join(tmpdir(), "frog-project-git-nested-tracked-"));
    const project = join(repo, "packages", "app");
    try {
      mkdirSync(join(project, ".claude"), { recursive: true });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ env: { USER: "tracked" } }, null, 2));
      execFileSync("git", ["add", "-f", "packages/app/.claude/settings.local.json"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, ".git", "info", "exclude"), "packages/app/.claude/settings.local.json\n");
      expect(getClaudeProjectGitProtection(project).status).toBe("tracked");
      expect(() => ensureClaudeProjectSettingsExcluded(project)).toThrow(/tracked/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("project git protection detects ignored settings in nested projects", () => {
    const repo = mkdtempSync(join(tmpdir(), "frog-project-git-nested-ignored-"));
    const project = join(repo, "packages", "app");
    try {
      mkdirSync(join(project, ".claude"), { recursive: true });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, ".gitignore"), "packages/app/.claude/settings.local.json\n");
      writeFileSync(join(project, ".claude", "settings.local.json"), "{}\n");
      expect(getClaudeProjectGitProtection(project).status).toBe("ignored");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("project git protection blocks tracked settings before writing", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frog-project-tracked-home-"));
    const project = mkdtempSync(join(tmpdir(), "frog-project-tracked-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    try {
      execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
      mkdirSync(join(project, ".claude"), { recursive: true });
      writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ env: { USER: "tracked" } }, null, 2));
      execFileSync("git", ["add", "-f", ".claude/settings.local.json"], { cwd: project, stdio: "ignore" });

      expect(getClaudeProjectGitProtection(project).status).toBe("tracked");
      expect(() => ensureClaudeProjectSettingsExcluded(project)).toThrow(/tracked/);
      expect(injectClaudeProjectSettings(10100, { projectPath: project, routingProfileId: "cp_work" }).success).toBe(false);
      expect(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"))).toEqual({ env: { USER: "tracked" } });
      expect(existsSync(join(frogHome, "claude-projects"))).toBe(false);
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("project git protection allows non-git projects with a warning", () => {
    const project = mkdtempSync(join(tmpdir(), "frog-project-not-git-"));
    try {
      const protection = getClaudeProjectGitProtection(project);
      expect(protection.status).toBe("not_git");
      expect(protection.warning).toContain("not inside a git work tree");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
  test("orphan cleanup removes both carrier variants but preserves an unrelated user auth token", () => {
    // token-free orphan: frog base url + discovery + profile header, no sentinel token
    expect(removeOrphanedFrogProgsySettings({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_work",
        UNRELATED: "keep",
      },
    })).toEqual({
      changed: true,
      settings: { env: { UNRELATED: "keep" } },
    });

    // sentinel orphan: frog base url + discovery + the exact local sentinel token
    expect(removeOrphanedFrogProgsySettings({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        UNRELATED: "keep",
      },
    })).toEqual({
      changed: true,
      settings: { env: { UNRELATED: "keep" } },
    });

    // a user's own auth token must survive cleanup even alongside every frog marker
    expect(removeOrphanedFrogProgsySettings({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "sk-ant-user-real",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_work",
        UNRELATED: "keep",
      },
    })).toEqual({
      changed: true,
      settings: { env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-user-real", UNRELATED: "keep" } },
    });
  });

  test("static guard: the local discovery sentinel token is injected only inside an explicit sentinel branch", () => {
    const source = readFileSync(new URL("../src/claude-settings.ts", import.meta.url), "utf8");
    const injectionLines = source.split(/\r?\n/).filter(line => /ANTHROPIC_AUTH_TOKEN\s*:\s*LOCAL_CLAUDE_AUTH_TOKEN/.test(line));
    // Exactly one place may inject the sentinel token, and it must be guarded by the includeAuthToken ternary.
    expect(injectionLines).toHaveLength(1);
    expect(injectionLines[0]).toMatch(/includeAuthToken\s*\?/);
    // The removed project-enrollment hardcode must never reappear as an unconditional injection.
    expect(source).not.toContain("includeAuthToken: true");
  });
});
