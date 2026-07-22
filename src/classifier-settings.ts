import type { FrogConfig, FrogProviderConfig } from "./types";

export interface ClassifierProviderOption {
  name: string;
  classifierModel: string;
  models: string[];
}

export interface ClassifierSettingsSnapshot {
  providers: ClassifierProviderOption[];
  classifierFallback: { provider: string; model: string };
}

/** Sorted unique model list for a single provider (defaultModel + models[]). */
export function providerKnownModels(prov: FrogProviderConfig): string[] {
  const set = new Set<string>();
  if (prov.defaultModel) set.add(prov.defaultModel);
  for (const m of prov.models ?? []) set.add(m);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Returns a human-readable warning string when `model` is non-empty and not in
 * the provider's known model list (defaultModel + models[]). Returns null when
 * the model is valid, empty, or the provider has no known-model list to validate against.
 * Never throws.
 */
export function validateClassifierModel(
  config: FrogConfig,
  providerName: string,
  model: string,
): string | null {
  if (!model) return null;
  const prov = config.providers[providerName];
  if (!prov) return null;
  const known = providerKnownModels(prov);
  if (known.length === 0) return null; // no list to validate against
  if (known.includes(model)) return null;
  const preview = known.slice(0, 5).join(", ");
  const ellipsis = known.length > 5 ? "…" : "";
  return `classifier model "${model}" is not in the known models list for provider "${providerName}" (${preview}${ellipsis})`;
}

/** Build the classifier settings snapshot for GET /api/classifier-settings. */
export function classifierSettingsSnapshot(config: FrogConfig): ClassifierSettingsSnapshot {
  const providers: ClassifierProviderOption[] = Object.keys(config.providers).map(name => {
    const prov = config.providers[name]!;
    return {
      name,
      classifierModel: prov.classifierModel ?? "",
      models: providerKnownModels(prov),
    };
  });
  return {
    providers,
    classifierFallback: {
      provider: config.classifierFallback?.provider ?? "",
      model: config.classifierFallback?.model ?? "",
    },
  };
}
