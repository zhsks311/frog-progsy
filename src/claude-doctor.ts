import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { claudeExecutableCandidates, claudeLauncherBinDir, claudeLauncherFileName, findRealClaudeExecutable, isClaudeExecutableBasename, plannedClaudeLaunchers } from "./claude-launchers";
import { claudeGatewayModelsCachePath } from "./claude-paths";
import { readClaudeGatewayState, type ClaudeGatewayState } from "./claude-settings";
import { computeModelAliases } from "./model-aliases";
import { ensureClaudeProfiles } from "./claude-profiles";
import {
  getClaudeGrantById,
  grantsRoot,
  listClaudeGrants,
  readGrantMarker,
} from "./claude-grants";
import { inspectClaudeGrantStatus, type ClaudeGrantStatus, type ClaudeGrantStatusState } from "./claude-grant-auth";
import { DEFAULT_PORT } from "./config";
import type { ClaudeGrantRecord, ClaudeProfileRecord, FrogConfig } from "./types";

export type RawClaudeKind = "missing" | "managed_launcher" | "package_bin" | "cmux_shim" | "native" | "unknown";
export type GatewayCacheStatus = "healthy" | "missing" | "malformed";
export type FindingSeverity = "info" | "warning" | "error";

export interface FileSystemProbe {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf-8"): string;
  realpathSync(path: string): string;
}

const defaultFs: FileSystemProbe = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  realpathSync: (path) => realpathSync.native(path),
};

export interface RawClaudeResolution {
  command: "claude";
  kind: RawClaudeKind;
  path: string | null;
  realPath: string | null;
  pathEntry: string | null;
  reason: string;
}

export interface RealClaudeResolution {
  command: "claude";
  path: string;
}

export interface LauncherDiagnostic {
  command: string;
  profileId: string;
  profileName: string;
  claudeHome: string;
  path: string;
  installed: boolean;
  onPath: boolean;
}

export interface ProfileGatewayDiagnostic {
  profileId: string;
  profileName: string;
  claudeHome: string;
  state: ClaudeGatewayState;
  runCommand: string[];
  reloadCommand: string[];
}

export interface GatewayCacheDiagnostic {
  status: GatewayCacheStatus;
  path: string;
  /** Active loopback gateway URL recorded in the exact P1 cache schema (healthy only). */
  baseUrl?: string;
  /** Cache write time in epoch milliseconds from the P1 schema (healthy only). */
  fetchedAt?: number;
  /** Cache age in ms relative to the inspection clock; clamped to >= 0 (healthy only). */
  ageMs?: number;
  modelCount: number;
  ids: string[];
  displayNames: string[];
  expectedAliasesPresent: string[];
  expectedAliasesMissing: string[];
  error?: string;
}

export interface ProviderModelSummary {
  provider: string;
  authMode?: FrogConfig["providers"][string]["authMode"];
  enabledCount: number;
  disabledCount: number;
  enabledModelIds: string[];
  disabledModelIds: string[];
  /** Configured models whose provider credential is not resolvable (`authReady === false`). */
  authNotReadyCount: number;
  authNotReadyModelIds: string[];
}

export interface ModelProviderSummary {
  providers: ProviderModelSummary[];
  codex: {
    enabledCount: number;
    disabledCount: number;
    enabledModelIds: string[];
    disabledModelIds: string[];
  };
  expectedEnabledAliases: { routeKey: string; alias: string }[];
}

export interface ProcessInspectionDiagnostic {
  status: "unavailable";
  reason: string;
}

export interface ClaudeDoctorFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  action: string;
}

/** Coarse, scoped-origin credential lifecycle state (mirrors the core `inspectClaudeGrantStatus`). */
export type GrantCredentialState = ClaudeGrantStatusState;

export interface ClaudeGrantDiagnostic {
  id: string;
  label: string;
  /** True when the grant's config dir canonicalizes strictly inside the claude-grants root. */
  configDirConfined: boolean;
  /** True when the on-disk marker binds this grant id. */
  markerBound: boolean;
  credentialOrigin: "keychain_scoped" | "file_scoped";
  /**
   * Coarse credential lifecycle from the core scoped-origin inspector (darwin scoped Keychain, else
   * the in-root credential file): none/ok/expiring/reauth_required/unreadable. Never a token,
   * credential value, scoped service name, or path.
   */
  credentialState: GrantCredentialState;
  boundProviders: string[];
  dangling: boolean;
}

