import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { NATIVE_OPENAI_MODELS, gatherRoutedModels, invalidateClaudeCodeModelsCache, nativeOpenAiSlugs, syncCatalogModels } from "./claude-catalog";
import { materializeModelAliases, type ModelAliasEntry } from "./model-aliases";
import { assertSafeClaudeHomeWrite, claudeGatewayModelsCachePath, claudeModelsCachePath } from "./claude-paths";
import { atomicWriteFile } from "./config";
import type { FrogConfig } from "./types";

// Transient model fetch/sync failures keep the last-known-good cache (`retained_after_error`) or
// hard-fail (`failed`) when no valid same-baseUrl cache exists. Transient errors never invalidate LKG.
export type ClaudeCodeGatewayModelsCacheStatus =
  | "written"
  | "retained_after_error"
  | "failed"
  | "skipped"
  | "unknown";

export interface ClaudeCodeGatewayModelsCacheSyncResult {
  status: ClaudeCodeGatewayModelsCacheStatus;
  path?: string;
  modelCount?: number;
  warning?: string;
}

export interface ClaudeCodeGatewayModelsCacheInvalidationResult {
  path: string;
  existed: boolean;
  deleted: boolean;
  warning?: string;
}


export interface ClaudeCodeCatalogRefreshResult {
  added: number;
  path: string;
  catalogExists: boolean;
  cacheSynced: boolean;
  gatewayCache: ClaudeCodeGatewayModelsCacheSyncResult;
  warnings: string[];
}

/**
 * Exact on-disk gateway models cache schema (Claude Code's official discovery-fallback read):
 * `{baseUrl, fetchedAt, models:[{id, display_name?}]}`. `baseUrl` is the active frogprogsy loopback
 * URL Claude Code is enrolled against; `fetchedAt` is the write time in epoch milliseconds. Cache
 * entries are ROUTED ALIASES ONLY — `id` is the generated gateway alias, `display_name` its routeKey.
 */
interface GatewayModelsCacheEntry {
  id: string;
  display_name?: string;
}

interface GatewayModelsCache {
  baseUrl: string;
  fetchedAt: number;
  models: GatewayModelsCacheEntry[];
}

function isGatewayModelsCacheEntry(value: unknown): value is GatewayModelsCacheEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  return keys.every(key => key === "id" || key === "display_name")
    && typeof entry.id === "string"
    && entry.id.length > 0
    && (entry.display_name === undefined || typeof entry.display_name === "string");
}

interface RefreshDeps {
  syncCatalogModels: typeof syncCatalogModels;
  invalidateClaudeCodeModelsCache: typeof invalidateClaudeCodeModelsCache;
  syncClaudeCodeGatewayModelsCache: typeof syncClaudeCodeGatewayModelsCache;
  syncClaudeCodeModelsCacheFromCatalog: typeof syncClaudeCodeModelsCacheFromCatalog;
  existsSync: typeof existsSync;
}

const defaultDeps: RefreshDeps = {
  syncCatalogModels,
  invalidateClaudeCodeModelsCache,
  syncClaudeCodeGatewayModelsCache,
  syncClaudeCodeModelsCacheFromCatalog,
  existsSync,
};

/** Test-only override seam for the routed-model source of the gateway cache. */
export interface GatewayCacheDeps {
  gatherRoutedModels: typeof gatherRoutedModels;
}

const defaultGatewayCacheDeps: GatewayCacheDeps = { gatherRoutedModels };

/** The active frogprogsy loopback base URL Claude Code is enrolled against (ANTHROPIC_BASE_URL). */
function gatewayBaseUrl(config: FrogConfig): string {
  return `http://localhost:${config.port}`;
}

// Native Claude Code built-in model slugs the gateway cache must never shadow. Kept as an explicit,
// deterministic set (independent of any live catalog read) so the write-time collision guard is
// stable and testable. OpenAI natives come from the shared NATIVE_OPENAI_MODELS export.
const NATIVE_CLAUDE_MODEL_SLUGS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

