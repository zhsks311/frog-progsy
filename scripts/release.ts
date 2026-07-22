#!/usr/bin/env bun
/**
 * Release helper (jawcode-style, single package). Not shipped in the registry tarball.
 *
 * Usage:
 *   bun scripts/release.ts <version> [--tag latest|preview] [--publish]
 *       Preflight (clean tree on main + typecheck) → bump package.json → commit → push →
 *       wait for Cross-platform CI → dispatch the Release workflow → watch it.
 *       Dry-run by default; pass --publish to publish.
 *   bun scripts/release.ts watch
 *       Watch the most recent Release run.
 *
 * Example:  bun scripts/release.ts 0.1.0            # dry-run release of 0.1.0
 *           bun scripts/release.ts 0.1.0 --publish  # actually publish 0.1.0
 *
 * Requires: gh CLI (authed). Final publishing uses Trusted Publishing (OIDC), with no long-lived registry token.
 */
import { $ } from "bun";

const args = process.argv.slice(2);
interface GhRun {
  conclusion: string | null;
  databaseId: number;
  headSha: string;
  status: string;
  url: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CI_WORKFLOW = "ci.yml";
const CI_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const CI_POLL_MS = 10 * 1000;

async function runQuiet(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function readPackageName(): Promise<string> {
  try {
    const pkg = JSON.parse(await Bun.file("package.json").text()) as { name?: unknown };
    if (typeof pkg.name !== "string" || !pkg.name) {
      console.error("✗ package.json is missing a valid name");
      process.exit(1);
    }
    return pkg.name;
  } catch (error) {
    console.error(`✗ failed to read package.json: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function writePackageVersion(version: string): Promise<boolean> {
  const path = "package.json";
  const pkg = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
  if (pkg.version === version) return false;
  pkg.version = version;
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

async function registryVersionExists(packageName: string, version: string): Promise<boolean> {
  const result = await runQuiet(["bun", "pm", "view", `${packageName}@${version}`, "version"]);
  if (result.exitCode === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("e404") || output.includes("404") || output.includes("no match found") || output.includes("not found")) {
    return false;
  }

  console.error(`✗ failed to check registry version ${packageName}@${version}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function remoteTagSha(tagName: string): Promise<string | null> {
  const result = await runQuiet(["git", "ls-remote", "origin", `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]);
  if (result.exitCode !== 0) {
    console.error(`✗ failed to check remote tag ${tagName}`);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const peeled = lines.find(line => line.endsWith(`refs/tags/${tagName}^{}`));
  const exact = lines.find(line => line.endsWith(`refs/tags/${tagName}`));
  const selected = peeled ?? exact;
  return selected ? selected.split(/\s+/)[0] ?? null : null;
}

async function githubReleaseExists(tagName: string): Promise<boolean> {
  const result = await runQuiet(["gh", "release", "view", tagName, "--json", "tagName"]);
  if (result.exitCode === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("release not found") || output.includes("not found")) return false;

  console.error(`✗ failed to check GitHub Release ${tagName}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function assertUnusedReleaseVersion(packageName: string, version: string): Promise<void> {
  const releaseTag = `v${version}`;
  const [registryUsed, tagSha, releaseUsed] = await Promise.all([
    registryVersionExists(packageName, version),
    remoteTagSha(releaseTag),
    githubReleaseExists(releaseTag),
  ]);

  const failures: string[] = [];
  if (registryUsed) failures.push(`- package registry already has ${packageName}@${version}`);
  if (tagSha) failures.push(`- remote Git tag ${releaseTag} already exists at ${tagSha}`);
  if (releaseUsed) failures.push(`- GitHub Release ${releaseTag} already exists`);

  if (failures.length > 0) {
    console.error(`✗ release version ${version} is already partially or fully used:`);
    console.error(failures.join("\n"));
    console.error("Choose the next unused patch version, or make an explicit human decision to repair public metadata.");
    process.exit(1);
  }
}

async function watchLatest(): Promise<void> {
  const id = (await $`gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId'`.text()).trim();
  if (!id) { console.error("No Release runs found yet."); process.exit(1); }
  console.log(`→ watching Release run ${id}`);
  await $`gh run watch ${id} --exit-status --interval 10`;
}

async function listCiRuns(sha: string): Promise<GhRun[]> {
  const raw = await $`gh run list --workflow ${CI_WORKFLOW} --commit ${sha} --limit 20 --json conclusion,databaseId,headSha,status,url`.text();
  const runs = JSON.parse(raw) as GhRun[];
  return runs.filter(run => run.headSha === sha);
}

async function waitForSuccessfulCi(sha: string): Promise<GhRun> {
  const deadline = Date.now() + CI_WAIT_TIMEOUT_MS;
  let attempt = 1;
  while (Date.now() < deadline) {
    const runs = await listCiRuns(sha);
    const successful = runs.find(run => run.status === "completed" && run.conclusion === "success");
    if (successful) {
      console.log(`→ Cross-platform CI passed: ${successful.url}`);
      return successful;
    }

    const failed = runs.find(run => run.status === "completed" && run.conclusion && run.conclusion !== "success");
    if (failed) {
      console.error(`✗ Cross-platform CI failed for ${sha}: ${failed.url}`);
      process.exit(1);
    }

    const state = runs.length > 0
      ? runs.map(run => `${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`).join(", ")
      : "not started yet";
    console.log(`→ waiting for Cross-platform CI (${sha.slice(0, 7)}) attempt ${attempt}: ${state}`);
    attempt += 1;
    await Bun.sleep(CI_POLL_MS);
  }

  console.error(`✗ timed out waiting for Cross-platform CI on ${sha}`);
  process.exit(1);
}

async function remoteMainSha(): Promise<string> {
  const out = (await $`git ls-remote origin refs/heads/main`.text()).trim();
  const [sha] = out.split(/\s+/);
  if (!sha) {
    console.error("✗ could not resolve origin/main");
    process.exit(1);
  }
  return sha;
}

if (args[0] === "watch") {
  await watchLatest();
  process.exit(0);
}

const version = args[0];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun scripts/release.ts <version> [--tag latest|preview] [--publish]\n       bun scripts/release.ts watch");
  process.exit(1);
}
const tag = args.includes("--tag") ? (args[args.indexOf("--tag") + 1] ?? "latest") : "latest";
const dryRun = !args.includes("--publish");

// 1. Preflight — must be on a clean main, and typecheck must pass.
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main") { console.error(`✗ must be on main (currently ${branch}).`); process.exit(1); }
if ((await $`git status --porcelain`.text()).trim()) { console.error("✗ working tree not clean — commit or stash first."); process.exit(1); }
const packageName = await readPackageName();
console.log(`→ release metadata preflight (${packageName}@${version})`);
await assertUnusedReleaseVersion(packageName, version);
console.log("→ typecheck");
await $`bun x tsc --noEmit`;

// 2. Bump package.json only; the workflow creates the version tag after a successful publish.
console.log(`→ package.json version → ${version}`);
const versionChanged = await writePackageVersion(version);

// 3. Commit + push the version bump. Re-running dry-run → publish for the same
// version reuses the already-pushed release commit instead of creating an empty commit.
if (versionChanged) {
  await $`git add package.json`;
  await $`git commit -m ${`release: v${version}`}`;
} else {
  console.log("→ package.json already has the requested version; reusing HEAD");
}
const releaseSha = (await $`git rev-parse HEAD`.text()).trim();
console.log("→ push origin main");
await $`git push origin main`;

// 4. Wait for the pushed release commit to pass CI, then dispatch the Release workflow.
console.log(`→ wait for Cross-platform CI (${releaseSha})`);
await waitForSuccessfulCi(releaseSha);

const originMain = await remoteMainSha();
if (originMain !== releaseSha) {
  console.error(`✗ origin/main moved while waiting for CI (${originMain} != ${releaseSha}); aborting release dispatch.`);
  process.exit(1);
}

console.log(`→ dispatch Release (tag=${tag}, dry-run=${dryRun})`);
await $`gh workflow run release.yml --ref main -f version=${version} -f tag=${tag} -f dry-run=${String(dryRun)}`;
await Bun.sleep(4000);

// 5. Watch it.
await watchLatest();
console.log(dryRun
  ? "\n✓ Dry run complete. Re-run with --publish to publish for real."
  : "\n✓ Published. Try:  bun add -g frogprogsy");