export interface DanglingProviderBinding {
  provider: string;
  grantId: string;
}

/**
 * Read-only scoped-origin status inspector (defaults to the core `inspectClaudeGrantStatus`). Injected
 * in tests via an exported dependency seam so the doctor never touches the real Keychain.
 */
export type GrantStatusInspector = (config: FrogConfig, grant: ClaudeGrantRecord) => ClaudeGrantStatus;

export interface ClaudeGrantsInspection {
  /** Classification of the resolved real Claude executable that guided grant login would use. */
  realClaudeKind: RawClaudeKind;
  grants: ClaudeGrantDiagnostic[];
  danglingProviderBindings: DanglingProviderBinding[];
  /** Names only (never values) of env vars that could conflict with an isolated grant login. */
  nativeAuthEnvConflicts: string[];
  scopeAssumptions: string[];
}

export interface ClaudeDoctorReport {
  rawClaude: RawClaudeResolution;
  realClaude: RealClaudeResolution;
  launcherBinDir: string;
  launchers: LauncherDiagnostic[];
  profiles: ProfileGatewayDiagnostic[];
  gatewayCaches: GatewayCacheDiagnostic[];
  modelSummary: ModelProviderSummary;
  grants: ClaudeGrantsInspection;
  processInspection: ProcessInspectionDiagnostic;
  findings: ClaudeDoctorFinding[];
}

export interface ApiModelRow {
  id?: unknown;
  provider?: unknown;
  disabled?: unknown;
  /** Management readiness tag from /api/models: false => logged-out configured model (kept, alias-excluded). */
  authReady?: unknown;
  [key: string]: unknown;
}

function realpathMaybe(path: string, fs: FileSystemProbe): string {
  try { return fs.realpathSync(path); } catch { return resolve(path); }
}

function pathEntries(pathEnv = process.env.PATH ?? ""): string[] {
  return pathEnv.split(delimiter).filter(Boolean);
}

function isInside(parent: string, child: string, fs: FileSystemProbe): boolean {
  const p = realpathMaybe(parent, fs);
  const c = realpathMaybe(child, fs);
  return c === p || c.startsWith(`${p}${sep}`);
}

function firstPathCommand(commands: string[], pathEnv: string, fs: FileSystemProbe): { path: string; realPath: string; pathEntry: string } | null {
  for (const dir of pathEntries(pathEnv)) {
    for (const command of commands) {
      const candidate = join(dir, command);
      if (!fs.existsSync(candidate)) continue;
      return { path: candidate, realPath: realpathMaybe(candidate, fs), pathEntry: dir };
    }
  }
  return null;
}

export function classifyRawClaudePath(path: string, realPath: string, launcherBinDir: string, fs: FileSystemProbe = defaultFs): RawClaudeKind {
  const haystack = `${path}\n${realPath}`.toLowerCase();
  if (haystack.includes("cmux-cli-shims") || haystack.includes("cmux")) return "cmux_shim";
  if (isInside(launcherBinDir, path, fs) || isInside(launcherBinDir, realPath, fs)) return "managed_launcher";
  if (haystack.includes(`${sep}node_modules${sep}.bin${sep}`) || haystack.includes("@anthropic-ai") || haystack.includes("claude-code")) return "package_bin";
  try {
    const script = fs.readFileSync(path, "utf-8");
    if (script.includes("Generated by frogprogsy")) return "managed_launcher";
    if (script.includes("cmux-cli-shims") || script.toLowerCase().includes("cmux")) return "cmux_shim";
    if (script.includes("@anthropic-ai") || script.includes("claude-code")) return "package_bin";
  } catch {
    // Binary/native executables often are not readable as UTF-8; classify by path below.
  }
  if (isClaudeExecutableBasename(path) || isClaudeExecutableBasename(realPath)) return "native";
  return "unknown";
}

