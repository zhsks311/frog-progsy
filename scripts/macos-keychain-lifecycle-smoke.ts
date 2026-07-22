#!/usr/bin/env bun
/**
 * CI-only macOS Keychain lifecycle smoke for isolated Claude subscription grants.
 *
 * Proves — against the REAL macOS `security` Keychain and the REAL production `defaultKeychain` /
 * `defaultAccount` in `src/claude-grant-auth.ts` — that frogprogsy's PRODUCT public functions read /
 * status / delete (twice, idempotently) a grant's scoped credential end to end, and that the
 * native/global `Claude Code-credentials` service never appears as a raw `security` service argument.
 *
 * Real CI path (never bypasses production):
 *  - A raw `security add-generic-password` SEEDS a unique scoped grant item, keyed by the exact scoped
 *    service (`expectedKeychainService`) and the SAME account the production `defaultAccount()` uses.
 *  - `getClaudeGrantAccessToken` / `inspectClaudeGrantStatus` / `deleteClaudeGrantCredential` are then
 *    called WITHOUT any keychain/account override, so they run through the production `defaultKeychain`
 *    and `defaultAccount()` and actually hit the real Keychain.
 *  - Raw `security` is used ONLY to seed the item and, in `--cleanup` mode / `finally`, to delete it.
 *
 * Fail-closed safety invariants:
 *  - Touches the real Keychain ONLY when `process.platform === "darwin"` AND `CI === "true"` AND the
 *    explicit opt-in `FROGP_KEYCHAIN_SMOKE === "1"` is set. Anywhere else it skips WITHOUT invoking
 *    `security`. The workflow additionally gates on `runner.environment == 'github-hosted'`.
 *  - `FROGPROGSY_HOME` is forced to a throwaway temp dir for the run and restored in `finally`, so the
 *    real `~/.frogprogsy`, native Claude homes, grants, and credentials are never read or written.
 *  - Only a UNIQUE scoped grant service (`Claude Code-credentials-<hash>`) and a dummy credential are
 *    created; the native/unscoped service and any pre-existing user item are never created, read, or
 *    deleted. `assertScopedKeychainService` guards the derived service and every cleanup delete, and
 *    the native service is never placed in any raw `security` argv.
 *  - The scoped service + account (NO secret) are recorded to a `RUNNER_TEMP` cleanup file BEFORE the
 *    item is created, so an `if: always()` `--cleanup` step can idempotently delete the exact scoped
 *    item even after the main step fails or times out. `finally` also deletes the item, removes the
 *    temp dir, and clears this run's record.
 *  - No raw token, secret, service name, account, or path is ever printed — only redacted booleans /
 *    coarse states / typed-error labels / counts.
 *
 * The behavioural seams (`runSecurity`, `runnerTemp`, temp-home, and a test-only `productDepsOverride`)
 * exist so UNIT tests can exercise the argv / guard / cleanup contract with a fully in-memory Keychain
 * and never touch the real one; production leaves `productDepsOverride` undefined.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  deleteClaudeGrantCredential,
  getClaudeGrantAccessToken,
  inspectClaudeGrantStatus,
  type ClaudeGrantAuthDeps,
} from "../src/claude-grant-auth";
import {
  addClaudeGrant,
  assertScopedKeychainService,
  expectedKeychainService,
  isScopedKeychainService,
  KEYCHAIN_SERVICE_PREFIX,
  NATIVE_KEYCHAIN_SERVICE,
} from "../src/claude-grants";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

export { KEYCHAIN_SERVICE_PREFIX, NATIVE_KEYCHAIN_SERVICE };

/** macOS `security` exit status for errSecItemNotFound. */
const SEC_ITEM_NOT_FOUND = 44;
/** Dummy credential freshness so the product read never attempts a network refresh. */
const FRESH_TTL_MS = 60 * 60 * 1000;
/** Opt-in env the workflow sets explicitly for the main smoke step. */
export const OPT_IN_ENV = "FROGP_KEYCHAIN_SMOKE";
/** Cleanup record file name under `RUNNER_TEMP` (service + account only, never a secret). */
const CLEANUP_RECORD_FILE = "frogp-keychain-smoke-cleanup.jsonl";

