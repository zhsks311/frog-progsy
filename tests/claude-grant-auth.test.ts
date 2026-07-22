import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_GRANT_CLIENT_ID,
  CLAUDE_GRANT_REFRESH_URL,
  ClaudeGrantError,
  createGrantFileLock,
  getClaudeGrantAccessToken,
  deleteClaudeGrantCredential,
  inspectClaudeGrantStatus,
  type ClaudeGrantAuthDeps,
} from "../src/claude-grant-auth";
import { addClaudeGrant, expectedKeychainService, grantCredentialsPath, NATIVE_KEYCHAIN_SERVICE } from "../src/claude-grants";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

const NOW = 1_800_000_000_000;
const originalHome = process.env.FROGPROGSY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frog-grant-auth-"));
  process.env.FROGPROGSY_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// ── fakes ───────────────────────────────────────────────────────────────────

interface ResponseLike {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function jsonResponse(status: number, body: unknown): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

type FetchCall = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

function countingFetch(handler: (call: FetchCall) => ResponseLike | Promise<ResponseLike>) {
  const calls: FetchCall[] = [];
  const fn = (async (url: string, init: FetchCall["init"]) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as ClaudeGrantAuthDeps["fetch"] & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

function memKeychain(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const writes: Array<{ service: string; account: string; secret: string }> = [];
  const reads: string[] = [];
  const deletes: Array<{ service: string; account: string }> = [];
  return {
    store,
    writes,
    reads,
    deletes,
    read: (service: string, _account: string) => {
      reads.push(service);
      return store.has(service) ? store.get(service)! : null;
    },
    write: (service: string, account: string, secret: string) => {
      writes.push({ service, account, secret });
      store.set(service, secret);
    },
    delete: (service: string, account: string) => {
      // An absent item models errSecItemNotFound → a successful no-op delete.
      deletes.push({ service, account });
      store.delete(service);
    },
  };
}

function memFiles(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  return {
    store,
    writes,
    deletes,
    read: (path: string) => (store.has(path) ? store.get(path)! : null),
    write: (path: string, content: string) => {
      writes.push({ path, content });
      store.set(path, content);
    },
    delete: (path: string) => {
      // A missing file models a successful no-op delete.
      deletes.push(path);
      store.delete(path);
    },
  };
}

const noopLock: ClaudeGrantAuthDeps["lock"] = { acquire: async () => () => {} };

function cred(oauth: Record<string, unknown>, extraTop: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: oauth, ...extraTop });
}

function setup(overrideProvider: Partial<FrogProviderConfig> = {}) {
  const config: FrogConfig = { port: 10100, defaultProvider: "cg", providers: {} };
  const grant = addClaudeGrant(config, { label: "Work" });
  const provider: FrogProviderConfig = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "claude-grant",
    claudeGrantId: grant.id,
    ...overrideProvider,
  };
  config.providers.cg = provider;
  return { config, grant, provider, service: expectedKeychainService(grant.configDir) };
}

async function expectGrantError(promise: Promise<unknown>, code: ClaudeGrantError["code"]): Promise<ClaudeGrantError> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ClaudeGrantError);
  expect((error as ClaudeGrantError).code).toBe(code);
  return error as ClaudeGrantError;
}

function leakBlob(error: ClaudeGrantError): string {
  return `${error.message}\n${error.stack ?? ""}\n${String(error)}`;
}

// ── binding / read failures ─────────────────────────────────────────────────

describe("claude grant binding", () => {
  test("not_bound when the provider has no claudeGrantId", async () => {
    const { config, provider } = setup({ claudeGrantId: undefined });
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain: memKeychain(), files: memFiles(), lock: noopLock, now: () => NOW }),
      "not_bound",
    );
  });

  test("not_bound when the referenced grant does not exist", async () => {
    const { config, provider } = setup({ claudeGrantId: "cg_missing99" });
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain: memKeychain(), files: memFiles(), lock: noopLock, now: () => NOW }),
      "not_bound",
    );
  });

  test("no_credential when the scoped keychain item is absent", async () => {
    const { config, provider } = setup();
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain: memKeychain(), files: memFiles(), lock: noopLock, now: () => NOW }),
      "no_credential",
    );
  });

  test("unreadable on malformed credential JSON — and the raw is never leaked", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: '{"claudeAiOauth": broken ACC-RAW-leak' });
    const error = await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW }),
      "unreadable",
    );
    expect(leakBlob(error)).not.toContain("ACC-RAW-leak");
  });
});

