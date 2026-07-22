import type { AdapterEvent, FrogConfig, FrogMessage, FrogParsedRequest, FrogTool } from "../types";
import { executeSearchEvidence as defaultExecuteSearchEvidence, type PanelSearchTier, type SearchEvidence } from "../web-search-fallback/panel-search";
import { buildWebSearchTool, WEB_SEARCH_TOOL_NAME } from "../web-search-fallback/synthetic-tool";
import type { MixTarget } from "./index";
import { buildJudgePrompt, buildPanelPrompt, buildRefinePrompt, buildScorePrompt, buildSynthesisPrompt, parseJudgeAnalysis, resolveFusionPlan, type JudgeAnalysis } from "./fusion";
import { buildStagePrompt, buildVerifierInstruction, resolvePipelineStages } from "./pipeline";
import { scanEventsForMix } from "./scan";
import { extractTaskText, validMixAgents } from "./select";

export interface MixLoopDeps {
  config: FrogConfig;
  parsed: FrogParsedRequest;
  incomingHeaders: Headers;
  abortSignal?: AbortSignal;

  /** Buffered (non-streaming) dispatch to one panel/judge target; returns the full adapter event list. */
  dispatchBuffered: (target: MixTarget, messages: FrogMessage[], maxTokens: number, timeoutMs?: number, tools?: FrogTool[]) => Promise<AdapterEvent[]>;
  /** Streamed dispatch to the synthesizer: the original request context plus an appended instruction. */
  dispatchFinalStream: (target: MixTarget, systemAppend: string) => Promise<AsyncGenerator<AdapterEvent>>;
  /** Test seam for panel synthetic web_search evidence; production uses executeSearchEvidence. */
  executeSearchEvidence?: typeof defaultExecuteSearchEvidence;
}

function concatText(events: AdapterEvent[]): string {
  let text = "";
  for (const e of events) if (e.type === "text_delta") text += e.text;
  return text;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface WebSearchCall {
  id: string;
  query: string;
}

function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function webSearchCalls(events: AdapterEvent[]): WebSearchCall[] {
  const calls: WebSearchCall[] = [];
  let current: { id: string; name: string; args: string } | undefined;
  for (const event of events) {
    if (event.type === "tool_call_start") {
      current = { id: event.id, name: event.name, args: "" };
    } else if (event.type === "tool_call_delta" && current) {
      current.args += event.arguments;
    } else if (event.type === "tool_call_end" && current) {
      if (current.name === WEB_SEARCH_TOOL_NAME) {
        const args = parseToolArguments(current.args);
        const query = typeof args.query === "string" ? args.query.trim() : "";
        calls.push({ id: current.id, query });
      }
      current = undefined;
    }
  }
  return calls;
}

function syntheticToolCallMessage(call: WebSearchCall, timestamp: number): FrogMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: call.id, name: WEB_SEARCH_TOOL_NAME, arguments: { query: call.query } }],
    timestamp,
  };
}

function syntheticToolResultMessage(call: WebSearchCall, evidence: SearchEvidence, timestamp: number): FrogMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: WEB_SEARCH_TOOL_NAME,
    content: evidence.text,
    isError: evidence.evidence.coverage === "insufficient",
    timestamp,
  };
}

function cappedSearchEvidence(query: string, reason: string): SearchEvidence {
  return {
    text: `Web search for "${query}" was not run (${reason}). Answer from your own knowledge and note that it may be out of date.`,
    sources: [],
    evidence: { coverage: "insufficient", sourceCount: 0, citationCount: 0, insufficientReason: reason },
    tier: "unavailable",
    skippedReasonCodes: [reason],
    latencyMs: 0,
  };
}

