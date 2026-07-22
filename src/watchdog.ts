/**
 * src/watchdog.ts — sole-supervisor watchdog sidecar (Work Item C)
 *
 * Pure decision functions are at the top and unit-tested without spawning.
 * The impure runWatchdog() is at the bottom.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { FrogConfig } from "./types";
import type { ShutdownIntent } from "./config";
import {
  DEFAULT_PORT,
  getWatchdogPidPath,
  getWatchdogStatusPath,
  loadConfig,
  readActivePort,
  readPid,
  readShutdownIntent,
  atomicWriteFile,
  assertSafeConfigDirWrite,
} from "./config";
import { GIVE_UP_MESSAGE, GIVE_UP_TITLE, notify } from "./notify";

// ---------------------------------------------------------------------------
// Default timing constants (plan §C #1)
// ---------------------------------------------------------------------------

export const WATCHDOG_DEFAULTS = {
  maxAttempts: 2,
  backoffMs: [1000, 5000] as number[],
  healthyWindowMs: 15_000,
  pollIntervalMs: 2_000,
  maxPerWindow: 5,
  rollingWindowMs: 600_000,
} as const;

// ---------------------------------------------------------------------------
// Pure functions — unit-testable without spawning or I/O
// ---------------------------------------------------------------------------

/**
 * Parse an environment-variable flag value to a boolean.
 * TRUE  for "1" | "true" | "yes" | "on" (case-insensitive, trimmed).
 * FALSE for "" | "0" | "false" | "no" | "off" | undefined (or any other value).
 *
 * CX-1: the resolved ENABLED boolean is derived from this; callers must never
 * compare the raw env string to "ON"/"OFF" — they check the resolved boolean.
 */
