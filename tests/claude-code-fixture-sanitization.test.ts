import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { rawFixturePatternIsIgnored } from "../tools/capture-claude-code-fixtures.ts";

const FIXTURE_DIR = "fixtures/claude-code-gateway";
const TRACKED_FIXTURE_FILES = [
  "scenarios.normalized.jsonl",
  "capture-metadata.json",
  "docs-vs-capture-ledger.md",
];

async function readTrackedFixtureBundle(): Promise<string> {
  const parts = await Promise.all(TRACKED_FIXTURE_FILES.map((file) => readFile(join(FIXTURE_DIR, file), "utf8")));
  return parts.join("\n");
}

describe("Claude Code fixture sanitization", () => {
  test("tracked normalized artifacts do not leak local paths or fixture secrets", async () => {
    const text = await readTrackedFixtureBundle();
    const forbiddenFragments = [
      homedir(),
      process.cwd(),
      resolve("."),
      "fixture-token-redacted",
      "fixture-api-key-redacted",
      "x-frogprogsy-fixture: redacted",
    ].filter((fragment) => fragment.length > 1);

    for (const fragment of forbiddenFragments) {
      expect(text.includes(fragment), `leaked forbidden fragment: ${fragment}`).toBe(false);
    }

    expect(text).not.toMatch(/Bearer\s+(?!\[REDACTED_AUTH\])[A-Za-z0-9._-]+/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/session[_-]?[A-Za-z0-9_-]{6,}/i);
    expect(text).not.toMatch(/agent[_-]?[A-Za-z0-9_-]{6,}/i);
  });

  test("raw debug captures are excluded by gitignore", async () => {
    const gitignore = await readFile(".gitignore", "utf8");
    expect(rawFixturePatternIsIgnored(gitignore)).toBe(true);
  });

  test("local investigation and verification directories are excluded by gitignore", async () => {
    const entries = (await readFile(".gitignore", "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(entries).toContain("/docs/");
    expect(entries).toContain("/artifacts/");
  });
});
