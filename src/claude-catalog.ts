import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, ensureConfigDirForWrite, getConfigDir, websocketsEnabled } from "./config";
import { assertSafeClaudeHomeWrite, claudeCatalogPath, claudeConfigTomlPath, claudeModelsCachePath, readRootTomlString, resolveClaudeCodeConfigPath } from "./claude-paths";
import { DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, setCached } from "./model-cache";
import { buildModelsRequest } from "./oauth/index";
import { resolveProviderAuth, type ProviderAuthDeps } from "./provider-auth";
import type { FrogConfig, FrogProviderConfig } from "./types";
import { CLAUDE_REASONING_LEVELS, configuredReasoningEfforts, modelRecordValue, sanitizeClaudeCodeReasoningEfforts } from "./reasoning-effort";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "./generated/jawcode-model-metadata";
import { materializeModelAliases } from "./model-aliases";
import { mixAliasId } from "./model-mixing/select";
import { shouldCaseFoldMetadataModelId } from "./providers/derive";

function catalogBackupPath(profileId?: string): string {
  return profileId ? join(getConfigDir(), "claude-profiles", profileId, "catalog-backup.json") : join(getConfigDir(), "catalog-backup.json");
}

/**
 * Native OpenAI / Claude Code model slugs served through the ChatGPT/Codex OAuth-backed Responses
 * upstream — FALLBACK only. The ChatGPT backend has no `GET /models`, so the real set is read from
 * the live Claude Code catalog (the slugs Claude Code itself ships for the installed version) via
 * nativeOpenAiSlugs(); this static list is used only when no catalog is present. Keep it to ids
 * ChatGPT actually accepts — advertising a phantom (e.g. an old `gpt-5.2`/`gpt-5.3-claude` that a
 * newer Claude Code dropped) makes it 400 "model is not supported".
 */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-claude-spark",
];

/**
 * The native OpenAI slugs to advertise — the LIVE Claude Code catalog's own bare slugs when
 * available (always-latest: matches exactly what the installed Claude Code supports), else the static
 * fallback above. Single source for the /v1/models native list and the subagent-default seed.
 */
export function nativeOpenAiSlugs(): string[] {
  const live = listCatalogNativeSlugs();
  return live.length > 0 ? live : NATIVE_OPENAI_MODELS;
}

export interface CatalogModel { id: string; provider: string; owned_by?: string; reasoningEfforts?: string[]; contextWindow?: number; inputModalities?: string[]; authReady?: boolean; }
type RawEntry = Record<string, unknown>;
const JAWCODE_CATALOG_AUGMENT_PROVIDERS = new Set(["opencode-go"]);

/**
 * Image/video GENERATION model families. frogprogsy routes chat/coding models into Claude Code; media-
 * generation models (Grok image/video, DALL·E, Imagen, Sora, Veo, …) are useless to a coding agent
 * and must never surface in the dashboard, /v1/models, or the routed catalog. The metadata has no
 * output-modality field, so we classify by id. Extend this list as providers add media models.
 */
const MEDIA_GEN_FAMILIES = [
  "dall-e", "dalle", "imagen", "sora", "veo", "flux", "kling",
  "seedance", "hailuo", "stable-diffusion", "sdxl", "midjourney",
];
const MEDIA_GEN_ID_RE = new RegExp(
  `(?:^|[/_-])(?:image|video)(?:[/_-]|$)|(?:^|[/_-])(?:${MEDIA_GEN_FAMILIES.join("|")})(?:[/_-]|$|\\d)`,
  "i",
);

/**
 * True when a model id denotes image/video GENERATION (so it should be hidden everywhere). Vision
 * *input* chat models — `grok-2-vision`, `qwen3-vl-*`, `gpt-4o`, `gemini-3-pro-preview` — are
 * intentionally NOT matched: they carry no `image`/`video` id segment and no generation-family token.
 */
export function isMediaGenerationModelId(id: string): boolean {
  return MEDIA_GEN_ID_RE.test(id);
}

/** Resolve the `model_catalog_json` path from Claude Code config.toml, else the default. */
export function readClaudeCodeCatalogPath(claudeHome?: string): string {
  const configTomlPath = claudeConfigTomlPath(claudeHome);
  try {
    if (existsSync(configTomlPath)) {
      const toml = readFileSync(configTomlPath, "utf-8");
      const path = readRootTomlString(toml, "model_catalog_json");
      if (path) return resolveClaudeCodeConfigPath(path, claudeHome);
    }
  } catch { /* ignore */ }
  return claudeCatalogPath(claudeHome);
}

