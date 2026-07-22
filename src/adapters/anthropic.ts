import { createHash } from "node:crypto";
import type { IncomingMeta, ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../debug";
import type {
  AdapterDiagnostic,
  AdapterStopReason,
  AdapterEvent,
  FrogAssistantMessage,
  FrogContentPart,
  FrogMessage,
  FrogParsedRequest,
  FrogProviderConfig,
  FrogTextContent,
  FrogThinkingContent,
  FrogToolCall,
  FrogToolResultMessage,
  FrogUsage,
} from "../types";
import { namespacedToolName } from "../types";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION, applyClaudeToolPrefix, stripClaudeToolPrefix } from "../oauth/anthropic";
import { modelRecordValue } from "../model-capabilities";
import { parseDataUrl } from "./image";

const ANTHROPIC_FORWARD_AUTH_HEADERS = ["authorization", "x-api-key"] as const;
const LOCAL_CLAUDE_AUTH_TOKEN = "local-frogprogsy";

function isLocalClaudeAuthToken(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === LOCAL_CLAUDE_AUTH_TOKEN || /^Bearer\s+local-frogprogsy$/i.test(trimmed);
}

function applyAnthropicForwardAuthHeaders(headers: Record<string, string>, incoming?: Headers): void {
  if (!incoming) return;
  for (const name of ANTHROPIC_FORWARD_AUTH_HEADERS) {
    const value = incoming.get(name);
    if (!value || !value.trim()) continue;
    if (name === "authorization" && isLocalClaudeAuthToken(value)) continue;
    // A scheme-only value (e.g. "Bearer" / "Bearer   ") carries no credential — forwarding it
    // upstream guarantees a 401; drop it instead.
    if (name === "authorization" && /^[A-Za-z-]+\s*$/.test(value.trim())) continue;
    headers[name === "authorization" ? "Authorization" : name] = value;
  }
}

/**
 * True when the incoming request forwards a real (non-placeholder) Bearer token. Anthropic
 * subscription OAuth tokens travel as `Authorization: Bearer …`; API keys travel as `x-api-key`.
 * Only Bearer forwards need the Claude OAuth request shape (identity system block + oauth beta).
 */
function hasForwardedBearerAuth(incoming?: Headers): boolean {
  const value = incoming?.get("authorization");
  return !!value && /^Bearer\s+\S/i.test(value.trim()) && !isLocalClaudeAuthToken(value);
}

/**
 * True for auth modes that speak the Anthropic subscription (Claude Code) wire identity: a resolved
 * Bearer subscription token in `provider.apiKey`, the OAuth `anthropic-beta` marker, the Claude Code
 * identity system block, and Claude tool-name prefixing. Stored Claude OAuth (`oauth`) and isolated,
 * config-dir-scoped Claude grants (`claude-grant`) both resolve a subscription Bearer token into
 * `provider.apiKey`, so they are wire-identical here; `key` and `forward` are not.
 */
function usesClaudeSubscriptionIdentity(provider: FrogProviderConfig): boolean {
  return provider.authMode === "oauth" || provider.authMode === "claude-grant";
}

/** Credential header names a resolved subscription Bearer identity owns exclusively. */
const ANTHROPIC_CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"]);

/**
 * Apply provider-configured custom headers. When the request already carries a resolved Claude
 * subscription Bearer identity (`oauth`/`claude-grant`), a custom `x-api-key` or `Authorization`
 * header must never shadow it or add a second credential — Anthropic 401s when an OAuth Bearer and
 * an API key are both present. Those credential headers are dropped in that mode; every other custom
 * header (and all custom headers in `key`/`forward` mode) is applied unchanged, preserving behavior.
 */
function applyProviderHeaders(
  headers: Record<string, string>,
  providerHeaders: Record<string, string> | undefined,
  protectBearerIdentity: boolean,
): void {
  if (!providerHeaders) return;
  for (const [name, value] of Object.entries(providerHeaders)) {
    if (protectBearerIdentity && ANTHROPIC_CREDENTIAL_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
}

/** Map a user content part to an Anthropic content block (text or image source). */
function toAnthropicContentPart(p: FrogContentPart): unknown {
  if (p.type === "image") {
    const data = parseDataUrl(p.imageUrl);
    return data
      ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.base64 } }
      : { type: "image", source: { type: "url", url: p.imageUrl } };
  }
  return { type: "text", text: p.text };
}