// ── happy path & refresh ─────────────────────────────────────────────────────

describe("claude grant token resolution", () => {
  test("returns a fresh access token without refreshing", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-fresh", refreshToken: "REF", expiresAt: NOW + 10 * 60 * 1000 }) });
    const fetch = countingFetch(() => { throw new Error("must not fetch"); });

    const token = await getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch });
    expect(token).toBe("ACC-fresh");
    expect(fetch.calls.length).toBe(0);
    expect(keychain.writes.length).toBe(0);
  });

  test("refreshes a token inside the 5-minute skew and persists to the scoped service only", async () => {
    const { config, provider, service } = setup();
    const files = memFiles();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW + 60 * 1000 }) });
    const fetch = countingFetch(() => jsonResponse(200, { access_token: "ACC-new", refresh_token: "REF-new", expires_in: 3600 }));

    const token = await getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files, lock: noopLock, now: () => NOW, fetch });
    expect(token).toBe("ACC-new");

    // Exactly one refresh, one write, to the exact scoped service.
    expect(fetch.calls.length).toBe(1);
    expect(keychain.writes.length).toBe(1);
    expect(keychain.writes[0].service).toBe(service);
    expect(keychain.writes.every(w => w.service === service)).toBe(true);

    // Refresh request shape.
    const call = fetch.calls[0];
    expect(call.url).toBe(CLAUDE_GRANT_REFRESH_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    const refreshBody = JSON.parse(call.init.body);
    expect(refreshBody).toEqual({
      grant_type: "refresh_token",
      refresh_token: "REF-old",
      client_id: CLAUDE_GRANT_CLIENT_ID,
      scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    });

    // Rotated token persisted; expiry recomputed from expires_in.
    const stored = JSON.parse(keychain.store.get(service)!);
    expect(stored.claudeAiOauth.accessToken).toBe("ACC-new");
    expect(stored.claudeAiOauth.refreshToken).toBe("REF-new");
    expect(stored.claudeAiOauth.expiresAt).toBe(NOW + 3600 * 1000);

    // No global fallback: no file writes, no native/unscoped service ever touched.
    expect(files.writes.length).toBe(0);
    expect(keychain.store.has(NATIVE_KEYCHAIN_SERVICE)).toBe(false);
  });

  test("preserves unknown credential fields across a refresh", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({
      [service]: cred(
        { accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW - 1000, subscriptionType: "team", scopes: ["a", "b"], mystery: "keep-me" },
        { schemaVersion: 9, otherTop: "top-keep" },
      ),
    });
    const fetch = countingFetch(() => jsonResponse(200, { access_token: "ACC-new", refresh_token: "REF-new", expires_in: 100 }));

    await getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch });
    expect(JSON.parse(fetch.calls[0].init.body).scope).toBe("a b");

    const stored = JSON.parse(keychain.store.get(service)!);
    expect(stored.claudeAiOauth.accessToken).toBe("ACC-new");
    expect(stored.claudeAiOauth.subscriptionType).toBe("team");
    expect(stored.claudeAiOauth.scopes).toEqual(["a", "b"]);
    expect(stored.claudeAiOauth.mystery).toBe("keep-me");
    expect(stored.schemaVersion).toBe(9);
    expect(stored.otherTop).toBe("top-keep");
  });

  test("non-darwin uses the scoped file credential and never the keychain", async () => {
    const { config, provider, grant } = setup();
    const path = grantCredentialsPath(grant.configDir);
    const files = memFiles({ [path]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW + 60 * 1000 }) });
    const keychain = memKeychain();
    const fetch = countingFetch(() => jsonResponse(200, { access_token: "ACC-new", refresh_token: "REF-new", expires_in: 3600 }));

    const token = await getClaudeGrantAccessToken(config, "cg", provider, { platform: "linux", keychain, files, lock: noopLock, now: () => NOW, fetch });
    expect(token).toBe("ACC-new");
    expect(files.writes.length).toBe(1);
    expect(files.writes[0].path).toBe(path);
    expect(keychain.store.size).toBe(0);
    expect(keychain.writes.length).toBe(0);
  });
});

