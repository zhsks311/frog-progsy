import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("full uninstall command", () => {
  test("CLI exposes a one-shot local state cleanup command", async () => {
    const cli = await readText("src/cli.ts");

    expect(cli).toContain("frogp uninstall");
    expect(cli).toContain("async function handleUninstall()");
    expect(cli).not.toContain("uninstallServiceIfInstalled");
    expect(cli).not.toContain("uninstallClaudeCodeShim");
    expect(cli).toContain("restoreNativeClaudeCode");
    expect(cli).toContain("rmSync(getConfigDir()");
  });

  test("uninstall preserves config backups when restore steps fail", async () => {
    const cli = await readText("src/cli.ts");

    expect(cli).toContain("Skipping frogprogsy config removal so restore backups remain available.");
    expect(cli.indexOf("Skipping frogprogsy config removal")).toBeLessThan(cli.indexOf("frogprogsy config removed"));
  });

  test("stop propagates Claude home and project routing restore failures", async () => {
    const cli = await readText("src/cli.ts");
    const server = await readText("src/server.ts");

    expect(cli).toContain("Claude Code routing restore failed");
    // /api/stop must delegate to the canonical lifecycle so managed homes AND every enrolled project
    // are restored — not the old per-profile-only restore loop.
    expect(server).toContain('const { restoreManagedClaudeRouting } = await import("./claude-routing-lifecycle")');
    expect(server).toContain("const restore = restoreManagedClaudeRouting(config)");
    expect(server).toContain('return jsonResponse({ success: false, error: restore.message }, 500)');
    expect(server).not.toContain('error: messages.join("\\n") }, 500');
    expect(server).toContain("removePid()");
  });

  test("recover-history command is fully removed (no handler, no case, no usage line)", async () => {
    const cli = await readText("src/cli.ts");

    expect(cli).not.toContain("handleRecoverHistory");
    expect(cli).not.toContain("recover-history");
    expect(cli).not.toContain("frogp recover-history");
  });

  test("uninstall runs global package removal as the last step", async () => {
    const cli = await readText("src/cli.ts");

    // package removal comes after config removal
    const configIdx = cli.indexOf("frogprogsy config removed");
    const pkgIdx = cli.indexOf("detectInstall");
    expect(configIdx).toBeGreaterThan(-1);
    expect(pkgIdx).toBeGreaterThan(-1);
    expect(pkgIdx).toBeGreaterThan(configIdx);
  });

  test("uninstall handles bun global removal", async () => {
    const cli = await readText("src/cli.ts");

    expect(cli).toContain('"remove", "-g", "frogprogsy"');
  });

  test("uninstall rejects non-Bun package-manager removal", async () => {
    const cli = await readText("src/cli.ts");

    expect(cli).toContain("this installation is not managed by Bun");
    expect(cli).not.toContain('"uninstall", "-g", "frogprogsy"');
  });

  test("uninstall skips package manager removal for source checkouts", async () => {
    const cli = await readText("src/cli.ts");

    expect(cli).toContain("Source checkout");
  });

  test("uninstall wraps package removal in try/catch for best-effort behaviour", async () => {
    const cli = await readText("src/cli.ts");

    // package removal is a best-effort try/catch scoped to handleUninstall, logging a skip on failure
    const start = cli.indexOf("async function handleUninstall()");
    const end = cli.indexOf("frogprogsy uninstalled.", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = cli.slice(start, end);
    expect(body).toContain("detectInstall");
    expect(body).toContain("} catch (err) {");
    expect(body).toContain("Package removal skipped");
  });

  test("uninstall final message no longer instructs manual package removal", async () => {
    const cli = await readText("src/cli.ts");

    expect(cli).not.toContain("Remove the package with:");
    expect(cli).toContain("frogprogsy uninstalled.");
  });
});
