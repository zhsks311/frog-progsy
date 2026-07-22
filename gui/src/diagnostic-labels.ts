export const DASH = "—";

const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f<>{}[\]"]/;
const URL_OR_EMAIL = /(https?:\/\/|wss?:\/\/|file:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+)/i;
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s"'`(])[A-Z]:[\\/]/i;
const UNIX_ABSOLUTE_PATH = /(?:^|[\s"'`(])\/(?:Applications|bin|dev|etc|home|Library|opt|private|sbin|System|tmp|Users|usr|var|Volumes)(?:[\\/]|$)/i;
const RELATIVE_PATH_SEGMENT = /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/;
const SAFE_LABEL_CHARS = /^[\p{L}\p{N} ._:/+@()#-]+$/u;

export function primitiveDiagnosticText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

export function safeDiagnosticLabel(value: unknown, options: { allowSlash?: boolean; max?: number } = {}): string | undefined {
  const text = primitiveDiagnosticText(value)?.trim();
  const max = options.max ?? 96;
  if (!text || text.length > max) return undefined;
  if (CONTROL_OR_MARKUP.test(text)) return undefined;
  if (URL_OR_EMAIL.test(text)) return undefined;
  if (!options.allowSlash && /[\\/]/.test(text)) return undefined;
  if (options.allowSlash && (/^[\\/]/.test(text) || /[\\]/.test(text))) return undefined;
  if (WINDOWS_ABSOLUTE_PATH.test(text) || UNIX_ABSOLUTE_PATH.test(text) || RELATIVE_PATH_SEGMENT.test(text)) return undefined;
  if (!SAFE_LABEL_CHARS.test(text)) return undefined;
  return text;
}
