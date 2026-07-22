import type { FrogAssistantContentPart, FrogConfig, FrogContentPart, FrogContext, FrogMessage } from "../types";
import { extractFirstJsonObject, validMixAgents } from "./select";
import type { MixTarget } from "./index";

const MAX_PANEL = 8;

/** A judge's structured comparison of N independent panel answers to the same task. */
export interface JudgeAnalysis {
  consensus: { point: string; supportingModels: string[] }[];
  contradictions: { topic: string; positions: { model: string; claim: string }[] }[];
  uniqueInsights: { model: string; insight: string }[];
  blindSpots: string[];
  confidence: "low" | "medium" | "high";
}

/** The resolved fusion roster: an answering panel, a judge, and a synthesizer. */
export interface FusionPlan {
  panel: MixTarget[];
  judge: MixTarget;
  synthesizer: MixTarget;
  warnings: string[];
}

function isConfigured(config: FrogConfig, provider: string | undefined, model: string | undefined): boolean {
  return (
    typeof provider === "string" &&
    provider.length > 0 &&
    typeof model === "string" &&
    model.length > 0 &&
    config.providers[provider] !== undefined
  );
}

/**
 * Resolve `combine="fusion"` roster: panel defaults to `validMixAgents(config)` when
 * `fusion.panel` is absent; entries with an unconfigured provider are dropped (warned).
 * Panel is truncated to 8 with a warning. Judge defaults to `coordinator`; synthesizer defaults
 * to `coordinator`, else the first surviving panel member. Missing required roles fall back
 * to the first surviving panel member (or the first roster agent) with a loud warning.
 */
export function resolveFusionPlan(config: FrogConfig): FusionPlan {
  const warnings: string[] = [];
  const cfg = config.modelMixing;
  const rawPanel = cfg?.fusion?.panel && cfg.fusion.panel.length > 0 ? cfg.fusion.panel : validMixAgents(config);

  let panel: MixTarget[] = [];
  for (const p of rawPanel) {
    if (isConfigured(config, p.provider, p.model)) {
      panel.push({ provider: p.provider, model: p.model });
    } else {
      warnings.push(`model-mixing: fusion panel entry ${p.provider ?? "?"}/${p.model ?? "?"} is unconfigured; dropped`);
    }
  }
  if (panel.length > MAX_PANEL) {
    warnings.push(`model-mixing: fusion panel truncated from ${panel.length} to ${MAX_PANEL}`);
    panel = panel.slice(0, MAX_PANEL);
  }
  if (panel.length === 0) {
    warnings.push("model-mixing: fusion panel is empty after validation; no panel members available");
  }

  const coordinator = cfg?.coordinator;
  const coordinatorTarget: MixTarget | undefined = isConfigured(config, coordinator?.provider, coordinator?.model)
    ? { provider: coordinator!.provider!, model: coordinator!.model! }
    : undefined;

  let judge: MixTarget;
  if (isConfigured(config, cfg?.fusion?.judge?.provider, cfg?.fusion?.judge?.model)) {
    judge = { provider: cfg!.fusion!.judge!.provider, model: cfg!.fusion!.judge!.model };
  } else if (coordinatorTarget) {
    judge = coordinatorTarget;
  } else if (panel[0]) {
    warnings.push("model-mixing: fusion judge unconfigured and no coordinator; falling back to first panel member");
    judge = panel[0];
  } else {
    warnings.push("model-mixing: fusion judge unresolved (no judge, coordinator, or panel configured)");
    judge = { provider: "", model: "" };
  }

  let synthesizer: MixTarget;
  if (isConfigured(config, cfg?.fusion?.synthesizer?.provider, cfg?.fusion?.synthesizer?.model)) {
    synthesizer = { provider: cfg!.fusion!.synthesizer!.provider, model: cfg!.fusion!.synthesizer!.model };
  } else if (coordinatorTarget) {
    synthesizer = coordinatorTarget;
  } else if (panel[0]) {
    warnings.push("model-mixing: fusion synthesizer unconfigured and no coordinator; falling back to first panel member");
    synthesizer = panel[0];
  } else {
    warnings.push("model-mixing: fusion synthesizer unresolved (no synthesizer, coordinator, or panel configured)");
    synthesizer = { provider: "", model: "" };
  }

  return { panel, judge, synthesizer, warnings };
}

