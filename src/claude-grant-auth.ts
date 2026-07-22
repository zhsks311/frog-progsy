/**
 * Claude grant credential resolution (Branch-B core).
 *
 * Owns scoped-credential read/refresh/persist for `authMode: "claude-grant"` providers:
 *  - darwin: the grant's scoped macOS Keychain service ONLY (`Claude Code-credentials-<hash>`).
 *  - non-darwin: `<grant-config-dir>/.credentials.json` ONLY.
 *
 * Never falls back to a native Claude home, the unscoped `Claude Code-credentials` service, or
 * `~/.frogprogsy/auth.json`. A rotated refresh token is persisted back to the exact origin the
 * credential was read from — nowhere else. All failures are typed and fail-closed, and no token text
 * ever appears in an error message or log.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir, hardenExistingSecret } from "./config";
import {
  assertScopedKeychainService,
  expectedKeychainService,
  getClaudeGrantById,
  grantCredentialsPath,
  NATIVE_KEYCHAIN_SERVICE,
} from "./claude-grants";
import type { ClaudeGrantRecord, FrogConfig, FrogProviderConfig } from "./types";

/** Claude Code 2.1.207 production OAuth constants; the refresh wire shape is locked by unit tests. */
export const CLAUDE_GRANT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_GRANT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_CLAUDE_GRANT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** macOS `security` exit status for errSecItemNotFound. */
const SEC_ITEM_NOT_FOUND = 44;

/** File-lock timing (overridable for tests via createGrantFileLock). */
const LOCK_WAIT_MS = REFRESH_TIMEOUT_MS * 3;
const LOCK_STALE_MS = REFRESH_TIMEOUT_MS * 2;
const LOCK_POLL_MS = 25;
const LOCK_MAX_RECLAIMS = 3;

export type ClaudeGrantErrorCode =
  | "not_bound"
  | "no_credential"
  | "reauth_required"
  | "refresh_unavailable"
  | "unreadable"
  | "delete_failed";

/** Typed, fail-closed error. Messages are constructed to never contain token text. */
export class ClaudeGrantError extends Error {
  readonly code: ClaudeGrantErrorCode;
  readonly grantId?: string;
  constructor(code: ClaudeGrantErrorCode, message: string, grantId?: string) {
    super(message);
    this.name = "ClaudeGrantError";
    this.code = code;
    this.grantId = grantId;
  }
}

/** The `{ claudeAiOauth: {...} }` credential envelope, with unknown fields preserved. */
export interface ClaudeAiOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  [key: string]: unknown;
}
export interface ScopedCredential {
  claudeAiOauth: ClaudeAiOauth;
  [key: string]: unknown;
}

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface KeychainAccess {
  /** Returns the stored secret for `service`/`account`, or null when the item does not exist. */
  read: (service: string, account: string) => string | null;
  /** Creates/updates the secret for `service`/`account`. */
  write: (service: string, account: string, secret: string) => void;
  /** Delete the secret for `service`/`account`. Item-not-found MUST be treated as success. */
  delete?: (service: string, account: string) => void;
}

export interface FileCredentialAccess {
  read: (path: string) => string | null;
  write: (path: string, content: string) => void;
  /** Delete the credential file at `path`. A missing file MUST be treated as success. */
  delete?: (path: string) => void;
}

export interface GrantLock {
  /** Acquire an exclusive cross-process lock for `key`; resolve to a release function. */
  acquire: (key: string) => Promise<() => void>;
}

export interface ClaudeGrantAuthDeps {
  now: () => number;
  fetch: FetchLike;
  platform: NodeJS.Platform;
  keychain: KeychainAccess;
  files: FileCredentialAccess;
  lock: GrantLock;
  account: string;
}

// ── default (production) dependency implementations ─────────────────────────

function defaultAccount(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    /* fall through */
  }
  return process.env.USER || process.env.LOGNAME || "frogprogsy";
}

