import type {
  FrogAssistantMessage,
  FrogContentPart,
  FrogContext,
  FrogMessage,
  FrogParsedRequest,
  FrogRequestOptions,
  FrogTextContent,
  FrogThinkingContent,
  FrogTool,
  FrogToolCall,
  FrogToolResultMessage,
  FrogWebSearchRequest,
} from "../types";

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length > 0 ? [...new Set(out)] : undefined;
}

function isAnthropicWebSearchTool(value: unknown): boolean {
  if (!isObj(value)) return false;
  if (typeof value.type !== "string" || !/^web_search_\d{8}$/.test(value.type)) return false;
  return value.name === undefined || value.name === "web_search";
}

function extractAnthropicWebSearch(tools: unknown): FrogWebSearchRequest | undefined {
  if (!Array.isArray(tools)) return undefined;
  for (const raw of tools) {
    if (!isAnthropicWebSearchTool(raw) || !isObj(raw) || typeof raw.type !== "string") continue;
    const allowedDomains = stringArray(raw.allowed_domains);
    const blockedDomains = stringArray(raw.blocked_domains);
    const userLocation = isObj(raw.user_location) ? { ...raw.user_location } : undefined;
    return {
      kind: "anthropic_server",
      source: "anthropic_messages",
      type: raw.type,
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      raw: { ...raw },
      ...(typeof raw.max_uses === "number" ? { maxUses: raw.max_uses } : {}),
      ...(allowedDomains ? { allowedDomains } : {}),
      ...(blockedDomains ? { blockedDomains } : {}),
      ...(userLocation ? { userLocation } : {}),
      ...(typeof raw.search_context_size === "string" ? { searchContextSize: raw.search_context_size } : {}),
    };
  }
  return undefined;
}


function textFromSystem(system: unknown): string[] {
  if (typeof system === "string" && system.length > 0) return [system];
  if (!Array.isArray(system)) return [];
  const out: string[] = [];
  for (const block of system) {
    if (isObj(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      out.push(block.text);
    }
  }
  return out;
}

function imageUrlFromSource(source: unknown): string | undefined {
  if (!isObj(source)) return undefined;
  if (source.type === "url" && typeof source.url === "string") return source.url;
  if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return undefined;
}

function userContentPart(block: Record<string, unknown>): FrogContentPart | undefined {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    const imageUrl = imageUrlFromSource(block.source);
    if (imageUrl) return { type: "image", imageUrl };
    return { type: "text", text: "[image]" };
  }
  return undefined;
}

function compactUserContent(parts: FrogContentPart[]): string | FrogContentPart[] {
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function anthropicToolResultContent(content: unknown): string | FrogContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: FrogContentPart[] = [];
  let hasImage = false;
  for (const raw of content) {
    if (!isObj(raw)) continue;
    const part = userContentPart(raw);
    if (part) {
      if (part.type === "image") hasImage = true;
      parts.push(part);
    }
  }
  if (!hasImage) return parts.map(p => p.type === "text" ? p.text : "").join("");
  return parts;
}

function findToolById(messages: FrogMessage[], id: string): { name: string; namespace?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "toolCall" && part.id === id) return { name: part.name, namespace: part.namespace };
    }
  }
  return { name: "" };
}

function pushUserAndToolResults(
  messages: FrogMessage[],
  role: string,
  rawContent: unknown,
  now: number,
): void {
  if (typeof rawContent === "string") {
    if (rawContent.length > 0) messages.push({ role: role === "developer" ? "developer" : "user", content: rawContent, timestamp: now });
    return;
  }
  if (!Array.isArray(rawContent)) {
    messages.push({ role: role === "developer" ? "developer" : "user", content: "", timestamp: now });
    return;
  }

  const pendingParts: FrogContentPart[] = [];
  const flushParts = () => {
    if (pendingParts.length === 0) return;
    messages.push({
      role: role === "developer" ? "developer" : "user",
      content: compactUserContent([...pendingParts]),
      timestamp: now,
    });
    pendingParts.length = 0;
  };

  for (const raw of rawContent) {
    if (!isObj(raw)) continue;
    if (raw.type === "tool_result") {
      flushParts();
      const toolCallId = asString(raw.tool_use_id) ?? "";
      const toolInfo = findToolById(messages, toolCallId);
      const result: FrogToolResultMessage = {
        role: "toolResult",
        toolCallId,
        toolName: toolInfo.name,
        ...(toolInfo.namespace ? { toolNamespace: toolInfo.namespace } : {}),
        content: anthropicToolResultContent(raw.content),
        isError: raw.is_error === true,
        timestamp: now,
      };
      messages.push(result);
      continue;
    }
    const part = userContentPart(raw);
    if (part) pendingParts.push(part);
  }
  flushParts();
}

