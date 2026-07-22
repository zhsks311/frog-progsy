import type { FrogProviderConfig } from "../types";
import { buildOpenAIResponsesFallbackFetch, resolveOpenAIResponsesFallbackProvider } from "../fallback-openai-responses";
import { signalWithTimeout } from "../abort";
import { parseFallbackSSE } from "../web-search-fallback/parse";

export interface VisionSettings {
  model: string;
  timeoutMs: number;
}

/** A description, or an `error` string when it couldn't run (caller injects a graceful marker). */
export type DescribeOutcome = { text: string; error?: string };

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
/** ~20 MB — generous enough for screenshots; rejects pathological payloads before forwarding. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Validate an image URL before forwarding. Data URLs are checked for an allowed media type and a sane
 * decoded size (a malformed/huge/unsupported one would otherwise 400 at the backend or waste tokens).
 * Remote https URLs are passed through — the ChatGPT backend fetches them, not this proxy (so there's
 * no SSRF surface here). Returns an error string when the URL must be rejected, else null.
 */
function validateImageUrl(url: string): string | null {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+?)(;base64)?,(.*)$/s.exec(url);
    if (!m) return "malformed data URL";
    const mime = m[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return `unsupported image type "${mime}"`;
    if (m[2]) {
      const bytes = Math.floor((m[3].length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) return `image too large (~${Math.round(bytes / 1024 / 1024)}MB)`;
    }
    return null;
  }
  if (url.startsWith("https://")) return null;
  return "unsupported image URL scheme (expected data: or https:)";
}

/**
 * Describe ONE image via an OpenAI Responses fallback helper with native image input. The user's
 * own request text is passed as context so the description is focused. Never throws — returns
 * `{error}` on failure.
 */
export async function describeImage(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  forwardProvider: FrogProviderConfig,
  forwardProviderName: string | undefined,
  incomingHeaders: Headers,
  settings: VisionSettings,
  abortSignal?: AbortSignal,
): Promise<DescribeOutcome> {
  const invalid = validateImageUrl(imageUrl);
  if (invalid) return { text: "", error: invalid };

  const content: unknown[] = [];
  if (contextText) content.push({ type: "input_text", text: `The user's request about this image: ${contextText}` });
  content.push({ type: "input_image", image_url: imageUrl, detail: detail ?? "high" });

  const body = {
    model: settings.model,
    instructions:
      "You are a vision describer for a text-only model that cannot see the image. Describe the image " +
      "thoroughly and factually so that model can fully reason about it: transcribe any visible text " +
      "verbatim, and note UI/layout, colors, branding/logos, charts, and notable details. Focus on " +
      "what's relevant to the user's request. Output only the description.",
    input: [{ type: "message", role: "user", content }],
    reasoning: { effort: "low" },
    // The ChatGPT (claude) backend rejects `max_output_tokens` ("Unsupported parameter"); the
    // description is clamped downstream (DESC_MAX_CHARS) instead.
    store: false,
    stream: true,
  };
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  try {
    const resolvedProvider = await resolveOpenAIResponsesFallbackProvider(forwardProviderName, forwardProvider);
    const { url, headers } = buildOpenAIResponsesFallbackFetch(resolvedProvider, incomingHeaders);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linkedSignal.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { text: "", error: `vision fallback HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const parsed = await parseFallbackSSE(res);
    // The backend can return HTTP 200 then stream a `response.failed`/`error` event with no text;
    // surface that as a describe error instead of an empty (silently-blank) description.
    if (!parsed.text.trim() && parsed.error) return { text: "", error: parsed.error };
    return { text: parsed.text };
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    linkedSignal.cleanup();
  }
}
