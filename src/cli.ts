#!/usr/bin/env bun
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { suggestClosest } from "./cli-suggest";
import { dim, error as errorText, shouldColor, success, warn } from "./cli-color";
import { restoreNativeClaudeCode } from "./claude-inject";
import { reapplyEnrolledClaudeProjects, restoreManagedClaudeRouting } from "./claude-routing-lifecycle";
import {
  clearShutdownIntent,
  DEFAULT_PORT,
  assertSafeConfigDirWrite,
  getConfigDir,
  getWatchdogStatusPath,
  loadConfig,
  readPid,
  readActivePort,
  removeActivePort,
  removePid,
  saveConfig,
  writePid,
  writeActivePort,
  writeShutdownIntent,
} from "./config";
import { findAvailablePort } from "./ports";
import { startServer } from "./server";
import { maybeShowStarPrompt } from "./star-prompt";
import { parseEnvFlag, resolveWatchdogEnabled } from "./watchdog";
import { injectClaudeSettingsWithRetry } from "./inject-retry";
import { findGuiDistFromModuleDir, formatGuiBuildWarning, resolveGuiBuildIdentity } from "./build-identity";
import {
  addClaudeProfile,
  ensureClaudeProfiles,
  managedClaudeProfiles,
  listClaudeProfiles,
  markClaudeProfileInjected,
  removeClaudeProfile,
  renameClaudeProfile,
  resolveClaudeProfile,
} from "./claude-profiles";
import {
  addClaudeProject,
  clearClaudeProjectsForRoutingProfile,
  findClaudeProjectsForRoutingProfile,
  getClaudeProjectGitProtection,
  listClaudeProjects,
  markClaudeProjectEnrolled,
  resolveClaudeProject,
} from "./claude-projects";
import { claudeLauncherBinDir, findRealClaudeExecutable, runClaudeProfile, syncClaudeLauncherShims } from "./claude-launchers";
import {
  claudeProjectSettingsFilePath,
  clearClaudeProjectRoutingProfileHeader,
  injectClaudeProjectSettings,
  readClaudeGatewayState,
  readClaudeProjectGatewayState,
  restoreClaudeProjectSettings,
} from "./claude-settings";
import { buildClaudeDoctorReport, resolveRawClaudeOnPath, sanitizeClaudeDoctorReport, type ApiModelRow, type ClaudeDoctorReport } from "./claude-doctor";
import {
  addClaudeGrant,
  assertClaudeGrantRemovalSafe,
  assertRealClaudeExecutable,
  buildClaudeGrantLoginCommand,
  grantsRoot,
  listClaudeGrants,
  readGrantMarker,
  removeClaudeGrant,
  resolveClaudeGrant,
} from "./claude-grants";
import type { ClaudeGrantRecord } from "./types";
import { deleteClaudeGrantCredential, inspectClaudeGrantStatus, type ClaudeGrantStatusState } from "./claude-grant-auth";
import { ClaudeGrantProbeError, runClaudeGrantLiveProbe } from "./claude-grant-probe";
import { assertAllowedClaudeGrantTarget } from "./provider-auth";

const args = process.argv.slice(2);
const command = args[0];

function cliVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")).version as string) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function installedDevBuildId(): string | null {
  try {
    const receiptPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".frogprogsy-dev-build.json");
    const value = JSON.parse(readFileSync(receiptPath, "utf-8")) as { buildId?: unknown };
    return typeof value.buildId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.buildId)
      ? value.buildId
      : null;
  } catch {
    return null;
  }
}

function guiBuildWarning(): string | null {
  const version = cliVersion();
  const identity = resolveGuiBuildIdentity(
    findGuiDistFromModuleDir(dirname(fileURLToPath(import.meta.url))),
    version,
    `frogprogsy-server@${version}`,
  );
  return formatGuiBuildWarning(identity);
}

function printGuiBuildWarning(): void {
  const warningText = guiBuildWarning();
  if (warningText) console.error(`⚠️  ${warningText}`);
}

function printUsage() {
  console.log(`frogprogsy (frogp) — Universal provider proxy for Claude Code

Usage:
  frogp init                    Interactive setup (provider + Claude Code config injection)
  frogp start [--port <port>]   Start the proxy server (auto-syncs models and claude launchers)
  frogp stop                    Stop the proxy AND restore native Claude Code routing
  frogp restore                 Restore native Claude Code routing without stopping
  frogp uninstall               Remove local config, restore native Claude Code, and remove the package
  frogp gui                     Open the local dashboard
  frogp refresh                 Ensure the proxy is running and re-sync Claude Code config/models/cache
  frogp status [--json]         Check proxy server status (JSON for scripts)
  frogp doctor claude [--json]   Diagnose Claude Code model picker visibility
  frogp models [--json]         List routed models from the running proxy
  frogp claude <command>        Manage Claude Code homes, isolated subscription grants, and project enrollment
  frogp login [--list|<provider>]  Login or add a key (codex, openai, xai, kimi, API-key catalog)
  frogp logout <provider>       Remove a stored OAuth login
  frogp providers set <name> --auth claude-grant --grant <id>   Bind a provider to an isolated Claude subscription grant
  frogp update [--no-restart]   Update frogprogsy to the latest published version
  frogp version                 Print the installed version and development build id
  frogp help [command]          Show this help, or usage for one command

Examples:
  frogp init                    Set up provider and inject into Claude Code
  frogp start                   Start on default port (${DEFAULT_PORT})
  frogp gui                     Open the dashboard
  frogp login codex             Log in with OpenAI Codex / ChatGPT OAuth
  frogp start --port 8080       Start on custom port
  frogp refresh                 Sync available models to Claude Code
  frogp claude project enroll   Enroll this project for ordinary \`claude\` gateway discovery
  frogp claude reload-models    Prepare a Claude Code home to reload gateway models on next start/resume
  frogp claude add "업무용" --home ~/.claude-work
  frogp claude grants add "Work Max"   Create an isolated Claude subscription grant and print a manual login
  frogp claude grants status            Show ok/none/unreadable/reauth_required/dangling per grant (no secrets)
  frogp providers set anthropic --auth claude-grant --grant cg_ab12cd   Bind a provider to a grant
  frogp status --json           Machine-readable status for scripts
  frogp models                  Show the model list Claude Code sees
  frogp doctor claude           Diagnose missing GPT/codex aliases in Claude Code
  frogp help login              Show usage for the login command`);
}

function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

const HELP_TOPICS = new Set([
  "init",
  "start",
  "stop",
  "restore",
  "refresh",
  "uninstall",
  "status",
  "doctor",
  "models",
  "claude",
  "login",
  "logout",
  "providers",
  "gui",
  "update",
  "version",
]);

