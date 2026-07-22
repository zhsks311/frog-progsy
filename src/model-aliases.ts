import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, ensureConfigDirForWrite, getConfigDir } from "./config";
import type { FrogConfig } from "./types";

export const MODEL_ALIASES_PATH = join(getConfigDir(), "model-aliases.json");

function modelAliasesPath(): string {
  return join(getConfigDir(), "model-aliases.json");
}
// Short marker so gateway-discovery ids stay readable in Claude Code pickers while remaining
// unambiguously owned by this gateway. Must start with "claude-" — Claude Code only accepts
// Anthropic-style model ids from gateway discovery. Exported as the single source of truth for
// the gateway alias prefix so the router can fail closed on unknown ids that carry it.
export const GATEWAY_MODEL_ALIAS_PREFIX = "claude-frogp-";
// Collision suffix length. Aliases are hashless by default; a hash is appended only when two
// DISTINCT route keys sanitize/truncate to the same base (e.g. long dated model variants cut
// at SLUG_MAX, or ids differing only in folded characters).
const HASH_LEN = 6;
const SLUG_MAX = 28;

export interface ModelAliasEntry {
  alias: string;
  provider: string;
  model: string;
  routeKey: string;
  displayName: string;
  createdAt: string;
}

export interface ModelAliasState {
  schemaVersion: 1;
  aliases: Record<string, ModelAliasEntry>;
}

export interface AliasSourceModel {
  provider: string;
  model: string;
}

function slugPart(value: string): string {
  const slug = value.toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "model";
}

/**
 * The hashless deterministic alias base. This is the id Claude Code shows for almost every model;
 * `computeModelAliases` appends a collision suffix only when two distinct route keys share a base.
 */
export function deterministicModelAlias(provider: string, model: string): string {
  return `${GATEWAY_MODEL_ALIAS_PREFIX}${slugPart(provider)}-${slugPart(model)}`;
}

function collisionSuffix(provider: string, model: string): string {
  return createHash("sha256").update(`${provider}/${model}`).digest("hex").slice(0, HASH_LEN);
}

/**
 * Deterministic alias per source model: the hashless base when unique within `models`, else
 * base + `-<hash6>` for every colliding route key. Returns routeKey → alias.
 */
export function computeModelAliases(models: AliasSourceModel[]): Map<string, string> {
  const routeKeys = new Map<string, AliasSourceModel>();
  for (const m of models) routeKeys.set(`${m.provider}/${m.model}`, m);
  const baseCounts = new Map<string, number>();
  for (const m of routeKeys.values()) {
    const base = deterministicModelAlias(m.provider, m.model);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [routeKey, m] of routeKeys) {
    const base = deterministicModelAlias(m.provider, m.model);
    out.set(routeKey, baseCounts.get(base)! > 1 ? `${base}-${collisionSuffix(m.provider, m.model)}` : base);
  }
  return out;
}


function readState(): ModelAliasState {
  const path = modelAliasesPath();
  if (!existsSync(path)) return { schemaVersion: 1, aliases: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelAliasState;
    if (parsed?.schemaVersion === 1 && parsed.aliases && typeof parsed.aliases === "object") return parsed;
  } catch { /* rebuild below */ }
  return { schemaVersion: 1, aliases: {} };
}

function writeState(state: ModelAliasState): void {
  ensureConfigDirForWrite("write model aliases");
  atomicWriteFile(modelAliasesPath(), JSON.stringify(state, null, 2) + "\n");
}

function makeEntry(provider: string, model: string, alias: string, existing?: ModelAliasEntry): ModelAliasEntry {
  const routeKey = `${provider}/${model}`;
  return {
    alias,
    provider,
    model,
    routeKey,
    displayName: routeKey,
    createdAt: existing?.createdAt ?? new Date(0).toISOString(),
  };
}

/**
 * Persist the alias registry for `models`. Two writer modes keep alias identity single-owner:
 *   - `prune:true` (canonical full-registry writer): recompute aliases over the FULL universe and
 *     DELETE any alias no longer present. Only this mode may drop another writer's aliases.
 *   - default (subset publisher): upsert the given models, NEVER delete other aliases, and REUSE an
 *     existing canonical alias already persisted for the same routeKey so published route identity
 *     never drifts when a collision-universe superset is absent from `models`.
 */
export function materializeModelAliases(models: AliasSourceModel[], options: { prune?: boolean } = {}): ModelAliasEntry[] {
  const state = readState();
  const aliases = computeModelAliases(models);
  const keep = new Set<string>();
  const entries: ModelAliasEntry[] = [];
  // Reverse index of persisted aliases by routeKey so a subset writer reuses the existing canonical
  // alias for a routeKey instead of minting a divergent (e.g. hashless) one.
  const existingByRouteKey = new Map<string, ModelAliasEntry>();
  for (const entry of Object.values(state.aliases)) existingByRouteKey.set(entry.routeKey, entry);
  for (const [routeKey, computedAlias] of aliases) {
    const slash = routeKey.indexOf("/");
    const provider = routeKey.slice(0, slash);
    const model = routeKey.slice(slash + 1);
    const preserved = options.prune ? undefined : existingByRouteKey.get(routeKey);
    const alias = preserved ? preserved.alias : computedAlias;
    const entry = makeEntry(provider, model, alias, state.aliases[alias]);
    state.aliases[alias] = entry;
    keep.add(alias);
    entries.push(entry);
  }
  // Pruning is the canonical writer's job only; subset publishers leave other writers' aliases intact.
  if (options.prune) {
    for (const alias of Object.keys(state.aliases)) {
      if (!keep.has(alias)) delete state.aliases[alias];
    }
  }
  writeState(state);
  return entries;
}

export function resolvePersistedModelAlias(alias: string): ModelAliasEntry | undefined {
  return readState().aliases[alias];
}

export function resolveConfiguredModelAlias(config: FrogConfig, alias: string): ModelAliasEntry | undefined {
  const persisted = resolvePersistedModelAlias(alias);
  if (persisted) return persisted;
  // Stateless fallback: recompute collision-aware aliases over every statically configured model.
  const candidates: AliasSourceModel[] = [];
  for (const [provider, cfg] of Object.entries(config.providers)) {
    const models = new Set<string>();
    if (cfg.defaultModel) models.add(cfg.defaultModel);
    for (const model of cfg.models ?? []) models.add(model);
    for (const model of models) candidates.push({ provider, model });
  }
  const aliases = computeModelAliases(candidates);
  for (const candidate of candidates) {
    const computed = aliases.get(`${candidate.provider}/${candidate.model}`);
    if (computed === alias) {
      return makeEntry(candidate.provider, candidate.model, computed ?? deterministicModelAlias(candidate.provider, candidate.model));
    }
  }
  return undefined;
}
