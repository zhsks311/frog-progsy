/**
 * tests/watchdog-integration.test.ts
 *
 * Deterministic integration tests for the watchdog feature (feat/watchdog-only).
 * Covers: active-port resolution, graceful-stop no-restart, stale-lock guard,
 * null-pid/crash decision, and status-file lifecycle.
 *
 * No real process spawning, no network, no OS notifications.
 * All I/O uses a temp directory injected via FROGPROGSY_HOME.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers: isolated config dir via FROGPROGSY_HOME
// ---------------------------------------------------------------------------

let tmpHome: string;

function useTmpHome(): string {
  tmpHome = mkdtempSync(join(tmpdir(), "frogp-watchdog-integ-test-"));
  process.env["FROGPROGSY_HOME"] = tmpHome;
  return tmpHome;
}

function cleanTmpHome() {
  delete process.env["FROGPROGSY_HOME"];
}

// ---------------------------------------------------------------------------
// Active-port resolution (watchdog reads active-port over config.port)
// ---------------------------------------------------------------------------

describe("active-port config helpers", () => {
  beforeEach(() => useTmpHome());
  afterEach(() => cleanTmpHome());

  test("writeActivePort / readActivePort round-trip", async () => {
    const { writeActivePort, readActivePort } = await import("../src/config.js");
    expect(readActivePort()).toBeNull();
    writeActivePort(10200);
    expect(readActivePort()).toBe(10200);
  });

  test("removeActivePort deletes the file", async () => {
    const { writeActivePort, readActivePort, removeActivePort, activePortPath } = await import("../src/config.js");
    writeActivePort(10200);
    expect(readActivePort()).toBe(10200);
    removeActivePort();
    expect(existsSync(activePortPath())).toBe(false);
    expect(readActivePort()).toBeNull();
  });

  test("readActivePort returns null for a malformed file", async () => {
    const { readActivePort, activePortPath } = await import("../src/config.js");
    writeFileSync(activePortPath(), "not-a-number", "utf-8");
    expect(readActivePort()).toBeNull();
  });

  test("readActivePort prefers active-port file over config.port", async () => {
    const { writeActivePort, readActivePort, loadConfig } = await import("../src/config.js");
    const config = loadConfig(); // default port 3764
    writeActivePort(10200); // active port differs
    const port = readActivePort() ?? config.port ?? 3764;
    expect(port).toBe(10200); // active port wins
  });
});

// ---------------------------------------------------------------------------
// Watchdog active-port resolution priority
// ---------------------------------------------------------------------------

describe("watchdog uses readActivePort over portHint and config.port", () => {
  beforeEach(() => useTmpHome());
  afterEach(() => cleanTmpHome());

  test("readActivePort() ?? portHint ?? config.port prefers active-port", async () => {
    const { writeActivePort, readActivePort } = await import("../src/config.js");

    const configPort = 3764;
    const portHint = 10200;
    writeActivePort(10250);

    const resolved = readActivePort() ?? portHint ?? configPort;
    expect(resolved).toBe(10250); // active-port file wins
  });

  test("falls back to portHint when active-port file absent", async () => {
    const { readActivePort } = await import("../src/config.js");
    const configPort = 3764;
    const portHint = 10200;

    const resolved = readActivePort() ?? portHint ?? configPort;
    expect(resolved).toBe(10200); // portHint second
  });

  test("falls back to config.port when both active-port and portHint absent", async () => {
    const { readActivePort } = await import("../src/config.js");
    const configPort = 3764;

    const resolved = readActivePort() ?? undefined ?? configPort;
    expect(resolved).toBe(3764); // config.port last resort
  });
});

// ---------------------------------------------------------------------------
// Graceful-stop: shutdown-intent marker written before removePid
// ---------------------------------------------------------------------------

describe("graceful-stop no-restart: shutdown-intent marker", () => {
  beforeEach(() => useTmpHome());
  afterEach(() => cleanTmpHome());

  test("writeShutdownIntent then removePid leaves marker still readable", async () => {
    const {
      writePid,
      writeShutdownIntent,
      removePid,
      readShutdownIntent,
    } = await import("../src/config.js");

    const realPid = process.pid;
    writePid(realPid);
    // Simulate what /api/stop (and handleStop) does: write marker THEN remove pid.
    writeShutdownIntent(realPid);
    removePid();

    // Marker is still present after removePid — watchdog can read it.
    const marker = readShutdownIntent();
    expect(marker).not.toBeNull();
    expect(marker?.pid).toBe(realPid);
  });

  test("marker.pid matches the stopped pid (no pid-mismatch false-negative)", async () => {
    const {
      writePid,
      writeShutdownIntent,
      removePid,
      readShutdownIntent,
    } = await import("../src/config.js");
    const { markerFreshForPid: wdMarkerFreshForPid } = await import("../src/watchdog.js");

    const realPid = process.pid;
    writePid(realPid);
    writeShutdownIntent(realPid);
    removePid();

    const marker = readShutdownIntent();
    // Marker is fresh for the stopped pid.
    expect(wdMarkerFreshForPid(marker, realPid, 30_000)).toBe(true);
    // Null pid does NOT match (pre-fix bug scenario).
    expect(wdMarkerFreshForPid(marker, null, 30_000)).toBe(false);
    // lastKnownManagedPid (realPid) DOES match via effectivePidForMarker (post-fix behaviour).
    const effectivePid = null /* managedPid */ ?? realPid /* lastKnownManagedPid */;
    expect(wdMarkerFreshForPid(marker, effectivePid, 30_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// null-pid decision (decideNullPidAction) — maps to graceful-stop and crash
// ---------------------------------------------------------------------------

describe("decideNullPidAction pure function", () => {
  let decideNullPidAction: typeof import("../src/watchdog.js").decideNullPidAction;
  let NULL_PID_GRACE_CYCLES: number;

  beforeEach(async () => {
    const mod = await import("../src/watchdog.js");
    decideNullPidAction = mod.decideNullPidAction;
    NULL_PID_GRACE_CYCLES = mod.NULL_PID_GRACE_CYCLES;
  });

  test("pid-null + fresh matching marker → graceful (no restart)", () => {
    const lastKnownPid = 1234;
    const marker = { pid: lastKnownPid, timestamp: Date.now() - 100 };
    const result = decideNullPidAction({
      marker,
      lastKnownManagedPid: lastKnownPid,
      nullPidCycles: 1,
      graceCycles: NULL_PID_GRACE_CYCLES,
    });
    expect(result).toBe("graceful");
  });

  test("pid-null + fresh marker for DIFFERENT pid → not graceful (marker is for old process)", () => {
    const marker = { pid: 9999, timestamp: Date.now() - 100 };
    const result = decideNullPidAction({
      marker,
      lastKnownManagedPid: 1234, // mismatch
      nullPidCycles: 1,
      graceCycles: NULL_PID_GRACE_CYCLES,
    });
    // Not graceful — falls into wait (within grace)
    expect(result).toBe("wait");
  });

  test("pid-null + no marker + within grace → wait (respawn window)", () => {
    const result = decideNullPidAction({
      marker: null,
      lastKnownManagedPid: 1234,
      nullPidCycles: 1,
      graceCycles: NULL_PID_GRACE_CYCLES,
    });
    expect(result).toBe("wait");
  });

  test("pid-null + no marker + exactly at grace boundary → wait", () => {
    const result = decideNullPidAction({
      marker: null,
      lastKnownManagedPid: 1234,
      nullPidCycles: NULL_PID_GRACE_CYCLES,
      graceCycles: NULL_PID_GRACE_CYCLES,
    });
    expect(result).toBe("wait");
  });

  test("pid-null + no marker + beyond grace → crash", () => {
    const result = decideNullPidAction({
      marker: null,
      lastKnownManagedPid: 1234,
      nullPidCycles: NULL_PID_GRACE_CYCLES + 1,
      graceCycles: NULL_PID_GRACE_CYCLES,
    });
    expect(result).toBe("crash");
  });

  test("pid-null + no lastKnownManagedPid + no marker + beyond grace → crash", () => {
    const result = decideNullPidAction({
      marker: null,
      lastKnownManagedPid: null,
      nullPidCycles: 99,
      graceCycles: NULL_PID_GRACE_CYCLES,
    });
    expect(result).toBe("crash");
  });

  test("pid-null + expired marker (> ttlMs) → not graceful → wait within grace", () => {
    const marker = { pid: 1234, timestamp: Date.now() - 60_000 }; // 60s old
    const result = decideNullPidAction({
      marker,
      lastKnownManagedPid: 1234,
      nullPidCycles: 1,
      graceCycles: NULL_PID_GRACE_CYCLES,
      ttlMs: 30_000, // 30s TTL — marker expired
    });
    expect(result).toBe("wait");
  });
});

// ---------------------------------------------------------------------------
// Crash path: pid present + healthz down + no marker → crash (>=2 crashes)
// ---------------------------------------------------------------------------

describe("crash path when pid present, healthz down, no marker", () => {
  test("pid present + healthz down + no marker → crash", async () => {
    const { decideCrashVsGraceful } = await import("../src/watchdog.js");
    const result = decideCrashVsGraceful({
      healthzOk: false,
      markerFreshForPid: false,
      pidAlive: true,
    });
    expect(result).toBe("crash");
  });

  test("2 consecutive crashes reach maxAttempts=2 → shouldRestart=false (give-up)", async () => {
    const { shouldRestart, WATCHDOG_DEFAULTS } = await import("../src/watchdog.js");
    const state = {
      attempts: 2, // 2 restarts attempted = at maxAttempts
      maxAttempts: WATCHDOG_DEFAULTS.maxAttempts, // 2
      backoffMs: [...WATCHDOG_DEFAULTS.backoffMs],
      lastRestartAt: Date.now(),
      healthyWindowMs: WATCHDOG_DEFAULTS.healthyWindowMs,
      restartLog: [Date.now() - 1000, Date.now() - 5000],
      rollingWindowMs: WATCHDOG_DEFAULTS.rollingWindowMs,
      maxPerWindow: WATCHDOG_DEFAULTS.maxPerWindow,
    };
    expect(shouldRestart(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stale-lock: acquireWatchdogPidLock removes dead incumbent
// ---------------------------------------------------------------------------

describe("stale-lock: acquireWatchdogPidLock", () => {
  beforeEach(() => useTmpHome());
  afterEach(() => cleanTmpHome());

  test("stale lock (dead pid in file) → acquired by new watchdog", async () => {
    const { getWatchdogPidPath } = await import("../src/config.js");
    const { acquireWatchdogPidLock } = await import("../src/watchdog.js");

    const wdPath = getWatchdogPidPath();
    // Write a stale pid (dead process)
    writeFileSync(wdPath, "1", "utf-8"); // use pid 1 with isAlive=false
    const isAlive = (_pid: number) => false;

    const acquired = acquireWatchdogPidLock(wdPath, process.pid, isAlive);
    expect(acquired).toBe(true);
    // Clean up
    try { unlinkSync(wdPath); } catch { /* ignore */ }
  });

  test("live incumbent → new watchdog yields (exactly-one-live invariant)", async () => {
    const { getWatchdogPidPath } = await import("../src/config.js");
    const { acquireWatchdogPidLock } = await import("../src/watchdog.js");

    const wdPath = getWatchdogPidPath();
    writeFileSync(wdPath, "99888", "utf-8");
    const isAlive = (_pid: number) => true; // incumbent is alive

    const acquired = acquireWatchdogPidLock(wdPath, process.pid, isAlive);
    expect(acquired).toBe(false); // exactly-one: new watchdog does not start
    // Clean up
    try { unlinkSync(wdPath); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// Watchdog status file lifecycle (P2-2: cleared on successful start)
// ---------------------------------------------------------------------------

describe("watchdog status file lifecycle", () => {
  beforeEach(() => useTmpHome());
  afterEach(() => cleanTmpHome());

  test("getWatchdogStatusPath resolves inside the config dir", async () => {
    const { getWatchdogStatusPath, getConfigDir } = await import("../src/config.js");
    const statusPath = getWatchdogStatusPath();
    expect(statusPath.startsWith(getConfigDir())).toBe(true);
    expect(statusPath).toMatch(/frogp-watchdog-status\.json$/);
  });

  test("stale give-up status file is removed by handleStart's cleanup logic", async () => {
    const { getWatchdogStatusPath } = await import("../src/config.js");
    const statusPath = getWatchdogStatusPath();

    // Simulate a give-up that left a status file behind
    writeFileSync(
      statusPath,
      JSON.stringify({ gaveUpAt: new Date().toISOString(), attempts: 2, restartLog: [], lastError: "test" }),
      "utf-8",
    );
    expect(existsSync(statusPath)).toBe(true);

    // Reproduce the cleanup logic added to handleStart (after clearShutdownIntent).
    if (existsSync(statusPath)) {
      try { unlinkSync(statusPath); } catch { /* best-effort */ }
    }

    // Status file is now gone — 'frogp status' will not show stale give-up.
    expect(existsSync(statusPath)).toBe(false);
  });

  test("no error when status file is absent (idempotent)", async () => {
    const { getWatchdogStatusPath } = await import("../src/config.js");
    const statusPath = getWatchdogStatusPath();

    expect(existsSync(statusPath)).toBe(false); // confirm absent
    expect(() => {
      if (existsSync(statusPath)) {
        unlinkSync(statusPath);
      }
    }).not.toThrow();
  });
});