/** Default `max_tokens` when Claude Code omits `max_output_tokens`. */
const DEFAULT_MAX_TOKENS = 8192;
/** Ceiling applied to `thinking.budget_tokens` only — never to the caller's `max_tokens` cap. */
const REASONING_BUDGET_CEILING = 32_000;
/** Anthropic's documented minimum `thinking.budget_tokens`. */
const MIN_THINKING_BUDGET = 1024;
/**
 * Visible-output floor reserved under the caller's `max_tokens` when extended thinking is enabled.
 * Anthropic counts thinking + visible output against `max_tokens`; the caller cap is authoritative
 * and is never raised, so thinking is only sent when the cap fits `MIN_THINKING_BUDGET` plus this
 * floor (cap >= 5120). Below that, thinking is omitted and the request stays a normal capped call.
 */
const MIN_VISIBLE_OUTPUT_TOKENS_WITH_THINKING = 4096;

/** Anthropic-compatible stop reasons that may pass through to clients untouched. */
const APPROVED_STOP_REASONS: ReadonlySet<AdapterStopReason> = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence"]);

/**
 * Normalize a provider stop reason. Approved values pass through (`approved`); unknown values
 * normalize to `end_turn` (`unknown_normalized`) with a request-log-safe diagnostic carrying only
 * a sha256 hash + length of the raw value — the raw string never reaches clients or logs.
 */
function normalizeAnthropicStopReason(
  raw: unknown,
  surface: "stream" | "nonstream",
): { stopReason: AdapterStopReason; provenance: "approved" | "unknown_normalized"; diagnostic?: AdapterDiagnostic } | null {
  if (typeof raw !== "string") return null;
  if (APPROVED_STOP_REASONS.has(raw as AdapterStopReason)) {
    return { stopReason: raw as AdapterStopReason, provenance: "approved" };
  }
  return {
    stopReason: "end_turn",
    provenance: "unknown_normalized",
    diagnostic: {
      kind: "adapter",
      code: "anthropic_unknown_stop_reason",
      provider: "anthropic",
      surface,
      rawValueHash: createHash("sha256").update(raw).digest("hex"),
      rawValueLength: raw.length,
    },
  };
}
const COMPAT_TOOL_PREFIX = "frogp_";

/** Map a Responses reasoning effort to an Anthropic extended-thinking budget (tokens, >= 1024). */
function reasoningBudget(effort: string): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "high": return 16384;
    case "xhigh": return 24576;
    case "max": return 32000;
    case "medium":
    default: return 8192;
  }
}

function usageFromAnthropic(usage: Record<string, number> | undefined): FrogUsage | undefined {
  if (!usage) return undefined;
  const hasCache = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(hasCache ? { cachedInputTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) } : {}),
  };
}

function buildToolNameTransforms(provider: FrogProviderConfig): { toWire: (name: string) => string; fromWire: (name: string) => string } {
  if (usesClaudeSubscriptionIdentity(provider)) {
    return { toWire: applyClaudeToolPrefix, fromWire: stripClaudeToolPrefix };
  }
  if (provider.escapeBuiltinToolNames === true) {
    return {
      toWire: (name) => name.startsWith(COMPAT_TOOL_PREFIX) ? name : COMPAT_TOOL_PREFIX + name,
      fromWire: (name) => name.startsWith(COMPAT_TOOL_PREFIX) ? name.slice(COMPAT_TOOL_PREFIX.length) : name,
    };
  }
  return { toWire: (name) => name, fromWire: (name) => name };
}

