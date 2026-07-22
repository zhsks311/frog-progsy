import type {
  FrogConfig,
  FrogContentPart,
  FrogMessage,
  FrogModelMixingAgent,
  FrogModelMixingConfig,
  FrogParsedRequest,
} from "../types";

// Namespaced by default (`<ns>/<id>`) so it rides the routed-catalog lifecycle: injected as a routed
// entry, featured/orderable, and stripped on restore like any other "provider/model" slug.
export const DEFAULT_MIX_ALIAS_ID = "frogp/mix";
export const DEFAULT_MIX_TIMEOUT_MS = 15_000;
const MAX_TASK_CHARS = 4000;

/** The model id that triggers mixing when Claude Code targets it. */
export function mixAliasId(cfg: FrogModelMixingConfig | undefined): string {
  const id = cfg?.aliasId?.trim();
  return id && id.length > 0 ? id : DEFAULT_MIX_ALIAS_ID;
}

/** True when this request should enter the mixing path (enabled + id match). */
export function isModelMixingRequest(config: FrogConfig, modelId: string): boolean {
  const cfg = config.modelMixing;
  if (!cfg?.enabled) return false;
  return modelId === mixAliasId(cfg);
}

/**
 * Roster agents that are actually routable: a non-empty provider/model whose provider is a
 * configured provider. Unconfigured providers are dropped — routing them would fall through
 * `routeModel` to an unrelated default, which is worse than skipping them.
 */
export function validMixAgents(config: FrogConfig): FrogModelMixingAgent[] {
  const agents = config.modelMixing?.agents ?? [];
  return agents.filter(
    a =>
      !!a &&
      typeof a.provider === "string" &&
      a.provider.length > 0 &&
      typeof a.model === "string" &&
      a.model.length > 0 &&
      config.providers[a.provider] !== undefined,
  );
}

function textFromContent(content: string | FrogContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map(p => p.text)
    .join("\n");
}

/** The task the coordinator routes on: the latest user message text (truncated). */
export function extractTaskText(parsed: FrogParsedRequest): string {
  const msgs = parsed.context.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "user") {
      const t = textFromContent(m.content).trim();
      if (t.length > 0) return t.slice(0, MAX_TASK_CHARS);
    }
  }
  // Fallback: newest non-empty user/developer message of any position.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "user" || m.role === "developer") {
      const t = textFromContent(m.content).trim();
      if (t.length > 0) return t.slice(0, MAX_TASK_CHARS);
    }
  }
  return "";
}

/** Human-readable, index-numbered roster the coordinator selects from. */
export function rosterText(agents: FrogModelMixingAgent[]): string {
  return agents
    .map((a, i) => {
      const bits: string[] = [`#${i}: ${a.provider}/${a.model}`];
      if (a.tasks?.length) bits.push(`tasks=[${a.tasks.join(", ")}]`);
      if (a.difficulty?.length) bits.push(`difficulty=[${a.difficulty.join(", ")}]`);
      if (a.role) bits.push(`role=${a.role}`);
      if (a.notes) bits.push(`notes: ${a.notes}`);
      return bits.join("  ");
    })
    .join("\n");
}

/** The single-user-message prompt handed to the coordinator model. */
export function buildCoordinatorPrompt(
  agents: FrogModelMixingAgent[],
  guidance: string | undefined,
  taskText: string,
): string {
  const lines = [
    "You are a model-routing coordinator. Pick exactly ONE agent from the roster to handle the task below.",
    "Base your choice on each agent's task types, difficulty tiers, and the operator guidance.",
    "",
    "ROSTER:",
    rosterText(agents),
  ];
  if (guidance && guidance.trim().length > 0) {
    lines.push("", "GUIDANCE:", guidance.trim());
  }
  lines.push(
    "",
    "TASK:",
    taskText.length > 0 ? taskText : "(no task text provided)",
    "",
    'Respond with ONLY a JSON object: {"agent": <index>} where <index> is the 0-based roster number of your choice. No prose, no explanation.',
  );
  return lines.join("\n");
}

/** Wrap the coordinator prompt as a one-message conversation. */
export function coordinatorMessages(prompt: string): FrogMessage[] {
  return [{ role: "user", content: prompt, timestamp: Date.now() }];
}

export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const o: unknown = JSON.parse(cleaned.slice(start, i + 1));
          if (o && typeof o === "object") return o as Record<string, unknown>;
        } catch {
          /* not valid JSON */
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Parse the coordinator reply into a chosen roster agent, or null when unparseable/out of range.
 * Accepts `{"agent": n}` / `{"index": n}` (0-based index) or `{"provider": ..., "model": ...}`
 * matching a roster entry. Anything else (prose, wrong index, unknown provider/model) is a miss so
 * the caller can fall back loudly rather than route somewhere unintended.
 */
export function parseCoordinatorChoice(
  text: string,
  agents: FrogModelMixingAgent[],
): FrogModelMixingAgent | null {
  if (agents.length === 0) return null;
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;

  const idx = obj.agent ?? obj.index;
  if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < agents.length) {
    return agents[idx]!;
  }
  if (typeof obj.provider === "string" && typeof obj.model === "string") {
    const match = agents.find(a => a.provider === obj.provider && a.model === obj.model);
    if (match) return match;
  }
  return null;
}