export function resolveRawClaudeOnPath(options: { pathEnv?: string; launcherBinDir?: string; fs?: FileSystemProbe } = {}): RawClaudeResolution {
  const fs = options.fs ?? defaultFs;
  const hit = firstPathCommand(claudeExecutableCandidates(), options.pathEnv ?? process.env.PATH ?? "", fs);
  if (!hit) {
    return { command: "claude", kind: "missing", path: null, realPath: null, pathEntry: null, reason: "PATH에서 claude 실행 파일을 찾지 못했습니다." };
  }
  const binDir = options.launcherBinDir ?? claudeLauncherBinDir();
  const kind = classifyRawClaudePath(hit.path, hit.realPath, binDir, fs);
  return { command: "claude", kind, path: hit.path, realPath: hit.realPath, pathEntry: hit.pathEntry, reason: rawClaudeReason(kind) };
}

function rawClaudeReason(kind: RawClaudeKind): string {
  switch (kind) {
    case "managed_launcher": return "frogprogsy가 생성한 Claude 런처가 PATH에서 먼저 발견됩니다.";
    case "package_bin": return "패키지 매니저가 설치한 Claude Code 바이너리가 PATH에서 먼저 발견됩니다.";
    case "cmux_shim": return "cmux shim이 PATH에서 먼저 발견됩니다.";
    case "native": return "네이티브 Claude 실행 파일이 PATH에서 먼저 발견됩니다.";
    case "unknown": return "출처를 확정할 수 없는 claude 실행 파일이 PATH에서 먼저 발견됩니다.";
    case "missing": return "PATH에서 claude 실행 파일을 찾지 못했습니다.";
  }
}

export function resolveRealClaudeTarget(extraSkipDirs: string[] = []): RealClaudeResolution {
  return { command: "claude", path: findRealClaudeExecutable(extraSkipDirs) };
}

export function inspectPlannedLaunchers(config: FrogConfig, options: { pathEnv?: string; launcherBinDir?: string; fs?: FileSystemProbe } = {}): LauncherDiagnostic[] {
  const fs = options.fs ?? defaultFs;
  const binDir = options.launcherBinDir ?? claudeLauncherBinDir();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const { launchers } = plannedClaudeLaunchers(config);
  return launchers.map(entry => {
    const launcherPath = join(binDir, claudeLauncherFileName(entry.name));
    const first = firstPathCommand(claudeExecutableCandidates(entry.name), pathEnv, fs);
    return {
      command: entry.name,
      profileId: entry.profileId,
      profileName: entry.profileName,
      claudeHome: entry.claudeHome,
      path: launcherPath,
      installed: fs.existsSync(launcherPath),
      onPath: first?.realPath === realpathMaybe(launcherPath, fs),
    };
  });
}

