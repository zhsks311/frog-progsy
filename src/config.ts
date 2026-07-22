import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { FrogConfig } from "./types";

let _atomicSeq = 0;
/**
 * Write a file atomically (temp + rename) so concurrent writers — e.g. `frogp stop` and the
 * proxy's own shutdown handler both restoring Claude Code — can never leave a half-written file.
 */
export function atomicWriteFile(path: string, content: string): void {
  const tmp = `${path}.frogp.${process.pid}.${++_atomicSeq}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

let resolvedConfigDirCache: { raw: string | undefined; path: string } | null = null;

function defaultConfigDir(): string {
  return join(homedir(), ".frogprogsy");
}

function resolveConfigDir(): string {
  const raw = process.env["FROGPROGSY_HOME"]?.trim() || undefined;
  if (resolvedConfigDirCache && resolvedConfigDirCache.raw === raw) return resolvedConfigDirCache.path;
  const path = raw ? resolve(raw) : defaultConfigDir();
  resolvedConfigDirCache = { raw, path };
  return path;
}

function isDefaultConfigDir(path: string): boolean {
  return resolve(path) === resolve(defaultConfigDir());
}
function isInsideDefaultConfigDir(path: string): boolean {
  const target = resolve(path);
  const root = resolve(defaultConfigDir());
  return target === root || target.startsWith(`${root}${sep}`);
}


export function assertSafeConfigDirWrite(operation: string): void {
  if (process.env.NODE_ENV !== "test") return;
  const configDir = resolveConfigDir();
  if (!isDefaultConfigDir(configDir)) return;
  throw new Error(`${operation} refused to write to ${configDir} while NODE_ENV=test. Set FROGPROGSY_HOME to an isolated temp directory.`);
}

export function ensureConfigDirForWrite(operation: string): string {
  assertSafeConfigDirWrite(operation);
  const configDir = resolveConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(configDir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  return configDir;
}

function resolveConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}

function resolvePidPath(): string {
  return join(resolveConfigDir(), "frogp.pid");
}

/**
 * Default featured subagent models (native GPT) seeded on a fresh install and when `subagentModels`
 * is unset. Claude Code's spawn_agent advertises the first 5 featured catalog entries; these are the GPT
 * natives the installed Claude Code actually ships. The user can remove any in the GUI — once they set the
 * list (even to []), it is respected, so removals persist (start-up only seeds the UNSET case).
 * Kept to ids ChatGPT accepts; the start-up seed prefers the live catalog's native slugs.
 */
export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-claude-spark"];

/** Default proxy listen port seeded on a fresh install and used as the product-wide fallback. */
export const DEFAULT_PORT = 3764;

export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getConfigPath(): string {
  return resolveConfigPath();
}

export function getPidPath(): string {
  return resolvePidPath();
}

export function hardenConfigDir(): void {
  const dir = resolveConfigDir();
  if (process.env.NODE_ENV === "test" && isDefaultConfigDir(dir)) return;
  if (existsSync(dir)) {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

export function hardenExistingSecret(path: string): void {
  if (process.env.NODE_ENV === "test" && isInsideDefaultConfigDir(path)) return;
  if (existsSync(path)) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
}

const RUNTIME_FIXTURE_PROVIDER_NAMES = new Set(["routed", "chatgpt", "anthropicForward"]);

function providerHost(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isRuntimeFixtureProvider(name: string, provider: FrogConfig["providers"][string] | undefined): boolean {
  if (!provider || !RUNTIME_FIXTURE_PROVIDER_NAMES.has(name)) return false;
  const host = providerHost(provider.baseUrl);
  if (name === "anthropicForward") {
    return provider.adapter === "anthropic" && provider.authMode === "forward" && host === "api.anthropic.com";
  }
  return host === "routed.test" || host === "chatgpt.test" || host.endsWith(".test");
}

export function dropRuntimeFixtureProviders(config: FrogConfig): string[] {
  const removed: string[] = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (!isRuntimeFixtureProvider(name, provider)) continue;
    delete config.providers[name];
    removed.push(name);
  }
  if (removed.length === 0) return removed;

  if (!config.providers[config.defaultProvider]) {
    const fallback = Object.keys(config.providers)[0];
    if (fallback) {
      config.defaultProvider = fallback;
    } else {
      const defaults = getDefaultConfig();
      config.providers = { ...defaults.providers };
      config.defaultProvider = defaults.defaultProvider;
      if (config.subagentModels === undefined && defaults.subagentModels) {
        config.subagentModels = [...defaults.subagentModels];
      }
    }
  }
  return removed;
}

export function loadConfig(): FrogConfig {
  const configDir = resolveConfigDir();
  const configPath = resolveConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(configDir, "auth.json"));
  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as FrogConfig;
  } catch {
    return getDefaultConfig();
  }
}

export function saveConfig(config: FrogConfig): void {
  const configDir = ensureConfigDirForWrite("saveConfig");
  const configPath = join(configDir, "config.json");
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function websocketsEnabled(_config: Pick<FrogConfig, "websockets">): boolean {
  return false;
}


export function getDefaultConfig(): FrogConfig {
  // Fresh-install fallback follows Claude Code's native provider shape: Anthropic Messages
  // with forward auth. It stores no upstream key and only relays allowlisted Anthropic
  // credentials if the incoming Claude Code request actually carries them. Claude
  // subscription login stays in Claude Code and is selected through `frogp claude` homes.
  return {
    port: DEFAULT_PORT,
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-sonnet-4-6",
      },
    },
    defaultProvider: "anthropic",
    subagentModels: [...DEFAULT_SUBAGENT_MODELS],
    websockets: false,
  };
}

export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) return process.env[match[1]];
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

export function writePid(pid: number): void {
  const configDir = ensureConfigDirForWrite("writePid");
  writeFileSync(join(configDir, "frogp.pid"), String(pid), "utf-8");
}

export function readPid(): number | null {
  const pidPath = resolvePidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);

    if (isNaN(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return pid;
      return null;
    }
  } catch {
    return null;
  }
}

export function removePid(): void {
  assertSafeConfigDirWrite("removePid");
  try {
    const { unlinkSync } = require("node:fs");
    unlinkSync(resolvePidPath());
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Active-port record — written by handleStart so the watchdog targets
// the real listen port (which may differ from config.port when an alternate
// port was chosen by findAvailablePort).
// ---------------------------------------------------------------------------

function resolveActivePortPath(): string {
  return join(resolveConfigDir(), "frogp.port");
}

export function activePortPath(): string {
  return resolveActivePortPath();
}

export function writeActivePort(port: number): void {
  const configDir = ensureConfigDirForWrite("writeActivePort");
  writeFileSync(join(configDir, "frogp.port"), String(port), "utf-8");
}

export function readActivePort(): number | null {
  const p = resolveActivePortPath();
  if (!existsSync(p)) return null;
  try {
    const n = parseInt(readFileSync(p, "utf-8").trim(), 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export function removeActivePort(): void {
  assertSafeConfigDirWrite("removeActivePort");
  try {
    const { unlinkSync } = require("node:fs");
    unlinkSync(resolveActivePortPath());
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Watchdog file paths
// ---------------------------------------------------------------------------

export function getWatchdogPidPath(): string {
  return join(resolveConfigDir(), "watchdog.pid");
}

export function getWatchdogStatusPath(): string {
  return join(resolveConfigDir(), "frogp-watchdog-status.json");
}

// ---------------------------------------------------------------------------
// Shutdown-intent marker — written before intentional proxy stop so the
// watchdog can distinguish a graceful shutdown from a crash (CX-4).
// ---------------------------------------------------------------------------

export interface ShutdownIntent {
  pid: number;
  timestamp: number;
}

const SHUTDOWN_INTENT_FILE = "frogp-shutdown.intent";

function resolveShutdownIntentPath(): string {
  return join(resolveConfigDir(), SHUTDOWN_INTENT_FILE);
}

export function writeShutdownIntent(pid: number): void {
  const configDir = ensureConfigDirForWrite("writeShutdownIntent");
  const intent: ShutdownIntent = { pid, timestamp: Date.now() };
  atomicWriteFile(join(configDir, SHUTDOWN_INTENT_FILE), JSON.stringify(intent) + "\n");
}

export function readShutdownIntent(): ShutdownIntent | null {
  const p = resolveShutdownIntentPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8").trim();
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      "timestamp" in parsed &&
      typeof (parsed as ShutdownIntent).pid === "number" &&
      typeof (parsed as ShutdownIntent).timestamp === "number"
    ) {
      return parsed as ShutdownIntent;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearShutdownIntent(): void {
  assertSafeConfigDirWrite("clearShutdownIntent");
  try {
    const { unlinkSync } = require("node:fs");
    unlinkSync(resolveShutdownIntentPath());
  } catch { /* ignore */ }
}
