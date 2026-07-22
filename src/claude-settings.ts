import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, ensureConfigDirForWrite, getConfigDir } from "./config";
import { assertSafeClaudeHomeWrite, CLAUDE_HOME, resolveClaudeCodeHome } from "./claude-paths";
import { mergeClaudeProfileHeader, removeClaudeProfileHeader } from "./claude-profiles";
import { ensureClaudeProjectSettingsExcluded } from "./claude-projects";
import type { GatewayAuthCarrier } from "./types";

export const CLAUDE_SETTINGS_PATH = join(CLAUDE_HOME, "settings.json");

export function claudeSettingsFilePath(claudeHome?: string): string {
  return join(resolveClaudeCodeHome(claudeHome), "settings.json");
}

export const CLAUDE_SETTINGS_BACKUP_PATH = join(getConfigDir(), "claude-settings-backup.json");

function claudeSettingsBackupPath(profileId?: string): string {
  return profileId
    ? join(getConfigDir(), "claude-profiles", profileId, "claude-settings-backup.json")
    : join(getConfigDir(), "claude-settings-backup.json");
}

export function claudeProjectSettingsFilePath(projectPath: string): string {
  return join(canonicalProjectPath(projectPath), ".claude", "settings.local.json");
}

function canonicalProjectPath(projectPath: string): string {
  return realpathSync.native(resolve(projectPath));
}

function claudeProjectSettingsBackupPath(settingsPath: string): string {
  const digest = createHash("sha256").update(settingsPath).digest("hex").slice(0, 32);
  return join(getConfigDir(), "claude-projects", "settings-backups", `${digest}.json`);
}

export const OWNED_CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

type OwnedKey = typeof OWNED_CLAUDE_ENV_KEYS[number];

export interface ClaudeSettingsBackup {
  schemaVersion: 1;
  settingsPath: string;
  profileId?: string;
  claudeHome?: string;
  env: Record<OwnedKey, { existed: boolean; value?: string }>;
}

export const LOCAL_CLAUDE_AUTH_TOKEN = "local-frogprogsy";
const ROUTED_MODEL_PREFIX = "claude-frogp-";

function isRoutedClaudeCodeModel(model: string): boolean {
  return model.startsWith(ROUTED_MODEL_PREFIX);
}

function removeRoutedClaudeCodeModel(settings: Record<string, unknown>): { settings: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...settings };
  const model = next.model;
  if (typeof model === "string" && isRoutedClaudeCodeModel(model)) {
    delete next.model;
    return { settings: next, changed: true };
  }
  return { settings: next, changed: false };
}


function isLocalFrogProgsyBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value.trim());
}

