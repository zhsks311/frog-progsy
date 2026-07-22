import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GUI_BUILD_STATUS = ["ok", "missing", "malformed", "version-mismatch", "source-mismatch-dev"] as const;
export type GuiBuildStatus = typeof GUI_BUILD_STATUS[number];

export interface GuiBuildMeta {
  schemaVersion: 1;
  appBuildId: string;
  version: string;
  generatedAt: string;
  sourceHash?: string;
}

export interface GuiBuildIdentity {
  serverBuildId: string;
  guiBuildId: string | null;
  guiBuildStatus: GuiBuildStatus;
}

function isGuiBuildMeta(value: unknown): value is GuiBuildMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Partial<GuiBuildMeta>;
  return meta.schemaVersion === 1
    && typeof meta.appBuildId === "string"
    && meta.appBuildId.length > 0
    && typeof meta.version === "string"
    && meta.version.length > 0
    && typeof meta.generatedAt === "string"
    && meta.generatedAt.length > 0
    && (meta.sourceHash === undefined || typeof meta.sourceHash === "string");
}

export function readGuiBuildMeta(guiDist: string | null | undefined): GuiBuildMeta | null | "malformed" {
  if (!guiDist) return null;
  const metaPath = join(guiDist, "build-meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    return isGuiBuildMeta(parsed) ? parsed : "malformed";
  } catch {
    return "malformed";
  }
}

export function findGuiDistFromModuleDir(moduleDir: string): string | null {
  const candidates = [
    join(moduleDir, "..", "gui", "dist"),
    join(moduleDir, "..", "..", "gui", "dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export function resolveGuiBuildIdentity(guiDist: string | null | undefined, expectedVersion: string, serverBuildId: string): GuiBuildIdentity {
  const meta = readGuiBuildMeta(guiDist);
  if (meta === null) return { serverBuildId, guiBuildId: null, guiBuildStatus: "missing" };
  if (meta === "malformed") return { serverBuildId, guiBuildId: null, guiBuildStatus: "malformed" };
  if (meta.version !== expectedVersion) {
    return { serverBuildId, guiBuildId: meta.appBuildId, guiBuildStatus: "version-mismatch" };
  }
  return { serverBuildId, guiBuildId: meta.appBuildId, guiBuildStatus: "ok" };
}

export function formatGuiBuildWarning(identity: GuiBuildIdentity): string | null {
  if (identity.guiBuildStatus === "ok") return null;
  switch (identity.guiBuildStatus) {
    case "missing":
      return "GUI build metadata is missing; run: bun run build:gui (or frogp refresh after updating).";
    case "malformed":
      return "GUI build metadata is unreadable; rebuild the dashboard with: bun run build:gui.";
    case "version-mismatch":
      return "GUI build metadata version does not match this server; run: frogp refresh.";
    case "source-mismatch-dev":
      return "GUI build metadata is stale for the current source tree; run: bun run build:gui.";
    default:
      return null;
  }
}
