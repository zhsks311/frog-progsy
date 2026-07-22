import type { IncomingMeta, ProviderAdapter } from "./base";
import type { AdapterEvent, FrogParsedRequest, FrogProviderConfig, FrogUsage } from "../types";
import { debugDroppedFrame } from "../debug";
import { codexBackendHeaders, isCodexBackendBaseUrl } from "../oauth/codex";

// Headers relayed verbatim from the caller in forward-auth mode.
// Exported so fallbacks reuse the exact same forwarded-auth set for ChatGPT/OpenAI Responses calls.
export const FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-claude-beta-features",
  "x-claude-installation-id",
  "x-claude-parent-thread-id",
  "x-claude-turn-metadata",
  "x-claude-turn-state",
  "x-claude-window-id",
  "x-oai-attestation",
  "x-responsesapi-include-timing-metrics",
];

function sanitizeReasoningInputContent(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.input)) return body;

  let changed = false;
  const input = raw.input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const rec = item as Record<string, unknown>;
    if (rec.type !== "reasoning" || !Array.isArray(rec.content) || rec.content.length === 0) return item;
    changed = true;
    // Routed models can produce raw `reasoning_text` output items. Claude Code echoes those in later
    // native GPT requests, but ChatGPT's Responses backend accepts reasoning input only with empty
    // `content`; keep summaries/ids and drop the raw content so the Responses upstream does not 400.
    return { ...rec, content: [] };
  });

  return changed ? { ...raw, input } : body;
}

function coerceImageUrlPart(part: unknown): unknown {
  if (!part || typeof part !== "object" || Array.isArray(part)) return part;
  const p = part as Record<string, unknown>;
  if (p.type !== "input_image") return part;
  const url = p.image_url;
  if (!url || typeof url !== "object" || Array.isArray(url)) return part;
  const obj = url as Record<string, unknown>;
  if (typeof obj.url !== "string") return part;
  const next: Record<string, unknown> = { ...p, image_url: obj.url };
  if (next.detail === undefined && typeof obj.detail === "string") next.detail = obj.detail;
  return next;
}

// The Responses API requires `input_image.image_url` to be a plain string (URL or data URI).
// Some clients reuse the Chat-Completions object shape ({ url, detail }); ChatGPT's Codex/Responses
// backend then 400s with: [ImageUrlParam] [input[N].content[M].image_url] expected an image URL,
// but got an object instead. The adapter serializes `parsed._rawBody` for Responses upstream calls
// (raw Responses inbound when present, or a generated Responses body from the Claude Messages parser),
// so coerce any object-shaped image_url back to its string url across message `content` and tool
// `output` arrays before sending.
function normalizeInputImageUrls(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.input)) return body;

  let changed = false;
  const input = raw.input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const rec = item as Record<string, unknown>;
    let itemChanged = false;
    const next: Record<string, unknown> = { ...rec };
    for (const key of ["content", "output"] as const) {
      const arr = rec[key];
      if (!Array.isArray(arr)) continue;
      let arrChanged = false;
      const mapped = arr.map(part => {
        const coerced = coerceImageUrlPart(part);
        if (coerced !== part) arrChanged = true;
        return coerced;
      });
      if (arrChanged) {
        next[key] = mapped;
        itemChanged = true;
      }
    }
    if (!itemChanged) return item;
    changed = true;
    return next;
  });

  return changed ? { ...raw, input } : body;
}

function sanitizeCodexBackendBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof raw.model === "string") out.model = raw.model;
  if (raw.input !== undefined) out.input = raw.input;
  if (typeof raw.instructions === "string" && raw.instructions.length > 0) {
    out.instructions = raw.instructions;
  }
  // ChatGPT's Codex backend rejects non-streaming Responses calls ("Stream must be set to true").
  // The adapter still returns non-stream Claude Messages JSON by collecting the upstream SSE in parseResponse().
  out.stream = true;

  const tools = normalizeCodexTools(raw.tools);
  if (tools.length > 0) {
    out.tools = tools;
    const toolChoice = normalizeCodexToolChoice(raw.tool_choice, new Set(tools.map(tool => tool.name)));
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
  }

  // Keep Codex requests stateless. A caller-provided `store: true` can make the
  // backend expect server-side response state we do not use or replay.
  out.store = false;

  if (raw.reasoning && typeof raw.reasoning === "object" && !Array.isArray(raw.reasoning)) {
    const reasoning = { ...(raw.reasoning as Record<string, unknown>) };
    const effort = typeof reasoning.effort === "string" ? reasoning.effort : "medium";
    reasoning.effort = effort === "minimal" ? "low" : effort === "xhigh" || effort === "max" ? "high" : effort;
    reasoning.summary = reasoning.summary || "auto";
    out.reasoning = reasoning;
  }

  return out;
}