function readCatalog(path: string): { models?: RawEntry[]; [k: string]: unknown } | null {
  try {
    if (!existsSync(path)) return null;
    const cat = JSON.parse(readFileSync(path, "utf-8"));
    return (cat && Array.isArray(cat.models)) ? cat : null;
  } catch { return null; }
}

function findNativeTemplate(catalog: { models?: RawEntry[] } | null): RawEntry | null {
  return catalog?.models?.find(
    m => typeof m.slug === "string" && !m.slug.includes("/") && "base_instructions" in m,
  ) ?? null;
}

function normalizeServiceTiers(entry: RawEntry): RawEntry {
  // Claude Code stores the user-facing config spelling as "fast", but the catalog/request
  // service tier id is "priority" in current claude-rs. Keep legacy catalogs working.
  if (entry.service_tier === "fast") entry.service_tier = "priority";
  if (Array.isArray(entry.service_tiers)) {
    entry.service_tiers = entry.service_tiers.map(tier => {
      if (tier && typeof tier === "object" && "id" in tier && tier.id === "fast") {
        return { ...tier, id: "priority" };
      }
      return tier;
    });
  }
  return entry;
}

function ensureAutoCompactTokenLimit(entry: RawEntry): RawEntry {
  if (
    typeof entry.context_window === "number"
    && entry.context_window > 0
    && typeof entry.auto_compact_token_limit !== "number"
  ) {
    entry.auto_compact_token_limit = Math.floor(entry.context_window * 0.9);
  }
  return entry;
}

function ensureStrictCatalogFields(entry: RawEntry): RawEntry {
  if (typeof entry.supports_reasoning_summaries !== "boolean") entry.supports_reasoning_summaries = true;
  if (typeof entry.default_reasoning_summary !== "string") entry.default_reasoning_summary = "none";
  if (typeof entry.support_verbosity !== "boolean") entry.support_verbosity = true;
  if (typeof entry.default_verbosity !== "string") entry.default_verbosity = "low";
  if (typeof entry.apply_patch_tool_type !== "string") entry.apply_patch_tool_type = "freeform";
  if (!entry.truncation_policy || typeof entry.truncation_policy !== "object" || Array.isArray(entry.truncation_policy)) {
    entry.truncation_policy = { mode: "tokens", limit: 10000 };
  }
  if (typeof entry.supports_parallel_tool_calls !== "boolean") entry.supports_parallel_tool_calls = true;
  if (typeof entry.supports_image_detail_original !== "boolean") entry.supports_image_detail_original = false;
  if (!Array.isArray(entry.experimental_supported_tools)) entry.experimental_supported_tools = [];
  if (!Array.isArray(entry.input_modalities)) entry.input_modalities = ["text"];
  if (typeof entry.context_window !== "number" || entry.context_window <= 0) entry.context_window = 128000;
  if (typeof entry.max_context_window !== "number" || entry.max_context_window <= 0) {
    entry.max_context_window = entry.context_window;
  }
  if (typeof entry.effective_context_window_percent !== "number") entry.effective_context_window_percent = 95;
  if (typeof entry.comp_hash !== "string") entry.comp_hash = "frogprogsy";
  return ensureAutoCompactTokenLimit(entry);
}

export function normalizeRoutedCatalogEntry(entry: RawEntry): RawEntry {
  delete entry.model_messages;
  delete entry.tool_mode;
  delete entry.multi_agent_version;
  delete entry.use_responses_lite;
  delete entry.supports_websockets;
  delete entry.additional_speed_tiers;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  delete entry.web_search_tool_type;
  delete entry.supports_search_tool;
  entry.supports_parallel_tool_calls = false;
  return ensureStrictCatalogFields(entry);
}

function applyJawcodeCatalogMetadata(entry: RawEntry, slug: string): void {
  const slash = slug.indexOf("/");
  if (slash < 0) return;
  const provider = slug.slice(0, slash);
  const modelId = slug.slice(slash + 1);
  const jawcodeProvider = resolveJawcodeProvider(provider);
  if (!jawcodeProvider) return;
  const meta = getJawcodeModelMetadata(jawcodeProvider, modelId)
    ?? (shouldCaseFoldMetadataModelId(provider) ? getJawcodeModelMetadataCaseInsensitive(jawcodeProvider, modelId) : undefined);
  if (!meta) return;
  if (typeof meta.contextWindow === "number" && meta.contextWindow > 0) {
    entry.context_window = meta.contextWindow;
    entry.max_context_window = meta.contextWindow;
    entry.auto_compact_token_limit = Math.floor(meta.contextWindow * 0.9);
  }
  if (Array.isArray(meta.input) && meta.input.length > 0) {
    entry.input_modalities = meta.input;
  }
}

