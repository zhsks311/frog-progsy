import { providerKnownModels } from "../classifier-settings";
import type { FrogConfig, FrogModelMixingConfig } from "../types";
import { mixAliasId } from "./select";
import { computeCallPlan } from "./orchestrate";

export interface ModelMixingProviderOption {
  name: string;
  defaultModel: string;
  models: string[];
  authMode: "key" | "forward" | "oauth" | "claude-grant" | "none";
  adapter: string;
  claudeGrantId?: string;
}

export interface ModelMixingCatalogAliasStatus {
  aliasId: string;
  namespaced: boolean;
  provider: string;
  id: string;
  exposed: boolean;
  disabled: boolean;
  hiddenPolicy: "alias-id-specific";
}

export const MIX_EVIDENCE = {
  candidate: "f3-codex",
  baseline: "baseline-gpt55",
  candidateLabel: "f3-codex",
  baselineLabel: "codex/gpt-5.5",
  qualityDelta: 0.13333333333333341,
  qualityDeltaCi95: [0.05833333333333335, 0.20000000000000018],
  passesPrimaryGate: true,
  latencyWallClockMs: { p50: 28766, p95: 219457 },
} as const;

export const MIX_PRESETS = [
  {
    id: "low",
    label: "Low",
    description: "2-panel fusion, task context, no panel web-search, no multiround.",
    modelMixing: {
      combine: "fusion",
      agents: [
        { provider: "codex", model: "gpt-5.5" },
        { provider: "codex", model: "gpt-5.4-mini" },
      ],
      fusion: {
        contextMode: "task",
        judgeContextMode: "task",
        panelWebSearch: { enabled: false },
        multiround: { enabled: false },
      },
    },
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "3-panel fusion, fuller context tradeoff, no panel web-search, no multiround.",
    modelMixing: {
      combine: "fusion",
      agents: [
        { provider: "codex", model: "gpt-5.5" },
        { provider: "codex", model: "gpt-5.4" },
        { provider: "codex", model: "gpt-5.4-mini" },
      ],
      fusion: {
        contextMode: "full",
        judgeContextMode: "task",
        panelWebSearch: { enabled: false },
        multiround: { enabled: false },
      },
    },
  },
  {
    id: "research",
    label: "Research/F3",
    description: "F3 accepted profile with full panel/judge context, panel web-search, and bounded multiround.",
    modelMixing: {
      combine: "fusion",
      agents: [
        { provider: "codex", model: "gpt-5.5" },
        { provider: "codex", model: "gpt-5.4" },
        { provider: "codex", model: "gpt-5.4-mini" },
      ],
      fusion: {
        judge: { provider: "codex", model: "gpt-5.5" },
        synthesizer: { provider: "codex", model: "gpt-5.5" },
        contextMode: "full",
        judgeContextMode: "full",
        panelWebSearch: {
          enabled: true,
          maxSearchesPerPanel: 1,
          maxTotalSearches: 4,
          timeoutMs: 10000,
          tiers: ["no_key"],
        },
        multiround: {
          enabled: true,
          maxRounds: 2,
          branchFactor: 2,
          budgetCalls: 12,
        },
      },
      stageTimeoutMs: 60000,
      panelTimeoutMs: 60000,
    },
  },
] as const;

type ModelMixingPresetCallPlan = Pick<ReturnType<typeof computeCallPlan>, "calls" | "searchCalls">;
type ModelMixingPresetSnapshot = (typeof MIX_PRESETS)[number] & { callPlan: ModelMixingPresetCallPlan };

export interface ModelMixingSettingsSnapshot {
  modelMixing: FrogModelMixingConfig;
  providers: ModelMixingProviderOption[];
  catalogAlias: ModelMixingCatalogAliasStatus;
  presets: ModelMixingPresetSnapshot[];
  evidence: typeof MIX_EVIDENCE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsafeMergeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function mergePreservingObjects(existing: unknown, patch: unknown, warnings: string[], path: string): unknown {
  if (!isRecord(patch)) return cloneJson(patch);
  const out: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(patch)) {
    const childPath = `${path}.${key}`;
    if (isUnsafeMergeKey(key)) {
      warnings.push(`${childPath} ignored: unsafe key`);
      continue;
    }
    out[key] = mergePreservingObjects(out[key], value, warnings, childPath);
  }
  return out;
}