export function inspectGatewayCache(claudeHome: string, expectedAliases: string[], fs: FileSystemProbe = defaultFs, now: number = Date.now()): GatewayCacheDiagnostic {
  const path = claudeGatewayModelsCachePath(claudeHome);
  if (!fs.existsSync(path)) {
    return { status: "missing", path, modelCount: 0, ids: [], displayNames: [], expectedAliasesPresent: [], expectedAliasesMissing: [...expectedAliases] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf-8")) as { baseUrl?: unknown; fetchedAt?: unknown; models?: unknown };
    // Exact P1 on-disk schema: {baseUrl:string, fetchedAt:number(epoch-ms), models:array}. Any legacy or
    // partial cache (missing baseUrl/fetchedAt, or a non-array models field) is malformed, never healthy.
    if (Object.keys(raw).sort().join(",") !== "baseUrl,fetchedAt,models") throw new Error("unexpected cache fields");
    if (typeof raw.baseUrl !== "string" || raw.baseUrl === "") throw new Error("baseUrl string missing");
    if (typeof raw.fetchedAt !== "number" || !Number.isFinite(raw.fetchedAt)) throw new Error("fetchedAt number missing");
    if (!Array.isArray(raw.models)) throw new Error("models array missing");
    if (!raw.models.every(model => {
      if (!isRecord(model)) return false;
      const keys = Object.keys(model);
      return keys.every(key => key === "id" || key === "display_name")
        && typeof model.id === "string"
        && model.id.length > 0
        && (model.display_name === undefined || typeof model.display_name === "string");
    })) {
      throw new Error("models entries malformed");
    }
    const ids = raw.models.map(model => (model as Record<string, unknown>).id as string).sort();
    const displayNames = raw.models
      .map(model => (model as Record<string, unknown>).display_name)
      .filter((name): name is string => typeof name === "string")
      .sort();
    const idSet = new Set(ids);
    return {
      status: "healthy",
      path,
      baseUrl: raw.baseUrl,
      fetchedAt: raw.fetchedAt,
      ageMs: Math.max(0, now - raw.fetchedAt),
      modelCount: ids.length,
      ids,
      displayNames,
      expectedAliasesPresent: expectedAliases.filter(alias => idSet.has(alias)).sort(),
      expectedAliasesMissing: expectedAliases.filter(alias => !idSet.has(alias)).sort(),
    };
  } catch (err) {
    return {
      status: "malformed",
      path,
      modelCount: 0,
      ids: [],
      displayNames: [],
      expectedAliasesPresent: [],
      expectedAliasesMissing: [...expectedAliases].sort(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowRouteKey(row: ApiModelRow): { provider: string; model: string; routeKey: string; disabled: boolean; authReady: boolean } | null {
  const id = typeof row.id === "string" ? row.id : "";
  const provider = typeof row.provider === "string" && row.provider ? row.provider : (id.includes("/") ? id.split("/", 1)[0] : "");
  if (!id || !provider) return null;
  const model = id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
  // authReady === false marks a configured model whose OAuth/key/grant credential is not resolvable:
  // retain it in the management summary but exclude it from expected picker aliases.
  return { provider, model, routeKey: `${provider}/${model}`, disabled: row.disabled === true, authReady: row.authReady !== false };
}

export function summarizeApiModels(rows: ApiModelRow[], config?: FrogConfig): ModelProviderSummary {
  const byProvider = new Map<string, ProviderModelSummary>();
  const enabledSources: { provider: string; model: string }[] = [];
  for (const row of rows) {
    const parsed = rowRouteKey(row);
    if (!parsed) continue;
    let summary = byProvider.get(parsed.provider);
    if (!summary) {
      const authMode = config?.providers[parsed.provider]?.authMode;
      summary = {
        provider: parsed.provider,
        ...(authMode ? { authMode } : {}),
        enabledCount: 0,
        disabledCount: 0,
        enabledModelIds: [],
        disabledModelIds: [],
        authNotReadyCount: 0,
        authNotReadyModelIds: [],
      };
      byProvider.set(parsed.provider, summary);
    }
    if (!parsed.authReady) {
      summary.authNotReadyCount += 1;
      summary.authNotReadyModelIds.push(parsed.model);
    }
    if (parsed.disabled) {
      summary.disabledCount += 1;
      summary.disabledModelIds.push(parsed.model);
    } else {
      summary.enabledCount += 1;
      summary.enabledModelIds.push(parsed.model);
      // Expected picker aliases require a ready credential (authReady !== false) AND non-forward auth;
      // logged-out configured models remain in the summary above but never become expected aliases.
      if (parsed.authReady && config?.providers[parsed.provider]?.authMode !== "forward") {
        enabledSources.push({ provider: parsed.provider, model: parsed.model });
      }
    }
  }
  const providers = [...byProvider.values()].map(summary => ({
    ...summary,
    enabledModelIds: summary.enabledModelIds.sort(),
    disabledModelIds: summary.disabledModelIds.sort(),
    authNotReadyModelIds: summary.authNotReadyModelIds.sort(),
  })).sort((a, b) => a.provider.localeCompare(b.provider));
  const aliases = computeModelAliases(enabledSources);
  const expectedEnabledAliases = [...aliases.entries()]
    .map(([routeKey, alias]) => ({ routeKey, alias }))
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey));
  const codex = byProvider.get("codex") ?? { provider: "codex", enabledCount: 0, disabledCount: 0, enabledModelIds: [], disabledModelIds: [], authNotReadyCount: 0, authNotReadyModelIds: [] };
  return {
    providers,
    codex: {
      enabledCount: codex.enabledCount,
      disabledCount: codex.disabledCount,
      enabledModelIds: [...codex.enabledModelIds].sort(),
      disabledModelIds: [...codex.disabledModelIds].sort(),
    },
    expectedEnabledAliases,
  };
}

function isSensitiveDoctorKey(key: string): boolean {
  const lower = key.toLowerCase();
  const compact = lower.replace(/[\s_-]/g, "");
  return lower === "authorization"
    || lower === "x-api-key"
    || compact === "xapikey"
    || compact.includes("apikey")
    || compact.includes("token")
    || compact.includes("secret")
    || compact.includes("customheaders");
}

function isHeaderContainerKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[\s_-]/g, "");
  return compact === "headers" || compact.endsWith("headers");
}

function redactedSensitiveValue(value: unknown): unknown {
  return value === undefined || value === null || value === "" ? value : "set_redacted";
}

function redactHeaderContainer(value: unknown): unknown {
  if (!isRecord(value)) return redactedSensitiveValue(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = redactedSensitiveValue(value[key]);
  return out;
}

export function redactForClaudeDoctor(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForClaudeDoctor);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isHeaderContainerKey(key)) {
      out[key] = redactHeaderContainer(item);
    } else if (isSensitiveDoctorKey(key)) {
      out[key] = redactedSensitiveValue(item);
    } else {
      out[key] = redactForClaudeDoctor(item);
    }
  }
  return out;
}