const defaultKeychain: KeychainAccess = {
  read(service, account) {
    const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8" });
    if (result.status === 0) return (result.stdout ?? "").replace(/\n$/, "");
    if (result.status === SEC_ITEM_NOT_FOUND) return null;
    throw new Error(`keychain read failed for service ${JSON.stringify(service)} (status ${result.status ?? "unknown"})`);
  },
  write(service, account, secret) {
    const result = spawnSync("security", ["add-generic-password", "-U", "-a", account, "-s", service, "-w", secret], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`keychain write failed for service ${JSON.stringify(service)} (status ${result.status ?? "unknown"})`);
    }
  },
  delete(service, account) {
    const result = spawnSync("security", ["delete-generic-password", "-s", service, "-a", account], { encoding: "utf8" });
    if (result.status === 0) return;
    if (result.status === SEC_ITEM_NOT_FOUND) return; // errSecItemNotFound → nothing to delete
    throw new Error(`keychain delete failed for service ${JSON.stringify(service)} (status ${result.status ?? "unknown"})`);
  },
};

const defaultFiles: FileCredentialAccess = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
      // Permission / IO errors must NOT masquerade as "missing" — surface them (mapped to unreadable).
      throw err;
    }
  },
  write(path, content) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFile(path, content);
    hardenExistingSecret(path);
  },
  delete(path) {
    // force: true makes a missing file a no-op (success); permission / IO errors still throw.
    rmSync(path, { force: true });
  },
};

export interface GrantFileLockOptions {
  /** Lock directory. Defaults to `<frogprogsy-home>/locks`, resolved per acquire. */
  dir?: string;
  /** Bounded total time to wait for the lock before failing closed. */
  waitMs?: number;
  /** A lock file older than this is treated as abandoned and eligible for bounded reclaim. */
  staleMs?: number;
  /** Poll interval while the lock is held by a live holder. */
  pollMs?: number;
  /** Upper bound on stale-lock reclaim attempts (prevents starving a live-but-slow holder). */
  maxReclaims?: number;
}

/**
 * File-backed exclusive lock under `<frogprogsy-home>/locks`. In-process refresh coalescing already
 * serializes callers within one process; this guards concurrent processes (proxy + watchdog).
 *
 * Fail-closed: if the exclusive lock cannot be acquired within the bounded wait (a live holder), or
 * any filesystem error occurs, `acquire` throws a typed `refresh_unavailable` error so the caller
 * NEVER performs a lockless refresh. Stale-lock reclaim is bounded by `maxReclaims`.
 */
export function createGrantFileLock(options: GrantFileLockOptions = {}): GrantLock {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const maxReclaims = options.maxReclaims ?? LOCK_MAX_RECLAIMS;

  return {
    async acquire(key) {
      const dir = options.dir ?? join(getConfigDir(), "locks");
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
      const lockPath = join(dir, `claude-grant-${safeKey}.lock`);
      // Unique owner token stamped into the lockfile so a late release by a reclaimed (stale) holder
      // can never delete a successor's lock — release deletes only when the file still holds OUR token.
      const ownerToken = `${process.pid}:${randomBytes(16).toString("hex")}`;

      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        throw new ClaudeGrantError("refresh_unavailable", "could not prepare the claude grant refresh lock directory", key);
      }

      const deadline = Date.now() + waitMs;
      let reclaims = 0;
      for (;;) {
        try {
          const fd = openSync(lockPath, "wx", 0o600);
          try { writeSync(fd, ownerToken); } finally { closeSync(fd); }
          break; // acquired the exclusive lock
        } catch (err) {
          if (!err || typeof err !== "object" || (err as NodeJS.ErrnoException).code !== "EEXIST") {
            // Unexpected filesystem error (permissions, ENOTDIR, ...): fail closed, never lockless.
            throw new ClaudeGrantError("refresh_unavailable", "could not acquire the claude grant refresh lock", key);
          }
          // Lock is currently held. Reclaim ONLY an abandoned (stale) lock, up to maxReclaims.
          let ageMs: number | undefined;
          try {
            ageMs = Date.now() - statSync(lockPath).mtimeMs;
          } catch {
            ageMs = undefined; // vanished between open and stat — retry immediately
          }
          if (ageMs !== undefined && ageMs > staleMs && reclaims < maxReclaims) {
            reclaims++;
            try { rmSync(lockPath, { force: true }); } catch { /* another waiter reclaimed first */ }
            continue; // retry acquisition immediately
          }
          if (Date.now() >= deadline) {
            // Bounded wait exhausted while a live holder keeps the lock — fail closed.
            throw new ClaudeGrantError("refresh_unavailable", "timed out acquiring the claude grant refresh lock", key);
          }
          await new Promise(res => setTimeout(res, pollMs));
        }
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only remove the lockfile if we still own it (a stale reclaim may have replaced it).
        try {
          if (readFileSync(lockPath, "utf8") === ownerToken) rmSync(lockPath, { force: true });
        } catch { /* lockfile gone or unreadable — nothing for us to release */ }
      };
    },
  };
}