function printSubcommandUsage(name: string | undefined): boolean {
  switch (name) {
    case "init":
      console.log("Usage: frogp init\n\nInteractive setup for providers and Claude Code config injection.");
      break;
    case "start":
      console.log("Usage: frogp start [--port <port>]\n\nStart the proxy server, sync models to Claude Code, and generate plain claude/profile launchers.");
      break;
    case "stop":
      console.log("Usage: frogp stop\n\nStop the proxy and restore every configured Claude Code home AND every enrolled project so new Claude Code sessions never target a stopped proxy after a successful stop. Global stop temporarily removes project-local gateway settings but retains enrollment intent (enrolled:true); the next start/refresh reapplies enrolled projects. Managed launchers remain installed and pass through to native Claude Code while the proxy is stopped.");
      break;
    case "restore":
      console.log("Usage: frogp restore\n\nRestore every configured Claude Code home AND every enrolled project without stopping the proxy, leaving them Claude-direct so new Claude Code sessions never target a stopped proxy. Global restore temporarily removes project-local gateway settings but retains enrollment intent (enrolled:true); the next start/refresh reapplies enrolled projects, while explicit `frogp claude project restore` is the durable per-project opt-out. Managed launchers remain installed and pass through to native Claude Code when no proxy is active.");
      break;
    case "uninstall":
      console.log("Usage: frogp uninstall\n\nRemove local config, restore every configured Claude Code home and every enrolled project to native Claude Code, remove the config directory containing managed launchers, and remove the package.");
      break;
    case "refresh":
      console.log("Usage: frogp refresh\n\nEnsure the proxy is running and re-sync every configured Claude Code home config/models/cache plus plain claude/profile launchers, and reapply every enrolled project's gateway routing with the active port and carrier (token-free migrates stale sentinel project settings).");
      break;
    case "claude":
      console.log("Usage: frogp claude list|add|rename|remove|inject|refresh|reload-models|restore|status|run|project|grants|auth ...\n\nManage Claude Code config homes, isolated subscription grants, and project-scoped enrollment. For ordinary `claude` in a repository, prefer `frogp claude project enroll [path]`: it writes only <project>/.claude/settings.local.json with the frogprogsy base URL and gateway discovery flag. Token-free is the default; no synthetic auth token is written unless the explicit sentinel rollback is configured. Claude account/home selection remains Claude Code controlled and is not chosen by project enrollment.\n\nProject commands:\n  frogp claude project enroll [path] [--routing-profile <name-or-id>]\n  frogp claude project status [path]\n  frogp claude project restore [path]\n\nIsolated Claude subscription grants (Branch B) — never touch your native ~/.claude home or the global Keychain login:\n  frogp claude grants list\n  frogp claude grants add <label>            Create a grant and print a manual login using your real claude executable\n  frogp claude grants remove <id> [--force]  Deletes the grant's scoped local credential then removes it; refuses while a provider is bound unless --force (no auto-rebind); no server-side revocation\n  frogp claude grants status [id]            ok/none/unreadable/reauth_required/dangling (no secrets)\n  frogp claude auth probe-b --grant <id> [--live --yes] [--json] [--provider <name>]   Consented Branch-B probe; --live --yes verifies two real Anthropic surfaces with the bound grant only\n\nStale model picker recovery for a specific Claude home: frogp claude reload-models [name-or-id]\nRebuilds that home's gateway model cache/catalog. Claude Code may refetch /v1/models on process/session start and resume, not when an already-open /model screen is reopened.\n\nRollback only: set gatewayAuthCarrier:\"sentinel\" in frogprogsy config, or add --global-discovery-auth to one home inject/refresh/reload-models invocation. Sentinel mode may disable claude.ai connectors for that home.");
      break;
    case "providers":
      console.log("Usage: frogp providers set <name> --auth claude-grant --grant <id>\n\nBind an existing provider to an isolated Claude subscription grant. Unknown provider or grant is a hard error. This never touches OAuth or API-key logins; it only sets the provider's authMode to claude-grant and records the grant id. It does not log in and does not auto-rebind on grant removal.");
      break;
    case "doctor":
      console.log("Usage: frogp doctor claude [--json]\n\nRead-only diagnostics for Claude Code /model visibility plus isolated Claude subscription grants (resolved real claude path/kind, grant config-dir confinement, expected scoped Keychain service, provider dangling bindings, native auth env conflicts). Never reads or writes native Claude homes or the global/unscoped Keychain. --json prints one redacted JSON object on stdout; credential values, JSON, email, and absolute home paths are never emitted.");
      break;

    case "status":
      console.log("Usage: frogp status [--json]\n\nCheck proxy server status. --json prints a stable machine-readable snapshot (stdout is JSON only).");
      break;
    case "models":
      console.log("Usage: frogp models [--json]\n\nList routed models from the RUNNING proxy (same list as the dashboard, via GET /api/models). Requires the proxy to be up: frogp start. --json prints the raw /api/models array.");
      break;
    case "login":
      console.log("Usage: frogp login [--list|<provider>]\n\nOAuth or API-key login for a provider. --list shows available OAuth and API-key providers.");
      break;
    case "logout":
      console.log("Usage: frogp logout <provider>\n\nRemove a stored provider login.");
      break;
    case "gui":
      console.log("Usage: frogp gui\n\nOpen the frogprogsy dashboard.");
      break;
    case "update":
      console.log("Usage: frogp update [--no-restart]\n\nUpdate frogprogsy to the latest published version. Pass --no-restart to skip the automatic proxy restart.");
      break;
    case "version":
      console.log("Usage: frogp version\n\nPrint the installed version and development build id when present.");
      break;

    default:
      return false;
  }
  return true;
}

/** Suggest the closest known command for a typo (edit distance ≤ 2), or null. */
function suggestCommand(input: string): string | null {
  return suggestClosest(input, [...HELP_TOPICS, "help"], 2);
}

