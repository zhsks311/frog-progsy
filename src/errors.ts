export interface FrogErrorPayload {
  message: string;
  type: string;
  code: string | null;
}
export interface UpstreamErrorDetails {
  message: string;
  type: string;
  code?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanMessage(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseUpstreamErrorDetails(
  status: number,
  fallbackType: string,
  fallbackMessage: string,
  bodyText: string,
): UpstreamErrorDetails {
  const fallback = { type: fallbackType, message: fallbackMessage };
  const text = bodyText.trim();
  if (!text) return fallback;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      const message = stringField(error.message) ?? stringField(parsed.message);
      const type = stringField(error.type) ?? stringField(parsed.type) ?? fallbackType;
      const code = stringField(error.code) ?? stringField(parsed.code) ?? null;
      if (message) return { type, message: cleanMessage(message), code };
    }
  } catch {
    // Non-JSON provider errors are common; use the provider text below.
  }

  const message = cleanMessage(text);
  return message ? { type: fallbackType, message } : fallback;
}


export function classifyError(status: number, type: string, message: string): FrogErrorPayload {
  const text = message.toLowerCase();
  const rateLimitLike =
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("requests per") ||
    text.includes("tokens per") ||
    text.includes("rate_limit_error") ||
    type === "rate_limit_error";
  if (
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  ) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota")
  ) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  if (rateLimitLike) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (status === 429) {
    return { message, type: "api_error", code: "provider_429" };
  }
  if (status === 401 || status === 403 || type === "authentication_error") {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  if (
    status === 503 ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable")
  ) {
    // Claude Code recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); generic "upstream_server_error" is not recognized.
    return { message, type: "server_error", code: "server_is_overloaded" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}
