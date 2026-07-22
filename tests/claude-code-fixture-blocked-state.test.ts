import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { BLOCKED_REASONS, readNormalizedRecords } from "../tools/capture-claude-code-fixtures.ts";

describe("Claude Code fixture blocked-state guard", () => {
  test("every blocked scenario uses an approved blocked-state reason", async () => {
    const records = await readNormalizedRecords("fixtures/claude-code-gateway");
    const blocked = records.filter((record) => record.status === "blocked");

    expect(blocked.length).toBeGreaterThan(0);
    for (const record of blocked) {
      expect(record.blockedReason).toBeDefined();
      expect(BLOCKED_REASONS).toContain(record.blockedReason!);
      expect(record.evidence.length).toBeGreaterThan(20);
    }
  });

  test("blocked scenarios were not bypassed with unsafe fallbacks", async () => {
    const records = await readNormalizedRecords("fixtures/claude-code-gateway");

    for (const record of records) {
      expect(record.bypassAssertions.bypassedWithRealHome).toBe(false);
      expect(record.bypassAssertions.mutatedRealClaudeSettings).toBe(false);
      expect(record.bypassAssertions.loggedIntoClaudeAi).toBe(false);
      expect(record.bypassAssertions.switchedToBedrockOrVertex).toBe(false);
      expect(record.bypassAssertions.usedHostedCloudProxy).toBe(false);
      expect(record.bypassAssertions.weakenedProxyMitmOrNetworkIsolation).toBe(false);
    }
  });

  test("docs-vs-capture ledger has no unresolved release-blocking conflict", async () => {
    const ledger = await readFile("fixtures/claude-code-gateway/docs-vs-capture-ledger.md", "utf8");

    expect(ledger).toContain("Unresolved release-blocking conflicts: none.");
    expect(ledger).toContain("GitHub proxy/router projects are comparison aids only");
  });
});