export function sanitizeClaudeDoctorReport(report: ClaudeDoctorReport): unknown {
  return redactForClaudeDoctor(report);
}

export function inspectProfiles(config: FrogConfig, port: number): ProfileGatewayDiagnostic[] {
  const profileConfig = ensureClaudeProfiles(structuredClone(config)).profiles;
  return profileConfig.map(profile => profileGatewayDiagnostic(profile, port));
}

function profileGatewayDiagnostic(profile: ClaudeProfileRecord, port: number): ProfileGatewayDiagnostic {
  return {
    profileId: profile.id,
    profileName: profile.name,
    claudeHome: profile.claudeHome,
    state: readClaudeGatewayState(port, { claudeHome: profile.claudeHome, profileId: profile.id }),
    runCommand: ["frogp", "claude", "run", profile.id],
    reloadCommand: ["frogp", "claude", "reload-models", profile.id],
  };
}

/** Env var NAMES (never values) that could override an isolated grant's scoped login/credential. */
const NATIVE_AUTH_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

const GRANT_SCOPE_ASSUMPTION =
  "Grant scoped Keychain service names are derived as `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0..8]>`; a Claude Code change to that naming, the OAuth client id, or the refresh endpoint would require re-provisioning grants.";


function grantBoundProviders(config: FrogConfig, grantId: string): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.authMode === "claude-grant" && provider.claudeGrantId === grantId)
    .map(([name]) => name)
    .sort();
}

function safeReadGrantMarkerId(configDir: string): string | null {
  try {
    return readGrantMarker(configDir)?.id ?? null;
  } catch {
    return null;
  }
}


/**
 * Inspect isolated Claude subscription grants WITHOUT reading native Claude homes or the global /
 * unscoped Keychain. Config-dir confinement, marker binding, dangling provider bindings, and
 * native-auth env conflicts (names only) are derived from config + fs + env. The scoped credential
 * lifecycle is read only through `grantStatusInspector` (default: the core `inspectClaudeGrantStatus`,
 * which reads ONLY the grant's scoped origin — darwin scoped Keychain, else the in-root file); tests
 * inject the seam so no real Keychain is touched. A dangling grant is never inspected.
 */
