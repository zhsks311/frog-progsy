import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addClaudeGrant,
  assertInsideGrantsRoot,
  assertRealClaudeExecutable,
  buildClaudeGrantLoginCommand,
  createClaudeGrantId,
  ensureClaudeGrants,
  expectedKeychainService,
  grantConfigDir,
  grantCredentialsPath,
  grantsRoot,
  isValidGrantId,
  listClaudeGrants,
  NATIVE_KEYCHAIN_SERVICE,
  readGrantMarker,
  removeClaudeGrant,
  resolveClaudeGrant,
  verifyClaudeGrantProvisioned,
} from "../src/claude-grants";
import type { FrogConfig } from "../src/types";

const originalHome = process.env.FROGPROGSY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frog-grants-"));
  process.env.FROGPROGSY_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function baseConfig(): FrogConfig {
  return { port: 10100, defaultProvider: "anthropic", providers: {} };
}

function executableFixturePath(path: string): string {
  return process.platform === "win32" ? `${path}.cmd` : path;
}
function writeExecutable(path: string, content = "#!/bin/sh\nexit 0\n"): string {
  const executablePath = executableFixturePath(path);
  writeFileSync(executablePath, content, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

describe("claude grant ids", () => {
  test("accepts cg_ hex ids and rejects traversal-shaped ids", () => {
    expect(isValidGrantId("cg_a1b2c3")).toBe(true);
    expect(isValidGrantId("cg_../evil")).toBe(false);
    expect(isValidGrantId("cg_")).toBe(false);
    expect(isValidGrantId("nope")).toBe(false);
    expect(isValidGrantId("cg_../../etc/passwd")).toBe(false);
  });

  test("createClaudeGrantId yields unique valid ids", () => {
    const a = createClaudeGrantId();
    const b = createClaudeGrantId([a]);
    expect(isValidGrantId(a)).toBe(true);
    expect(isValidGrantId(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("claude grant path safety", () => {
  test("grantConfigDir rejects malformed ids", () => {
    expect(() => grantConfigDir("cg_../../etc")).toThrow(/invalid claude grant id/);
    expect(() => grantConfigDir("../escape")).toThrow(/invalid claude grant id/);
  });

  test("assertInsideGrantsRoot rejects paths outside the grants root", () => {
    expect(() => assertInsideGrantsRoot("read", "/etc/passwd")).toThrow(/outside the claude-grants root/);
    expect(() => assertInsideGrantsRoot("read", join(grantsRoot(), "..", "sibling"))).toThrow(/outside the claude-grants root/);
    expect(() => assertInsideGrantsRoot("read", grantsRoot())).toThrow(/equals the claude-grants root/);
  });

  test("grantCredentialsPath refuses to escape the grants root", () => {
    expect(() => grantCredentialsPath(join(grantsRoot(), "..", "..", "somewhere"))).toThrow(/outside the claude-grants root/);
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });

    expect(grantCredentialsPath(grant.configDir)).toContain(join("claude-grants", grant.id));
    expect(grantCredentialsPath(grant.configDir).endsWith(".credentials.json")).toBe(true);
  });
});

describe("scoped keychain service derivation", () => {
  test("derives Claude Code-credentials-<sha256[0..8]> from the canonical config dir", () => {
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });
    const service = expectedKeychainService(grant.configDir);
    const expectedHash = createHash("sha256").update(realpathSync.native(grant.configDir)).digest("hex").slice(0, 8);

    expect(service).toBe(`Claude Code-credentials-${expectedHash}`);
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(service).not.toBe(NATIVE_KEYCHAIN_SERVICE);
    // Deterministic
    expect(expectedKeychainService(grant.configDir)).toBe(service);
  });

  test("distinct grant dirs derive distinct services", () => {
    const config = baseConfig();
    const a = addClaudeGrant(config, { label: "A" });
    const b = addClaudeGrant(config, { label: "B" });
    expect(expectedKeychainService(a.configDir)).not.toBe(expectedKeychainService(b.configDir));
  });
});

describe("claude grant collection", () => {
  test("add materializes a scoped dir + marker binding the id, and lists/resolves it", () => {
    const config = baseConfig();
    const grant = addClaudeGrant(config, { label: "Work" });

    expect(grant.configDir).toBe(join(realpathSync.native(grantsRoot()), grant.id));
    expect(existsSync(grant.configDir)).toBe(true);

    const marker = readGrantMarker(grant.configDir);
    expect(marker?.id).toBe(grant.id);
    expect(marker?.configDir).toBe(grant.configDir);

    expect(listClaudeGrants(config).map(g => g.id)).toEqual([grant.id]);
    expect(resolveClaudeGrant(config, grant.id).id).toBe(grant.id);
    expect(resolveClaudeGrant(config, "Work").id).toBe(grant.id);
    expect(() => resolveClaudeGrant(config, "missing")).toThrow(/not found/);
  });

  test("remove deletes only the bound scoped dir and drops the record", () => {
    const config = baseConfig();
    const grant = addClaudeGrant(config, { label: "Temp" });
    expect(existsSync(grant.configDir)).toBe(true);

    const removed = removeClaudeGrant(config, grant.id);
    expect(removed.id).toBe(grant.id);
    expect(existsSync(grant.configDir)).toBe(false);
    expect(listClaudeGrants(config)).toEqual([]);
  });

  test("remove refuses a tampered record whose configDir points outside the grants root", () => {
    const config = baseConfig();
    const outside = mkdtempSync(join(tmpdir(), "frog-outside-"));
    const sentinel = writeExecutable(join(outside, "keep.txt"), "keep\n");
    ensureClaudeGrants(config).grants.push({
      id: "cg_tamper01",
      label: "bad",
      configDir: outside,
      createdAt: new Date().toISOString(),
    });

    expect(() => removeClaudeGrant(config, "cg_tamper01")).toThrow(/outside the claude-grants root/);
    expect(existsSync(sentinel)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("guided login requires a real Claude executable", () => {
  test("rejects a bare `claude` (interceptable by a frogprogsy shim)", () => {
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });
    expect(() => buildClaudeGrantLoginCommand({ grant, realClaude: "claude" })).toThrow(/non-absolute/);
    expect(() => buildClaudeGrantLoginCommand({ grant, resolveRealClaude: () => "claude" })).toThrow(/non-absolute/);
    expect(() => assertRealClaudeExecutable("claude")).toThrow(/non-absolute/);
  });

  test("rejects an executable inside the frogprogsy launcher bin dir", () => {
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    const shim = writeExecutable(join(binDir, "claude"));
    expect(() => buildClaudeGrantLoginCommand({ grant, realClaude: shim })).toThrow(/launcher directory/);
  });

  test("rejects a managed frogprogsy launcher by its generated marker", () => {
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });
    const managed = writeExecutable(join(home, "managed-claude"), "#!/bin/sh\n# Generated by frogprogsy. Do not edit by hand.\nexit 0\n");
    expect(() => buildClaudeGrantLoginCommand({ grant, realClaude: managed })).toThrow(/managed frogprogsy launcher/);
  });

  test("rejects a source-form frogprogsy launcher from another worktree (no generated marker)", () => {
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });
    // A sibling worktree's `src/claude.ts`-style launcher: absolute, executable, outside this source
    // tree, and without the generated marker — but it delegates to runClaudeLauncherProcess.
    const worktreeSrc = join(home, "other-worktree", "src");
    mkdirSync(worktreeSrc, { recursive: true });
    const sourceLauncher = writeExecutable(
      join(worktreeSrc, "claude"),
      '#!/usr/bin/env bun\nimport { runClaudeLauncherProcess } from "./claude-launchers";\nrunClaudeLauncherProcess(process.argv.slice(2), "claude");\n',
    );
    expect(() => assertRealClaudeExecutable(sourceLauncher)).toThrow(/managed frogprogsy launcher/);
    expect(() => buildClaudeGrantLoginCommand({ grant, realClaude: sourceLauncher })).toThrow(/managed frogprogsy launcher/);
  });

  test("returns a scoped login command for a verified real executable", () => {
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });
    const realDir = join(home, "realbin");
    mkdirSync(realDir, { recursive: true });
    const realExe = writeExecutable(join(realDir, "claude"));

    const cmd = buildClaudeGrantLoginCommand({ grant, realClaude: realExe });
    expect(cmd.command).toBe(realpathSync.native(realExe));
    expect(cmd.command).not.toBe("claude");
    expect(cmd.args).toEqual(["auth", "login", "--claudeai"]);
    expect(cmd.env.CLAUDE_CONFIG_DIR).toBe(grant.configDir);
    expect(cmd.configDir).toBe(grant.configDir);
    expect(cmd.expectedService).toBe(expectedKeychainService(grant.configDir));
    expect(cmd.expectedService).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  test("refuses a grant configDir outside the grants root", () => {
    const realDir = join(home, "realbin");
    mkdirSync(realDir, { recursive: true });
    const realExe = writeExecutable(join(realDir, "claude"));
    expect(() => buildClaudeGrantLoginCommand({ grant: { id: "cg_abc123", configDir: "/etc" }, realClaude: realExe }))
      .toThrow(/outside the claude-grants root/);
  });
});

describe("guided login enforces real executability on this platform", () => {
  test("rejects a zero-byte Claude update artifact even when the exec bit is set", () => {
    const artifact = join(home, "claude-partial");
    writeFileSync(artifact, "", "utf8");
    chmodSync(artifact, 0o755);
    expect(() => assertRealClaudeExecutable(artifact)).toThrow(/not executable/);
  });

  test.skipIf(process.platform === "win32")("rejects a non-executable file (no exec bit) — POSIX X_OK semantics", () => {
    const noexec = join(home, "claude-noexec");
    writeFileSync(noexec, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(noexec, 0o644);
    expect(() => assertRealClaudeExecutable(noexec)).toThrow(/not executable/);
  });
  test.skipIf(process.platform !== "win32")("rejects a non-runnable extensionless file on Windows", () => {
    const extensionless = join(home, "claude-extensionless");
    writeFileSync(extensionless, "@echo off\r\nexit /b 0\r\n", "utf8");
    expect(() => assertRealClaudeExecutable(extensionless)).toThrow(/not executable/);
  });

  test("rejects a directory that shares the executable name", () => {
    const dir = join(home, "claude-dir");
    mkdirSync(dir, { recursive: true });
    expect(() => assertRealClaudeExecutable(dir)).toThrow(/not a file/);
  });

  test("rejects a symlink that resolves to a managed frogprogsy launcher", () => {
    const managed = writeExecutable(join(home, "managed-real"), "#!/bin/sh\n# Generated by frogprogsy. Do not edit.\nexit 0\n");
    const link = join(home, "claude-managed-link");
    symlinkSync(managed, link);
    expect(() => assertRealClaudeExecutable(link)).toThrow(/managed frogprogsy launcher/);
  });

  test("accepts an executable symlink and returns the canonical real path", () => {
    const realDir = join(home, "opt", "claude");
    mkdirSync(realDir, { recursive: true });
    const target = writeExecutable(join(realDir, "claude"));
    const link = join(home, "claude-symlink");
    symlinkSync(target, link);

    const resolved = assertRealClaudeExecutable(link);
    expect(resolved).toBe(realpathSync.native(target));
    expect(resolved).not.toBe(link);
  });

  test("build command accepts an executable symlink and canonicalizes the command", () => {
    const grant = addClaudeGrant(baseConfig(), { label: "Work" });
    const realDir = join(home, "opt2", "claude");
    mkdirSync(realDir, { recursive: true });
    const target = writeExecutable(join(realDir, "claude"));
    const link = join(home, "claude-cmd-link");
    symlinkSync(target, link);

    const cmd = buildClaudeGrantLoginCommand({ grant, realClaude: link });
    expect(cmd.command).toBe(realpathSync.native(target));
  });

  test("errors give a fixed reason and never dump the candidate path or secrets", () => {
    const secretDir = join(home, "s3cr3t-token-store");
    mkdirSync(secretDir, { recursive: true });
    const secretPath = join(secretDir, "claude");
    writeFileSync(secretPath, "", "utf8");
    chmodSync(secretPath, 0o755);

    let caught: unknown;
    try {
      assertRealClaudeExecutable(secretPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("claude grant login executable is not executable");
    expect((caught as Error).message).not.toContain(secretPath);
    expect((caught as Error).message).not.toContain("s3cr3t");
  });
});

describe("grant setup verification contract", () => {
  test("darwin verify passes only when the scoped credential exists", async () => {
    const grant = addClaudeGrant(baseConfig(), { label: "V" });
    await expect(verifyClaudeGrantProvisioned(grant, { platform: "darwin", hasScopedCredential: () => true }))
      .resolves.toMatchObject({ ok: true, service: expectedKeychainService(grant.configDir) });
    await expect(verifyClaudeGrantProvisioned(grant, { platform: "darwin", hasScopedCredential: () => false }))
      .rejects.toThrow(/not provisioned/);
  });

  test("non-darwin verify uses the scoped file credential", async () => {
    const grant = addClaudeGrant(baseConfig(), { label: "V" });
    const seen: string[] = [];
    await expect(verifyClaudeGrantProvisioned(grant, {
      platform: "linux",
      hasFileCredential: (path) => { seen.push(path); return true; },
    })).resolves.toMatchObject({ ok: true });
    expect(seen[0]).toBe(grantCredentialsPath(grant.configDir));
  });
});
