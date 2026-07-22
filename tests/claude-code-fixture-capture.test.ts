import { describe, expect, test } from "bun:test";
import {
  BLOCKED_REASONS,
  REQUIRED_SCENARIOS,
  readNormalizedRecords,
  type NormalizedFixtureRecord,
} from "../tools/capture-claude-code-fixtures.ts";

const FIXTURE_DIR = "fixtures/claude-code-gateway";

function byScenario(records: NormalizedFixtureRecord[]): Map<string, NormalizedFixtureRecord> {
  return new Map(records.map((record) => [record.scenario, record]));
}

describe("Claude Code fixture capture schema", () => {
  test("normalized fixtures cover every required Phase -1 scenario", async () => {
    const records = await readNormalizedRecords(FIXTURE_DIR);
    const map = byScenario(records);

    expect(records).toHaveLength(REQUIRED_SCENARIOS.length);
    for (const scenario of REQUIRED_SCENARIOS) {
      const record = map.get(scenario.id);
      expect(record, `missing scenario ${scenario.id}`).toBeDefined();
      expect(record?.schemaVersion).toBe(1);
      expect(record?.method).toBe(scenario.method);
      expect(record?.path).toBe(scenario.path);
      expect(record?.responseKind).toBe(scenario.responseKind);
      expect(record?.evidence.length).toBeGreaterThan(20);
    }
  });

  test("each scenario is either captured with matching requests or explicitly blocked", async () => {
    const records = await readNormalizedRecords(FIXTURE_DIR);

    for (const record of records) {
      if (record.status === "captured") {
        expect(record.requests.length, `${record.scenario} should include captured requests`).toBeGreaterThan(0);
        expect(record.requests.some((request) => request.method === record.method && request.path === record.path)).toBe(true);
        expect(record.blockedReason).toBeUndefined();
      } else {
        expect(record.status).toBe("blocked");
        expect(record.blockedReason).toBeDefined();
        expect(BLOCKED_REASONS).toContain(record.blockedReason!);
        expect(record.requests).toEqual([]);
      }
    }
  });

  test("fixture set includes success, streaming, tool, token, and error-path coverage", async () => {
    const records = await readNormalizedRecords(FIXTURE_DIR);
    const scenarioIds = new Set(records.map((record) => record.scenario));

    expect(scenarioIds).toContain("model-discovery");
    expect(scenarioIds).toContain("basic-message");
    expect(scenarioIds).toContain("streaming-message");
    expect(scenarioIds).toContain("tool-use-turn");
    expect(scenarioIds).toContain("count-tokens");
    expect(scenarioIds).toContain("error-401");
    expect(scenarioIds).toContain("error-429");
    expect(scenarioIds).toContain("error-overloaded-529");
    expect(scenarioIds).toContain("malformed-sse");
    expect(scenarioIds).toContain("mid-stream-error");
  });
});
