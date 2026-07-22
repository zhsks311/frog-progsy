#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "frogprogsy";
const MANIFEST_SCHEMA_VERSION = 1;
const INSTALLED_MANIFEST = ".frogprogsy-dev-build.json";
const LATEST_LOCK_WAIT_MS = 10_000;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export interface DevBuildManifest {
  schemaVersion: 1;
  buildId: string;
  version: string;
  gitCommit: string;
  gitBranch: string;
  gitDirty: boolean;
  completedAt: string;
  tarballFile: string;
  tarballSha256: string;
  tarballBytes: number;
}

export interface InstalledDevBuildManifest extends DevBuildManifest {
  installedAt: string;
}

export type DevInstallState = "not-installed" | "untracked" | "current" | "outdated" | "installed-no-latest";

export interface DevPackageStatus {
  state: DevInstallState;
  latest: DevBuildManifest | null;
  installed: InstalledDevBuildManifest | null;
  installedPackageRoot: string | null;
}

function commandResult(command: string, args: string[], cwd = REPO_ROOT): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
  }
  return result.stdout.trim();
}

function run(command: string, args: string[], cwd = REPO_ROOT): void {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status ?? "?"})`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function packageVersion(): string {
  const pkg = readJson<{ name?: string; version?: string }>(join(REPO_ROOT, "package.json"));
  if (pkg.name !== PACKAGE_NAME || typeof pkg.version !== "string" || !pkg.version) {
    throw new Error(`package.json must identify ${PACKAGE_NAME} with a non-empty version`);
  }
  return pkg.version;
}

export function isDevBuildManifest(value: unknown): value is DevBuildManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === MANIFEST_SCHEMA_VERSION
    && typeof row.buildId === "string"
    && BUILD_ID_PATTERN.test(row.buildId)
    && typeof row.version === "string"
    && typeof row.gitCommit === "string"
    && typeof row.gitBranch === "string"
    && typeof row.gitDirty === "boolean"
    && typeof row.completedAt === "string"
    && Number.isFinite(Date.parse(row.completedAt))
    && typeof row.tarballFile === "string"
    && row.tarballFile.length > 0
    && !isAbsolute(row.tarballFile)
    && !row.tarballFile.split(/[\\/]+/).includes("..")
    && typeof row.tarballSha256 === "string"
    && /^[a-f0-9]{64}$/.test(row.tarballSha256)
    && typeof row.tarballBytes === "number"
    && Number.isSafeInteger(row.tarballBytes)
    && row.tarballBytes > 0;
}

function readManifest(path: string): DevBuildManifest | null {
  if (!existsSync(path)) return null;
  try {
    const value = readJson<unknown>(path);
    return isDevBuildManifest(value) ? value : null;
  } catch {
    return null;
  }
}

function readInstalledManifest(path: string): InstalledDevBuildManifest | null {
  if (!existsSync(path)) return null;
  try {
    const value = readJson<unknown>(path);
    if (!isDevBuildManifest(value)) return null;
    const installedAt = (value as Record<string, unknown>).installedAt;
    if (typeof installedAt !== "string" || !Number.isFinite(Date.parse(installedAt))) return null;
    return { ...value, installedAt } as InstalledDevBuildManifest;
  } catch {
    return null;
  }
}

export function compareBuildCompletion(a: DevBuildManifest, b: DevBuildManifest): number {
  const time = Date.parse(a.completedAt) - Date.parse(b.completedAt);
  return time !== 0 ? time : a.buildId.localeCompare(b.buildId);
}

export function chooseLatestBuild(
  current: DevBuildManifest | null,
  candidate: DevBuildManifest,
): DevBuildManifest {
  return current && compareBuildCompletion(current, candidate) > 0 ? current : candidate;
}

function gitCommonDir(): string {
  const configured = process.env.FROGPROGSY_DEV_PACKAGE_HOME?.trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
  const common = commandResult("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return join(common, "frogprogsy-dev-packages");
}

function buildDir(root: string, buildId: string): string {
  if (!BUILD_ID_PATTERN.test(buildId)) throw new Error(`Invalid dev build id: ${buildId}`);
  const path = resolve(root, "builds", buildId);
  const expectedParent = resolve(root, "builds");
  if (dirname(path) !== expectedParent) throw new Error(`Dev build escaped the build root: ${buildId}`);
  return path;
}

function tarballPath(root: string, manifest: DevBuildManifest): string {
  const path = resolve(root, manifest.tarballFile);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Invalid dev tarball path for ${manifest.buildId}`);
  return path;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}