export type FusionContextMode = "task" | "full";

export interface FusionPromptContext {
  contextMode?: FusionContextMode;
  context?: FrogContext;
}

function contentToPromptText(content: string | FrogContentPart[] | FrogAssistantContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return `[image: ${part.detail ? `detail=${part.detail} ` : ""}${part.imageUrl}]`;
      if (part.type === "thinking") return `[thinking] ${part.thinking}`;
      return `[tool_call: ${part.name}]`;
    })
    .join("");
}

function fullContextLines(context: FrogContext | undefined): string[] {
  const systemPrompt = context?.systemPrompt ?? [];
  const messages = context?.messages ?? [];
  const lines = [
    "FULL CONTEXT:",
    "The following is the original conversation context. It is provided verbatim without summarization.",
    "Client tools are intentionally not available to this pre-final stage.",
    "",
    "SYSTEM PROMPT:",
    "```text",
    systemPrompt.length > 0 ? systemPrompt.join("\n\n") : "(no system prompt)",
    "```",
    "",
    "MESSAGE HISTORY:",
  ];
  if (messages.length === 0) {
    lines.push("(no messages)");
  } else {
    messages.forEach((message, index) => {
      lines.push(`--- message ${index + 1}: ${message.role} ---`);
      if (message.role === "toolResult") {
        lines.push(`toolCallId: ${message.toolCallId}`);
        lines.push(`toolName: ${message.toolName}`);
        lines.push(`isError: ${message.isError}`);
        lines.push(contentToPromptText(message.content));
      } else {
        lines.push(contentToPromptText(message.content));
      }
    });
  }
  return lines;
}

function isFullContext(opts: FusionPromptContext | undefined): boolean {
  return opts?.contextMode === "full";
}

/** The single-user-message prompt handed to a panel member: answer the task directly. */
export function buildPanelPrompt(taskText: string, guidance?: string, opts?: FusionPromptContext): FrogMessage[] {
  const lines = [
    "You are one of several independent models answering the same task. Answer directly and completely;",
    "you will not see the other answers. Do not mention that you are part of a panel.",
  ];
  if (guidance && guidance.trim().length > 0) {
    lines.push("", "GUIDANCE:", guidance.trim());
  }
  if (isFullContext(opts)) {
    lines.push("", ...fullContextLines(opts?.context), "", "CURRENT TASK:", taskText.length > 0 ? taskText : "(no task text provided)");
  } else {
    lines.push("", "TASK:", taskText.length > 0 ? taskText : "(no task text provided)");
  }
  return [{ role: "user", content: lines.join("\n"), timestamp: Date.now() }];
}

/** The literal judge prompt (stage-05-revision.md §4b): JSON-only, 5-key `JudgeAnalysis` schema. */
export function buildJudgePrompt(
  taskText: string,
  panelAnswers: { label: string; text: string }[],
  opts?: FusionPromptContext,
): FrogMessage[] {
  const lines = [
    "You are an impartial analyst comparing N independent model answers to the SAME task.",
    "Produce ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys:",
    "{",
    '  "consensus": [{"point": string, "supportingModels": [modelLabel,...]}],',
    '  "contradictions": [{"topic": string, "positions": [{"model": modelLabel, "claim": string}]}],',
    '  "uniqueInsights": [{"model": modelLabel, "insight": string}],',
    '  "blindSpots": [string],',
    '  "confidence": "low" | "medium" | "high"',
    "}",
    'Rules: cite panel answers by their given label (e.g. "p1/m1"). consensus = points >=2 answers agree on.',
    "contradictions = points where answers directly conflict. uniqueInsights = correct/valuable points only one",
    "answer raised. blindSpots = important aspects of the TASK that NO answer addressed. confidence = your overall",
    "confidence that a correct synthesized answer is derivable from these answers. Output JSON ONLY.",
    "",
  ];
  if (isFullContext(opts)) {
    lines.push(...fullContextLines(opts?.context), "", "CURRENT TASK:");
  } else {
    lines.push("TASK:");
  }
  lines.push(
    taskText.length > 0 ? taskText : "(no task text provided)",
    "",
    "PANEL ANSWERS:",
    ...panelAnswers.map(a => `[${a.label}] ${a.text}`),
  );
  return [{ role: "user", content: lines.join("\n"), timestamp: Date.now() }];
}

