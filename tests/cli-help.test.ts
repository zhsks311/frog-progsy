import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");



describe("CLI subcommand help", () => {
  test("restore --help prints usage without mutating Claude Code config", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-help-"));
    try {
      const configPath = join(claudeHome, "config.toml");
      const before = [
        'model_provider = "frogprogsy"',
        "",
        "[model_providers.frogprogsy]",
        'base_url = "http://localhost:10100/v1"',
        'wire_api = "messages"',
        "",
      ].join("\n");
      writeFileSync(configPath, before, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "restore", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CLAUDE_HOME: claudeHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: frogp restore");
      expect(result.stdout).toContain("every enrolled project");
      expect(result.stdout).toContain("retains enrollment intent");
      expect(result.stdout).toContain("next start/refresh reapplies enrolled projects");
      expect(result.stdout).not.toContain("Plain `claude` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
    }
  }, 15000);
  test("stop --help documents enrolled-project routing suspension", () => {
    const result = spawnSync(process.execPath, [cliPath, "stop", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp stop");
    expect(result.stdout).toContain("every enrolled project");
    expect(result.stdout).toContain("retains enrollment intent");
    expect(result.stdout).toContain("next start/refresh reapplies enrolled projects");
  }, 15000);


  test("uninstall --help prints usage without uninstalling", () => {
    const result = spawnSync(process.execPath, [cliPath, "uninstall", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp uninstall");
    expect(result.stdout).toContain("every enrolled project");
    expect(result.stdout).not.toContain("frogprogsy uninstalled");
    expect(result.stderr).not.toContain("Unknown command");
  }, 15000);

  test("frogp --version prints the installed package version", () => {
    const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;
    const result = spawnSync(process.execPath, [cliPath, "--version"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`frogprogsy v${pkgVersion}`);
  }, 15000);

  test("frogp help <command> prints that command's usage", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "login"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp login");
  });

  test("frogp help with an unknown topic fails and suggests the closest command", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "statu"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown help topic: statu");
    expect(result.stderr).toContain("Did you mean: frogp help status?");
  });

  test("unknown command fails and suggests the closest command", () => {
    const result = spawnSync(process.execPath, [cliPath, "refrsh"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: refrsh");
    expect(result.stderr).toContain("Did you mean: frogp refresh?");
  });

  test("help topics cover status --json, models, and login --list", () => {
    const statusHelp = spawnSync(process.execPath, [cliPath, "help", "status"], { cwd: repoRoot, encoding: "utf8" });
    expect(statusHelp.status).toBe(0);
    expect(statusHelp.stdout).toContain("--json");

    const modelsHelp = spawnSync(process.execPath, [cliPath, "help", "models"], { cwd: repoRoot, encoding: "utf8" });
    expect(modelsHelp.status).toBe(0);
    expect(modelsHelp.stdout).toContain("RUNNING proxy");
    expect(modelsHelp.stdout).toContain("--json");
    expect(modelsHelp.stdout).toContain("frogp start");

    const loginHelp = spawnSync(process.execPath, [cliPath, "help", "login"], { cwd: repoRoot, encoding: "utf8" });
    expect(loginHelp.status).toBe(0);
    expect(loginHelp.stdout).toContain("--list");
  }, 15000);

  test("claude help recommends project enrollment without account-selection claims", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "claude"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogp claude project enroll [path]");
    expect(result.stdout).toContain("<project>/.claude/settings.local.json");
    expect(result.stdout).toContain("not chosen by project enrollment");
    expect(result.stdout).not.toContain("selects the Claude account");
  }, 15000);
  test("login anthropic returns pass-through guidance instead of starting OAuth", () => {
    const result = spawnSync(process.execPath, [cliPath, "login", "anthropic"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Claude subscription OAuth login is not supported");
    expect(result.stderr).toContain("frogp claude");
  });

  test("claude home CLI add and rename keep a stable id", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-claude-cli-"));
    const defaultClaudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-default-"));
    const workClaudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-work-"));
    const env = { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: defaultClaudeHome, CLAUDE_CONFIG_DIR: defaultClaudeHome };
    try {
      const added = spawnSync(process.execPath, [cliPath, "claude", "add", "컬리 업무용", "--home", workClaudeHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(added.status).toBe(0);
      expect(added.stdout).toContain("Claude Code home added");

      const configPath = join(frogHome, "config.json");
      const afterAdd = JSON.parse(readFileSync(configPath, "utf8"));
      const workProfile = afterAdd.claudeProfiles.profiles.find((profile: any) => profile.name === "컬리 업무용");
      expect(workProfile.id).toMatch(/^cp_[a-z0-9]+$/);
      expect(workProfile.claudeHome).toBe(workClaudeHome);

      const renamed = spawnSync(process.execPath, [cliPath, "claude", "rename", workProfile.id, "개인 Max"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(renamed.status).toBe(0);
      const afterRename = JSON.parse(readFileSync(configPath, "utf8"));
      const renamedProfile = afterRename.claudeProfiles.profiles.find((profile: any) => profile.name === "개인 Max");
      expect(renamedProfile.id).toBe(workProfile.id);
      expect(renamedProfile.claudeHome).toBe(workClaudeHome);
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(defaultClaudeHome, { recursive: true, force: true });
      rmSync(workClaudeHome, { recursive: true, force: true });
    }
  });

  test("claude remove validates the only home before project cleanup", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-remove-only-"));
    const defaultClaudeHome = mkdtempSync(join(tmpdir(), "frogp-remove-only-claude-"));
    const project = mkdtempSync(join(tmpdir(), "frogp-remove-only-project-"));
    const env = { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: defaultClaudeHome, CLAUDE_CONFIG_DIR: defaultClaudeHome };
    try {
      mkdirSync(join(project, ".claude"), { recursive: true });
      writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_default" },
      }, null, 2));
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: 10100,
        defaultProvider: "codex",
        providers: {
          codex: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "gpt-5.5", models: ["gpt-5.5"], liveModels: false },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [{ id: "cp_default", name: "Default", claudeHome: defaultClaudeHome, authState: "not_seen" }],
        },
        claudeProjects: {
          schemaVersion: 1,
          projects: [{ id: "cpr_default", name: "project", projectPath: project, routingProfileId: "cp_default", enrolled: true }],
        },
      }, null, 2) + "\n");

      const result = spawnSync(process.execPath, [cliPath, "claude", "remove", "cp_default"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cannot remove the only Claude Code home");
      const configAfter = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8"));
      expect(configAfter.claudeProjects.projects[0].routingProfileId).toBe("cp_default");
      const settingsAfter = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"));
      expect(settingsAfter.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Frogp-Claude-Profile: cp_default");
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(defaultClaudeHome, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 15000);
  test("claude reload-models prepares a selected home without starting the proxy", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-reload-cli-"));
    const defaultClaudeHome = mkdtempSync(join(tmpdir(), "frogp-reload-default-"));
    const workClaudeHome = mkdtempSync(join(tmpdir(), "frogp-reload-work-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
    };
    delete env.FROGPROGSY_NO_CLAUDE_WRITES;

    try {
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: 9,
        defaultProvider: "codex",
        providers: {
          codex: {
            adapter: "openai-chat",
            baseUrl: "https://models.test/v1",
            apiKey: "sk-test",
            defaultModel: "gpt-5.5",
            models: ["gpt-5.5"],
            liveModels: false,
          },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [
            { id: "cp_default", name: "Default", claudeHome: defaultClaudeHome, authState: "not_seen" },
            { id: "cp_work", name: "Work Home", claudeHome: workClaudeHome, authState: "not_seen" },
          ],
        },
      }, null, 2) + "\n");

      const result = spawnSync(process.execPath, [cliPath, "claude", "reload-models", "cp_work"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Model reload prepared for Work Home (cp_work)");
      expect(result.stdout).toContain("Gateway cache: written (1 models)");
      expect(result.stdout).toContain("Catalog cache: not synced");
      expect(result.stdout).toContain("Proxy is not answering on port 9; run frogp refresh");
      expect(result.stdout).toContain("Start a new Claude Code session or resume so it refetches /v1/models");
      expect(result.stdout).toContain("frogp claude project enroll [path]");
      expect(result.stdout).not.toContain("frogp start");

      const namedResult = spawnSync(process.execPath, [cliPath, "claude", "reload-models", "Work Home"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(namedResult.status).toBe(0);
      expect(namedResult.stdout).toContain("Model reload prepared for Work Home (cp_work)");

      const gatewayCache = JSON.parse(readFileSync(join(workClaudeHome, "cache", "gateway-models.json"), "utf8"));
      expect(gatewayCache.models.map((model: any) => model.display_name)).toEqual(["codex/gpt-5.5"]);

      const settings = JSON.parse(readFileSync(join(workClaudeHome, "settings.json"), "utf8"));
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:9");
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Frogp-Claude-Profile: cp_work");

      const globalAuthResult = spawnSync(process.execPath, [cliPath, "claude", "reload-models", "cp_work", "--global-discovery-auth"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(globalAuthResult.status).toBe(0);
      expect(globalAuthResult.stdout).toContain("Local gateway auth token injected into settings");
      const globalAuthSettings = JSON.parse(readFileSync(join(workClaudeHome, "settings.json"), "utf8"));
      expect(globalAuthSettings.env.ANTHROPIC_AUTH_TOKEN).toBe("local-frogprogsy");
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(defaultClaudeHome, { recursive: true, force: true });
      rmSync(workClaudeHome, { recursive: true, force: true });
    }
  });

  test("claude project CLI enrolls local settings and reports account/home boundary", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-project-cli-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "frogp-project-cli-"));
    const env = { ...process.env, FROGPROGSY_HOME: frogHome };
    try {
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: 10100,
        defaultProvider: "test",
        providers: {
          test: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "alpha", models: ["alpha"], liveModels: false },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [{ id: "cp_default", name: "Default", claudeHome: join(frogHome, ".claude"), authState: "not_seen" }],
        },
      }, null, 2) + "\n");

      const enrolled = spawnSync(process.execPath, [cliPath, "claude", "project", "enroll", projectRoot], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(enrolled.status).toBe(0);
      expect(enrolled.stdout).toContain("Claude project enrolled");
      expect(enrolled.stdout).toContain("project local settings");
      expect(enrolled.stdout).toContain("Claude account/home selection remains Claude Code controlled");

      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:10100");
      expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

      const status = spawnSync(process.execPath, [cliPath, "claude", "project", "status", projectRoot], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("carrier: token-free");
      expect(status.stdout).toContain("token scope: not set");
      expect(status.stdout).toContain("does not choose the Claude account or Claude Code home");
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 15000);


  test("top-level help advertises current Claude Code and login surfaces", () => {
    const result = spawnSync(process.execPath, [cliPath, "help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogprogsy (frogp)");
    expect(result.stdout).toContain("frogp login [--list|<provider>]");
    expect(result.stdout).toContain("codex, openai, xai, kimi");
    expect(result.stdout).toContain("frogp login codex");
    expect(result.stdout).not.toContain("frogp service <sub>");
    expect(result.stdout).not.toContain("frogp claude-shim <sub>");
    expect(result.stdout).toContain("frogp gui");
    expect(result.stdout).toContain("Start on default port (3764)");
    expect(result.stdout).toContain("frogp uninstall");
    expect(result.stdout).not.toContain("OAuth login (xai) —");
    // refresh present; removed commands absent
    expect(result.stdout).toContain("frogp refresh");
    expect(result.stdout).toContain("frogp claude reload-models");
    expect(result.stdout).not.toContain("frogp ensure");
    expect(result.stdout).not.toContain("frogp sync-cache");
    expect(result.stdout).not.toContain("frogp recover-history");
    expect(result.stdout).toContain("--no-restart");
    // round-2 surfaces present
    expect(result.stdout).toContain("frogp status [--json]");
    expect(result.stdout).toContain("frogp models [--json]");
    expect(result.stdout).toContain("frogp claude project enroll");
    // Branch-B isolated Claude subscription grant surfaces
    expect(result.stdout).toContain("frogp providers set <name> --auth claude-grant --grant <id>");
    expect(result.stdout).toContain("frogp claude grants add");
  });

  test("claude help documents grants lifecycle, probe-b consent, and real-executable requirement", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "claude"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogp claude grants add <label>");
    expect(result.stdout).toContain("frogp claude grants remove <id> [--force]");
    expect(result.stdout).toContain("frogp claude auth probe-b --grant <id> [--live --yes] [--json]");
    expect(result.stdout).toContain("real claude executable");
    expect(result.stdout).toContain("never touch your native ~/.claude home or the global Keychain");
  });

  test("providers help topic documents the claude-grant binding and OAuth safety", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "providers"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp providers set <name> --auth claude-grant --grant <id>");
    expect(result.stdout).toContain("Unknown provider or grant is a hard error");
    expect(result.stdout).toContain("never touches OAuth or API-key logins");
  });
});