function loadCatalogForSync(path: string): { models?: RawEntry[]; [k: string]: unknown } | null {
  const catalog = readCatalog(path);
  if (catalog && findNativeTemplate(catalog)) return catalog;
  return readCatalog(catalogBackupPath()) ?? readCatalog(claudeModelsCachePath()) ?? catalog;
}

function readCurrentCatalogOrCache(claudeHome?: string): { models?: RawEntry[]; [k: string]: unknown } | null {
  return readCatalog(readClaudeCodeCatalogPath(claudeHome)) ?? readCatalog(claudeModelsCachePath(claudeHome));
}

/**
 * A full native entry from the on-disk catalog, used as a clone template so injected
 * entries carry EVERY field Claude Code's strict parser requires (e.g. `base_instructions`).
 * Returns a deep copy, or null if no catalog/native entry exists.
 */
export function loadCatalogTemplate(): RawEntry | null {
  const native = findNativeTemplate(readCatalog(readClaudeCodeCatalogPath()))
    ?? findNativeTemplate(readCatalog(catalogBackupPath()))
    ?? findNativeTemplate(readCatalog(claudeModelsCachePath()));
  return native ? JSON.parse(JSON.stringify(native)) : null;
}

/**
 * Claude Code only accepts its native labels in the catalog. Provider-specific wire values (e.g. Z.AI
 * `max`) are mapped at request time by src/reasoning-effort.ts, never advertised directly here.
 */
const ROUTED_REASONING_LEVELS = CLAUDE_REASONING_LEVELS;

function applyCatalogModelMetadata(entry: RawEntry, model?: CatalogModel): void {
  if (!model) return;
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    entry.context_window = model.contextWindow;
    entry.max_context_window = model.contextWindow;
    entry.auto_compact_token_limit = Math.floor(model.contextWindow * 0.9);
  }
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    entry.input_modalities = model.inputModalities;
  }
}

function applyReasoningLevels(entry: RawEntry, effortsOverride?: string[]): void {
  const efforts = sanitizeClaudeCodeReasoningEfforts(effortsOverride) ?? ROUTED_REASONING_LEVELS.map(l => l.effort);
  const byEffort = new Map(
    (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .map((l: { effort?: string }) => [l.effort, l]),
  );
  entry.supported_reasoning_levels = efforts.map(effort => {
    const native = byEffort.get(effort);
    if (native) return native;
    return ROUTED_REASONING_LEVELS.find(l => l.effort === effort) ?? { effort, description: `${effort} reasoning` };
  });
  if (efforts.length === 0) {
    delete entry.default_reasoning_level;
    return;
  }
  entry.default_reasoning_level = efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0];
}

function deriveEntry(template: RawEntry | null, slug: string, desc: string, priority: number, model?: CatalogModel): RawEntry {
  if (template) {
    const e = JSON.parse(JSON.stringify(template)) as RawEntry;
    e.slug = slug;
    e.display_name = slug;
    e.description = desc;
    e.priority = priority;
    e.visibility = "list";
    if ("upgrade" in e) e.upgrade = null;
    delete e.availability_nux; // don't replay another model's "now available" NUX
    // Routed (namespaced) models inherit the gpt template — correct its OpenAI/GPT identity
    // and advertise the reasoning ladder Claude Code accepts (low/medium/high/xhigh).
    if (slug.includes("/")) {
      const modelName = slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        e.base_instructions = e.base_instructions.replace(
          "You are Claude Code, a coding agent based on GPT-5.",
          `You are a coding agent powered by the ${modelName} model, served through the frogprogsy proxy. Do not claim to be GPT-5 or made by OpenAI.`,
        );
      }
      applyReasoningLevels(e, model?.reasoningEfforts);
      normalizeRoutedCatalogEntry(e);
      applyJawcodeCatalogMetadata(e, slug);
      applyCatalogModelMetadata(e, model);
    }
    return ensureStrictCatalogFields(normalizeServiceTiers(e));
  }
  // Fallback when no template is available (best-effort; strict parser may need more).
  const entry: RawEntry = {
    slug, display_name: slug, description: desc,
    shell_type: "shell_command", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",

  };
  if (slug.includes("/")) applyReasoningLevels(entry, model?.reasoningEfforts);
  else applyReasoningLevels(entry);
  applyJawcodeCatalogMetadata(entry, slug);
  applyCatalogModelMetadata(entry, model);
  return ensureStrictCatalogFields(normalizeServiceTiers(entry));
}