function createDefaultLock(): GrantLock {
  return createGrantFileLock();
}

function resolveDeps(override?: Partial<ClaudeGrantAuthDeps>): ClaudeGrantAuthDeps {
  return {
    now: override?.now ?? Date.now,
    fetch: override?.fetch ?? ((input, init) => globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>),
    platform: override?.platform ?? process.platform,
    keychain: override?.keychain ?? defaultKeychain,
    files: override?.files ?? defaultFiles,
    lock: override?.lock ?? createDefaultLock(),
    account: override?.account ?? defaultAccount(),
  };
}

// ── credential parse / origin I/O ───────────────────────────────────────────

function parseCredential(raw: string | null, grantId: string): ScopedCredential | null {
  if (raw == null || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeGrantError("unreadable", "stored claude grant credential is not valid JSON", grantId);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClaudeGrantError("unreadable", "stored claude grant credential is not an object", grantId);
  }
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    throw new ClaudeGrantError("unreadable", "stored claude grant credential is missing a claudeAiOauth object", grantId);
  }
  return parsed as ScopedCredential;
}

/** Read the credential from the grant's ONLY origin (scoped Keychain on darwin, file otherwise). */
function readCredential(grant: ClaudeGrantRecord, deps: ClaudeGrantAuthDeps): ScopedCredential | null {
  const service = assertScopedKeychainService("read claude grant credential", expectedKeychainService(grant.configDir));
  let raw: string | null;
  try {
    raw = deps.platform === "darwin"
      ? deps.keychain.read(service, deps.account)
      : deps.files.read(grantCredentialsPath(grant.configDir));
  } catch (err) {
    if (err instanceof ClaudeGrantError) throw err;
    throw new ClaudeGrantError("unreadable", "could not read the scoped claude grant credential", grant.id);
  }
  return parseCredential(raw, grant.id);
}

/** Persist the credential back to the exact origin only. Guards against native/global writes. */
function writeCredential(grant: ClaudeGrantRecord, credential: ScopedCredential, deps: ClaudeGrantAuthDeps): void {
  const serialized = JSON.stringify(credential);
  if (deps.platform === "darwin") {
    const service = assertScopedKeychainService("persist claude grant credential", expectedKeychainService(grant.configDir));
    if (service === NATIVE_KEYCHAIN_SERVICE) {
      throw new ClaudeGrantError("unreadable", "refusing to write the unscoped native Claude Code Keychain service", grant.id);
    }
    deps.keychain.write(service, deps.account, serialized);
  } else {
    // grantCredentialsPath asserts the path is inside the claude-grants root (never ~/.claude* or
    // ~/.frogprogsy/auth.json).
    deps.files.write(grantCredentialsPath(grant.configDir), serialized);
  }
}