export function parseEnvFlag(v?: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

/**
 * Resolve whether the watchdog is ENABLED.
 * Returns true (enabled) when:
 *   - FROGP_EXTERNAL_SUPERVISOR is NOT set (watchdog auto-off when an external supervisor already owns restart behavior), AND
 *   - FROGP_NO_WATCHDOG is NOT set to a truthy flag value, AND
 *   - config.watchdog?.enabled is not explicitly false.
 * Default is ON when all are unset.
 */
export function resolveWatchdogEnabled(
  config: Pick<FrogConfig, "watchdog">,
  env: Record<string, string | undefined>,
): boolean {
  return (
    !parseEnvFlag(env["FROGP_EXTERNAL_SUPERVISOR"]) &&
    !parseEnvFlag(env["FROGP_NO_WATCHDOG"]) &&
    config.watchdog?.enabled !== false
  );
}

/**
 * Returns true iff the shutdown-intent marker is valid for the given managedPid.
 * Conditions (all must hold):
 *   1. marker is not null
 *   2. marker.pid === managedPid
 *   3. If ttlMs is given: now - marker.timestamp <= ttlMs (not expired)
 *
 * CX-4: a stale marker (pid mismatch OR expired) yields false → treated as CRASH.
 */
export function markerFreshForPid(
  marker: ShutdownIntent | null,
  managedPid: number | null,
  ttlMs?: number,
): boolean {
  if (marker === null || managedPid === null) return false;
  if (marker.pid !== managedPid) return false;
  if (ttlMs !== undefined && Date.now() - marker.timestamp > ttlMs) return false;
  return true;
}

/**
 * Classify the watchdog's current observation.
 * /healthz is the primary signal (least spoofable):
 *   - ok       — proxy is healthy (/healthz returned 2xx)
 *   - graceful — /healthz down BUT a fresh pid-bound shutdown-intent marker exists
 *   - crash    — /healthz down AND no fresh marker (also covers pid-reuse case)
 *
 * pidAlive is advisory only and NEVER upgrades a healthz-down state to "ok".
 */
export function decideCrashVsGraceful(input: {
  healthzOk: boolean;
  markerFreshForPid: boolean;
  pidAlive: boolean;
}): "ok" | "graceful" | "crash" {
  if (input.healthzOk) return "ok";
  if (input.markerFreshForPid) return "graceful";
  return "crash";
}


// Default number of null-pid poll cycles to tolerate before treating absence as crash.
// This prevents the watchdog fighting its own respawn (brief window between proxy dying
// and the newly spawned proxy writing its pid file).
export const NULL_PID_GRACE_CYCLES = 2;

/**
 * Pure decision for when managedPid is null (pid file absent or process dead).
 *
 * Returns:
 *   "graceful" — a fresh shutdown-intent marker exists for lastKnownManagedPid.
 *                Watchdog should exit cleanly without restarting.
 *   "wait"     — within grace window (pid may reappear after a self-respawn).
 *                Watchdog should skip this poll cycle without restarting.
 *   "crash"    — grace expired, no fresh marker. Escalate to crash handling.
 */
export function decideNullPidAction(input: {
  marker: ShutdownIntent | null;
  lastKnownManagedPid: number | null;
  nullPidCycles: number;
  graceCycles: number;
  ttlMs?: number;
}): "graceful" | "wait" | "crash" {
  if (markerFreshForPid(input.marker, input.lastKnownManagedPid, input.ttlMs)) {
    return "graceful";
  }
  if (input.nullPidCycles <= input.graceCycles) {
    return "wait";
  }
  return "crash";
}

export interface WatchdogState {
  /** Consecutive crash-restart attempts in the current burst (resets after healthyWindowMs). */
  attempts: number;
  maxAttempts: number;
  backoffMs: number[];
  /** Timestamp of the last restart, or null if none yet. */
  lastRestartAt: number | null;
  /** Duration (ms) of continuous health that resets the burst counter. */
  healthyWindowMs: number;
  /**
   * Timestamp log of every restart across ALL bursts.
   * Persists through burst resets so a slow flap hits give-up via rolling budget.
   */
  restartLog: number[];
  rollingWindowMs: number;
  maxPerWindow: number;
}

/**
 * Pure decision: should the watchdog attempt another restart?
 * Returns false (give-up) when:
 *   - burst attempts >= maxAttempts, OR
 *   - count of restartLog entries within rollingWindowMs >= maxPerWindow
 */
export function shouldRestart(state: WatchdogState): boolean {
  if (state.attempts >= state.maxAttempts) return false;
  const now = Date.now();
  const recent = state.restartLog.filter(t => now - t <= state.rollingWindowMs);
  if (recent.length >= state.maxPerWindow) return false;
  return true;
}

/**
 * Return the backoff delay for a given (0-indexed) attempt number.
 * Uses the backoffMs array; clamps to the last entry if attempt exceeds the array length.
 */
export function nextBackoffMs(attempt: number, backoffMs: number[] = WATCHDOG_DEFAULTS.backoffMs): number {
  if (backoffMs.length === 0) return 1000;
  return backoffMs[Math.min(attempt, backoffMs.length - 1)];
}

// ---------------------------------------------------------------------------
// Singleton guard — CX-3
// ---------------------------------------------------------------------------

/**
 * Acquire the watchdog.pid singleton lock.
 * Uses { flag: "wx" } (exclusive create) to prevent duplicate watchdogs.
 *
 * Stale-safe:
 *   - EEXIST + alive  → another live watchdog exists → caller should exit (return false)
 *   - EEXIST + dead   → stale lock from a crashed watchdog → unlink + retry wx once
 *     - retry EEXIST  → lost the race to another starter → caller should exit (return false)
 *   - success         → we now own the lock (return true)
 */
export function acquireWatchdogPidLock(
  watchdogPidPath: string,
  selfPid: number,
  isAlive: (pid: number) => boolean,
): boolean {
  const tryCreate = (): boolean => {
    try {
      writeFileSync(watchdogPidPath, String(selfPid), { flag: "wx", encoding: "utf-8" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    }
  };

  if (tryCreate()) return true;

  // EEXIST — inspect the incumbent
  let incumbentPid: number | null = null;
  try {
    const raw = readFileSync(watchdogPidPath, "utf-8").trim();
    const n = parseInt(raw, 10);
    if (!isNaN(n)) incumbentPid = n;
  } catch {
    /* ignore — file may have disappeared */
  }

  if (incumbentPid !== null && isAlive(incumbentPid)) {
    // A real live watchdog holds the lock → yield
    return false;
  }

  // Dead incumbent — unlink the stale lock and retry once
  try {
    unlinkSync(watchdogPidPath);
  } catch {
    /* file may already be gone — proceed to retry */
  }

  // Retry: if this also fails (lost race to another starter) → yield
  return tryCreate();
}

// ---------------------------------------------------------------------------
// Impure loop
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

async function probeHealthz(port: number, hostname?: string): Promise<boolean> {
  const host =
    !hostname || hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Impure watchdog supervision loop.
 *
 * Behavior (sole-supervisor model):
 *   1. Acquire watchdog.pid singleton lock; exit immediately if another live watchdog holds it.
 *   2. Each poll:
 *      - re-read managedPid = readPid() (MUTABLE — tracks new proxy pid after respawn)
 *      - re-read live config.port
 *      - probe GET /healthz
 *      - decideCrashVsGraceful
 *   3. 'ok' → if healthy window elapsed, reset burst counter.
 *   4. 'graceful' OR parent process gone with a fresh matching marker → clean self-exit.
 *   5. 'crash' + shouldRestart → respawn `frogp start` with FROGP_NO_WATCHDOG=1,
 *      record the restart, wait backoff, continue (NEVER exits for own respawn).
 *   6. 'crash' + !shouldRestart → give-up: write status file + notify() once +
 *      remove watchdog.pid + process.exit.
 */
export async function runWatchdog(opts: {
  parentPidHint?: number;
  portHint?: number;
}): Promise<void> {
  assertSafeConfigDirWrite("write watchdog pid");
  const watchdogPidPath = getWatchdogPidPath();
  const selfPid = process.pid;

  const acquired = acquireWatchdogPidLock(watchdogPidPath, selfPid, isProcessAlive);
  if (!acquired) {
    // Another live watchdog is already running — exit silently
    process.exit(0);
  }

  assertSafeConfigDirWrite("remove watchdog pid");
  const removeSelfPid = () => {
    try { unlinkSync(watchdogPidPath); } catch { /* ignore */ }
  };

  // Clean up on unexpected signals
  process.on("SIGTERM", () => { removeSelfPid(); process.exit(0); });
  process.on("SIGINT", () => { removeSelfPid(); process.exit(0); });

  const config = loadConfig();
  const maxAttempts = config.watchdog?.maxAttempts ?? WATCHDOG_DEFAULTS.maxAttempts;
  const backoffMs = config.watchdog?.backoffMs ?? WATCHDOG_DEFAULTS.backoffMs;
  const healthyWindowMs = config.watchdog?.healthyWindowMs ?? WATCHDOG_DEFAULTS.healthyWindowMs;
  const pollIntervalMs = config.watchdog?.pollIntervalMs ?? WATCHDOG_DEFAULTS.pollIntervalMs;
  const maxPerWindow = config.watchdog?.maxPerWindow ?? WATCHDOG_DEFAULTS.maxPerWindow;
  const rollingWindowMs = config.watchdog?.rollingWindowMs ?? WATCHDOG_DEFAULTS.rollingWindowMs;
  const markerTtlMs = config.watchdog?.markerTtlMs;

  const state: WatchdogState = {
    attempts: 0,
    maxAttempts,
    backoffMs,
    lastRestartAt: null,
    healthyWindowMs,
    restartLog: [],
    rollingWindowMs,
    maxPerWindow,
  };

  let firstHealthyAt: number | null = null;
  let lastError: string | undefined;
  /** Last non-null managedPid seen; seeded from the supervised parent so an immediate stop
   *  before the first poll is still recognized as graceful. */
  let lastKnownManagedPid: number | null = opts.parentPidHint ?? null;
  /** Consecutive poll cycles where readPid() returned null. */
  let nullPidCycles = 0;

  // Give-up helper — write status file, notify, clean up, exit.
  const giveUp = () => {
    const statusPath = getWatchdogStatusPath();
    assertSafeConfigDirWrite("write watchdog status");
    try {
      atomicWriteFile(
        statusPath,
        JSON.stringify(
          {
            gaveUpAt: new Date().toISOString(),
            attempts: state.attempts,
            restartLog: state.restartLog,
            lastError,
          },
          null,
          2,
        ) + "\n",
      );
    } catch { /* best-effort */ }
    notify(GIVE_UP_TITLE, GIVE_UP_MESSAGE);
    removeSelfPid();
    process.exit(0);
  };

  // Respawn the proxy with FROGP_NO_WATCHDOG=1 so it does NOT arm a second watchdog.
  // Preserve FROGP_DETACHED from `frogp refresh`, but clear FROGP_EXTERNAL_SUPERVISOR because only
  // a real external supervisor should suppress watchdog supervision.
  const respawnProxy = () => {
    const child = spawn(process.execPath, [process.argv[1], "start"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FROGP_NO_WATCHDOG: "1", FROGP_EXTERNAL_SUPERVISOR: undefined } as NodeJS.ProcessEnv,
    });
    child.unref();
  };

  // Main poll loop
  while (true) {
    await sleep(pollIntervalMs);

    // Re-read mutable state each poll
    const managedPid = readPid();

    // Track the last non-null pid so we can match shutdown-intent markers even after
    // the pid file has been removed (handleStop removes pid AFTER killing the process).
    if (managedPid !== null) {
      lastKnownManagedPid = managedPid;
      nullPidCycles = 0;
    } else {
      nullPidCycles++;
    }

    const liveConfig = loadConfig();
    // Prefer the active-port file (written by handleStart) over config.port so respawns on
    // a new port are tracked correctly (Fix 5+6).
    const port = readActivePort() ?? opts.portHint ?? liveConfig.port ?? DEFAULT_PORT;
    const hostname = liveConfig.hostname;

    const healthzOk = await probeHealthz(port, hostname);
    const marker = readShutdownIntent();

    // When pid is null (file gone or process dead), check marker against lastKnownManagedPid
    // rather than null — otherwise markerFreshForPid always returns false for a graceful stop.
    const effectivePidForMarker = managedPid ?? lastKnownManagedPid;
    const freshMarker = markerFreshForPid(marker, effectivePidForMarker, markerTtlMs);
    const pidAlive = managedPid !== null ? isProcessAlive(managedPid) : false;

    // pid gone — delegate entirely to the pure decision function (single source of truth).
    // decideNullPidAction uses lastKnownManagedPid (not null) to match the shutdown-intent
    // marker, which is correct: handleStop removes the pid file after killing the process.
    if (managedPid === null) {
      const nullAction = decideNullPidAction({
        marker,
        lastKnownManagedPid,
        nullPidCycles,
        graceCycles: NULL_PID_GRACE_CYCLES,
        ttlMs: markerTtlMs,
      });
      if (nullAction === "graceful") {
        removeSelfPid();
        process.exit(0);
      }
      if (nullAction === "wait") {
        firstHealthyAt = null;
        continue;
      }
      // nullAction === "crash" — fall through; pid absent is definitively a crash
      // regardless of healthzOk (skip decideCrashVsGraceful for this branch).
    }

    // Check if parent process is gone (parent-gone + fresh marker = graceful)
    const parentGone =
      opts.parentPidHint !== undefined && !isProcessAlive(opts.parentPidHint);

    // When pid was present, use decideCrashVsGraceful; when we fell through from the
    // null-pid crash branch above, the decision is already known to be "crash".
    const decision = managedPid !== null
      ? decideCrashVsGraceful({ healthzOk, markerFreshForPid: freshMarker, pidAlive })
      : "crash";

    if (decision === "ok") {
      if (firstHealthyAt === null) firstHealthyAt = Date.now();
      // Reset burst counter after a sustained healthy window
      if (state.attempts > 0 && Date.now() - firstHealthyAt >= healthyWindowMs) {
        state.attempts = 0;
        firstHealthyAt = null;
        // restartLog intentionally persists for rolling budget
      }
      continue;
    }

    // Reset healthy timer on any non-ok poll
    firstHealthyAt = null;

    if (decision === "graceful" || (parentGone && freshMarker)) {
      // Intentional shutdown detected — exit cleanly without respawning
      removeSelfPid();
      process.exit(0);
    }

    // decision === "crash"
    lastError = `healthz-down at ${new Date().toISOString()} managedPid=${managedPid ?? "none"} pidAlive=${pidAlive}`;

    if (!shouldRestart(state)) {
      giveUp();
      return; // unreachable — giveUp calls process.exit
    }

    // Respawn and continue supervising (sole-supervisor: W NEVER exits for its own respawn)
    const backoff = nextBackoffMs(state.attempts, backoffMs);
    state.attempts++;
    state.restartLog.push(Date.now());
    state.lastRestartAt = Date.now();

    respawnProxy();

    // Wait backoff before next poll (during which the new proxy should start up)
    await sleep(backoff);
  }
}