export function removeOrphanedFrogProgsySettings(settings: Record<string, unknown>): { settings: Record<string, unknown>; changed: boolean } {
  const stripped = removeRoutedClaudeCodeModel(settings);
  const next: Record<string, unknown> = stripped.settings;
  const env = isRecord(next.env) ? { ...next.env } : {};
  let changed = stripped.changed;
  let removedFrogProxyEnv = false;
  const customHeaders = typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" ? env.ANTHROPIC_CUSTOM_HEADERS : undefined;
  const hasProfileHeader = customHeaders !== undefined && removeClaudeProfileHeader(customHeaders) !== customHeaders;
  const hasFrogProgsyMarker = stripped.changed
    || env.ANTHROPIC_AUTH_TOKEN === LOCAL_CLAUDE_AUTH_TOKEN
    || env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1"
    || hasProfileHeader;

  if (isLocalFrogProgsyBaseUrl(env.ANTHROPIC_BASE_URL) && hasFrogProgsyMarker) {
    delete env.ANTHROPIC_BASE_URL;
    changed = true;
    removedFrogProxyEnv = true;
  }

  if (env.ANTHROPIC_AUTH_TOKEN === LOCAL_CLAUDE_AUTH_TOKEN) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    changed = true;
    removedFrogProxyEnv = true;
  }

  if ((removedFrogProxyEnv || stripped.changed || hasProfileHeader) && env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1") {
    delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
    changed = true;
  }

  if ((removedFrogProxyEnv || hasProfileHeader) && typeof env.ANTHROPIC_CUSTOM_HEADERS === "string") {
    const withoutProfile = removeClaudeProfileHeader(env.ANTHROPIC_CUSTOM_HEADERS);
    if (withoutProfile) env.ANTHROPIC_CUSTOM_HEADERS = withoutProfile;
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
    changed = true;
  }

  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return { settings: next, changed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ClaudeSettingsInjectionOptions {
  /** Explicit per-invocation sentinel override: force the local discovery token regardless of carrier. */
  includeAuthToken?: boolean;
  /** Configured carrier. Absent => token-free (default); "sentinel" injects the local discovery token. */
  gatewayAuthCarrier?: GatewayAuthCarrier;
  claudeHome?: string;
  profileId?: string;
}

/**
 * Resolve whether the local frogprogsy discovery sentinel token should be injected. Token-free is the
 * default; the sentinel is injected ONLY when a caller explicitly opts in per-invocation
 * (`includeAuthToken === true`) or the configured carrier is "sentinel". This is the single decision point
 * for sentinel injection — see the static guard in tests/claude-settings-inject.test.ts.
 */
function shouldInjectSentinelAuthToken(options: { includeAuthToken?: boolean; gatewayAuthCarrier?: GatewayAuthCarrier }): boolean {
  if (options.includeAuthToken === true) return true;
  return options.gatewayAuthCarrier === "sentinel";
}

export function buildClaudeCodeEnv(port: number, options: ClaudeSettingsInjectionOptions = {}): Partial<Record<OwnedKey, string>> {
  const includeAuthToken = shouldInjectSentinelAuthToken(options);
  return {
    ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    ...(includeAuthToken ? { ANTHROPIC_AUTH_TOKEN: LOCAL_CLAUDE_AUTH_TOKEN } : {}),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ...(options.profileId ? { ANTHROPIC_CUSTOM_HEADERS: mergeClaudeProfileHeader(undefined, options.profileId) } : {}),
  };
}

export interface ClaudeGatewayState {
  settingsPath: string;
  settingsFound: boolean;
  applied: boolean;
  expectedBaseUrl: string;
  actualBaseUrl: string | undefined;
  baseUrlMatchesExpected: boolean;
  gatewayDiscovery: boolean;
  profileHeaderMatches: boolean;
  authToken: "set_redacted" | "not_set";
  /**
   * Active gateway auth carrier observed in the settings: "sentinel" when the local frogprogsy discovery
   * token is present, otherwise "token-free". Independent of `authToken` (a user's own token still reads as
   * token-free) and of `modelDiscoveryReady`.
   */
  carrier: GatewayAuthCarrier;
  modelDiscoveryReady: boolean;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function customHeadersContainProfile(raw: unknown, profileId: string | undefined): boolean {
  if (!profileId) return true;
  if (typeof raw !== "string") return false;
  const expected = `x-frogp-claude-profile: ${profileId}`.toLowerCase();
  return raw.split(/\r?\n/).some(line => line.trim().toLowerCase() === expected);
}

function customHeadersMatchProjectProfile(raw: unknown, profileId: string | undefined): boolean {
  if (profileId) return customHeadersContainProfile(raw, profileId);
  if (typeof raw !== "string") return true;
  return removeClaudeProfileHeader(raw) === raw;
}

/**
 * Derive the active carrier from the settings env. "sentinel" only when the EXACT local frogprogsy
 * discovery token is present; a user's own ANTHROPIC_AUTH_TOKEN reads as "token-free".
 */
function resolveObservedGatewayCarrier(env: Record<string, unknown>): GatewayAuthCarrier {
  return env.ANTHROPIC_AUTH_TOKEN === LOCAL_CLAUDE_AUTH_TOKEN ? "sentinel" : "token-free";
}

/**
 * Model discovery is ready once the gateway markers are applied. Token-free relies on the native OAuth
 * bearer passthrough, so it does NOT require an auth token in settings. Sentinel still requires its local
 * discovery token to be present.
 */
function resolveModelDiscoveryReady(applied: boolean, carrier: GatewayAuthCarrier, authTokenSet: boolean): boolean {
  return applied && (carrier === "token-free" || authTokenSet);
}

export function readClaudeGatewayState(port: number, options: { claudeHome?: string; profileId?: string } = {}): ClaudeGatewayState {
  const settingsPath = claudeSettingsFilePath(options.claudeHome);
  const settingsFound = existsSync(settingsPath);
  let settings: Record<string, unknown> = {};
  if (settingsFound) {
    try {
      settings = readJsonFile(settingsPath);
    } catch {
      settings = {};
    }
  }
  const env = isRecord(settings.env) ? settings.env : {};
  const expectedBaseUrl = buildClaudeCodeEnv(port).ANTHROPIC_BASE_URL ?? `http://localhost:${port}`;
  const actualBaseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : undefined;
  const baseUrlMatchesExpected = typeof actualBaseUrl === "string" && stripTrailingSlash(actualBaseUrl.trim()) === expectedBaseUrl;
  const gatewayDiscovery = env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1";
  const profileHeaderMatches = customHeadersContainProfile(env.ANTHROPIC_CUSTOM_HEADERS, options.profileId);
  const authTokenSet = typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.trim() !== "";
  const carrier = resolveObservedGatewayCarrier(env);
  const applied = baseUrlMatchesExpected && gatewayDiscovery && profileHeaderMatches;
  return {
    settingsPath,
    settingsFound,
    applied,
    expectedBaseUrl,
    actualBaseUrl,
    baseUrlMatchesExpected,
    gatewayDiscovery,
    profileHeaderMatches,
    authToken: typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? "set_redacted" : "not_set",
    carrier,
    modelDiscoveryReady: resolveModelDiscoveryReady(applied, carrier, authTokenSet),
  };
}

export function mergeClaudeCodeSettings(
  settings: Record<string, unknown>,
  port: number,
  existingBackup?: ClaudeSettingsBackup | null,
  options: ClaudeSettingsInjectionOptions = {},
): { settings: Record<string, unknown>; backup: ClaudeSettingsBackup } {
  const settingsPath = claudeSettingsFilePath(options.claudeHome);
  const baseline = existingBackup ? settings : removeOrphanedFrogProgsySettings(settings).settings;
  const originalEnv = isRecord(baseline.env) ? baseline.env : {};
  const next: Record<string, unknown> = { ...baseline };
  const env = isRecord(next.env) ? { ...next.env } : {};
  const desired = buildClaudeCodeEnv(port, options);
  const backup: ClaudeSettingsBackup = existingBackup ?? {
    schemaVersion: 1,
    settingsPath,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.claudeHome ? { claudeHome: resolveClaudeCodeHome(options.claudeHome) } : {}),
    env: {} as ClaudeSettingsBackup["env"],
  };

  for (const key of OWNED_CLAUDE_ENV_KEYS) {
    if (!(key in backup.env)) {
      const value = originalEnv[key];
      backup.env[key] = typeof value === "string"
        ? { existed: true, value }
        : { existed: false };
    }
  }

  env.ANTHROPIC_BASE_URL = desired.ANTHROPIC_BASE_URL;
  if (desired.ANTHROPIC_AUTH_TOKEN !== undefined) env.ANTHROPIC_AUTH_TOKEN = desired.ANTHROPIC_AUTH_TOKEN;
  else if (env.ANTHROPIC_AUTH_TOKEN === LOCAL_CLAUDE_AUTH_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = desired.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  if (options.profileId) {
    env.ANTHROPIC_CUSTOM_HEADERS = mergeClaudeProfileHeader(typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" ? env.ANTHROPIC_CUSTOM_HEADERS : undefined, options.profileId);
  }

  next.env = env;
  return { settings: next, backup };
}

export function restoreClaudeCodeSettingsFromBackup(
  settings: Record<string, unknown>,
  backup: ClaudeSettingsBackup,
): Record<string, unknown> {
  const next: Record<string, unknown> = removeRoutedClaudeCodeModel(settings).settings;
  const env = isRecord(next.env) ? { ...next.env } : {};
  for (const key of OWNED_CLAUDE_ENV_KEYS) {
    const entry = backup.env[key];
    if (!entry || !entry.existed) delete env[key];
    else env[key] = entry.value ?? "";
  }
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function readBackup(profileId?: string): ClaudeSettingsBackup | null {
  const backupPath = claudeSettingsBackupPath(profileId);
  if (!existsSync(backupPath)) return null;
  const parsed = JSON.parse(readFileSync(backupPath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.env)) return null;
  return parsed as unknown as ClaudeSettingsBackup;
}

function readBackupPath(backupPath: string): ClaudeSettingsBackup | null {
  if (!existsSync(backupPath)) return null;
  const parsed = JSON.parse(readFileSync(backupPath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.env)) return null;
  return parsed as unknown as ClaudeSettingsBackup;
}

function writeJson(path: string, value: unknown, operation: string): void {
  if (path.startsWith(getConfigDir())) ensureConfigDirForWrite(operation);
  else assertSafeClaudeHomeWrite(operation, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, JSON.stringify(value, null, 2) + "\n");
}

function writeProjectJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, JSON.stringify(value, null, 2) + "\n");
}

export function injectClaudeCodeSettings(port: number, options: ClaudeSettingsInjectionOptions = {}): { success: boolean; message: string } {
  try {
    const profileId = options.profileId;
    const backupPath = claudeSettingsBackupPath(profileId);
    const settingsPath = claudeSettingsFilePath(options.claudeHome);
    const settings = readJsonFile(settingsPath);
    const existingBackup = readBackup(profileId);
    const { settings: next, backup } = mergeClaudeCodeSettings(settings, port, existingBackup, options);
    writeJson(backupPath, backup, "write Claude settings backup");
    writeJson(settingsPath, next, "write Claude settings");
    return {
      success: true,
      message: `Injected frogprogsy env into Claude Code settings at ${settingsPath}. Backup: ${backupPath}.`,
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export interface ClaudeProjectSettingsOptions {
  projectPath: string;
  routingProfileId?: string;
  skipGitProtection?: boolean;
  /** Explicit per-invocation sentinel override for this project enrollment. */
  includeAuthToken?: boolean;
  /** Configured carrier threaded from FrogConfig.gatewayAuthCarrier. Absent => token-free (default). */
  gatewayAuthCarrier?: GatewayAuthCarrier;
}

export function mergeClaudeProjectSettings(
  settings: Record<string, unknown>,
  port: number,
  existingBackup: ClaudeSettingsBackup | null | undefined,
  options: ClaudeProjectSettingsOptions,
): { settings: Record<string, unknown>; backup: ClaudeSettingsBackup } {
  const settingsPath = claudeProjectSettingsFilePath(options.projectPath);
  const profileId = options.routingProfileId?.trim() || undefined;
  const merged = mergeClaudeCodeSettings(settings, port, existingBackup, {
    ...(options.includeAuthToken !== undefined ? { includeAuthToken: options.includeAuthToken } : {}),
    ...(options.gatewayAuthCarrier ? { gatewayAuthCarrier: options.gatewayAuthCarrier } : {}),
    ...(profileId ? { profileId } : {}),
  });
  const projectSettings = merged.settings;
  if (!profileId && isRecord(projectSettings.env)) {
    const env = { ...projectSettings.env };
    const withoutProfile = removeClaudeProfileHeader(typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" ? env.ANTHROPIC_CUSTOM_HEADERS : undefined);
    if (withoutProfile) env.ANTHROPIC_CUSTOM_HEADERS = withoutProfile;
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
    if (Object.keys(env).length > 0) projectSettings.env = env;
    else delete projectSettings.env;
  }
  if (!existingBackup) {
    merged.backup.settingsPath = settingsPath;
  }
  delete merged.backup.profileId;
  delete merged.backup.claudeHome;
  return merged;
}

export function injectClaudeProjectSettings(port: number, options: ClaudeProjectSettingsOptions): { success: boolean; message: string } {
  try {
    if (options.skipGitProtection !== true) ensureClaudeProjectSettingsExcluded(options.projectPath);
    const settingsPath = claudeProjectSettingsFilePath(options.projectPath);
    const backupPath = claudeProjectSettingsBackupPath(settingsPath);
    const settings = readJsonFile(settingsPath);
    const existingBackup = readBackupPath(backupPath);
    const { settings: next, backup } = mergeClaudeProjectSettings(settings, port, existingBackup, options);
    writeJson(backupPath, backup, "write Claude project settings backup");
    writeProjectJson(settingsPath, next);
    return {
      success: true,
      message: `Injected frogprogsy env into Claude Code project settings at ${settingsPath}. Backup: ${backupPath}.`,
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function restoreClaudeProjectSettings(projectPath: string): { success: boolean; message: string } {
  try {
    const settingsPath = claudeProjectSettingsFilePath(projectPath);
    const backupPath = claudeProjectSettingsBackupPath(settingsPath);
    const backup = readBackupPath(backupPath);
    const settings = readJsonFile(settingsPath);
    if (!backup) {
      const orphaned = removeOrphanedFrogProgsySettings(settings);
      if (!orphaned.changed) return { success: true, message: "No frogprogsy Claude Code project settings backup found." };
      writeProjectJson(settingsPath, orphaned.settings);
      return { success: true, message: `Removed orphaned frogprogsy Claude Code project settings at ${settingsPath}.` };
    }
    const restored = restoreClaudeCodeSettingsFromBackup(settings, backup);
    writeProjectJson(settingsPath, restored);
    try { ensureConfigDirForWrite("remove Claude project settings backup"); unlinkSync(backupPath); } catch { /* ignore */ }
    return { success: true, message: `Restored Claude Code project settings at ${settingsPath}.` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function clearClaudeProjectRoutingProfileHeader(projectPath: string, profileId?: string): { success: boolean; message: string } {
  try {
    const settingsPath = claudeProjectSettingsFilePath(projectPath);
    const settings = readJsonFile(settingsPath);
    const next: Record<string, unknown> = { ...settings };
    const env = isRecord(next.env) ? { ...next.env } : {};
    const current = typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" ? env.ANTHROPIC_CUSTOM_HEADERS : undefined;
    const withoutProfile = removeClaudeProjectProfileHeaderValue(current, profileId);
    if (withoutProfile === current) {
      return { success: true, message: `No matching Claude project routing profile header found at ${settingsPath}.` };
    }
    if (withoutProfile) env.ANTHROPIC_CUSTOM_HEADERS = withoutProfile;
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
    if (Object.keys(env).length > 0) next.env = env;
    else delete next.env;
    writeProjectJson(settingsPath, next);
    return { success: true, message: `Removed Claude project routing profile header at ${settingsPath}.` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function removeClaudeProjectProfileHeaderValue(existing: string | undefined, profileId?: string): string | undefined {
  if (!existing) return undefined;
  const wanted = profileId?.trim().toLowerCase();
  const entries: string[] = [];
  let changed = false;
  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    const name = index > 0 ? trimmed.slice(0, index).trim().toLowerCase() : "";
    const value = index > 0 ? trimmed.slice(index + 1).trim().toLowerCase() : "";
    const isProfileHeader = name === "x-frogp-claude-profile";
    const remove = isProfileHeader && (!wanted || value === wanted);
    if (remove) {
      changed = true;
      continue;
    }
    entries.push(trimmed);
  }
  if (!changed) return existing;
  return entries.length > 0 ? entries.join("\n") : undefined;
}

export function readClaudeProjectGatewayState(port: number, options: ClaudeProjectSettingsOptions): ClaudeGatewayState {
  const settingsPath = claudeProjectSettingsFilePath(options.projectPath);
  const settingsFound = existsSync(settingsPath);
  let settings: Record<string, unknown> = {};
  if (settingsFound) {
    try {
      settings = readJsonFile(settingsPath);
    } catch {
      settings = {};
    }
  }
  const env = isRecord(settings.env) ? settings.env : {};
  const expectedBaseUrl = buildClaudeCodeEnv(port).ANTHROPIC_BASE_URL ?? `http://localhost:${port}`;
  const actualBaseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : undefined;
  const baseUrlMatchesExpected = typeof actualBaseUrl === "string" && stripTrailingSlash(actualBaseUrl.trim()) === expectedBaseUrl;
  const gatewayDiscovery = env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1";
  const profileHeaderMatches = customHeadersMatchProjectProfile(env.ANTHROPIC_CUSTOM_HEADERS, options.routingProfileId);
  const authTokenSet = typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.trim() !== "";
  const carrier = resolveObservedGatewayCarrier(env);
  const applied = baseUrlMatchesExpected && gatewayDiscovery && profileHeaderMatches;
  return {
    settingsPath,
    settingsFound,
    applied,
    expectedBaseUrl,
    actualBaseUrl,
    baseUrlMatchesExpected,
    gatewayDiscovery,
    profileHeaderMatches,
    authToken: typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? "set_redacted" : "not_set",
    carrier,
    modelDiscoveryReady: resolveModelDiscoveryReady(applied, carrier, authTokenSet),
  };
}

export function restoreClaudeCodeSettings(options: { claudeHome?: string; profileId?: string } = {}): { success: boolean; message: string } {
  try {
    const backupPath = claudeSettingsBackupPath(options.profileId);
    const backup = readBackup(options.profileId);
    const settingsPath = claudeSettingsFilePath(options.claudeHome);
    const settings = readJsonFile(settingsPath);
    if (!backup) {
      const orphaned = removeOrphanedFrogProgsySettings(settings);
      if (!orphaned.changed) return { success: true, message: "No frogprogsy Claude Code settings backup found." };
      writeJson(settingsPath, orphaned.settings, "write Claude settings");
      return { success: true, message: `Removed orphaned frogprogsy Claude Code settings at ${settingsPath}.` };
    }
    const restored = restoreClaudeCodeSettingsFromBackup(settings, backup);
    writeJson(settingsPath, restored, "write Claude settings");
    try { ensureConfigDirForWrite("remove Claude settings backup"); unlinkSync(backupPath); } catch { /* ignore */ }
    return { success: true, message: `Restored Claude Code settings at ${settingsPath}.` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}
