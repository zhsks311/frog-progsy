import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  BIN_NAME,
  PACKAGE_NAME,
  PackageSmokeError,
  SENTINEL_SETTINGS_OBJECT,
  binName,
  buildChildEnv,
  bytesEquivalent,
  listTarballs,
  parseTarballDir,
  planTempLayout,
  resolvePackageSmokeDeps,
  resolveSingleTarball,
  runCleanup,
  runPackageLifecycleSmoke,
  sentinelSettingsBytes,
  type CommandRunner,
  type DetachedSpawner,
  type PackageSmokeDeps,
} from "../scripts/package-lifecycle-smoke";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── tarball cardinality ──────────────────────────────────────────────────────────────────────

describe("package lifecycle smoke — tarball cardinality", () => {
  test("resolves the single .tgz among unrelated entries", () => {
    const entries = ["README.md", "frogprogsy-0.0.1.tgz", "notes.txt", ".DS_Store"];
    expect(resolveSingleTarball("/dl", entries)).toBe(resolve("/dl", "frogprogsy-0.0.1.tgz"));
  });

  test("a relative --tarball-dir resolves to an absolute tarball path (bun add -g must not resolve against the temp global install)", () => {
    const out = resolveSingleTarball("dist-tarball", ["README.md", "frogprogsy-0.0.1.tgz"]);
    expect(isAbsolute(out)).toBe(true);
    expect(out).toBe(resolve("dist-tarball", "frogprogsy-0.0.1.tgz"));
    expect(out.endsWith("frogprogsy-0.0.1.tgz")).toBe(true);
  });

  test("case-insensitive, sorted tarball listing", () => {
    expect(listTarballs(["b.TGZ", "a.tgz", "c.md"])).toEqual(["a.tgz", "b.TGZ"]);
  });

  test("zero tarballs is a hard error", () => {
    expect(() => resolveSingleTarball("/dl", ["README.md"])).toThrow(PackageSmokeError);
    expect(() => resolveSingleTarball("/dl", [])).toThrow(/no .tgz tarball/);
  });

  test("more than one tarball is a hard error with a redacted count", () => {
    const entries = ["frogprogsy-0.0.1.tgz", "frogprogsy-0.0.2.tgz"];
    expect(() => resolveSingleTarball("/dl", entries)).toThrow(/exactly one .tgz .* found 2/);
  });

  test("parseTarballDir requires the flag", () => {
    expect(parseTarballDir(["--tarball-dir", "/dl"])).toBe("/dl");
    expect(() => parseTarballDir([])).toThrow(PackageSmokeError);
    expect(() => parseTarballDir(["--tarball-dir", "--other"])).toThrow(/usage/);
  });
});

// ── cross-platform temp bin resolution ─────────────────────────────────────────────────────────

describe("package lifecycle smoke — temp bin resolution", () => {
  test("bin filename is platform-aware", () => {
    expect(binName("linux")).toBe(BIN_NAME);
    expect(binName("darwin")).toBe(BIN_NAME);
    expect(binName("win32")).toBe("frogp.exe");
  });

  test("layout points every managed file inside the temp root", () => {
    const posix = planTempLayout("/tmp/root", "linux");
    expect(posix.bunInstall).toBe(join("/tmp/root", "bun-install"));
    expect(posix.binDir).toBe(join("/tmp/root", "bun-install", "bin"));
    expect(posix.binPath).toBe(join("/tmp/root", "bun-install", "bin", "frogp"));
    expect(posix.frogpPidPath).toBe(join("/tmp/root", "frogprogsy-home", "frogp.pid"));
    expect(posix.watchdogPidPath).toBe(join("/tmp/root", "frogprogsy-home", "watchdog.pid"));
    expect(posix.activePortPath).toBe(join("/tmp/root", "frogprogsy-home", "frogp.port"));
    expect(posix.configPath).toBe(join("/tmp/root", "frogprogsy-home", "config.json"));
    expect(posix.claudeSettingsPath).toBe(join("/tmp/root", "claude-home", "settings.json"));

    const win = planTempLayout("C:\\root", "win32");
    expect(win.binPath).toBe(join("C:\\root", "bun-install", "bin", "frogp.exe"));
  });
});

