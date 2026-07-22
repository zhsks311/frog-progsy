import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");
const ANSI_PATTERN = /\x1b\[[0-9;]*m/;


function makeHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FROGPROGSY_HOME: home, ...extra };
  // Ensure a clean slate for the real-executable seam unless a test opts in.
  if (!("FROGP_REAL_CLAUDE" in extra)) delete env.FROGP_REAL_CLAUDE;
  return env;
}

function run(argv: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

const IS_WINDOWS = process.platform === "win32";

/** Platform-native filename for a grant executable fixture. Windows needs a PATHEXT-like suffix. */
function grantExecutableName(base: string): string {
  return IS_WINDOWS ? `${base}.cmd` : base;
}

/**
 * Default body for a "real" (non-managed) Claude executable fixture. Windows requires genuinely valid
 * batch content behind the `.cmd` suffix so the executable-suffix + X_OK gates accept it; POSIX keeps
 * a shell script whose exec bit is set via chmod below.
 */
const REAL_EXECUTABLE_CONTENT = IS_WINDOWS ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";

function writeExecutable(path: string, content = REAL_EXECUTABLE_CONTENT): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function readConfig(home: string): any {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

/** Create a grant through the real CLI flow and return its persisted record. */
function addGrantViaCli(home: string, label: string): { id: string; configDir: string } {
  const realExe = writeExecutable(join(home, "realbin", grantExecutableName("claude")));
  const result = run(["claude", "grants", "add", label], baseEnv(home, { FROGP_REAL_CLAUDE: realExe }));
  if (result.status !== 0) {
    throw new Error(`frogp claude grants add ${JSON.stringify(label)} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  expect(result.status).toBe(0);
  const config = readConfig(home);
  const grant = config.claudeGrants.grants.find((g: any) => g.label === label);
  expect(grant).toBeTruthy();
  return { id: grant.id, configDir: grant.configDir };
}

function bindOfficialGrantProvider(home: string, grantId: string): void {
  const config = readConfig(home);
  config.providers.anthropic = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "claude-grant",
    claudeGrantId: grantId,
    defaultModel: "claude-sonnet-4-6",
  };
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

describe("frogp claude grants add — real-executable enforcement", () => {
  test("prints a manual login using the verified absolute real claude and an isolated CLAUDE_CONFIG_DIR", () => {
    const home = makeHome("frogp-grant-add-");
    try {
      const realExe = realpathSync.native(writeExecutable(join(home, "realbin", grantExecutableName("claude"))));
      const result = run(["claude", "grants", "add", "Work Max"], baseEnv(home, { FROGP_REAL_CLAUDE: realExe }));
      if (result.status !== 0) {
        throw new Error(`frogp claude grants add exited ${result.status}: ${result.stderr || result.stdout}`);
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Claude grant created: Work Max");
      expect(result.stdout).toContain("CLAUDE_CONFIG_DIR=");
      expect(result.stdout).toContain("claude-grants");
      expect(result.stdout).toContain(realExe);
      expect(result.stdout).toContain("will not run it and will not open a browser");
      // Never a bare `claude` login line.
      expect(result.stdout).not.toMatch(/\n\s*claude auth login/);

      const config = readConfig(home);
      expect(config.claudeGrants.grants).toHaveLength(1);
      expect(config.claudeGrants.grants[0].label).toBe("Work Max");
      expect(config.claudeGrants.grants[0].id).toMatch(/^cg_[a-z0-9]+$/);
      expect(existsSync(config.claudeGrants.grants[0].configDir)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("refuses a managed frogprogsy launcher and does not create a grant", () => {
    const home = makeHome("frogp-grant-managed-");
    try {
      const managed = writeExecutable(
        join(home, "realbin", grantExecutableName("claude")),
        IS_WINDOWS
          ? "@echo off\r\nrem Generated by frogprogsy. Do not edit.\r\nexit /b 0\r\n"
          : "#!/bin/sh\n# Generated by frogprogsy. Do not edit.\nexit 0\n",
      );
      const result = run(["claude", "grants", "add", "Bad"], baseEnv(home, { FROGP_REAL_CLAUDE: managed }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("managed frogprogsy launcher");

      const list = run(["claude", "grants", "list"], baseEnv(home));
      expect(list.status).toBe(0);
      expect(list.stdout).toContain("No Claude grants");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("refuses a bare/missing real claude and does not create a grant", () => {
    const home = makeHome("frogp-grant-bare-");
    const emptyPath = join(home, "empty-path");
    mkdirSync(emptyPath, { recursive: true });
    try {
      const result = run(["claude", "grants", "add", "Bare"], baseEnv(home, { PATH: emptyPath }));
      expect(result.status).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain("real");

      const list = run(["claude", "grants", "list"], baseEnv(home, { PATH: emptyPath }));
      expect(list.stdout).toContain("No Claude grants");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("frogp providers set --auth claude-grant", () => {
  function seedProvidersConfig(home: string): void {
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward" },
      },
    }, null, 2) + "\n");
  }

  test("binds an existing provider to a verified grant without touching the OAuth store", () => {
    const home = makeHome("frogp-providers-set-");
    try {
      seedProvidersConfig(home);
      const grant = addGrantViaCli(home, "Work");
      const result = run(["providers", "set", "anthropic", "--auth", "claude-grant", "--grant", grant.id], baseEnv(home));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`bound to Claude grant Work (${grant.id})`);

      const config = readConfig(home);
      expect(config.providers.anthropic.authMode).toBe("claude-grant");
      expect(config.providers.anthropic.claudeGrantId).toBe(grant.id);
      // OAuth store must never be created/touched by binding.
      expect(existsSync(join(home, "auth.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("unknown provider is a hard error", () => {
    const home = makeHome("frogp-providers-unknown-prov-");
    try {
      seedProvidersConfig(home);
      const grant = addGrantViaCli(home, "Work");
      const result = run(["providers", "set", "ghost", "--auth", "claude-grant", "--grant", grant.id], baseEnv(home));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unknown provider: ghost");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("unknown grant is a hard error", () => {
    const home = makeHome("frogp-providers-unknown-grant-");
    try {
      seedProvidersConfig(home);
      const result = run(["providers", "set", "anthropic", "--auth", "claude-grant", "--grant", "cg_missing99"], baseEnv(home));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("claude grant not found");
      const config = readConfig(home);
      expect(config.providers.anthropic.authMode).toBe("forward");
      expect(config.providers.anthropic.claudeGrantId).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("frogp claude grants remove", () => {
  test("refuses while a provider is bound, then --force removes and leaves the binding dangling", () => {
    const home = makeHome("frogp-grant-remove-");
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({
        port: 10100,
        defaultProvider: "anthropic",
        providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward" } },
      }, null, 2) + "\n");
      const grant = addGrantViaCli(home, "Bound");
      run(["providers", "set", "anthropic", "--auth", "claude-grant", "--grant", grant.id], baseEnv(home));

      const refused = run(["claude", "grants", "remove", grant.id], baseEnv(home));
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("still bound to provider(s): anthropic");
      expect(readConfig(home).claudeGrants.grants).toHaveLength(1);

      const forced = run(["claude", "grants", "remove", grant.id, "--force"], baseEnv(home));
      expect(forced.status).toBe(0);
      expect(forced.stdout).toContain("Claude grant removed");
      expect(forced.stdout).toContain("dangling");

      const config = readConfig(home);
      expect(config.claudeGrants.grants).toHaveLength(0);
      expect(existsSync(grant.configDir)).toBe(false);
      // No auto-rebind: the provider still references the now-missing grant.
      expect(config.providers.anthropic.authMode).toBe("claude-grant");
      expect(config.providers.anthropic.claudeGrantId).toBe(grant.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("frogp claude grants status", () => {
  test("reports none and dangling from the real scoped-origin inspector without a fixture backdoor", () => {
    const home = makeHome("frogp-grant-status-");
    try {
      const grant = addGrantViaCli(home, "Status");

      const none = run(["claude", "grants", "status", grant.id], baseEnv(home));
      expect(none.status).toBe(0);
      expect(none.stdout).toContain(`${grant.id}  Status: none`);
      expect(none.stdout).not.toContain("accessToken");
      expect(none.stdout).not.toContain("refreshToken");

      rmSync(grant.configDir, { recursive: true, force: true });
      const dangling = run(["claude", "grants", "status", grant.id], baseEnv(home));
      expect(dangling.status).toBe(0);
      expect(dangling.stdout).toContain(": dangling");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("frogp claude auth probe-b", () => {
  test("local probe reports only lifecycle metadata and never reads or fingerprints credential bytes", () => {
    const home = makeHome("frogp-probe-local-");
    try {
      const grant = addGrantViaCli(home, "Probe");

      const human = run(["claude", "auth", "probe-b", "--grant", grant.id], baseEnv(home));
      expect(human.status).toBe(0);
      expect(human.stdout).toContain("probe-b [local]: none");
      expect(human.stdout).toContain("no credential bytes were read");
      expect(human.stdout).not.toContain("sha256=");
      expect(human.stdout).not.toContain(grant.configDir);

      const json = run(["claude", "auth", "probe-b", "--grant", grant.id, "--json"], baseEnv(home));
      expect(json.status).toBe(0);
      expect(json.stdout).not.toMatch(ANSI_PATTERN);
      const parsed = JSON.parse(json.stdout);
      expect(parsed).toEqual({ grant: grant.id, mode: "local", status: "none" });
      expect(json.stdout).not.toContain("accessToken");
      expect(json.stdout).not.toContain("refreshToken");
      expect(json.stdout).not.toContain("token");
      expect(json.stdout).not.toContain("service");
      expect(json.stdout).not.toContain(grant.configDir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("--live without --yes refuses, warns about ToS/quota, and performs no action", () => {
    const home = makeHome("frogp-probe-consent-");
    try {
      const grant = addGrantViaCli(home, "Consent");
      const result = run(["claude", "auth", "probe-b", "--grant", grant.id, "--live"], baseEnv(home));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Refusing --live probe-b without explicit --yes consent");
      expect(result.stderr).toContain("Terms of Service");
      expect(result.stderr.toLowerCase()).toContain("quota");
      expect(result.stderr).toContain("never opens a browser");
      expect(result.stdout).not.toContain("Authorization");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("--live --yes with one official bound provider fails closed before network when no scoped credential exists", () => {
    const home = makeHome("frogp-probe-live-");
    try {
      const grant = addGrantViaCli(home, "Live");
      bindOfficialGrantProvider(home, grant.id);

      const human = run(["claude", "auth", "probe-b", "--grant", grant.id, "--live", "--yes"], baseEnv(home));
      expect(human.status).toBe(3);
      expect(human.stderr).toContain("FAIL (token_unavailable)");
      expect(human.stderr).toContain("failed closed");
      expect(human.stdout).not.toContain("PASS");
      expect(human.stdout).not.toContain("Authorization");

      const json = run(["claude", "auth", "probe-b", "--grant", grant.id, "--live", "--yes", "--json"], baseEnv(home));
      expect(json.status).toBe(3);
      const parsed = JSON.parse(json.stdout);
      expect(parsed).toEqual({
        grant: grant.id,
        provider: "anthropic",
        mode: "live",
        status: "fail",
        code: "token_unavailable",
      });
      expect(json.stdout).not.toContain("accessToken");
      expect(json.stdout).not.toContain("refreshToken");
      expect(json.stdout).not.toContain("Authorization");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  test("unknown grant is a hard error", () => {
    const home = makeHome("frogp-probe-unknown-");
    try {
      const result = run(["claude", "auth", "probe-b", "--grant", "cg_missing99"], baseEnv(home));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("claude grant not found");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("frogp help surfaces the grant lifecycle", () => {
  test("claude help lists grants and probe-b with consent + real-executable guidance", () => {
    const result = run(["help", "claude"], { ...process.env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogp claude grants add <label>");
    expect(result.stdout).toContain("frogp claude grants status");
    expect(result.stdout).toContain("frogp claude auth probe-b --grant <id> [--live --yes] [--json]");
    expect(result.stdout).toContain("real claude executable");
  });

  test("providers help documents the claude-grant binding without OAuth side effects", () => {
    const result = run(["help", "providers"], { ...process.env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogp providers set <name> --auth claude-grant --grant <id>");
    expect(result.stdout).toContain("never touches OAuth or API-key logins");
  });
});