function toAnthropicToolResult(msg: FrogToolResultMessage): Record<string, unknown> {
  // Anthropic tool_result accepts a string OR content blocks — render images natively
  // (e.g. Claude Code view_image output) instead of dropping them.
  const content = typeof msg.content === "string"
    ? msg.content
    : (msg.content as FrogContentPart[]).map(toAnthropicContentPart);
  return {
    type: "tool_result",
    tool_use_id: msg.toolCallId,
    content,
    ...(msg.isError ? { is_error: true } : {}),
  };
}

function orphanToolResultText(msg: FrogToolResultMessage): string {
  const label = msg.toolName ? `${msg.toolName} (${msg.toolCallId})` : msg.toolCallId;
  const content = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content);
  return `[tool_result without adjacent tool_use: ${label}]\n${content}`;
}

function messagesToAnthropicFormat(
  parsed: FrogParsedRequest,
  toolNames: { toWire: (name: string) => string },
): { system: string | undefined; messages: unknown[] } {
  const system = parsed.context.systemPrompt?.join("\n\n") || undefined;
  const messages: unknown[] = [];

  for (let i = 0; i < parsed.context.messages.length; i++) {
    const msg = parsed.context.messages[i];
    switch (msg.role) {
      case "user":
      case "developer": {
        const content = typeof msg.content === "string"
          ? msg.content
          : (msg.content as FrogContentPart[]).map(toAnthropicContentPart);
        messages.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const aMsg = msg as FrogAssistantMessage;
        const content: unknown[] = [];
        const toolUseIds: string[] = [];
        for (const part of aMsg.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: (part as FrogTextContent).text });
          } else if (part.type === "thinking") {
            const t = part as FrogThinkingContent;
            content.push({ type: "thinking", thinking: t.thinking, ...(t.signature ? { signature: t.signature } : {}) });
          } else if (part.type === "toolCall") {
            const tc = part as FrogToolCall;
            const flatName = namespacedToolName(tc.namespace, tc.name);
            toolUseIds.push(tc.id);
            content.push({ type: "tool_use", id: tc.id, name: toolNames.toWire(flatName), input: tc.arguments });
          }
        }
        messages.push({ role: "assistant", content });
        if (toolUseIds.length > 0) {
          const requiredIds = new Set(toolUseIds);
          const resultBlocks: Record<string, unknown>[] = [];
          const orphanBlocks: Record<string, unknown>[] = [];
          const seen = new Set<string>();
          let j = i + 1;
          while (j < parsed.context.messages.length && parsed.context.messages[j].role === "toolResult") {
            const tr = parsed.context.messages[j] as FrogToolResultMessage;
            if (requiredIds.has(tr.toolCallId) && !seen.has(tr.toolCallId)) {
              resultBlocks.push(toAnthropicToolResult(tr));
              seen.add(tr.toolCallId);
            } else {
              orphanBlocks.push({ type: "text", text: orphanToolResultText(tr) });
            }
            j++;
          }
          for (const id of toolUseIds) {
            if (!seen.has(id)) {
              resultBlocks.push({
                type: "tool_result",
                tool_use_id: id,
                content: "[frogprogsy: missing tool_result for this tool_use in Claude Code history]",
                is_error: true,
              });
            }
          }
          messages.push({ role: "user", content: [...resultBlocks, ...orphanBlocks] });
          i = j - 1;
        }
        break;
      }
      case "toolResult": {
        // A standalone Anthropic tool_result is invalid unless it immediately follows an
        // assistant tool_use. Preserve the information as text instead of sending a 400-prone block.
        messages.push({ role: "user", content: orphanToolResultText(msg as FrogToolResultMessage) });
        break;
      }
    }
  }

  return { system, messages };
}

function toolsToAnthropicFormat(
  parsed: FrogParsedRequest,
  toolNames: { toWire: (name: string) => string },
  nativeWebSearchEnabled: boolean,
): unknown[] | undefined {
  const out: unknown[] = [];
  if (nativeWebSearchEnabled && parsed._webSearchRequest?.kind === "anthropic_server") {
    out.push(parsed._webSearchRequest.raw);
  }
  for (const t of parsed.context.tools ?? []) {
    out.push({
      name: toolNames.toWire(namespacedToolName(t.namespace, t.name)),
      description: t.description,
      input_schema: t.parameters,
    });
  }
  return out.length > 0 ? out : undefined;
}

