/**
 * Dependency-free minimal ANSI color helper for human CLI output.
 *
 * Contract (locked by tests/cli-color.test.ts):
 * - JSON renderers must bypass this module entirely — JSON output never contains ANSI codes.
 * - `NO_COLOR` set to any non-empty value disables color (explicit opt-out, always wins).
 * - When stdout is not a TTY, color is disabled by default.
 * - `FORCE_COLOR=1` enables color even when stdout is not a TTY, unless `NO_COLOR` is set.
 * - Minimal palette only: success, warn, error, dim. No nested styling, no theme abstraction.
 */

export type CliPalette = "success" | "warn" | "error" | "dim";

const CODES: Record<CliPalette, string> = {
  success: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  dim: "\x1b[2m",
};

const RESET = "\x1b[0m";

/** Pure color-enable decision: NO_COLOR wins over FORCE_COLOR, FORCE_COLOR=1 overrides non-TTY. */
export function shouldColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if ((env.NO_COLOR ?? "") !== "") return false;
  if (env.FORCE_COLOR === "1") return true;
  return isTTY;
}

/** Wrap `text` in the palette color when enabled; return it unchanged when disabled. */
export function colorize(text: string, palette: CliPalette, enabled: boolean): string {
  if (!enabled) return text;
  return `${CODES[palette]}${text}${RESET}`;
}

export function success(text: string, enabled: boolean): string {
  return colorize(text, "success", enabled);
}

export function warn(text: string, enabled: boolean): string {
  return colorize(text, "warn", enabled);
}

export function error(text: string, enabled: boolean): string {
  return colorize(text, "error", enabled);
}

export function dim(text: string, enabled: boolean): string {
  return colorize(text, "dim", enabled);
}