function bestCandidateLabel(analysis: JudgeAnalysis | null, candidates: { label: string; text: string }[]): string | undefined {
  if (!analysis || candidates.length === 0) return candidates[0]?.label;
  const labels = new Set(candidates.map(c => c.label));
  const explicit = analysis.consensus
    .map(item => item.point.match(/^BEST_CANDIDATE:\s*(.+)$/i)?.[1]?.trim())
    .find(label => label && labels.has(label));
  if (explicit) return explicit;

  const score = new Map(candidates.map(c => [c.label, 0]));
  for (const item of analysis.consensus) for (const label of item.supportingModels) score.set(label, (score.get(label) ?? 0) + 2);
  for (const item of analysis.uniqueInsights) score.set(item.model, (score.get(item.model) ?? 0) + 1);
  for (const item of analysis.contradictions) for (const pos of item.positions) score.set(pos.model, (score.get(pos.model) ?? 0) - 1);
  return candidates
    .map(c => ({ label: c.label, score: score.get(c.label) ?? 0 }))
    .sort((a, b) => b.score - a.score)[0]?.label;
}

function refineInstruction(round: number, variant: number): string {
  const styles = [
    "Strengthen the core reasoning and make hidden assumptions explicit.",
    "Look for edge cases, counterexamples, and missing constraints before answering.",
    "Compress weak sections and prioritize the most decision-relevant facts.",
    "Re-derive the answer independently, preserving only claims you can justify.",
  ];
  return `round ${round}, variant ${variant}: ${styles[(round + variant - 2) % styles.length]}`;
}

/**
 * Fusion orchestration (stage-05-revision.md §2-3): dispatch an independent panel in parallel, have a
 * judge analyze their answers, then stream a synthesizer's final answer against the real request
 * context (+ the judge analysis / raw panel answers appended as an instruction). Intermediate stages
 * are optionally surfaced as `thinking_delta` events so Claude Code shows fusion progress live.
 */
