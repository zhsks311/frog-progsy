/**
 * tests/watchdog.test.ts — unit tests for every pure function in src/watchdog.ts
 * No process spawning, no network, no OS notifications.
 */
import { describe, expect, test } from "bun:test";
import {
  decideCrashVsGraceful,
  markerFreshForPid,
  nextBackoffMs,
  parseEnvFlag,
  resolveWatchdogEnabled,
  shouldRestart,
  acquireWatchdogPidLock,
  WATCHDOG_DEFAULTS,
  type WatchdogState,
} from "../src/watchdog";
import type { ShutdownIntent } from "../src/config";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// parseEnvFlag — CX-1
// ---------------------------------------------------------------------------

describe("parseEnvFlag", () => {
  test.each(["1", "true", "yes", "on", "TRUE", "YES", "ON", " 1 ", " true "])(
    "returns true for %s",
    (v) => {
      expect(parseEnvFlag(v)).toBe(true);
    },
  );

  test.each(["", "0", "false", "no", "off", "FALSE", "NO", "OFF", undefined])(
    "returns false for %s",
    (v) => {
      expect(parseEnvFlag(v)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// resolveWatchdogEnabled — CX-1
// ---------------------------------------------------------------------------

describe("resolveWatchdogEnabled", () => {
  const cfg = (enabled?: boolean) => ({ watchdog: enabled === undefined ? undefined : { enabled } });

  test("default-ON when FROGP_NO_WATCHDOG unset and config absent", () => {
    expect(resolveWatchdogEnabled({}, {})).toBe(true);
  });

  test.each(["1", "true", "yes", "on"])(
    "FROGP_NO_WATCHDOG=%s → ENABLED=false",
    (v) => {
      expect(resolveWatchdogEnabled({}, { FROGP_NO_WATCHDOG: v })).toBe(false);
    },
  );

  test.each(["", "0", "false", "no", "off", undefined])(
    "FROGP_NO_WATCHDOG=%s → ENABLED=true (unset-ish values)",
    (v) => {
      expect(resolveWatchdogEnabled({}, { FROGP_NO_WATCHDOG: v })).toBe(true);
    },
  );

  test("config.watchdog.enabled=false → ENABLED=false regardless of env", () => {
    expect(resolveWatchdogEnabled(cfg(false), {})).toBe(false);
    expect(resolveWatchdogEnabled(cfg(false), { FROGP_NO_WATCHDOG: "0" })).toBe(false);
  });

  test("config.watchdog.enabled=true is respected", () => {
    expect(resolveWatchdogEnabled(cfg(true), {})).toBe(true);
  });

  test("FROGP_NO_WATCHDOG beats config.watchdog.enabled=true", () => {
    expect(resolveWatchdogEnabled(cfg(true), { FROGP_NO_WATCHDOG: "1" })).toBe(false);
  });

  // FROGP_EXTERNAL_SUPERVISOR auto-off rows (Docker/systemd/Kubernetes owns restart behavior)
  test("FROGP_EXTERNAL_SUPERVISOR=1 → ENABLED=false (external supervisor already active)", () => {
    expect(resolveWatchdogEnabled({}, { FROGP_EXTERNAL_SUPERVISOR: "1" })).toBe(false);
  });

  test.each(["true", "yes", "on"])(
    "FROGP_EXTERNAL_SUPERVISOR=%s → ENABLED=false",
    (v) => {
      expect(resolveWatchdogEnabled({}, { FROGP_EXTERNAL_SUPERVISOR: v })).toBe(false);
    },
  );

  test("FROGP_EXTERNAL_SUPERVISOR=0 → ENABLED=true (external supervisor not active)", () => {
    expect(resolveWatchdogEnabled({}, { FROGP_EXTERNAL_SUPERVISOR: "0" })).toBe(true);
  });

  test("FROGP_EXTERNAL_SUPERVISOR unset → ENABLED=true (no external supervisor)", () => {
    expect(resolveWatchdogEnabled({}, { FROGP_EXTERNAL_SUPERVISOR: undefined })).toBe(true);
  });

  test("FROGP_EXTERNAL_SUPERVISOR=1 beats config.watchdog.enabled=true", () => {
    expect(resolveWatchdogEnabled(cfg(true), { FROGP_EXTERNAL_SUPERVISOR: "1" })).toBe(false);
  });
  test("FROGP_DETACHED=1 keeps watchdog enabled", () => {
    expect(resolveWatchdogEnabled({}, { FROGP_DETACHED: "1" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markerFreshForPid — CX-4
// ---------------------------------------------------------------------------

describe("markerFreshForPid", () => {
  const now = Date.now();
  const fresh = (pid: number): ShutdownIntent => ({ pid, timestamp: now - 100 });
  const old = (pid: number): ShutdownIntent => ({ pid, timestamp: now - 10_000 });

  test("null marker → false", () => {
    expect(markerFreshForPid(null, 1234)).toBe(false);
  });

  test("null managedPid → false", () => {
    expect(markerFreshForPid(fresh(1234), null)).toBe(false);
  });

  test("pid mismatch → false", () => {
    expect(markerFreshForPid(fresh(1234), 9999)).toBe(false);
  });

  test("pid match, no TTL → true", () => {
    expect(markerFreshForPid(fresh(1234), 1234)).toBe(true);
  });

  test("pid match, within TTL → true", () => {
    expect(markerFreshForPid(fresh(1234), 1234, 5000)).toBe(true);
  });

  test("pid match, expired (timestamp older than ttlMs) → false", () => {
    expect(markerFreshForPid(old(1234), 1234, 5000)).toBe(false);
  });

  test("pid match, well within TTL → true", () => {
    // Use 3000ms age with 5000ms TTL to avoid race with Date.now() drift
    const marker: ShutdownIntent = { pid: 1234, timestamp: now - 3000 };
    expect(markerFreshForPid(marker, 1234, 5000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideCrashVsGraceful
// ---------------------------------------------------------------------------

describe("decideCrashVsGraceful", () => {
  test("healthzOk=true → ok (pidAlive irrelevant)", () => {
    expect(decideCrashVsGraceful({ healthzOk: true, markerFreshForPid: false, pidAlive: false })).toBe("ok");
    expect(decideCrashVsGraceful({ healthzOk: true, markerFreshForPid: true, pidAlive: true })).toBe("ok");
  });

  test("healthzOk=false, fresh marker → graceful", () => {
    expect(decideCrashVsGraceful({ healthzOk: false, markerFreshForPid: true, pidAlive: false })).toBe("graceful");
  });

  test("healthzOk=false, no fresh marker, pidAlive=false → crash", () => {
    expect(decideCrashVsGraceful({ healthzOk: false, markerFreshForPid: false, pidAlive: false })).toBe("crash");
  });

  test("healthzOk=false, no fresh marker, pidAlive=true → crash (pid reuse case)", () => {
    // pidAlive is advisory only — never upgrades a healthz-down to ok
    expect(decideCrashVsGraceful({ healthzOk: false, markerFreshForPid: false, pidAlive: true })).toBe("crash");
  });

  test("healthzOk=false, fresh marker, pidAlive=true → graceful", () => {
    expect(decideCrashVsGraceful({ healthzOk: false, markerFreshForPid: true, pidAlive: true })).toBe("graceful");
  });
});

// ---------------------------------------------------------------------------
// shouldRestart
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<WatchdogState> = {}): WatchdogState {
  return {
    attempts: 0,
    maxAttempts: WATCHDOG_DEFAULTS.maxAttempts,    // 2
    backoffMs: [...WATCHDOG_DEFAULTS.backoffMs],
    lastRestartAt: null,
    healthyWindowMs: WATCHDOG_DEFAULTS.healthyWindowMs,
    restartLog: [],
    rollingWindowMs: WATCHDOG_DEFAULTS.rollingWindowMs,
    maxPerWindow: WATCHDOG_DEFAULTS.maxPerWindow,  // 5
    ...overrides,
  };
}

describe("shouldRestart", () => {
  test("attempts=0 → true (can restart)", () => {
    expect(shouldRestart(makeState({ attempts: 0 }))).toBe(true);
  });

  test("attempts=1 → true", () => {
    expect(shouldRestart(makeState({ attempts: 1 }))).toBe(true);
  });

  test("burst: attempts=2 (=== maxAttempts) → false (give-up)", () => {
    expect(shouldRestart(makeState({ attempts: 2 }))).toBe(false);
  });

  test("burst: attempts=3 > maxAttempts → false", () => {
    expect(shouldRestart(makeState({ attempts: 3 }))).toBe(false);
  });

  test("rolling budget: 5 recent entries → false", () => {
    const now = Date.now();
    const restartLog = [now - 100, now - 200, now - 300, now - 400, now - 500];
    // attempts is 0 (reset after healthy window), but rolling log is full
    expect(shouldRestart(makeState({ attempts: 0, restartLog }))).toBe(false);
  });

  test("rolling budget: 4 recent entries → true (one more allowed)", () => {
    const now = Date.now();
    const restartLog = [now - 100, now - 200, now - 300, now - 400];
    expect(shouldRestart(makeState({ attempts: 0, restartLog }))).toBe(true);
  });

  test("old entries outside rollingWindowMs don't count toward budget", () => {
    const now = Date.now();
    // 5 old restarts outside the window (> 600s ago) — should NOT block
    const restartLog = [
      now - 700_000,
      now - 700_000,
      now - 700_000,
      now - 700_000,
      now - 700_000,
    ];
    expect(shouldRestart(makeState({ attempts: 0, restartLog }))).toBe(true);
  });

  test("slow-flap: burst resets (attempts=0) but restartLog persists → give-up after 5 total", () => {
    // Simulate: 5 restarts spread over time; burst was reset (attempts=0)
    // but the rolling log has 5 recent entries → give-up
    const now = Date.now();
    const restartLog = [
      now - 16_000,
      now - 32_000,
      now - 48_000,
      now - 64_000,
      now - 80_000,
    ]; // all within 600s window
    expect(shouldRestart(makeState({ attempts: 0, restartLog }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextBackoffMs (#1 timing)
// ---------------------------------------------------------------------------

describe("nextBackoffMs", () => {
  test("attempt 0 → 1000ms", () => {
    expect(nextBackoffMs(0)).toBe(1000);
  });

  test("attempt 1 → 5000ms", () => {
    expect(nextBackoffMs(1)).toBe(5000);
  });

  test("attempt 2 (beyond array) → 5000ms (clamped to last)", () => {
    expect(nextBackoffMs(2)).toBe(5000);
  });

  test("custom backoff array", () => {
    expect(nextBackoffMs(0, [2000, 8000])).toBe(2000);
    expect(nextBackoffMs(1, [2000, 8000])).toBe(8000);
    expect(nextBackoffMs(5, [2000, 8000])).toBe(8000);
  });

  test("empty array → returns 1000 (fallback)", () => {
    expect(nextBackoffMs(0, [])).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// acquireWatchdogPidLock — CX-3 singleton stale-lock
// ---------------------------------------------------------------------------

describe("acquireWatchdogPidLock (singleton stale-lock)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "frogp-watchdog-test-"));
  const pidFile = join(tmpDir, "watchdog.pid");

  const cleanup = () => {
    try { unlinkSync(pidFile); } catch { /* ignore */ }
  };

  test("creates lock file and returns true when no incumbent", () => {
    cleanup();
    const result = acquireWatchdogPidLock(pidFile, 99999, () => false);
    expect(result).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    cleanup();
  });

  test("stale lock (dead pid) → unlinks and acquires → returns true", () => {
    cleanup();
    // Write a dead pid manually
    writeFileSync(pidFile, "1", { encoding: "utf-8" }); // pid 1 may or may not exist; mock isAlive
    const isAlive = (pid: number) => false; // pretend all pids are dead
    const result = acquireWatchdogPidLock(pidFile, 99999, isAlive);
    expect(result).toBe(true);
    cleanup();
  });

  test("live incumbent → returns false (yields to existing watchdog)", () => {
    cleanup();
    writeFileSync(pidFile, "99888", { encoding: "utf-8" });
    const isAlive = (_pid: number) => true; // pretend all alive
    const result = acquireWatchdogPidLock(pidFile, 99999, isAlive);
    expect(result).toBe(false);
    cleanup();
  });
});