async function acquireLatestLock(root: string): Promise<{ path: string; token: string }> {
  mkdirSync(root, { recursive: true });
  const path = join(root, ".latest.lock");
  const ownerPath = join(path, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + LATEST_LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      mkdirSync(path);
      atomicWriteJson(ownerPath, { pid: process.pid, token, createdAt: new Date().toISOString() });
      return { path, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await Bun.sleep(50);
    }
  }
  throw new Error(
    `Timed out waiting for the shared dev-build latest lock at ${path}. `
    + "A crashed writer may have left it behind; remove it only after verifying its owner process is gone.",
  );
}

function releaseLatestLock(lock: { path: string; token: string }): void {
  try {
    const owner = readJson<{ token?: unknown }>(join(lock.path, "owner.json"));
    if (owner.token === lock.token) rmSync(lock.path, { recursive: true, force: true });
  } catch {
    // Never remove a lock whose ownership cannot be proven.
  }
}

export async function recordLatest(root: string, candidate: DevBuildManifest): Promise<DevBuildManifest> {
  const lock = await acquireLatestLock(root);
  try {
    const latestPath = join(root, "latest.json");
    const current = readManifest(latestPath);
    const selected = chooseLatestBuild(current, candidate);
    if (!current || selected.buildId !== current.buildId) atomicWriteJson(latestPath, selected);
    return selected;
  } finally {
    releaseLatestLock(lock);
  }
}

function resolveBuild(root: string, selector?: string): DevBuildManifest {
  const manifest = selector
    ? readManifest(join(buildDir(root, selector), "manifest.json"))
    : readManifest(join(root, "latest.json"));
  if (!manifest) throw new Error(selector ? `Unknown dev build: ${selector}` : "No completed dev build exists. Run `bun run dev:package build` first.");
  return manifest;
}

