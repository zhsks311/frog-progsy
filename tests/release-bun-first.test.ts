import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("Bun-first release and installation contract", () => {
  test("release helper uses Bun for version and registry preparation", async () => {
    const source = await read("scripts/release.ts");
    expect(source).toContain('["bun", "pm", "view"');
    expect(source).toContain("writePackageVersion");
    expect(source).not.toContain("npm version");
    expect(source).not.toContain("npm install -g");
    expect(source).toContain("bun add -g frogprogsy");
  });

  test("release helper waits fail-closed on BOTH workflow gates for the exact SHA before dispatching", async () => {
    const source = await read("scripts/release.ts");

    // Both gate workflows are named as constants and registered for waiting — matching
    // release.yml's `require_success ci.yml` + `require_success package-lifecycle.yml`.
    expect(source).toContain('const CI_WORKFLOW = "ci.yml"');
    expect(source).toContain('const PACKAGE_LIFECYCLE_WORKFLOW = "package-lifecycle.yml"');
    expect(source).toContain("{ workflow: CI_WORKFLOW, label: \"Cross-platform CI\" }");
    expect(source).toContain("{ workflow: PACKAGE_LIFECYCLE_WORKFLOW, label: \"Package lifecycle\" }");

    // The run lookup is pinned to the exact commit SHA.
    expect(source).toContain("gh run list --workflow ${workflow} --commit ${sha}");

    // A completed non-success run aborts immediately and names the failed workflow.
    expect(source).toContain("${gate.label} (${gate.workflow}) failed for ${sha}");
    // Missing/in-progress runs keep polling inside the bounded timeout (fail-closed on expiry).
    expect(source).toContain("const deadline = Date.now() + RELEASE_GATE_WAIT_TIMEOUT_MS");
    expect(source).toContain("timed out waiting for ${gate.label}");

    // The dual gate is awaited BEFORE the Release workflow is dispatched, and the old
    // single-CI-only wait is gone.
    expect(source).toContain("await waitForReleaseGates(releaseSha)");
    expect(source).not.toContain("waitForSuccessfulCi");
    const gateIndex = source.indexOf("await waitForReleaseGates(releaseSha)");
    const dispatchIndex = source.indexOf("gh workflow run release.yml");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(gateIndex);
  });

  test("release workflow confines npm to the final trusted-publish lane", async () => {
    const workflow = await read(".github/workflows/release.yml");
    expect(workflow).toContain("bun install");
    expect(workflow).toContain("bun pm view");
    expect(workflow).toContain("bun run prepublishOnly");
    expect(workflow).toContain("bun scripts/dev-package.ts build --skip-gates");
    expect(workflow).toContain('bun publish --dry-run "$TARBALL"');
    expect(workflow).toContain('npm publish "$TARBALL" --tag "$REGISTRY_DIST_TAG" --access public');
    expect(workflow).not.toContain("npm pack");
    expect(workflow).not.toContain("npm run prepublishOnly");
    expect(workflow).not.toContain("npm view");
    expect(workflow).not.toContain('release_tag="v${{ inputs.');
    expect(workflow).not.toContain('if [ "${{ inputs.');
    expect(workflow).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(workflow).toContain("oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("bun-version: 1.3.14");
    expect(workflow).not.toContain("actions/checkout@v");
    expect(workflow).not.toContain("oven-sh/setup-bun@v");
    expect(workflow).not.toContain("actions/setup-node@v");
    expect(workflow).toContain("npm install -g npm@11.5.1");
    expect(workflow).not.toContain("npm install -g npm@latest");
  });

  test("release policy enforces channels, one-time bootstrap, and canonical provenance metadata", async () => {
    const helper = await read("scripts/release.ts");
    const workflow = await read(".github/workflows/release.yml");
    const pkg = JSON.parse(await read("package.json")) as { repository?: { url?: string } };

    expect(helper).toContain('tag !== "latest" && tag !== "preview"');
    expect(helper).toContain('(tag === "preview") !== prerelease');
    expect(helper).toContain("-f bootstrap=${String(bootstrap)}");
    expect(helper).toContain("-f expected-sha=${releaseSha}");
    expect(workflow).toContain("Workflow checkout SHA ${GITHUB_SHA} != expected release SHA ${EXPECTED_SHA}");
    expect(workflow).toContain("latest requires a stable SemVer");
    expect(workflow).toContain("preview requires a prerelease SemVer");
    expect(workflow).toContain("bootstrap is one-time only");
    expect(helper).toContain("--bootstrap must publish a stable version to the latest channel");
    expect(workflow).toContain("bootstrap must create the default latest channel");
    expect(workflow).not.toContain('|*"not found"*)');
    expect(workflow).toContain("Unable to determine whether ${pkg_name}@${RELEASE_VERSION} exists");
    expect(workflow).toContain("Unable to determine whether GitHub Release ${release_tag} exists");
    expect(helper).not.toContain('output.includes("release not found") ||');
    expect(workflow).toContain("secrets.NPM_BOOTSTRAP_TOKEN");
    expect(workflow).toContain('if [ "$BOOTSTRAP" = "true" ] && [ -z "$NODE_AUTH_TOKEN" ]');
    const buildIndex = workflow.indexOf("bun scripts/dev-package.ts build --skip-gates");
    const secretIndex = workflow.indexOf("NODE_AUTH_TOKEN:");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ inputs.bootstrap && secrets.NPM_BOOTSTRAP_TOKEN || '' }}");
    expect(workflow.split("NODE_AUTH_TOKEN:").length - 1).toBe(1);
    expect(buildIndex).toBeGreaterThan(-1);
    expect(secretIndex).toBeGreaterThan(buildIndex);
    expect(workflow).toContain("Keep the bootstrap credential out of install, build, lifecycle, and dry-run steps");
    expect(pkg.repository?.url).toBe("git+https://github.com/zhsks311/Frogprogsy.git");
  });

  test("package lifecycle workflow builds the shared tarball once and installs it across three OSes", async () => {
    const lifecycle = await read(".github/workflows/package-lifecycle.yml");
    const count = (needle: string) => lifecycle.split(needle).length - 1;

    // A package.json-only main push must still trigger the workflow (release gate
    // needs a green run for the exact version-bump commit).
    expect(lifecycle).toContain("push:");
    expect(lifecycle).toContain("branches: [main, dev]");
    expect(lifecycle).toContain('- "package.json"');
    expect(lifecycle).toContain('- ".github/workflows/package-lifecycle.yml"');

    // Least privilege + safe concurrency.
    expect(lifecycle).toContain("contents: read");
    expect(lifecycle).toContain("concurrency:");
    expect(lifecycle).toContain("group: package-lifecycle-${{ github.ref }}");

    // Bun 1.3.14 frozen install -> GUI build -> build once -> resolve path.
    expect(lifecycle).toContain("bun-version: 1.3.14");
    expect(lifecycle).toContain("bun install --frozen-lockfile");
    expect(lifecycle).toContain("bun run build:gui");
    expect(lifecycle).toContain("bun run dev:package path");

    // The tarball is built exactly ONCE (ubuntu build job), then uploaded once.
    expect(count("bun run dev:package build --skip-gates")).toBe(1);
    expect(count("actions/upload-artifact@")).toBe(1);
    expect(count("actions/download-artifact@")).toBe(1);

    // The matrix installs the SAME downloaded artifact on all three platforms and
    // never rebuilds it there.
    expect(lifecycle).toContain("needs: build");
    expect(lifecycle).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(lifecycle).toContain("name: package-tarball");
    expect(lifecycle).toContain("bun scripts/package-lifecycle-smoke.ts --tarball-dir dist-tarball");

    // Third-party actions are commit-SHA pinned (no floating tags) with timeouts.
    expect(lifecycle).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(lifecycle).toContain("oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76");
    expect(lifecycle).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(lifecycle).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(lifecycle).not.toContain("actions/checkout@v");
    expect(lifecycle).not.toContain("oven-sh/setup-bun@v");
    expect(lifecycle).not.toContain("actions/upload-artifact@v");
    expect(lifecycle).not.toContain("actions/download-artifact@v");
    expect(lifecycle).toContain("timeout-minutes:");
  });

  test("release is gated on successful CI and package-lifecycle runs for the exact commit SHA", async () => {
    const workflow = await read(".github/workflows/release.yml");

    // Fail-closed dual gate: both workflows must have a green run for THIS commit.
    expect(workflow).toContain("require_success() {");
    expect(workflow).toContain("require_success ci.yml");
    expect(workflow).toContain("require_success package-lifecycle.yml");

    // The lookup is pinned to the exact commit and demands an actual success —
    // an empty result aborts rather than being treated as passing.
    expect(workflow).toContain('--commit "$GITHUB_SHA"');
    expect(workflow).toContain("--status success");
    expect(workflow).toContain('if [ -z "$run_url" ]; then');
  });

  test("runtime update and package removal are Bun-managed", async () => {
    const update = await read("src/update.ts");
    const cli = await read("src/cli.ts");
    expect(update).toContain('spawnSync("bun", ["pm", "view"');
    expect(update).toContain('spawnSync("bun", cmdArgs');
    expect(update).not.toContain('spawnSync("npm"');
    expect(cli).toContain('spawnSync("bun", cmdArgs');
    expect(cli).not.toContain('spawnSync("npm"');
    expect(cli).toContain(".frogprogsy-dev-build.json");
    expect(cli).toContain("installedDevBuildId");
  });

  test("public installation commands use Bun in every locale", async () => {
    const files = [
      "README.md",
      "README.ko.md",
      "README.zh-CN.md",
      "docs-site/content/docs/en/getting-started/installation.md",
      "docs-site/content/docs/ko/getting-started/installation.md",
      "docs-site/content/docs/zh-cn/getting-started/installation.md",
    ];
    for (const file of files) {
      const source = await read(file);
      expect(source).toContain("bun add -g .");
      expect(source).toContain("bun add -g frogprogsy");
      expect(source).not.toContain("npm install -g");
    }
  });

  test("active product and release surfaces contain no retired product name", async () => {
    const files = [
      "package.json",
      "scripts/dev-package.ts",
      "scripts/release.ts",
      "src/update.ts",
      "src/cli.ts",
      "structure/06_docs-and-release.md",
      "README.md",
      "README.ko.md",
      "README.zh-CN.md",
    ];
    const retiredName = ["open", "claudecode"].join("-");
    for (const file of files) {
      expect((await read(file)).toLowerCase()).not.toContain(retiredName);
    }
  });
});
