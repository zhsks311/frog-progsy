import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ClaudeProfileAuthState, ClaudeProfileRecord, FrogConfig, GatewayAuthCarrier } from "./types";
import { resolveClaudeCodeHome } from "./claude-paths";

export const CLAUDE_PROFILE_HEADER = "X-Frogp-Claude-Profile";
const LOCAL_CLAUDE_AUTH_TOKEN = "local-frogprogsy";

export interface ClaudeProfileSummary extends ClaudeProfileRecord {
  isDefault: boolean;
}

export function createClaudeProfileId(existingIds: Iterable<string> = []): string {
  const used = new Set(existingIds);
  for (let i = 0; i < 16; i++) {
    const id = `cp_${randomBytes(6).toString("hex")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("failed to create a unique Claude Code home id");
}

export function expandHomePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Claude Code home path is required");
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? `${homedir()}${trimmed.slice(1)}`
    : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

export function defaultClaudeProfileName(home = resolveClaudeCodeHome()): string {
  const normalized = expandHomePath(home);
  if (normalized === expandHomePath(`${homedir()}/.claude`)) return "Default Claude Code";
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? "Claude Code";
}

export function makeClaudeProfile(input: { name: string; claudeHome: string; id?: string }, existingIds: Iterable<string> = []): ClaudeProfileRecord {
  const name = input.name.trim();
  if (!name) throw new Error("Claude Code home name is required");
  const id = input.id?.trim() || createClaudeProfileId(existingIds);
  if (!/^cp_[a-z0-9]+$/i.test(id)) throw new Error("Claude Code home id must start with cp_ and contain only letters/numbers");
  return {
    id,
    name,
    claudeHome: expandHomePath(input.claudeHome),
    authState: "not_seen",
  };
}

export function ensureClaudeProfiles(config: FrogConfig): NonNullable<FrogConfig["claudeProfiles"]> {
  const existing = config.claudeProfiles;
  if (existing?.schemaVersion === 1 && Array.isArray(existing.profiles) && existing.profiles.length > 0) {
    existing.profiles = dedupeProfiles(existing.profiles);
    if (!existing.defaultProfileId || !existing.profiles.some(profile => profile.id === existing.defaultProfileId)) {
      existing.defaultProfileId = existing.profiles[0]!.id;
    }
    return existing;
  }

  const home = resolveClaudeCodeHome();
  const profile = makeClaudeProfile({
    id: "cp_default",
    name: defaultClaudeProfileName(home),
    claudeHome: home,
  });
  config.claudeProfiles = {
    schemaVersion: 1,
    defaultProfileId: profile.id,
    profiles: [profile],
  };
  return config.claudeProfiles;
}

function dedupeProfiles(profiles: ClaudeProfileRecord[]): ClaudeProfileRecord[] {
  const seenIds = new Set<string>();
  const seenHomes = new Set<string>();
  const out: ClaudeProfileRecord[] = [];
  for (const profile of profiles) {
    const id = profile.id?.trim();
    const name = profile.name?.trim();
    const home = profile.claudeHome ? expandHomePath(profile.claudeHome) : "";
    if (!id || !name || !home || seenIds.has(id) || seenHomes.has(home)) continue;
    seenIds.add(id);
    seenHomes.add(home);
    profile.id = id;
    profile.name = name;
    profile.claudeHome = home;
    profile.authState = profile.authState ?? "not_seen";
    out.push(profile);
  }
  return out;
}

export function listClaudeProfiles(config: FrogConfig): ClaudeProfileSummary[] {
  const profiles = ensureClaudeProfiles(config);
  return profiles.profiles.map(profile => ({
    ...profile,
    isDefault: profile.id === profiles.defaultProfileId,
  }));
}

export function resolveClaudeProfile(config: FrogConfig, selector?: string | null): ClaudeProfileRecord {
  const profiles = ensureClaudeProfiles(config);
  const wanted = selector?.trim();
  if (!wanted) {
    return profiles.profiles.find(profile => profile.id === profiles.defaultProfileId) ?? profiles.profiles[0]!;
  }
  const byId = profiles.profiles.find(profile => profile.id === wanted);
  if (byId) return byId;
  const byName = profiles.profiles.find(profile => profile.name === wanted);
  if (byName) return byName;
  const lowered = wanted.toLowerCase();
  const byFoldedName = profiles.profiles.find(profile => profile.name.toLowerCase() === lowered);
  if (byFoldedName) return byFoldedName;
  throw new Error(`Unknown Claude Code home: ${wanted}`);
}

export function addClaudeProfile(config: FrogConfig, input: { name: string; claudeHome: string; id?: string }): ClaudeProfileRecord {
  const profiles = ensureClaudeProfiles(config);
  const normalizedHome = expandHomePath(input.claudeHome);
  if (profiles.profiles.some(profile => expandHomePath(profile.claudeHome) === normalizedHome)) {
    throw new Error(`Claude Code home already exists for ${normalizedHome}`);
  }
  if (profiles.profiles.some(profile => profile.name === input.name.trim())) {
    throw new Error(`Claude Code home name already exists: ${input.name.trim()}`);
  }
  const profile = makeClaudeProfile({ ...input, claudeHome: normalizedHome }, profiles.profiles.map(p => p.id));
  profiles.profiles.push(profile);
  if (!profiles.defaultProfileId) profiles.defaultProfileId = profile.id;
  return profile;
}

export function renameClaudeProfile(config: FrogConfig, selector: string, nextName: string): ClaudeProfileRecord {
  const profiles = ensureClaudeProfiles(config);
  const profile = resolveClaudeProfile(config, selector);
  const name = nextName.trim();
  if (!name) throw new Error("Claude Code home name is required");
  if (profiles.profiles.some(candidate => candidate.id !== profile.id && candidate.name === name)) {
    throw new Error(`Claude Code home name already exists: ${name}`);
  }
  profile.name = name;
  return profile;
}

export function removeClaudeProfile(config: FrogConfig, selector: string): ClaudeProfileRecord {
  const profiles = ensureClaudeProfiles(config);
  const profile = resolveClaudeProfile(config, selector);
  if (profiles.profiles.length === 1) throw new Error("Cannot remove the only Claude Code home");
  profiles.profiles = profiles.profiles.filter(candidate => candidate.id !== profile.id);
  if (profiles.defaultProfileId === profile.id) profiles.defaultProfileId = profiles.profiles[0]!.id;
  return profile;
}

export function markClaudeProfileInjected(config: FrogConfig, profileId: string, injected = true): void {
  const profile = resolveClaudeProfile(config, profileId);
  profile.injected = injected;
  profile.lastInjectedAt = new Date().toISOString();
}

export function updateClaudeProfileAuthState(config: FrogConfig, profileId: string, authState: ClaudeProfileAuthState): void {
  const profile = resolveClaudeProfile(config, profileId);
  profile.authState = authState;
  profile.lastSeenAt = new Date().toISOString();
}

export function managedClaudeProfiles(config: FrogConfig): ClaudeProfileRecord[] {
  return ensureClaudeProfiles(config).profiles;
}


export function mergeClaudeProfileHeader(existing: string | undefined, profileId: string): string {
  const entries = parseCustomHeaders(existing).filter(entry => entry.name.toLowerCase() !== CLAUDE_PROFILE_HEADER.toLowerCase());
  entries.push({ name: CLAUDE_PROFILE_HEADER, value: profileId });
  return entries.map(entry => `${entry.name}: ${entry.value}`).join("\n");
}

export function removeClaudeProfileHeader(existing: string | undefined): string | undefined {
  const entries = parseCustomHeaders(existing).filter(entry => entry.name.toLowerCase() !== CLAUDE_PROFILE_HEADER.toLowerCase());
  if (entries.length === 0) return undefined;
  return entries.map(entry => `${entry.name}: ${entry.value}`).join("\n");
}

function parseCustomHeaders(raw: string | undefined): Array<{ name: string; value: string }> {
  if (!raw) return [];
  const entries: Array<{ name: string; value: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!name || !value) continue;
    entries.push({ name, value });
  }
  return entries;
}

export function buildClaudeProfileRunEnv(profile: ClaudeProfileRecord, port: number, carrier: GatewayAuthCarrier = "token-free", baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CLAUDE_CONFIG_DIR: profile.claudeHome,
    CLAUDE_HOME: profile.claudeHome,
    ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ANTHROPIC_CUSTOM_HEADERS: mergeClaudeProfileHeader(baseEnv.ANTHROPIC_CUSTOM_HEADERS, profile.id),
  };
  // Default/absent carrier is token-free: native claude.ai OAuth passes through, so no sentinel is
  // injected. Only "sentinel" restores the exact current per-process local gateway token. Any stale
  // frogp sentinel inherited from baseEnv is stripped in token-free mode (a real user-set
  // ANTHROPIC_AUTH_TOKEN is preserved), mirroring buildClaudeProfileNativeEnv's cleanup.
  if (carrier === "sentinel") env.ANTHROPIC_AUTH_TOKEN = LOCAL_CLAUDE_AUTH_TOKEN;
  else if (env.ANTHROPIC_AUTH_TOKEN === LOCAL_CLAUDE_AUTH_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function buildClaudeProfileNativeEnv(profile: ClaudeProfileRecord, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CLAUDE_CONFIG_DIR: profile.claudeHome,
    CLAUDE_HOME: profile.claudeHome,
  };
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  if (env.ANTHROPIC_AUTH_TOKEN === LOCAL_CLAUDE_AUTH_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
  const headers = removeClaudeProfileHeader(baseEnv.ANTHROPIC_CUSTOM_HEADERS);
  if (headers) env.ANTHROPIC_CUSTOM_HEADERS = headers;
  else delete env.ANTHROPIC_CUSTOM_HEADERS;
  return env;
}
