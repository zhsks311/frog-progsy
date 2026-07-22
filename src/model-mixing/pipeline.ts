import type { FrogConfig, FrogMessage } from "../types";

/** One resolved role in a `combine="pipeline"` roster: which provider/model plays thinker/worker/verifier. */
export interface PipelineStage {
  role: "thinker" | "worker" | "verifier";
  provider: string;
  model: string;
}

const ROLE_ORDER: PipelineStage["role"][] = ["thinker", "worker", "verifier"];

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
 * Resolve `combine="pipeline"` stages (stage-05-revision.md §2, §8 risk 1): an explicit
 * `modelMixing.pipeline[]` wins over inferring roles from `agents[].role`. Explicit entries with
 * an unconfigured provider are dropped (warned); the result is capped at 3 and deduped by role
 * (first occurrence wins). Inference orders thinker->worker->verifier, one agent per role, and
 * only considers agents whose provider is configured. If nothing resolves, `stages` is empty and
 * a warning explains why — the caller is expected to fall back to a plain final answer.
 */
export function resolvePipelineStages(config: FrogConfig): { stages: PipelineStage[]; warnings: string[] } {
  const warnings: string[] = [];
  const cfg = config.modelMixing;
  const explicit = cfg?.pipeline;

  let stages: PipelineStage[] = [];
  if (explicit && explicit.length > 0) {
    const seen = new Set<PipelineStage["role"]>();
    for (const entry of explicit) {
      if (!isConfigured(config, entry.provider, entry.model)) {
        warnings.push(`model-mixing: pipeline stage ${entry.role}/${entry.provider ?? "?"}/${entry.model ?? "?"} is unconfigured; dropped`);
        continue;
      }
      if (seen.has(entry.role)) {
        warnings.push(`model-mixing: pipeline stage role ${entry.role} duplicated; keeping first occurrence`);
        continue;
      }
      seen.add(entry.role);
      stages.push({ role: entry.role, provider: entry.provider, model: entry.model });
    }
    if (stages.length > 3) {
      warnings.push(`model-mixing: pipeline stages truncated from ${stages.length} to 3`);
      stages = stages.slice(0, 3);
    }
  } else {
    const agents = cfg?.agents ?? [];
    for (const role of ROLE_ORDER) {
      const agent = agents.find(a => a.role === role && isConfigured(config, a.provider, a.model));
      if (agent) stages.push({ role, provider: agent.provider, model: agent.model });
    }
  }

  if (stages.length === 0) {
    warnings.push("model-mixing: no pipeline stages resolved (no explicit pipeline[] and no agents[].role matched thinker/worker/verifier); falling back");
  }

  return { stages, warnings };
}

const ROLE_INSTRUCTION: Record<PipelineStage["role"], string> = {
  thinker: "You are the THINKER stage of a multi-model pipeline. Think through the task and produce a clear plan " +
    "(approach, key steps, risks/edge cases) for the WORKER stage to execute. Do not produce the final answer itself.",
  worker: "You are the WORKER stage of a multi-model pipeline. Do the actual work requested in the task, using the " +
    "THINKER's plan above as guidance. Produce a complete draft answer.",
  verifier: "You are the VERIFIER stage of a multi-model pipeline. Review the prior stage output(s), fix any errors, " +
    "and produce the final, corrected answer. Do not narrate the review.",
};

/** The single-user-message prompt handed to a buffered (non-final) pipeline stage. */
export function buildStagePrompt(
  role: PipelineStage["role"],
  taskText: string,
  priorStages: { role: string; text: string }[],
  guidance?: string,
): FrogMessage[] {
  const lines = [ROLE_INSTRUCTION[role]];
  if (guidance && guidance.trim().length > 0) {
    lines.push("", "GUIDANCE:", guidance.trim());
  }
  lines.push("", "TASK:", taskText.length > 0 ? taskText : "(no task text provided)");
  if (priorStages.length > 0) {
    lines.push("", "PRIOR STAGE OUTPUT:");
    for (const s of priorStages) lines.push(`[${s.role}] ${s.text}`);
  }
  return [{ role: "user", content: lines.join("\n"), timestamp: Date.now() }];
}

/**
 * The instruction appended to the real request context for the streamed final Verifier stage
 * (stage-05-revision.md §2): review the draft work built up by prior stages and produce the
 * final, corrected answer — without narrating the review.
 */
export function buildVerifierInstruction(priorStages: { role: string; text: string }[]): string {
  const lines = [
    "Review the following draft work and produce the final, corrected answer to the user's request. " +
      "Fix errors; keep what is correct; do not narrate the review.",
    "",
    ...priorStages.map(s => `[${s.role}] ${s.text}`),
  ];
  return lines.join("\n");
}