export interface SecurityResult {
  status: number | null;
  stdout: string;
}

/** Runs the macOS `security` CLI with the given argv. Injected in tests to avoid the real Keychain. */
export type SecurityRunner = (args: readonly string[]) => SecurityResult;

export interface SmokeCheck {
  id: string;
  pass: boolean;
  /** Redacted — never a token, secret, service name, account, or path. */
  detail: string;
}

export interface KeychainSmokeDeps {
  platform: NodeJS.Platform;
  ci: boolean;
  optIn: boolean;
  now: () => number;
  /** Account for the raw `security` seed/cleanup. MUST mirror production `defaultAccount()` in CI. */
  account: string;
  /** Raw `security` runner — used ONLY to seed the item and to delete it (finally / --cleanup). */
  runSecurity: SecurityRunner;
  runnerTemp: string;
  makeTempHome: () => string;
  removeTempHome: (path: string) => void;
  log: (line: string) => void;
  /**
   * TEST-ONLY override forwarded to the product read/status/delete calls. Undefined in production so
   * the real `defaultKeychain` / `defaultAccount` / `Date.now` / file lock run unchanged and actually
   * hit the real Keychain.
   */
  productDepsOverride?: Partial<ClaudeGrantAuthDeps>;
}

export interface KeychainSmokeResult {
  outcome: "passed" | "failed" | "skipped";
  platform: NodeJS.Platform;
  ci: boolean;
  optIn: boolean;
  reason?: string;
  checks: SmokeCheck[];
  /** Number of raw `security` invocations the smoke itself issued (seed + finally cleanup). */
  rawSecurityInvocations: number;
  nativeServiceAbsentFromArgv: boolean;
  onlyScopedServiceInArgv: boolean;
  cleanup: { scopedItemRemoved: boolean; tempHomeRemoved: boolean; recordCleared: boolean };
}

export interface KeychainCleanupResult {
  outcome: "cleaned" | "failed" | "skipped";
  reason?: string;
  records: number;
  deleted: number;
  failed: number;
  skippedNonScoped: number;
  nativeServiceAbsentFromArgv: boolean;
}

/** Cleanup record (no secret): the exact scoped service + account to idempotently delete. */
export interface CleanupRecord {
  service: string;
  account: string;
}

