import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { REQUIRED_SCENARIOS } from "../tools/capture-claude-code-fixtures.ts";

const LEDGER_PATH = "fixtures/claude-code-gateway/docs-vs-capture-ledger.md";

describe("Claude Code docs-vs-capture ledger", () => {
  test("has no unresolved release-blocking conflicts", async () => {
    const ledger = await readFile(LEDGER_PATH, "utf8");
    expect(ledger).toContain("Authority order: official Claude Code gateway docs");
    expect(ledger).toContain("Unresolved release-blocking conflicts: none.");
    expect(ledger).not.toMatch(/Unresolved release-blocking conflicts:\s*(?!none\.)\S/i);
  });

  test("records every required fixture scenario outcome", async () => {
    const ledger = await readFile(LEDGER_PATH, "utf8");
    for (const scenario of REQUIRED_SCENARIOS) {
      expect(ledger, `missing ledger row for ${scenario.id}`).toContain(`| ${scenario.id} | ${scenario.method} ${scenario.path} |`);
    }
  });

  test("reiterates non-target safety boundaries", async () => {
    const ledger = await readFile(LEDGER_PATH, "utf8");
    for (const forbidden of ["Claude.ai account login", "Bedrock", "Vertex", "hosted/cloud", "billing", "team/admin/org", "remote settings sync", "unapproved proxy/MITM"]) {
      expect(ledger).toContain(forbidden);
    }
  });
});
