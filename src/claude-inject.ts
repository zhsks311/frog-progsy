import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile, websocketsEnabled } from "./config";
import { restoreClaudeCodeCatalog } from "./claude-catalog";
import { assertSafeClaudeHomeWrite, CLAUDE_HOME, claudeCatalogPath, claudeConfigTomlPath, claudeLegacyProfilePath, parseTomlString, readRootTomlString, resolveClaudeCodeConfigPath, tomlString } from "./claude-paths";
import { CLAUDE_SETTINGS_PATH, injectClaudeCodeSettings, restoreClaudeCodeSettings } from "./claude-settings";
import { invalidateClaudeCodeGatewayModelsCache } from "./claude-refresh";
import type { FrogConfig } from "./types";

const FROGP_SECTION_MARKER = "# Auto-injected by frogprogsy";

export interface InjectClaudeCodeOptions {
  /**
   * Absolute or CLAUDE_HOME-relative catalog path to advertise to Claude Code. Pass `null` only when the
   * frogprogsy catalog could not be materialized; Claude Code will then keep its native catalog instead of
   * failing on a missing model_catalog_json file.
   */
  catalogPath?: string | null;
  claudeHome?: string;
  profileId?: string;
  includeAuthToken?: boolean;
}

/**
 * The `[model_providers.frogprogsy]` TABLE only. A table is position-independent in TOML, so it is
 * safe to append at EOF. The bare root key `model_provider = "frogprogsy"` is NOT included here —
 * it must live at the document root (before any table header) and is set separately by
 * setRootModelProvider(). Appending the bare key at EOF was the original bug: it nested under
 * whatever `[table]` happened to be open last (e.g. `[plugins."chrome@openai-bundled"]`), so Claude Code
 * never saw a global model_provider and silently fell back to the `openai` (ChatGPT) provider.
 */
export function buildProviderTableBlock(port: number, _supportsWebsockets = false): string {
  const lines = [
    "",
    FROGP_SECTION_MARKER,
    "[model_providers.frogprogsy]",
    'name = "FrogProgsy Proxy"',
    `base_url = "http://localhost:${port}/v1"`,
    'wire_api = "messages"',
    "requires_openai_auth = true",
  ];
  // Responses WebSocket support is retired for the Claude Messages data plane.
  return lines.join("\n") + "\n";
}

/**
 * Strip every existing `model_provider` line that we must not duplicate: any line set to
 * "frogprogsy" (wherever it sits — including a previously mis-nested one under a table), plus any
 * ROOT-level model_provider (before the first table) of any value, since we override the global.
 * A `model_provider` legitimately inside a user table/profile with a non-frogprogsy value is left
 * untouched.
 */
function stripExistingModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*model_provider\s*=/.test(line)) {
      const isOurs = /^\s*model_provider\s*=\s*"frogprogsy"\s*$/.test(line);
      const isRoot = firstTable === -1 || i < firstTable;
      if (isOurs || isRoot) return; // drop it
    }
    out.push(line);
  });
  return out.join("\n");
}

function stripRootContextWindowOverrides(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      return !isRoot || !/^\s*model_(?:context_window|auto_compact_token_limit)\s*=/.test(line);
    })
    .join("\n");
}

function stripRootRoutedModel(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      if (!isRoot) return true;
      const m = line.match(/^\s*model\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
      if (!m) return true;
      const model = parseTomlString(m[1]);
      return !model?.includes("/");
    })
    .join("\n");
}

/**
 * Insert `model_provider = "frogprogsy"` at the document ROOT — immediately before the first table
 * header (TOML root keys must precede all tables). If there are no tables, append it to the root body.
 */
function setRootModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const key = 'model_provider = "frogprogsy"';
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function readRootModelCatalogPath(content: string): string | null {
  return readRootTomlString(content, "model_catalog_json");
}