function normalizeCodexTools(value: unknown): Array<{ type: "function"; name: string; description?: string; parameters?: unknown; strict?: boolean }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ type: "function"; name: string; description?: string; parameters?: unknown; strict?: boolean }> = [];
  for (const rawTool of value) {
    if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) continue;
    const tool = rawTool as Record<string, unknown>;
    if (tool.type !== "function" || typeof tool.name !== "string" || tool.name.trim().length === 0) continue;
    const normalized: { type: "function"; name: string; description?: string; parameters?: unknown; strict?: boolean } = {
      type: "function",
      name: tool.name.trim(),
    };
    if (typeof tool.description === "string") normalized.description = tool.description;
    if (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)) normalized.parameters = tool.parameters;
    if (typeof tool.strict === "boolean") normalized.strict = tool.strict;
    out.push(normalized);
  }
  return out;
}

function normalizeCodexToolChoice(value: unknown, toolNames: Set<string>): unknown {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const choice = value as Record<string, unknown>;
  if (choice.type === "function" && typeof choice.name === "string" && toolNames.has(choice.name)) {
    return { type: "function", name: choice.name };
  }
  return undefined;
}

function usageFromResponses(usage: Record<string, unknown> | undefined): FrogUsage | undefined {
  if (!usage) return undefined;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    ...(typeof inputDetails?.cached_tokens === "number" ? { cachedInputTokens: inputDetails.cached_tokens } : {}),
    ...(typeof outputDetails?.reasoning_tokens === "number" ? { reasoningOutputTokens: outputDetails.reasoning_tokens } : {}),
  };
}