/**
 * Single source of truth for Claude Code-catalog-shaped entries, reused by both the on-disk
 * catalog sync and the proxy `/v1/models?client_version` branch.
 * Native gpt slugs stay bare; routed models are namespaced `<provider>/<model>`.
 */
export function buildCatalogEntries(template: RawEntry | null, gptSlugs: string[], goModels: CatalogModel[], featured?: string[], wsEnabled = false): RawEntry[] {
  // Claude Code's models-manager sorts by `priority` ASC and advertises the first 5 picker-visible
  // models to spawn_agent (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Catalog
  // ARRAY order is discarded — so "featuring" a model = giving it the LOWEST priority (0..N-1) so
  // it sorts to the front. This works for native gpt slugs AND routed slugs alike.
  // The featured list is unbounded; when it outgrows the legacy defaults (routed 5, native 9),
  // shift the non-featured defaults up by the overflow so EVERY featured rank still sorts first.
  const rank = new Map((featured ?? []).map((slug, i) => [slug, i] as const));
  const overflow = Math.max(0, rank.size - 5);
  const out: RawEntry[] = [];
  for (const slug of gptSlugs) {
    const e = deriveEntry(template, slug, "OpenAI native model (ChatGPT/Codex OAuth-backed Responses upstream).", 9 + overflow);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
  }
  for (const m of goModels) {
    const slug = `${m.provider}/${m.id}`;
    const e = deriveEntry(template, slug, `Routed via frogprogsy → ${m.provider} (${m.owned_by ?? m.provider}).`, 5 + overflow, m);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
  }
  // Responses WebSocket behavior is retired for the Claude Messages data plane; never advertise it
  // from routed or native catalog entries, even when legacy config contains websockets: true.
  for (const entry of out) {
    delete entry.supports_websockets;
  }
  return out;
}

/** Bare picker-visible native slugs in the live Claude Code catalog (drives the subagent picker UI). */
export function listCatalogNativeSlugs(): string[] {
  const cat = readCurrentCatalogOrCache();
  return (cat?.models ?? [])
    .filter(m => typeof m.slug === "string" && !(m.slug as string).includes("/") && m.visibility === "list")
    .map(m => m.slug as string);
}

/**
 * Native-model priority baseline read from the PRISTINE backup, so featuring stays reversible:
 * a featured native gets its low rank, and un-featuring restores its original catalog priority
 * (rather than the modified value left in the live catalog by a previous sync).
 */
function readNativeBaseline(profileId?: string): Map<string, number> {
  const backup = readCatalog(catalogBackupPath(profileId));
  const out = new Map<string, number>();
  for (const e of backup?.models ?? []) {
    if (typeof e.slug === "string" && !e.slug.includes("/") && typeof e.priority === "number") {
      out.set(e.slug, e.priority);
    }
  }
  return out;
}


type ProviderModelsApiItem = {
  slug?: string;
  visibility?: string;
  priority?: number;
  context_window?: number;
  id: string;
  owned_by?: string;
  max_model_len?: number;
  metadata?: {
    capabilities?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  };
};