// ── isolated temp env ──────────────────────────────────────────────────────────────────────────

describe("package lifecycle smoke — isolated temp env", () => {
  const layout = planTempLayout("/tmp/root", "linux");

  test("pins the four isolation vars and prepends the temp bin to PATH", () => {
    const env = buildChildEnv(layout, { PATH: "/usr/bin:/bin", HOME: "/home/ci" });
    expect(env.BUN_INSTALL).toBe(layout.bunInstall);
    expect(env.FROGPROGSY_HOME).toBe(layout.frogHome);
    expect(env.CLAUDE_HOME).toBe(layout.claudeHome);
    expect(env.CLAUDE_CONFIG_DIR).toBe(layout.claudeHome);
    expect(env.PATH).toBe(`${layout.binDir}${delimiter}/usr/bin:/bin`);
    expect(env.HOME).toBe("/home/ci"); // unrelated caller vars pass through so the child works
  });

  test("keeps the default watchdog ON by stripping external-supervisor / detached flags", () => {
    const env = buildChildEnv(layout, {
      PATH: "/usr/bin",
      FROGP_EXTERNAL_SUPERVISOR: "1",
      FROGP_DETACHED: "1",
    });
    expect(env.FROGP_EXTERNAL_SUPERVISOR).toBeUndefined();
    expect(env.FROGP_DETACHED).toBeUndefined();
  });

  test("strips inherited NODE_ENV and FROGPROGSY_NO_CLAUDE_WRITES so restore is not vacuous", () => {
    // An inherited NODE_ENV=test or no-writes flag would make the installed proxy skip the Claude Code
    // settings injection, leaving the byte-equivalent restore assertion meaningless.
    const env = buildChildEnv(layout, {
      PATH: "/usr/bin",
      NODE_ENV: "test",
      FROGPROGSY_NO_CLAUDE_WRITES: "1",
    });
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.FROGPROGSY_NO_CLAUDE_WRITES).toBeUndefined();
  });

  test("normalizes inherited Path casing into a single canonical PATH", () => {
    const env = buildChildEnv(layout, { Path: "C:\\Windows" });
    expect(env.Path).toBeUndefined();
    expect(env.PATH.startsWith(layout.binDir)).toBe(true);
    expect(env.PATH.endsWith("C:\\Windows")).toBe(true);
  });

  test("PATH is just the temp bin when the caller had none", () => {
    const env = buildChildEnv(layout, {});
    expect(env.PATH).toBe(layout.binDir);
  });
});

// ── restore assertion primitives ───────────────────────────────────────────────────────────────

describe("package lifecycle smoke — restore assertions", () => {
  test("bytesEquivalent compares exact bytes across string/Buffer", () => {
    expect(bytesEquivalent("abc", "abc")).toBe(true);
    expect(bytesEquivalent("abc", Buffer.from("abc"))).toBe(true);
    expect(bytesEquivalent("abc", "abc\n")).toBe(false);
    expect(bytesEquivalent(Buffer.from("a"), Buffer.from("b"))).toBe(false);
  });

  test("sentinel settings are env-free, non-routed, and product-serialized", () => {
    expect("env" in SENTINEL_SETTINGS_OBJECT).toBe(false);
    expect(SENTINEL_SETTINGS_OBJECT.model.startsWith("claude-frogp-")).toBe(false);
    // Same serialization the product uses so an inject -> restore round-trip is byte-identical.
    expect(sentinelSettingsBytes()).toBe(`${JSON.stringify(SENTINEL_SETTINGS_OBJECT, null, 2)}\n`);
    expect(sentinelSettingsBytes().endsWith("\n")).toBe(true);
  });
});

// ── cleanup ordering + safety gate + config preservation ───────────────────────────────────────