function nativeBuiltinSlugSet(): Set<string> {
  const set = new Set<string>();
  for (const slug of NATIVE_OPENAI_MODELS) set.add(slug.toLowerCase());
  for (const slug of NATIVE_CLAUDE_MODEL_SLUGS) set.add(slug.toLowerCase());
  return set;
}

// Redacted, id-only rejection warning: never surfaces routing detail beyond the generated cache id.
function gatewayRejectionWarning(id: string, reason: string): string {
  return `Claude Code gateway cache rejected model id "${id}": ${reason}`;
}

export interface GatewayCacheBuildResult {
  models: GatewayModelsCacheEntry[];
  warnings: string[];
}

/**
 * Turn materialized routed aliases into gateway cache entries under the D-pinned write-time rules:
 *   (ii) reject any candidate whose INTERNAL routing identity is not a namespaced `<provider>/<model>`;
 *   (i)  reject any candidate whose GENERATED id or display collides with a native Claude/OpenAI
 *        built-in slug.
 * Every rejection emits a redacted, id-only warning. Native built-ins are never candidates by
 * construction (gatherRoutedModels excludes forward/native providers); this guard is the
 * deterministic backstop so the picker/cache can never advertise an unnamespaced or native identity.
 */
export function buildGatewayCacheEntries(aliases: ModelAliasEntry[]): GatewayCacheBuildResult {
  const natives = nativeBuiltinSlugSet();
  const models: GatewayModelsCacheEntry[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  for (const alias of aliases) {
    const id = alias.alias;
    const display = alias.displayName;
    const slash = alias.routeKey.indexOf("/");
    const provider = slash > 0 ? alias.routeKey.slice(0, slash) : "";
    const model = slash >= 0 ? alias.routeKey.slice(slash + 1) : "";
    if (!provider || !model) {
      warnings.push(gatewayRejectionWarning(id, "internal route is not a namespaced <provider>/<model>"));
      continue;
    }
    if (natives.has(id.toLowerCase())) {
      warnings.push(gatewayRejectionWarning(id, "generated id collides with a native Claude/OpenAI built-in slug"));
      continue;
    }
    if (natives.has(display.toLowerCase())) {
      warnings.push(gatewayRejectionWarning(id, "generated display collides with a native Claude/OpenAI built-in slug"));
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(gatewayRejectionWarning(id, "duplicate generated id"));
      continue;
    }
    seenIds.add(id);
    models.push({ id, display_name: display });
  }
  return { models, warnings };
}

export function syncClaudeCodeModelsCacheFromCatalog(catalogPath: string, options: { claudeHome?: string } = {}): void {
  const content = readFileSync(catalogPath, "utf8");
  const modelsCachePath = claudeModelsCachePath(options.claudeHome);
  assertSafeClaudeHomeWrite("write Claude models cache", modelsCachePath);
  atomicWriteFile(modelsCachePath, content);
}

/**
 * Explicit, unconditional deletion of the gateway models cache. Deletion is reserved for explicit
 * invalidation, restore/stop, and baseUrl/port changes — NOT for transient fetch/sync failures,
 * which retain the last-known-good cache (see `gatewaySyncFailureResult`).
 */
export function invalidateClaudeCodeGatewayModelsCache(options: { claudeHome?: string } = {}): ClaudeCodeGatewayModelsCacheInvalidationResult {
  const cachePath = claudeGatewayModelsCachePath(options.claudeHome);
  try {
    if (!existsSync(cachePath)) return { path: cachePath, existed: false, deleted: false };
    assertSafeClaudeHomeWrite("delete Claude gateway models cache", cachePath);
    unlinkSync(cachePath);
    return { path: cachePath, existed: true, deleted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: cachePath,
      existed: true,
      deleted: false,
      warning: `Claude Code gateway models cache invalidation failed for ${cachePath}: ${message}`,
    };
  }
}

function isGatewayModelEnabled(config: FrogConfig, provider: string, model: string): boolean {
  const disabled = new Set(config.disabledModels ?? []);
  return !disabled.has(model) && !disabled.has(`${provider}/${model}`);
}

/**
 * Read a well-formed CURRENT-schema gateway cache, or null for a missing / unparseable / legacy
 * cache. A legacy cache (current schema had no `baseUrl`) parses but lacks a `baseUrl` string, so it
 * returns null here and is treated as stale by `gatewaySyncFailureResult` (delete-then-rewrite,
 * never retained).
 */
function readGatewayModelsCache(cachePath: string): GatewayModelsCache | null {
  try {
    if (!existsSync(cachePath)) return null;
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Object.keys(parsed as Record<string, unknown>).sort().join(",") === "baseUrl,fetchedAt,models" &&
      typeof (parsed as GatewayModelsCache).baseUrl === "string" &&
      (parsed as GatewayModelsCache).baseUrl.length > 0 &&
      typeof (parsed as GatewayModelsCache).fetchedAt === "number" &&
      Number.isFinite((parsed as GatewayModelsCache).fetchedAt) &&
      Array.isArray((parsed as GatewayModelsCache).models) &&
      (parsed as GatewayModelsCache).models.every(isGatewayModelsCacheEntry)
    ) {
      return parsed as GatewayModelsCache;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Result for a transient model fetch/sync error. Reverses the previous invalidate-on-error behavior:
 * a valid last-known-good cache on the SAME baseUrl is RETAINED (`retained_after_error`). A missing /
 * unparseable / mismatched-baseUrl (legacy) cache is stale — deleted here and rewritten on the next
 * success — and is NEVER counted as retained (`failed`).
 */
function gatewaySyncFailureResult(
  cachePath: string,
  baseUrl: string,
  message: string,
  options: { claudeHome?: string },
  modelCount?: number,
): ClaudeCodeGatewayModelsCacheSyncResult {
  const existing = readGatewayModelsCache(cachePath);
  if (existing && existing.baseUrl === baseUrl) {
    return {
      status: "retained_after_error",
      path: cachePath,
      ...(modelCount !== undefined ? { modelCount } : {}),
      warning: `Claude Code gateway models cache sync failed; retained last-known-good cache: ${message}`,
    };
  }
  const invalidation = invalidateClaudeCodeGatewayModelsCache(options);
  if (invalidation.warning) {
    return {
      status: "failed",
      path: cachePath,
      ...(modelCount !== undefined ? { modelCount } : {}),
      warning: `Claude Code gateway models cache sync failed and stale cache may remain: ${message}; ${invalidation.warning}`,
    };
  }
  const staleNote = existing
    ? "stale cache with mismatched baseUrl deleted"
    : invalidation.existed
      ? "stale/legacy cache deleted"
      : "no last-known-good cache to retain";
  return {
    status: "failed",
    path: cachePath,
    ...(modelCount !== undefined ? { modelCount } : {}),
    warning: `Claude Code gateway models cache sync failed; ${staleNote}: ${message}`,
  };
}


export async function syncClaudeCodeGatewayModelsCache(
  config: FrogConfig,
  options: { claudeHome?: string } = {},
  deps: GatewayCacheDeps = defaultGatewayCacheDeps,
): Promise<ClaudeCodeGatewayModelsCacheSyncResult> {
  const cachePath = claudeGatewayModelsCachePath(options.claudeHome);
  const baseUrl = gatewayBaseUrl(config);
  let modelCount: number | undefined;
  try {
    const gathered = await deps.gatherRoutedModels(config);
    // Materialize over the FULL collision universe (configured native OpenAI slugs + EVERY gathered
    // routed model) WITHOUT prune: this is a subset publisher, so it must never delete the canonical
    // aliases owned by syncCatalogModels, and alias identity is computed over the full universe (never
    // the visible subset) so a hidden collision peer can't silently change a visible alias.
    const nativeAliasSources = config.providers.openai
      ? nativeOpenAiSlugs().map(model => ({ provider: "openai", model }))
      : [];
    const aliases = materializeModelAliases([
      ...nativeAliasSources,
      ...gathered.map(model => ({ provider: model.provider, model: model.id })),
    ]);
    // Readiness/disabled filter selects VISIBILITY only, not identity: publish the canonical aliases
    // for exactly the authReady + enabled routed routeKeys. `authReady === false` means the configured
    // OAuth/key/grant credential is not resolvable, so those models stay out of the picker/cache.
    const visibleRouteKeys = new Set(
      gathered
        .filter(model => model.authReady !== false)
        .filter(model => isGatewayModelEnabled(config, model.provider, model.id))
        .map(model => `${model.provider}/${model.id}`),
    );
    const { models, warnings } = buildGatewayCacheEntries(aliases.filter(entry => visibleRouteKeys.has(entry.routeKey)));
    const cache: GatewayModelsCache = { baseUrl, fetchedAt: Date.now(), models };
    modelCount = cache.models.length;
    assertSafeClaudeHomeWrite("write Claude gateway models cache", cachePath);
    mkdirSync(dirname(cachePath), { recursive: true });
    atomicWriteFile(cachePath, JSON.stringify(cache, null, 2) + "\n");
    // F2: enforce a fail-closed post-write security contract. On POSIX the gateway cache holds routing
    // identity and MUST end up owner-only, so verify the FINAL on-disk mode is exactly 0600 after the
    // temp+rename (enforce, then assert). Windows cannot represent 0600 with POSIX permission bits, so
    // it does NOT claim a 0600 mode; the contract there is the successful atomic write/replace itself —
    // require the renamed cache file to exist on disk, else fail closed (never a false 0600 claim).
    if (process.platform === "win32") {
      if (!existsSync(cachePath)) {
        throw new Error("gateway models cache atomic write did not produce the cache file");
      }
    } else {
      let mode = statSync(cachePath).mode & 0o777;
      if (mode !== 0o600) {
        chmodSync(cachePath, 0o600);
        mode = statSync(cachePath).mode & 0o777;
      }
      if (mode !== 0o600) {
        throw new Error(`gateway models cache final mode ${mode.toString(8)} is not 0600`);
      }
    }
    return {
      status: "written",
      path: cachePath,
      modelCount,
      ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return gatewaySyncFailureResult(cachePath, baseUrl, message, options, modelCount);
  }
}

/**
 * Rebuild Claude Code's on-disk model catalog and keep Claude Code's models cache aligned
 * when a catalog file exists. Claude Code Desktop can read models_cache.json directly,
 * so deleting a stale cache is not enough: the cache must be replaced with the
 * same catalog content the CLI debug path reads.
 */
export async function refreshClaudeCodeModelCatalog(
  config: FrogConfig,
  deps: RefreshDeps = defaultDeps,
  options: { claudeHome?: string; profileId?: string } = {},
): Promise<ClaudeCodeCatalogRefreshResult> {
  const result = await deps.syncCatalogModels(config, options);
  let gatewayCache: ClaudeCodeGatewayModelsCacheSyncResult;
  const warnings: string[] = [];
  try {
    gatewayCache = await deps.syncClaudeCodeGatewayModelsCache(config, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gatewayCache = gatewaySyncFailureResult(claudeGatewayModelsCachePath(options.claudeHome), gatewayBaseUrl(config), message, options);
  }
  if (gatewayCache.warning) warnings.push(gatewayCache.warning);
  const catalogExists = deps.existsSync(result.path);
  if (!catalogExists) return { ...result, catalogExists, cacheSynced: false, gatewayCache, warnings };
  deps.invalidateClaudeCodeModelsCache(options);
  deps.syncClaudeCodeModelsCacheFromCatalog(result.path, options);
  return { ...result, catalogExists, cacheSynced: true, gatewayCache, warnings };
}