if (command !== undefined && command !== "help" && hasHelpFlag(args.slice(1))) {
  if (!HELP_TOPICS.has(command) || !printSubcommandUsage(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  process.exit(0);
}

async function syncModelsToClaudeCode(port?: number) {
  const config = loadConfig();
  const p = port ?? config.port ?? DEFAULT_PORT;
  const profiles = managedClaudeProfiles(config);
  const { refreshClaudeCodeModelCatalog } = await import("./claude-refresh");
  const { injectClaudeCodeConfig } = await import("./claude-inject");
  // Top-level refresh applies to every configured Claude Code home. Per-home refresh is available via `frogp claude refresh <home>`.
  let ok = true;
  const messages: string[] = [];
  for (const profile of profiles) {
    let catalogPath: string | null | undefined;
    try {
      const cat = await refreshClaudeCodeModelCatalog(config, undefined, { claudeHome: profile.claudeHome, profileId: profile.id });
      catalogPath = cat.catalogExists ? cat.path : null;
      if (cat.added > 0) {
        console.log(`   + ${cat.added} models appended to Claude Code catalog for ${profile.name} (${cat.path})`);
      }
    } catch (e) {
      console.error(`catalog sync skipped for ${profile.name}:`, e instanceof Error ? e.message : String(e));
    }
    const result = await injectClaudeCodeConfig(p, config, { catalogPath, claudeHome: profile.claudeHome, profileId: profile.id });
    ok = ok && result.success;
    messages.push(`[${profile.name}] ${result.message}`);
    if (result.success) markClaudeProfileInjected(config, profile.id, true);
  }
  // Reapply every enrolled project's gateway routing on the same refresh path (uses the active port +
  // carrier; token-free migrates stale sentinel project settings). Failures are surfaced, not fatal.
  const projectReapply = reapplyEnrolledClaudeProjects(config, p);
  if (projectReapply.message) messages.push(projectReapply.message);
  ok = ok && projectReapply.success;
  saveConfig(config);
  syncLaunchers(config);
  console.log(messages.join("\n"));
  return { success: ok, message: messages.join("\n") };
}

/**
 * Reapply enrolled project routing after the server is active (normal `frogp start` path). Logs the
 * aggregated evidence: successes are informational, missing/unwritable projects are warnings — never a
 * hard failure, so one broken project cannot stop the running proxy.
 */
function reapplyEnrolledProjectsWithLogging(config: ReturnType<typeof loadConfig>, port: number): void {
  const result = reapplyEnrolledClaudeProjects(config, port);
  if (!result.message) return;
  if (result.success) console.log(`↩️  ${result.message}`);
  else console.error(`⚠️  ${result.message}`);
}

function parsePortOption(): number | undefined {
  const portIdx = args.indexOf("--port");
  if (portIdx === -1) return undefined;
  const value = args[portIdx + 1];
  const port = value ? parseInt(value, 10) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("Invalid port number");
    process.exit(1);
  }
  return port;
}

function healthHost(hostname?: string): string {
  return !hostname || hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
}

async function proxyHealthy(port?: number): Promise<boolean> {
  const config = loadConfig();
  const p = port ?? config.port ?? DEFAULT_PORT;
  try {
    const res = await fetch(`http://${healthHost(config.hostname)}:${p}/healthz`, {
      signal: AbortSignal.timeout(750),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function printLauncherSync(result: ReturnType<typeof syncClaudeLauncherShims>): void {
  const names = result.launchers.map(entry => entry.name).join(", ");
  console.log(`   launchers: ${names || "(none)"} in ${result.binDir}`);
  if (result.realClaude === "claude") {
    console.log("   warning: real Claude executable was not resolved; launchers will use PATH at runtime.");
  } else {
    console.log(`   real claude: ${result.realClaude}`);
  }
  for (const warning of result.warnings) console.log(`   warning: ${warning}`);
  console.log(`   Put ${result.binDir} before the original Claude Code binary in PATH to make plain 'claude' and generated aliases route through frogprogsy.`);
}

function syncLaunchers(config: ReturnType<typeof loadConfig>): void {
  try {
    printLauncherSync(syncClaudeLauncherShims(config));
  } catch (error) {
    console.error(`⚠️  Claude launcher shim sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}


async function waitForProxy(timeoutMs = 8_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const config = loadConfig();
    const port = config.port ?? DEFAULT_PORT;
    if (await proxyHealthy(port)) return port;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

async function chooseListenPort(requestedPort?: number): Promise<number> {
  const config = loadConfig();
  const preferred = requestedPort ?? config.port ?? DEFAULT_PORT;
  const selected = await findAvailablePort(preferred, config.hostname ?? "127.0.0.1");
  if (selected !== preferred) {
    console.log(`⚠️  Port ${preferred} is busy; starting frogprogsy on ${selected}.`);
  }
  if (config.port !== selected) {
    config.port = selected;
    saveConfig(config);
  }
  return selected;
}

async function handleStart(options: { block?: boolean } = {}) {
  const existingPid = readPid();
  if (existingPid) {
    const config = loadConfig();
    if (await proxyHealthy(config.port)) {
      console.error(`⚠️  Proxy already running (PID ${existingPid}). Use 'frogp stop' first.`);
      process.exit(1);
    }
    removePid();
  }

  const requestedPort = parsePortOption();
  const port = await chooseListenPort(requestedPort);

  printGuiBuildWarning();

  const server = startServer(port);
  writePid(process.pid);
  writeActivePort(port); // record real listen port for watchdog health-poll
  clearShutdownIntent();
  // Clear any stale watchdog give-up status so 'frogp status' doesn't show
  // both 'running' and 'gave up' after a give-up → 'frogp start' cycle.
  const _watchdogStatusPath = getWatchdogStatusPath();
  if (existsSync(_watchdogStatusPath)) {
    assertSafeConfigDirWrite("remove watchdog status");
    try { unlinkSync(_watchdogStatusPath); } catch { /* best-effort */ }
  }

  // Arm the watchdog sidecar (sole-supervisor, default-ON, auto-off when FROGP_EXTERNAL_SUPERVISOR is set).
  const _startConfig = loadConfig();
  if (resolveWatchdogEnabled(_startConfig, process.env as Record<string, string | undefined>)) {
    const watchdogChild = spawn(
      process.execPath,
      [process.argv[1], "__watchdog", "--parent", String(process.pid), "--port", String(port)],
      { detached: true, stdio: "ignore", env: { ...process.env } },
    );
    watchdogChild.unref();
  }

  const shutdown = () => {
    console.log("\n🛑 Shutting down frogprogsy proxy...");
    let exitCode = 0;
    writeShutdownIntent(process.pid); // signal watchdog: graceful stop, not a crash
    server.stop(true);
    removePid();
    removeActivePort();
    // Intentional shutdown restores Claude Code unless the process is kept alive by a
    // supervisor or by a detached `frogp refresh` / FROGP_DETACHED integration.
    if (!parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR) && !process.env.FROGP_DETACHED) {
      try {
        const restored = restoreAllClaudeRouting();
        if (restored.success) {
          console.log(`↩️  ${restored.message}`);
        } else {
          exitCode = 1;
          console.error(`❌ Claude Code routing restore failed: ${restored.message}`);
        }
      } catch (err) {
        exitCode = 1;
        console.error(`❌ Claude Code routing restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await maybeShowStarPrompt(); // once-only [Y/n] GitHub-star prompt on first interactive start
  const startConfig = loadConfig();
  const startProfiles = managedClaudeProfiles(startConfig);
  const { refreshClaudeCodeModelCatalog } = await import("./claude-refresh");
  for (const profile of startProfiles) {
    try {
      const cat = await refreshClaudeCodeModelCatalog(startConfig, undefined, { claudeHome: profile.claudeHome, profileId: profile.id });
      if (cat.added > 0) console.log(`   + ${cat.added} models appended to Claude Code catalog for ${profile.name} (${cat.path})`);
    } catch (e) {
      console.error(`catalog sync skipped for ${profile.name}:`, e instanceof Error ? e.message : String(e));
    }
    await injectClaudeSettingsWithRetry(port, {
      claudeHome: profile.claudeHome,
      profileId: profile.id,
      gatewayAuthCarrier: startConfig.gatewayAuthCarrier,
    });
    markClaudeProfileInjected(startConfig, profile.id, true);
  }
  saveConfig(startConfig);
  syncLaunchers(startConfig);
  // Server is active: reapply every enrolled project's gateway routing with the live port + carrier.
  // Missing/unwritable projects surface warnings here but never block the running server.
  reapplyEnrolledProjectsWithLogging(startConfig, port);
  if (options.block ?? true) {
    setInterval(() => {}, 60_000);
    await new Promise<void>(() => {});
  }
}

async function handleRefresh() {
  let config = loadConfig();
  if (await proxyHealthy(config.port)) {
    await syncModelsToClaudeCode(config.port).catch(e => {
      console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    });
    try {
      const { invalidateClaudeCodeModelsCache } = await import("./claude-catalog");
      invalidateClaudeCodeModelsCache();
    } catch (e) {
      console.error(`⚠️  Cache invalidation skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log(`✅ Proxy running on port ${config.port}`);
    return;
  }

  const child = spawn(process.execPath, [process.argv[1], "start"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FROGP_DETACHED: "1", FROGP_EXTERNAL_SUPERVISOR: undefined },
  });
  child.unref();

  const port = await waitForProxy();
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    process.exit(1);
  }
  config = loadConfig();
  await syncModelsToClaudeCode(config.port ?? port).catch(e => {
    console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
  });
  try {
    const { invalidateClaudeCodeModelsCache } = await import("./claude-catalog");
    invalidateClaudeCodeModelsCache();
  } catch (e) {
    console.error(`⚠️  Cache invalidation skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`✅ Proxy running on port ${config.port ?? port}`);
}


function killProxy(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    try {
      execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } catch (err) {
      if (isProcessAlive(pid)) throw err;
    }
  } else {
    process.kill(pid, "SIGTERM");
    if (!waitForExit(pid, 5000)) process.kill(pid, "SIGKILL");
  }
  if (!waitForExit(pid, 5000)) throw new Error(`process ${pid} did not exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const marker = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(marker, 0, 0, 50);
  }
  return !isProcessAlive(pid);
}
function restoreAllClaudeRouting(): { success: boolean; message: string } {
  const config = loadConfig();
  // Global restore boundary (graceful shutdown, `frogp stop`, `frogp restore`, uninstall): make every
  // managed home AND every enrolled project Claude-direct on disk while retaining enrollment intent.
  const result = restoreManagedClaudeRouting(config);
  saveConfig(config);
  return result;
}


function handleStop() {
  let stopFailed = false;

  const pid = readPid();
  if (pid) {
    try {
      writeShutdownIntent(pid); // signal watchdog: graceful stop, not a crash
      killProxy(pid);
      console.log(`✅ Proxy (PID ${pid}) stopped.`);
      removePid();
      removeActivePort();
    } catch {
      stopFailed = true;
      console.error(`❌ Failed to stop proxy (PID ${pid}).`);
    }
  } else {
    console.log("No running proxy found.");
  }
  const r = restoreAllClaudeRouting();
  if (r.success) {
    console.log(`↩️  ${r.message}`);
  } else {
    stopFailed = true;
    console.error(`❌ Claude Code routing restore failed: ${r.message}`);
  }
  if (stopFailed) process.exit(1);
}

async function handleUninstall() {
  const failures: string[] = [];

  const runStep = (label: string, step: () => void | boolean) => {
    try {
      const changed = step();
      if (changed === false) console.log(`- ${label}: not installed`);
      else console.log(`✅ ${label}`);
    } catch (err) {
      failures.push(label);
      console.error(`⚠️  ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };


  runStep("proxy stopped", () => {
    const pid = readPid();
    if (!pid) return false;
    killProxy(pid);
    removePid();
    return true;
  });

  runStep("Claude Code routing restored", () => {
    const r = restoreAllClaudeRouting();
    if (!r.success) throw new Error(r.message);
  });


  if (failures.length > 0) {
    console.error(`\nSkipping frogprogsy config removal so restore backups remain available.`);
    console.error(`Uninstall finished with ${failures.length} failed step(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  runStep("frogprogsy config removed", () => {
    assertSafeConfigDirWrite("remove frogprogsy config");
    rmSync(getConfigDir(), { recursive: true, force: true });
  });

  if (failures.length > 0) {
    console.error(`\nUninstall finished with ${failures.length} failed step(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  // Best-effort Bun global package removal (must run last — removes the running binary's package)
  try {
    const { detectInstall } = await import("./update");
    const installer = detectInstall();
    if (installer === "source") {
      console.log("Source checkout — remove the directory manually (no global package removal).");
    } else if (installer === "unsupported") {
      console.error("⚠️  Package removal skipped: this installation is not managed by Bun.");
      console.error("    Reinstall with Bun for managed removal: bun add -g frogprogsy");
    } else {
      const cmdArgs = ["remove", "-g", "frogprogsy"];
      console.log(`Removing Bun global package: bun ${cmdArgs.join(" ")}`);
      const r = spawnSync("bun", cmdArgs, { stdio: "inherit", timeout: 60000, windowsHide: true });
      if (r.status === 0) {
        console.log("✅ frogprogsy package removed.");
      } else {
        console.error(`⚠️  Package removal failed (exit ${r.status ?? "?"}). Remove manually: bun ${cmdArgs.join(" ")}`);
      }
    }
  } catch (err) {
    console.error(`⚠️  Package removal skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log("\n✅ frogprogsy uninstalled.");
}


interface WatchdogSnapshot {
  present: boolean;
  attempts: number | null;
  gaveUpAt: string | null;
  unreadable: boolean;
}

interface StatusSnapshot {
  running: boolean;
  healthy: boolean;
  pid: number | null;
  port: number | null;
  dashboardUrl: string | null;
  recovery: string | null;
  watchdog: WatchdogSnapshot;
}

/** Normalize the watchdog give-up file into a fixed, raw-field-free schema. */
function readWatchdogSnapshot(): WatchdogSnapshot {
  const watchdogStatusPath = getWatchdogStatusPath();
  if (!existsSync(watchdogStatusPath)) {
    return { present: false, attempts: null, gaveUpAt: null, unreadable: false };
  }
  try {
    const raw = JSON.parse(readFileSync(watchdogStatusPath, "utf-8")) as Record<string, unknown>;
    return {
      present: true,
      attempts: typeof raw.attempts === "number" && Number.isFinite(raw.attempts) ? raw.attempts : null,
      gaveUpAt: typeof raw.gaveUpAt === "string" ? raw.gaveUpAt : null,
      unreadable: false,
    };
  } catch {
    return { present: true, attempts: null, gaveUpAt: null, unreadable: true };
  }
}

async function collectStatusSnapshot(): Promise<StatusSnapshot> {
  const pid = readPid();
  const watchdog = readWatchdogSnapshot();
  if (!pid) {
    return { running: false, healthy: false, pid: null, port: null, dashboardUrl: null, recovery: "frogp start", watchdog };
  }
  const config = loadConfig();
  const port = readActivePort() ?? config.port ?? DEFAULT_PORT;
  const healthy = await proxyHealthy(port);
  return {
    running: true,
    healthy,
    pid,
    port,
    dashboardUrl: healthy ? `http://localhost:${port}` : null,
    recovery: healthy ? null : "frogp refresh",
    watchdog,
  };
}

/**
 * Machine-output path: exactly one JSON document plus trailing newline on stdout.
 * Never routed through the color helper — JSON must not contain ANSI codes.
 */
function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function humanColorEnabled(): boolean {
  return shouldColor(process.env as Record<string, string | undefined>, process.stdout.isTTY === true);
}

function renderHumanStatus(snapshot: StatusSnapshot, paint: boolean): void {
  if (snapshot.running && snapshot.healthy) {
    console.log(success(`✅ Proxy running (PID ${snapshot.pid}) on port ${snapshot.port}`, paint));
    console.log(dim(`   Dashboard: ${snapshot.dashboardUrl}  (or run: frogp gui)`, paint));
  } else if (snapshot.running) {
    console.log(warn(`⚠️  Proxy process exists (PID ${snapshot.pid}) but is not answering on port ${snapshot.port}.`, paint));
    console.log("   Recover with: frogp refresh");
  } else {
    console.log(errorText("❌ Proxy not running. Start it with: frogp start", paint));
  }
  const wd = snapshot.watchdog;
  if (wd.present) {
    if (wd.unreadable) {
      console.log(warn("⚠️  Watchdog gave up — status file unreadable. Run: frogp start", paint));
    } else {
      console.log(warn(`⚠️  Watchdog gave up after ${wd.attempts ?? "?"} attempt(s) (at ${wd.gaveUpAt ?? "unknown time"}). Run: frogp start`, paint));
    }
  }
  const guiWarning = guiBuildWarning();
  if (guiWarning) console.log(warn(`⚠️  ${guiWarning}`, paint));
  const rawClaude = resolveRawClaudeOnPath();
  if (rawClaude.kind === "cmux_shim") {
    console.log(warn("⚠️  Claude 모델 선택기에 GPT/codex가 없으면 진단 실행: frogp doctor claude", paint));
  }
}

async function handleStatus(flags: string[]) {
  const unknown = flags.filter(flag => flag !== "--json");
  if (unknown.length > 0) {
    console.error(`Unknown status option: ${unknown.join(" ")}\nUsage: frogp status [--json]`);
    process.exit(1);
  }
  const snapshot = await collectStatusSnapshot();
  if (flags.includes("--json")) {
    printJson(snapshot);
    return;
  }
  renderHumanStatus(snapshot, humanColorEnabled());
}

function renderHumanModels(models: Record<string, unknown>[], paint: boolean): void {
  if (models.length === 0) {
    console.log("No models reported by the proxy. Add a provider in the dashboard: frogp gui");
    return;
  }
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const model of models) {
    const provider = typeof model.provider === "string" && model.provider ? model.provider : "(unknown provider)";
    const rows = groups.get(provider);
    if (rows) rows.push(model);
    else groups.set(provider, [model]);
  }
  for (const [provider, rows] of groups) {
    console.log(success(`${provider} (${rows.length})`, paint));
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : String(row.id ?? "(unknown)");
      const details: string[] = [];
      if (row.disabled === true) details.push("disabled");
      if (typeof row.contextWindow === "number") details.push(`ctx ${row.contextWindow}`);
      if (Array.isArray(row.inputModalities) && row.inputModalities.length > 0) details.push(row.inputModalities.join("+"));
      if (Array.isArray(row.reasoningEfforts) && row.reasoningEfforts.length > 0) details.push(`effort ${row.reasoningEfforts.join("/")}`);
      const suffix = details.length > 0 ? dim(`  (${details.join(", ")})`, paint) : "";
      console.log(`  ${id}${suffix}`);
    }
  }
}

/**
 * Online-only model listing: delegates to the running proxy's existing GET /api/models
 * (the same list the dashboard and Claude Code catalog use). Never synthesizes an
 * offline list from config/registry/catalog state.
 */
async function handleModels(flags: string[]) {
  const unknown = flags.filter(flag => flag !== "--json");
  if (unknown.length > 0) {
    console.error(`Unknown models option: ${unknown.join(" ")}\nUsage: frogp models [--json]`);
    process.exit(1);
  }
  if (!readPid()) {
    console.error("❌ Proxy not running. Start it with: frogp start");
    process.exit(1);
  }
  const config = loadConfig();
  const port = readActivePort() ?? config.port ?? DEFAULT_PORT;
  if (!(await proxyHealthy(port))) {
    console.error(`❌ Proxy is not answering on port ${port}. Check: frogp status, then recover with: frogp refresh (or frogp start)`);
    process.exit(1);
  }
  let models: unknown;
  try {
    const res = await fetch(`http://${healthHost(config.hostname)}:${port}/api/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = await res.json();
  } catch (err) {
    console.error(`❌ Could not fetch models from the running proxy (${err instanceof Error ? err.message : String(err)}). Check: frogp status, then recover with: frogp refresh`);
    process.exit(1);
  }
  if (!Array.isArray(models)) {
    console.error("❌ Unexpected /api/models response shape (expected an array).");
    process.exit(1);
  }
  if (flags.includes("--json")) {
    printJson(models);
    return;
  }
  renderHumanModels(models as Record<string, unknown>[], humanColorEnabled());
}
async function fetchApiModelRowsForDoctor(config: ReturnType<typeof loadConfig>, port: number): Promise<ApiModelRow[]> {
  if (!readPid() || !(await proxyHealthy(port))) return [];
  try {
    const res = await fetch(`http://${healthHost(config.hostname)}:${port}/api/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const models = await res.json();
    return Array.isArray(models) ? models as ApiModelRow[] : [];
  } catch {
    return [];
  }
}

function renderDoctorHuman(report: ClaudeDoctorReport, paint: boolean): void {
  const healthyCaches = report.gatewayCaches.filter(cache => cache.status === "healthy");
  const publicationHealthy = report.modelSummary.expectedEnabledAliases.length > 0 && healthyCaches.some(cache => cache.modelCount > 0 && cache.expectedAliasesMissing.length === 0);
  console.log(success(publicationHealthy ? "✅ Claude 모델 발행 상태: 정상" : "⚠️  Claude 모델 발행 상태: 확인 필요", paint));
  for (const cache of report.gatewayCaches) {
    const missing = cache.expectedAliasesMissing.length > 0 ? `, 누락 alias ${cache.expectedAliasesMissing.length}` : "";
    const age = cache.ageMs !== undefined ? `, age ${Math.round(cache.ageMs / 1_000)}s` : "";
    console.log(`   cache: ${cache.status} (${cache.modelCount} models${missing}${age}) ${cache.path}`);
  }

  console.log(`raw claude: ${report.rawClaude.kind} ${report.rawClaude.path ?? "(missing)"}`);
  console.log(`real claude target: ${report.realClaude.path}`);

  const launcherMissing = report.launchers.filter(launcher => !launcher.installed || !launcher.onPath);
  if (launcherMissing.length === 0) {
    console.log(success(`✅ 명시적 home/account 런처 PATH 상태: 정상 (${report.launcherBinDir})`, paint));
  } else {
    console.log(warn(`⚠️  명시적 home/account 런처 PATH 상태: ${launcherMissing.length}개 확인 필요 (${report.launcherBinDir})`, paint));
    for (const launcher of launcherMissing) {
      console.log(`   ${launcher.command}: installed=${launcher.installed ? "yes" : "no"}, onPath=${launcher.onPath ? "yes" : "no"}`);
    }
  }

  console.log(`codex: enabled ${report.modelSummary.codex.enabledCount}, disabled ${report.modelSummary.codex.disabledCount}`);
  if (report.modelSummary.codex.disabledModelIds.length > 0) {
    console.log(`   disabled: ${report.modelSummary.codex.disabledModelIds.join(", ")}`);
  }

  for (const profile of report.profiles) {
    const discoveryAuth = profile.state.modelDiscoveryReady ? "settings" : "launcher";
    console.log(`profile ${profile.profileName}: settings=${profile.state.applied ? "gateway" : "direct"}, carrier=${profile.state.carrier}, discoveryAuth=${discoveryAuth}; run ${profile.runCommand.join(" ")}; reload ${profile.reloadCommand.join(" ")}`);
  }

  const grantInspection = report.grants;
  console.log(`real claude kind (for grants): ${grantInspection.realClaudeKind}`);
  if (grantInspection.grants.length === 0 && grantInspection.danglingProviderBindings.length === 0) {
    console.log("claude grants: none configured");
  } else {
    for (const grant of grantInspection.grants) {
      const detail = grant.dangling
        ? "dangling"
        : `confined=${grant.configDirConfined ? "yes" : "no"}, marker=${grant.markerBound ? "bound" : "unbound"}, credential=${grant.credentialState}`;
      const providers = grant.boundProviders.length > 0 ? `, providers=${grant.boundProviders.join(",")}` : "";
      console.log(`grant ${grant.id} (${grant.label}): ${detail}${providers}`);
    }
    for (const binding of grantInspection.danglingProviderBindings) {
      console.log(`⚠️  provider ${binding.provider} → missing grant ${binding.grantId || "(unset)"}`);
    }
  }
  if (grantInspection.nativeAuthEnvConflicts.length > 0) {
    console.log(`native auth env conflicts: ${grantInspection.nativeAuthEnvConflicts.join(", ")} (names only; unset before grant login)`);
  }

  console.log("guidance: Claude Code는 이미 열린 /model 화면을 hot-reload하지 않을 수 있습니다. 새 Claude 프로세스/세션을 시작하거나 resume하고, 필요하면 frogp claude reload-models를 실행하세요.");
  for (const finding of report.findings) {
    const prefix = finding.severity === "error" ? "❌" : finding.severity === "warning" ? "⚠️ " : "ℹ️ ";
    console.log(`${prefix} ${finding.message}`);
    console.log(`   action: ${finding.action}`);
  }
}

async function handleDoctor(values: string[]): Promise<void> {
  const topic = values[0];
  const flags = values.slice(1);
  if (topic !== "claude") {
    console.error("Usage: frogp doctor claude [--json]");
    process.exit(1);
  }
  const unknown = flags.filter(flag => flag !== "--json");
  if (unknown.length > 0) {
    console.error(`Unknown doctor option: ${unknown.join(" ")}\nUsage: frogp doctor claude [--json]`);
    process.exit(1);
  }
  const config = loadConfig();
  const port = readActivePort() ?? config.port ?? DEFAULT_PORT;
  const apiModels = await fetchApiModelRowsForDoctor(config, port);
  const report = buildClaudeDoctorReport(config, apiModels, { port });
  if (flags.includes("--json")) {
    printJson(sanitizeClaudeDoctorReport(report));
    return;
  }
  renderDoctorHuman(report, humanColorEnabled());
}

function parseClaudeHomeOption(values: string[]): string | null {
  const index = values.indexOf("--home");
  if (index === -1) return null;
  const home = values[index + 1]?.trim();
  if (!home) {
    console.error("Usage: frogp claude add <name> --home <path>");
    process.exit(1);
  }
  return home;
}
function parseGlobalDiscoveryAuthFlag(values: string[]): { values: string[]; includeAuthToken: boolean } {
  const includeAuthToken = values.includes("--global-discovery-auth");
  return {
    includeAuthToken,
    values: values.filter(value => value !== "--global-discovery-auth"),
  };
}

function parseRoutingProfileOption(values: string[], config: ReturnType<typeof loadConfig>): { values: string[]; routingProfileId?: string } {
  const index = values.indexOf("--routing-profile");
  if (index === -1) return { values };
  const selector = values[index + 1]?.trim();
  if (!selector) {
    console.error("Usage: frogp claude project enroll [path] [--routing-profile <name-or-id>]");
    process.exit(1);
  }
  const profile = resolveClaudeProfile(config, selector);
  return {
    values: values.filter((_, valueIndex) => valueIndex !== index && valueIndex !== index + 1),
    routingProfileId: profile.id,
  };
}

function projectGatewayLabel(config: ReturnType<typeof loadConfig>, project: { projectPath: string; routingProfileId?: string }): "frogprogsy gateway" | "Claude direct" {
  const port = readActivePort() ?? config.port ?? DEFAULT_PORT;
  return readClaudeProjectGatewayState(port, { projectPath: project.projectPath, routingProfileId: project.routingProfileId }).applied ? "frogprogsy gateway" : "Claude direct";
}

function printClaudeProjectStatus(config: ReturnType<typeof loadConfig>, projectPath: string): void {
  let record: ReturnType<typeof resolveClaudeProject> | undefined;
  try {
    record = resolveClaudeProject(config, projectPath);
  } catch {
    record = undefined;
  }
  const routingProfileId = record?.routingProfileId;
  const port = readActivePort() ?? config.port ?? DEFAULT_PORT;
  const state = readClaudeProjectGatewayState(port, { projectPath, routingProfileId });
  const gitProtection = getClaudeProjectGitProtection(projectPath);
  console.log(record ? `${record.name} (${record.id})` : "Unenrolled Claude project");
  console.log(`project: ${record?.projectPath ?? projectPath}`);
  console.log(`settings: ${state.settingsPath}`);
  console.log(`gitProtection: ${gitProtection.status}`);
  console.log(`enrolled: ${record?.enrolled === true ? "yes" : "no"}`);
  console.log(`applied: ${state.applied ? "yes" : "no"}`);
  console.log(`modelDiscoveryReady: ${state.modelDiscoveryReady ? "yes" : "no"}`);
  console.log(`carrier: ${state.carrier}`);
  console.log(`token scope: ${state.authToken === "set_redacted" ? "project local settings" : "not set"}`);
  console.log(`routing profile: ${routingProfileId ?? "none"}`);
  console.log("Project enrollment does not choose the Claude account or Claude Code home; Claude Code remains in control of account/home selection.");
}

function cleanupProjectsForRemovedProfile(config: ReturnType<typeof loadConfig>, profileId: string): void {
  const projects = findClaudeProjectsForRoutingProfile(config, profileId);
  for (const project of projects) {
    const cleared = clearClaudeProjectRoutingProfileHeader(project.projectPath, profileId);
    if (!cleared.success) {
      throw new Error(`Could not clear project routing metadata for ${project.projectPath}: ${cleared.message}`);
    }
  }
  clearClaudeProjectsForRoutingProfile(config, profileId);
}

async function handleClaudeProjectCommand(values: string[], config: ReturnType<typeof loadConfig>): Promise<void> {
  const action = values[1] ?? "status";
  switch (action) {
    case "enroll": {
      const parsed = parseRoutingProfileOption(values.slice(2), config);
      const projectPath = parsed.values[0] ?? process.cwd();
      let project;
      try {
        project = resolveClaudeProject(config, projectPath);
        project.routingProfileId = parsed.routingProfileId;
        getClaudeProjectGitProtection(project.projectPath);
      } catch {
        project = addClaudeProject(config, { projectPath, routingProfileId: parsed.routingProfileId });
      }
      const result = injectClaudeProjectSettings(config.port ?? DEFAULT_PORT, {
        projectPath: project.projectPath,
        routingProfileId: project.routingProfileId,
        gatewayAuthCarrier: config.gatewayAuthCarrier,
      });
      if (!result.success) {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
      markClaudeProjectEnrolled(config, project.id, true);
      saveConfig(config);
      console.log(`✅ Claude project enrolled: ${project.name} (${project.id})`);
      console.log(`   settings: ${claudeProjectSettingsFilePath(project.projectPath)}`);
      console.log("   scope: project local settings; Claude account/home selection remains Claude Code controlled.");
      return;
    }
    case "status": {
      const projectPath = values[2] ?? process.cwd();
      printClaudeProjectStatus(config, projectPath);
      return;
    }
    case "restore": {
      const projectPath = values[2] ?? process.cwd();
      let project;
      try { project = resolveClaudeProject(config, projectPath); } catch { project = undefined; }
      const result = restoreClaudeProjectSettings(project?.projectPath ?? projectPath);
      if (!result.success) {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
      if (project) {
        project.enrolled = false;
        saveConfig(config);
      }
      console.log(`✅ ${result.message}`);
      return;
    }
    case "list": {
      for (const project of listClaudeProjects(config)) {
        console.log(`${project.name} (${project.id})`);
        console.log(`    project: ${project.projectPath}`);
        console.log(`    gateway: ${projectGatewayLabel(config, project)}; gitProtection: ${project.gitProtection.status}; routingProfile: ${project.routingProfileId ?? "none"}`);
      }
      return;
    }
    default:
      console.error("Usage: frogp claude project enroll|status|restore [path] [--routing-profile <name-or-id>]");
      process.exit(1);
  }
}


function profileGatewayApplied(config: ReturnType<typeof loadConfig>, profile: { id: string; claudeHome: string }): boolean {
  const port = readActivePort() ?? config.port ?? DEFAULT_PORT;
  return readClaudeGatewayState(port, { claudeHome: profile.claudeHome, profileId: profile.id }).applied;
}

function profileGatewayLabel(config: ReturnType<typeof loadConfig>, profile: { id: string; claudeHome: string }): "frogprogsy gateway" | "Claude direct" {
  return profileGatewayApplied(config, profile) ? "frogprogsy gateway" : "Claude direct";
}

function printClaudeProfiles(config = loadConfig()): void {
  const rows = listClaudeProfiles(config);
  for (const profile of rows) {
    const marker = profile.isDefault ? "*" : " ";
    console.log(`${marker} ${profile.name} (${profile.id})`);
    console.log(`    home: ${profile.claudeHome}`);
    console.log(`    gateway: ${profileGatewayLabel(config, profile)}; auth: ${profile.authState ?? "not_seen"}`);
  }
}

async function handleClaudeCommand(values: string[]): Promise<void> {
  const sub = values[0] ?? "list";
  const config = loadConfig();
  switch (sub) {
    case "list":
      ensureClaudeProfiles(config);
      saveConfig(config);
      printClaudeProfiles(config);
      return;
    case "add": {
      const home = parseClaudeHomeOption(values);
      const nameParts = values.slice(1).filter((value, index, arr) => {
        if (value === "--home") return false;
        if (arr[index - 1] === "--home") return false;
        return true;
      });
      const name = nameParts.join(" ").trim();
      if (!name || !home) {
        console.error("Usage: frogp claude add <name> --home <path>");
        process.exit(1);
      }
      const profile = addClaudeProfile(config, { name, claudeHome: home });
      saveConfig(config);
      syncLaunchers(config);
      console.log(`✅ Claude Code home added: ${profile.name} (${profile.id})`);
      console.log(`   home: ${profile.claudeHome}`);
      return;
    }
    case "rename": {
      const selector = values[1];
      const nextName = values.slice(2).join(" ").trim();
      if (!selector || !nextName) {
        console.error("Usage: frogp claude rename <name-or-id> <new-name>");
        process.exit(1);
      }
      const profile = renameClaudeProfile(config, selector, nextName);
      saveConfig(config);
      syncLaunchers(config);
      console.log(`✅ Claude Code home renamed: ${profile.name} (${profile.id})`);
      return;
    }
    case "remove": {
      const selector = values[1];
      if (!selector) {
        console.error("Usage: frogp claude remove <name-or-id>");
        process.exit(1);
      }
      const profile = resolveClaudeProfile(config, selector);
      if (ensureClaudeProfiles(config).profiles.length <= 1) {
        console.error("❌ Cannot remove the only Claude Code home");
        process.exit(1);
      }
      try {
        cleanupProjectsForRemovedProfile(config, profile.id);
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      if (profile.injected === true || profileGatewayApplied(config, profile)) {
        const restored = restoreNativeClaudeCode({ claudeHome: profile.claudeHome, profileId: profile.id });
        if (!restored.success) {
          console.error(`❌ ${restored.message}`);
          process.exit(1);
        }
        profile.injected = false;
      }
      const removed = removeClaudeProfile(config, profile.id);
      saveConfig(config);
      syncLaunchers(config);
      console.log(`✅ Claude Code home removed: ${removed.name} (${removed.id})`);
      return;
    }
    case "project":
      await handleClaudeProjectCommand(values, config);
      return;
    case "inject":
    case "refresh":
    case "reload-models": {
      const parsed = parseGlobalDiscoveryAuthFlag(values);
      const profile = resolveClaudeProfile(config, parsed.values.slice(1).join(" ") || undefined);
      const isReloadModels = sub === "reload-models";
      let catalogPath: string | null | undefined;
      let refreshed: import("./claude-refresh").ClaudeCodeCatalogRefreshResult | undefined;
      if (sub === "refresh" || isReloadModels) {
        const { refreshClaudeCodeModelCatalog } = await import("./claude-refresh");
        refreshed = await refreshClaudeCodeModelCatalog(config, undefined, { claudeHome: profile.claudeHome, profileId: profile.id });
        catalogPath = refreshed.catalogExists ? refreshed.path : null;
      }
      const result = await (await import("./claude-inject")).injectClaudeCodeConfig(config.port ?? DEFAULT_PORT, config, { catalogPath, claudeHome: profile.claudeHome, profileId: profile.id, includeAuthToken: parsed.includeAuthToken });
      if (!result.success) {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
      markClaudeProfileInjected(config, profile.id, true);
      saveConfig(config);
      syncLaunchers(config);
      if (!isReloadModels) {
        console.log(result.message);
        return;
      }

      const port = config.port ?? DEFAULT_PORT;
      const healthy = await proxyHealthy(port);
      const lines = [
        result.message,
        `Model reload prepared for ${profile.name} (${profile.id}).`,
        `Claude Code home: ${profile.claudeHome}`,
        `Gateway cache: ${refreshed?.gatewayCache.status ?? "unknown"}${refreshed?.gatewayCache.modelCount !== undefined ? ` (${refreshed.gatewayCache.modelCount} models)` : ""}`,
        `Catalog cache: ${refreshed?.cacheSynced ? "synced" : "not synced"}`,
        ...((refreshed?.warnings ?? []).map(warning => `Warning: ${warning}`)),
        healthy
          ? `Proxy is answering on port ${port}.`
          : `Proxy is not answering on port ${port}; run frogp refresh before starting or resuming Claude Code.`,
        "Start a new Claude Code session or resume so it refetches /v1/models; reopening an already-open /model screen is not a hot reload.",
        "For ordinary raw `claude` in a repository, use `frogp claude project enroll [path]`; managed launchers are only for explicitly selecting a separate Claude home/account.",
      ];
      console.log(lines.join("\n"));
      return;
    }
    case "restore": {
      const profile = resolveClaudeProfile(config, values.slice(1).join(" ") || undefined);
      const result = restoreNativeClaudeCode({ claudeHome: profile.claudeHome, profileId: profile.id });
      if (!result.success) {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
      profile.injected = false;
      profile.lastInjectedAt = new Date().toISOString();
      saveConfig(config);
      console.log(`✅ [${profile.name}] ${result.message}`);
      return;
    }
    case "status": {
      const selector = values.slice(1).join(" ");
      if (selector) {
        const profile = resolveClaudeProfile(config, selector);
        console.log(`${profile.name} (${profile.id})`);
        console.log(`home: ${profile.claudeHome}`);
        console.log(`gateway: ${profileGatewayLabel(config, profile)}`);
        console.log(`auth: ${profile.authState ?? "not_seen"}`);
      } else {
        printClaudeProfiles(config);
      }
      return;
    }
    case "run": {
      const separator = values.indexOf("--");
      const selectorValues = separator === -1 ? values.slice(1, 2) : values.slice(1, separator);
      const claudeArgs = separator === -1 ? values.slice(2) : values.slice(separator + 1);
      const profile = resolveClaudeProfile(config, selectorValues.join(" ") || undefined);
      await runClaudeProfile(profile, config, claudeArgs, { realClaude: process.env.FROGP_REAL_CLAUDE?.trim() || undefined });
    }
    case "grants":
      await handleClaudeGrantsCommand(values, config);
      return;
    case "auth":
      await handleClaudeAuthCommand(values, config);
      return;
    default:
      console.error("Usage: frogp claude list|add|rename|remove|inject|refresh|reload-models|restore|status|run|project|grants|auth ...");
      process.exit(1);
  }
}

// ── claude grant CLI (Branch-B: isolated Claude subscription grants) ─────────

type GrantLifecycleState = ClaudeGrantStatusState | "dangling";

/** Quote a value for a copy-paste shell command line without altering already-safe tokens. */
function grantShellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Provider names bound to `grantId` via `authMode: "claude-grant"`. */
function boundProvidersForGrant(config: ReturnType<typeof loadConfig>, grantId: string): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.authMode === "claude-grant" && provider.claudeGrantId === grantId)
    .map(([name]) => name)
    .sort();
}

/** True when the grant's scoped dir exists and its marker binds this exact id (else the grant is dangling). */
function grantIsBound(grant: ClaudeGrantRecord): boolean {
  try {
    return existsSync(grant.configDir) && readGrantMarker(grant.configDir)?.id === grant.id;
  } catch {
    return false;
  }
}

/**
 * Resolve a grant's lifecycle state for the read-only surfaces (status / list / local probe-b).
 * Delegates to the core scoped-origin `inspectClaudeGrantStatus` (darwin scoped Keychain, else the
 * in-root credential file) — never a native home or the global/unscoped Keychain — and never reads or
 * fingerprints the raw access token. A grant whose scoped dir/marker is gone is `dangling` and no
 * credential is touched. Only `state`/`expiresAt` are surfaced; no token, service, or path text.
 */
function resolveGrantLifecycle(config: ReturnType<typeof loadConfig>, grant: ClaudeGrantRecord): { state: GrantLifecycleState; expiresAt?: number } {
  if (!grantIsBound(grant)) return { state: "dangling" };
  try {
    return inspectClaudeGrantStatus(config, grant);
  } catch {
    return { state: "unreadable" };
  }
}

function optionValue(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  if (index === -1) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

async function handleClaudeGrantsCommand(values: string[], config: ReturnType<typeof loadConfig>): Promise<void> {
  const sub = values[1] ?? "list";
  switch (sub) {
    case "list": {
      const grants = listClaudeGrants(config);
      if (grants.length === 0) {
        console.log("No Claude grants. Create one with: frogp claude grants add <label>");
        return;
      }
      for (const grant of grants) {
        const bound = boundProvidersForGrant(config, grant.id);
        const providers = bound.length > 0 ? `  providers=${bound.join(",")}` : "";
        console.log(`${grant.id}  ${grant.label}  created=${grant.createdAt}${providers}`);
      }
      return;
    }
    case "add": {
      const label = values.slice(2).filter(value => value !== "--" && !value.startsWith("--")).join(" ").trim();
      if (!label) {
        console.error("Usage: frogp claude grants add <label>");
        process.exit(1);
      }
      const explicitRealClaude = process.env.FROGP_REAL_CLAUDE?.trim();
      let realClaude: string;
      try {
        // FROGP_REAL_CLAUDE, when set, is asserted verbatim (a bad value is a hard error — never a
        // silent PATH fallback); otherwise resolve a real claude off PATH, skipping our shims + grants.
        realClaude = explicitRealClaude
          ? assertRealClaudeExecutable(explicitRealClaude)
          : assertRealClaudeExecutable(findRealClaudeExecutable([claudeLauncherBinDir(), grantsRoot()]));
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
        console.error("Install Claude Code (a real absolute `claude` executable) or set FROGP_REAL_CLAUDE to its absolute path, then retry. frogprogsy never logs in for you and never uses a bare `claude` or a managed launcher.");
        process.exit(1);
      }
      const grant = addClaudeGrant(config, { label });
      saveConfig(config);
      const login = buildClaudeGrantLoginCommand({ grant, realClaude });
      console.log(`✅ Claude grant created: ${grant.label} (${grant.id})`);
      console.log(`   scoped Keychain service: ${login.expectedService}`);
      console.log("");
      console.log("Run this login yourself in a terminal — frogprogsy will not run it and will not open a browser:");
      console.log("");
      console.log(`   CLAUDE_CONFIG_DIR=${grantShellQuote(login.configDir)} \\`);
      console.log(`     ${grantShellQuote(login.command)} ${login.args.map(grantShellQuote).join(" ")}`);
      console.log("");
      console.log("It uses your verified real Claude executable and an isolated CLAUDE_CONFIG_DIR; it never touches your native ~/.claude home or the global Keychain login.");
      console.log(`After logging in, verify with: frogp claude grants status ${grant.id}`);
      return;
    }
    case "remove": {
      const force = values.includes("--force");
      const selector = values.slice(2).filter(value => value !== "--force").join(" ").trim();
      if (!selector) {
        console.error("Usage: frogp claude grants remove <id-or-label> [--force]");
        process.exit(1);
      }
      let grant: ClaudeGrantRecord;
      try {
        grant = resolveClaudeGrant(config, selector);
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      const bound = boundProvidersForGrant(config, grant.id);
      if (bound.length > 0 && !force) {
        console.error(`❌ Claude grant ${grant.id} is still bound to provider(s): ${bound.join(", ")}.`);
        console.error("Rebind those providers first, or re-run with --force to remove the grant and leave those bindings dangling. frogprogsy will not re-bind them automatically.");
        process.exit(1);
      }
      try {
        assertClaudeGrantRemovalSafe(config, grant.id);
      } catch {
        console.error(`❌ Claude grant ${grant.id} failed its directory/marker safety preflight; nothing was deleted.`);
        process.exit(1);
      }
      // Clean up the grant's scoped credential FIRST so a removed grant never orphans a local secret.
      // Only the grant's exact scoped Keychain service / in-root `.credentials.json` is touched — never
      // a native Claude home, the global Keychain login, or another grant. If cleanup fails, the grant
      // metadata + dir are kept intact and nothing is revoked server-side at Anthropic.
      try {
        await deleteClaudeGrantCredential(grant);
      } catch {
        console.error(`❌ Could not remove the scoped local credential for Claude grant ${grant.id}; the grant was left intact.`);
        console.error("frogprogsy never deletes the grant record while its local credential cleanup fails, and never revokes anything server-side at Anthropic. Resolve the Keychain/file error and retry.");
        process.exit(1);
      }
      let removed: ClaudeGrantRecord;
      try {
        removed = removeClaudeGrant(config, grant.id);
        saveConfig(config);
      } catch {
        console.error(`❌ Claude grant ${grant.id} could not be removed after scoped credential cleanup.`);
        console.error("The grant record was kept. Check the grant directory marker and local filesystem permissions, then retry.");
        process.exit(1);
      }
      console.log(`✅ Claude grant removed: ${removed.label} (${removed.id})`);
      console.log("   Local only: the grant's scoped credential was deleted from this machine. frogprogsy performed no server-side revocation at Anthropic — manage the subscription/session there separately.");
      if (bound.length > 0) {
        console.log(`⚠️  Provider(s) ${bound.join(", ")} now reference a missing grant (dangling). Rebind with: frogp providers set <name> --auth claude-grant --grant <id>. No auto-rebind was performed.`);
      }
      return;
    }
    case "status": {
      const selector = values.slice(2).join(" ").trim();
      let grants: ClaudeGrantRecord[];
      if (selector) {
        try {
          grants = [resolveClaudeGrant(config, selector)];
        } catch (error) {
          console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      } else {
        grants = listClaudeGrants(config);
      }
      if (grants.length === 0) {
        console.log("No Claude grants.");
        return;
      }
      for (const grant of grants) {
        const { state, expiresAt } = resolveGrantLifecycle(config, grant);
        const bound = boundProvidersForGrant(config, grant.id);
        const providers = bound.length > 0 ? `  providers=${bound.join(",")}` : "";
        const expiry = expiresAt !== undefined ? `  expiresAt=${expiresAt}` : "";
        console.log(`${grant.id}  ${grant.label}: ${state}${expiry}${providers}`);
      }
      return;
    }
    default:
      console.error("Usage: frogp claude grants list|add <label>|remove <id-or-label> [--force]|status [id-or-label]");
      process.exit(1);
  }
}

/** Provider names bound to `grantId` via `authMode: "claude-grant"` whose adapter speaks Anthropic. */
function boundAnthropicProvidersForGrant(config: ReturnType<typeof loadConfig>, grantId: string): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.authMode === "claude-grant" && provider.claudeGrantId === grantId && provider.adapter === "anthropic")
    .map(([name]) => name)
    .sort();
}

/** Emit a typed, network-free live-probe guidance message (redacted json to stdout, human to stderr). */
function emitProbeGuidance(json: boolean, grantId: string, status: string, summary: string, guidance: string): void {
  if (json) {
    printJson({ grant: grantId, mode: "live", status });
  } else {
    console.error(`❌ ${summary}`);
    console.error(guidance);
  }
}

async function handleClaudeAuthCommand(values: string[], config: ReturnType<typeof loadConfig>): Promise<void> {
  const sub = values[1];
  if (sub !== "probe-b") {
    console.error("Usage: frogp claude auth probe-b --grant <id> [--live --yes] [--json] [--provider <name>]");
    process.exit(1);
  }
  const json = values.includes("--json");
  const live = values.includes("--live");
  const yes = values.includes("--yes");
  const grantSelector = optionValue(values, "--grant");
  if (!grantSelector) {
    console.error("Usage: frogp claude auth probe-b --grant <id> [--live --yes] [--json] [--provider <name>]");
    process.exit(1);
  }
  let grant: ClaudeGrantRecord;
  try {
    grant = resolveClaudeGrant(config, grantSelector);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Non-live: inspect only the grant's scoped lifecycle state. This path never asks the broker for
  // an access token, never refreshes, never fingerprints credential bytes, and performs no network I/O.
  if (!live) {
    const lifecycle = resolveGrantLifecycle(config, grant);
    const payload = {
      grant: grant.id,
      mode: "local",
      status: lifecycle.state,
      ...(lifecycle.expiresAt !== undefined ? { expiresAt: lifecycle.expiresAt } : {}),
    };
    if (json) {
      printJson(payload);
    } else {
      console.log(`grant ${grant.id} (${grant.label}) probe-b [local]: ${lifecycle.state}`);
      if (lifecycle.expiresAt !== undefined) console.log(`   expiresAt=${lifecycle.expiresAt}`);
      console.log("   local inspection only; no credential bytes were read, refreshed, fingerprinted, or sent");
    }
    return;
  }

  // A live probe requires explicit --yes consent. Copy intentionally spells out the ToS/quota risk.
  if (!yes) {
    if (json) {
      printJson({ grant: grant.id, mode: "live", status: "consent_required", consent: false });
    } else {
      console.error("Refusing --live probe-b without explicit --yes consent.");
      console.error("A live probe-b would send a request to Anthropic using this grant's subscription credential.");
      console.error("Risks: it may count against your Claude subscription quota/usage, and automated probing may violate Anthropic's Terms of Service and put the account at risk.");
      console.error("It never runs a login and never opens a browser. Re-run with --live --yes only if you accept these risks.");
    }
    process.exit(2);
  }

  // live && yes: pick the bound Anthropic provider, then verify two real Anthropic surfaces with the
  // bound grant ONLY. No fallback to a forwarded header, API key, OAuth login, or another provider.
  const providerSelector = optionValue(values, "--provider");
  const bound = boundAnthropicProvidersForGrant(config, grant.id);
  let providerName: string;
  if (providerSelector !== undefined) {
    if (!bound.includes(providerSelector)) {
      emitProbeGuidance(json, grant.id, "provider_not_bound",
        `Provider ${JSON.stringify(providerSelector)} is not an Anthropic provider bound to Claude grant ${grant.id}.`,
        `Bind it first (frogp providers set ${providerSelector} --auth claude-grant --grant ${grant.id}) or pass a --provider that is bound. No network request was made.`);
      process.exit(2);
    }
    providerName = providerSelector;
  } else if (bound.length === 1) {
    providerName = bound[0];
  } else if (bound.length === 0) {
    emitProbeGuidance(json, grant.id, "not_bound",
      `Claude grant ${grant.id} is not bound to any Anthropic provider.`,
      `Bind one first: frogp providers set <name> --auth claude-grant --grant ${grant.id}. No network request was made.`);
    process.exit(2);
  } else {
    emitProbeGuidance(json, grant.id, "provider_ambiguous",
      `Claude grant ${grant.id} is bound to multiple providers (${bound.join(", ")}).`,
      "Choose one explicitly with --provider <name>. No network request was made.");
    process.exit(2);
  }

  const provider = config.providers[providerName]!;
  try {
    const result = await runClaudeGrantLiveProbe(config, providerName, provider);
    const payload = {
      grant: grant.id,
      provider: providerName,
      mode: "live",
      status: "pass",
      modelsStatus: result.status,
      modelCount: result.modelCount,
      modelId: result.modelId,
      messageStatus: result.messageStatus,
      token: result.tokenFingerprint,
    };
    if (json) {
      printJson(payload);
    } else {
      console.log(`grant ${grant.id} (${grant.label}) probe-b [live] via ${providerName}: PASS`);
      console.log(`   GET /v1/models: ${result.status} (${result.modelCount} models); model ${result.modelId}`);
      console.log(`   POST /v1/messages: ${result.messageStatus} (max_tokens=1, Claude Code identity)`);
      console.log(`   access token: sha256=${result.tokenFingerprint.sha256_8} len=${result.tokenFingerprint.length} (redacted)`);
      console.log("   Verified live against Anthropic with the bound grant only; no fallback auth was used and no response body was stored.");
    }
    return;
  } catch (error) {
    const code = error instanceof ClaudeGrantProbeError ? error.code : "probe_failed";
    const payload = { grant: grant.id, provider: providerName, mode: "live", status: "fail", code };
    if (json) {
      printJson(payload);
    } else {
      console.error(`grant ${grant.id} (${grant.label}) probe-b [live] via ${providerName}: FAIL (${code})`);
      console.error("The live probe failed closed. frogprogsy did not substitute any other credential, provider, forwarded header, or API key, and stored no response body or token.");
    }
    process.exit(3);
  }
}

async function handleProvidersCommand(values: string[]): Promise<void> {
  const usage = "Usage: frogp providers set <name> --auth claude-grant --grant <id>";
  if (values[0] !== "set") {
    console.error(usage);
    process.exit(1);
  }
  const name = values[1];
  if (!name || name.startsWith("--")) {
    console.error(usage);
    process.exit(1);
  }
  const auth = optionValue(values, "--auth");
  const grantSelector = optionValue(values, "--grant");
  if (auth !== "claude-grant") {
    console.error(usage);
    console.error("Only --auth claude-grant is supported here; this command never modifies OAuth or API-key logins.");
    process.exit(1);
  }
  if (!grantSelector) {
    console.error(usage);
    process.exit(1);
  }
  const config = loadConfig();
  const provider = config.providers[name];
  if (!provider) {
    const known = Object.keys(config.providers).join(", ") || "(none)";
    console.error(`❌ Unknown provider: ${name}. Known providers: ${known}`);
    process.exit(1);
  }
  let grant: ClaudeGrantRecord;
  try {
    grant = resolveClaudeGrant(config, grantSelector);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  try {
    assertAllowedClaudeGrantTarget(provider);
  } catch {
    console.error("❌ Claude grants may be bound only to an Anthropic adapter targeting https://api.anthropic.com.");
    console.error("No provider settings were changed.");
    process.exit(1);
  }
  provider.authMode = "claude-grant";
  provider.claudeGrantId = grant.id;
  saveConfig(config);
  console.log(`✅ Provider ${name} bound to Claude grant ${grant.label} (${grant.id}).`);
  console.log("   auth mode: claude-grant (isolated subscription grant; OAuth/API-key logins untouched)");
  console.log(`   Verify the grant is logged in with: frogp claude grants status ${grant.id}`);
}

switch (command) {
  case "init": {
    const { runInit } = await import("./init");
    await runInit();
    break;
  }
  case "start":
    await handleStart();
    break;
  case "stop":
    handleStop();
    break;
  case "restore": {
    const r = restoreAllClaudeRouting();
    if (!r.success) {
      console.error(`❌ ${r.message}`);
      process.exit(1);
    }
    console.log(`✅ ${r.message}`);
    console.log("Plain `claude` now runs natively (no proxy).");
    break;
  }

  case "uninstall":
    await handleUninstall();
    break;
  case "status":
    await handleStatus(args.slice(1));
    break;
  case "models":
    await handleModels(args.slice(1));
    break;
  case "doctor":
    await handleDoctor(args.slice(1));
    break;
  case "refresh":
    await handleRefresh();
    break;
  case "claude":
    await handleClaudeCommand(args.slice(1));
    break;
  case "providers":
    await handleProvidersCommand(args.slice(1));
    break;
  case "login": {
    const { handleLogin } = await import("./oauth/login-cli");
    await handleLogin(args[1]);
    break;
  }
  case "logout": {
    const { loadAuthStore, removeCredential } = await import("./oauth/store");
    const name = (args[1] ?? "").trim().toLowerCase();
    const store = loadAuthStore();
    const loginList = Object.keys(store).length > 0 ? Object.keys(store).join(", ") : "(none)";
    if (!name) {
      console.error(`Usage: frogp logout <provider>\n  Stored logins: ${loginList}`);
      process.exit(1);
    }
    if (!store[name]) {
      console.error(`Not logged in to ${name}.\n  Stored logins: ${loginList}`);
      process.exit(1);
    }
    removeCredential(name);
    console.log(`✅ Logged out of ${name}.`);
    break;
  }

  case "gui": {
    const cfg = await import("./config");
    if (!cfg.readPid()) {
      console.log("Proxy not running. Starting...");
      const child = spawn(process.execPath, [process.argv[1], "start"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      const started = await waitForProxy();
      if (!started) {
        console.error("❌ Proxy did not become healthy. Check: frogp status");
        process.exit(1);
      }
    }
    const config = cfg.loadConfig();
    const port = cfg.readActivePort() ?? config.port ?? DEFAULT_PORT;
    const guiUrl = `http://localhost:${port}`;
    console.log(`Opening ${guiUrl}`);
    const { openUrl } = await import("./open-url");
    openUrl(guiUrl);
    break;
  }
  case "update": {
    const noRestart = args.includes("--no-restart");
    const { runUpdate } = await import("./update");
    await runUpdate(noRestart);
    break;
  }
  case "version":
  case "--version":
  case "-v": {
    const devBuildId = installedDevBuildId();
    console.log(`frogprogsy v${cliVersion()}${devBuildId ? ` dev ${devBuildId}` : ""}`);
    break;
  }
  case "help": {
    const topic = args[1];
    if (topic !== undefined && !printSubcommandUsage(topic)) {
      console.error(`Unknown help topic: ${topic}`);
      const suggestion = suggestCommand(topic);
      if (suggestion) console.error(`Did you mean: frogp help ${suggestion}?`);
      process.exit(1);
    }
    if (topic === undefined) printUsage();
    break;
  }
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  case "__watchdog": {
    // Hidden subcommand — not in printUsage. Arms the supervision loop.
    const parentIdx = args.indexOf("--parent");
    const portIdx = args.indexOf("--port");
    const parentPidHint = parentIdx !== -1 ? parseInt(args[parentIdx + 1], 10) : undefined;
    const portHint = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : undefined;
    const { runWatchdog } = await import("./watchdog");
    await runWatchdog({
      parentPidHint: parentPidHint !== undefined && !isNaN(parentPidHint) ? parentPidHint : undefined,
      portHint: portHint !== undefined && !isNaN(portHint) ? portHint : undefined,
    });
    break;
  }
  default: {
    const paint = shouldColor(process.env as Record<string, string | undefined>, process.stderr.isTTY === true);
    console.error(errorText(`Unknown command: ${command}`, paint));
    const suggestion = suggestCommand(command);
    if (suggestion) console.error(warn(`Did you mean: frogp ${suggestion}?`, paint));
    printUsage();
    process.exit(1);
  }
}