// ── refresh failure modes ─────────────────────────────────────────────────────

describe("claude grant refresh failures", () => {
  test("invalid_grant maps to reauth_required and never leaks tokens", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-SECRET-leak", refreshToken: "REF-SECRET-leak", expiresAt: NOW - 1 }) });
    const fetch = countingFetch(() => jsonResponse(400, { error: "invalid_grant", hint: "REF-HINT-leak" }));

    const error = await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch }),
      "reauth_required",
    );
    const blob = leakBlob(error);
    expect(blob).not.toContain("ACC-SECRET-leak");
    expect(blob).not.toContain("REF-SECRET-leak");
    expect(blob).not.toContain("REF-HINT-leak");
    // A rejected refresh must not overwrite the stored credential.
    expect(keychain.writes.length).toBe(0);
  });

  test("refresh_unavailable when the credential has no refresh token", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", expiresAt: NOW - 1 }) });
    const fetch = countingFetch(() => { throw new Error("must not fetch"); });
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch }),
      "refresh_unavailable",
    );
    expect(fetch.calls.length).toBe(0);
  });

  test("refresh_unavailable on a network error, without leaking the failure internals", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW - 1 }) });
    const fetch = countingFetch(() => { throw new Error("socket died TOKEN-XYZ"); });
    const error = await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch }),
      "refresh_unavailable",
    );
    expect(leakBlob(error)).not.toContain("TOKEN-XYZ");
  });

  test("reauth_required when the stored credential has neither access nor refresh token", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ subscriptionType: "team" }) });
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch: countingFetch(() => jsonResponse(200, {})) }),
      "reauth_required",
    );
  });
});

// ── concurrency ───────────────────────────────────────────────────────────────

describe("claude grant concurrency", () => {
  test("10 concurrent callers trigger exactly one refresh and one write", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW - 1 }) });
    let fetchCount = 0;
    const fetch = countingFetch(async () => {
      fetchCount++;
      await new Promise(res => setTimeout(res, 5));
      return jsonResponse(200, { access_token: "ACC-new", refresh_token: "REF-new", expires_in: 3600 });
    });
    const deps = { platform: "darwin" as const, keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch };

    const results = await Promise.all(Array.from({ length: 10 }, () => getClaudeGrantAccessToken(config, "cg", provider, deps)));

    expect(results).toEqual(Array(10).fill("ACC-new"));
    expect(fetchCount).toBe(1);
    expect(fetch.calls.length).toBe(1);
    expect(keychain.writes.length).toBe(1);
    expect(keychain.writes[0].service).toBe(service);
  });

  test("re-reads after acquiring the lock and skips refresh when another writer already rotated", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW - 1 }) });
    const fetch = countingFetch(() => { throw new Error("must not refresh; credential is already fresh after the lock"); });
    // Simulate a concurrent process that rotated the credential while we waited for the lock.
    const lock: ClaudeGrantAuthDeps["lock"] = {
      acquire: async () => {
        keychain.store.set(service, cred({ accessToken: "ACC-fresh-by-other", refreshToken: "REF-x", expiresAt: NOW + 10 * 60 * 1000 }));
        return () => {};
      },
    };

    const token = await getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock, now: () => NOW, fetch });
    expect(token).toBe("ACC-fresh-by-other");
    expect(fetch.calls.length).toBe(0);
    expect(keychain.writes.length).toBe(0);
  });
});

// ── fail-closed exclusive lock (single-writer invariant) ─────────────────────

