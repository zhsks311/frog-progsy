import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatLoginFailure } from "../src/oauth/login-cli";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

function runCli(argv: string[], frogHome: string) {
  const claudeHome = join(frogHome, "claude");
  mkdirSync(claudeHome, { recursive: true });
  return spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome },
    encoding: "utf8",
    timeout: 5000,
  });
}

describe("CLI login provider help", () => {
  test("login --list prints provider groups to stdout", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-login-"));
    try {
      const result = runCli(["login", "--list"], home);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("OAuth login:");
      expect(result.stdout).toContain("codex");
      expect(result.stdout).toContain("anthropic");
      expect(result.stdout).toContain("xai");
      expect(result.stdout).toContain("kimi");
      expect(result.stdout).toContain("API-key login:");
      expect(result.stdout).toContain("openai-apikey");
      expect(result.stdout).toContain("openai is an alias for openai-apikey");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("login without a provider fails with usage and does not create state", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-login-"));
    try {
      const result = runCli(["login"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: frogp login [--list|<provider>]");
      expect(result.stderr).toContain("OAuth login:");
      expect(result.stderr).toContain("API-key login:");
      expect(result.stderr).toContain("openai is an alias for openai-apikey");
      expect(existsSync(join(home, "config.json"))).toBe(false);
      expect(existsSync(join(home, "auth.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("unknown login provider suggests the closest known provider", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-login-"));
    try {
      const result = runCli(["login", "opnai"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Did you mean: frogp login openai?");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("OAuth login failure formatter includes provider and cause without stack frames", () => {
    const message = formatLoginFailure("codex", new Error("callback timed out"));
    expect(message).toContain("Login failed for codex: callback timed out");
    expect(message).toContain("Try again: frogp login codex");
    expect(message).not.toContain("at ");
  });
});
