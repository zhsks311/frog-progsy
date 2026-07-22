import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cliSource = () => readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");

describe("frogp refresh detached lifecycle", () => {
  test("refresh does not mark its background proxy as externally service-managed", () => {
    const source = cliSource();
    const refreshStart = source.indexOf("async function handleRefresh()");
    expect(refreshStart).toBeGreaterThanOrEqual(0);
    const refreshSource = source.slice(refreshStart, source.indexOf("function killProxy", refreshStart));

    expect(refreshSource).toContain('FROGP_DETACHED: "1"');
    expect(refreshSource).toContain("FROGP_EXTERNAL_SUPERVISOR: undefined");
    expect(refreshSource).not.toContain('FROGP_EXTERNAL_SUPERVISOR: "1"');
  });

  test("detached proxies keep Claude settings injected without suppressing watchdog", () => {
    const source = cliSource();

    expect(source).toContain("!parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR) && !process.env.FROGP_DETACHED");
    expect(source).toContain("resolveWatchdogEnabled(_startConfig, process.env");
  });

  test("watchdog seeds last-known pid from the supervised parent", () => {
    const watchdogSource = readFileSync(join(import.meta.dir, "..", "src", "watchdog.ts"), "utf8");

    expect(watchdogSource).toContain("let lastKnownManagedPid: number | null = opts.parentPidHint ?? null");
  });
});
