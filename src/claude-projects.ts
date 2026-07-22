import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, constants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ClaudeProjectRecord, FrogConfig } from "./types";


export type ClaudeProjectGitStatus = "tracked" | "ignored" | "excluded" | "untracked" | "not_git" | "unwritable";

export interface ClaudeProjectGitProtection {
  status: ClaudeProjectGitStatus;
  projectPath: string;
  settingsPath: string;
  warning?: string;
}

const PROJECT_SETTINGS_EXCLUDE_ENTRY = ".claude/settings.local.json";

export interface ClaudeProjectSummary extends ClaudeProjectRecord {
  gitProtection: ClaudeProjectGitProtection;
}

function canonicalProjectPath(projectPath: string): string {
  const resolved = resolve(projectPath.trim());
  if (!resolved) throw new Error("Claude project path is required");
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Claude project path is not a directory: ${resolved}`);
  return realpathSync.native(resolved);
}

function projectSettingsPath(projectPath: string): string {
  return join(projectPath, ".claude", "settings.local.json");
}

function runGit(projectPath: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", ["-c", "core.excludesFile=", "-C", projectPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function gitCommonDir(projectPath: string): string | null {
  const result = runGit(projectPath, ["rev-parse", "--git-common-dir"]);
  if (!result.ok) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return resolve(projectPath, raw);
}
function excludePath(projectPath: string): string | null {
  const commonDir = gitCommonDir(projectPath);
  return commonDir ? join(commonDir, "info", "exclude") : null;
}

function gitTopLevel(projectPath: string): string | null {
  const result = runGit(projectPath, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return resolve(projectPath, raw);
}

function runGitFromTopLevel(projectPath: string, args: string[]): { ok: boolean; stdout: string } {
  const topLevel = gitTopLevel(projectPath);
  return topLevel ? runGit(topLevel, args) : { ok: false, stdout: "" };
}

function settingsExcludeEntry(projectPath: string): string {
  const topLevel = gitTopLevel(projectPath);
  if (!topLevel) return PROJECT_SETTINGS_EXCLUDE_ENTRY;
  const entry = relative(topLevel, projectSettingsPath(projectPath)).split(sep).join("/");
  return entry && !entry.startsWith("..") ? entry : PROJECT_SETTINGS_EXCLUDE_ENTRY;
}

function excludeContainsExactEntry(path: string | null, entry: string): boolean {
  if (!path || !existsSync(path)) return false;
  return readFileSync(path, "utf8").split(/\r?\n/).some(line => line.trim() === entry);
}

function canWriteProjectSettings(projectPath: string): boolean {
  try {
    const claudeDir = join(projectPath, ".claude");
    const target = existsSync(claudeDir) ? claudeDir : projectPath;
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function canWriteExclude(path: string | null): boolean {
  if (!path) return false;
  try {
    const dir = dirname(path);
    accessSync(existsSync(path) ? path : dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function getClaudeProjectGitProtection(projectPathInput: string): ClaudeProjectGitProtection {
  const projectPath = canonicalProjectPath(projectPathInput);
  const settingsPath = projectSettingsPath(projectPath);
  if (!canWriteProjectSettings(projectPath)) {
    return { status: "unwritable", projectPath, settingsPath, warning: `Cannot write ${settingsPath}` };
  }

  if (!runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]).ok) {
    return { status: "not_git", projectPath, settingsPath, warning: "Project is not inside a git work tree; Claude project settings will not be auto-excluded." };
  }

  const gitSettingsPath = settingsExcludeEntry(projectPath);
  if (runGitFromTopLevel(projectPath, ["ls-files", "--error-unmatch", "--", gitSettingsPath]).ok) {
    return { status: "tracked", projectPath, settingsPath, warning: `${gitSettingsPath} is tracked by git; project enrollment is blocked by default.` };
  }

  const exclude = excludePath(projectPath);
  if (excludeContainsExactEntry(exclude, gitSettingsPath)) return { status: "excluded", projectPath, settingsPath };

  if (runGitFromTopLevel(projectPath, ["check-ignore", "--quiet", "--", gitSettingsPath]).ok) {
    return { status: "ignored", projectPath, settingsPath };
  }

  return { status: "untracked", projectPath, settingsPath };
}

export function ensureClaudeProjectSettingsExcluded(projectPathInput: string): ClaudeProjectGitProtection {
  const protection = getClaudeProjectGitProtection(projectPathInput);
  if (protection.status === "tracked") throw new Error(protection.warning ?? `${PROJECT_SETTINGS_EXCLUDE_ENTRY} is tracked by git`);
  if (protection.status === "unwritable") throw new Error(protection.warning ?? `Cannot write ${protection.settingsPath}`);
  if (protection.status !== "untracked") return protection;

  const exclude = excludePath(protection.projectPath);
  if (!exclude || !canWriteExclude(exclude)) {
    throw new Error("Cannot update .git/info/exclude for Claude project settings.");
  }
  mkdirSync(dirname(exclude), { recursive: true, mode: 0o700 });
  const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const entry = settingsExcludeEntry(protection.projectPath);
  if (!existing.split(/\r?\n/).some(line => line.trim() === entry)) {
    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    writeFileSync(exclude, `${prefix}${entry}\n`, { encoding: "utf8", mode: 0o600 });
  }
  const next = getClaudeProjectGitProtection(protection.projectPath);
  if (next.status !== "excluded" && next.status !== "ignored") {
    throw new Error(`Claude project settings are not protected after updating .git/info/exclude (status: ${next.status}).`);
  }
  return next;
}

export function createClaudeProjectId(existingIds: Iterable<string> = []): string {
  const used = new Set(existingIds);
  for (let i = 0; i < 16; i++) {
    const id = `cpr_${randomBytes(6).toString("hex")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("failed to create a unique Claude project id");
}

export function makeClaudeProject(input: { name?: string; projectPath: string; routingProfileId?: string; id?: string }, existingIds: Iterable<string> = []): ClaudeProjectRecord {
  const projectPath = canonicalProjectPath(input.projectPath);
  const name = (input.name?.trim() || basename(projectPath) || projectPath).trim();
  const id = input.id?.trim() || createClaudeProjectId(existingIds);
  if (!/^cpr_[a-z0-9]+$/i.test(id)) throw new Error("Claude project id must start with cpr_ and contain only letters/numbers");
  const routingProfileId = input.routingProfileId?.trim() || undefined;
  return {
    id,
    name,
    projectPath,
    ...(routingProfileId ? { routingProfileId } : {}),
  };
}

export function ensureClaudeProjects(config: FrogConfig): NonNullable<FrogConfig["claudeProjects"]> {
  const existing = config.claudeProjects;
  if (existing?.schemaVersion === 1 && Array.isArray(existing.projects)) {
    existing.projects = dedupeProjects(existing.projects);
    return existing;
  }
  config.claudeProjects = { schemaVersion: 1, projects: [] };
  return config.claudeProjects;
}

function dedupeProjects(projects: ClaudeProjectRecord[]): ClaudeProjectRecord[] {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const out: ClaudeProjectRecord[] = [];
  for (const project of projects) {
    try {
      const id = project.id?.trim();
      const name = project.name?.trim();
      const projectPath = project.projectPath ? canonicalProjectPath(project.projectPath) : "";
      if (!id || !name || !projectPath || seenIds.has(id) || seenPaths.has(projectPath)) continue;
      seenIds.add(id);
      seenPaths.add(projectPath);
      project.id = id;
      project.name = name;
      project.projectPath = projectPath;
      project.routingProfileId = project.routingProfileId?.trim() || undefined;
      out.push(project);
    } catch {
      continue;
    }
  }
  return out;
}

export function listClaudeProjects(config: FrogConfig): ClaudeProjectSummary[] {
  return ensureClaudeProjects(config).projects.map(project => ({
    ...project,
    gitProtection: getClaudeProjectGitProtection(project.projectPath),
  }));
}

export function resolveClaudeProject(config: FrogConfig, selector: string): ClaudeProjectRecord {
  const wanted = selector.trim();
  if (!wanted) throw new Error("Claude project selector is required");
  const projects = ensureClaudeProjects(config).projects;
  const byId = projects.find(project => project.id === wanted);
  if (byId) return byId;
  const byPath = projects.find(project => {
    try {
      return project.projectPath === canonicalProjectPath(wanted);
    } catch {
      return false;
    }
  });
  if (byPath) return byPath;
  const lowered = wanted.toLowerCase();
  const byName = projects.find(project => project.name.toLowerCase() === lowered);
  if (byName) return byName;
  throw new Error(`Unknown Claude project: ${wanted}`);
}

export function addClaudeProject(config: FrogConfig, input: { name?: string; projectPath: string; routingProfileId?: string; id?: string }, options: { protectGit?: boolean } = {}): ClaudeProjectRecord {
  const projects = ensureClaudeProjects(config);
  const project = makeClaudeProject(input, projects.projects.map(p => p.id));
  if (projects.projects.some(candidate => candidate.projectPath === project.projectPath)) {
    throw new Error(`Claude project already exists for ${project.projectPath}`);
  }
  if (options.protectGit !== false) ensureClaudeProjectSettingsExcluded(project.projectPath);
  projects.projects.push(project);
  return project;
}

export function removeClaudeProject(config: FrogConfig, selector: string): ClaudeProjectRecord {
  const projects = ensureClaudeProjects(config);
  const project = resolveClaudeProject(config, selector);
  projects.projects = projects.projects.filter(candidate => candidate.id !== project.id);
  return project;
}

export function markClaudeProjectEnrolled(config: FrogConfig, selector: string, enrolled = true): void {
  const project = resolveClaudeProject(config, selector);
  project.enrolled = enrolled;
  project.lastEnrolledAt = new Date().toISOString();
}

export function findClaudeProjectsForRoutingProfile(config: FrogConfig, routingProfileId: string): ClaudeProjectRecord[] {
  const wanted = routingProfileId.trim();
  if (!wanted) return [];
  return ensureClaudeProjects(config).projects.filter(project => project.routingProfileId === wanted);
}

export function clearClaudeProjectsForRoutingProfile(config: FrogConfig, routingProfileId: string): ClaudeProjectRecord[] {
  const cleared: ClaudeProjectRecord[] = [];
  for (const project of findClaudeProjectsForRoutingProfile(config, routingProfileId)) {
    delete project.routingProfileId;
    cleared.push(project);
  }
  return cleared;
}