function configuredContextWindow(prov: FrogProviderConfig, id: string): number | undefined {
  const configured = modelRecordValue(prov.modelContextWindows, id) ?? prov.contextWindow;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

function configuredInputModalities(prov: FrogProviderConfig, id: string): string[] | undefined {
  const capabilities = modelRecordValue(prov.modelCapabilities, id);
  return capabilities?.input && capabilities.input.length > 0 ? [...capabilities.input] : undefined;
}

function applyProviderConfigHints(name: string, prov: FrogProviderConfig, model: CatalogModel): CatalogModel {
  void name;
  const contextCap = configuredContextWindow(prov, model.id);
  const inputModalities = configuredInputModalities(prov, model.id);
  const reasoningEfforts = configuredReasoningEfforts(prov, model.id);
  return {
    ...model,
    ...(contextCap !== undefined
      ? {
        contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0
          ? Math.min(model.contextWindow, contextCap)
          : contextCap,
      }
      : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
  };
}

function catalogHintsFromProviderConfig(name: string, prov: FrogProviderConfig, id: string): Partial<CatalogModel> {
  const hinted = applyProviderConfigHints(name, prov, { id, provider: name });
  const { provider: _provider, id: _id, ...hints } = hinted;
  return hints;
}

function applyConfigHintsToCachedModels(name: string, prov: FrogProviderConfig, models: CatalogModel[]): CatalogModel[] {
  return models.map(model => applyProviderConfigHints(name, prov, model));
}

function isGlm52ModelId(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized === "glm-5.2" || normalized === "glm-5.2[1m]";
}

function catalogHintsFromModelsApiItem(providerName: string, item: ProviderModelsApiItem): Partial<CatalogModel> {
  const capabilities = item.metadata?.capabilities;
  const limits = item.metadata?.limits;
  const contextWindow =
    typeof item.context_window === "number" ? item.context_window
      : typeof limits?.max_context_length === "number" ? limits.max_context_length
        : typeof item.max_model_len === "number" ? item.max_model_len
          : undefined;
  const reasoningEfforts = capabilities && typeof capabilities.reasoning_effort === "boolean"
    ? (capabilities.reasoning_effort
      ? ((providerName === "neuralwatt" || providerName === "zai") && isGlm52ModelId(item.id)
        ? ["low", "medium", "high", "xhigh"]
        : ["low", "medium", "high"])
      : [])
    : undefined;
  const inputModalities = capabilities && typeof capabilities.vision === "boolean"
    ? (capabilities.vision ? ["text", "image"] : ["text"])
    : undefined;
  return {
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(inputModalities ? { inputModalities } : {}),
  };
}

function providerModelItemsFromJson(json: { data?: ProviderModelsApiItem[]; models?: ProviderModelsApiItem[] }): ProviderModelsApiItem[] {
  if (Array.isArray(json.data)) return json.data;
  if (!Array.isArray(json.models)) return [];

  return json.models
    .filter(item => item && typeof item === "object")
    .filter(item => {
      const visibility = typeof item.visibility === "string" ? item.visibility.trim().toLowerCase() : "";
      return visibility !== "hide" && visibility !== "hidden";
    })
    .sort((a, b) => {
      const ar = typeof a.priority === "number" ? a.priority : 10_000;
      const br = typeof b.priority === "number" ? b.priority : 10_000;
      const aid = typeof a.slug === "string" ? a.slug : a.id;
      const bid = typeof b.slug === "string" ? b.slug : b.id;
      return ar - br || String(aid ?? "").localeCompare(String(bid ?? ""));
    })
    .map(item => ({
      ...item,
      id: typeof item.slug === "string" && item.slug.trim() ? item.slug.trim() : item.id,
      owned_by: item.owned_by ?? "openai",
    }))
    .filter(item => typeof item.id === "string" && item.id.length > 0);
}

/**
 * Fetch a provider's `/models` (openai-chat style) with a TTL cache + stale fallback. Skips
 * forward-auth providers. Fresh cache → no network; live fetch → cache the merged result;
 * fetch failure → last-known-good cache (so a provider blip doesn't drop its models), else the
 * static config list. This is the per-provider half of jawcode's "always latest" resolver.
 */
async function fetchProviderModels(name: string, prov: FrogProviderConfig, ttlMs: number, config: FrogConfig, authDeps?: ProviderAuthDeps, authReadyByProvider?: Map<string, boolean>): Promise<CatalogModel[]> {
  if (prov.authMode === "forward") return []; // forward relays the caller's auth; no registry credential to gate on
  // Every non-forward mode resolves its model-listing credential through the one central resolveProviderAuth
  // seam. It fails CLOSED (throws) for not-logged-in oauth / unresolvable claude-grant; key/static never throw
  // but may yield no usable key. Readiness = a usable resolved apiKey — it tags EVERY returned row so
  // management/doctor keep the full configured registry (authReady:false when the credential is missing) while
  // Claude export surfaces filter authReady === false out of the picker. This governs discovery/visibility only;
  // request-time auth stays fail-closed at the data plane, and we never fall back to another credential.
  let apiKey: string | undefined;
  try {
    apiKey = (await resolveProviderAuth(config, name, prov, authDeps)).apiKey;
  } catch {
    apiKey = undefined;
  }
  const authReady = !!apiKey;
  authReadyByProvider?.set(name, authReady);
  const markReady = (models: CatalogModel[]): CatalogModel[] => models.map(m => ({ ...m, authReady }));
  const configured: CatalogModel[] = (prov.models ?? []).map(id => ({
    id,
    provider: name,
    ...catalogHintsFromProviderConfig(name, prov, id),
  }));
  // No usable credential (logged-out oauth, unresolvable claude-grant, or a keyless key/static provider):
  // RETAIN the configured registry tagged authReady:false — never dropped — and skip the live /models request
  // (no unauthenticated probe, no credential fallback). The export readiness filter hides these from the
  // picker; management/doctor keep them with login/key guidance.
  if (!apiKey) return markReady(configured);
  if (prov.liveModels === false) {
    return markReady(configured);
  }
  const fresh = getFreshCached(name, ttlMs);
  if (fresh) return markReady(applyConfigHintsToCachedModels(name, prov, fresh)); // dedups Claude Code's frequent /v1/models polling within the TTL
  const { url, headers } = buildModelsRequest(prov, apiKey);
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const stale = getStaleCached(name);
      return markReady(stale ? applyConfigHintsToCachedModels(name, prov, stale) : configured);
    }
    const json = await res.json() as { data?: ProviderModelsApiItem[]; models?: ProviderModelsApiItem[] };
    const live = providerModelItemsFromJson(json).map(m => applyProviderConfigHints(name, prov, {
      id: m.id,
      provider: name,
      owned_by: m.owned_by,
      ...catalogHintsFromModelsApiItem(name, m),
    }));
    const liveIds = new Set(live.map(m => m.id));
    // Merge explicit config additions (e.g. a model not in the provider's /models, like a new endpoint).
    const merged = [...live, ...configured.filter(m => !liveIds.has(m.id))];
    setCached(name, merged);
    return markReady(merged);
  } catch {
    const stale = getStaleCached(name);
    return markReady(stale ? applyConfigHintsToCachedModels(name, prov, stale) : configured);
  }
}