/** Production `security` runner. Bounded, stdout captured, never merges caller stderr into evidence. */
export function defaultRunSecurity(args: readonly string[]): SecurityResult {
  const result = spawnSync("security", [...args], { encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/**
 * Mirror of the production `defaultAccount()` in `src/claude-grant-auth.ts` so the raw-security seed
 * writes to the SAME account the production `defaultKeychain` will read/delete. Keep in sync.
 */
export function productAccount(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    /* fall through */
  }
  return process.env.USER || process.env.LOGNAME || "frogprogsy";
}

export function resolveKeychainSmokeDeps(overrides: Partial<KeychainSmokeDeps> = {}): KeychainSmokeDeps {
  return {
    platform: overrides.platform ?? process.platform,
    ci: overrides.ci ?? (process.env.CI === "true"),
    optIn: overrides.optIn ?? (process.env[OPT_IN_ENV] === "1"),
    now: overrides.now ?? Date.now,
    account: overrides.account ?? productAccount(),
    runSecurity: overrides.runSecurity ?? defaultRunSecurity,
    runnerTemp: overrides.runnerTemp ?? (process.env.RUNNER_TEMP && process.env.RUNNER_TEMP.trim() ? process.env.RUNNER_TEMP : tmpdir()),
    makeTempHome: overrides.makeTempHome ?? (() => mkdtempSync(join(tmpdir(), "frogp-kc-smoke-"))),
    removeTempHome: overrides.removeTempHome ?? ((path) => rmSync(path, { recursive: true, force: true })),
    log: overrides.log ?? ((line) => console.log(line)),
    productDepsOverride: overrides.productDepsOverride,
  };
}

// ── cleanup record I/O (RUNNER_TEMP, service + account only) ───────────────────────────────────

export function cleanupRecordFile(runnerTemp: string): string {
  return join(runnerTemp, CLEANUP_RECORD_FILE);
}

/** Append one `{service, account}` record (no secret) so a crash/timeout can still be cleaned up. */
export function appendCleanupRecord(runnerTemp: string, record: CleanupRecord): void {
  const file = cleanupRecordFile(runnerTemp);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readCleanupRecords(runnerTemp: string): CleanupRecord[] {
  let raw: string;
  try {
    raw = readFileSync(cleanupRecordFile(runnerTemp), "utf8");
  } catch {
    return [];
  }
  const out: CleanupRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object"
        && typeof (parsed as CleanupRecord).service === "string"
        && typeof (parsed as CleanupRecord).account === "string") {
        out.push({ service: (parsed as CleanupRecord).service, account: (parsed as CleanupRecord).account });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export function clearCleanupRecords(runnerTemp: string): void {
  try {
    rmSync(cleanupRecordFile(runnerTemp), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Remove ONLY the records matching `record` (exact service + account), preserving every other record.
 * Rewrites the file (or deletes it when empty). Safer than blanket-clearing when multiple parallel
 * records may be present. Best-effort — a rewrite failure leaves the record in place for a later retry.
 */
export function removeCleanupRecord(runnerTemp: string, record: CleanupRecord): void {
  const remaining = readCleanupRecords(runnerTemp)
    .filter((r) => !(r.service === record.service && r.account === record.account));
  const file = cleanupRecordFile(runnerTemp);
  try {
    if (remaining.length === 0) {
      rmSync(file, { force: true });
      return;
    }
    writeFileSync(file, `${remaining.map((r) => JSON.stringify(r)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best-effort — never mask the primary result; the record stays for the --cleanup retry */
  }
}

/** Redacted, path/token-free label for a caught error (typed grant errors keep only name + code). */
function errorLabel(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
    return code ? `${err.name}:${code}` : err.name;
  }
  return "non-error-throw";
}

/** Extract the value following the first `-s` flag in a `security` argv, if any. */
function serviceArg(argv: readonly string[]): string | undefined {
  const i = argv.indexOf("-s");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Native is judged ONLY by exact equality on the `-s` service argument (a scoped prefix is NOT native). */
function nativeServiceAbsent(argv: readonly string[][]): boolean {
  return !argv.map(serviceArg).some((s) => s === NATIVE_KEYCHAIN_SERVICE);
}

function onlyScopedServices(argv: readonly string[][]): boolean {
  const services = argv.map(serviceArg).filter((s): s is string => s !== undefined);
  return services.length > 0 && services.every((s) => isScopedKeychainService(s));
}

/**
 * Drive seed -> product read -> product status -> product delete (x2, idempotent) -> absence against a
 * unique scoped grant Keychain item. Returns a redacted result; never throws for a lifecycle failure
 * (records it as a failing check) and always runs cleanup.
 */
export async function runKeychainLifecycleSmoke(depsOverride: Partial<KeychainSmokeDeps> = {}): Promise<KeychainSmokeResult> {
  const deps = resolveKeychainSmokeDeps(depsOverride);
  const cleanup = { scopedItemRemoved: false, tempHomeRemoved: false, recordCleared: false };

  // Fail-closed guard: only touch the real Keychain on opted-in macOS CI. No `security` runs otherwise.
  if (deps.platform !== "darwin" || !deps.ci || !deps.optIn) {
    const reason = deps.platform !== "darwin"
      ? `skipped: real Keychain smoke runs only on darwin (platform=${deps.platform})`
      : !deps.ci
        ? "skipped: real Keychain smoke runs only when CI=true"
        : `skipped: real Keychain smoke requires explicit opt-in (${OPT_IN_ENV}=1)`;
    deps.log(reason);
    return {
      outcome: "skipped",
      platform: deps.platform,
      ci: deps.ci,
      optIn: deps.optIn,
      reason,
      checks: [],
      rawSecurityInvocations: 0,
      nativeServiceAbsentFromArgv: true,
      onlyScopedServiceInArgv: true,
      cleanup,
    };
  }

  // Raw `security` is used ONLY to seed the item and to delete it in finally; every call is recorded so
  // we can assert the native service never appears and only scoped services do.
  const rawArgv: string[][] = [];
  const runRaw = (args: readonly string[]): SecurityResult => {
    rawArgv.push([...args]);
    return deps.runSecurity(args);
  };

  const checks: SmokeCheck[] = [];
  const now = deps.now();
  const account = deps.account;

  const prevHome = process.env.FROGPROGSY_HOME;
  let tempHome: string | undefined;
  let scopedService: string | undefined;
  let hadError: string | null = null;

  try {
    tempHome = deps.makeTempHome();
    process.env.FROGPROGSY_HOME = tempHome; // force isolation before any grant path is resolved

    const config = { port: 0, providers: {}, defaultProvider: "" } as FrogConfig;
    const grant = addClaudeGrant(config, { label: "keychain-lifecycle-smoke" });

    // Product derivation + hard assert: the service MUST be a scoped grant service, never native/global.
    scopedService = assertScopedKeychainService("keychain lifecycle smoke", expectedKeychainService(grant.configDir));
    const isScoped = isScopedKeychainService(scopedService) && scopedService !== NATIVE_KEYCHAIN_SERVICE;
    checks.push({
      id: "scoped-service-not-native",
      pass: isScoped,
      detail: "derived Keychain service is scoped, not the native Claude Code-credentials service",
    });
    if (!isScoped) throw new Error("derived Keychain service is not scoped");

    // Record the exact scoped service + account (no secret) BEFORE creating the item, so an
    // if:always() cleanup step can idempotently delete it even if this process is killed/timed out.
    appendCleanupRecord(deps.runnerTemp, { service: scopedService, account });

    // ── seed: create the unique scoped grant item + dummy (fresh) credential via RAW security ─────
    const dummy = JSON.stringify({
      claudeAiOauth: {
        accessToken: `dummy-access-${randomBytes(6).toString("hex")}`,
        refreshToken: `dummy-refresh-${randomBytes(6).toString("hex")}`,
        expiresAt: now + FRESH_TTL_MS,
        scopes: ["user:inference"],
      },
    });
    const seed = runRaw(["add-generic-password", "-U", "-a", account, "-s", scopedService, "-w", dummy]);
    if (seed.status !== 0) throw new Error(`seed add-generic-password failed (status ${seed.status ?? "unknown"})`);

    const provider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://keychain-smoke.invalid",
      authMode: "claude-grant",
      claudeGrantId: grant.id,
    };
    // Production leaves this undefined so the real defaultKeychain / defaultAccount actually run;
    // unit tests inject an in-memory keychain + matching account here.
    const productDeps = deps.productDepsOverride;

    // ── product read (through production defaultKeychain; never prints the returned token) ────────
    const token = await getClaudeGrantAccessToken(config, "keychain-smoke-provider", provider, productDeps);
    checks.push({
      id: "product-read",
      pass: typeof token === "string" && token.length > 0,
      detail: "getClaudeGrantAccessToken returned a usable token (value never printed)",
    });

    // ── product status ───────────────────────────────────────────────────────────────────────────
    const statusBefore = inspectClaudeGrantStatus(config, grant, productDeps);
    checks.push({
      id: "product-status-ok",
      pass: statusBefore.state === "ok",
      detail: `inspectClaudeGrantStatus state=${statusBefore.state}`,
    });

    // ── product delete #1 ──────────────────────────────────────────────────────────────────────
    await deleteClaudeGrantCredential(grant, productDeps);

    // ── product delete #2: idempotent no-op on the now-missing item (errSecItemNotFound == success) ─
    let idempotentOk = false;
    try {
      await deleteClaudeGrantCredential(grant, productDeps);
      idempotentOk = true;
    } catch {
      idempotentOk = false;
    }
    checks.push({
      id: "product-delete-idempotent",
      pass: idempotentOk,
      detail: "second deleteClaudeGrantCredential resolved as an errSecItemNotFound no-op",
    });

    // ── absence verification via product status (through production defaultKeychain) ─────────────
    const statusAfter = inspectClaudeGrantStatus(config, grant, productDeps);
    checks.push({
      id: "product-status-none-after-delete",
      pass: statusAfter.state === "none",
      detail: `post-delete inspectClaudeGrantStatus state=${statusAfter.state}`,
    });
  } catch (err) {
    hadError = errorLabel(err);
  } finally {
    // Unconditional cleanup: drop the scoped item (raw security) and the temp home even on failure.
    if (scopedService) {
      try {
        const del = runRaw(["delete-generic-password", "-s", scopedService, "-a", account]);
        cleanup.scopedItemRemoved = del.status === 0 || del.status === SEC_ITEM_NOT_FOUND;
      } catch {
        /* best-effort — never mask the primary result */
      }
    }
    if (tempHome) {
      try {
        deps.removeTempHome(tempHome);
        cleanup.tempHomeRemoved = true;
      } catch {
        /* best-effort */
      }
    }
    // Remove ONLY this run's record, and ONLY if the scoped item was actually deleted here. On any
    // delete failure/throw the record is preserved so the workflow's if:always() --cleanup step retries.
    if (scopedService && cleanup.scopedItemRemoved) {
      removeCleanupRecord(deps.runnerTemp, { service: scopedService, account });
      cleanup.recordCleared = true;
    }
    if (prevHome === undefined) delete process.env.FROGPROGSY_HOME;
    else process.env.FROGPROGSY_HOME = prevHome;
  }

  // ── argv contract on the raw security we issued: native must never appear, only scoped may ───────
  const nativeAbsent = nativeServiceAbsent(rawArgv);
  const onlyScoped = onlyScopedServices(rawArgv);
  checks.push({
    id: "native-service-absent-from-argv",
    pass: nativeAbsent,
    detail: "no raw security invocation used the native Claude Code-credentials service argument",
  });
  checks.push({
    id: "only-scoped-service-in-argv",
    pass: onlyScoped,
    detail: "every raw security -s argument was a scoped grant service",
  });
  if (hadError) {
    checks.push({ id: "no-lifecycle-error", pass: false, detail: `lifecycle error: ${hadError}` });
  }

  return {
    outcome: checks.every((c) => c.pass) ? "passed" : "failed",
    platform: deps.platform,
    ci: deps.ci,
    optIn: deps.optIn,
    checks,
    rawSecurityInvocations: rawArgv.length,
    nativeServiceAbsentFromArgv: nativeAbsent,
    onlyScopedServiceInArgv: onlyScoped,
    cleanup,
  };
}

/**
 * `--cleanup` mode: idempotently delete every recorded scoped item with raw `security`. Safe to run
 * `if: always()` after the main step fails or times out. Refuses any non-scoped/native record (never
 * passes the native service to `security`). errSecItemNotFound is success. Each cleaned item and each
 * refused (non-scoped) record is removed; a record whose scoped delete genuinely fails is preserved.
 */
export async function runKeychainCleanup(depsOverride: Partial<KeychainSmokeDeps> = {}): Promise<KeychainCleanupResult> {
  const deps = resolveKeychainSmokeDeps(depsOverride);
  // Same fail-closed gate as the main smoke: cleanup also runs raw `security`, so it must never touch
  // a local (non-CI) Mac Keychain. Requires darwin + CI=true + explicit opt-in; else a no-op skip that
  // leaves the record file untouched for a properly-gated retry.
  if (deps.platform !== "darwin" || !deps.ci || !deps.optIn) {
    const reason = deps.platform !== "darwin"
      ? `skipped: cleanup runs only on darwin (platform=${deps.platform})`
      : !deps.ci
        ? "skipped: cleanup runs only when CI=true"
        : `skipped: cleanup requires explicit opt-in (${OPT_IN_ENV}=1)`;
    deps.log(reason);
    return { outcome: "skipped", reason, records: 0, deleted: 0, failed: 0, skippedNonScoped: 0, nativeServiceAbsentFromArgv: true };
  }

  const records = readCleanupRecords(deps.runnerTemp);
  const rawArgv: string[][] = [];
  const runRaw = (args: readonly string[]): SecurityResult => {
    rawArgv.push([...args]);
    return deps.runSecurity(args);
  };

  let deleted = 0;
  let failed = 0;
  let skippedNonScoped = 0;
  const toRemove: CleanupRecord[] = [];
  for (const record of records) {
    // Product assert / guard: never route a non-scoped or native service to `security`.
    if (!isScopedKeychainService(record.service)) {
      skippedNonScoped++;
      deps.log("cleanup skipped a non-scoped record");
      toRemove.push(record); // invalid/native — never actionable, drop it
      continue;
    }
    try {
      assertScopedKeychainService("keychain smoke cleanup", record.service);
      const del = runRaw(["delete-generic-password", "-s", record.service, "-a", record.account]);
      if (del.status === 0 || del.status === SEC_ITEM_NOT_FOUND) {
        deleted++; // idempotent
        toRemove.push(record); // cleaned — drop it
      } else {
        failed++;
      }
      // A genuine delete failure (other status) is preserved so a later run can retry.
    } catch {
      failed++;
      // Keep the record for retry, but surface the cleanup failure to CI.
    }
  }
  // Remove only records we actually handled; failed scoped records remain for a later retry.
  for (const record of toRemove) removeCleanupRecord(deps.runnerTemp, record);

  const nativeAbsent = nativeServiceAbsent(rawArgv);
  deps.log(`macos-keychain-lifecycle-smoke cleanup: records=${records.length} deleted=${deleted} failed=${failed} skippedNonScoped=${skippedNonScoped} nativeServiceAbsentFromArgv=${nativeAbsent}`);
  return {
    outcome: failed === 0 && skippedNonScoped === 0 ? "cleaned" : "failed",
    records: records.length,
    deleted,
    failed,
    skippedNonScoped,
    nativeServiceAbsentFromArgv: nativeAbsent,
  };
}

export async function main(rawArgs: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (rawArgs.includes("--cleanup")) {
    const result = await runKeychainCleanup();
    return result.outcome === "failed" || !result.nativeServiceAbsentFromArgv ? 1 : 0;
  }

  const result = await runKeychainLifecycleSmoke();
  console.log(`macos-keychain-lifecycle-smoke: ${result.outcome}`);
  if (result.reason) console.log(`  reason: ${result.reason}`);
  for (const c of result.checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
  console.log(`  raw security invocations: ${result.rawSecurityInvocations}`);
  console.log(`  native service absent from argv: ${result.nativeServiceAbsentFromArgv}`);
  console.log(`  only scoped service in argv: ${result.onlyScopedServiceInArgv}`);
  console.log(`  cleanup: scopedItemRemoved=${result.cleanup.scopedItemRemoved} tempHomeRemoved=${result.cleanup.tempHomeRemoved} recordCleared=${result.cleanup.recordCleared}`);
  if (result.outcome === "skipped") return 0;
  return result.outcome === "passed" ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`macos-keychain-lifecycle-smoke fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    });
}