describe("package lifecycle smoke — watchdog-before-proxy cleanup ordering", () => {
  test("kills watchdog before proxy, checks port, verifies config, then removes package + temp", async () => {
    const layout = planTempLayout("/tmp/frogp-cleanup-order", "linux");
    const WATCHDOG = 700001;
    const PROXY = 700002;
    const PORT = 46123;
    const alive = new Set([WATCHDOG, PROXY]);
    const timeline: string[] = [];

    const deps = resolvePackageSmokeDeps({
      platform: "linux",
      readIntFile: (path) =>
        path === layout.watchdogPidPath
          ? WATCHDOG
          : path === layout.frogpPidPath
            ? PROXY
            : path === layout.activePortPath
              ? PORT
              : null,
      isAlive: (pid) => alive.has(pid),
      killPid: (pid) => {
        timeline.push(`kill:${pid}`);
        alive.delete(pid);
      },
      portBound: async () => {
        timeline.push("port-probe");
        return false;
      },
      fileExists: (path) => {
        if (path === layout.configPath) {
          timeline.push("config-check");
          return true;
        }
        return false;
      },
      run: (file, args) => {
        timeline.push(`run:${file}:${args[0]}`);
        return { status: 0, stdout: "", stderr: "" };
      },
      removeDir: () => {
        timeline.push("rmtemp");
      },
      sleep: async () => {},
      killTimeoutMs: 200,
      portTimeoutMs: 200,
    });

    const result = await runCleanup(deps, layout, {} as Record<string, string>, PORT);

    expect(result.watchdogKilled).toBe(true);
    expect(result.proxyKilled).toBe(true);
    expect(result.watchdogBeforeProxy).toBe(true);
    expect(result.portUnbound).toBe(true);
    expect(result.safeToRemove).toBe(true);
    expect(result.packageRemoved).toBe(true);
    expect(result.configPreserved).toBe(true);
    expect(result.tempRemoved).toBe(true);

    const killWatchdog = timeline.indexOf(`kill:${WATCHDOG}`);
    const killProxy = timeline.indexOf(`kill:${PROXY}`);
    const port = timeline.indexOf("port-probe");
    const removePackage = timeline.indexOf(`run:bun:remove`);
    const configCheck = timeline.indexOf("config-check");
    const removeTemp = timeline.indexOf("rmtemp");

    expect(killWatchdog).toBeGreaterThanOrEqual(0);
    expect(killWatchdog).toBeLessThan(killProxy); // watchdog dies first so it cannot respawn the proxy
    expect(port).toBeGreaterThan(killProxy); // port-unbound invariant is checked only after both kills
    expect(removePackage).toBeGreaterThan(port); // bun remove -g runs after the port is confirmed free
    expect(configCheck).toBeGreaterThan(removePackage); // config verified AFTER removal, BEFORE temp delete
    expect(removeTemp).toBeGreaterThan(configCheck); // temp tree deleted last

    // Structural marker ordering matches the side-effecting call ordering.
    expect(result.events.indexOf("kill-watchdog")).toBeLessThan(result.events.indexOf("kill-proxy"));
    expect(result.events.indexOf("port-check")).toBeGreaterThan(result.events.indexOf("kill-proxy"));
    expect(result.events.indexOf("config-preserved")).toBeGreaterThan(result.events.indexOf("remove-package"));
    expect(result.events.indexOf("remove-temp")).toBeGreaterThan(result.events.indexOf("config-preserved"));
  });

  test("safe when pid files are already gone (graceful stop) and still ordered watchdog-first", async () => {
    const layout = planTempLayout("/tmp/frogp-cleanup-clean", "linux");
    const deps = resolvePackageSmokeDeps({
      platform: "linux",
      readIntFile: () => null, // clean stop removed the pid files already
      portBound: async () => false,
      fileExists: (path) => path === layout.configPath,
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      removeDir: () => {},
      sleep: async () => {},
      killTimeoutMs: 100,
      portTimeoutMs: 100,
    });
    const result = await runCleanup(deps, layout, {} as Record<string, string>, 46001);
    expect(result.watchdogKilled).toBe(true);
    expect(result.proxyKilled).toBe(true);
    expect(result.watchdogBeforeProxy).toBe(true);
    expect(result.portUnbound).toBe(true);
    expect(result.safeToRemove).toBe(true);
    expect(result.events.indexOf("kill-watchdog")).toBeLessThan(result.events.indexOf("kill-proxy"));
  });

  test("port-unbound invariant fails and blocks removal when the recorded port never frees", async () => {
    const layout = planTempLayout("/tmp/frogp-cleanup-bound", "linux");
    let clock = 0;
    let removeCalled = false;
    let removeDirCalled = false;
    const deps = resolvePackageSmokeDeps({
      platform: "linux",
      readIntFile: () => null,
      portBound: async () => true, // something is still listening on the recorded port
      run: (_file, args) => {
        if (args[0] === "remove") removeCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      removeDir: () => {
        removeDirCalled = true;
      },
      sleep: async () => {},
      now: () => (clock += 100),
      killTimeoutMs: 100,
      portTimeoutMs: 100,
    });
    const result = await runCleanup(deps, layout, {} as Record<string, string>, 46777);
    expect(result.portUnbound).toBe(false);
    expect(result.safeToRemove).toBe(false);
    // A bound port means the binary may still be executing: never remove the package or the temp tree.
    expect(result.packageRemoved).toBe(false);
    expect(result.tempRemoved).toBe(false);
    expect(removeCalled).toBe(false);
    expect(removeDirCalled).toBe(false);
    expect(result.watchdogBeforeProxy).toBe(true);
  });

  test("refuses to remove the package or temp tree when the proxy will not die", async () => {
    const layout = planTempLayout("/tmp/frogp-cleanup-stubborn", "linux");
    const WATCHDOG = 710001;
    const PROXY = 710002;
    const alive = new Set([WATCHDOG, PROXY]);
    let clock = 0;
    let removeCalled = false;
    let removeDirCalled = false;
    const deps = resolvePackageSmokeDeps({
      platform: "linux",
      readIntFile: (path) =>
        path === layout.watchdogPidPath ? WATCHDOG : path === layout.frogpPidPath ? PROXY : null,
      isAlive: (pid) => alive.has(pid),
      killPid: (pid) => {
        if (pid === WATCHDOG) alive.delete(WATCHDOG); // watchdog dies, proxy is stubborn
      },
      portBound: async () => false,
      run: (_file, args) => {
        if (args[0] === "remove") removeCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      removeDir: () => {
        removeDirCalled = true;
      },
      sleep: async () => {},
      now: () => (clock += 100),
      killTimeoutMs: 100,
      portTimeoutMs: 100,
    });
    const result = await runCleanup(deps, layout, {} as Record<string, string>, 46999);
    expect(result.watchdogKilled).toBe(true);
    expect(result.proxyKilled).toBe(false);
    expect(result.safeToRemove).toBe(false);
    expect(result.packageRemoved).toBe(false);
    expect(result.tempRemoved).toBe(false);
    expect(removeCalled).toBe(false);
    expect(removeDirCalled).toBe(false);
  });
});

// ── full orchestration with fully faked process/network I/O (no real global install) ───────────

interface FullHarness {
  deps: Partial<PackageSmokeDeps>;
  layout: ReturnType<typeof planTempLayout>;
  timeline: string[];
}

function makeFullHarness(
  root: string,
  tarballDir: string,
  opts: { installStatus?: number; firstStopLeaksPort?: boolean } = {},
): FullHarness {
  const layout = planTempLayout(root, "linux");
  const WATCHDOG = 987001;
  const PROXY = 987002;
  const alive = new Set<number>();
  const state = { healthy: false, portOpen: false };
  const timeline: string[] = [];
  let stopCount = 0;
  const injectedBytes = `${JSON.stringify(
    { ...SENTINEL_SETTINGS_OBJECT, env: { ANTHROPIC_BASE_URL: "http://localhost:0", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" } },
    null,
    2,
  )}\n`;

  const run: CommandRunner = (file, args) => {
    const sub = args[0];
    if (file === "bun" && sub === "add") {
      timeline.push("install");
      if ((opts.installStatus ?? 0) !== 0) return { status: opts.installStatus!, stdout: "", stderr: "" };
      mkdirSync(layout.binDir, { recursive: true });
      writeFileSync(layout.binPath, "#!/usr/bin/env bun\n");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (file === "bun" && sub === "remove") {
      timeline.push("remove-package");
      rmSync(layout.binPath, { force: true }); // drops ONLY the package bin, never the frog config
      return { status: 0, stdout: "", stderr: "" };
    }
    if (file === layout.binPath && sub === "restore") {
      timeline.push("restore");
      writeFileSync(layout.claudeSettingsPath, sentinelSettingsBytes()); // restore to the seeded bytes
      return { status: 0, stdout: "", stderr: "" };
    }
    if (file === layout.binPath && sub === "stop") {
      timeline.push("stop");
      stopCount += 1;
      writeFileSync(layout.claudeSettingsPath, sentinelSettingsBytes());
      if (stopCount === 1 && opts.firstStopLeaksPort) {
        return { status: 0, stdout: "", stderr: "" }; // broken stop: port + process still alive
      }
      state.healthy = false;
      state.portOpen = false;
      alive.delete(PROXY);
      alive.delete(WATCHDOG); // graceful stop: watchdog observes shutdown intent and exits
      rmSync(layout.frogpPidPath, { force: true });
      rmSync(layout.watchdogPidPath, { force: true });
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const spawnDetached: DetachedSpawner = (file, args) => {
    const portIndex = args.indexOf("--port");
    const port = portIndex !== -1 ? Number(args[portIndex + 1]) : 0;
    timeline.push("start");
    state.healthy = true;
    state.portOpen = true;
    alive.add(PROXY);
    alive.add(WATCHDOG);
    mkdirSync(layout.frogHome, { recursive: true });
    writeFileSync(layout.frogpPidPath, String(PROXY));
    writeFileSync(layout.watchdogPidPath, String(WATCHDOG));
    writeFileSync(layout.activePortPath, String(port));
    writeFileSync(layout.configPath, JSON.stringify({ port, providers: {} }, null, 2)); // frog config.json
    writeFileSync(layout.claudeSettingsPath, injectedBytes); // injection makes settings differ from the seed
    return { pid: PROXY, unref: () => {} };
  };

  const deps: Partial<PackageSmokeDeps> = {
    platform: "linux",
    tarballDir,
    baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/ci", SECRET_TOKEN: "passthrough", FROGP_EXTERNAL_SUPERVISOR: "1" },
    makeTempRoot: () => root,
    run,
    spawnDetached,
    allocatePort: async () => 45999,
    probeHealth: async () => state.healthy,
    portBound: async () => state.portOpen,
    killPid: (pid) => {
      alive.delete(pid);
    },
    isAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    log: () => {},
    healthTimeoutMs: 1000,
    killTimeoutMs: 1000,
    portTimeoutMs: 1000,
  };

  return { deps, layout, timeline };
}

describe("package lifecycle smoke — full lifecycle (faked, no real install)", () => {
  test("install -> start -> health -> restore -> stop -> restart -> stop -> uninstall passes end to end", async () => {
    const root = tempDir("frogp-pkg-full-");
    const tarballDir = tempDir("frogp-pkg-dl-");
    writeFileSync(join(tarballDir, "frogprogsy-0.0.1.tgz"), "fake-tarball");
    const { deps, layout, timeline } = makeFullHarness(root, tarballDir);
    try {
      const result = await runPackageLifecycleSmoke(deps);

      expect(result.outcome).toBe("passed");
      const passing = result.checks.filter((c) => c.pass).map((c) => c.id);
      for (const id of [
        "single-tarball",
        "isolated-env",
        "global-install",
        "start-health",
        "start-active-port",
        "start-watchdog",
        "restore-byte-equivalent",
        "first-stop",
        "first-stop-port-unbound",
        "restart-health",
        "restart-active-port",
        "restart-watchdog",
        "second-stop-port-unbound",
        "stop-byte-equivalent",
        "watchdog-before-proxy",
        "port-unbound-final",
        "package-removed",
        "config-preserved",
      ]) {
        expect(passing).toContain(id);
      }

      // Exact lifecycle order the smoke drove.
      expect(timeline).toEqual(["install", "start", "restore", "stop", "start", "stop", "remove-package"]);

      expect(result.recordedPort).toBe(45999);
      expect(result.cleanup.portUnbound).toBe(true);
      expect(result.cleanup.safeToRemove).toBe(true);
      expect(result.cleanup.packageRemoved).toBe(true);
      expect(result.cleanup.configPreserved).toBe(true);
      expect(result.cleanup.tempRemoved).toBe(true);
      expect(result.cleanup.watchdogBeforeProxy).toBe(true);

      // Temp tree (including the temp global bin) is gone; nothing leaked outside it.
      expect(existsSync(root)).toBe(false);
      expect(existsSync(layout.binPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(tarballDir, { recursive: true, force: true });
    }
  });

  test("a broken first stop that leaks the port fails before restart and is not mistaken for success", async () => {
    const root = tempDir("frogp-pkg-leak-");
    const tarballDir = tempDir("frogp-pkg-dl-");
    writeFileSync(join(tarballDir, "frogprogsy-0.0.1.tgz"), "fake-tarball");
    const { deps, timeline } = makeFullHarness(root, tarballDir, { firstStopLeaksPort: true });
    try {
      const result = await runPackageLifecycleSmoke(deps);

      expect(result.outcome).toBe("failed");
      expect(result.checks.some((c) => c.id === "first-stop-port-unbound" && !c.pass)).toBe(true);
      // Restart was never attempted, so a lingering old process cannot masquerade as a healthy restart.
      expect(result.checks.some((c) => c.id === "restart-health")).toBe(false);
      expect(timeline.filter((t) => t === "start")).toHaveLength(1);
      // Unsafe teardown state (port still bound): package + temp tree are preserved, not removed.
      expect(result.cleanup.safeToRemove).toBe(false);
      expect(result.cleanup.packageRemoved).toBe(false);
      expect(result.cleanup.tempRemoved).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(tarballDir, { recursive: true, force: true });
    }
  });

  test("install failure fails the smoke but still runs cleanup and removes the temp tree", async () => {
    const root = tempDir("frogp-pkg-failinstall-");
    const tarballDir = tempDir("frogp-pkg-dl-");
    writeFileSync(join(tarballDir, "frogprogsy-0.0.1.tgz"), "fake-tarball");
    const { deps } = makeFullHarness(root, tarballDir, { installStatus: 1 });
    try {
      const result = await runPackageLifecycleSmoke(deps);

      expect(result.outcome).toBe("failed");
      expect(result.checks.some((c) => c.id === "global-install" && !c.pass)).toBe(true);
      expect(result.checks.some((c) => c.id === "no-lifecycle-error" && !c.pass)).toBe(true);
      // start-health etc. never ran, but teardown still executed and the temp tree was removed.
      expect(result.checks.some((c) => c.id === "start-health")).toBe(false);
      expect(result.cleanup.tempRemoved).toBe(true);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(tarballDir, { recursive: true, force: true });
    }
  });

  test("bad tarball cardinality fails before any temp tree is created", async () => {
    const tarballDir = tempDir("frogp-pkg-dl-empty-");
    let tempMade = false;
    try {
      const result = await runPackageLifecycleSmoke({
        platform: "linux",
        tarballDir,
        makeTempRoot: () => {
          tempMade = true;
          return "/tmp/should-not-be-made";
        },
        log: () => {},
      });
      expect(result.outcome).toBe("failed");
      expect(result.checks).toEqual([
        { id: "single-tarball", pass: false, detail: expect.stringContaining("no .tgz tarball") },
      ]);
      expect(tempMade).toBe(false);
    } finally {
      rmSync(tarballDir, { recursive: true, force: true });
    }
  });
});

describe("package lifecycle smoke — constants", () => {
  test("targets the frogprogsy package + frogp bin", () => {
    expect(PACKAGE_NAME).toBe("frogprogsy");
    expect(BIN_NAME).toBe("frogp");
  });
});
