import type { FrogConfig, FrogMessage, FrogParsedRequest } from "../types";
import {
  buildCoordinatorPrompt,
  coordinatorMessages,
  DEFAULT_MIX_TIMEOUT_MS,
  extractTaskText,
  mixAliasId,
  parseCoordinatorChoice,
  validMixAgents,
} from "./select";
import { resolveRulesTarget } from "./rules";

export {
  DEFAULT_MIX_ALIAS_ID,
  DEFAULT_MIX_TIMEOUT_MS,
  isModelMixingRequest,
  mixAliasId,
  validMixAgents,
} from "./select";

/** A concrete provider/model the mixing coordinator resolved to. `provider` is always configured. */
export interface MixTarget {
  provider: string;
  model: string;
}

export interface MixResolution {
  target: MixTarget;
  /** "coordinator" when the model chose it; "fallback" when a misconfig/failure forced the choice. */
  source: "coordinator" | "fallback";
  /** Non-fatal diagnostic emitted on any fallback (mirrors the classifier's loud-fallback rule). */
  warning?: string;
}

export interface CoordinatorCallArgs {
  providerName: string;
  modelId: string;
  messages: FrogMessage[];
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Runs one non-streaming completion against the coordinator provider/model and returns its text.
 * Injected by the server (which owns adapter resolution + auth); kept out of this module so the
 * planning logic stays pure and unit-testable.
 */
export type CoordinatorComplete = (args: CoordinatorCallArgs) => Promise<string>;

/**
 * Resolve a `frogp-mix` request to a concrete provider/model.
 *
 * v1 implements `combine: "route"` in `mode: "coordinator"`: the coordinator model reads the roster
 * plus operator guidance and picks exactly one agent. Every failure path (no roster, coordinator
 * unconfigured, call error, unparseable reply) falls back to the first roster agent (or the default
 * provider when the roster is empty) with a loud `warning` — never a silent surprise route.
 */
export async function resolveMix(
  config: FrogConfig,
  parsed: FrogParsedRequest,
  complete: CoordinatorComplete,
  signal?: AbortSignal,
): Promise<MixResolution> {
  const cfg = config.modelMixing;
  if (cfg?.mode === "rules") {
    return resolveRulesTarget(config, parsed);
  }
  const agents = validMixAgents(config);

  if (agents.length === 0) {
    const dp = config.providers[config.defaultProvider];
    const model = dp?.defaultModel ?? mixAliasId(cfg);
    return {
      target: { provider: config.defaultProvider, model },
      source: "fallback",
      warning: "model-mixing: no routable agents configured; fell back to the default provider",
    };
  }

  const firstAgent = agents[0]!;
  const fallback = (warning: string): MixResolution => ({
    target: { provider: firstAgent.provider, model: firstAgent.model },
    source: "fallback",
    warning,
  });

  const coordProvider = cfg?.coordinator?.provider;
  const coordModel = cfg?.coordinator?.model;
  if (!coordProvider || !coordModel || !config.providers[coordProvider]) {
    return fallback("model-mixing: coordinator model not configured; used the first roster agent");
  }

  const prompt = buildCoordinatorPrompt(agents, cfg?.guidance, extractTaskText(parsed));
  const timeoutMs = cfg?.timeoutMs ?? DEFAULT_MIX_TIMEOUT_MS;

  let reply: string;
  try {
    reply = await complete({
      providerName: coordProvider,
      modelId: coordModel,
      messages: coordinatorMessages(prompt),
      timeoutMs,
      signal,
    });
  } catch (e) {
    return fallback(
      `model-mixing: coordinator call failed (${e instanceof Error ? e.message : String(e)}); used the first roster agent`,
    );
  }

  const choice = parseCoordinatorChoice(reply, agents);
  if (!choice) {
    return fallback("model-mixing: coordinator reply was unparseable; used the first roster agent");
  }
  return { target: { provider: choice.provider, model: choice.model }, source: "coordinator" };
}

/**
 * A no-LLM mix target for side calls that must not spend a coordinator round-trip (e.g. token
 * counting): the first routable roster agent, or the default provider's default model when the
 * roster is empty.
 */
export function cheapMixTarget(config: FrogConfig): MixTarget {
  const agents = validMixAgents(config);
  if (agents.length > 0) return { provider: agents[0]!.provider, model: agents[0]!.model };
  const dp = config.providers[config.defaultProvider];
  return { provider: config.defaultProvider, model: dp?.defaultModel ?? mixAliasId(config.modelMixing) };
}