function applyRefresh(credential: ScopedCredential, tokens: RefreshedTokens): ScopedCredential {
  return {
    ...credential,
    claudeAiOauth: {
      ...credential.claudeAiOauth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
  };
}

function isFresh(oauth: ClaudeAiOauth, now: number): boolean {
  return typeof oauth.accessToken === "string"
    && oauth.accessToken.length > 0
    && typeof oauth.expiresAt === "number"
    && oauth.expiresAt > now + EXPIRY_SKEW_MS;
}

// ── refresh ─────────────────────────────────────────────────────────────────

async function performRefresh(
  refreshToken: string,
  grantId: string,
  scopes: string[],
  deps: ClaudeGrantAuthDeps,
): Promise<RefreshedTokens> {
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_GRANT_CLIENT_ID,
    scope: scopes.join(" "),
  });

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await deps.fetch(CLAUDE_GRANT_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    // Network error / timeout — never surface request internals.
    throw new ClaudeGrantError("refresh_unavailable", "claude grant token refresh request failed", grantId);
  }

  const text = await response.text().catch(() => "");
  let json: Record<string, unknown> | undefined;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const errorCode = json && typeof json.error === "string" ? json.error : undefined;
    if (errorCode === "invalid_grant") {
      throw new ClaudeGrantError("reauth_required", "claude grant refresh was rejected; re-authentication is required", grantId);
    }
    throw new ClaudeGrantError("refresh_unavailable", `claude grant token refresh failed (status ${response.status})`, grantId);
  }
  if (!json || typeof json !== "object") {
    throw new ClaudeGrantError("refresh_unavailable", "claude grant token refresh returned an unreadable response", grantId);
  }

  const accessToken = typeof json.access_token === "string" ? json.access_token : undefined;
  if (!accessToken) {
    throw new ClaudeGrantError("refresh_unavailable", "claude grant token refresh response did not include an access token", grantId);
  }
  const newRefresh = typeof json.refresh_token === "string" ? json.refresh_token : refreshToken;
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  const expiresAt = expiresIn != null ? deps.now() + expiresIn * 1000 : deps.now() + DEFAULT_TTL_MS;
  return { accessToken, refreshToken: newRefresh, expiresAt };
}

async function refreshWithLock(grant: ClaudeGrantRecord, stale: ScopedCredential, deps: ClaudeGrantAuthDeps): Promise<string> {
  const staleRefresh = typeof stale.claudeAiOauth.refreshToken === "string" ? stale.claudeAiOauth.refreshToken : undefined;
  if (!staleRefresh) {
    throw new ClaudeGrantError("refresh_unavailable", "claude grant credential has no refresh token", grant.id);
  }

  let release: () => void;
  try {
    release = await deps.lock.acquire(grant.id);
  } catch (err) {
    // Never refresh without the exclusive lock. Surface a typed, token-free failure.
    if (err instanceof ClaudeGrantError) throw err;
    throw new ClaudeGrantError("refresh_unavailable", "could not acquire the claude grant refresh lock", grant.id);
  }
  try {
    // Re-read after acquiring the lock: another process may have refreshed OR deleted the credential
    // while we waited. A null re-read is a deliberate deletion committed under the SAME lock — treat
    // it as authoritative and NEVER refresh from the stale pre-lock snapshot (which would recreate a
    // credential the deleter intentionally removed).
    const current = readCredential(grant, deps);
    if (!current) {
      throw new ClaudeGrantError("no_credential", "the scoped claude grant credential was removed", grant.id);
    }
    if (isFresh(current.claudeAiOauth, deps.now())) {
      return current.claudeAiOauth.accessToken as string;
    }
    const refreshToken = typeof current.claudeAiOauth.refreshToken === "string"
      ? current.claudeAiOauth.refreshToken
      : staleRefresh;
    const storedScopes = Array.isArray(current.claudeAiOauth.scopes)
      ? current.claudeAiOauth.scopes.filter(scope => typeof scope === "string" && scope.length > 0)
      : [];
    const scopes = storedScopes.length > 0 ? storedScopes : [...DEFAULT_CLAUDE_GRANT_SCOPES];
    const tokens = await performRefresh(refreshToken, grant.id, scopes, deps);
    const merged = applyRefresh(current, tokens);
    try {
      writeCredential(grant, merged, deps);
    } catch (err) {
      // Preserve any typed ClaudeGrantError (e.g. native/global write refusal); wrap raw persistence
      // failures in a fixed, token/path/service-free refresh_unavailable.
      if (err instanceof ClaudeGrantError) throw err;
      throw new ClaudeGrantError("refresh_unavailable", "could not persist the refreshed claude grant credential", grant.id);
    }
    return tokens.accessToken;
  } finally {
    release();
  }
}

// ── public resolver ─────────────────────────────────────────────────────────