function pushAssistant(messages: FrogMessage[], rawContent: unknown, modelId: string, now: number): void {
  const content: Array<FrogTextContent | FrogThinkingContent | FrogToolCall> = [];
  if (typeof rawContent === "string") {
    if (rawContent.length > 0) content.push({ type: "text", text: rawContent });
  } else if (Array.isArray(rawContent)) {
    for (const raw of rawContent) {
      if (!isObj(raw)) continue;
      if (raw.type === "text" && typeof raw.text === "string") {
        content.push({ type: "text", text: raw.text });
      } else if (raw.type === "thinking" && typeof raw.thinking === "string") {
        content.push({
          type: "thinking",
          thinking: raw.thinking,
          ...(typeof raw.signature === "string" ? { signature: raw.signature } : {}),
        });
      } else if (raw.type === "redacted_thinking") {
        content.push({ type: "thinking", thinking: "", ...(typeof raw.data === "string" ? { signature: raw.data } : {}) });
      } else if (raw.type === "tool_use") {
        content.push({
          type: "toolCall",
          id: asString(raw.id) ?? `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
          name: asString(raw.name) ?? "",
          arguments: isObj(raw.input) ? raw.input : {},
        });
      }
    }
  }
  messages.push({ role: "assistant", content, model: modelId, timestamp: now });
}

function buildTools(tools: unknown): FrogTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: FrogTool[] = [];
  for (const raw of tools) {
    if (!isObj(raw) || typeof raw.name !== "string") continue;
    if (isAnthropicWebSearchTool(raw)) continue;
    out.push({
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : "",
      parameters: isObj(raw.input_schema) ? raw.input_schema : {},
    });
  }
  return out.length > 0 ? out : undefined;
}

function mapToolChoice(value: unknown): FrogRequestOptions["toolChoice"] {
  if (!isObj(value)) return undefined;
  switch (value.type) {
    case "auto": return "auto";
    case "none": return "none";
    case "any": return "required";
    case "tool": return typeof value.name === "string" ? { name: value.name } : "required";
    default: return undefined;
  }
}

function reasoningFromThinking(thinking: unknown): string | undefined {
  if (!isObj(thinking) || thinking.type !== "enabled") return undefined;
  const budget = typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : 0;
  if (budget >= 24_576) return "xhigh";
  if (budget >= 16_384) return "high";
  if (budget >= 8_192) return "medium";
  if (budget >= 4_096) return "low";
  return "minimal";
}

function toResponsesInput(messages: FrogMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "developer") {
      const content = typeof msg.content === "string"
        ? [{ type: "input_text", text: msg.content }]
        : msg.content.map(part => part.type === "image"
          ? { type: "input_image", image_url: part.imageUrl, ...(part.detail ? { detail: part.detail } : {}) }
          : { type: "input_text", text: part.text });
      input.push({ type: "message", role: msg.role, content });
    } else if (msg.role === "assistant") {
      const messageContent: unknown[] = [];
      const flushAssistantMessage = () => {
        if (messageContent.length === 0) return;
        input.push({ type: "message", role: "assistant", content: [...messageContent] });
        messageContent.length = 0;
      };
      for (const part of msg.content) {
        if (part.type === "text") {
          messageContent.push({ type: "output_text", text: part.text });
        } else if (part.type === "thinking") {
          flushAssistantMessage();
          input.push({ type: "reasoning", summary: part.thinking ? [{ text: part.thinking }] : [], content: [] });
        } else if (part.type === "toolCall") {
          flushAssistantMessage();
          input.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {}),
          });
        }
      }
      flushAssistantMessage();
    } else if (msg.role === "toolResult") {
      const content = typeof msg.content === "string"
        ? msg.content
        : msg.content.map(part => part.type === "image"
          ? { type: "input_image", image_url: part.imageUrl, ...(part.detail ? { detail: part.detail } : {}) }
          : { type: "output_text", text: part.text });
      input.push({ type: "function_call_output", call_id: msg.toolCallId, output: content });
    }
  }
  return input;
}

function toResponsesTools(tools: FrogTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function buildResponsesBody(parsed: FrogParsedRequest, source: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: parsed.modelId,
    input: toResponsesInput(parsed.context.messages),
    stream: parsed.stream,
  };
  if (parsed.context.systemPrompt?.length) body.instructions = parsed.context.systemPrompt.join("\n\n");
  const tools = toResponsesTools(parsed.context.tools);
  if (tools) body.tools = tools;
  if (parsed.options.maxOutputTokens !== undefined) body.max_output_tokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
  if (parsed.options.toolChoice !== undefined) {
    const tc = parsed.options.toolChoice;
    if (tc === "required") body.tool_choice = "required";
    else if (tc === "auto" || tc === "none") body.tool_choice = tc;
    else body.tool_choice = { type: "function", name: tc.name };
  }
  if (parsed.options.reasoning) body.reasoning = { effort: parsed.options.reasoning, summary: "auto" };
  if (typeof source.metadata === "object") body.metadata = source.metadata;
  return body;
}

export function parseMessagesRequest(body: unknown): FrogParsedRequest {
  if (!isObj(body)) throw new Error("messages parse error: request body must be an object");
  if (typeof body.model !== "string" || body.model.length === 0) throw new Error("messages parse error: model is required");
  if (!Array.isArray(body.messages)) throw new Error("messages parse error: messages array is required");

  const now = Date.now();
  const messages: FrogMessage[] = [];
  const modelId = body.model;
  const systemPrompt = textFromSystem(body.system);

  for (const raw of body.messages) {
    if (!isObj(raw) || typeof raw.role !== "string") continue;
    if (raw.role === "user" || raw.role === "developer") {
      pushUserAndToolResults(messages, raw.role, raw.content, now);
    } else if (raw.role === "assistant") {
      pushAssistant(messages, raw.content, modelId, now);
    }
  }

  const webSearchRequest = extractAnthropicWebSearch(body.tools);
  const tools = buildTools(body.tools);
  const context: FrogContext = {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    messages,
    ...(tools ? { tools } : {}),
  };

  const options: FrogRequestOptions = {};
  if (typeof body.max_tokens === "number") options.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === "number") options.temperature = body.temperature;
  if (typeof body.top_p === "number") options.topP = body.top_p;
  if (Array.isArray(body.stop_sequences)) options.stopSequences = body.stop_sequences.filter((s): s is string => typeof s === "string");
  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined) options.toolChoice = toolChoice;
  const reasoning = reasoningFromThinking(body.thinking);
  if (reasoning) {
    options.reasoning = reasoning;
    options.hideThinkingSummary = false;
  } else {
    options.hideThinkingSummary = true;
  }

  const parsed: FrogParsedRequest = {
    modelId,
    context,
    stream: body.stream === true,
    options,
    _messagesRawBody: body,
    ...(webSearchRequest ? { _webSearchRequest: webSearchRequest } : {}),
  };
  parsed._rawBody = buildResponsesBody(parsed, body);
  return parsed;
}

export function estimateMessagesInputTokens(parsed: FrogParsedRequest): number {
  let chars = 0;
  const add = (value: unknown) => { chars += JSON.stringify(value ?? "").length; };
  add(parsed.context.systemPrompt ?? []);
  for (const msg of parsed.context.messages) add(msg);
  for (const tool of parsed.context.tools ?? []) add(tool);
  const messageOverhead = parsed.context.messages.length * 16;
  const toolOverhead = (parsed.context.tools?.length ?? 0) * 64;
  const imageOverhead = parsed.context.messages.reduce((count, msg) => {
    const content = "content" in msg ? msg.content : undefined;
    return count + (Array.isArray(content) ? content.filter(p => p.type === "image").length : 0);
  }, 0) * 1024;
  return Math.max(1, Math.ceil(chars / 4) + messageOverhead + toolOverhead + imageOverhead);
}
