import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCleanupRecord,
  cleanupRecordFile,
  clearCleanupRecords,
  KEYCHAIN_SERVICE_PREFIX,
  NATIVE_KEYCHAIN_SERVICE,
  productAccount,
  readCleanupRecords,
  removeCleanupRecord,
  runKeychainCleanup,
  runKeychainLifecycleSmoke,
  type KeychainSmokeDeps,
  type SecurityResult,
  type SecurityRunner,
} from "../scripts/macos-keychain-lifecycle-smoke";
import type { ClaudeGrantAuthDeps, KeychainAccess } from "../src/claude-grant-auth";

const NOW = 1_800_000_000_000;

/**
 * In-memory `security` emulator shared between the raw seed/cleanup runner AND the product
 * `KeychainAccess` seam, so every lifecycle Keychain call is observable via one `argv` list and one
 * `store`. Never touches the real Keychain.
 */
function makeFakeBackend(opts: { failFind?: boolean; failDelete?: boolean } = {}): {
  run: SecurityRunner;
  keychain: Required<KeychainAccess>;
  store: Map<string, string>;
  argv: string[][];
} {
  const store = new Map<string, string>();
  const argv: string[][] = [];
  const key = (service: string, account: string) => `${service}\u0000${account}`;
  const val = (args: readonly string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const run: SecurityRunner = (args): SecurityResult => {
    argv.push([...args]);
    const cmd = args[0];
    const service = val(args, "-s");
    const account = val(args, "-a");
    if (cmd === "add-generic-password") {
      store.set(key(service!, account!), val(args, "-w")!);
      return { status: 0, stdout: "" };
    }
    if (cmd === "find-generic-password") {
      if (opts.failFind) return { status: 1, stdout: "" };
      const v = store.get(key(service!, account!));
      return v === undefined ? { status: 44, stdout: "" } : { status: 0, stdout: `${v}\n` };
    }
    if (cmd === "delete-generic-password") {
      if (opts.failDelete) return { status: 1, stdout: "" }; // simulate a stubborn delete (item kept)
      const existed = store.delete(key(service!, account!));
      return { status: existed ? 0 : 44, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  const keychain: Required<KeychainAccess> = {
    read(service, account) {
      const r = run(["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (r.status === 0) return r.stdout.replace(/\n$/, "");
      if (r.status === 44) return null;
      throw new Error(`fake keychain read failed (status ${r.status})`);
    },
    write(service, account, secret) {
      const r = run(["add-generic-password", "-U", "-a", account, "-s", service, "-w", secret]);
      if (r.status !== 0) throw new Error(`fake keychain write failed (status ${r.status})`);
    },
    delete(service, account) {
      const r = run(["delete-generic-password", "-s", service, "-a", account]);
      if (r.status === 0 || r.status === 44) return;
      throw new Error(`fake keychain delete failed (status ${r.status})`);
    },
  };
  return { run, keychain, store, argv };
}

function serviceArgs(argv: readonly string[][]): string[] {
  return argv
    .map((a) => {
      const i = a.indexOf("-s");
      return i >= 0 && i + 1 < a.length ? a[i + 1] : undefined;
    })
    .filter((s): s is string => s !== undefined);
}

function tempRunnerDir(): string {
  return mkdtempSync(join(tmpdir(), "kc-smoke-runnertemp-"));
}

/** Build lifecycle deps wired to a fake backend (unit-test-only seam injection). */
function fakeLifecycleDeps(
  fake: ReturnType<typeof makeFakeBackend>,
  runnerTemp: string,
  extra: Partial<KeychainSmokeDeps> = {},
): { deps: Partial<KeychainSmokeDeps>; tempHomes: string[]; removedTempHomes: string[] } {
  const account = "kc-smoke-acct";
  const tempHomes: string[] = [];
  const removedTempHomes: string[] = [];
  const productDepsOverride: Partial<ClaudeGrantAuthDeps> = {
    platform: "darwin",
    account,
    now: () => NOW,
    keychain: fake.keychain,
    lock: { acquire: async () => () => {} },
    fetch: (async () => {
      throw new Error("keychain smoke test: network must not be called");
    }) as unknown as ClaudeGrantAuthDeps["fetch"],
  };
  const deps: Partial<KeychainSmokeDeps> = {
    platform: "darwin",
    ci: true,
    optIn: true,
    now: () => NOW,
    account,
    runSecurity: fake.run,
    runnerTemp,
    makeTempHome: () => {
      const p = mkdtempSync(join(tmpdir(), "kc-smoke-home-"));
      tempHomes.push(p);
      return p;
    },
    removeTempHome: (p) => {
      rmSync(p, { recursive: true, force: true });
      removedTempHomes.push(p);
    },
    log: () => {},
    productDepsOverride,
    ...extra,
  };
  return { deps, tempHomes, removedTempHomes };
}

describe("macos keychain lifecycle smoke — fail-closed guard", () => {
  test("skips on non-darwin without invoking security or creating a temp home", async () => {
    let securityCalled = false;
    let tempMade = false;
    const result = await runKeychainLifecycleSmoke({
      platform: "linux",
      ci: true,
      optIn: true,
      runSecurity: () => {
        securityCalled = true;
        return { status: 0, stdout: "" };
      },
      makeTempHome: () => {
        tempMade = true;
        return "/tmp/should-not-be-made";
      },
      removeTempHome: () => {},
      runnerTemp: tmpdir(),
      log: () => {},
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("darwin");
    expect(securityCalled).toBe(false);
    expect(tempMade).toBe(false);
  });

  test("skips when CI is not true", async () => {
    let securityCalled = false;
    const result = await runKeychainLifecycleSmoke({
      platform: "darwin",
      ci: false,
      optIn: true,
      runSecurity: () => {
        securityCalled = true;
        return { status: 0, stdout: "" };
      },
      makeTempHome: () => "/tmp/nope",
      removeTempHome: () => {},
      runnerTemp: tmpdir(),
      log: () => {},
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("CI=true");
    expect(securityCalled).toBe(false);
  });

  test("skips when the explicit opt-in is missing", async () => {
    let securityCalled = false;
    const result = await runKeychainLifecycleSmoke({
      platform: "darwin",
      ci: true,
      optIn: false,
      runSecurity: () => {
        securityCalled = true;
        return { status: 0, stdout: "" };
      },
      makeTempHome: () => "/tmp/nope",
      removeTempHome: () => {},
      runnerTemp: tmpdir(),
      log: () => {},
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("FROGP_KEYCHAIN_SMOKE=1");
    expect(securityCalled).toBe(false);
  });
});

describe("macos keychain lifecycle smoke — lifecycle contract (fake keychain)", () => {
  test("seed -> product read/status -> delete (x2 idempotent) -> absence, scoped only, native never in argv", async () => {
    const runnerTemp = tempRunnerDir();
    const fake = makeFakeBackend();
    const { deps, tempHomes, removedTempHomes } = fakeLifecycleDeps(fake, runnerTemp);
    try {
      const result = await runKeychainLifecycleSmoke(deps);

      expect(result.outcome).toBe("passed");
      const ids = result.checks.filter((c) => c.pass).map((c) => c.id);
      expect(ids).toContain("scoped-service-not-native");
      expect(ids).toContain("product-read");
      expect(ids).toContain("product-status-ok");
      expect(ids).toContain("product-delete-idempotent");
      expect(ids).toContain("product-status-none-after-delete");
      expect(ids).toContain("native-service-absent-from-argv");
      expect(ids).toContain("only-scoped-service-in-argv");

      // Every observed `security -s` argument is scoped; the native service (a strict prefix of the
      // scoped service) is NEVER matched by exact equality — regression guard for the argv check.
      const services = serviceArgs(fake.argv);
      expect(services.length).toBeGreaterThan(0);
      expect(services.every((s) => s.startsWith(KEYCHAIN_SERVICE_PREFIX))).toBe(true);
      expect(services.some((s) => s === NATIVE_KEYCHAIN_SERVICE)).toBe(false);

      // Two product deletes were issued; the second hit the already-absent item (errSecItemNotFound).
      const deletes = fake.argv.filter((a) => a[0] === "delete-generic-password");
      expect(deletes.length).toBeGreaterThanOrEqual(2);

      // Store is empty (item created then removed) and the run cleaned up after itself.
      expect(fake.store.size).toBe(0);
      expect(result.cleanup.scopedItemRemoved).toBe(true);
      expect(result.cleanup.tempHomeRemoved).toBe(true);
      expect(result.cleanup.recordCleared).toBe(true);
      expect(readCleanupRecords(runnerTemp)).toHaveLength(0);
      expect(tempHomes).toHaveLength(1);
      expect(removedTempHomes).toEqual(tempHomes);
      expect(existsSync(tempHomes[0]!)).toBe(false);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("runs cleanup unconditionally when a product call fails (finally still deletes + removes temp home)", async () => {
    const runnerTemp = tempRunnerDir();
    const fake = makeFakeBackend({ failFind: true }); // product read errors -> lifecycle failure
    const { deps, tempHomes } = fakeLifecycleDeps(fake, runnerTemp);
    try {
      const result = await runKeychainLifecycleSmoke(deps);

      expect(result.outcome).toBe("failed");
      expect(result.checks.some((c) => c.id === "no-lifecycle-error" && !c.pass)).toBe(true);

      // Despite the failure, the scoped item + temp home + record were cleaned up.
      expect(result.cleanup.scopedItemRemoved).toBe(true);
      expect(result.cleanup.tempHomeRemoved).toBe(true);
      expect(result.cleanup.recordCleared).toBe(true);
      expect(fake.store.size).toBe(0);
      expect(readCleanupRecords(runnerTemp)).toHaveLength(0);
      expect(existsSync(tempHomes[0]!)).toBe(false);

      // Even on the failure path, native never appears as a service argument.
      expect(result.nativeServiceAbsentFromArgv).toBe(true);
      expect(serviceArgs(fake.argv).some((s) => s === NATIVE_KEYCHAIN_SERVICE)).toBe(false);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("preserves the cleanup record when the scoped delete fails so the always() cleanup can retry", async () => {
    const runnerTemp = tempRunnerDir();
    const fake = makeFakeBackend({ failDelete: true }); // every scoped delete errors
    const { deps, tempHomes } = fakeLifecycleDeps(fake, runnerTemp);
    try {
      const result = await runKeychainLifecycleSmoke(deps);

      expect(result.outcome).toBe("failed");
      // The scoped item could not be deleted, so this run's record MUST be preserved for retry.
      expect(result.cleanup.scopedItemRemoved).toBe(false);
      expect(result.cleanup.recordCleared).toBe(false);
      const records = readCleanupRecords(runnerTemp);
      expect(records).toHaveLength(1);
      expect(records[0]!.service.startsWith(KEYCHAIN_SERVICE_PREFIX)).toBe(true);
      expect(records[0]!.service).not.toBe(NATIVE_KEYCHAIN_SERVICE);

      // The temp home is still cleaned regardless, and native never appears in argv.
      expect(result.cleanup.tempHomeRemoved).toBe(true);
      expect(existsSync(tempHomes[0]!)).toBe(false);
      expect(result.nativeServiceAbsentFromArgv).toBe(true);

      // A subsequent --cleanup run finds the preserved record and (with delete working) removes it.
      const healthy = makeFakeBackend();
      // Re-seed the item into the healthy backend so the retry has something to delete.
      healthy.run(["add-generic-password", "-U", "-a", records[0]!.account, "-s", records[0]!.service, "-w", "{}"]);
      const retry = await runKeychainCleanup({ platform: "darwin", ci: true, optIn: true, runSecurity: healthy.run, runnerTemp, log: () => {} });
      expect(retry.records).toBe(1);
      expect(retry.deleted).toBe(1);
      expect(readCleanupRecords(runnerTemp)).toHaveLength(0);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("records the scoped service + account (no secret) BEFORE the item is created", async () => {
    const runnerTemp = tempRunnerDir();
    const captured: string[] = [];
    const fake = makeFakeBackend();
    // Snapshot the record file the moment the seed `add-generic-password` runs.
    const wrappedRun: SecurityRunner = (args) => {
      if (args[0] === "add-generic-password") {
        captured.push(...readCleanupRecords(runnerTemp).map((r) => r.service));
      }
      return fake.run(args);
    };
    const { deps } = fakeLifecycleDeps(fake, runnerTemp, { runSecurity: wrappedRun });
    try {
      const result = await runKeychainLifecycleSmoke(deps);
      expect(result.outcome).toBe("passed");
      // A record existed at seed time (recorded before creation) and carried a scoped service only.
      expect(captured.length).toBeGreaterThan(0);
      expect(captured.every((s) => s.startsWith(KEYCHAIN_SERVICE_PREFIX))).toBe(true);
      expect(captured.some((s) => s === NATIVE_KEYCHAIN_SERVICE)).toBe(false);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});

describe("macos keychain lifecycle smoke — --cleanup mode", () => {
  test("idempotently deletes a recorded scoped item and clears the record", async () => {
    const runnerTemp = tempRunnerDir();
    const fake = makeFakeBackend();
    const service = `${KEYCHAIN_SERVICE_PREFIX}deadbeef`;
    const account = "kc-smoke-acct";
    try {
      // Simulate a crashed main step: the item exists and a record was left behind.
      fake.run(["add-generic-password", "-U", "-a", account, "-s", service, "-w", "{}"]);
      appendCleanupRecord(runnerTemp, { service, account });

      const first = await runKeychainCleanup({ platform: "darwin", ci: true, optIn: true, runSecurity: fake.run, runnerTemp, log: () => {} });
      expect(first.outcome).toBe("cleaned");
      expect(first.records).toBe(1);
      expect(first.deleted).toBe(1);
      expect(first.failed).toBe(0);
      expect(first.nativeServiceAbsentFromArgv).toBe(true);
      expect(fake.store.size).toBe(0);
      expect(readCleanupRecords(runnerTemp)).toHaveLength(0);

      // Running again is a no-op (record file already cleared) — idempotent.
      const second = await runKeychainCleanup({ platform: "darwin", ci: true, optIn: true, runSecurity: fake.run, runnerTemp, log: () => {} });
      expect(second.records).toBe(0);
      expect(second.deleted).toBe(0);
      expect(second.failed).toBe(0);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("refuses a native/non-scoped record and never passes the native service to security", async () => {
    const runnerTemp = tempRunnerDir();
    const fake = makeFakeBackend();
    const scoped = `${KEYCHAIN_SERVICE_PREFIX}cafef00d`;
    const account = "kc-smoke-acct";
    try {
      fake.run(["add-generic-password", "-U", "-a", account, "-s", scoped, "-w", "{}"]);
      appendCleanupRecord(runnerTemp, { service: NATIVE_KEYCHAIN_SERVICE, account });
      appendCleanupRecord(runnerTemp, { service: scoped, account });

      const result = await runKeychainCleanup({ platform: "darwin", ci: true, optIn: true, runSecurity: fake.run, runnerTemp, log: () => {} });
      expect(result.outcome).toBe("failed");
      expect(result.records).toBe(2);
      expect(result.deleted).toBe(1);
      expect(result.skippedNonScoped).toBe(1);
      expect(result.nativeServiceAbsentFromArgv).toBe(true);

      // No `security` invocation referenced the native service.
      expect(serviceArgs(fake.argv).some((s) => s === NATIVE_KEYCHAIN_SERVICE)).toBe(false);
      // The native record was skipped entirely: only the scoped delete reached `security`.
      const deletes = fake.argv.filter((a) => a[0] === "delete-generic-password");
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toContain(scoped);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("fails closed and preserves the record when a scoped cleanup delete fails", async () => {
    const runnerTemp = tempRunnerDir();
    const fake = makeFakeBackend({ failDelete: true });
    const service = `${KEYCHAIN_SERVICE_PREFIX}feedface`;
    const account = "kc-smoke-acct";
    try {
      fake.run(["add-generic-password", "-U", "-a", account, "-s", service, "-w", "{}"]);
      appendCleanupRecord(runnerTemp, { service, account });

      const result = await runKeychainCleanup({
        platform: "darwin",
        ci: true,
        optIn: true,
        runSecurity: fake.run,
        runnerTemp,
        log: () => {},
      });

      expect(result.outcome).toBe("failed");
      expect(result.records).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.nativeServiceAbsentFromArgv).toBe(true);
      expect(readCleanupRecords(runnerTemp)).toEqual([{ service, account }]);
      expect(fake.store.size).toBe(1);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("skips on non-darwin", async () => {
    let securityCalled = false;
    const result = await runKeychainCleanup({
      platform: "win32",
      runSecurity: () => {
        securityCalled = true;
        return { status: 0, stdout: "" };
      },
      runnerTemp: tmpdir(),
      log: () => {},
    });
    expect(result.outcome).toBe("skipped");
    expect(securityCalled).toBe(false);
  });

  test("skips (no security) on darwin when CI is not true, leaving the record untouched", async () => {
    const runnerTemp = tempRunnerDir();
    let securityCalled = false;
    try {
      appendCleanupRecord(runnerTemp, { service: `${KEYCHAIN_SERVICE_PREFIX}abcd1234`, account: "a" });
      const result = await runKeychainCleanup({
        platform: "darwin",
        ci: false,
        optIn: true,
        runSecurity: () => {
          securityCalled = true;
          return { status: 0, stdout: "" };
        },
        runnerTemp,
        log: () => {},
      });
      expect(result.outcome).toBe("skipped");
      expect(result.reason).toContain("CI=true");
      expect(securityCalled).toBe(false);
      // The record is preserved for a properly-gated retry.
      expect(readCleanupRecords(runnerTemp)).toHaveLength(1);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("skips (no security) on darwin CI when the explicit opt-in is missing, leaving the record untouched", async () => {
    const runnerTemp = tempRunnerDir();
    let securityCalled = false;
    try {
      appendCleanupRecord(runnerTemp, { service: `${KEYCHAIN_SERVICE_PREFIX}abcd1234`, account: "a" });
      const result = await runKeychainCleanup({
        platform: "darwin",
        ci: true,
        optIn: false,
        runSecurity: () => {
          securityCalled = true;
          return { status: 0, stdout: "" };
        },
        runnerTemp,
        log: () => {},
      });
      expect(result.outcome).toBe("skipped");
      expect(result.reason).toContain("FROGP_KEYCHAIN_SMOKE=1");
      expect(securityCalled).toBe(false);
      expect(readCleanupRecords(runnerTemp)).toHaveLength(1);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});

describe("macos keychain lifecycle smoke — cleanup record I/O", () => {
  test("append/read/clear round-trips without dropping records", () => {
    const runnerTemp = tempRunnerDir();
    try {
      expect(readCleanupRecords(runnerTemp)).toHaveLength(0);
      appendCleanupRecord(runnerTemp, { service: `${KEYCHAIN_SERVICE_PREFIX}aa11bb22`, account: "a" });
      appendCleanupRecord(runnerTemp, { service: `${KEYCHAIN_SERVICE_PREFIX}cc33dd44`, account: "b" });
      const records = readCleanupRecords(runnerTemp);
      expect(records).toHaveLength(2);
      expect(records[0]!.service).toBe(`${KEYCHAIN_SERVICE_PREFIX}aa11bb22`);
      expect(records[1]!.account).toBe("b");
      clearCleanupRecords(runnerTemp);
      expect(readCleanupRecords(runnerTemp)).toHaveLength(0);
      expect(existsSync(cleanupRecordFile(runnerTemp))).toBe(false);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("removeCleanupRecord drops only the matching record and preserves the rest", () => {
    const runnerTemp = tempRunnerDir();
    const keep = { service: `${KEYCHAIN_SERVICE_PREFIX}11112222`, account: "keep" };
    const drop = { service: `${KEYCHAIN_SERVICE_PREFIX}33334444`, account: "drop" };
    try {
      appendCleanupRecord(runnerTemp, keep);
      appendCleanupRecord(runnerTemp, drop);
      removeCleanupRecord(runnerTemp, drop);
      const remaining = readCleanupRecords(runnerTemp);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.service).toBe(keep.service);
      expect(remaining[0]!.account).toBe("keep");
      // Removing the last record deletes the file entirely.
      removeCleanupRecord(runnerTemp, keep);
      expect(readCleanupRecords(runnerTemp)).toHaveLength(0);
      expect(existsSync(cleanupRecordFile(runnerTemp))).toBe(false);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("productAccount returns a non-empty account string", () => {
    expect(productAccount().length).toBeGreaterThan(0);
  });
});
