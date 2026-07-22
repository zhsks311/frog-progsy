#!/usr/bin/env bun
/**
 * CI-only package lifecycle smoke: prove a freshly built `frogprogsy` tarball installs, boots, restores,
 * stops, restarts, and uninstalls end to end — against the REAL published bin — without ever touching the
 * developer's real home, Keychain, or the proxy already running on the default port.
 *
 * Real CI path (`bun scripts/package-lifecycle-smoke.ts --tarball-dir <download-dir>`):
 *  1. Resolve EXACTLY ONE `.tgz` from `--tarball-dir` (a build-once/upload/download artifact). Zero or
 *     more than one tarball is a hard error — the release gate must publish a single package.
 *  2. Mint a throwaway temp root and pin an ISOLATED environment: `BUN_INSTALL`, `FROGPROGSY_HOME`,
 *     `CLAUDE_HOME`, and `CLAUDE_CONFIG_DIR` all point inside it, and the temp global bin is prepended to
 *     `PATH`. `FROGP_EXTERNAL_SUPERVISOR` / `FROGP_DETACHED` are stripped so the default watchdog stays ON
 *     and a graceful `frogp stop` restores Claude Code routing.
 *  3. `bun add -g --ignore-scripts <tarball>` into the temp `BUN_INSTALL`, then run the temp global bin's
 *     real `frogp` for every lifecycle step (never the source checkout).
 *  4. Seed UNRELATED sentinel Claude Code settings (no `env`, no routed `model`) serialized the exact way
 *     the product writes settings, then drive: start -> /healthz -> explicit `restore` (settings must be
 *     byte-equivalent to the seed) -> stop -> restart -> stop (byte-equivalent again).
 *  5. `finally`: kill the temp home's `watchdog.pid` FIRST (so it can never resurrect the proxy), then
 *     `frogp.pid`, poll that both are dead AND the recorded port is unbound, then `bun remove -g` from the
 *     temp `BUN_INSTALL` and delete the temp root.
 *
 * Safety invariants:
 *  - The four isolation vars are always overridden to temp locations, so the real `~/.frogprogsy`,
 *    native `~/.claude`, and the developer's live proxy/config are never read or written.
 *  - `bun add -g` / `bun remove -g` run with the temp `BUN_INSTALL`, so the real global install is untouched.
 *  - No Keychain / `security` call is ever issued.
 *  - No raw environment, secret, or token is ever printed — only redacted booleans, coarse states, check
 *    ids, counts, and typed-error labels.
 *
 * The behavioural seams (command runner, detached spawner, health/port probes, pid readers, killer, temp
 * fs) exist so UNIT tests can exercise the tarball cardinality, temp env, temp bin resolution, restore
 * assertions, watchdog-before-proxy cleanup ordering, and port-unbound final invariant with fully faked
 * process/network I/O and NO real global install; production leaves every seam at its default.
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** Published package name (Bun global add/remove target). */
export const PACKAGE_NAME = "frogprogsy";
/** Executable the package installs into the global bin. */
export const BIN_NAME = "frogp";
/** The one tarball extension `bun pm pack` / release upload produces. */
export const TARBALL_EXT = ".tgz";

/** Path-free, count/status-only smoke error so a thrown message never leaks a home path or secret. */
export class PackageSmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageSmokeError";
  }
}

// ── tarball cardinality ──────────────────────────────────────────────────────────────────────

/** Case-insensitive `.tgz` entries, sorted for a stable "found N" message. */
export function listTarballs(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry.toLowerCase().endsWith(TARBALL_EXT)).sort();
}

/**
 * Resolve the SINGLE tarball in `dir` to an ABSOLUTE path; zero or many is a hard error (release must
 * publish exactly one). The path MUST be absolute: `--tarball-dir` may be relative (CI passes
 * `dist-tarball`), and `bun add -g` resolves a relative spec against the temp global install dir, not the
 * cwd, so a relative tarball would never be found.
 */
export function resolveSingleTarball(dir: string, entries: readonly string[]): string {
  const tarballs = listTarballs(entries);
  if (tarballs.length === 0) throw new PackageSmokeError(`no ${TARBALL_EXT} tarball found in --tarball-dir`);
  if (tarballs.length > 1) {
    throw new PackageSmokeError(`expected exactly one ${TARBALL_EXT} in --tarball-dir, found ${tarballs.length}`);
  }
  return resolve(dir, tarballs[0]!);
}