function resolveGrant(config: FrogConfig, providerName: string, provider: FrogProviderConfig): ClaudeGrantRecord {
  const grantId = provider.claudeGrantId;
  if (!grantId) {
    throw new ClaudeGrantError("not_bound", `provider ${providerName} uses claude-grant auth but has no claudeGrantId`);
  }
  const grant = getClaudeGrantById(config, grantId);
  if (!grant) {
    throw new ClaudeGrantError("not_bound", `provider ${providerName} references unknown claude grant ${grantId}`, grantId);
  }
  return grant;
}

async function resolveToken(grant: ClaudeGrantRecord, deps: ClaudeGrantAuthDeps): Promise<string> {
  const credential = readCredential(grant, deps);
  if (!credential) {
    throw new ClaudeGrantError("no_credential", `no stored credential for claude grant ${grant.id}`, grant.id);
  }
  const oauth = credential.claudeAiOauth;
  const hasAccess = typeof oauth.accessToken === "string" && oauth.accessToken.length > 0;
  const hasRefresh = typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0;

  // Nothing usable at all -> the user must log in again.
  if (!hasAccess && !hasRefresh) {
    throw new ClaudeGrantError("reauth_required", `claude grant ${grant.id} has no usable credential`, grant.id);
  }
  if (isFresh(oauth, deps.now())) {
    return oauth.accessToken as string;
  }
  // Access is stale/absent and there is no refresh token to obtain a new one.
  if (!hasRefresh) {
    throw new ClaudeGrantError("refresh_unavailable", `claude grant ${grant.id} is expired and has no refresh token`, grant.id);
  }
  return refreshWithLock(grant, credential, deps);
}

/** In-process per-grant coalescing so concurrent callers share a single read/refresh/write. */
const inFlight = new Map<string, Promise<string>>();

/**
 * Server integration seam. Returns a valid access token for a `claude-grant` provider, refreshing +
 * persisting to the grant's scoped origin when expired. Concurrent callers for the same grant share
 * one operation. All failures are typed `ClaudeGrantError`s and never contain token text.
 */
export async function getClaudeGrantAccessToken(
  config: FrogConfig,
  providerName: string,
  provider: FrogProviderConfig,
  depsOverride?: Partial<ClaudeGrantAuthDeps>,
): Promise<string> {
  const deps = resolveDeps(depsOverride);
  const grant = resolveGrant(config, providerName, provider); // throws not_bound before coalescing

  const existing = inFlight.get(grant.id);
  if (existing) return existing;

  const tracked = resolveToken(grant, deps).finally(() => {
    if (inFlight.get(grant.id) === tracked) inFlight.delete(grant.id);
  });
  inFlight.set(grant.id, tracked);
  return tracked;
}

// ── credential deletion (scoped origin only, fail-closed) ────────────────────

/**
 * Delete the grant's scoped credential from its ONLY origin so removing a grant never orphans a
 * local secret. darwin: `security delete-generic-password` for the EXACT scoped service + current
 * account (errSecItemNotFound is success). non-darwin: unlink the in-root
 * `<configDir>/.credentials.json` only. Refuses the unscoped/native Keychain service and any path
 * outside the claude-grants root (hard error); NEVER touches a native Claude home, the global
 * Keychain login, or another grant. Throws `delete_failed` on any real deletion error so the caller
 * keeps the grant metadata + dir until cleanup actually succeeds. No token, credential, path, or
 * service text is ever surfaced.
 */