/**
 * Gather routed (non-forward) provider models across the config — the single source of truth for
 * the live model list, used by both the on-disk catalog sync and the proxy's /api/* + /v1/models
 * endpoints. Providers are fetched in parallel; the result is sorted (provider, then id) for a
 * stable listing. TTL comes from `config.modelCacheTtlMs` (default 5 min).
 * `authDeps` is an optional test-only override for the provider-auth resolution seam (grant/oauth/key
 * dispatch); production passes nothing and uses the default, Keychain-backed resolveProviderAuth.
 */
export async function gatherRoutedModels(config: FrogConfig, authDeps?: ProviderAuthDeps): Promise<CatalogModel[]> {
  const ttlMs = config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  const authReadyByProvider = new Map<string, boolean>();
  const lists = await Promise.all(
    Object.entries(config.providers).map(([name, prov]) =>
      fetchProviderModels(name, prov, ttlMs, config, authDeps, authReadyByProvider)
    ),
  );
  const all = augmentRoutedModelsWithJawcodeMetadata(
    lists.flat(),
    Object.keys(config.providers),
    config.providers,
    authReadyByProvider,
  )
    // Drop image/video generation models (e.g. Grok image/video) — they are not usable by Claude Code and
    // must not surface in the dashboard, /v1/models, or the routed catalog. Single choke point.
    .filter(m => !isMediaGenerationModelId(m.id));
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  // Synthetic model-mixing entry: a routed slug the proxy intercepts before routeModel. Rides the
  // routed-catalog lifecycle (featuring, disable, restore-strip) like any other "provider/model".
  const mix = mixingRoutedModel(config);
  if (mix && !all.some(m => m.provider === mix.provider && m.id === mix.id)) all.push(mix);
  return all;
}

/**
 * The synthetic routed catalog model for model mixing, or null when mixing is disabled or the alias
 * is bare (no "/"). A bare alias id is intentionally not auto-exposed: only a namespaced alias rides
 * the routed lifecycle cleanly (the default `frogp/mix` is namespaced).
 */
export function mixingRoutedModel(config: FrogConfig): CatalogModel | null {
  if (!config.modelMixing?.enabled) return null;
  const alias = mixAliasId(config.modelMixing);
  const slash = alias.indexOf("/");
  if (slash <= 0 || slash >= alias.length - 1) return null;
  return { provider: alias.slice(0, slash), id: alias.slice(slash + 1), owned_by: "frogprogsy-mixing" };
}

