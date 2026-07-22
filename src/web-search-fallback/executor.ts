import type { FrogProviderConfig } from "../types";
import { buildOpenAIResponsesFallbackFetch, resolveOpenAIResponsesFallbackProvider } from "../fallback-openai-responses";
import { signalWithTimeout } from "../abort";
import { parseFallbackSSE, type WebSearchResult } from "./parse";

export interface WebSearchFallbackSettings {
  model: string;
  reasoning: string;
  timeoutMs: number;
  /**
   * True when the routed (downstream) model is text-only. The search model CAN see images, so it's
   * told to verbalize any relevant image results and include their URLs — otherwise a non-vision model
   * would receive bare image links it cannot interpret (the image-web-search gap).
   */
  describeImages?: boolean;
}

const BASE_INSTRUCTION =
  "You are a web-search assistant. Use the web_search tool to find current information for the " +
  "user's query, then reply with a concise, factual answer and cite the sources you used.";
const IMAGE_INSTRUCTION =
  " The model that will read your answer is TEXT-ONLY and cannot see images: if the results include " +
  "relevant images, describe what they show in words and include their source URLs in your answer.";

/** A search result, or an `error` string when the search couldn't run (surfaced as a tool result). */
export type WebSearchFallbackOutcome = WebSearchResult & { error?: string };

/**
 * Execute ONE web search via an OpenAI Responses fallback helper — forward-auth, OAuth, or
 * API-key backed. Never throws — returns `{error}` so the caller injects a graceful tool result.
 */
export async function runWebSearch(
  query: string,
  hostedTool: Record<string, unknown>,
  forwardProvider: FrogProviderConfig,
  forwardProviderName: string | undefined,
  incomingHeaders: Headers,
  settings: WebSearchFallbackSettings,
  abortSignal?: AbortSignal,
): Promise<WebSearchFallbackOutcome> {
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const body = {
    model: settings.model,
    instructions: settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [hostedTool],
    tool_choice: "auto",
    reasoning: { effort: settings.reasoning },
    // NOTE: the ChatGPT (claude) backend rejects `max_output_tokens` ("Unsupported parameter") and
    // requires `store: false` — keep this body minimal. Answer length is capped downstream
    // (format-result clamps the injected tool_result), so no upstream cap is needed.
    store: false,
    stream: true,
  };
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
      return { text: "", sources: [], error: `fallback HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    return await parseFallbackSSE(res);
  } catch (e) {
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    linkedSignal.cleanup();
  }
}
