import { injectClaudeCodeSettings, type ClaudeSettingsInjectionOptions } from "./claude-settings";

/**
 * Inject ANTHROPIC_BASE_URL and related Claude Code settings (settings.json) with one automatic
 * retry. Home settings stay connector-friendly by default; callers opt in only for
 * settings-scoped discovery auth. Project-local enrollment is the safe ordinary-`claude`
 * path for gateway model discovery. On terminal failure the error is logged loudly but no exception
 * is re-thrown — proxy start continues.
 */
export async function injectClaudeSettingsWithRetry(port: number, options: ClaudeSettingsInjectionOptions = {}): Promise<void> {
  let firstError: string | null = null;

  // Attempt 1 -------------------------------------------------------------------
  try {
    const result = injectClaudeCodeSettings(port, options);
    if (result.success) {
      console.log(result.message);
      return;
    }
    firstError = result.message;
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  console.error(`⚠️  Settings inject attempt 1 failed (${firstError}) — retrying…`);

  // Attempt 2 (retry once) -------------------------------------------------------
  try {
    const result = injectClaudeCodeSettings(port, options);
    if (result.success) {
      console.log(result.message);
      return;
    }
    console.error(`❌ Settings inject failed after retry: ${result.message}`);
  } catch (err) {
    console.error(`❌ Settings inject failed after retry: ${err instanceof Error ? err.message : String(err)}`);
  }
  // continue-start: no throw
}
