import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { activePortPath, getConfigDir, getConfigPath, getPidPath, readActivePort } from "../src/config";
import { isolatedHome } from "./preload";

// The real, un-isolated home the preload must keep tests away from.
const defaultHome = resolve(join(homedir(), ".frogprogsy"));
const tmpRoot = resolve(tmpdir());
const preloadPath = join(import.meta.dir, "preload.ts");

function isUnderTmp(p: string): boolean {
  const r = resolve(p);
  return r === tmpRoot || r.startsWith(tmpRoot + sep);
}

describe("test environment isolation", () => {
  test("FROGPROGSY_HOME is forced to an isolated temp home, never the real user home", () => {
    const home = process.env.FROGPROGSY_HOME;
    expect(home).toBeDefined();
    expect(home).toBe(isolatedHome);
    expect(isUnderTmp(home!)).toBe(true);
    expect(resolve(home!)).not.toBe(defaultHome);
  });

  test("config resolution points at the isolated home, not the default dir", () => {
    expect(resolve(getConfigDir())).toBe(resolve(isolatedHome));
    expect(resolve(getConfigDir())).not.toBe(defaultHome);
    // Every state path (config.json, frogp.pid, frogp.port) lives under the temp home.
    for (const p of [getConfigPath(), getPidPath(), activePortPath()]) {
      expect(resolve(p).startsWith(resolve(isolatedHome) + sep)).toBe(true);
    }
  });

  test("a running real proxy's active-port file is invisible to tests", () => {
    // The isolated home is a fresh empty dir, so even when the real ~/.frogprogsy/frogp.port exists
    // (a live proxy on port 3764), this process reads nothing from it.
    expect(existsSync(activePortPath())).toBe(false);
    expect(readActivePort()).toBeNull();
  });

  test("preload overrides a caller-supplied REAL home with an isolated temp home", () => {
    // Simulate the exact hostile case in a real child test runner. Running the preload in `bun -e` would
    // be invalid because its beforeEach hook intentionally requires the Bun test runtime.
    const probeRoot = mkdtempSync(join(tmpdir(), "frogprogsy-isolation-probe-"));
    const probeFile = join(probeRoot, "probe.test.ts");
    writeFileSync(
      probeFile,
      'import { test } from "bun:test"; test("probe", () => console.log(`PROBE_HOME=${process.env.FROGPROGSY_HOME ?? ""}`));\n',
    );
    try {
      const res = Bun.spawnSync({
        cmd: ["bun", "test", "--preload", preloadPath, probeFile],
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, FROGPROGSY_HOME: defaultHome, NODE_ENV: "test" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      expect(res.exitCode).toBe(0);
      const match = res.stdout.toString().match(/PROBE_HOME=(.+)/);
      expect(match).not.toBeNull();
      const out = match![1]!.trim();
      expect(out).not.toBe("");
      expect(resolve(out)).not.toBe(defaultHome);
      expect(isUnderTmp(out)).toBe(true);
      // The child removed only its own captured isolated home on exit.
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  });
});
