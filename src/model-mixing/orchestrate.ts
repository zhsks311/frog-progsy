import type { FrogConfig, FrogModelMixingCombine } from "../types";
import { resolveFusionPlan } from "./fusion";

const MAX_PIPELINE_STAGES = 3;
const PIPELINE_ROLES = ["thinker", "worker", "verifier"] as const;

function countPipelineStages(config: FrogConfig): number {
  const cfg = config.modelMixing;
  const explicit = cfg?.pipeline ?? [];
  if (explicit.length > 0) {
    const roles = new Set(explicit.map(s => s.role));
    return Math.min(roles.size, MAX_PIPELINE_STAGES) || 1;
  }
  // Infer from agents[].role (dedup by role), else fall back to a single stage.
  const inferred = new Set((cfg?.agents ?? []).map(a => a.role).filter((r): r is string => !!r && (PIPELINE_ROLES as readonly string[]).includes(r)));
  return Math.min(inferred.size, MAX_PIPELINE_STAGES) || 1;
}

/**
 * Deterministic upstream call-count estimate for a resolved model-mixing turn, for cost/latency
 * accounting, tests, and preview UIs. Pure — does not dispatch anything, and this is NOT the
 * enforcement path: hard caps are enforced at `resolveFusionPlan` (fusion panel size / MAX_PANEL
 * in fusion.ts) and `resolvePipelineStages` (pipeline.ts), independently of this function.
 * - route (mode="coordinator"): 1 coordinator call + 1 routed call = 2.
 * - route (mode="rules"): deterministic target, no coordinator = 1.
 * - pipeline: one call per resolved stage (1-3; explicit `pipeline[]` wins, else inferred from
 *   `agents[].role`, else a single stage).
 * - fusion: panel.length (1-8) + 1 judge + 1 synthesizer, plus optional multiround score/refine calls.
 *   Panel web search is reported separately because it is capped by `maxTotalSearches`, not `budgetCalls`.
 */
export function computeCallPlan(config: FrogConfig): { mode: "route" | "pipeline" | "fusion"; calls: number; searchCalls: number; detail: string } {
  const cfg = config.modelMixing;
  const combine: FrogModelMixingCombine = cfg?.combine ?? "route";

  if (combine === "fusion") {
    const plan = resolveFusionPlan(config);
    const panelSize = Math.max(plan.panel.length, 1);
    const panelSearch = config.modelMixing?.fusion?.panelWebSearch;
    const maxPerPanel = panelSearch?.enabled === true ? Math.max(0, panelSearch.maxSearchesPerPanel ?? 1) : 0;
    const uncappedSearchCalls = panelSize * maxPerPanel;
    const searchCalls = panelSearch?.enabled === true ? Math.min(uncappedSearchCalls, Math.max(0, panelSearch.maxTotalSearches ?? uncappedSearchCalls)) : 0;
    const baseGenerate = panelSize;
    const multiround = config.modelMixing?.fusion?.multiround;
    if (multiround?.enabled === true) {
      const maxRounds = Math.max(0, multiround.maxRounds ?? 2);
      const branchFactor = Math.max(1, multiround.branchFactor ?? 2);
      const refineCalls = maxRounds * branchFactor;
      const scoreCalls = maxRounds;
      const synthesizeCalls = 1;
      const uncappedAnswerCalls = baseGenerate + 1 + scoreCalls + refineCalls + synthesizeCalls;
      const budget = Math.max(1, multiround.budgetCalls ?? 12);
      const calls = Math.min(uncappedAnswerCalls, budget);
      return {
        mode: "fusion",
        calls,
        searchCalls,
        detail: `generate=${baseGenerate} judge=1 score=${scoreCalls} refine=${refineCalls} synthesize=${synthesizeCalls} searchCalls=${searchCalls} maxTotalSearches=${Math.max(0, panelSearch?.maxTotalSearches ?? uncappedSearchCalls)} budgetCalls=${budget} worstCaseAnswerCalls=${uncappedAnswerCalls}`,
      };
    }
    return { mode: "fusion", calls: panelSize + 2, searchCalls, detail: `panel=${panelSize} judge=1 synthesizer=1 searchCalls=${searchCalls}` };
  }

  if (combine === "pipeline") {
    const stages = countPipelineStages(config);
    return { mode: "pipeline", calls: stages, searchCalls: 0, detail: `stages=${stages}` };
  }

  const isRules = cfg?.mode === "rules";
  const calls = isRules ? 1 : 2;
  return { mode: "route", calls, searchCalls: 0, detail: isRules ? "rules-target=1" : "coordinator=1 routed=1" };
}