function emitResponseItemEvents(item: Record<string, unknown>): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  if (item.type === "message" && Array.isArray(item.content)) {
    for (const block of item.content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
        out.push({ type: "text_delta", text: b.text });
      }
    }
  } else if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    for (const block of summary) {
      if (block && typeof block === "object" && !Array.isArray(block) && typeof (block as { text?: unknown }).text === "string") {
        out.push({ type: "thinking_delta", thinking: (block as { text: string }).text });
      }
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (block && typeof block === "object" && !Array.isArray(block) && typeof (block as { text?: unknown }).text === "string") {
        out.push({ type: "reasoning_raw_delta", text: (block as { text: string }).text });
      }
    }
  } else if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "tool_search_call") {
    const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${crypto.randomUUID().slice(0, 8)}`;
    const name = typeof item.name === "string" ? item.name : item.type === "tool_search_call" ? "tool_search" : "";
    out.push({ type: "tool_call_start", id, name });
    if (item.type === "custom_tool_call" && typeof item.input === "string") {
      out.push({ type: "tool_call_delta", arguments: JSON.stringify({ input: item.input }) });
    } else if (item.type === "tool_search_call" && item.arguments && typeof item.arguments === "object") {
      out.push({ type: "tool_call_delta", arguments: JSON.stringify(item.arguments) });
    } else if (typeof item.arguments === "string") {
      out.push({ type: "tool_call_delta", arguments: item.arguments });
    }
    out.push({ type: "tool_call_end" });
  }
  return out;
}

function eventsFromCompletedResponse(json: Record<string, unknown>): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const output = Array.isArray(json.output) ? json.output : [];
  for (const raw of output) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      events.push(...emitResponseItemEvents(raw as Record<string, unknown>));
    }
  }
  if (json.error && typeof json.error === "object" && !Array.isArray(json.error)) {
    const err = json.error as Record<string, unknown>;
    events.push({ type: "error", message: typeof err.message === "string" ? err.message : "upstream error" });
  }
  events.push({ type: "done", usage: usageFromResponses(json.usage as Record<string, unknown> | undefined) });
  return events;
}

async function collectStreamEvents(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function hasTerminalEvent(events: AdapterEvent[]): boolean {
  return events.some(event => event.type === "done" || event.type === "error");
}

/**
 * Builds OpenAI Responses upstream requests. `nativeRelay: true` here only means the legacy same-wire
 * /v1/responses handler can relay this adapter's upstream response as native wire. Claude Code's normal
 * /v1/messages route is still parsed as Anthropic Messages, converted into `parsed._rawBody`, and then
 * sent as an OpenAI Responses request.
 */
export function createResponsesAdapter(provider: FrogProviderConfig): ProviderAdapter & { nativeRelay: true } {
  return {
    name: "openai-responses",
    nativeRelay: true as const,

    buildRequest(parsed: FrogParsedRequest, incoming?: IncomingMeta) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const isCodexBackend = isCodexBackendBaseUrl(provider.baseUrl);
      let url: string;

      if (provider.authMode === "forward") {
        // Forward auth: ChatGPT/Codex backend path is `${baseUrl}/responses` (no /v1).
        url = `${provider.baseUrl.replace(/\/$/, "")}/responses`;
        if (provider.headers) Object.assign(headers, provider.headers); // static headers first…
        for (const h of FORWARD_HEADERS) {
          const v = incoming?.headers.get(h);
          if (v) headers[h] = v;                                        // …so forwarded auth always wins.
        }
      } else if (isCodexBackend) {
        url = `${provider.baseUrl.replace(/\/$/, "")}/responses`;
        if (provider.headers) Object.assign(headers, provider.headers);
        if (provider.apiKey) {
          headers["Authorization"] = `Bearer ${provider.apiKey}`;
          Object.assign(headers, codexBackendHeaders(provider.apiKey));
        }
      } else {
        const base = provider.baseUrl.replace(/\/v1\/?$/, "");
        url = `${base}/v1/responses`;
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }

      let body = sanitizeReasoningInputContent(parsed._rawBody);
      body = normalizeInputImageUrls(body);
      if (isCodexBackend) body = sanitizeCodexBackendBody(body);

      return {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(body),
      };
    },

    async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEventType = "";
      const toolArgumentDeltaSeen = new Set<string>();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEventType = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === "[DONE]") continue;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              debugDroppedFrame("openai-responses", payload);
              currentEventType = "";
              continue;
            }
            const eventType = currentEventType || (typeof data.type === "string" ? data.type : "");
            currentEventType = "";
            switch (eventType) {
              case "response.output_text.delta":
                if (typeof data.delta === "string") yield { type: "text_delta", text: data.delta };
                break;
              case "response.reasoning_summary_text.delta":
                if (typeof data.delta === "string") yield { type: "thinking_delta", thinking: data.delta };
                break;
              case "response.reasoning_text.delta":
                if (typeof data.delta === "string") yield { type: "reasoning_raw_delta", text: data.delta };
                break;
              case "response.output_item.added": {
                const item = data.item as Record<string, unknown> | undefined;
                if (item?.type === "function_call" || item?.type === "custom_tool_call" || item?.type === "tool_search_call") {
                  const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${crypto.randomUUID().slice(0, 8)}`;
                  const name = typeof item.name === "string" ? item.name : item.type === "tool_search_call" ? "tool_search" : "";
                  yield { type: "tool_call_start", id, name };
                }
                break;
              }
              case "response.function_call_arguments.delta": {
                const key = typeof data.item_id === "string" ? data.item_id : String(data.output_index ?? "current");
                if (typeof data.delta === "string") {
                  toolArgumentDeltaSeen.add(key);
                  yield { type: "tool_call_delta", arguments: data.delta };
                }
                break;
              }
              case "response.output_item.done": {
                const item = data.item as Record<string, unknown> | undefined;
                if (item?.type === "function_call" || item?.type === "custom_tool_call" || item?.type === "tool_search_call") {
                  const key = typeof item.id === "string" ? item.id : String(data.output_index ?? "current");
                  if (!toolArgumentDeltaSeen.has(key)) {
                    if (typeof item.arguments === "string") yield { type: "tool_call_delta", arguments: item.arguments };
                    else if (typeof item.input === "string") yield { type: "tool_call_delta", arguments: JSON.stringify({ input: item.input }) };
                  }
                  yield { type: "tool_call_end" };
                }
                break;
              }
              case "response.completed": {
                const responseObj = data.response as Record<string, unknown> | undefined;
                yield { type: "done", usage: usageFromResponses(responseObj?.usage as Record<string, unknown> | undefined) };
                break;
              }
              case "response.failed":
              case "response.incomplete": {
                const responseObj = data.response as Record<string, unknown> | undefined;
                const err = responseObj?.error as Record<string, unknown> | undefined;
                yield { type: "error", message: typeof err?.message === "string" ? err.message : eventType };
                return;
              }
              case "error": {
                const err = data.error as Record<string, unknown> | undefined;
                yield { type: "error", message: typeof err?.message === "string" ? err.message : "upstream error" };
                return;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      if (isCodexBackendBaseUrl(provider.baseUrl) || response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        const events = await collectStreamEvents(this.parseStream(response));
        if (!hasTerminalEvent(events)) throw new Error("stream ended without a terminal event");
        return events;
      }
      const json = await response.json() as Record<string, unknown>;
      return eventsFromCompletedResponse(json);
    },
  };
}
