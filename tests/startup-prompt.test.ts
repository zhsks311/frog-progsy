import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("startup star prompt", () => {
  test("does not ship a package-manager postinstall lifecycle prompt", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.mjs");
  });

  test("frogp start waits for the interactive prompt before sync/injection", async () => {
    const cli = await readText("src/cli.ts");
    const promptIndex = cli.indexOf("await maybeShowStarPrompt()");
    const injectIndex = cli.indexOf("await injectClaudeSettingsWithRetry(port,");

    expect(cli).not.toContain("void maybeShowStarPrompt()");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(injectIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(injectIndex);
  });

  test("frogp init does not offer a Claude Code autostart wrapper", async () => {
    const init = await readText("src/init.ts");

    expect(init).not.toContain("Install Claude Code autostart shim? [Y/n]");
    expect(init).not.toContain("installClaudeCodeShim");
  });
});