export function normalizedModelMixing(config: FrogConfig): FrogModelMixingConfig {
  const current = cloneJson(config.modelMixing ?? {});
  return {
    ...current,
    enabled: current.enabled ?? false,
    aliasId: mixAliasId(current),
    mode: current.mode ?? "coordinator",
    combine: current.combine ?? "route",
    agents: Array.isArray(current.agents) ? current.agents : [],
    fusion: isRecord(current.fusion) ? current.fusion : {},
  };
}

export function modelMixingCatalogAliasStatus(config: FrogConfig): ModelMixingCatalogAliasStatus {
  const aliasId = mixAliasId(config.modelMixing);
  const slash = aliasId.indexOf("/");
  const namespaced = slash > 0 && slash < aliasId.length - 1;
  const provider = namespaced ? aliasId.slice(0, slash) : "";
  const id = namespaced ? aliasId.slice(slash + 1) : "";
  const exposed = config.modelMixing?.enabled === true && namespaced;
  return {
    aliasId,
    namespaced,
    provider,
    id,
    exposed,
    disabled: namespaced ? new Set(config.disabledModels ?? []).has(aliasId) : false,
    hiddenPolicy: "alias-id-specific",
  };
}

function computePresetCallPlan(config: FrogConfig, modelMixing: (typeof MIX_PRESETS)[number]["modelMixing"]): ModelMixingPresetCallPlan {
  const presetModelMixing = cloneJson(modelMixing) as unknown as FrogModelMixingConfig;
  const effectiveConfig = {
    ...config,
    modelMixing: {
      ...cloneJson(config.modelMixing ?? {}),
      ...presetModelMixing,
    },
  } as FrogConfig;
  const { calls, searchCalls } = computeCallPlan(effectiveConfig);
  return { calls, searchCalls };
}

export function modelMixingSettingsSnapshot(config: FrogConfig): ModelMixingSettingsSnapshot {
  return {
    modelMixing: normalizedModelMixing(config),
    providers: Object.keys(config.providers).map(name => {
      const prov = config.providers[name]!;
      return {
        name,
        defaultModel: prov.defaultModel ?? "",
        models: providerKnownModels(prov),
        authMode: prov.authMode ?? (prov.apiKey || prov.apiKeys?.length ? "key" : "none"),
        adapter: prov.adapter,
        ...(prov.authMode === "claude-grant" && prov.claudeGrantId
          ? { claudeGrantId: prov.claudeGrantId }
          : {}),
      };
    }),
    catalogAlias: modelMixingCatalogAliasStatus(config),
    presets: MIX_PRESETS.map(preset => ({
      ...preset,
      callPlan: computePresetCallPlan(config, preset.modelMixing),
    })),
    evidence: MIX_EVIDENCE,
  };
}

const COMBINES = new Set(["route", "pipeline", "fusion"]);
const MODES = new Set(["coordinator", "rules"]);
const CONTEXT_MODES = new Set(["task", "full"]);
const WEB_SEARCH_TIERS = new Set(["fallback_model", "search_api", "no_key"]);

function assignString(target: Record<string, unknown>, key: string, value: unknown, warnings: string[]): void {
  if (typeof value === "string") target[key] = value.trim();
  else warnings.push(`modelMixing.${key} ignored: expected string`);
}

function assignBoolean(target: Record<string, unknown>, key: string, value: unknown, warnings: string[], path = `modelMixing.${key}`): void {
  if (typeof value === "boolean") target[key] = value;
  else warnings.push(`${path} ignored: expected boolean`);
}

function assignNumber(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  warnings: string[],
  path = `modelMixing.${key}`,
  validate: (value: number) => boolean = Number.isFinite,
  expectation = "expected finite number",
): void {
  if (typeof value === "number" && Number.isFinite(value) && validate(value)) target[key] = value;
  else warnings.push(`${path} ignored: ${expectation}`);
}

