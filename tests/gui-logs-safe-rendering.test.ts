import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const unsafeFixtures = [
  "prompt",
  "toolArgs",
  "toolResult",
  "headers",
  "rawFrames",
  "providerBody",
  "bodySnippet",
  "/Users/alice/private.txt",
  "https://example.com/private",
  "alice@example.com",
];

describe("GUI logs safe rendering guard", () => {
  test("Logs page renders structured metadata instead of arbitrary error/content fields", async () => {
    const source = await readFile("gui/src/pages/Logs.tsx", "utf8");

    expect(source).toContain("formatStructuredError");
    expect(source).toContain("formatPhaseSummary");
    expect(source).toContain("log.startedAt ?? log.timestamp");
    expect(source).not.toContain('t("logs.col.error")');
    expect(source).not.toContain("title={log.error");
    expect(source).not.toContain("log.error.length");
    expect(source).not.toContain("log.error.slice");

    for (const unsafeField of unsafeFixtures) {
      expect(source).not.toContain(`log.${unsafeField}`);
    }
  });

  test("localized safe log columns exist in every locale", async () => {
    const localeFiles = ["gui/src/i18n/en.ts", "gui/src/i18n/ko.ts", "gui/src/i18n/zh.ts"];

    for (const file of localeFiles) {
      const source = await readFile(file, "utf8");
      expect(source).toContain('"logs.col.errorCodes"');
      expect(source).toContain('"logs.col.phases"');
    }
  });
});