function stagePackageTree(staging: string): string {
  const packageRoot = join(staging, "package-root");
  mkdirSync(packageRoot, { recursive: true });

  for (const file of ["package.json", "README.md", "LICENSE"]) {
    const source = join(REPO_ROOT, file);
    if (!existsSync(source)) throw new Error(`Required package file is missing: ${file}`);
    cpSync(source, join(packageRoot, file));
  }
  cpSync(join(REPO_ROOT, "src"), join(packageRoot, "src"), { recursive: true });

  const guiDist = join(REPO_ROOT, "gui", "dist");
  if (!existsSync(join(guiDist, "index.html")) || !existsSync(join(guiDist, "build-meta.json"))) {
    throw new Error("GUI build output is missing. Run `bun run build:gui` before packing.");
  }
  cpSync(guiDist, join(packageRoot, "gui", "dist"), { recursive: true });
  return packageRoot;
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

async function buildPackage(skipGates: boolean): Promise<DevBuildManifest> {
  if (!skipGates) {
    run("bun", ["install", "--frozen-lockfile"]);
    run("bun", ["run", "typecheck"]);
    run("bun", ["run", "test"]);
    run("bun", ["run", "build:gui"]);
  }

  const root = gitCommonDir();
  const version = packageVersion();
  const staging = join(root, "staging", `${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  const packageRoot = stagePackageTree(staging);
  const stagedTarball = join(staging, `${PACKAGE_NAME}-${version}.tgz`);

  try {
    run("bun", ["pm", "pack", "--destination", staging, "--quiet"], packageRoot);
    if (!existsSync(stagedTarball)) throw new Error(`bun pm pack completed without creating ${PACKAGE_NAME}-${version}.tgz`);

    const completedAt = new Date().toISOString();
    const digest = await sha256(stagedTarball);
    const commit = commandResult("git", ["rev-parse", "--short=12", "HEAD"]);
    const branch = commandResult("git", ["branch", "--show-current"]) || "detached";
    const dirty = commandResult("git", ["status", "--porcelain", "--untracked-files=no"]).length > 0;
    const buildId = `${version}-g${commit}-${compactTimestamp(new Date(completedAt))}-${digest.slice(0, 12)}`;
    const finalDir = buildDir(root, buildId);
    mkdirSync(dirname(finalDir), { recursive: true });
    mkdirSync(finalDir);
    const finalTarball = join(finalDir, `${PACKAGE_NAME}-${buildId}.tgz`);
    renameSync(stagedTarball, finalTarball);

    const manifest: DevBuildManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      buildId,
      version,
      gitCommit: commit,
      gitBranch: branch,
      gitDirty: dirty,
      completedAt,
      tarballFile: relative(root, finalTarball),
      tarballSha256: digest,
      tarballBytes: statSync(finalTarball).size,
    };
    atomicWriteJson(join(finalDir, "manifest.json"), manifest);
    const latest = await recordLatest(root, manifest);
    console.log(`\n✅ Dev package built: ${buildId}`);
    console.log(`   tarball: ${finalTarball}`);
    console.log(`   latest: ${latest.buildId}`);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function bunBinDir(): string {
  return commandResult("bun", ["pm", "bin", "-g"]);
}

function packageRootFromBin(binPath: string): string | null {
  if (!existsSync(binPath)) return null;
  try {
    const target = realpathSync(binPath);
    const root = dirname(dirname(target));
    const pkg = readJson<{ name?: string }>(join(root, "package.json"));
    return pkg.name === PACKAGE_NAME ? root : null;
  } catch {
    return null;
  }
}

function packageRootForCommand(binDir: string, command: "frogp" | "claude"): string | null {
  for (const name of [command, `${command}.exe`, `${command}.cmd`]) {
    const root = packageRootFromBin(join(binDir, name));
    if (root) return root;
  }
  return null;
}

export function classifyDevInstall(
  latest: DevBuildManifest | null,
  installed: InstalledDevBuildManifest | null,
  packagePresent: boolean,
): DevInstallState {
  if (!packagePresent) return "not-installed";
  if (!installed) return "untracked";
  if (!latest) return "installed-no-latest";
  return latest.buildId === installed.buildId ? "current" : "outdated";
}

function currentStatus(root = gitCommonDir()): DevPackageStatus {
  const latest = readManifest(join(root, "latest.json"));
  const installedPackageRoot = packageRootForCommand(bunBinDir(), "frogp");
  const installed = installedPackageRoot ? readInstalledManifest(join(installedPackageRoot, INSTALLED_MANIFEST)) : null;
  return {
    state: classifyDevInstall(latest, installed, installedPackageRoot !== null),
    latest,
    installed,
    installedPackageRoot,
  };
}

function cleanupBrokenBunLinks(): void {
  const binDir = bunBinDir();
  for (const command of ["frogp", "claude"] as const) {
    for (const name of [command, `${command}.exe`, `${command}.cmd`]) {
      const path = join(binDir, name);
      if (!existsSync(path)) {
        try {
          if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
        } catch {
          // Absent is the desired state.
        }
      }
    }
  }
}

function removeBunPackageOnly(): void {
  const binDir = bunBinDir();
  const root = packageRootForCommand(binDir, "frogp");
  if (root && !root.includes(`${join("node_modules", PACKAGE_NAME)}`)) {
    run("bun", ["unlink", "--cwd", root]);
  }
  const result = spawnSync("bun", ["remove", "-g", PACKAGE_NAME], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0 && packageRootForCommand(binDir, "frogp")) {
    throw new Error(`bun remove -g ${PACKAGE_NAME} failed (exit ${result.status ?? "?"})`);
  }
  cleanupBrokenBunLinks();
}

async function verifyTarball(root: string, manifest: DevBuildManifest): Promise<string> {
  const path = tarballPath(root, manifest);
  if (!existsSync(path)) throw new Error(`Dev tarball is missing for ${manifest.buildId}`);
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const confined = relative(realRoot, realPath);
  if (!confined || confined.startsWith("..") || isAbsolute(confined)) {
    throw new Error(`Dev tarball escaped the shared build root for ${manifest.buildId}`);
  }
  const stats = statSync(realPath);
  if (!stats.isFile() || stats.size !== manifest.tarballBytes) throw new Error(`Dev tarball size mismatch for ${manifest.buildId}`);
  const digest = await sha256(realPath);
  if (digest !== manifest.tarballSha256) throw new Error(`Dev tarball hash mismatch for ${manifest.buildId}`);
  return realPath;
}

function preflightTarballInstall(cacheRoot: string, tarball: string): void {
  const staging = join(cacheRoot, "install-preflight", `${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  atomicWriteJson(join(staging, "package.json"), {
    name: "frogprogsy-dev-install-preflight",
    private: true,
    version: "0.0.0",
  });
  try {
    run("bun", ["add", "--no-save", "--ignore-scripts", tarball], staging);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

type PreviousGlobalInstall =
  | { kind: "source"; packageRoot: string }
  | { kind: "dev"; manifest: InstalledDevBuildManifest; tarball: string }
  | { kind: "untracked"; version: string }
  | null;

async function capturePreviousInstall(cacheRoot: string): Promise<PreviousGlobalInstall> {
  const packageRoot = packageRootForCommand(bunBinDir(), "frogp");
  if (!packageRoot) return null;
  if (!packageRoot.includes(join("node_modules", PACKAGE_NAME))) {
    return { kind: "source", packageRoot };
  }
  const manifest = readInstalledManifest(join(packageRoot, INSTALLED_MANIFEST));
  if (!manifest) {
    const pkg = readJson<{ name?: string; version?: string }>(join(packageRoot, "package.json"));
    if (pkg.name !== PACKAGE_NAME || typeof pkg.version !== "string" || !pkg.version) {
      throw new Error("The active global frogprogsy package has no restorable version");
    }
    return { kind: "untracked", version: pkg.version };
  }
  return { kind: "dev", manifest, tarball: await verifyTarball(cacheRoot, manifest) };
}

function verifyInstalledPackageVersion(version: string): string {
  const binDir = bunBinDir();
  const packageRoot = packageRootForCommand(binDir, "frogp");
  if (!packageRoot) throw new Error("Bun reported success but the installed frogp binary is not owned by frogprogsy");
  if (!packageRoot.includes(join("node_modules", PACKAGE_NAME))) {
    throw new Error("Bun did not replace the active source link with the packaged build");
  }
  const pkg = readJson<{ name?: string; version?: string }>(join(packageRoot, "package.json"));
  if (pkg.name !== PACKAGE_NAME || pkg.version !== version) {
    throw new Error(`Installed package identity mismatch for frogprogsy@${version}`);
  }
  const claudeRoot = packageRootForCommand(binDir, "claude");
  if (claudeRoot !== packageRoot) throw new Error("Installed frogp and claude bins do not resolve to the same package");
  return packageRoot;
}

function verifyInstalledPackage(manifest: DevBuildManifest): string {
  return verifyInstalledPackageVersion(manifest.version);
}

function restorePreviousInstall(previous: PreviousGlobalInstall): void {
  if (!previous) return;
  if (previous.kind === "untracked") {
    run("bun", ["add", "-g", "--ignore-scripts", `${PACKAGE_NAME}@${previous.version}`]);
    verifyInstalledPackageVersion(previous.version);
    return;
  }
  if (previous.kind === "source") {
    run("bun", ["link", "--cwd", previous.packageRoot]);
    return;
  }

  run("bun", ["add", "-g", "--ignore-scripts", previous.tarball]);
  const packageRoot = verifyInstalledPackage(previous.manifest);
  atomicWriteJson(join(packageRoot, INSTALLED_MANIFEST), previous.manifest);
}

async function installBuild(manifest: DevBuildManifest, yes: boolean): Promise<void> {
  if (!yes) throw new Error("Global package replacement requires --yes");
  const root = gitCommonDir();
  const path = await verifyTarball(root, manifest);
  const previous = await capturePreviousInstall(root);

  // Resolve every dependency in an isolated temporary project before touching the
  // current global package. A registry/cache failure therefore leaves the active
  // source link or previously installed build intact.
  preflightTarballInstall(root, path);
  removeBunPackageOnly();

  try {
    run("bun", ["add", "-g", "--ignore-scripts", path]);
    const packageRoot = verifyInstalledPackage(manifest);
    const installed: InstalledDevBuildManifest = { ...manifest, installedAt: new Date().toISOString() };
    atomicWriteJson(join(packageRoot, INSTALLED_MANIFEST), installed);
  } catch (error) {
    let rollback = "The previous global package was restored.";
    try {
      removeBunPackageOnly();
      restorePreviousInstall(previous);
    } catch (rollbackError) {
      rollback = `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}. ${rollback}`);
  }
  console.log(`\n✅ Installed dev build ${manifest.buildId}`);
  console.log("   Restart a running proxy before testing this build.");
}

function uninstallPackage(yes: boolean): void {
  if (!yes) throw new Error("Global package removal requires --yes");
  removeBunPackageOnly();
  console.log("✅ Removed the Bun global frogprogsy package. User config and credentials were not touched.");
}

function printStatus(status: DevPackageStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`state: ${status.state}`);
  console.log(`latest: ${status.latest?.buildId ?? "none"}`);
  console.log(`installed: ${status.installed?.buildId ?? (status.installedPackageRoot ? "untracked" : "none")}`);
  if (status.latest) {
    console.log(`latest commit: ${status.latest.gitCommit}${status.latest.gitDirty ? " (dirty)" : ""}`);
    console.log(`latest completed: ${status.latest.completedAt}`);
  }
}


function printUsage(): void {
  console.log(`Usage: bun run dev:package <command> [options]

Commands:
  build [--skip-gates]             Verify, build GUI, and create an immutable shared tarball
  install [--build <id>] --yes     Install latest or an explicit verified build with Bun
  reinstall [--skip-gates] --yes   Build, then replace the Bun global package with that exact build
  uninstall --yes                  Remove only the Bun global package; preserve all user state
  status [--json]                  Compare the latest completed build with the installed build
  path [--build <id>]              Print only the verified tarball path for scripts and release upload

Shared build metadata lives under the repository's Git common directory so every worktree sees the same latest build.
The script never invokes the product-level uninstall command and never removes frogprogsy config, Claude homes, or credentials.`);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  const yes = args.includes("--yes");
  const skipGates = args.includes("--skip-gates");

  switch (command) {
    case "build":
      await buildPackage(skipGates);
      return;
    case "install":
      await installBuild(resolveBuild(gitCommonDir(), optionValue(args, "--build")), yes);
      return;
    case "reinstall": {
      if (!yes) throw new Error("Global package replacement requires --yes");
      const manifest = await buildPackage(skipGates);
      await installBuild(manifest, true);
      return;
    }
    case "uninstall":
      uninstallPackage(yes);
      return;
    case "status":
      printStatus(currentStatus(), args.includes("--json"));
      return;
    case "path": {
      const root = gitCommonDir();
      const manifest = resolveBuild(root, optionValue(args, "--build"));
      const path = await verifyTarball(root, manifest);
      console.log(path);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      throw new Error(`Unknown dev-package command: ${command}`);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