export async function deleteClaudeGrantCredential(
  grant: ClaudeGrantRecord,
  depsOverride?: Partial<ClaudeGrantAuthDeps>,
): Promise<void> {
  const deps = resolveDeps(depsOverride);

  // Serialize deletion against refresh on the SAME per-grant lock. While we hold it no refresh can
  // run; once we release, refreshWithLock re-reads under the lock and treats the now-missing
  // credential as authoritative (no_credential), so a concurrent refresh can never recreate what we
  // delete here. A lock-acquisition failure is a fixed, token/path/service-free delete_failed so the
  // caller keeps the grant metadata + dir intact.
  let release: () => void;
  try {
    release = await deps.lock.acquire(grant.id);
  } catch {
    // Map EVERY acquisition failure — including a typed lock error such as the default grant lock's
    // refresh_unavailable — to a fixed, token/path/service-free delete_failed. Deletion must never
    // surface a refresh error code, and the caller keeps the grant metadata + dir intact.
    throw new ClaudeGrantError("delete_failed", "could not acquire the claude grant lock to delete the scoped credential", grant.id);
  }
  try {
    if (deps.platform === "darwin") {
      const service = assertScopedKeychainService(
        "delete claude grant credential",
        expectedKeychainService(grant.configDir),
      );
      // Belt-and-suspenders: assertScopedKeychainService already rejects the native/global service.
      if (service === NATIVE_KEYCHAIN_SERVICE) {
        throw new ClaudeGrantError("delete_failed", "refusing to delete the unscoped native Claude Code Keychain service", grant.id);
      }
      const del = deps.keychain.delete;
      if (!del) {
        throw new ClaudeGrantError("delete_failed", "no keychain delete seam is available for the claude grant credential", grant.id);
      }
      try {
        del(service, deps.account);
      } catch (err) {
        if (err instanceof ClaudeGrantError) throw err;
        throw new ClaudeGrantError("delete_failed", "could not delete the scoped claude grant Keychain credential", grant.id);
      }
    } else {
      // grantCredentialsPath asserts the path is strictly inside the claude-grants root (never a
      // native ~/.claude* home or ~/.frogprogsy/auth.json), and only ever the grant's own dir.
      const path = grantCredentialsPath(grant.configDir);
      const del = deps.files.delete;
      if (!del) {
        throw new ClaudeGrantError("delete_failed", "no file delete seam is available for the claude grant credential", grant.id);
      }
      try {
        del(path);
      } catch (err) {
        if (err instanceof ClaudeGrantError) throw err;
        throw new ClaudeGrantError("delete_failed", "could not delete the scoped claude grant file credential", grant.id);
      }
    }
  } finally {
    release();
  }
}

// ── read-only status (no refresh, no network) ────────────────────────────────

export type ClaudeGrantStatusState = "none" | "ok" | "expiring" | "reauth_required" | "unreadable";

/** Read-only grant status. Deliberately carries NO token, credential, path, or service. */
export interface ClaudeGrantStatus {
  state: ClaudeGrantStatusState;
  /** Access-token expiry (epoch ms) when the stored credential exposes a numeric one. Not a secret. */
  expiresAt?: number;
}

/**
 * Inspect a grant's scoped credential WITHOUT refreshing or making any network call — safe for GET
 * handlers / doctor diagnostics. Reads only the grant's real origin (darwin scoped Keychain service,
 * else `<configDir>/.credentials.json`); never falls back to a native Claude home or the global
 * Keychain service, and never writes. Returns only a coarse state plus an optional expiry timestamp:
 *  - none            : no credential stored at the scoped origin
 *  - ok              : a usable access token that is not within the expiry skew
 *  - expiring        : access token expired/near-expiry but a refresh token is present (recoverable)
 *  - reauth_required : not currently usable and no refresh token (re-login required)
 *  - unreadable      : the credential exists but is corrupt or the origin errored (non-missing)
 */
export function inspectClaudeGrantStatus(
  config: FrogConfig,
  grantOrId: ClaudeGrantRecord | string,
  depsOverride?: Partial<ClaudeGrantAuthDeps>,
): ClaudeGrantStatus {
  const deps = resolveDeps(depsOverride);
  const grant = typeof grantOrId === "string" ? getClaudeGrantById(config, grantOrId) : grantOrId;
  if (!grant) {
    throw new Error(`claude grant not found: ${typeof grantOrId === "string" ? grantOrId : grantOrId.id}`);
  }

  let credential: ScopedCredential | null;
  try {
    credential = readCredential(grant, deps);
  } catch (err) {
    if (err instanceof ClaudeGrantError && err.code === "unreadable") return { state: "unreadable" };
    throw err;
  }
  if (!credential) return { state: "none" };

  const oauth = credential.claudeAiOauth;
  const hasRefresh = typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0;
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined;
  const withExpiry = expiresAt !== undefined ? { expiresAt } : {};

  if (isFresh(oauth, deps.now())) return { state: "ok", ...withExpiry };
  if (hasRefresh) return { state: "expiring", ...withExpiry };
  return { state: "reauth_required", ...withExpiry };
}