function assignPositiveNumber(target: Record<string, unknown>, key: string, value: unknown, warnings: string[], path = `modelMixing.${key}`): void {
  assignNumber(target, key, value, warnings, path, n => n > 0, "expected positive number");
}

function assignNonNegativeInteger(target: Record<string, unknown>, key: string, value: unknown, warnings: string[], path = `modelMixing.${key}`): void {
  assignNumber(target, key, value, warnings, path, n => Number.isInteger(n) && n >= 0, "expected non-negative integer");
}

function assignPositiveInteger(target: Record<string, unknown>, key: string, value: unknown, warnings: string[], path = `modelMixing.${key}`): void {
  assignNumber(target, key, value, warnings, path, n => Number.isInteger(n) && n > 0, "expected positive integer");
}

function assignProviderModel(target: Record<string, unknown>, key: string, value: unknown, warnings: string[], path: string): void {
  if (!isRecord(value)) {
    warnings.push(`${path} ignored: expected object`);
    return;
  }
  const out = { ...(isRecord(target[key]) ? target[key] as Record<string, unknown> : {}) };
  if ("provider" in value) assignString(out, "provider", value.provider, warnings);
  if ("model" in value) assignString(out, "model", value.model, warnings);
  target[key] = out;
}

function warnUnknownModels(config: FrogConfig, warnings: string[], value: unknown, path: string): void {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!provider || !model) continue;
    const prov = config.providers[provider];
    if (!prov) {
      warnings.push(`${path} provider "${provider}" not found in config`);
      continue;
    }
    const known = providerKnownModels(prov);
    if (known.length > 0 && !known.includes(model)) warnings.push(`${path} model "${model}" is not in the known models list for provider "${provider}"`);
  }
}

