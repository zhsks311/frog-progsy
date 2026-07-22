import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { REQUIRED_SCENARIOS, type CaptureMetadata } from "../tools/capture-claude-code-fixtures.ts";

async function metadata(): Promise<CaptureMetadata> {
  return JSON.parse(await readFile("fixtures/claude-code-gateway/capture-metadata.json", "utf8")) as CaptureMetadata;
}

describe("Claude Code fixture drift metadata", () => {
  test("metadata records provenance required to detect Claude Code request drift", async () => {
    const data = await metadata();

    expect(data.schemaVersion).toBe(1);
    expect(data.harnessVersion).toMatch(/^frogprogsy-phase1-capture-/);
    expect(Date.parse(data.captureDate)).not.toBeNaN();
    expect(data.claudeVersion.command).toBe("claude --version");
    expect(["available", "unavailable"]).toContain(data.claudeVersion.status);
    if (data.captureMode === "safe-blocked") {
      expect(data.claudeVersion.status).toBe("unavailable");
      expect(data.claudeVersion.stdout).toBeNull();
      expect(data.claudeVersion.stderr).toContain("Not run in safe-blocked mode");
      expect(data.claudeVersion.exitCode).toBeNull();
    }
    expect(data.os.platform.length).toBeGreaterThan(0);
    expect(data.os.arch.length).toBeGreaterThan(0);
    expect(data.os.release.length).toBeGreaterThan(0);
    expect(data.bunVersion.length).toBeGreaterThan(0);
    expect(data.nodeVersion.length).toBeGreaterThan(0);
    expect(data.envKeysUsed).toEqual(expect.arrayContaining([
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    ]));
    expect(Object.prototype.hasOwnProperty.call(data, "claudeCodeDisableExperimentalBetas")).toBe(true);
    expect(data.officialDocs.some((url) => url.includes("docs.anthropic.com"))).toBe(true);
  });

  test("metadata contains a minimum-version note for every required scenario", async () => {
    const data = await metadata();
    for (const scenario of REQUIRED_SCENARIOS) {
      expect(data.minimumRequiredClaudeCodeVersionByScenario[scenario.id]).toBe(scenario.minimumClaudeCodeVersion);
      expect(data.scenarioStatus[scenario.id]).toMatch(/^(captured|blocked)$/);
    }
  });
});
