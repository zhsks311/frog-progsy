import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

function runCli(argv: string[], frogHome: string) {
  const claudeHome = join(frogHome, "claude");
  mkdirSync(claudeHome, { recursive: true });
  return spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome },
    encoding: "utf8",
  });
}

describe("CLI logout validation", () => {
  test("logout without a provider fails with usage and stored logins", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-logout-"));
    try {
      const result = runCli(["logout"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: frogp logout <provider>");
      expect(result.stderr).toContain("Stored logins: (none)");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("logout for a provider that is not logged in fails loudly", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-logout-"));
    try {
      writeFileSync(
        join(home, "auth.json"),
        JSON.stringify({ codex: { access: "a", refresh: "r", expires: 9999999999999 } }),
        "utf8",
      );
      const result = runCli(["logout", "anthropic"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Not logged in to anthropic.");
      expect(result.stderr).toContain("Stored logins: codex");
      // The stored codex login must be untouched.
      const store = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
      expect(Object.keys(store)).toEqual(["codex"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("logout removes only the requested stored credential", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-logout-"));
    try {
      writeFileSync(
        join(home, "auth.json"),
        JSON.stringify({
          codex: { access: "a", refresh: "r", expires: 9999999999999 },
          anthropic: { access: "b", refresh: "s", expires: 9999999999999 },
        }),
        "utf8",
      );
      const result = runCli(["logout", "anthropic"], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Logged out of anthropic.");
      const store = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
      expect(Object.keys(store)).toEqual(["codex"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI status output", () => {
  test("status without a running proxy points at frogp start", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-status-"));
    try {
      expect(existsSync(join(home, "frogp.pid"))).toBe(false);
      const result = runCli(["status"], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Proxy not running. Start it with: frogp start");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  const ANSI_PATTERN = /\x1b\[[0-9;]*m/;

  function runCliWithEnv(argv: string[], frogHome: string, extraEnv: Record<string, string>) {
    const claudeHome = join(frogHome, "claude");
    mkdirSync(claudeHome, { recursive: true });
    return spawnSync(process.execPath, [cliPath, ...argv], {
      cwd: repoRoot,
      env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome, ...extraEnv },
      encoding: "utf8",
    });
  }

  test("status --json stopped case prints stable JSON to stdout only", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-status-"));
    try {
      const result = runCliWithEnv(["status", "--json"], home, { FORCE_COLOR: "1" });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(ANSI_PATTERN);
      const snapshot = JSON.parse(result.stdout);
      expect(snapshot).toEqual({
        running: false,
        healthy: false,
        pid: null,
        port: null,
        dashboardUrl: null,
        recovery: "frogp start",
        watchdog: { present: false, attempts: null, gaveUpAt: null, unreadable: false },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("status --json normalizes a valid watchdog give-up file", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-status-"));
    try {
      writeFileSync(
        join(home, "frogp-watchdog-status.json"),
        JSON.stringify({ attempts: 3, gaveUpAt: "2026-07-03T00:00:00Z", secretRawField: "must-not-leak" }),
        "utf8",
      );
      const result = runCli(["status", "--json"], home);
      expect(result.status).toBe(0);
      const snapshot = JSON.parse(result.stdout);
      expect(snapshot.watchdog).toEqual({
        present: true,
        attempts: 3,
        gaveUpAt: "2026-07-03T00:00:00Z",
        unreadable: false,
      });
      expect(result.stdout).not.toContain("secretRawField");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("status --json flags a malformed watchdog file as unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-status-"));
    try {
      writeFileSync(join(home, "frogp-watchdog-status.json"), "{not json", "utf8");
      const result = runCli(["status", "--json"], home);
      expect(result.status).toBe(0);
      const snapshot = JSON.parse(result.stdout);
      expect(snapshot.watchdog).toEqual({ present: true, attempts: null, gaveUpAt: null, unreadable: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("status --json coerces invalid watchdog field types to null", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-status-"));
    try {
      writeFileSync(
        join(home, "frogp-watchdog-status.json"),
        JSON.stringify({ attempts: "three", gaveUpAt: 12345 }),
        "utf8",
      );
      const result = runCli(["status", "--json"], home);
      expect(result.status).toBe(0);
      const snapshot = JSON.parse(result.stdout);
      expect(snapshot.watchdog).toEqual({ present: true, attempts: null, gaveUpAt: null, unreadable: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("status rejects unknown options with exit 1", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-status-"));
    try {
      const result = runCli(["status", "--verbose"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown status option: --verbose");
      expect(result.stderr).toContain("Usage: frogp status [--json]");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