describe("claude grant refresh lock is fail-closed", () => {
  test("resolver never refreshes lockless: a lock backend failure is a typed refresh_unavailable", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW - 1 }) });
    const fetch = countingFetch(() => jsonResponse(200, { access_token: "ACC-new", refresh_token: "REF-new", expires_in: 3600 }));
    const lock: ClaudeGrantAuthDeps["lock"] = { acquire: async () => { throw new Error("lock backend down INTERNAL-XYZ"); } };

    const error = await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock, now: () => NOW, fetch }),
      "refresh_unavailable",
    );
    // Never performed a lockless refresh or write.
    expect(fetch.calls.length).toBe(0);
    expect(keychain.writes.length).toBe(0);
    // Internal lock error text is not leaked.
    expect(leakBlob(error)).not.toContain("INTERNAL-XYZ");
  });

  test("a typed lock error is propagated unchanged", async () => {
    const { config, provider, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW - 1 }) });
    const fetch = countingFetch(() => jsonResponse(200, { access_token: "ACC-new", refresh_token: "REF-new", expires_in: 3600 }));
    const lock: ClaudeGrantAuthDeps["lock"] = {
      acquire: async () => { throw new ClaudeGrantError("refresh_unavailable", "timed out acquiring the claude grant refresh lock", "cg_x"); },
    };
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock, now: () => NOW, fetch }),
      "refresh_unavailable",
    );
    expect(fetch.calls.length).toBe(0);
  });

  test("createGrantFileLock fails closed when a live holder keeps the lock (concurrent writer)", async () => {
    const dir = join(home, "locks-live");
    const lock = createGrantFileLock({ dir, waitMs: 60, pollMs: 5, staleMs: 10_000, maxReclaims: 3 });
    const release = await lock.acquire("cg_holder1");
    try {
      let error: unknown;
      try {
        await lock.acquire("cg_holder1"); // held + fresh -> bounded wait -> fail closed
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ClaudeGrantError);
      expect((error as ClaudeGrantError).code).toBe("refresh_unavailable");
    } finally {
      release();
    }
    // After release the same key is acquirable again.
    const release2 = await lock.acquire("cg_holder1");
    release2();
  });

  test("createGrantFileLock fails closed on an unexpected filesystem error", async () => {
    const blocker = join(home, "not-a-dir");
    writeFileSync(blocker, "x");
    const lock = createGrantFileLock({ dir: join(blocker, "sub"), waitMs: 40, pollMs: 5 });
    let error: unknown;
    try {
      await lock.acquire("cg_fs1");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ClaudeGrantError);
    expect((error as ClaudeGrantError).code).toBe("refresh_unavailable");
  });

  test("createGrantFileLock reclaims an abandoned stale lock, but honors the reclaim bound", async () => {
    const dir = join(home, "locks-stale");
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "claude-grant-cg_stale1.lock");
    const oldSecs = Date.now() / 1000 - 100;

    // Stale lock present + reclaim allowed -> stolen -> acquisition succeeds.
    writeFileSync(lockPath, "");
    utimesSync(lockPath, oldSecs, oldSecs);
    const reclaiming = createGrantFileLock({ dir, waitMs: 200, pollMs: 5, staleMs: 1_000, maxReclaims: 3 });
    const release = await reclaiming.acquire("cg_stale1");
    release();

    // Same stale lock + reclaim bound of 0 -> never reclaimed -> fail closed.
    writeFileSync(lockPath, "");
    utimesSync(lockPath, oldSecs, oldSecs);
    const bounded = createGrantFileLock({ dir, waitMs: 40, pollMs: 5, staleMs: 1_000, maxReclaims: 0 });
    let error: unknown;
    try {
      await bounded.acquire("cg_stale1");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ClaudeGrantError);
    expect((error as ClaudeGrantError).code).toBe("refresh_unavailable");
    rmSync(lockPath, { force: true });
  });
});

// ── non-darwin file read: ENOENT is missing, other IO errors are unreadable ──

describe("claude grant file-credential read error handling", () => {
  test("a missing credential file is no_credential (ENOENT -> null)", async () => {
    const { config, provider } = setup();
    // Uses the REAL defaultFiles (files not injected); the credential file does not exist.
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "linux", now: () => NOW }),
      "no_credential",
    );
  });

  test("a non-ENOENT read error is unreadable, not silently missing", async () => {
    const { config, provider, grant } = setup();
    // Make the credential path a directory so the real readFileSync throws EISDIR (not ENOENT).
    mkdirSync(grantCredentialsPath(grant.configDir), { recursive: true });
    await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "linux", now: () => NOW }),
      "unreadable",
    );
  });
});