function mergeFusion(config: FrogConfig, target: Record<string, unknown>, patch: unknown, warnings: string[]): void {
  if (!isRecord(patch)) {
    warnings.push("modelMixing.fusion ignored: expected object");
    return;
  }
  const out = { ...(isRecord(target.fusion) ? target.fusion as Record<string, unknown> : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (isUnsafeMergeKey(key)) {
      warnings.push(`modelMixing.fusion.${key} ignored: unsafe key`);
      continue;
    }
    if (key === "panel") {
      if (Array.isArray(value)) {
        out.panel = cloneJson(value);
        warnUnknownModels(config, warnings, value, "modelMixing.fusion.panel");
      } else warnings.push("modelMixing.fusion.panel ignored: expected array");
    } else if (key === "judge" || key === "synthesizer") {
      assignProviderModel(out, key, value, warnings, `modelMixing.fusion.${key}`);
      warnUnknownModels(config, warnings, value, `modelMixing.fusion.${key}`);
    } else if (key === "contextMode" || key === "judgeContextMode") {
      if (typeof value === "string" && CONTEXT_MODES.has(value)) out[key] = value;
      else warnings.push(`modelMixing.fusion.${key} ignored: expected task or full`);
    } else if (key === "panelWebSearch") {
      if (!isRecord(value)) {
        warnings.push("modelMixing.fusion.panelWebSearch ignored: expected object");
      } else {
        const web = { ...(isRecord(out.panelWebSearch) ? out.panelWebSearch as Record<string, unknown> : {}) };
        for (const [wk, wv] of Object.entries(value)) {
          if (isUnsafeMergeKey(wk)) {
            warnings.push(`modelMixing.fusion.panelWebSearch.${wk} ignored: unsafe key`);
            continue;
          }
          if (wk === "enabled") assignBoolean(web, wk, wv, warnings, `modelMixing.fusion.panelWebSearch.${wk}`);
          else if (wk === "maxSearchesPerPanel" || wk === "maxTotalSearches") assignNonNegativeInteger(web, wk, wv, warnings, `modelMixing.fusion.panelWebSearch.${wk}`);
          else if (wk === "timeoutMs") assignPositiveNumber(web, wk, wv, warnings, `modelMixing.fusion.panelWebSearch.${wk}`);
          else if (wk === "tiers") {
            if (Array.isArray(wv) && wv.every(t => typeof t === "string" && WEB_SEARCH_TIERS.has(t))) web.tiers = [...wv];
            else warnings.push("modelMixing.fusion.panelWebSearch.tiers ignored: expected known tier strings");
          } else web[wk] = mergePreservingObjects(web[wk], wv, warnings, `modelMixing.fusion.panelWebSearch.${wk}`);
        }
        out.panelWebSearch = web;
      }
    } else if (key === "multiround") {
      if (!isRecord(value)) {
        warnings.push("modelMixing.fusion.multiround ignored: expected object");
      } else {
        const multi = { ...(isRecord(out.multiround) ? out.multiround as Record<string, unknown> : {}) };
        for (const [mk, mv] of Object.entries(value)) {
          if (isUnsafeMergeKey(mk)) {
            warnings.push(`modelMixing.fusion.multiround.${mk} ignored: unsafe key`);
            continue;
          }
          if (mk === "enabled") assignBoolean(multi, mk, mv, warnings, `modelMixing.fusion.multiround.${mk}`);
          else if (mk === "maxRounds") assignNonNegativeInteger(multi, mk, mv, warnings, `modelMixing.fusion.multiround.${mk}`);
          else if (mk === "branchFactor" || mk === "budgetCalls") assignPositiveInteger(multi, mk, mv, warnings, `modelMixing.fusion.multiround.${mk}`);
          else multi[mk] = mergePreservingObjects(multi[mk], mv, warnings, `modelMixing.fusion.multiround.${mk}`);
        }
        out.multiround = multi;
      }
    } else {
      out[key] = mergePreservingObjects(out[key], value, warnings, `modelMixing.fusion.${key}`);
    }
  }
  target.fusion = out;
}

export function applyModelMixingPatch(config: FrogConfig, patch: unknown): string[] {
  const warnings: string[] = [];
  if (!isRecord(patch)) {
    warnings.push("modelMixing ignored: expected object");
    return warnings;
  }
  const current = { ...(isRecord(config.modelMixing) ? config.modelMixing as Record<string, unknown> : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (isUnsafeMergeKey(key)) {
      warnings.push(`modelMixing.${key} ignored: unsafe key`);
      continue;
    }
    if (key === "enabled") assignBoolean(current, key, value, warnings);
    else if (key === "aliasId" || key === "guidance") assignString(current, key, value, warnings);
    else if (key === "mode") {
      if (typeof value === "string" && MODES.has(value)) current.mode = value;
      else warnings.push("modelMixing.mode ignored: expected coordinator or rules");
    } else if (key === "combine") {
      if (typeof value === "string" && COMBINES.has(value)) current.combine = value;
      else warnings.push("modelMixing.combine ignored: expected route, pipeline, or fusion");
    } else if (key === "coordinator") {
      assignProviderModel(current, key, value, warnings, "modelMixing.coordinator");
      warnUnknownModels(config, warnings, value, "modelMixing.coordinator");
    } else if (key === "agents" || key === "pipeline" || key === "rules") {
      if (Array.isArray(value)) {
        current[key] = cloneJson(value);
        if (key === "agents" || key === "pipeline") warnUnknownModels(config, warnings, value, `modelMixing.${key}`);
      } else warnings.push(`modelMixing.${key} ignored: expected array`);
    } else if (key === "fusion") {
      mergeFusion(config, current, value, warnings);
    } else if (key === "timeoutMs" || key === "stageTimeoutMs" || key === "panelTimeoutMs") {
      assignPositiveNumber(current, key, value, warnings);
    } else if (key === "surfaceStages") {
      assignBoolean(current, key, value, warnings);
    } else {
      current[key] = mergePreservingObjects(current[key], value, warnings, `modelMixing.${key}`);
    }
  }
  config.modelMixing = current as FrogModelMixingConfig;
  return warnings;
}
