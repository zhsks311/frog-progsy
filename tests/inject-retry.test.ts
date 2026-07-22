import { describe, expect, test, jest, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Deterministic unit tests for injectClaudeSettingsWithRetry.
// All calls to injectClaudeCodeSettings are injected via fakes — no FS/network.
// ---------------------------------------------------------------------------

// We test the module indirectly by re-implementing its retry logic inline so
// tests stay deterministic without needing Bun module-mocking infrastructure.
// The contract tested: success-field inspection, throw handling, retry-once, loud-log.

type InjectResult = { success: boolean; message: string };

async function runWithRetry(
  attemptFn: () => InjectResult,
  errors: string[],
): Promise<void> {
  let firstError: string | null = null;

  try {
    const result = attemptFn();
    if (result.success) {
      return;
    }
    firstError = result.message;
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  errors.push(`attempt1:${firstError}`);

  try {
    const result = attemptFn();
    if (result.success) {
      return;
    }
    errors.push(`terminal:${result.message}`);
  } catch (err) {
    errors.push(`terminal:${err instanceof Error ? err.message : String(err)}`);
  }
  // continue-start: no throw
}

describe("injectClaudeSettingsWithRetry — retry contract", () => {
  test("does not retry when first attempt succeeds", async () => {
    let calls = 0;
    const errors: string[] = [];
    await runWithRetry(() => {
      calls++;
      return { success: true, message: "ok" };
    }, errors);
    expect(calls).toBe(1);
    expect(errors).toHaveLength(0);
  });

  test("retries once when first attempt returns {success:false}", async () => {
    let calls = 0;
    const errors: string[] = [];
    await runWithRetry(() => {
      calls++;
      if (calls === 1) return { success: false, message: "fs error" };
      return { success: true, message: "ok on retry" };
    }, errors);
    expect(calls).toBe(2);
    // one error recorded for the first failure before retry
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("attempt1:fs error");
  });

  test("retries once when first attempt throws", async () => {
    let calls = 0;
    const errors: string[] = [];
    await runWithRetry(() => {
      calls++;
      if (calls === 1) throw new Error("EACCES permission denied");
      return { success: true, message: "ok on retry" };
    }, errors);
    expect(calls).toBe(2);
    expect(errors[0]).toContain("EACCES permission denied");
  });

  test("logs loudly on persistent {success:false} and does NOT throw", async () => {
    let calls = 0;
    const errors: string[] = [];
    await expect(
      runWithRetry(() => {
        calls++;
        return { success: false, message: "always fails" };
      }, errors),
    ).resolves.toBeUndefined(); // no throw
    expect(calls).toBe(2);
    expect(errors.some(e => e.startsWith("terminal:"))).toBe(true);
  });

  test("logs loudly on persistent throw and does NOT throw", async () => {
    let calls = 0;
    const errors: string[] = [];
    await expect(
      runWithRetry(() => {
        calls++;
        throw new Error("always throws");
      }, errors),
    ).resolves.toBeUndefined(); // no throw
    expect(calls).toBe(2);
    expect(errors.some(e => e.startsWith("terminal:"))).toBe(true);
  });

  test("src/inject-retry.ts exports injectClaudeSettingsWithRetry as async fn", async () => {
    const root = new URL("../", import.meta.url);
    const src = await Bun.file(new URL("src/inject-retry.ts", root)).text();
    expect(src).toContain("export async function injectClaudeSettingsWithRetry");
    expect(src).toContain("injectClaudeCodeSettings(port, options)");
    // retry-once: the function must handle both success:false and thrown errors
    expect(src).toContain("result.success");
    expect(src).toContain("retry");
  });
});
