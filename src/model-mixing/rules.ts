import type { FrogConfig, FrogParsedRequest } from "../types";
import { extractTaskText, mixAliasId, validMixAgents } from "./select";
import type { MixResolution } from "./index";

/**
 * Deterministic RULES mode: a task->model table, no LLM, no coordinator round-trip.
 *
 * Rules are evaluated in order. A rule matches iff every PRESENT sub-condition in its `match`
 * holds against `extractTaskText(parsed)` (lowercased substring checks):
 *  - `taskKeywords`: the task contains ANY listed keyword.
 *  - `difficulty`: the task contains the difficulty string.
 *  - `hint`: the task contains the hint string.
 *
 * DECISION: an absent or empty `match` object is a catch-all default — it matches unconditionally
 * so operators can terminate the table with a default rule. The first matching rule whose provider
 * is configured wins. A matching rule with an unconfigured provider is skipped (with a console
 * warning) rather than aborting the whole table, so later rules (including a catch-all) still get a
 * chance. No match at all falls back loudly to the first roster agent, then to the default provider.
 */
export function resolveRulesTarget(config: FrogConfig, parsed: FrogParsedRequest): MixResolution {
  const task = extractTaskText(parsed).toLowerCase();
  const rules = config.modelMixing?.rules ?? [];

  for (const rule of rules) {
    const match = rule.match;
    const isCatchAll =
      !match ||
      ((match.taskKeywords === undefined || match.taskKeywords.length === 0) &&
        match.difficulty === undefined &&
        match.hint === undefined);

    const matches =
      isCatchAll ||
      ((!match!.taskKeywords ||
        match!.taskKeywords.length === 0 ||
        match!.taskKeywords.some(k => task.includes(k.toLowerCase()))) &&
        (match!.difficulty === undefined || task.includes(match!.difficulty.toLowerCase())) &&
        (match!.hint === undefined || task.includes(match!.hint.toLowerCase())));

    if (!matches) continue;

    if (!config.providers[rule.provider]) {
      console.error(
        `model-mixing: rules mode matched a rule targeting unconfigured provider "${rule.provider}"; skipping`,
      );
      continue;
    }

    return { target: { provider: rule.provider, model: rule.model }, source: "coordinator" };
  }

  const agents = validMixAgents(config);
  if (agents.length) {
    return {
      target: { provider: agents[0]!.provider, model: agents[0]!.model },
      source: "fallback",
      warning: "model-mixing: no rules matched task; used first roster agent",
    };
  }
  return {
    target: {
      provider: config.defaultProvider,
      model: config.providers[config.defaultProvider]?.defaultModel ?? mixAliasId(config.modelMixing),
    },
    source: "fallback",
    warning: "model-mixing: no rules matched and no roster; used default provider",
  };
}
