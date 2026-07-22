import type { AdapterEvent, AdapterStopReason, FrogUsage } from "../types";
import { classifyError } from "../errors";

function uuid(prefix = "msg"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function usageFromAdapter(usage: FrogUsage | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const out: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedInputTokens !== undefined) out.cache_read_input_tokens = usage.cachedInputTokens;
  if (usage.reasoningOutputTokens !== undefined) out.reasoning_output_tokens = usage.reasoningOutputTokens;
  return out;
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

function parseToolInput(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return { input: args };
  }
}

/**
 * Merge a `done` event's provider stop metadata into the locally tracked stop reason.
 * Precedence (binding, from the approved plan amendment): `max_tokens`, `stop_sequence`, and
 * `tool_use` always set the final stop reason; `end_turn` — including `unknown_normalized`
 * end_turn — never overwrites a locally established `tool_use`.
 */
function applyStopReason(local: AdapterStopReason, event: { stopReason?: AdapterStopReason }): AdapterStopReason {
  if (!event.stopReason) return local;
  if (event.stopReason === "end_turn" && local === "tool_use") return local;
  return event.stopReason;
}

interface MessageBuildOptions {
  hideThinkingSummary?: boolean;
}

export function buildMessageJSON(
  events: AdapterEvent[],
  modelId: string,
  options?: MessageBuildOptions,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  let currentText = "";
  let currentThinking = "";
  let currentTool: { id: string; name: string; args: string } | null = null;
  let usage: FrogUsage | undefined;
  let errorMessage: string | undefined;
  let stopReason: AdapterStopReason = "end_turn";
  let providerStopReason: AdapterStopReason | undefined;

  const flushText = () => {
    if (!currentText) return;
    content.push({ type: "text", text: currentText });
    currentText = "";
  };
  const flushThinking = () => {
    if (!currentThinking || options?.hideThinkingSummary) {
      currentThinking = "";
      return;
    }
    content.push({ type: "thinking", thinking: currentThinking });
    currentThinking = "";
  };
  const flushTool = () => {
    if (!currentTool) return;
    content.push({
      type: "tool_use",
      id: currentTool.id,
      name: currentTool.name,
      input: parseToolInput(currentTool.args),
    });
    stopReason = "tool_use";
    currentTool = null;
  };

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        flushThinking();
        flushTool();
        currentText += event.text;
        break;
      case "thinking_delta":
      case "reasoning_raw_delta":
        flushText();
        flushTool();
        currentThinking += event.type === "thinking_delta" ? event.thinking : event.text;
        break;
      case "tool_call_start":
        flushText();
        flushThinking();
        flushTool();
        currentTool = { id: event.id || uuid("toolu"), name: event.name, args: "" };
        break;
      case "tool_call_delta":
        if (currentTool) currentTool.args += event.arguments;
        break;
      case "tool_call_end":
        flushTool();
        break;
      case "diagnostic":
        // Request-log-safe adapter diagnostics are recorded by the server observer, never bridged.
        break;
      case "done":
        usage = event.usage;
        if (event.stopReason) providerStopReason = event.stopReason;
        break;
      case "error":
        errorMessage = event.message;
        break;
    }
  }

  flushText();
  flushThinking();
  flushTool();

  if (errorMessage) {
    return {
      id: uuid(),
      type: "message",
      role: "assistant",
      model: modelId,
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: usageFromAdapter(usage),
      error: { message: errorMessage },
    };
  }

  return {
    id: uuid(),
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: applyStopReason(stopReason, { stopReason: providerStopReason }),
    stop_sequence: null,
    usage: usageFromAdapter(usage),
  };
}