export function inspectClaudeGrants(config: FrogConfig, options: {
  realClaudeKind: RawClaudeKind;
  fs?: FileSystemProbe;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  grantStatusInspector?: GrantStatusInspector;
}): ClaudeGrantsInspection {
  const fs = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const origin: "keychain_scoped" | "file_scoped" = platform === "darwin" ? "keychain_scoped" : "file_scoped";
  // Default honors the resolved platform so the scoped origin matches; never a native/global fallback.
  const inspectStatus = options.grantStatusInspector
    ?? ((cfg: FrogConfig, grant: ClaudeGrantRecord) => inspectClaudeGrantStatus(cfg, grant, { platform }));

  let root = "";
  try { root = realpathMaybe(grantsRoot(), fs); } catch { root = ""; }

  const grants = listClaudeGrants(config).map<ClaudeGrantDiagnostic>(grant => {
    let configDirConfined = false;
    let markerBound = false;
    let dirExists = false;
    try {
      const canonicalDir = realpathMaybe(grant.configDir, fs);
      configDirConfined = root !== "" && canonicalDir !== root && canonicalDir.startsWith(`${root}${sep}`);
      dirExists = fs.existsSync(grant.configDir);
      markerBound = safeReadGrantMarkerId(grant.configDir) === grant.id;
    } catch {
      configDirConfined = false;
    }
    const dangling = !(configDirConfined && dirExists && markerBound);
    let credentialState: GrantCredentialState = "none";
    if (!dangling) {
      try {
        credentialState = inspectStatus(config, grant).state;
      } catch {
        credentialState = "unreadable";
      }
    }
    return {
      id: grant.id,
      label: grant.label,
      configDirConfined,
      markerBound,
      credentialOrigin: origin,
      credentialState,
      boundProviders: grantBoundProviders(config, grant.id),
      dangling,
    };
  });

  const danglingProviderBindings: DanglingProviderBinding[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.authMode !== "claude-grant") continue;
    const grantId = provider.claudeGrantId;
    if (!grantId || !getClaudeGrantById(config, grantId)) {
      danglingProviderBindings.push({ provider: name, grantId: grantId ?? "" });
    }
  }

  const hasGrantSurface = grants.length > 0
    || Object.values(config.providers).some(provider => provider.authMode === "claude-grant");
  const nativeAuthEnvConflicts = hasGrantSurface
    ? NATIVE_AUTH_ENV_VARS.filter(name => typeof env[name] === "string" && env[name] !== "")
    : [];
  const scopeAssumptions = hasGrantSurface ? [GRANT_SCOPE_ASSUMPTION] : [];

  return { realClaudeKind: options.realClaudeKind, grants, danglingProviderBindings, nativeAuthEnvConflicts, scopeAssumptions };
}

export function buildClaudeDoctorReport(config: FrogConfig, apiModels: ApiModelRow[], options: { port?: number; pathEnv?: string; env?: NodeJS.ProcessEnv; fs?: FileSystemProbe; grantStatusInspector?: GrantStatusInspector } = {}): ClaudeDoctorReport {
  const fs = options.fs ?? defaultFs;
  const port = options.port ?? config.port ?? DEFAULT_PORT;
  const modelSummary = summarizeApiModels(apiModels, config);
  const expectedAliases = modelSummary.expectedEnabledAliases.map(entry => entry.alias);
  const rawClaude = resolveRawClaudeOnPath({ pathEnv: options.pathEnv, fs });
  const realClaude = resolveRealClaudeTarget([claudeLauncherBinDir()]);
  const realClaudeKind = classifyRawClaudePath(realClaude.path, realpathMaybe(realClaude.path, fs), claudeLauncherBinDir(), fs);
  const grants = inspectClaudeGrants(config, { realClaudeKind, fs, env: options.env, grantStatusInspector: options.grantStatusInspector });
  const diagnosticConfig = structuredClone(config);
  const launchers = inspectPlannedLaunchers(diagnosticConfig, { pathEnv: options.pathEnv, fs });
  const profiles = inspectProfiles(config, port);
  const gatewayCaches = profiles.map(profile => inspectGatewayCache(profile.claudeHome, expectedAliases, fs));
  const report: ClaudeDoctorReport = {
    rawClaude,
    realClaude,
    launcherBinDir: claudeLauncherBinDir(),
    launchers,
    profiles,
    gatewayCaches,
    modelSummary,
    grants,
    processInspection: { status: "unavailable", reason: "실행 중인 Claude Code 프로세스 환경 검사는 이 진단에서 아직 지원하지 않습니다." },
    findings: [],
  };
  report.findings = buildFindings(report);
  return report;
}

function providerAuthRepairAction(provider: ProviderModelSummary): string {
  if (provider.authMode === "oauth") {
    return `frogp login ${provider.provider} 로 로그인한 뒤 frogp refresh 또는 frogp claude reload-models를 실행해 발행하세요.`;
  }
  if (provider.authMode === "claude-grant") {
    return "AI 계정의 grant binding과 Claude grant 상태를 확인하고, 안내된 실제 Claude 로그인 명령으로 grant를 복구한 뒤 frogp refresh를 실행하세요.";
  }
  return "AI 계정에서 이 provider의 API key/자격 증명을 설정한 뒤 frogp refresh 또는 frogp claude reload-models를 실행하세요.";
}

