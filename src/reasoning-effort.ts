import type { FrogProviderConfig } from "./types";
import { modelInList } from "./types";

export const CLAUDE_REASONING_LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extended reasoning for the hardest problems" },
];

const CODEX_REASONING_ORDER = CLAUDE_REASONING_LEVELS.map(l => l.effort);
const CODEX_REASONING_SET = new Set(CODEX_REASONING_ORDER);

export function modelRecordValue<T>(record: Record<string, T> | undefined, modelId: string): T | undefined {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const family = modelId.slice(0, colon);
    if (Object.prototype.hasOwnProperty.call(record, family)) return record[family];
  }
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

export function sanitizeClaudeCodeReasoningEfforts(efforts: readonly string[] | undefined): string[] | undefined {
  if (efforts === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const effort of efforts) {
    if (!CODEX_REASONING_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out.sort((a, b) => CODEX_REASONING_ORDER.indexOf(a) - CODEX_REASONING_ORDER.indexOf(b));
}

/**
 * Provider/model configured reasoning levels for the Claude Code catalog. `undefined` means “no override”,
 * while an empty array means “intentionally expose no effort control for this model”.
 */
export function configuredReasoningEfforts(provider: FrogProviderConfig, modelId: string): string[] | undefined {
  if (modelInList(provider.noReasoningModels, modelId)) return [];
  const modelEfforts = modelRecordValue(provider.modelReasoningEfforts, modelId);
  if (modelEfforts !== undefined) return sanitizeClaudeCodeReasoningEfforts(modelEfforts) ?? [];
  if (provider.reasoningEfforts !== undefined) return sanitizeClaudeCodeReasoningEfforts(provider.reasoningEfforts) ?? [];
  return undefined;
}

function requestToClaudeCodeEffort(requested: string): string | undefined {
  if (requested === "none") return undefined;
  if (requested === "minimal") return "low";
  if (requested === "max") return "xhigh";
  return CODEX_REASONING_SET.has(requested) ? requested : undefined;
}

function clampToSupportedClaudeCodeEffort(requested: string, supported: readonly string[]): string | undefined {
  if (supported.length === 0) return undefined;
  const claude = requestToClaudeCodeEffort(requested);
  if (!claude) return undefined;
  if (supported.includes(claude)) return claude;

  const requestedRank = CODEX_REASONING_ORDER.indexOf(claude);
  let best = supported[0];
  let bestRank = CODEX_REASONING_ORDER.indexOf(best);
  for (const effort of supported) {
    const rank = CODEX_REASONING_ORDER.indexOf(effort);
    if (rank <= requestedRank && rank >= bestRank) {
      best = effort;
      bestRank = rank;
    }
  }
  // If every supported tier is above the requested tier, choose the lowest supported tier.
  return best;
}

export function reasoningEffortMapFor(provider: FrogProviderConfig, modelId: string): Record<string, string> | undefined {
  return modelRecordValue(provider.modelReasoningEffortMap, modelId) ?? provider.reasoningEffortMap;
}

/**
 * Translate Claude Code's reasoning label into the provider's real wire value. The Claude Code catalog must only
 * advertise labels Claude Code itself accepts (`low`/`medium`/`high`/`xhigh`), but some upstreams use
 * different values (`max`) or a smaller subset (`low`/`medium`/`high`).
 */
export function mapReasoningEffort(provider: FrogProviderConfig, modelId: string, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  if (modelInList(provider.noReasoningModels, modelId)) return undefined;

  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, requested)) return wireMap[requested];

  const supported = configuredReasoningEfforts(provider, modelId);
  const claudeEffort = supported !== undefined ? clampToSupportedClaudeCodeEffort(requested, supported) : requestToClaudeCodeEffort(requested);
  if (!claudeEffort) return undefined;

  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, claudeEffort)) return wireMap[claudeEffort];
  return claudeEffort;
}
