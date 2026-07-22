import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { restoreManagedClaudeRouting, reapplyEnrolledClaudeProjects } from "../src/claude-routing-lifecycle";
import { injectClaudeCodeSettings, injectClaudeProjectSettings } from "../src/claude-settings";
import type { FrogConfig } from "../src/types";

interface Fixture {
  root: string;
  frogHome: string;
  claudeHome: string;
  project: string;
  config: FrogConfig;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "frogp-routing-lifecycle-"));
  const frogHome = join(root, "frog");
  const claudeHome = join(root, "claude");
  const project = join(root, "project");
  mkdirSync(frogHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });

  const previous = {
    FROGPROGSY_HOME: process.env.FROGPROGSY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.FROGPROGSY_HOME = frogHome;
  process.env.CLAUDE_HOME = claudeHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;

  const config: FrogConfig = {
    port: 10100,
    defaultProvider: "ready",
    providers: {
      ready: {
        adapter: "openai-chat",
        baseUrl: "https://models.test/v1",
        apiKey: "test-key",
        defaultModel: "ready-model",
        models: ["ready-model"],
        liveModels: false,
      },
    },
    claudeProfiles: {
      schemaVersion: 1,
      defaultProfileId: "cp_default",
      profiles: [{ id: "cp_default", name: "Default", claudeHome, injected: true }],
    },
    claudeProjects: {
      schemaVersion: 1,
      projects: [{ id: "cpr_project", name: "project", projectPath: project, routingProfileId: "cp_default", enrolled: true }],
    },
  };

  return {
    root,
    frogHome,
    claudeHome,
    project,
    config,
    cleanup: () => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

describe("Claude routing lifecycle", () => {
  test("global restore suspends enrolled project routing and start reapplication migrates stale sentinel to token-free", () => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.claudeHome, "settings.json"), JSON.stringify({ env: { HOME_SETTING: "keep-home" } }, null, 2));
      writeFileSync(join(fixture.project, ".claude", "settings.local.json"), JSON.stringify({ env: { PROJECT_SETTING: "keep-project" } }, null, 2));

      expect(injectClaudeCodeSettings(10100, {
        claudeHome: fixture.claudeHome,
        profileId: "cp_default",
        gatewayAuthCarrier: "sentinel",
      }).success).toBe(true);
      expect(injectClaudeProjectSettings(10100, {
        projectPath: fixture.project,
        routingProfileId: "cp_default",
        gatewayAuthCarrier: "sentinel",
      }).success).toBe(true);

      const restored = restoreManagedClaudeRouting(fixture.config);
      expect(restored.success).toBe(true);
      expect(restored.message).toContain("[project project]");

      const homeAfterRestore = readJson(join(fixture.claudeHome, "settings.json"));
      expect(homeAfterRestore.env).toEqual({ HOME_SETTING: "keep-home" });
      const projectAfterRestore = readJson(join(fixture.project, ".claude", "settings.local.json"));
      expect(projectAfterRestore.env).toEqual({ PROJECT_SETTING: "keep-project" });
      expect(fixture.config.claudeProfiles?.profiles[0]?.injected).toBe(false);
      expect(fixture.config.claudeProjects?.projects[0]?.enrolled).toBe(true);

      const reapplied = reapplyEnrolledClaudeProjects(fixture.config, 10222);
      expect(reapplied.success).toBe(true);
      const projectAfterReapply = readJson(join(fixture.project, ".claude", "settings.local.json"));
      expect(projectAfterReapply.env).toMatchObject({
        PROJECT_SETTING: "keep-project",
        ANTHROPIC_BASE_URL: "http://localhost:10222",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      });
      expect(projectAfterReapply.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(projectAfterReapply.env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Frogp-Claude-Profile");
      expect(fixture.config.claudeProjects?.projects[0]?.enrolled).toBe(true);

      expect(restoreManagedClaudeRouting(fixture.config).success).toBe(true);
      fixture.config.gatewayAuthCarrier = "sentinel";
      expect(reapplyEnrolledClaudeProjects(fixture.config, 10333).success).toBe(true);
      const sentinelProject = readJson(join(fixture.project, ".claude", "settings.local.json"));
      expect(sentinelProject.env.ANTHROPIC_AUTH_TOKEN).toBe("local-frogprogsy");
    } finally {
      fixture.cleanup();
    }
  });

  test("reapplication does not preserve orphaned frogprogsy values as user backup state", () => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.project, ".claude", "settings.local.json"), JSON.stringify({
        env: {
          PROJECT_SETTING: "keep-project",
          ANTHROPIC_BASE_URL: "http://localhost:9999",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
          ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        },
      }, null, 2));

      expect(reapplyEnrolledClaudeProjects(fixture.config, 10555).success).toBe(true);
      const applied = readJson(join(fixture.project, ".claude", "settings.local.json"));
      expect(applied.env.ANTHROPIC_BASE_URL).toBe("http://localhost:10555");
      expect(applied.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

      expect(restoreManagedClaudeRouting(fixture.config).success).toBe(true);
      const restored = readJson(join(fixture.project, ".claude", "settings.local.json"));
      expect(restored.env).toEqual({ PROJECT_SETTING: "keep-project" });
      expect(fixture.config.claudeProjects?.projects[0]?.enrolled).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
  test("project failures are aggregated without erasing durable enrollment intent or blocking other projects", () => {
    const fixture = makeFixture();
    try {
      const brokenProject = join(fixture.root, "not-a-directory");
      writeFileSync(brokenProject, "occupied");
      fixture.config.claudeProjects!.projects.push({
        id: "cpr_broken",
        name: "broken",
        projectPath: brokenProject,
        enrolled: true,
      });
      fixture.config.claudeProjects!.projects.push({
        id: "cpr_missing",
        name: "missing",
        projectPath: join(fixture.root, "missing-project"),
        enrolled: true,
      });

      const reapplied = reapplyEnrolledClaudeProjects(fixture.config, 10444);
      expect(reapplied.success).toBe(false);
      expect(reapplied.message).toContain("[project broken]");
      // Deterministic curated message: the lifecycle's own directory guard fires before any ENOTDIR throw.
      expect(reapplied.message).toContain("Project path is not a directory");
      expect(reapplied.message).toContain("enrollment retained but gateway settings not reapplied");
      expect(reapplied.message).toContain("[project missing]");
      expect(reapplied.message).toContain("Project path missing");
      expect(readJson(join(fixture.project, ".claude", "settings.local.json")).env.ANTHROPIC_BASE_URL).toBe("http://localhost:10444");
      expect(fixture.config.claudeProjects?.projects.every(project => project.enrolled === true)).toBe(true);

      const restored = restoreManagedClaudeRouting(fixture.config);
      expect(restored.success).toBe(false);
      expect(restored.message).toContain("[project broken]");
      expect(restored.message).toContain("[project missing]");
      expect(restored.message).toContain("routing cleanup could not be verified");
      expect(fixture.config.claudeProjects?.projects.every(project => project.enrolled === true)).toBe(true);
      const healthySettings = readJson(join(fixture.project, ".claude", "settings.local.json"));
      expect(healthySettings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });
});
