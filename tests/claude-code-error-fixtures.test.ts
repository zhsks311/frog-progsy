import { describe, expect, test } from "bun:test";
import { readNormalizedRecords, type NormalizedFixtureRecord } from "../tools/capture-claude-code-fixtures.ts";

const FIXTURE_DIR = "fixtures/claude-code-gateway";
const ERROR_SCENARIOS = [
  ["error-401", "401"],
  ["error-429", "429"],
  ["error-overloaded-529", "529"],
  ["malformed-sse", "malformed-sse"],
  ["mid-stream-error", "mid-stream-error"],
] as const;

function byScenario(records: NormalizedFixtureRecord[]): Map<string, NormalizedFixtureRecord> {
  return new Map(records.map((record) => [record.scenario, record]));
}

describe("Claude Code error fixture scenarios", () => {
  test("cover every required error and malformed-stream shape", async () => {
    const records = byScenario(await readNormalizedRecords(FIXTURE_DIR));

    for (const [id, responseKind] of ERROR_SCENARIOS) {
      const record = records.get(id);
      expect(record, `missing ${id}`).toBeDefined();
      expect(record?.method).toBe("POST");
      expect(record?.path).toBe("/v1/messages");
      expect(record?.responseKind).toBe(responseKind);
      expect(record?.evidence).toMatch(/401|429|529|malformed|mid-stream|blocked|capture/i);
    }
  });

  test("blocked error fixtures are classified rather than bypassed unsafely", async () => {
    const records = byScenario(await readNormalizedRecords(FIXTURE_DIR));

    for (const [id] of ERROR_SCENARIOS) {
      const record = records.get(id)!;
      if (record.status === "captured") {
        expect(record.requests.length).toBeGreaterThan(0);
        continue;
      }
      expect(record.status).toBe("blocked");
      expect(["version-blocked", "environment-blocked", "auth-blocked", "safety-blocked"]).toContain(record.blockedReason);
      expect(record.safety.fakeHomeUsed).toBe(true);
      expect(record.safety.realClaudeSettingsTouched).toBe(false);
      expect(record.bypassAssertions.bypassedWithRealHome).toBe(false);
      expect(record.bypassAssertions.loggedIntoClaudeAi).toBe(false);
      expect(record.bypassAssertions.switchedToBedrockOrVertex).toBe(false);
    }
  });
});