/** Refine the current best candidate into one deliberately different, stronger variant. */
export function buildRefinePrompt(
  taskText: string,
  bestCandidate: { label: string; text: string },
  critique: JudgeAnalysis | null,
  instruction: string,
  opts?: FusionPromptContext,
): FrogMessage[] {
  const lines = [
    "You are refining the strongest current draft answer to the same task.",
    "Produce a complete replacement answer, not commentary about the draft.",
    "Preserve correct content, fix weaknesses identified by the judge, and follow the diversity instruction.",
    "",
  ];
  if (isFullContext(opts)) {
    lines.push(...fullContextLines(opts?.context), "", "CURRENT TASK:");
  } else {
    lines.push("TASK:");
  }
  lines.push(
    taskText.length > 0 ? taskText : "(no task text provided)",
    "",
    `CURRENT BEST CANDIDATE [${bestCandidate.label}]:`,
    bestCandidate.text,
    "",
    "JUDGE CRITIQUE:",
    critique ? JSON.stringify(critique) : "(no structured critique available)",
    "",
    "DIVERSITY / IMPROVEMENT INSTRUCTION:",
    instruction,
  );
  return [{ role: "user", content: lines.join("\n"), timestamp: Date.now() }];
}

/** Score current candidates with the existing JudgeAnalysis-compatible JSON schema. */
export function buildScorePrompt(
  taskText: string,
  candidates: { label: string; text: string }[],
  opts?: FusionPromptContext,
): FrogMessage[] {
  const lines = [
    "You are scoring candidate answers to the SAME task.",
    "Pick the single strongest candidate and compare all candidates using the JudgeAnalysis JSON schema below.",
    "Produce ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys:",
    "{",
    '  "consensus": [{"point": string, "supportingModels": [modelLabel,...]}],',
    '  "contradictions": [{"topic": string, "positions": [{"model": modelLabel, "claim": string}]}],',
    '  "uniqueInsights": [{"model": modelLabel, "insight": string}],',
    '  "blindSpots": [string],',
    '  "confidence": "low" | "medium" | "high"',
    "}",
    'Rules: the FIRST consensus item MUST be {"point":"BEST_CANDIDATE:<label>","supportingModels":["<label>"]}.',
    "Use the remaining fields to explain correctness, conflicts, unique strengths, and task blind spots.",
    "Output JSON ONLY.",
    "",
  ];
  if (isFullContext(opts)) {
    lines.push(...fullContextLines(opts?.context), "", "CURRENT TASK:");
  } else {
    lines.push("TASK:");
  }
  lines.push(
    taskText.length > 0 ? taskText : "(no task text provided)",
    "",
    "CANDIDATE ANSWERS:",
    ...candidates.map(a => `[${a.label}] ${a.text}`),
  );
  return [{ role: "user", content: lines.join("\n"), timestamp: Date.now() }];
}

/**
 * The literal synthesis instruction block (stage-05-revision.md §4b), appended to the synthesizer's
 * real `parsed.context` alongside the judge analysis (or raw panel answers when `analysis` is null)
 * so the synthesizer answers the user's actual task, not a summary of the panel.
 */