export function bridgeToMessagesSSE(
  events: AsyncIterable<AdapterEvent>,
  modelId: string,
  onCancel?: () => void,
  heartbeatMs = 2_000,
  options?: MessageBuildOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const messageId = uuid();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let activity = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (name: string, data: Record<string, unknown>) => {
        if (closed) return;
        activity = true;
        try {
          controller.enqueue(encoder.encode(sseEvent(name, data)));
        } catch {
          closed = true;
        }
      };

      emit("message_start", {
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        if (activity) { activity = false; return; }
        try { controller.enqueue(encoder.encode(": frogprogsy keepalive\n\n")); } catch { closed = true; }
      }, heartbeatMs);

      let index = 0;
      let current: "text" | "thinking" | "tool" | null = null;
      let currentTool: { id: string; name: string; args: string; index: number } | null = null;
      let stopReason: AdapterStopReason = "end_turn";
      let providerStopReason: AdapterStopReason | undefined;
      let usage: FrogUsage | undefined;

      const closeCurrent = () => {
        if (current === null) return;
        emit("content_block_stop", { index: currentTool?.index ?? index - 1 });
        current = null;
        currentTool = null;
      };
      const startText = () => {
        if (current === "text") return;
        closeCurrent();
        emit("content_block_start", { index, content_block: { type: "text", text: "" } });
        current = "text";
        index++;
      };
      const startThinking = () => {
        if (options?.hideThinkingSummary) return;
        if (current === "thinking") return;
        closeCurrent();
        emit("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
        current = "thinking";
        index++;
      };
      const startTool = (id: string, name: string) => {
        closeCurrent();
        const toolIndex = index++;
        currentTool = { id: id || uuid("toolu"), name, args: "", index: toolIndex };
        current = "tool";
        stopReason = "tool_use";
        emit("content_block_start", {
          index: toolIndex,
          content_block: { type: "tool_use", id: currentTool.id, name, input: {} },
        });
      };

      try {
        for await (const event of events) {
          if (closed) break;
          switch (event.type) {
            case "text_delta":
              startText();
              emit("content_block_delta", { index: index - 1, delta: { type: "text_delta", text: event.text } });
              break;
            case "thinking_delta":
            case "reasoning_raw_delta": {
              const text = event.type === "thinking_delta" ? event.thinking : event.text;
              if (options?.hideThinkingSummary) break;
              startThinking();
              emit("content_block_delta", { index: index - 1, delta: { type: "thinking_delta", thinking: text } });
              break;
            }
            case "tool_call_start":
              startTool(event.id, event.name);
              break;
            case "tool_call_delta":
              if (!currentTool) startTool(uuid("toolu"), "tool");
              currentTool!.args += event.arguments;
              emit("content_block_delta", { index: currentTool!.index, delta: { type: "input_json_delta", partial_json: event.arguments } });
              break;
            case "tool_call_end":
              closeCurrent();
              break;
            case "diagnostic":
              // Request-log-safe adapter diagnostics are recorded by the server observer, never bridged.
              break;
            case "done":
              usage = event.usage;
              if (event.stopReason) providerStopReason = event.stopReason;
              break;
            case "error":
              closeCurrent();
              emit("error", { error: { type: "api_error", message: event.message } });
              controller.close();
              closed = true;
              break;
          }
        }
        if (!closed) {
          closeCurrent();
          emit("message_delta", {
            delta: { stop_reason: applyStopReason(stopReason, { stopReason: providerStopReason }), stop_sequence: null },
            usage: usageFromAdapter(usage),
          });
          emit("message_stop", {});
          controller.close();
          closed = true;
        }
      } catch (err) {
        if (!closed) {
          const message = err instanceof Error ? err.message : String(err);
          emit("error", { error: { type: "api_error", message } });
          controller.close();
          closed = true;
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    },
    cancel(reason) {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      onCancel?.();
    },
  });
}

export function formatAnthropicErrorResponse(status: number, type: string, message: string): Response {
  const classified = classifyError(status, type, message);
  const errorType = classified.code === "server_is_overloaded" ? "overloaded_error" : classified.type;
  return new Response(JSON.stringify({ type: "error", error: { type: errorType, message: classified.message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
