import { existsSync, statSync } from "node:fs";

import { restoreNativeClaudeCode } from "./claude-inject";
import { managedClaudeProfiles } from "./claude-profiles";
import { injectClaudeProjectSettings, restoreClaudeProjectSettings } from "./claude-settings";
import type { ClaudeProjectRecord, FrogConfig } from "./types";

/**
 * Claude Code routing lifecycle: keep on-disk routing state following the proxy lifecycle.
 *
 * The disk contract is:
 *   stopped / restored  => managed Claude homes AND enrolled project files are Claude-direct
 *   started / refreshed => every `enrolled:true` project is reapplied with the current port + carrier
 *
 * This module only COMPOSES the existing profile/project settings primitives. It never loads or saves
 * config and never logs; the CLI owns persistence and user-facing output. Enrollment intent
 * (`ClaudeProjectRecord.enrolled === true`) is durable across a temporary global stop/restore — only an
 * explicit per-project `frogp claude project restore` flips it to false.
 */

export interface RoutingLifecycleResult {
  /** True only when every managed home and enrolled project target succeeded. */
  success: boolean;
  /** One line per target, aggregated. Empty when there was nothing to do. */
  message: string;
}

/** Registry projects whose durable enrollment intent is currently on. */
export function enrolledClaudeProjects(config: FrogConfig): ClaudeProjectRecord[] {
  const registry = config.claudeProjects;
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.projects)) return [];
  return registry.projects.filter(project => project.enrolled === true);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Restore frogprogsy-owned routing so disk state follows a stopped/restored proxy: strip gateway
 * settings from every managed Claude home AND every enrolled project, leaving them Claude-direct.
 *
 * - Managed profile rows are marked `injected:false` on success (caller persists `config`).
 * - Enrolled projects keep `enrolled:true` — global restore preserves durable enrollment intent and
 *   never flips it; only explicit per-project restore does that.
 * - Unrelated user settings survive because the underlying restore functions replay per-target backups.
 * - A missing project directory is a failed restore target: cleanup cannot be verified, so callers surface it.
 * - Never throws for a single target; per-target results are aggregated into `{success,message}`.
 */
export function restoreManagedClaudeRouting(config: FrogConfig): RoutingLifecycleResult {
  const messages: string[] = [];
  let success = true;

  for (const profile of managedClaudeProfiles(config)) {
    const result = restoreNativeClaudeCode({ claudeHome: profile.claudeHome, profileId: profile.id });
    success = success && result.success;
    messages.push(`[${profile.name}] ${result.message}`);
    if (result.success) {
      profile.injected = false;
      profile.lastInjectedAt = new Date().toISOString();
    }
  }

  for (const project of enrolledClaudeProjects(config)) {
    if (!existsSync(project.projectPath)) {
      success = false;
      messages.push(`[project ${project.name}] Project path missing (${project.projectPath}); routing cleanup could not be verified and enrollment was retained.`);
      continue;
    }
    if (!isDirectory(project.projectPath)) {
      success = false;
      messages.push(`[project ${project.name}] Project path is not a directory (${project.projectPath}); enrollment retained.`);
      continue;
    }
    const result = restoreClaudeProjectSettings(project.projectPath);
    success = success && result.success;
    messages.push(`[project ${project.name}] ${result.message}`);
    // Intentionally NOT setting project.enrolled = false: durable enrollment intent survives restore.
  }

  return { success, message: messages.join("\n") };
}

/**
 * Reapply frogprogsy project-local gateway routing for every enrolled project using `port`, each
 * project's routing profile header, and the current `config.gatewayAuthCarrier`.
 *
 * - Token-free (the config default, absent carrier) migrates any stale sentinel project settings back
 *   to token-free by stripping the local discovery token; `"sentinel"` remains an explicit override.
 * - Missing/unwritable projects produce explicit failure/warning evidence in the aggregated result but
 *   never throw — one broken project must not prevent the proxy server itself from starting.
 * - Enrollment intent is unchanged; this only rewrites the on-disk project settings.
 */
export function reapplyEnrolledClaudeProjects(config: FrogConfig, port: number): RoutingLifecycleResult {
  const messages: string[] = [];
  let success = true;

  for (const project of enrolledClaudeProjects(config)) {
    if (!existsSync(project.projectPath)) {
      success = false;
      messages.push(`[project ${project.name}] Project path missing (${project.projectPath}); enrollment retained but gateway settings not reapplied.`);
      continue;
    }
    if (!isDirectory(project.projectPath)) {
      success = false;
      messages.push(`[project ${project.name}] Project path is not a directory (${project.projectPath}); enrollment retained but gateway settings not reapplied.`);
      continue;
    }
    const result = injectClaudeProjectSettings(port, {
      projectPath: project.projectPath,
      routingProfileId: project.routingProfileId,
      gatewayAuthCarrier: config.gatewayAuthCarrier,
    });
    success = success && result.success;
    messages.push(`[project ${project.name}] ${result.message}`);
  }

  return { success, message: messages.join("\n") };
}