export async function runWithMixing(deps: MixLoopDeps): Promise<AsyncGenerator<AdapterEvent>> {
  const { config, parsed } = deps;
  const combine = config.modelMixing?.combine;
  if (combine !== "fusion" && combine !== "pipeline") {
    throw new Error("runWithMixing: only combine=\"fusion\"|\"pipeline\" is implemented");
  }

  const taskText = extractTaskText(parsed);
  const guidance = config.modelMixing?.guidance;
  const surfaceStages = config.modelMixing?.surfaceStages !== false;

  async function* mixedEvents(): AsyncGenerator<AdapterEvent> {
    if (combine === "fusion") {
      const plan = resolveFusionPlan(config);
      for (const w of plan.warnings) console.error(`frogprogsy: model-mixing: ${w}`);

      const panelContextMode = config.modelMixing?.fusion?.contextMode ?? "task";
      const judgeContextMode = config.modelMixing?.fusion?.judgeContextMode ?? "task";
      const panelSearchConfig = config.modelMixing?.fusion?.panelWebSearch;
      const panelSearchEnabled = panelSearchConfig?.enabled === true;
      const panelSearchTools = panelSearchEnabled ? [buildWebSearchTool()] : undefined;
      const configuredPanelSearchTiers = panelSearchConfig?.tiers ?? ["fallback_model", "search_api", "no_key"];
      const panelSearchTiers = configuredPanelSearchTiers
        .filter((tier): tier is PanelSearchTier => tier === "fallback_model" || tier === "search_api" || tier === "no_key");
      const removedPanelSearchTiers = configuredPanelSearchTiers.filter(tier => !panelSearchTiers.includes(tier as PanelSearchTier));
      if (panelSearchEnabled && removedPanelSearchTiers.length > 0) {
        console.error(
          `frogprogsy: model-mixing: panelWebSearch.tiers removed unsupported tier(s): ${removedPanelSearchTiers.map(String).join(", ")}; supported tiers are fallback_model, search_api, no_key`,
        );
      }
      const maxSearchesPerPanel = Math.max(0, panelSearchConfig?.maxSearchesPerPanel ?? 1);
      const maxTotalSearches = Math.max(0, panelSearchConfig?.maxTotalSearches ?? plan.panel.length * maxSearchesPerPanel);
      let totalSearches = 0;
      const searchCache = new Map<string, SearchEvidence>();
      const multiroundConfig = config.modelMixing?.fusion?.multiround;
      const multiroundEnabled = multiroundConfig?.enabled === true;
      const maxRounds = Math.max(0, multiroundConfig?.maxRounds ?? 2);
      const branchFactor = Math.max(1, multiroundConfig?.branchFactor ?? 2);
      const budgetCalls = Math.max(1, multiroundConfig?.budgetCalls ?? 12);
      let budgetUsed = 0;
      let budgetFallback = false;

      function canSpend(calls: number, stage: string): boolean {
        if (!multiroundEnabled) return true;
        if (budgetUsed + calls <= budgetCalls) return true;
        budgetFallback = true;
        console.error(
          `frogprogsy: model-mixing: multiround budgetCalls exceeded before ${stage}; used=${budgetUsed} requested=${calls} budget=${budgetCalls}; loud fallback to current best candidate`,
        );
        return false;
      }

      async function dispatchPanelWithSearch(target: MixTarget): Promise<AdapterEvent[]> {
        let messages = buildPanelPrompt(taskText, guidance, { contextMode: panelContextMode, context: parsed.context });
        let events = await deps.dispatchBuffered(target, messages, 2048, config.modelMixing?.panelTimeoutMs, panelSearchTools);
        if (!panelSearchEnabled) return events;

        let panelSearches = 0;
        for (;;) {
          const calls = webSearchCalls(events);
          if (calls.length === 0) return events;

          for (const call of calls) {
            const normalized = normalizeSearchQuery(call.query);
            let evidence = normalized ? searchCache.get(normalized) : undefined;
            if (!evidence) {
              if (!normalized) {
                evidence = cappedSearchEvidence(call.query, "empty_query");
              } else if (panelSearches >= maxSearchesPerPanel) {
                evidence = cappedSearchEvidence(call.query, "max_searches_per_panel_exceeded");
              } else if (totalSearches >= maxTotalSearches) {
                evidence = cappedSearchEvidence(call.query, "max_total_searches_exceeded");
              } else {
                panelSearches++;
                totalSearches++;
                evidence = await (deps.executeSearchEvidence ?? defaultExecuteSearchEvidence)({
                  query: call.query,
                  config,
                  incomingHeaders: deps.incomingHeaders,
                  allowedTiers: panelSearchTiers,
                  timeoutMs: panelSearchConfig?.timeoutMs,
                  abortSignal: deps.abortSignal,
                });
                // Loud, greppable search accounting: the plan's M2 gate requires search count and
                // latency to be reportable separately, and the eval harness counts these markers.
                console.error(
                  `frogprogsy: model-mixing: panel web_search #${totalSearches} (${target.provider}/${target.model}) tier=${evidence.tier} sources=${evidence.sources.length} latencyMs=${evidence.latencyMs} query=${JSON.stringify(truncate(call.query, 120))}`,
                );
                searchCache.set(normalized, evidence);
              }
            }
            messages = [
              ...messages,
              syntheticToolCallMessage(call, Date.now()),
              syntheticToolResultMessage(call, evidence, Date.now()),
            ];
          }

          events = await deps.dispatchBuffered(target, messages, 2048, config.modelMixing?.panelTimeoutMs, panelSearchTools);
        }
      }

      const panelTargets = multiroundEnabled ? plan.panel.slice(0, Math.max(0, budgetCalls - 1)) : plan.panel;
      if (multiroundEnabled && panelTargets.length < plan.panel.length) {
        console.error(
          `frogprogsy: model-mixing: multiround budgetCalls capped initial panel from ${plan.panel.length} to ${panelTargets.length}; budget=${budgetCalls}; loud fallback to bounded branch set`,
        );
      }

      // (a) Panel: dispatch every roster member in parallel; survivors proceed, failures are dropped.
      const settled = await Promise.allSettled(panelTargets.map(m => dispatchPanelWithSearch(m)));
      const panelAnswers: { label: string; text: string }[] = [];
      for (let i = 0; i < settled.length; i++) {
        const m = panelTargets[i];
        const label = `${m.provider}/${m.model}`;
        const result = settled[i];
        if (result.status === "rejected") {
          console.error(`frogprogsy: model-mixing: panel model ${label} failed (${result.reason}); proceeding with survivors`);
          continue;
        }
        const text = concatText(result.value);
        panelAnswers.push({ label, text });
        if (surfaceStages) {
          yield { type: "thinking_delta", thinking: `[panel ${label}]\n${truncate(text, 1500)}\n\n` };
        }
      }
      budgetUsed += multiroundEnabled ? panelTargets.length : 0;

      // (b) All panel members failed: synthesize straight from the raw task, no judge.
      let analysis = null as ReturnType<typeof parseJudgeAnalysis>;
      if (panelAnswers.length === 0) {
        console.error("frogprogsy: model-mixing: all panel models failed; synthesizing from raw task");
      } else {
        // (c) Judge: analyze the surviving panel answers.
        let judgeText = "";
        try {
          if (canSpend(1, "judge")) {
            budgetUsed += multiroundEnabled ? 1 : 0;
            judgeText = concatText(
              await deps.dispatchBuffered(
                plan.judge,
                buildJudgePrompt(taskText, panelAnswers, { contextMode: judgeContextMode, context: parsed.context }),
                4096,
              ),
            );
            analysis = parseJudgeAnalysis(judgeText);
            if (!analysis) {
              console.error("frogprogsy: model-mixing: judge analysis invalid; synthesizing from raw panel answers");
            }
          }
        } catch (err) {
          console.error(`frogprogsy: model-mixing: judge dispatch failed (${err}); synthesizing from raw panel answers`);
          analysis = null;
        }
        if (surfaceStages) {
          yield { type: "thinking_delta", thinking: `[judge]\n${truncate(analysis ? JSON.stringify(analysis) : judgeText, 1500)}\n\n` };
        }
        if (multiroundEnabled && panelAnswers.length > 1) {
          const initialBestLabel = bestCandidateLabel(analysis, panelAnswers);
          const initialBest = panelAnswers.find(c => c.label === initialBestLabel);
          if (initialBest) {
            panelAnswers.splice(0, panelAnswers.length, initialBest, ...panelAnswers.filter(c => c.label !== initialBest.label));
          }
        }

        if (multiroundEnabled && !budgetFallback && panelAnswers.length > 0) {
          let candidates = panelAnswers;
          for (let round = 1; round <= maxRounds; round++) {
            if (!canSpend(1 + branchFactor + 1, `round ${round}`)) break;

            let scoreText = "";
            let scoreAnalysis: ReturnType<typeof parseJudgeAnalysis> = null;
            try {
              budgetUsed += 1;
              scoreText = concatText(
                await deps.dispatchBuffered(
                  plan.judge,
                  buildScorePrompt(taskText, candidates, { contextMode: judgeContextMode, context: parsed.context }),
                  4096,
                ),
              );
              scoreAnalysis = parseJudgeAnalysis(scoreText);
              if (!scoreAnalysis) console.error(`frogprogsy: model-mixing: round ${round} score invalid; using previous best`);
            } catch (err) {
              console.error(`frogprogsy: model-mixing: round ${round} score failed (${err}); using previous best`);
            }
            if (surfaceStages) {
              yield { type: "thinking_delta", thinking: `[round ${round} score]\n${truncate(scoreAnalysis ? JSON.stringify(scoreAnalysis) : scoreText, 1500)}\n\n` };
            }

            const bestLabel = bestCandidateLabel(scoreAnalysis ?? analysis, candidates);
            const best = candidates.find(c => c.label === bestLabel) ?? candidates[0];
            if (!best) break;

            const refined = await Promise.allSettled(
              Array.from({ length: branchFactor }, async (_, index) => {
                const variant = index + 1;
                const text = concatText(
                  await deps.dispatchBuffered(
                    plan.synthesizer,
                    buildRefinePrompt(
                      taskText,
                      best,
                      scoreAnalysis ?? analysis,
                      refineInstruction(round, variant),
                      { contextMode: judgeContextMode, context: parsed.context },
                    ),
                    2048,
                  ),
                );
                return { label: `round${round}/refine${variant}`, text };
              }),
            );
            budgetUsed += branchFactor;

            const nextCandidates = [best];
            const surfaced: string[] = [];
            for (const result of refined) {
              if (result.status === "rejected") {
                console.error(`frogprogsy: model-mixing: round ${round} refine failed (${result.reason}); proceeding with survivors`);
                continue;
              }
              nextCandidates.push(result.value);
              surfaced.push(`[${result.value.label}] ${result.value.text}`);
            }
            if (surfaceStages && surfaced.length > 0) {
              yield { type: "thinking_delta", thinking: `[round ${round} refine]\n${truncate(surfaced.join("\n\n"), 1500)}\n\n` };
            }
            candidates = nextCandidates;
            panelAnswers.splice(0, panelAnswers.length, ...candidates);
            analysis = scoreAnalysis ?? analysis;
          }
        }
      }

      // (d) Synthesizer: stream the final answer against the real request context.
      if (multiroundEnabled && !canSpend(1, "synthesizer")) {
        if (panelAnswers.length > 0) {
          yield { type: "text_delta", text: panelAnswers[0].text };
          yield { type: "done" };
          return;
        }
      }
      budgetUsed += multiroundEnabled ? 1 : 0;
      const { instruction } = buildSynthesisPrompt(analysis, panelAnswers);
      try {
        const gen = await deps.dispatchFinalStream(plan.synthesizer, instruction);
        yield* gen;
      } catch (err) {
        console.error(`frogprogsy: model-mixing: synthesis failed (${err instanceof Error ? err.message : String(err)}); falling back`);
        if (panelAnswers.length > 0) {
          yield { type: "text_delta", text: panelAnswers[0].text };
          yield { type: "done" };
        } else {
          yield { type: "error", message: "model-mixing: synthesis failed and no panel answer available" };
        }
      }
    } else if (combine === "pipeline") {
      const { stages, warnings } = resolvePipelineStages(config);
      for (const w of warnings) console.error(`frogprogsy: model-mixing: ${w}`);

      if (stages.length === 0) {
        // No pipeline roster resolved: fall back to a plain final answer from the first valid
        // mixing agent (no buffered stages, no verifier instruction).
        const fallback = validMixAgents(config)[0];
        if (!fallback) {
          yield { type: "error", message: "model-mixing: no pipeline stages resolved and no fallback agent configured" };
          return;
        }
        console.error(`frogprogsy: model-mixing: falling back to plain final answer from ${fallback.provider}/${fallback.model}`);
        try {
          const gen = await deps.dispatchFinalStream({ provider: fallback.provider, model: fallback.model }, "");
          yield* gen;
        } catch (err) {
          yield {
            type: "error",
            message: `model-mixing: pipeline fallback failed (${err instanceof Error ? err.message : String(err)})`,
          };
        }
        return;
      }

      const preFinal = stages.slice(0, -1);
      const final = stages[stages.length - 1];
      const prior: { role: string; text: string }[] = [];

      for (const stage of preFinal) {
        const events = await deps.dispatchBuffered(
          { provider: stage.provider, model: stage.model },
          buildStagePrompt(stage.role, taskText, prior, guidance),
          2048,
        );
        const { forwarded, hasRealToolCall } = scanEventsForMix(events);
        if (hasRealToolCall) {
          console.error(
            `frogprogsy: model-mixing: ${stage.role} emitted a tool call; pipeline finalized early, verifier deferred (stateless proxy cannot force a follow-up turn)`,
          );
          for (const e of forwarded) yield e;
          return;
        }
        const text = concatText(forwarded);
        prior.push({ role: stage.role, text });
        if (surfaceStages) {
          yield { type: "thinking_delta", thinking: `[${stage.role}]\n${truncate(text, 1500)}\n\n` };
        }
      }

      try {
        const gen = await deps.dispatchFinalStream(
          { provider: final.provider, model: final.model },
          buildVerifierInstruction(prior),
        );
        yield* gen;
      } catch (err) {
        console.error(`frogprogsy: model-mixing: verifier failed (${err instanceof Error ? err.message : String(err)}); falling back`);
        const last = prior[prior.length - 1];
        if (last) {
          yield { type: "text_delta", text: last.text };
          yield { type: "done" };
        } else {
          yield { type: "error", message: "model-mixing: verifier failed and no prior stage output available" };
        }
      }
    } else {
      throw new Error(`runWithMixing: unsupported combine mode`);
    }
  }

  return mixedEvents();
}
