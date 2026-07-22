import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runCommand as prepareHome } from "../evals/fusion/src/prepare-home";
import { runCommand as hashConfig } from "../evals/fusion/src/hash-config";
import { runCommand as health } from "../evals/fusion/src/health";
import { runCommand as stopServer } from "../evals/fusion/src/stop-server";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("failed to allocate TCP port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

function writeFixtureFiles(root: string): { base: string; overlay: string; suite: string } {
  const base = join(root, "base-config.json");
  const overlay = join(root, "profile.json");
  const suite = join(root, "suite.jsonl");
  writeFileSync(base, JSON.stringify({
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "local",
    providers: {
      local: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "secret-local-key",
        defaultModel: "local-model",
        models: ["local-model"],
        liveModels: false,
      },
      routed: {
        adapter: "openai-chat",
        baseUrl: "http://routed.test/v1",
        defaultModel: "fixture-model",
        models: ["fixture-model"],
        liveModels: false,
      },
      codex: {
        adapter: "openai-responses",
        authMode: "oauth",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        defaultModel: "stale-model",
        models: ["stale-model"],
      },
    },
    websockets: false,
  }, null, 2) + "\n");
  writeFileSync(overlay, JSON.stringify({
    name: "f0-current",
    description: "test profile",
    targetModel: "frogp/mix",
    modelMixing: {
      enabled: true,
      aliasId: "frogp/mix",
      mode: "rules",
      combine: "fusion",
      agents: [{ provider: "local", model: "local-model", tasks: ["coding"] }],
      fusion: { panel: [{ provider: "local", model: "local-model" }] },
    },
  }, null, 2) + "\n");
  writeFileSync(suite, JSON.stringify({
    id: "reasoning-001",
    suiteVersion: "local-suite-test",
    category: "reasoning",
    prompt: "What is 2+2?",
    allowedClientTools: [],
    reference: "4",
    grader: "exact",
    weight: 1,
    tags: ["smoke"],
    maxTokens: 128,
    timeoutBudget: 1000,
  }) + "\n");
  return { base, overlay, suite };
}

async function waitForHealth(proxy: string, expectedModel: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${proxy}/healthz`);
      if (res.ok && await health(["--proxy", proxy, "--expect-model", expectedModel]) === 0) return;
    } catch {
      // server is still starting
    }
    await Bun.sleep(100);
  }
  throw new Error("server did not become healthy");
}

describe("eval fusion home tooling", () => {
  test("prepare-home is idempotent and serve keeps canonical config hash stable", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-home-"));
    roots.push(root);
    const { base, overlay, suite } = writeFixtureFiles(root);
    const runA = join(root, "run-a");
    const runB = join(root, "run-b");

    const argsA = [
      "--base", base,
      "--overlay", overlay,
      "--suite", suite,
      "--canonicalize-startup",
      "--out", join(runA, "home"),
      "--snapshot", join(runA, "config.snapshot.json"),
      "--hash-out", join(runA, "config.sha256"),
    ];
    const argsB = [
      "--base", base,
      "--overlay", overlay,
      "--suite", suite,
      "--canonicalize-startup",
      "--out", join(runB, "home"),
      "--snapshot", join(runB, "config.snapshot.json"),
      "--hash-out", join(runB, "config.sha256"),
    ];
    expect(await prepareHome(argsA)).toBe(0);
    expect(await prepareHome(argsB)).toBe(0);
    expect(readFileSync(join(runA, "config.sha256"), "utf8")).toBe(readFileSync(join(runB, "config.sha256"), "utf8"));

    const prepared = JSON.parse(readFileSync(join(runA, "home", "config.json"), "utf8"));
    expect(prepared.providers.routed).toBeUndefined();
    expect(prepared.providers.codex.classifierModel).toBe("gpt-5.4-mini");
    expect(prepared.subagentModels).toContain("gpt-5.5");
    expect(readFileSync(join(runA, "config.snapshot.json"), "utf8")).toContain("[REDACTED]");

    expect(await hashConfig(["--config", join(runA, "home", "config.json"), "--expect-file", join(runA, "config.sha256")])).toBe(0);

    const port = await freePort();
    const pidFile = join(runA, "server.pid");
    const claudeHome = join(root, "claude-home");
    mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    const proc = Bun.spawn({
      cmd: ["bun", "tools/eval-fusion.ts", "serve", "--home", join(runA, "home"), "--host", "127.0.0.1", "--port", String(port), "--pid-file", pidFile],
      env: { ...process.env, FROGPROGSY_HOME: join(root, "should-not-use"), CLAUDE_HOME: claudeHome, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await waitForHealth(`http://127.0.0.1:${port}`, "frogp/mix");
      expect(await hashConfig(["--config", join(runA, "home", "config.json"), "--expect-file", join(runA, "config.sha256")])).toBe(0);
      const stopping = stopServer(["--pid-file", pidFile]);
      await Promise.all([stopping, proc.exited]);
      // General stop coverage on every platform: the stop command succeeds and clears the pid file.
      expect(await stopping).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      // Graceful zero exit on SIGTERM is a POSIX signal contract. On Windows process.kill maps to
      // TerminateProcess, which cannot yield a graceful zero exit, so only assert termination.
      if (process.platform === "win32") expect(proc.exitCode).not.toBeNull();
      else expect(proc.exitCode).toBe(0);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited.catch(() => undefined);
    }
  });
});
