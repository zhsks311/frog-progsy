import { afterEach, describe, expect, test } from "bun:test";
import { __requestLogTest } from "../src/server";
import type { FrogConfig } from "../src/types";

let previousNoClaudeWrites: string | undefined;

afterEach(() => {
  if (previousNoClaudeWrites === undefined) delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  else process.env.FROGPROGSY_NO_CLAUDE_WRITES = previousNoClaudeWrites;
});

function config(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "key" },
      added: { adapter: "openai-chat", baseUrl: "https://added.test/v1", apiKey: "key" },
    },
  };
}

function enableGuard() {
  previousNoClaudeWrites = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  process.env.FROGPROGSY_NO_CLAUDE_WRITES = "1";
}

describe("eval serve Claude Code write guard", () => {
  test("POST /api/stop is a no-op under FROGPROGSY_NO_CLAUDE_WRITES", async () => {
    enableGuard();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/stop", { method: "POST" }),
        new URL("http://localhost/api/stop"),
        config(),
        { saveConfig: () => {} },
      );
      expect(res?.status).toBe(200);
      const body = await res!.json() as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toContain("writes disabled");
      expect(errors.some((line) => line.includes("blocked Claude Code environment write") && line.includes("restore native"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("config-changing catalog refresh is skipped but config persistence remains unchanged under guard", async () => {
    enableGuard();
    const cfg = config();
    let saves = 0;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/default-provider", {
          method: "PUT",
          body: JSON.stringify({ name: "added" }),
          headers: { "content-type": "application/json" },
        }),
        new URL("http://localhost/api/default-provider"),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(res?.status).toBe(200);
      expect(cfg.defaultProvider).toBe("added");
      expect(saves).toBeGreaterThanOrEqual(1);
      expect(errors.some((line) => line.includes("blocked Claude Code environment write") && line.includes("catalog refresh"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("config-changing handler still persists when guard is unset", async () => {
    previousNoClaudeWrites = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
    delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
    const cfg = config();
    let saves = 0;
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/fallback-settings", {
        method: "PUT",
        body: JSON.stringify({ webSearch: { enabled: true } }),
        headers: { "content-type": "application/json" },
      }),
      new URL("http://localhost/api/fallback-settings"),
      cfg,
      { saveConfig: () => { saves++; } },
    );
    expect(res?.status).toBe(200);
    expect(saves).toBeGreaterThanOrEqual(1);
    expect(cfg.webSearchFallback?.enabled).toBe(true);
  });
});
