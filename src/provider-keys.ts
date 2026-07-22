import { resolveEnvValue } from "./config";
import { maskSecretForDisplay } from "./provider-redaction";
import type { FrogProviderConfig } from "./types";

export interface EffectiveKeyCandidate {
  index: number;
  key: string;
}

export interface RedactedKeyCandidateMetadata {
  index: number;
  masked: string;
}


export function effectiveKeyCandidates(provider: FrogProviderConfig): EffectiveKeyCandidate[] {
  if (provider.authMode === "forward" || provider.authMode === "oauth" || provider.authMode === "claude-grant") return [];

  const rawCandidates = [provider.apiKey, ...(provider.apiKeys ?? [])];
  const seen = new Set<string>();
  const candidates: EffectiveKeyCandidate[] = [];
  for (const raw of rawCandidates) {
    const key = resolveEnvValue(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ index: candidates.length, key });
  }
  return candidates;
}

export function redactedKeyCandidateMetadata(provider: FrogProviderConfig): RedactedKeyCandidateMetadata[] {
  return effectiveKeyCandidates(provider).map(candidate => ({
    index: candidate.index,
    masked: maskSecretForDisplay(candidate.key) ?? "...",
  }));
}