export function buildSynthesisPrompt(
  analysis: JudgeAnalysis | null,
  panelAnswers: { label: string; text: string }[],
): { instruction: string } {
  const lines = [
    "You are the SYNTHESIZER. Answer the user's ACTUAL request above with full context and tools.",
    "You are given an analysis of several independent draft answers. Use it as follows:",
    "- CONSENSUS: treat as high-confidence; rely on it unless it conflicts with the task or is clearly wrong.",
    "- CONTRADICTIONS: adjudicate each — decide which position is correct (or synthesize a better one) and",
    "  briefly justify only when it affects the answer.",
    "- UNIQUE INSIGHTS: incorporate any that improve the answer; ignore irrelevant ones.",
    "- BLIND SPOTS: explicitly cover them if they matter to the task.",
    '- Weight by the analysis "confidence": lower confidence => rely more on your own reasoning and the task context.',
    "Do NOT describe or summarize the panel or the analysis. Produce the best possible direct answer to the user.",
    "",
  ];
  if (analysis) {
    lines.push("ANALYSIS:", JSON.stringify(analysis));
  } else {
    lines.push(
      "ANALYSIS: (unavailable — judge analysis was invalid or skipped; synthesizing from raw panel answers)",
    );
  }
  lines.push("", "PANEL ANSWERS:", ...panelAnswers.map(a => `[${a.label}] ${a.text}`));
  return { instruction: lines.join("\n") };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === "string");
}

function coerceConsensus(v: unknown): JudgeAnalysis["consensus"] {
  if (!Array.isArray(v)) return [];
  return v.map(item => {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      point: typeof o.point === "string" ? o.point : "",
      supportingModels: isStringArray(o.supportingModels) ? o.supportingModels : [],
    };
  });
}

function coerceContradictions(v: unknown): JudgeAnalysis["contradictions"] {
  if (!Array.isArray(v)) return [];
  return v.map(item => {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const positions = Array.isArray(o.positions)
      ? o.positions.map(p => {
          const po = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
          return {
            model: typeof po.model === "string" ? po.model : "",
            claim: typeof po.claim === "string" ? po.claim : "",
          };
        })
      : [];
    return { topic: typeof o.topic === "string" ? o.topic : "", positions };
  });
}

function coerceUniqueInsights(v: unknown): JudgeAnalysis["uniqueInsights"] {
  if (!Array.isArray(v)) return [];
  return v.map(item => {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      model: typeof o.model === "string" ? o.model : "",
      insight: typeof o.insight === "string" ? o.insight : "",
    };
  });
}

/**
 * Parse a judge's reply into a `JudgeAnalysis`, or null when the top-level shape is invalid.
 * All five keys must be present; `consensus`/`contradictions`/`uniqueInsights`/`blindSpots` must be
 * arrays; `confidence` must be one of low/medium/high. Nested subfields are coerced (missing/wrong
 * type → "" or []) rather than rejected — only a malformed top-level shape returns null.
 */
export function parseJudgeAnalysis(text: string): JudgeAnalysis | null {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  if (!("consensus" in obj) || !("contradictions" in obj) || !("uniqueInsights" in obj) || !("blindSpots" in obj) || !("confidence" in obj)) {
    return null;
  }
  if (!Array.isArray(obj.consensus) || !Array.isArray(obj.contradictions) || !Array.isArray(obj.uniqueInsights) || !Array.isArray(obj.blindSpots)) {
    return null;
  }
  const confidence = obj.confidence;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return null;

  return {
    consensus: coerceConsensus(obj.consensus),
    contradictions: coerceContradictions(obj.contradictions),
    uniqueInsights: coerceUniqueInsights(obj.uniqueInsights),
    blindSpots: (obj.blindSpots as unknown[]).filter((x): x is string => typeof x === "string"),
    confidence,
  };
}
