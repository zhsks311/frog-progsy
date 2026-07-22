import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

const ANSI_PATTERN = /\x1b\[[0-9;]*m/;

const STUB_MODELS = [
  { id: "gpt-5.5", provider: "codex", namespaced: "codex/gpt-5.5", disabled: false, contextWindow: 400000, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"] },
  { id: "gpt-5.4-mini", provider: "codex", namespaced: "codex/gpt-5.4-mini", disabled: true },
  { id: "claude-sonnet-4-6", provider: "anthropic", namespaced: "anthropic/claude-sonnet-4-6", disabled: false },
];

function runCli(argv: string[], frogHome: string, extraEnv: Record<string, string> = {}) {
  const claudeHome = join(frogHome, "claude");
  mkdirSync(claudeHome, { recursive: true });
  return spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome, ...extraEnv },
    encoding: "utf8",
    timeout: 15_000,
  });
}

/** Async spawn so an in-process Bun.serve stub stays responsive while the CLI runs. */
async function runCliAsync(argv: string[], frogHome: string, extraEnv: Record<string, string> = {}) {
  const claudeHome = join(frogHome, "claude");
  mkdirSync(claudeHome, { recursive: true });
  const proc = Bun.spawn([process.execPath, cliPath, ...argv], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, status };
}

/** Simulate a running proxy: live PID (this test process) + active-port record. */
function writeRunningState(frogHome: string, port: number) {
  writeFileSync(join(frogHome, "frogp.pid"), String(process.pid), "utf8");
  writeFileSync(join(frogHome, "frogp.port"), String(port), "utf8");
}

function startStubProxy(): { server: ReturnType<typeof Bun.serve>; port: number } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok", { status: 200 });
      if (url.pathname === "/api/models") return Response.json(STUB_MODELS);
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port };
}

describe("frogp models", () => {
  test("fails with frogp start guidance when no proxy is recorded", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    try {
      const result = runCli(["models"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Proxy not running. Start it with: frogp start");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fails with recovery guidance when the recorded proxy does not answer health checks", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    try {
      // Live PID but nothing listening on the recorded port → health check must fail.
      writeRunningState(home, 1); // port 1 is never listening for us
      const result = runCli(["models"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not answering on port 1");
      expect(result.stderr).toContain("frogp refresh");
      // Never synthesize an offline model list.
      expect(result.stdout).not.toContain("gpt-");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("groups models by provider for human output", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    const { server, port } = startStubProxy();
    try {
      writeRunningState(home, port);
      const result = await runCliAsync(["models"], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("codex (2)");
      expect(result.stdout).toContain("anthropic (1)");
      expect(result.stdout).toContain("gpt-5.5");
      expect(result.stdout).toContain("disabled");
      expect(result.stdout).toContain("claude-sonnet-4-6");
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("models --json prints the /api/models array unchanged with no ANSI even under FORCE_COLOR", async () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    const { server, port } = startStubProxy();
    try {
      writeRunningState(home, port);
      const result = await runCliAsync(["models", "--json"], home, { FORCE_COLOR: "1" });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(ANSI_PATTERN);
      expect(JSON.parse(result.stdout)).toEqual(STUB_MODELS);
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects unknown options with exit 1", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-models-"));
    try {
      const result = runCli(["models", "--all"], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown models option: --all");
      expect(result.stderr).toContain("Usage: frogp models [--json]");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