export function buildFindings(report: ClaudeDoctorReport): ClaudeDoctorFinding[] {
  const findings: ClaudeDoctorFinding[] = [];
  if (report.rawClaude.kind === "cmux_shim") {
    findings.push({ severity: "warning", code: "raw_claude_cmux_shim", message: "현재 PATH의 claude는 cmux shim입니다.", action: "일반 저장소의 `claude`에는 frogp claude project enroll [path]를 우선 사용하세요. 계정/홈을 분리해야 할 때만 frogprogsy 런처 bin 디렉터리를 PATH 앞쪽에 두거나 claude-work/claude-personal 런처를 직접 실행하세요." });
  }
  const missingOnPath = report.launchers.filter(launcher => launcher.installed && !launcher.onPath);
  if (missingOnPath.length > 0) {
    findings.push({ severity: "warning", code: "launcher_not_on_path", message: `설치된 Claude 런처 ${missingOnPath.map(l => l.command).join(", ")}가 PATH에서 먼저 발견되지 않습니다.`, action: "일반 저장소의 raw `claude`에는 frogp claude project enroll [path]가 우선 경로입니다. 별도 Claude home/account를 명시적으로 고를 때만 관리 런처 PATH 설정을 사용하세요." });
  }
  // Sentinel warning is scoped strictly to profiles whose observed carrier is "sentinel" (the local
  // frogprogsy discovery token is present in settings). Token-free profiles — the default — reach
  // modelDiscoveryReady via the native OAuth bearer passthrough and MUST never surface the
  // connectors-disabled / global-token warning.
  const sentinelProfiles = report.profiles.filter(profile => profile.state.carrier === "sentinel");
  if (sentinelProfiles.length > 0) {
    findings.push({
      severity: "warning",
      code: "sentinel_carrier_connectors_tradeoff",
      message: `Claude 프로필 ${sentinelProfiles.map(p => p.profileName).join(", ")}이(가) sentinel carrier(설정에 저장된 로컬 frogprogsy discovery 토큰)로 gateway 모델 discovery를 사용합니다.`,
      action: "sentinel carrier는 Claude Code의 claude.ai connectors/Remote Control을 비활성화할 수 있습니다. connectors가 필요하면 frogp claude refresh로 sentinel 토큰을 settings에서 제거하고 기본 token-free carrier로 되돌리세요.",
    });
  }
  const publicationHealthy = report.modelSummary.expectedEnabledAliases.length > 0 && report.gatewayCaches.some(cache => cache.status === "healthy" && cache.modelCount > 0 && cache.expectedAliasesMissing.length === 0);
  if (publicationHealthy) {
    // Token-free publication only needs the cache to be published and the client to re-read it; it does
    // NOT require project-local sentinel enrollment or a launcher-only auth token.
    findings.push({
      severity: "info",
      code: "publication_healthy_session_reload_needed",
      message: "게이트웨이 모델 발행은 정상입니다. 이미 열린 Claude Code 세션/프로세스는 아직 새 모델 목록을 다시 읽지 않았을 수 있습니다.",
      action: "Claude Code를 새 프로세스/새 세션으로 시작하거나 기존 세션을 resume하여 모델 목록을 다시 읽으세요. 열린 /model 화면은 hot-reload되지 않을 수 있습니다.",
    });
  }
  if (report.modelSummary.codex.disabledCount > 0) {
    findings.push({ severity: "warning", code: "codex_models_disabled", message: `codex 모델 ${report.modelSummary.codex.disabledCount}개가 비활성화되어 Claude 모델 선택기에 표시되지 않습니다.`, action: "필요한 codex 모델을 Providers 설정에서 다시 활성화한 뒤 frogp refresh 또는 frogp claude reload-models를 실행하세요." });
  }

  // Per-provider repair guidance for configured models whose OAuth/key/grant credential is unavailable.
  // They stay in the management summary but are excluded from expected picker aliases; no credential value,
  // email, or path is emitted.
  for (const provider of report.modelSummary.providers) {
    if (provider.authNotReadyCount > 0) {
      findings.push({
        severity: "warning",
        code: "provider_auth_not_ready",
        message: `provider ${provider.provider}의 모델 ${provider.authNotReadyCount}개가 로그인/자격 증명이 준비되지 않아(authReady:false) Claude 모델 선택기 별칭에서 제외됩니다. management 레지스트리에는 그대로 유지됩니다.`,
        action: providerAuthRepairAction(provider),
      });
    }
  }
  for (const launcher of report.launchers) {
    if (!launcher.installed) {
      findings.push({ severity: "warning", code: "launcher_not_installed", message: `${launcher.command} 런처가 아직 설치되어 있지 않습니다.`, action: "frogp start 또는 frogp refresh를 실행해 런처를 재생성하세요." });
    }
  }
  for (const grant of report.grants.grants) {
    if (grant.dangling) {
      findings.push({ severity: "warning", code: "claude_grant_dangling", message: `Claude grant ${grant.id} (${grant.label})의 격리된 config 디렉터리 또는 marker가 없거나 grants root 밖을 가리켜 사용할 수 없습니다.`, action: "frogp claude grants remove 로 정리한 뒤 frogp claude grants add 로 다시 만들고 안내된 login을 직접 실행하세요. frogprogsy는 native home이나 global Keychain을 대신 쓰지 않습니다." });
    } else if (grant.credentialState === "unreadable") {
      findings.push({ severity: "warning", code: "claude_grant_unreadable", message: `Claude grant ${grant.id} (${grant.label})의 scoped credential을 읽을 수 없습니다.`, action: "frogp claude grants add 로 안내된 login을 다시 실행해 grant를 재발급하세요. 값은 표시하지 않습니다." });
    } else if (grant.credentialState === "reauth_required") {
      findings.push({ severity: "warning", code: "claude_grant_reauth_required", message: `Claude grant ${grant.id} (${grant.label})의 scoped credential이 만료되었고 refresh token이 없어 다시 로그인이 필요합니다.`, action: "frogp claude grants add 가 출력한 login 명령(실제 절대경로 claude 실행 파일; bare claude 금지)을 직접 다시 실행한 뒤 frogp claude grants status 로 확인하세요. frogprogsy는 대신 로그인하지 않습니다." });
    } else if (grant.credentialState === "none") {
      findings.push({ severity: "info", code: "claude_grant_no_credential", message: `Claude grant ${grant.id} (${grant.label})가 아직 로그인되지 않아 scoped credential이 없습니다.`, action: "frogp claude grants add 가 출력한 login 명령(실제 절대경로 claude 실행 파일)을 직접 실행한 뒤 frogp claude grants status 로 확인하세요." });
    }
  }
  for (const binding of report.grants.danglingProviderBindings) {
    findings.push({ severity: "error", code: "claude_grant_provider_dangling", message: `provider ${binding.provider}가 claude-grant 인증을 쓰지만 존재하지 않는 grant(${binding.grantId || "미지정"})를 참조합니다.`, action: "frogp claude grants add 로 grant를 만들고 frogp providers set <name> --auth claude-grant --grant <id> 로 다시 바인딩하세요. frogprogsy는 자동으로 재바인딩하지 않습니다." });
  }
  if (report.grants.nativeAuthEnvConflicts.length > 0) {
    findings.push({ severity: "warning", code: "claude_grant_native_auth_env_conflict", message: `환경 변수 ${report.grants.nativeAuthEnvConflicts.join(", ")}가 설정되어 있어 isolated grant 로그인/사용을 덮어쓸 수 있습니다.`, action: "grant를 로그인하거나 사용할 때 이 환경 변수를 해제하세요. 값은 표시하지 않으며 frogprogsy는 이를 수정하지 않습니다." });
  }
  if (report.grants.grants.length > 0 && (report.grants.realClaudeKind === "managed_launcher" || report.grants.realClaudeKind === "missing")) {
    findings.push({ severity: "warning", code: "claude_grant_real_claude_unverified", message: `grant 안내 login이 쓸 real claude가 ${report.grants.realClaudeKind}로 분류됩니다. grant login은 반드시 실제 Claude 실행 파일이어야 합니다.`, action: "FROGP_REAL_CLAUDE에 실제 claude 절대 경로를 지정하거나 실제 Claude Code를 설치한 뒤 frogp claude grants add 를 다시 실행하세요." });
  }
  if (report.grants.scopeAssumptions.length > 0) {
    findings.push({ severity: "info", code: "claude_grant_scope_assumption", message: report.grants.scopeAssumptions[0]!, action: "Claude Code가 Keychain service 명명이나 OAuth 갱신 방식을 바꾸면 frogp claude grants add 로 grant를 다시 발급하세요." });
  }
  return findings;
}
