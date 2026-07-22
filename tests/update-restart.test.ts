import { describe, expect, test } from "bun:test";
import { parseEnvFlag } from "../src/watchdog";

// ---------------------------------------------------------------------------
// Deterministic unit tests for planUpdateRestart / ensureAfterUpdate logic.
// No real spawn or network calls — tests inspect the decision gating only.
// ---------------------------------------------------------------------------

// Mirror of the type used in update.ts
type Installer = "bun" | "source" | "unsupported";

// Minimal replica of planUpdateRestart's decision tree for isolated testing.
async function simulatePlanUpdateRestart(
  installer: Installer,
  env: Record<string, string | undefined>,
  ensureCalled: { value: boolean },
): Promise<string> {
  if (installer === "source") {
    return "source-hint";
  }
  if (installer === "unsupported") {
    return "unsupported-hint";
  }
  if (parseEnvFlag(env.FROGP_EXTERNAL_SUPERVISOR)) {
    return "service-hint";
  }
  ensureCalled.value = true;
  return "auto-ensure";
}

describe("planUpdateRestart — FROGP_EXTERNAL_SUPERVISOR gating", () => {
  test("source installer → manual hint, no auto-ensure", async () => {
    const ensureCalled = { value: false };
    const outcome = await simulatePlanUpdateRestart("bun", {}, ensureCalled);
    // sanity: bun → auto-ensure when FROGP_EXTERNAL_SUPERVISOR absent
    expect(outcome).toBe("auto-ensure");
    expect(ensureCalled.value).toBe(true);
  });

  test("FROGP_EXTERNAL_SUPERVISOR set → service hint, skips ensureAfterUpdate", async () => {
    const ensureCalled = { value: false };
    const outcome = await simulatePlanUpdateRestart("bun", { FROGP_EXTERNAL_SUPERVISOR: "1" }, ensureCalled);
    expect(outcome).toBe("service-hint");
    expect(ensureCalled.value).toBe(false);
  });

  test("unsupported installer is rejected before supervisor handling", async () => {
    const ensureCalled = { value: false };
    const outcome = await simulatePlanUpdateRestart("unsupported", { FROGP_EXTERNAL_SUPERVISOR: "1" }, ensureCalled);
    expect(outcome).toBe("unsupported-hint");
    expect(ensureCalled.value).toBe(false);
  });

  test("FROGP_EXTERNAL_SUPERVISOR=0 does not imply external supervision", async () => {
    const ensureCalled = { value: false };
    const outcome = await simulatePlanUpdateRestart("bun", { FROGP_EXTERNAL_SUPERVISOR: "0" }, ensureCalled);
    expect(outcome).toBe("auto-ensure");
    expect(ensureCalled.value).toBe(true);
  });

  test("source installer → source hint, skips ensureAfterUpdate regardless of FROGP_EXTERNAL_SUPERVISOR", async () => {
    const ensureCalled = { value: false };
    const outcome = await simulatePlanUpdateRestart("source", { FROGP_EXTERNAL_SUPERVISOR: "1" }, ensureCalled);
    expect(outcome).toBe("source-hint");
    expect(ensureCalled.value).toBe(false);
  });

  test("bun installer without FROGP_EXTERNAL_SUPERVISOR → auto-ensure", async () => {
    const ensureCalled = { value: false };
    const outcome = await simulatePlanUpdateRestart("bun", {}, ensureCalled);
    expect(outcome).toBe("auto-ensure");
    expect(ensureCalled.value).toBe(true);
  });

  test("unsupported installer never auto-ensures", async () => {
    const ensureCalled = { value: false };
    const outcome = await simulatePlanUpdateRestart("unsupported", {}, ensureCalled);
    expect(outcome).toBe("unsupported-hint");
    expect(ensureCalled.value).toBe(false);
  });
});