export function createAnthropicAdapter(provider: FrogProviderConfig): ProviderAdapter {
  const isSubscription = usesClaudeSubscriptionIdentity(provider);
  const isForward = provider.authMode === "forward";
  const toolNames = buildToolNameTransforms(provider);
  return {
    name: "anthropic",

    buildRequest(parsed: FrogParsedRequest, incoming?: IncomingMeta) {
      // Forward-mode requests that relay a subscription Bearer token must use the same Claude
      // OAuth request shape as oauth mode: Anthropic rejects Bearer subscription tokens whose
      // first system block is not the Claude Code identity (surfaced as a misleading 429
      // rate_limit_error). Real Claude Code callers already send the identity themselves.
      const forwardedBearer = isForward && hasForwardedBearerAuth(incoming?.headers);
      // oauth/claude-grant resolve a subscription Bearer token; a forwarded subscription Bearer
      // needs the same wire shape. All three share the Claude OAuth request identity.
      const useOAuthShape = isSubscription || forwardedBearer;
      const { system, messages } = messagesToAnthropicFormat(parsed, toolNames);
      const nativeWebSearchEnabled = modelRecordValue(provider.modelCapabilities, parsed.modelId)?.webSearch === true;
      const tools = toolsToAnthropicFormat(parsed, toolNames, nativeWebSearchEnabled);

      const body: Record<string, unknown> = {
        model: parsed.modelId,
        messages,
        stream: parsed.stream,
        max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (useOAuthShape) {
        // Claude OAuth (Pro/Max) requires the first system block to be the Claude Code identity.
        body.system = system?.startsWith(CLAUDE_CODE_SYSTEM_INSTRUCTION)
          ? [{ type: "text", text: system }]
          : [
            { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
            ...(system ? [{ type: "text", text: system }] : []),
          ];
      } else if (system) {
        body.system = system;
      }
      if (tools) body.tools = tools;
      if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
      if (parsed.options.stopSequences) body.stop_sequences = parsed.options.stopSequences;

      if (parsed.options.reasoning) {
        // Anthropic requires max_tokens > thinking.budget_tokens (max_tokens caps thinking +
        // visible output) and budget_tokens >= 1024. The caller's max_tokens is the hard wire cap
        // and is NEVER raised. Thinking is sent only when the cap fits the minimum budget plus the
        // visible-output floor; otherwise it is omitted and the request stays a normal capped call.
        const callerMaxTokens = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
        if (callerMaxTokens >= MIN_THINKING_BUDGET + MIN_VISIBLE_OUTPUT_TOKENS_WITH_THINKING) {
          const wantBudget = Math.min(reasoningBudget(parsed.options.reasoning), REASONING_BUDGET_CEILING);
          const budget = Math.min(wantBudget, callerMaxTokens - MIN_VISIBLE_OUTPUT_TOKENS_WITH_THINKING);
          body.thinking = { type: "enabled", budget_tokens: budget };
          // Extended thinking disallows temperature != 1 and top_p — drop both or the API 400s.
          delete body.temperature;
          delete body.top_p;
        }
      }

      if (parsed.options.toolChoice) {
        const tc = parsed.options.toolChoice;
        if (tc === "auto") body.tool_choice = { type: "auto" };
        else if (tc === "none") body.tool_choice = { type: "none" };
        else if (tc === "required") body.tool_choice = { type: "any" };
        else if (typeof tc === "object" && "name" in tc) {
          const nativeWebSearchName = nativeWebSearchEnabled && parsed._webSearchRequest?.kind === "anthropic_server"
            ? parsed._webSearchRequest.name ?? "web_search"
            : undefined;
          body.tool_choice = {
            type: "tool",
            name: tc.name === nativeWebSearchName ? tc.name : toolNames.toWire(tc.name),
          };
        }
      }

      const base = provider.baseUrl.replace(/\/v1\/?$/, "");
      const url = `${base}/v1/messages`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (isSubscription) {
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      } else if (!isForward && provider.apiKey) {
        headers["x-api-key"] = provider.apiKey;
      }
      applyProviderHeaders(headers, provider.headers, isSubscription);
      const incomingVersion = incoming?.headers.get("anthropic-version");
      if (incomingVersion) headers["anthropic-version"] = incomingVersion;
      const incomingBeta = incoming?.headers.get("anthropic-beta");
      if (incomingBeta) {
        headers["anthropic-beta"] = useOAuthShape && !incomingBeta.includes(ANTHROPIC_OAUTH_BETA)
          ? `${ANTHROPIC_OAUTH_BETA},${incomingBeta}`
          : incomingBeta;
      } else if (forwardedBearer) {
        headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      }
      if (isForward) applyAnthropicForwardAuthHeaders(headers, incoming?.headers);

      return { url, method: "POST", headers, body: JSON.stringify(body) };
    },

    async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentBlockType = "";
      let currentToolCallId = "";
      let currentToolCallName = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEventType = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEventType = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;

            let data: Record<string, unknown>;
            try {
              data = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              debugDroppedFrame("anthropic", payload);
              continue;
            }

            switch (currentEventType || data.type) {
              case "content_block_start": {
                const block = data.content_block as { type: string; id?: string; name?: string } | undefined;
                if (!block) break;
                currentBlockType = block.type;
                if (block.type === "tool_use") {
                  currentToolCallId = block.id ?? "";
                  currentToolCallName = toolNames.fromWire(block.name ?? "");
                  yield { type: "tool_call_start", id: currentToolCallId, name: currentToolCallName };
                }
                break;
              }
              case "content_block_delta": {
                const delta = data.delta as Record<string, unknown> | undefined;
                if (!delta) break;
                if (delta.type === "text_delta" && typeof delta.text === "string") {
                  yield { type: "text_delta", text: delta.text };
                } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                  yield { type: "thinking_delta", thinking: delta.thinking };
                } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                  yield { type: "tool_call_delta", arguments: delta.partial_json };
                }
                break;
              }
              case "content_block_stop": {
                if (currentBlockType === "tool_use") {
                  yield { type: "tool_call_end" };
                  currentToolCallId = "";
                  currentBlockType = "";
                }
                break;
              }
              case "message_delta": {
                const usage = data.usage as Record<string, number> | undefined;
                const delta = data.delta as { stop_reason?: unknown } | undefined;
                const stop = normalizeAnthropicStopReason(delta?.stop_reason, "stream");
                if (stop?.diagnostic) yield { type: "diagnostic", diagnostic: stop.diagnostic };
                if (usage || stop) {
                  yield {
                    type: "done",
                    usage: usageFromAnthropic(usage),
                    ...(stop ? { stopReason: stop.stopReason, stopReasonProvenance: stop.provenance } : {}),
                  };
                }
                break;
              }
              case "message_stop": {
                break;
              }
              case "error": {
                const err = data.error as { message?: string } | undefined;
                yield { type: "error", message: err?.message ?? "Anthropic error" };
                return;
              }
            }
            currentEventType = "";
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const json = await response.json() as Record<string, unknown>;
      const events: AdapterEvent[] = [];
      const content = json.content as { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[] | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            events.push({ type: "text_delta", text: block.text });
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            events.push({ type: "thinking_delta", thinking: block.thinking });
          } else if (block.type === "tool_use") {
            events.push({ type: "tool_call_start", id: block.id ?? "", name: toolNames.fromWire(block.name ?? "") });
            events.push({ type: "tool_call_delta", arguments: JSON.stringify(block.input ?? {}) });
            events.push({ type: "tool_call_end" });
          }
        }
      }
      const usage = json.usage as Record<string, number> | undefined;
      const stop = normalizeAnthropicStopReason(json.stop_reason, "nonstream");
      if (stop?.diagnostic) events.push({ type: "diagnostic", diagnostic: stop.diagnostic });
      events.push({
        type: "done",
        usage: usageFromAnthropic(usage),
        ...(stop ? { stopReason: stop.stopReason, stopReasonProvenance: stop.provenance } : {}),
      });
      return events;
    },

  };
}