// ── cross-platform temp layout + bin resolution ──────────────────────────────────────────────

/** Global bin filename Bun installs for a platform (Windows carries the `.exe` suffix). */
export function binName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${BIN_NAME}.exe` : BIN_NAME;
}

export interface TempLayout {
  root: string;
  bunInstall: string;
  binDir: string;
  binPath: string;
  frogHome: string;
  claudeHome: string;
  frogpPidPath: string;
  watchdogPidPath: string;
  activePortPath: string;
  configPath: string;
  claudeSettingsPath: string;
}

/** Deterministic temp tree so a faked runner can locate the bin/pid/settings files it must simulate. */
export function planTempLayout(root: string, platform: NodeJS.Platform): TempLayout {
  const bunInstall = join(root, "bun-install");
  const binDir = join(bunInstall, "bin");
  const frogHome = join(root, "frogprogsy-home");
  const claudeHome = join(root, "claude-home");
  return {
    root,
    bunInstall,
    binDir,
    binPath: join(binDir, binName(platform)),
    frogHome,
    claudeHome,
    frogpPidPath: join(frogHome, "frogp.pid"),
    watchdogPidPath: join(frogHome, "watchdog.pid"),
    activePortPath: join(frogHome, "frogp.port"),
    configPath: join(frogHome, "config.json"),
    claudeSettingsPath: join(claudeHome, "settings.json"),
  };
}

/**
 * Isolated child env. Overrides `BUN_INSTALL` / `FROGPROGSY_HOME` / `CLAUDE_HOME` / `CLAUDE_CONFIG_DIR` to
 * the temp tree and prepends the temp global bin to `PATH` so a bare `frogp` resolves to the fresh install.
 * Strips supervisor/detached/test flags so the installed `frogp` runs as a REAL production process with the
 * default watchdog ON: `FROGP_EXTERNAL_SUPERVISOR` / `FROGP_DETACHED` (graceful stop must restore routing),
 * `FROGPROGSY_NO_CLAUDE_WRITES` and `NODE_ENV` (an inherited `=test`/no-writes would make the proxy skip the
 * Claude Code settings injection, leaving the restore assertion vacuous). Carries every other caller var
 * forward (the child needs them) but is NEVER logged.
 */
export function buildChildEnv(
  layout: TempLayout,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  let inheritedPath = "";
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    // Normalize any inherited PATH/Path casing into a single canonical PATH below.
    if (key.toLowerCase() === "path") {
      inheritedPath = value;
      continue;
    }
    env[key] = value;
  }
  env.BUN_INSTALL = layout.bunInstall;
  env.FROGPROGSY_HOME = layout.frogHome;
  env.CLAUDE_HOME = layout.claudeHome;
  env.CLAUDE_CONFIG_DIR = layout.claudeHome;
  env.PATH = inheritedPath ? `${layout.binDir}${delimiter}${inheritedPath}` : layout.binDir;
  delete env.FROGP_EXTERNAL_SUPERVISOR;
  delete env.FROGP_DETACHED;
  // Never let an inherited no-writes/test flag make injection a no-op (vacuous restore) or trip the
  // product's NODE_ENV=test write guards against the temp home.
  delete env.FROGPROGSY_NO_CLAUDE_WRITES;
  delete env.NODE_ENV;
  return env;
}

// ── restore assertion primitives ─────────────────────────────────────────────────────────────

/** Exact byte comparison — the restore contract is a byte-for-byte round-trip, not a semantic one. */
export function bytesEquivalent(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return bufA.equals(bufB);
}

/**
 * UNRELATED sentinel Claude Code settings: no `env` key and no routed `model`, so injection appends only a
 * gateway `env` block and restore must delete exactly that block — returning the file to these bytes.
 */
export const SENTINEL_SETTINGS_OBJECT = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  model: "sonnet",
  cleanupPeriodDays: 30,
  includeCoAuthoredBy: false,
  permissions: { allow: [] as string[], deny: [] as string[] },
} as const;

/** Serialize the sentinel EXACTLY how the product writes settings (`JSON.stringify(x, null, 2) + "\n"`). */
export function sentinelSettingsBytes(): string {
  return `${JSON.stringify(SENTINEL_SETTINGS_OBJECT, null, 2)}\n`;
}

// ── seams + deps ─────────────────────────────────────────────────────────────────────────────

export interface CommandOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  opts: { env: Record<string, string>; timeoutMs?: number },
) => CommandOutcome;

export interface DetachedHandle {
  pid: number | undefined;
  unref: () => void;
}

export type DetachedSpawner = (
  file: string,
  args: readonly string[],
  opts: { env: Record<string, string> },
) => DetachedHandle;

export interface PackageSmokeDeps {
  platform: NodeJS.Platform;
  tarballDir: string;
  baseEnv: Record<string, string | undefined>;

  // filesystem seams (default to the real fs; tests point them at an OS temp tree)
  readDir: (dir: string) => string[];
  makeTempRoot: () => string;
  ensureDir: (dir: string) => void;
  removeDir: (dir: string) => void;
  fileExists: (path: string) => boolean;
  readBytes: (path: string) => Buffer;
  writeBytes: (path: string, data: string | Buffer) => void;
  readIntFile: (path: string) => number | null;

  // process / network seams (faked in unit tests → no real global install, proxy, or ports)
  allocatePort: () => Promise<number>;
  run: CommandRunner;
  spawnDetached: DetachedSpawner;
  probeHealth: (port: number) => Promise<boolean>;
  portBound: (port: number) => Promise<boolean>;
  killPid: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;

  // bounded polling knobs
  healthTimeoutMs: number;
  killTimeoutMs: number;
  portTimeoutMs: number;
}

function defaultReadIntFile(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("failed to allocate a loopback port"))));
    });
    server.listen({ port: 0, host: "127.0.0.1" });
  });
}

/** A port is "bound" when a fresh loopback listen fails with EADDRINUSE; a clean listen means it is free. */
function defaultPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen({ port, host: "127.0.0.1" });
  });
}

async function defaultProbeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(750) });
    return res.ok;
  } catch {
    return false;
  }
}

function defaultKillPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    const args = signal === "SIGKILL" ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    return;
  }
  process.kill(pid, signal);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultRun(
  file: string,
  args: readonly string[],
  opts: { env: Record<string, string>; timeoutMs?: number },
): CommandOutcome {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    env: opts.env,
    timeout: opts.timeoutMs ?? 60_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function defaultSpawnDetached(
  file: string,
  args: readonly string[],
  opts: { env: Record<string, string> },
): DetachedHandle {
  // Launch through a short-lived Bun intermediary so the proxy is not a direct child of this smoke
  // process. Otherwise a synchronous `frogp stop` can observe the exited proxy as a zombie while this
  // parent is blocked in spawnSync, report failure, and only reap it after the stop command returns.
  const launcher = [
    'const { spawn } = require("node:child_process");',
    "const [file, ...args] = process.argv.slice(1);",
    'const child = spawn(file, args, { detached: true, stdio: "ignore", env: process.env, windowsHide: true });',
    "child.unref();",
    'process.stdout.write(String(child.pid ?? ""));',
  ].join("");
  const launched = spawnSync(process.execPath, ["-e", launcher, file, ...args], {
    encoding: "utf8",
    env: opts.env,
    timeout: 10_000,
    windowsHide: true,
  });
  const pid = Number.parseInt((launched.stdout ?? "").trim(), 10);
  if (launched.status !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new PackageSmokeError("detached proxy launcher failed");
  }
  return { pid, unref: () => {} };
}

export function resolvePackageSmokeDeps(overrides: Partial<PackageSmokeDeps> = {}): PackageSmokeDeps {
  return {
    platform: overrides.platform ?? process.platform,
    tarballDir: overrides.tarballDir ?? "",
    baseEnv: overrides.baseEnv ?? process.env,
    readDir: overrides.readDir ?? ((dir) => readdirSync(dir)),
    makeTempRoot: overrides.makeTempRoot ?? (() => mkdtempSync(join(tmpdir(), "frogp-pkg-smoke-"))),
    ensureDir: overrides.ensureDir ?? ((dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); }),
    removeDir: overrides.removeDir ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
    fileExists: overrides.fileExists ?? ((path) => existsSync(path)),
    readBytes: overrides.readBytes ?? ((path) => readFileSync(path)),
    writeBytes: overrides.writeBytes ?? ((path, data) => writeFileSync(path, data)),
    readIntFile: overrides.readIntFile ?? defaultReadIntFile,
    allocatePort: overrides.allocatePort ?? defaultAllocatePort,
    run: overrides.run ?? defaultRun,
    spawnDetached: overrides.spawnDetached ?? defaultSpawnDetached,
    probeHealth: overrides.probeHealth ?? defaultProbeHealth,
    portBound: overrides.portBound ?? defaultPortBound,
    killPid: overrides.killPid ?? defaultKillPid,
    isAlive: overrides.isAlive ?? defaultIsAlive,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? Date.now,
    log: overrides.log ?? ((line) => console.log(line)),
    healthTimeoutMs: overrides.healthTimeoutMs ?? 20_000,
    killTimeoutMs: overrides.killTimeoutMs ?? 8_000,
    portTimeoutMs: overrides.portTimeoutMs ?? 8_000,
  };
}

// ── result shapes ────────────────────────────────────────────────────────────────────────────

export interface SmokeCheck {
  id: string;
  pass: boolean;
  /** Redacted — never an env value, secret, token, or home path. */
  detail: string;
}

export interface CleanupOutcome {
  /** Ordered teardown timeline (kill-watchdog, kill-proxy, port-check, remove-package, config-preserved, remove-temp). */
  events: string[];
  watchdogKilled: boolean;
  proxyKilled: boolean;
  watchdogBeforeProxy: boolean;
  portUnbound: boolean;
  /** True only when it was safe to touch the package: watchdog + proxy dead AND the port free. */
  safeToRemove: boolean;
  packageRemoved: boolean;
  /** Config-preservation contract: the temp frog `config.json` survived the Bun package removal. */
  configPreserved: boolean;
  tempRemoved: boolean;
}

export interface PackageSmokeResult {
  outcome: "passed" | "failed";
  checks: SmokeCheck[];
  recordedPort: number | null;
  cleanup: CleanupOutcome;
}

function emptyCleanup(): CleanupOutcome {
  return {
    events: [],
    watchdogKilled: false,
    proxyKilled: false,
    watchdogBeforeProxy: true,
    portUnbound: false,
    safeToRemove: false,
    packageRemoved: false,
    configPreserved: false,
    tempRemoved: false,
  };
}

/** Redacted label for a caught error; PackageSmokeError messages are already path/secret-free. */
function errorLabel(err: unknown): string {
  if (err instanceof PackageSmokeError) return err.message;
  if (err instanceof Error) return err.name;
  return "non-error-throw";
}

async function waitUntil(
  deps: PackageSmokeDeps,
  timeoutMs: number,
  intervalMs: number,
  predicate: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(intervalMs);
  }
}

async function waitHealthy(deps: PackageSmokeDeps, port: number): Promise<boolean> {
  return waitUntil(deps, deps.healthTimeoutMs, 200, () => deps.probeHealth(port));
}

async function waitPortUnbound(deps: PackageSmokeDeps, port: number): Promise<boolean> {
  return waitUntil(deps, deps.portTimeoutMs, 100, async () => !(await deps.portBound(port)));
}

async function waitDead(deps: PackageSmokeDeps, pid: number): Promise<boolean> {
  return waitUntil(deps, deps.killTimeoutMs, 50, async () => !deps.isAlive(pid));
}

async function waitForLivePidFile(deps: PackageSmokeDeps, pidPath: string): Promise<boolean> {
  return waitUntil(deps, deps.healthTimeoutMs, 50, async () => {
    const pid = deps.readIntFile(pidPath);
    return pid !== null && deps.isAlive(pid);
  });
}

function startProxy(deps: PackageSmokeDeps, layout: TempLayout, childEnv: Record<string, string>, port: number): void {
  const handle = deps.spawnDetached(layout.binPath, ["start", "--port", String(port)], { env: childEnv });
  handle.unref();
}

/**
 * Kill the pid recorded in `pidPath` (SIGTERM, then SIGKILL if it lingers). Always records a `kill-<label>`
 * marker BEFORE acting so cleanup ordering is observable even when the pid file is already gone (a clean
 * graceful stop). Returns true when the target is dead (or was never there).
 */
async function killFromPidFile(
  deps: PackageSmokeDeps,
  pidPath: string,
  label: "watchdog" | "proxy",
  events: string[],
): Promise<boolean> {
  events.push(`kill-${label}`);
  const pid = deps.readIntFile(pidPath);
  if (pid === null || pid <= 0) return true;
  if (!deps.isAlive(pid)) return true;
  try {
    deps.killPid(pid, "SIGTERM");
  } catch {
    /* fall through to SIGKILL */
  }
  if (await waitDead(deps, pid)) return true;
  try {
    deps.killPid(pid, "SIGKILL");
  } catch {
    /* best-effort */
  }
  return waitDead(deps, pid);
}

/**
 * `finally` teardown. Order is load-bearing: the watchdog is killed FIRST so it can never resurrect the
 * proxy we are about to kill; only after BOTH are dead do we assert the recorded port is unbound; only then
 * do we `bun remove -g` from the temp `BUN_INSTALL` and delete the temp root. Every step is best-effort so a
 * single failure never masks the primary result — but each outcome is reported.
 */
export async function runCleanup(
  deps: PackageSmokeDeps,
  layout: TempLayout,
  childEnv: Record<string, string>,
  port: number | null,
): Promise<CleanupOutcome> {
  const events: string[] = [];

  const watchdogKilled = await killFromPidFile(deps, layout.watchdogPidPath, "watchdog", events);
  const proxyKilled = await killFromPidFile(deps, layout.frogpPidPath, "proxy", events);

  let portUnbound = true;
  if (port !== null) {
    events.push("port-check");
    portUnbound = await waitPortUnbound(deps, port);
  }

  // Never remove a package whose binary might still be executing, or delete the temp tree that holds
  // it: only proceed once the watchdog + proxy are dead AND the recorded port is free.
  const safeToRemove = watchdogKilled && proxyKilled && portUnbound;

  let packageRemoved = false;
  let configPreserved = false;
  let tempRemoved = false;
  if (safeToRemove) {
    try {
      events.push("remove-package");
      const removed = deps.run("bun", ["remove", "-g", PACKAGE_NAME], { env: childEnv, timeoutMs: 120_000 });
      packageRemoved = removed.status === 0;
    } catch {
      /* best-effort */
    }

    // Config-preservation contract: dropping the Bun package must NOT wipe the temp frog config.json.
    // Verify it survived BEFORE deleting the temp tree that contains it.
    events.push("config-preserved");
    configPreserved = deps.fileExists(layout.configPath);

    try {
      events.push("remove-temp");
      deps.removeDir(layout.root);
      tempRemoved = true;
    } catch {
      /* best-effort */
    }
  }

  const watchdogIndex = events.indexOf("kill-watchdog");
  const proxyIndex = events.indexOf("kill-proxy");
  const watchdogBeforeProxy = watchdogIndex !== -1 && proxyIndex !== -1 ? watchdogIndex < proxyIndex : true;

  return {
    events,
    watchdogKilled,
    proxyKilled,
    watchdogBeforeProxy,
    portUnbound,
    safeToRemove,
    packageRemoved,
    configPreserved,
    tempRemoved,
  };
}

// ── orchestrator ─────────────────────────────────────────────────────────────────────────────

/**
 * Drive the full install -> start -> health -> restore -> stop -> restart -> stop -> uninstall lifecycle
 * against the real temp-global `frogp`. Never throws for a lifecycle failure (records a failing check) and
 * ALWAYS runs cleanup in `finally`.
 */
export async function runPackageLifecycleSmoke(overrides: Partial<PackageSmokeDeps> = {}): Promise<PackageSmokeResult> {
  const deps = resolvePackageSmokeDeps(overrides);
  const checks: SmokeCheck[] = [];

  let tarball: string;
  try {
    tarball = resolveSingleTarball(deps.tarballDir, deps.readDir(deps.tarballDir));
  } catch (err) {
    const detail = errorLabel(err);
    deps.log(`package-lifecycle-smoke: ${detail}`);
    return {
      outcome: "failed",
      checks: [{ id: "single-tarball", pass: false, detail }],
      recordedPort: null,
      cleanup: emptyCleanup(),
    };
  }
  checks.push({ id: "single-tarball", pass: true, detail: "exactly one .tgz resolved in --tarball-dir" });

  const root = deps.makeTempRoot();
  const layout = planTempLayout(root, deps.platform);
  const childEnv = buildChildEnv(layout, deps.baseEnv);
  const seedBytes = sentinelSettingsBytes();

  let recordedPort: number | null = null;
  let cleanup = emptyCleanup();
  let hadError: string | null = null;

  try {
    deps.ensureDir(layout.bunInstall);
    deps.ensureDir(layout.binDir);
    deps.ensureDir(layout.frogHome);
    deps.ensureDir(layout.claudeHome);

    const isolatedEnv =
      childEnv.BUN_INSTALL === layout.bunInstall &&
      childEnv.FROGPROGSY_HOME === layout.frogHome &&
      childEnv.CLAUDE_HOME === layout.claudeHome &&
      childEnv.CLAUDE_CONFIG_DIR === layout.claudeHome &&
      childEnv.PATH.startsWith(layout.binDir) &&
      childEnv.FROGP_EXTERNAL_SUPERVISOR === undefined;
    checks.push({
      id: "isolated-env",
      pass: isolatedEnv,
      detail: "child env pins temp BUN_INSTALL/FROGPROGSY_HOME/CLAUDE_HOME/CLAUDE_CONFIG_DIR + temp bin on PATH",
    });

    const requestedPort = await deps.allocatePort();
    recordedPort = requestedPort;

    // Seed unrelated sentinel settings the product will inject into and must restore byte-for-byte.
    deps.writeBytes(layout.claudeSettingsPath, seedBytes);

    // ── install the provided tarball into the temp global install ────────────────────────────
    const install = deps.run("bun", ["add", "-g", "--ignore-scripts", tarball], { env: childEnv, timeoutMs: 180_000 });
    const installedBin = install.status === 0 && deps.fileExists(layout.binPath);
    checks.push({
      id: "global-install",
      pass: installedBin,
      detail: "bun add -g --ignore-scripts placed frogp in the temp global bin",
    });
    if (!installedBin) throw new PackageSmokeError(`install failed (status ${install.status ?? "unknown"})`);

    // ── start #1 + health ────────────────────────────────────────────────────────────────────
    startProxy(deps, layout, childEnv, requestedPort);
    const healthy = await waitHealthy(deps, requestedPort);
    checks.push({ id: "start-health", pass: healthy, detail: "proxy answered /healthz after first start" });
    if (!healthy) throw new PackageSmokeError("first start never became healthy");

    const activePort = deps.readIntFile(layout.activePortPath);
    const activePortMatches = activePort === requestedPort;
    checks.push({
      id: "start-active-port",
      pass: activePortMatches,
      detail: "first start recorded the exact requested loopback port",
    });
    if (!activePortMatches) throw new PackageSmokeError("first start active port did not match request");
    recordedPort = activePort;

    const watchdogStarted = await waitForLivePidFile(deps, layout.watchdogPidPath);
    checks.push({
      id: "start-watchdog",
      pass: watchdogStarted,
      detail: "default watchdog sidecar was live after first start",
    });
    if (!watchdogStarted) throw new PackageSmokeError("default watchdog did not start");

    // ── explicit restore (proxy still running) must be byte-equivalent to the seed ────────────
    const restore = deps.run(layout.binPath, ["restore"], { env: childEnv, timeoutMs: 60_000 });
    const afterRestore = deps.readBytes(layout.claudeSettingsPath);
    checks.push({
      id: "restore-byte-equivalent",
      pass: restore.status === 0 && bytesEquivalent(afterRestore, seedBytes),
      detail: "explicit restore returned settings.json to the seeded bytes",
    });

    // ── stop #1 ───────────────────────────────────────────────────────────────────────────────
    const stop1 = deps.run(layout.binPath, ["stop"], { env: childEnv, timeoutMs: 60_000 });
    checks.push({ id: "first-stop", pass: stop1.status === 0, detail: "first stop exited cleanly" });
    // The recorded port MUST actually free before we restart — otherwise the next health check could be
    // answered by the still-running old process and mask a broken stop as a successful restart.
    const firstStopPortFree = await waitPortUnbound(deps, recordedPort);
    checks.push({
      id: "first-stop-port-unbound",
      pass: firstStopPortFree,
      detail: "recorded port freed after first stop before restart",
    });
    if (!firstStopPortFree) {
      throw new PackageSmokeError("port still bound after first stop; refusing to trust restart health");
    }

    // ── restart + health ──────────────────────────────────────────────────────────────────────
    startProxy(deps, layout, childEnv, requestedPort);
    const healthyAgain = await waitHealthy(deps, requestedPort);
    checks.push({ id: "restart-health", pass: healthyAgain, detail: "proxy answered /healthz after restart" });
    if (!healthyAgain) throw new PackageSmokeError("restart never became healthy");

    const restartedPort = deps.readIntFile(layout.activePortPath);
    const restartedPortMatches = restartedPort === requestedPort;
    checks.push({
      id: "restart-active-port",
      pass: restartedPortMatches,
      detail: "restart recorded the exact requested loopback port",
    });
    if (!restartedPortMatches) throw new PackageSmokeError("restart active port did not match request");
    recordedPort = restartedPort;

    const watchdogRestarted = await waitForLivePidFile(deps, layout.watchdogPidPath);
    checks.push({
      id: "restart-watchdog",
      pass: watchdogRestarted,
      detail: "default watchdog sidecar was live after restart",
    });
    if (!watchdogRestarted) throw new PackageSmokeError("default watchdog did not restart");

    // ── stop #2 must also restore settings byte-for-byte ──────────────────────────────────────
    const stop2 = deps.run(layout.binPath, ["stop"], { env: childEnv, timeoutMs: 60_000 });
    const secondStopPortFree = await waitPortUnbound(deps, recordedPort);
    checks.push({
      id: "second-stop-port-unbound",
      pass: secondStopPortFree,
      detail: "recorded port freed after the final stop",
    });
    const afterStop = deps.readBytes(layout.claudeSettingsPath);
    checks.push({
      id: "stop-byte-equivalent",
      pass: stop2.status === 0 && secondStopPortFree && bytesEquivalent(afterStop, seedBytes),
      detail: "stop restored settings.json to the seeded bytes",
    });
  } catch (err) {
    hadError = errorLabel(err);
  } finally {
    cleanup = await runCleanup(deps, layout, childEnv, recordedPort);
  }

  if (hadError) checks.push({ id: "no-lifecycle-error", pass: false, detail: `lifecycle error: ${hadError}` });
  checks.push({
    id: "watchdog-before-proxy",
    pass: cleanup.watchdogBeforeProxy,
    detail: "cleanup sequenced watchdog handling before proxy handling",
  });
  checks.push({
    id: "port-unbound-final",
    pass: cleanup.portUnbound,
    detail: "recorded port was unbound after teardown",
  });
  checks.push({
    id: "package-removed",
    pass: cleanup.packageRemoved,
    detail: "bun remove -g dropped the temp global package",
  });
  checks.push({
    id: "config-preserved",
    pass: cleanup.configPreserved,
    detail: "temp frog config.json survived the package removal",
  });

  return {
    outcome: checks.every((check) => check.pass) ? "passed" : "failed",
    checks,
    recordedPort,
    cleanup,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

/** Parse the required `--tarball-dir <download-dir>` flag. Missing/misused is a usage error. */
export function parseTarballDir(argv: readonly string[]): string {
  const index = argv.indexOf("--tarball-dir");
  const value = index !== -1 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new PackageSmokeError("usage: package-lifecycle-smoke --tarball-dir <download-dir>");
  }
  return value;
}

export async function main(rawArgs: readonly string[] = process.argv.slice(2)): Promise<number> {
  let tarballDir: string;
  try {
    tarballDir = parseTarballDir(rawArgs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const result = await runPackageLifecycleSmoke({ tarballDir });
  console.log(`package-lifecycle-smoke: ${result.outcome}`);
  for (const check of result.checks) {
    console.log(`  [${check.pass ? "PASS" : "FAIL"}] ${check.id}: ${check.detail}`);
  }
  console.log(`  recorded port still bound after teardown: ${!result.cleanup.portUnbound}`);
  console.log(`  cleanup order: ${result.cleanup.events.join(" -> ") || "(none)"}`);
  console.log(`  temp tree removed: ${result.cleanup.tempRemoved}`);
  return result.outcome === "passed" ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`package-lifecycle-smoke fatal: ${errorLabel(err)}`);
      process.exit(2);
    });
}