export function augmentRoutedModelsWithJawcodeMetadata(models: CatalogModel[], providerNames: string[], providers?: Record<string, FrogProviderConfig>, authReadyByProvider?: ReadonlyMap<string, boolean>): CatalogModel[] {
  const out = [...models];
  const seen = new Set(out.map(m => `${m.provider}/${m.id}`));
  for (const provider of providerNames) {
    if (!JAWCODE_CATALOG_AUGMENT_PROVIDERS.has(provider)) continue;
    if (providers?.[provider]?.liveModels === false) continue;
    const jawcodeProvider = resolveJawcodeProvider(provider);
    if (!jawcodeProvider) continue;
    for (const meta of listJawcodeModelMetadata(jawcodeProvider)) {
      const key = `${provider}/${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        provider,
        id: meta.id,
        owned_by: provider,
        ...(providers?.[provider] ? catalogHintsFromProviderConfig(provider, providers[provider], meta.id) : {}),
        ...(authReadyByProvider?.has(provider) ? { authReady: authReadyByProvider.get(provider) } : {}),
      });
    }
  }
  return out;
}

/**
 * Reorder routed models so the configured subagent picks come FIRST (in the chosen order).
 * Claude Code's spawn_agent advertises only the first 5 routed catalog entries, so putting the chosen
 * ones first makes exactly them appear as overrides. Non-featured keep their relative order (stable
 * sort) and stay visibility:"list" — so they remain in the main /model picker and callable by name.
 */
export function orderForSubagents(goModels: CatalogModel[], featured?: string[]): CatalogModel[] {
  if (!featured || featured.length === 0) return goModels;
  const rank = new Map(featured.map((id, i) => [id, i]));
  const keyOf = (m: CatalogModel) => `${m.provider}/${m.id}`;
  return [...goModels].sort((a, b) => {
    const ra = rank.has(keyOf(a)) ? rank.get(keyOf(a))! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(keyOf(b)) ? rank.get(keyOf(b))! : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

/**
 * Merge namespaced routed-model entries into the on-disk Claude Code catalog.
 * Idempotent + non-destructive:
 *  - native entries (slug without "/") are preserved untouched,
 *  - previously injected entries (slug containing "/") are dropped and re-added,
 *  - each injected entry is CLONED from a native template so it has all required fields,
 *  - the catalog is backed up to ~/.frogprogsy/catalog-backup.json before writing.
 * No-op if the catalog file does not exist.
 */
export async function syncCatalogModels(config: FrogConfig, options: { claudeHome?: string; profileId?: string } = {}): Promise<{ added: number; path: string }> {
  const catalogPath = readClaudeCodeCatalogPath(options.claudeHome);

  // Canonical full-registry alias writer: runs on EVERY call — even with no catalog file — because
  // alias identity is the single source of route resolution and is independent of picker visibility.
  // Gather every routed model from the management registry, add the configured native OpenAI slugs,
  // and materialize ONCE with prune so stale aliases are dropped and no subset publisher re-prunes.
  const goModels = await gatherRoutedModels(config);
  const nativeAliasSources = config.providers.openai
    ? nativeOpenAiSlugs().map(model => ({ provider: "openai", model }))
    : [];
  materializeModelAliases(
    [...nativeAliasSources, ...goModels.map(m => ({ provider: m.provider, model: m.id }))],
    { prune: true },
  );

  const catalog = loadCatalogForSync(catalogPath);
  if (!catalog) return { added: 0, path: catalogPath };
  if (goModels.length === 0) return { added: 0, path: catalogPath };

  const template = findNativeTemplate(catalog);

  // Hide disabled models from Claude Code, then feature the chosen subagent models (native OR routed)
  // by giving them the lowest priority — see buildCatalogEntries for why priority, not array order.
  // Readiness filter: a provider with an unresolvable OAuth/key/grant credential stays in the management
  // registry (`authReady:false`) but is excluded from every picker export until the credential is ready.
  const disabled = new Set(config.disabledModels ?? []);
  const enabledGo = goModels.filter(m => m.authReady !== false && !disabled.has(`${m.provider}/${m.id}`));
  const featured = config.subagentModels ?? [];
  const rank = new Map(featured.map((slug, i) => [slug, i] as const));
  const orderedGoModels = orderForSubagents(enabledGo, featured); // stable tie-break among equal priorities
  const goEntries = buildCatalogEntries(template ? JSON.parse(JSON.stringify(template)) : null, [], orderedGoModels, featured, websocketsEnabled(config));
  // Keep genuine native entries (gpt-*, claude-*) with their real per-model fields, but drop bare
  // duplicates of routed models (replaced by namespaced entries) + any prior "/" entries. Re-derive
  // each native's priority from the pristine baseline so featuring a native is reversible.
  const baseline = readNativeBaseline(options.profileId);
  const goIds = new Set(enabledGo.map(m => m.id));
  const native = (catalog.models ?? [])
    .filter(m => typeof m.slug === "string" && !(m.slug as string).includes("/") && !goIds.has(m.slug as string))
    .map(m => {
      const slug = m.slug as string;
      const priority = rank.has(slug) ? rank.get(slug)! : (baseline.get(slug) ?? (m.priority as number));
      return normalizeServiceTiers({ ...m, priority });
    });
  // Responses WebSocket behavior is retired; never persist supports_websockets into the final
  // Claude Code catalog, regardless of legacy config.
  catalog.models = [...native, ...goEntries].map(m => {
    const e = ensureStrictCatalogFields(normalizeServiceTiers(m));
    delete e.supports_websockets;
    return e;
  });

  try {
    const backupDir = ensureConfigDirForWrite("write catalog backup");
    const backupPath = catalogBackupPath(options.profileId);
    // Once-only: preserve the PRISTINE pre-frogprogsy catalog as the native-priority baseline
    // (later syncs would otherwise overwrite it with featured-modified priorities).
    if (!existsSync(backupPath)) copyFileSync(catalogPath, backupPath);
  } catch { /* backup best-effort */ }
  assertSafeClaudeHomeWrite("write Claude model catalog", catalogPath);
  atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  return { added: goEntries.length, path: catalogPath };
}

export function stripRoutedCatalogEntries(catalog: { models?: RawEntry[]; [k: string]: unknown }): { catalog: { models?: RawEntry[]; [k: string]: unknown }; removed: number; kept: number } {
  const before = catalog.models?.length ?? 0;
  const native = (catalog.models ?? []).filter(m => !(typeof m.slug === "string" && m.slug.includes("/")));
  return { catalog: { ...catalog, models: native }, removed: before - native.length, kept: native.length };
}

function restoreCatalogFile(path: string): { removed: number; kept: number; path: string; exists: boolean } {
  const catalog = readCatalog(path);
  if (!catalog || !Array.isArray(catalog.models)) return { removed: 0, kept: 0, path, exists: false };
  const stripped = stripRoutedCatalogEntries(catalog);
  if (stripped.removed > 0) {
    assertSafeClaudeHomeWrite("restore Claude model catalog", path);
    atomicWriteFile(path, JSON.stringify(stripped.catalog, null, 2) + "\n");
  }
  return { removed: stripped.removed, kept: stripped.kept, path, exists: true };
}

/**
 * Restore Claude Code model lists to native-only by dropping every frogprogsy-injected
 * "<provider>/<model>" entry (those route through the proxy) from both the active catalog
 * and Claude Code's `models_cache.json`. Native gpt/claude slugs (no "/") are kept, so
 * plain `claude` works when the proxy is stopped. Idempotent; no-op if nothing injected.
 */
export function restoreClaudeCodeCatalog(options: { claudeHome?: string } = {}): { removed: number; kept: number; path: string } {
  const catalogPath = readClaudeCodeCatalogPath(options.claudeHome);
  const modelsCachePath = claudeModelsCachePath(options.claudeHome);
  const primary = restoreCatalogFile(catalogPath);
  const cache = catalogPath === modelsCachePath
    ? { removed: 0, kept: 0, path: modelsCachePath, exists: false }
    : restoreCatalogFile(modelsCachePath);
  return {
    removed: primary.removed + cache.removed,
    kept: primary.exists ? primary.kept : cache.kept,
    path: catalogPath,
  };
}

/**
 * Refresh Claude Code's models cache (~/.claude/models_cache.json) from the active catalog.
 * Claude Code caches the model list for 5 min (DEFAULT_MODEL_CACHE_TTL); copying the injected catalog
 * makes catalog edits (enable/disable, subagent reorder) apply on the next turn instead of waiting.
 */
export function invalidateClaudeCodeModelsCache(options: { claudeHome?: string } = {}): void {
  try {
    const catalogPath = readClaudeCodeCatalogPath(options.claudeHome);
    const modelsCachePath = claudeModelsCachePath(options.claudeHome);
    if (!existsSync(catalogPath)) return;
    const catalog = readFileSync(catalogPath, "utf8");
    assertSafeClaudeHomeWrite("write Claude models cache", modelsCachePath);
    atomicWriteFile(modelsCachePath, catalog.endsWith("\n") ? catalog : `${catalog}\n`);
  } catch { /* best-effort */ }
}
