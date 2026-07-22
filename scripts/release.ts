#!/usr/bin/env bun
/**
 * Release helper (jawcode-style, single package). Not shipped in the registry tarball.
 *
 * Usage:
 *   bun scripts/release.ts <version> [--tag latest|preview] [--publish] [--bootstrap]
 *       Preflight (clean tree on main + typecheck) → bump package.json → commit → push →
 *       wait for BOTH release gates (Cross-platform CI + Package lifecycle) on the release
 *       SHA → dispatch the Release workflow → watch it.
 *       Dry-run by default; pass --publish to publish.
 *   bun scripts/release.ts watch
 *       Watch the most recent Release run.
 *
 * Example:  bun scripts/release.ts 0.1.0                            # dry-run stable release
 *           bun scripts/release.ts 0.1.0 --publish                  # OIDC stable publish
 *           bun scripts/release.ts 0.0.1 --publish --bootstrap      # one-time first publish
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

// The local helper mirrors release.yml's fail-closed dual gate: both Cross-platform CI
// (ci.yml) and Package lifecycle (package-lifecycle.yml) must have a successful run for
// the exact release SHA before the Release workflow is dispatched.
const CI_WORKFLOW = "ci.yml";
const PACKAGE_LIFECYCLE_WORKFLOW = "package-lifecycle.yml";
const RELEASE_GATE_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const RELEASE_GATE_POLL_MS = 10 * 1000;

interface ReleaseGate {
  workflow: string;
  label: string;
}

const RELEASE_GATES: ReleaseGate[] = [
  { workflow: CI_WORKFLOW, label: "Cross-platform CI" },
  { workflow: PACKAGE_LIFECYCLE_WORKFLOW, label: "Package lifecycle" },
];

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
  if (output.includes("e404") || output.includes("404 not found") || output.includes("does not exist in this registry") || output.includes("no match found")) {
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
  if (output.includes("release not found")) return false;

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

async function listWorkflowRuns(workflow: string, sha: string): Promise<GhRun[]> {
  const raw = await $`gh run list --workflow ${workflow} --commit ${sha} --limit 20 --json conclusion,databaseId,headSha,status,url`.text();
  const runs = JSON.parse(raw) as GhRun[];
  return runs.filter(run => run.headSha === sha);
}

// Wait for a single gate's workflow to have a successful run for THIS exact SHA. A run that
// completed with a non-success conclusion aborts immediately (naming the failed workflow);
// missing or in-progress runs keep polling inside the bounded timeout (fail-closed on expiry).
async function waitForSuccessfulGate(gate: ReleaseGate, sha: string): Promise<GhRun> {
  const deadline = Date.now() + RELEASE_GATE_WAIT_TIMEOUT_MS;
  let attempt = 1;
  while (Date.now() < deadline) {
    const runs = await listWorkflowRuns(gate.workflow, sha);
    const successful = runs.find(run => run.status === "completed" && run.conclusion === "success");
    if (successful) {
      console.log(`→ ${gate.label} (${gate.workflow}) passed: ${successful.url}`);
      return successful;
    }

    const failed = runs.find(run => run.status === "completed" && run.conclusion && run.conclusion !== "success");
    if (failed) {
      console.error(`✗ ${gate.label} (${gate.workflow}) failed for ${sha}: ${failed.url}`);
      process.exit(1);
    }

    const state = runs.length > 0
      ? runs.map(run => `${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`).join(", ")
      : "not started yet";
    console.log(`→ waiting for ${gate.label} (${sha.slice(0, 7)}) attempt ${attempt}: ${state}`);
    attempt += 1;
    await Bun.sleep(RELEASE_GATE_POLL_MS);
  }

  console.error(`✗ timed out waiting for ${gate.label} (${gate.workflow}) on ${sha}`);
  process.exit(1);
}

// The two gates are independent, so wait for them in parallel. Each keeps its own bounded
// timeout and fail-closed semantics; the first failed/missing run aborts the whole release.
async function waitForReleaseGates(sha: string): Promise<void> {
  await Promise.all(RELEASE_GATES.map(gate => waitForSuccessfulGate(gate, sha)));
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
  console.error("Usage: bun scripts/release.ts <version> [--tag latest|preview] [--publish] [--bootstrap]\n       bun scripts/release.ts watch");
  process.exit(1);
}
const tag = args.includes("--tag") ? (args[args.indexOf("--tag") + 1] ?? "latest") : "latest";
if (tag !== "latest" && tag !== "preview") {
  console.error(`✗ unsupported registry dist-tag: ${tag}`);
  process.exit(1);
}
const prerelease = version.includes("-");
if ((tag === "preview") !== prerelease) {
  console.error(`✗ ${tag} requires a ${tag === "preview" ? "prerelease" : "stable"} SemVer; got ${version}`);
  process.exit(1);
}
const dryRun = !args.includes("--publish");
const bootstrap = args.includes("--bootstrap");
if (bootstrap && dryRun) {
  console.error("✗ --bootstrap requires --publish");
  process.exit(1);
}
if (bootstrap && tag !== "latest") {
  console.error("✗ --bootstrap must publish a stable version to the latest channel");
  process.exit(1);
}

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

// 4. Wait for the pushed release commit to pass BOTH release gates — Cross-platform CI
// (ci.yml) and Package lifecycle (package-lifecycle.yml) — for this exact SHA, then
// dispatch the Release workflow. This mirrors release.yml's fail-closed dual gate, so we
// never dispatch without both success signals.
console.log(`→ wait for release gates (${RELEASE_GATES.map(gate => gate.workflow).join(" + ")}) on ${releaseSha}`);
await waitForReleaseGates(releaseSha);

const originMain = await remoteMainSha();
if (originMain !== releaseSha) {
  console.error(`✗ origin/main moved while waiting for the release gates (${originMain} != ${releaseSha}); aborting release dispatch.`);
  process.exit(1);
}

console.log(`→ dispatch Release (sha=${releaseSha}, tag=${tag}, dry-run=${dryRun}, bootstrap=${bootstrap})`);
await $`gh workflow run release.yml --ref main -f version=${version} -f expected-sha=${releaseSha} -f tag=${tag} -f dry-run=${String(dryRun)} -f bootstrap=${String(bootstrap)}`;
await Bun.sleep(4000);

// 5. Watch it.
await watchLatest();
console.log(dryRun
  ? "\n✓ Dry run complete. Re-run with --publish to publish for real."
  : "\n✓ Published. Try:  bun add -g frogprogsy");
