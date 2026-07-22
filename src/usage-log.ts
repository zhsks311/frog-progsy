import { chmodSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigDirForWrite, getConfigDir } from "./config";
import type { FrogUsage } from "./types";

export type UsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

export interface PersistedUsageEntry {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  resolvedModel?: string;
  status: number;
  durationMs: number;
  usageStatus: UsageStatus;
  usage?: FrogUsage;
  totalTokens?: number;
  /** Primary local request by default; future shadow comparison writes can mark shadow usage for exclusion from display pricing. */
  source?: "primary" | "shadow";
}

export function usageLogPath(): string {
  return join(getConfigDir(), "usage.jsonl");
}

export function usageTotalTokens(usage: FrogUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return usage.inputTokens + usage.outputTokens;
}

export function usageStatusForFinalLog(usage: FrogUsage | undefined): UsageStatus {
  return usage ? "reported" : "unreported";
}

function ensureUsageLogDir(): void {
  ensureConfigDirForWrite("append usage log");
}

export function appendUsageEntry(entry: PersistedUsageEntry): void {
  ensureUsageLogDir();
  const path = usageLogPath();
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function readUsageEntries(): PersistedUsageEntry[] {
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedUsageEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") entries.push(parsed);
    } catch {
      /* keep reading after a partially written or hand-edited line */
    }
  }
  return entries;
}