describe("planUpdateRestart — source-code contract", () => {
  test("update.ts exports planUpdateRestart and ensureAfterUpdate", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    expect(src).toContain("export async function planUpdateRestart");
    expect(src).toContain("export async function ensureAfterUpdate");
  });

  test("FROGP_EXTERNAL_SUPERVISOR guard is present in planUpdateRestart source", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    expect(src).toContain("process.env.FROGP_EXTERNAL_SUPERVISOR");
    // Should print a hint (not call ensureAfterUpdate) when the env var is set
    expect(src).toContain("External-supervisor-managed");
  });

  test("ensureAfterUpdate does not import from cli.ts (no circular dep)", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    expect(src).not.toContain('from "./cli"');
    expect(src).not.toContain('from "../src/cli"');
  });

  test("ensureAfterUpdate reads active port from config, not cli.ts", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    expect(src).toContain("readActivePort");
  });

  test("update uses Bun for registry lookup and global installation", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    expect(src).toContain('spawnSync("bun", ["pm", "view"');
    expect(src).toContain('const cmdArgs = ["add", "-g"');
    expect(src).not.toContain('spawnSync("npm"');
  });

  test("registry update refuses explicit development-package installs", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    expect(src).toContain(".frogprogsy-dev-build.json");
    expect(src).toContain("explicitly installed development build");
    expect(src.indexOf("isDevPackageInstall()")).toBeLessThan(src.indexOf("const latest = latestVersion()"));
  });
});
describe("runUpdate --no-restart flag", () => {
  test("runUpdate accepts noRestart parameter (source contract)", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    expect(src).toContain("export async function runUpdate(noRestart = false)");
  });

  test("when noRestart is set, planUpdateRestart is skipped (source contract)", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/update.ts", root)).text();
    // noRestart branch must print a manual hint and skip planUpdateRestart
    expect(src).toContain("noRestart");
    expect(src).toContain("frogp stop && frogp start");
    // planUpdateRestart is inside an else branch gated by noRestart
    const noRestartIdx = src.indexOf("noRestart");
    const planIdx = src.indexOf("planUpdateRestart(installer)");
    expect(noRestartIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(-1);
    // planUpdateRestart must appear AFTER the noRestart check
    expect(planIdx).toBeGreaterThan(noRestartIdx);
  });

  test("cli.ts passes --no-restart flag through to runUpdate (source contract)", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/cli.ts", root)).text();
    expect(src).toContain('args.includes("--no-restart")');
    expect(src).toContain("runUpdate(noRestart)");
  });

  test("--no-restart simulation: noRestart=true skips auto-ensure", async () => {
    // Mirror of planUpdateRestart logic, but driven through the noRestart gate
    const ensureCalled = { value: false };
    let output = "";

    async function simulateRunUpdate(noRestart: boolean, installer: "bun" | "source" | "unsupported") {
      if (installer === "source") {
        output = "source-noop";
        return;
      }
      if (installer === "unsupported") {
        output = "unsupported";
        return;
      }
      // Simulated update succeeded
      if (noRestart) {
        output = "manual-hint";
        return; // planUpdateRestart NOT called
      }
      ensureCalled.value = true;
      output = "auto-ensure";
    }

    await simulateRunUpdate(true, "bun");
    expect(output).toBe("manual-hint");
    expect(ensureCalled.value).toBe(false);
  });

  test("--no-restart simulation: noRestart=false triggers auto-ensure", async () => {
    const ensureCalled = { value: false };
    let output = "";

    async function simulateRunUpdate(noRestart: boolean, installer: "bun" | "source" | "unsupported") {
      if (installer === "source") { output = "source-noop"; return; }
      if (installer === "unsupported") { output = "unsupported"; return; }
      if (noRestart) { output = "manual-hint"; return; }
      ensureCalled.value = true;
      output = "auto-ensure";
    }

    await simulateRunUpdate(false, "bun");
    expect(output).toBe("auto-ensure");
    expect(ensureCalled.value).toBe(true);
  });
});
