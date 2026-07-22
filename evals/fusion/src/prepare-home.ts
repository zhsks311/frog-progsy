import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FrogConfig } from "../../../src/types";
import { parseEvalTasksJsonl, validateEvalProfile } from "./schema";
import { hasFlag, parseFlags, requireString } from "./cli-utils";

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function redactSecrets(value: unknown, keyPath = ""): unknown {
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, keyPath));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const path = keyPath ? `${keyPath}.${key}` : key;
      if (/(api[-_]?key|token|secret|password|credential|authorization|auth)$/i.test(key) || /(apiKey|access|refresh)$/i.test(key)) {
        out[key] = typeof child === "string" && child.length > 0 ? "[REDACTED]" : child;
      } else {
        out[key] = redactSecrets(child, path);
      }
    }
    return out;
  }
  return value;
}

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read JSON ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

async function canonicalizeStartupConfig(config: FrogConfig, outDir: string): Promise<FrogConfig> {
  const priorHome = process.env.FROGPROGSY_HOME;
  process.env.FROGPROGSY_HOME = outDir;
  try {
    // Mirrors src/server.ts:2057-2081 startServer startup back-fill without importing src/cli.ts:
    // runtime fixture removal, OAuth provider preset reconcile, subagent seed, classifier back-fill.
    const [{ DEFAULT_SUBAGENT_MODELS, dropRuntimeFixtureProviders }, { reconcileOAuthProviders }, { getProviderRegistryEntry }] = await Promise.all([
      import("../../../src/config"),
      import("../../../src/oauth/index"),
      import("../../../src/providers/registry"),
    ]);

    dropRuntimeFixtureProviders(config);

    const configPath = `${outDir.replace(/\/$/, "")}/config.json`;
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, stableJson(config), { encoding: "utf8", mode: 0o600 });
    reconcileOAuthProviders(config);

    if (config.subagentModels === undefined) {
      config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
    }

    for (const [name, provider] of Object.entries(config.providers ?? {})) {
      if (provider.classifierModel) continue;
      const seed = getProviderRegistryEntry(name)?.classifierModel;
      if (seed) provider.classifierModel = seed;
    }
    return config;
  } finally {
    if (priorHome === undefined) delete process.env.FROGPROGSY_HOME;
    else process.env.FROGPROGSY_HOME = priorHome;
  }
}

export async function runCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const basePath = requireString(flags, "base");
  const overlayPath = requireString(flags, "overlay");
  const suitePath = requireString(flags, "suite");
  const outDir = resolve(requireString(flags, "out"));
  const snapshotPath = requireString(flags, "snapshot");
  const hashOutPath = requireString(flags, "hash-out");

  const base = readJson(basePath) as FrogConfig;
  const overlay = validateEvalProfile(readJson(overlayPath), overlayPath);
  parseEvalTasksJsonl(readFileSync(suitePath, "utf8"), suitePath);

  const config: FrogConfig = JSON.parse(JSON.stringify(base));
  if (overlay.modelMixing !== undefined) {
    config.modelMixing = overlay.modelMixing as FrogConfig["modelMixing"];
  }

  if (hasFlag(flags, "canonicalize-startup")) {
    await canonicalizeStartupConfig(config, outDir);
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const canonicalBytes = stableJson(config);
  writeFileSync(`${outDir}/config.json`, canonicalBytes, { encoding: "utf8", mode: 0o600 });
  // NOTE: auth.json is deliberately NOT copied into the isolated home. OAuth refresh tokens
  // rotate on use, so a copy forks the token chain and invalidates the real login. The serve
  // subcommand shares the live auth store via --auth-file / FROGPROGSY_AUTH_FILE instead.
  ensureParent(snapshotPath);
  writeFileSync(snapshotPath, stableJson(redactSecrets(config)), { encoding: "utf8", mode: 0o600 });
  ensureParent(hashOutPath);
  writeFileSync(hashOutPath, `${sha256(canonicalBytes)}\n`, { encoding: "utf8", mode: 0o600 });
  return 0;
}