// ── read-only status inspection (no refresh, no network, no leak) ────────────

describe("inspectClaudeGrantStatus", () => {
  function statusDeps(over: Partial<ClaudeGrantAuthDeps> = {}): Partial<ClaudeGrantAuthDeps> {
    // A fetch that would throw if ever called, proving the inspector performs no network I/O.
    const fetch = countingFetch(() => { throw new Error("inspect must not perform network I/O"); });
    return { platform: "darwin", now: () => NOW, fetch, ...over };
  }

  test("none when the scoped origin has no credential", () => {
    const { config, grant } = setup();
    const keychain = memKeychain();
    const status = inspectClaudeGrantStatus(config, grant, statusDeps({ keychain, files: memFiles() }));
    expect(status).toEqual({ state: "none" });
    expect(keychain.writes.length).toBe(0);
  });

  test("ok with expiresAt when the access token is comfortably valid", () => {
    const { config, grant, service } = setup();
    const expiresAt = NOW + 10 * 60 * 1000;
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC", refreshToken: "REF", expiresAt }) });
    const status = inspectClaudeGrantStatus(config, grant.id, statusDeps({ keychain, files: memFiles() }));
    expect(status).toEqual({ state: "ok", expiresAt });
  });

  test("expiring when within the skew but a refresh token is present", () => {
    const { config, grant, service } = setup();
    const expiresAt = NOW + 60 * 1000; // inside the 5-minute skew
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC", refreshToken: "REF", expiresAt }) });
    const status = inspectClaudeGrantStatus(config, grant, statusDeps({ keychain, files: memFiles() }));
    expect(status).toEqual({ state: "expiring", expiresAt });
  });

  test("reauth_required when expired/absent access and no refresh token", () => {
    const { config, grant, service } = setup();
    const expiresAt = NOW - 1;
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC", expiresAt }) });
    const status = inspectClaudeGrantStatus(config, grant, statusDeps({ keychain, files: memFiles() }));
    expect(status).toEqual({ state: "reauth_required", expiresAt });
  });

  test("unreadable when the stored credential is corrupt (no throw, no leak)", () => {
    const { config, grant, service } = setup();
    const keychain = memKeychain({ [service]: '{"claudeAiOauth": broken ACC-RAW-leak' });
    const status = inspectClaudeGrantStatus(config, grant, statusDeps({ keychain, files: memFiles() }));
    expect(status).toEqual({ state: "unreadable" });
    // The result must not carry any credential text.
    expect(JSON.stringify(status)).not.toContain("ACC-RAW-leak");
  });

  test("returns only state + optional expiresAt (never token/credential/path/service)", () => {
    const { config, grant, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-SECRET", refreshToken: "REF-SECRET", expiresAt: NOW + 10 * 60 * 1000, subscriptionType: "team" }) });
    const status = inspectClaudeGrantStatus(config, grant, statusDeps({ keychain, files: memFiles() }));
    expect(Object.keys(status).sort()).toEqual(["expiresAt", "state"]);
    expect(JSON.stringify(status)).not.toContain("ACC-SECRET");
    expect(JSON.stringify(status)).not.toContain("REF-SECRET");
    expect(JSON.stringify(status)).not.toContain(grant.configDir);
    expect(JSON.stringify(status)).not.toContain(service);
  });

  test("darwin reads ONLY the scoped service — no native/global fallback, no file read, no write", () => {
    const { config, grant, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC", refreshToken: "REF", expiresAt: NOW + 10 * 60 * 1000 }) });
    const files = memFiles();
    const status = inspectClaudeGrantStatus(config, grant, statusDeps({ keychain, files }));
    expect(status.state).toBe("ok");
    expect(keychain.reads).toEqual([service]);
    expect(keychain.reads).not.toContain(NATIVE_KEYCHAIN_SERVICE);
    expect(keychain.store.has(NATIVE_KEYCHAIN_SERVICE)).toBe(false);
    expect(keychain.writes.length).toBe(0);
    expect(files.writes.length).toBe(0);
  });

  test("non-darwin reads the scoped file origin and never the keychain", () => {
    const { config, grant } = setup();
    const path = grantCredentialsPath(grant.configDir);
    const files = memFiles({ [path]: cred({ accessToken: "ACC", refreshToken: "REF", expiresAt: NOW + 60 * 1000 }) });
    const keychain = memKeychain();
    const status = inspectClaudeGrantStatus(config, grant, statusDeps({ platform: "linux", keychain, files }));
    expect(status.state).toBe("expiring");
    expect(keychain.reads.length).toBe(0);
    expect(keychain.store.size).toBe(0);
    expect(files.writes.length).toBe(0);
  });

  test("throws for an unknown grant id", () => {
    const { config } = setup();
    expect(() => inspectClaudeGrantStatus(config, "cg_missing99", statusDeps({ keychain: memKeychain(), files: memFiles() })))
      .toThrow(/not found/);
  });
});

// ── stale-reclaim ownership safety (late release must not delete a successor) ─

describe("claude grant lock ownership after stale reclaim", () => {
  test("a late release by the reclaimed holder does not delete the successor's lock, and a new waiter stays fail-closed", async () => {
    const dir = join(home, "locks-owner");
    const key = "cg_owner1";
    const lockPath = join(dir, `claude-grant-${key}.lock`);

    // Original holder H1 acquires, then goes stale (aged mtime).
    const h1 = createGrantFileLock({ dir, waitMs: 40, pollMs: 5, staleMs: 5, maxReclaims: 3 });
    const releaseH1 = await h1.acquire(key);
    const oldSecs = Date.now() / 1000 - 100;
    utimesSync(lockPath, oldSecs, oldSecs);

    // Successor H2 reclaims the abandoned lock and becomes the live holder (fresh lockfile, its token).
    const h2 = createGrantFileLock({ dir, waitMs: 200, pollMs: 5, staleMs: 5, maxReclaims: 3 });
    const releaseH2 = await h2.acquire(key);
    expect(existsSync(lockPath)).toBe(true);

    // H1 releases LATE — it must NOT delete H2's lockfile (different owner token).
    releaseH1();
    expect(existsSync(lockPath)).toBe(true);

    // While H2 (the successor) is alive and fresh, a new waiter must fail closed.
    const h3 = createGrantFileLock({ dir, waitMs: 40, pollMs: 5, staleMs: 10_000, maxReclaims: 0 });
    let error: unknown;
    try {
      await h3.acquire(key);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ClaudeGrantError);
    expect((error as ClaudeGrantError).code).toBe("refresh_unavailable");
    expect(existsSync(lockPath)).toBe(true);

    // The real owner (H2) releases and removes exactly its own lockfile.
    releaseH2();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("release deletes only the owner's own lockfile after a fresh acquire cycle", async () => {
    const dir = join(home, "locks-owner2");
    const key = "cg_owner2";
    const lockPath = join(dir, `claude-grant-${key}.lock`);
    const lock = createGrantFileLock({ dir, waitMs: 40, pollMs: 5, staleMs: 10_000, maxReclaims: 0 });

    const release1 = await lock.acquire(key);
    expect(existsSync(lockPath)).toBe(true);
    release1();
    expect(existsSync(lockPath)).toBe(false);

    // A second, independent acquire on the same key succeeds and owns a distinct lockfile.
    const release2 = await lock.acquire(key);
    expect(existsSync(lockPath)).toBe(true);
    // A stale release1() call is idempotent and must not touch the new owner's file.
    release1();
    expect(existsSync(lockPath)).toBe(true);
    release2();
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ── scoped credential deletion (exact origin, not-found success, fail-closed) ─

describe("deleteClaudeGrantCredential", () => {
  function delDeps(over: Partial<ClaudeGrantAuthDeps> = {}): Partial<ClaudeGrantAuthDeps> {
    // A fetch that throws if ever called, proving deletion performs no network I/O.
    const fetch = countingFetch(() => { throw new Error("delete must not perform network I/O"); });
    // A no-op lock keeps the existing hermetic tests off the real file lock; adversarial tests
    // below inject their own tracking / failing lock to exercise the serialization seam.
    return { platform: "darwin", now: () => NOW, fetch, lock: noopLock, ...over };
  }

  test("darwin: deletes ONLY the exact scoped service + current account", async () => {
    const { grant, service } = setup();
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-SECRET-leak", refreshToken: "REF", expiresAt: NOW }) });
    const files = memFiles();
    await deleteClaudeGrantCredential(grant, delDeps({ keychain, files, account: "tester" }));

    expect(keychain.deletes).toEqual([{ service, account: "tester" }]);
    expect(keychain.store.has(service)).toBe(false);
    // Never the unscoped native/global service, and never the file origin on darwin.
    expect(keychain.deletes.some(d => d.service === NATIVE_KEYCHAIN_SERVICE)).toBe(false);
    expect(keychain.store.has(NATIVE_KEYCHAIN_SERVICE)).toBe(false);
    expect(files.deletes.length).toBe(0);
  });

  test("darwin: a not-found delete (errSecItemNotFound) is success and never throws", async () => {
    const { grant, service } = setup();
    const keychain = memKeychain(); // nothing stored
    await expect(deleteClaudeGrantCredential(grant, delDeps({ keychain, files: memFiles(), account: "tester" }))).resolves.toBeUndefined();
    expect(keychain.deletes).toEqual([{ service, account: "tester" }]);
  });

  test("non-darwin: deletes ONLY the in-root .credentials.json, never the keychain", async () => {
    const { grant } = setup();
    const path = grantCredentialsPath(grant.configDir);
    const files = memFiles({ [path]: cred({ accessToken: "ACC-SECRET-leak" }) });
    const keychain = memKeychain();
    await deleteClaudeGrantCredential(grant, delDeps({ platform: "linux", keychain, files }));

    expect(files.deletes).toEqual([path]);
    expect(files.store.has(path)).toBe(false);
    expect(keychain.deletes.length).toBe(0);
  });

  test("darwin: never touches OTHER grants' scoped services", async () => {
    const config: FrogConfig = { port: 10100, defaultProvider: "cg", providers: {} };
    const grantA = addClaudeGrant(config, { label: "A" });
    const grantB = addClaudeGrant(config, { label: "B" });
    const serviceA = expectedKeychainService(grantA.configDir);
    const serviceB = expectedKeychainService(grantB.configDir);
    const keychain = memKeychain({
      [serviceA]: cred({ accessToken: "ACC-A" }),
      [serviceB]: cred({ accessToken: "ACC-B" }),
    });
    await deleteClaudeGrantCredential(grantA, delDeps({ keychain, files: memFiles(), account: "tester" }));

    expect(keychain.store.has(serviceA)).toBe(false);
    expect(keychain.store.has(serviceB)).toBe(true); // grant B is untouched
    expect(keychain.deletes).toEqual([{ service: serviceA, account: "tester" }]);
  });

  test("throws delete_failed (no leak) when the keychain delete fails, so the caller keeps metadata", async () => {
    const { grant, service } = setup();
    const base = memKeychain({ [service]: cred({ accessToken: "ACC" }) });
    const failingKeychain = { ...base, delete: (_s: string, _a: string) => { throw new Error("boom REF-SECRET-leak"); } };
    const error = await expectGrantError(
      deleteClaudeGrantCredential(grant, delDeps({ keychain: failingKeychain, files: memFiles(), account: "tester" })),
      "delete_failed",
    );
    expect(leakBlob(error)).not.toContain("REF-SECRET-leak");
  });

  test("non-darwin: refuses a credential path OUTSIDE the claude-grants root and deletes nothing", async () => {
    const grant = { id: "cg_outsider1", label: "Outsider", configDir: join(home, "outside-grants-root"), createdAt: new Date(NOW).toISOString() };
    const files = memFiles();
    await expect(deleteClaudeGrantCredential(grant, delDeps({ platform: "linux", files, keychain: memKeychain() }))).rejects.toThrow();
    expect(files.deletes.length).toBe(0);
  });

  test("acquires and releases the SAME per-grant lock, deleting while it is held", async () => {
    const { grant, service } = setup();
    const events: string[] = [];
    const keychain = {
      ...memKeychain({ [service]: cred({ accessToken: "ACC" }) }),
      delete: (_s: string, _a: string) => { events.push("delete"); },
    };
    let acquiredKey: string | undefined;
    const lock: ClaudeGrantAuthDeps["lock"] = {
      acquire: async (key: string) => {
        acquiredKey = key;
        events.push("acquire");
        return () => { events.push("release"); };
      },
    };
    await deleteClaudeGrantCredential(grant, delDeps({ keychain, files: memFiles(), account: "tester", lock }));

    expect(acquiredKey).toBe(grant.id); // same per-grant key refresh uses
    expect(events).toEqual(["acquire", "delete", "release"]); // deleted strictly under the lock
  });

  test("maps a lock-acquisition failure (typed OR raw) to a fixed, redacted delete_failed and deletes nothing", async () => {
    const { grant, service } = setup();
    // The default grant lock throws a TYPED refresh_unavailable when it cannot acquire; deletion MUST
    // still surface delete_failed and never let a refresh_unavailable escape. A raw error maps too.
    const typedLock: ClaudeGrantAuthDeps["lock"] = {
      acquire: async () => { throw new ClaudeGrantError("refresh_unavailable", "timed out acquiring the claude grant refresh lock INTERNAL-XYZ", grant.id); },
    };
    const rawLock: ClaudeGrantAuthDeps["lock"] = {
      acquire: async () => { throw new Error("lock backend down INTERNAL-XYZ"); },
    };
    for (const lock of [typedLock, rawLock]) {
      const keychain = memKeychain({ [service]: cred({ accessToken: "ACC" }) });
      const error = await expectGrantError(
        deleteClaudeGrantCredential(grant, delDeps({ keychain, files: memFiles(), account: "tester", lock })),
        "delete_failed",
      );
      expect(keychain.deletes.length).toBe(0); // never deleted without the exclusive lock
      expect(keychain.store.has(service)).toBe(true); // credential and thus grant metadata are kept
      expect(leakBlob(error)).not.toContain("INTERNAL-XYZ"); // fixed, redacted message either way
    }
  });
});

// ── delete/refresh serialization (a deleted credential is never recreated) ────

describe("claude grant delete/refresh serialization", () => {
  test("a credential removed before the post-lock re-read yields no_credential with zero refresh/write", async () => {
    const { config, provider, service } = setup();
    // Stale credential (needs refresh) WITH a refresh token, so a naive resolver would refresh.
    const keychain = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old-SECRET", expiresAt: NOW - 1 }) });
    const fetch = countingFetch(() => { throw new Error("must not refresh a credential deleted under the lock"); });
    // Model a concurrent deleter that acquired the lock first and removed the credential: by the time
    // we hold the lock and re-read, it is gone.
    const lock: ClaudeGrantAuthDeps["lock"] = {
      acquire: async () => {
        keychain.store.delete(service);
        return () => {};
      },
    };
    const error = await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock, now: () => NOW, fetch }),
      "no_credential",
    );
    expect(fetch.calls.length).toBe(0); // never refreshed from the stale pre-lock snapshot
    expect(keychain.writes.length).toBe(0); // never recreated the deleted credential
    expect(leakBlob(error)).not.toContain("REF-old-SECRET");
  });

  test("a persistence failure during refresh is a typed, redacted refresh_unavailable", async () => {
    const { config, provider, service } = setup();
    const base = memKeychain({ [service]: cred({ accessToken: "ACC-old", refreshToken: "REF-old", expiresAt: NOW - 1 }) });
    // Refresh succeeds on the wire but persistence blows up with a secret-bearing message.
    const keychain = { ...base, write: (_s: string, _a: string, _secret: string) => { throw new Error("disk exploded ACC-new-SECRET-leak"); } };
    const fetch = countingFetch(() => jsonResponse(200, { access_token: "ACC-new-SECRET-leak", refresh_token: "REF-new", expires_in: 3600 }));
    const error = await expectGrantError(
      getClaudeGrantAccessToken(config, "cg", provider, { platform: "darwin", keychain, files: memFiles(), lock: noopLock, now: () => NOW, fetch }),
      "refresh_unavailable",
    );
    expect(fetch.calls.length).toBe(1); // the refresh ran; only persistence failed
    expect(leakBlob(error)).not.toContain("ACC-new-SECRET-leak");
  });
});