function setRootModelCatalogPath(content: string, catalogPath: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const key = `model_catalog_json = ${tomlString(catalogPath)}`;
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < rootEnd; i++) {
    const m = lines[i].match(/^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
    if (!m) continue;
    const existing = parseTomlString(m[1]);
    if (isFrogProgsyCatalogPath(existing)) {
      lines[i] = key;
      return lines.join("\n");
    }
    return content;
  }
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function removeProfileSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inProfile = false;
  for (const line of lines) {
    if (line.trim() === "[profiles.frogprogsy]") {
      inProfile = true;
      continue;
    }
    if (inProfile) {
      if (line.startsWith("[") && line.trim() !== "[profiles.frogprogsy]") {
        inProfile = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function normalizeServiceTier(content: string): string {
  return content.replace(/^(\s*service_tier\s*=\s*)["']priority["']\s*$/gm, '$1"fast"');
}

function ensureFastModeFeature(content: string): string {
  const lines = content.split("\n");
  const featuresStart = lines.findIndex(line => line.trim() === "[features]");
  if (featuresStart === -1) {
    return content.trimEnd() + "\n\n[features]\nfast_mode = true\n";
  }

  const nextTable = lines.findIndex((line, index) => index > featuresStart && /^\s*\[/.test(line));
  const featuresEnd = nextTable === -1 ? lines.length : nextTable;
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (/^\s*fast_mode\s*=/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*)fast_mode\s*=.*$/, "$1fast_mode = true");
      return lines.join("\n");
    }
  }

  let insertAt = featuresEnd;
  while (insertAt > featuresStart + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, "fast_mode = true");
  return lines.join("\n");
}

function isFrogProgsyCatalogPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").pop() === "frogprogsy-catalog.json";
}

function stripFrogProgsyCatalogPath(content: string): string {
  return content
    .split("\n")
    .filter(line => {
      const m = line.match(/^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
      return !m || !isFrogProgsyCatalogPath(parseTomlString(m[1]));
    })
    .join("\n");
}

export function buildProfileFile(port: number, catalogPath?: string | null): string {
  const lines = [
    "# FrogProgsy proxy profile — use with: claude --profile frogprogsy",
    `# Routes all model requests through the frogprogsy proxy at localhost:${port}`,
    'model_provider = "frogprogsy"',
  ];
  if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
  lines.push("", "[features]", "fast_mode = true", "");
  return lines.join("\n");
}

export function chooseCatalogPathForInjection(content: string, requested?: string | null, claudeHome = CLAUDE_HOME): string | null {
  if (requested !== undefined) return requested;

  const existing = readRootModelCatalogPath(content);
  if (existing) {
    const resolved = resolveClaudeCodeConfigPath(existing, claudeHome);
    if (!isFrogProgsyCatalogPath(resolved) || existsSync(resolved)) return existing;
  }

  const defaultCatalogPath = claudeCatalogPath(claudeHome);
  return existsSync(defaultCatalogPath) ? defaultCatalogPath : null;
}

export async function injectClaudeCodeConfig(port: number, config?: FrogConfig, options: InjectClaudeCodeOptions = {}): Promise<{ success: boolean; message: string }> {
  const sentinelCarrier = options.includeAuthToken === true || config?.gatewayAuthCarrier === "sentinel";
  const injected = injectClaudeCodeSettings(port, {
    claudeHome: options.claudeHome,
    profileId: options.profileId,
    includeAuthToken: options.includeAuthToken,
    gatewayAuthCarrier: config?.gatewayAuthCarrier,
  });
  if (!injected.success) return injected;

  const authLine = sentinelCarrier
    ? "  Local gateway auth token injected into settings (sentinel carrier) — an explicit rollback / global-discovery override, not the default; frogprogsy strips it before upstream forwarding. Default launches are token-free.\n"
    : "  Token-free by default: native claude.ai OAuth/connectors pass through untouched and managed frogprogsy launchers run without a local token. For ordinary raw `claude` in a repository use `frogp claude project enroll [path]`. Sentinel token injection is an explicit rollback only, via gatewayAuthCarrier:\"sentinel\" or --global-discovery-auth.\n";

  return {
    success: true,
    message: `${injected.message}\n` +
      `  Claude Code gateway discovery enabled with ANTHROPIC_BASE_URL=http://localhost:${port}.\n` +
      authLine +
      (options.profileId ? `  Claude Code home header injected as X-Frogp-Claude-Profile: ${options.profileId}.\n` : "") +
      `  Claude Code model catalog injection via config.toml is retired; /v1/models discovery and frogprogsy aliases are used instead.\n` +
      `  Claude Code resume history remapping is retired/no-op; existing history is left unchanged.\n` +
      `  Restore with: frogp restore, frogp stop, frogp uninstall, or frogp claude restore <home>.`,
  };
}

function removeFrogSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inFrogSection = false;
  for (const line of lines) {
    if (line.includes(FROGP_SECTION_MARKER) || line.trim() === "[model_providers.frogprogsy]") {
      inFrogSection = true;
      continue;
    }
    if (inFrogSection) {
      // End the injected section at the next table header that ISN'T our own — exact match so a
      // user's "[model_providers.frogprogsy_backup]" (or similar) is preserved, not swallowed.
      if (line.startsWith("[") && line.trim() !== "[model_providers.frogprogsy]") {
        inFrogSection = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Pure transform: strip the frogprogsy provider block + `model_provider = "frogprogsy"` lines. */
export function stripFrogProgsyConfig(content: string): string {
  let out = content;
  if (out.includes("[model_providers.frogprogsy]")) {
    out = removeFrogSection(out);
  }
  out = removeProfileSection(out);
  // Regex (not exact-string) removal so compact `model_provider="frogprogsy"` is stripped too —
  // must match the detection regex above, or a detected line could survive un-removed.
  out = out.split("\n").filter(l => !/^\s*model_provider\s*=\s*"frogprogsy"\s*$/.test(l)).join("\n");
  out = stripRootContextWindowOverrides(out);
  out = stripRootRoutedModel(out);
  out = stripFrogProgsyCatalogPath(out);
  return out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function restoreClaudeCodeTomlConfig(options: { claudeHome?: string } = {}): { success: boolean; message: string; changed: boolean } {
  try {
    const claudeHome = options.claudeHome ?? CLAUDE_HOME;
    const configTomlPath = claudeConfigTomlPath(claudeHome);
    const legacyProfilePath = claudeLegacyProfilePath(claudeHome);
    let changed = false;
    if (existsSync(configTomlPath)) {
      const content = readFileSync(configTomlPath, "utf-8");
      const stripped = stripFrogProgsyConfig(content);
      if (stripped !== content) {
        assertSafeClaudeHomeWrite("restore Claude config.toml", configTomlPath);
        atomicWriteFile(configTomlPath, stripped);
        changed = true;
      }
    }
    if (existsSync(legacyProfilePath)) {
      assertSafeClaudeHomeWrite("remove legacy Claude config", legacyProfilePath);
      unlinkSync(legacyProfilePath);
      changed = true;
    }
    return {
      success: true,
      changed,
      message: changed ? `Restored Claude Code config.toml at ${configTomlPath}.` : "",
    };
  } catch (err) {
    return { success: false, changed: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function removeClaudeCodeConfig(options: { claudeHome?: string; profileId?: string } = {}): { success: boolean; message: string } {
  const settings = restoreClaudeCodeSettings(options);
  const toml = restoreClaudeCodeTomlConfig(options);
  const cache = invalidateClaudeCodeGatewayModelsCache({ claudeHome: options.claudeHome });
  const cacheMessage = cache.deleted
    ? ` Removed Claude Code gateway models cache at ${cache.path}.`
    : cache.warning
      ? ` ${cache.warning}`
      : "";
  return {
    success: settings.success && toml.success && !cache.warning,
    message: `${settings.message}${toml.message ? ` ${toml.message}` : ""}${cacheMessage}`,
  };
}

/**
 * Recover native Claude Code: strip frogprogsy from config.toml AND drop proxy-routed catalog entries,
 * so plain `claude` works when the proxy is stopped. Called by `frogp stop`, the proxy shutdown
 * handler, and `frogp restore`. Idempotent + atomic.
 */
export function restoreNativeClaudeCode(options: { claudeHome?: string; profileId?: string } = {}): { success: boolean; message: string } {
  const settings = restoreClaudeCodeSettings(options);
  const toml = restoreClaudeCodeTomlConfig(options);
  const cat = restoreClaudeCodeCatalog({ claudeHome: options.claudeHome });
  const cache = invalidateClaudeCodeGatewayModelsCache({ claudeHome: options.claudeHome });
  const catalogMsg = cat.removed > 0
    ? ` Catalog restored to ${cat.kept} native model(s) (dropped ${cat.removed} proxy-routed).`
    : "";
  const cacheMsg = cache.deleted
    ? ` Removed Claude Code gateway models cache at ${cache.path}.`
    : cache.warning
      ? ` ${cache.warning}`
      : "";
  return {
    success: settings.success && toml.success && !cache.warning,
    message: `${settings.message}${toml.message ? ` ${toml.message}` : ""}${catalogMsg}${cacheMsg}`,
  };
}

export function getClaudeCodeConfigPath(): string {
  return CLAUDE_SETTINGS_PATH;
}
