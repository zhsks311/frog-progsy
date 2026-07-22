import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseLatestBuild,
  classifyDevInstall,
  isDevBuildManifest,
  recordLatest,
  type DevBuildManifest,
  type InstalledDevBuildManifest,
} from "../scripts/dev-package";

const root = new URL("../", import.meta.url);

function manifest(overrides: Partial<DevBuildManifest> = {}): DevBuildManifest {
  return {
    schemaVersion: 1,
    buildId: "0.0.1-gabc123-20260718T120000000Z-1234567890ab",
    version: "0.0.1",
    gitCommit: "abc123",
    gitBranch: "feature/package",
    gitDirty: false,
    completedAt: "2026-07-18T12:00:00.000Z",
    tarballFile: "builds/build/frogprogsy.tgz",
    tarballSha256: "a".repeat(64),
    tarballBytes: 1024,
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledDevBuildManifest> = {}): InstalledDevBuildManifest {
  return {
    ...manifest(),
    installedAt: "2026-07-18T12:01:00.000Z",
    ...overrides,
  };
}

describe("dev package manifest", () => {
  test("accepts a repository-relative immutable tarball receipt", () => {
    expect(isDevBuildManifest(manifest())).toBe(true);
  });

  test("rejects absolute and traversing tarball paths", () => {
    expect(isDevBuildManifest(manifest({ tarballFile: "/tmp/frogprogsy.tgz" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ tarballFile: "../frogprogsy.tgz" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ tarballFile: "builds/../../frogprogsy.tgz" }))).toBe(false);
  });

  test("rejects malformed hashes, timestamps, sizes, and build ids", () => {
    expect(isDevBuildManifest(manifest({ tarballSha256: "short" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ completedAt: "not-a-date" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ tarballBytes: 0 }))).toBe(false);
    expect(isDevBuildManifest(manifest({ buildId: "../escape" }))).toBe(false);
  });

  test("latest means the most recently completed successful package", () => {
    const older = manifest({ buildId: "older", completedAt: "2026-07-18T11:59:00.000Z" });
    const newer = manifest({ buildId: "newer", completedAt: "2026-07-18T12:01:00.000Z" });
    expect(chooseLatestBuild(older, newer).buildId).toBe("newer");
    expect(chooseLatestBuild(newer, older).buildId).toBe("newer");
  });

  test("a deterministic build-id tie break prevents last-writer ambiguity", () => {
    const a = manifest({ buildId: "build-a" });
    const b = manifest({ buildId: "build-b" });
    expect(chooseLatestBuild(a, b).buildId).toBe("build-b");
    expect(chooseLatestBuild(b, a).buildId).toBe("build-b");
  });

  test("serializes concurrent latest writes without regressing completion order", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "frogprogsy-latest-"));
    const candidates = Array.from({ length: 16 }, (_, index) => manifest({
      buildId: `build-${index.toString().padStart(2, "0")}`,
      completedAt: new Date(Date.parse("2026-07-18T12:00:00.000Z") + index).toISOString(),
    }));

    try {
      await Promise.all(candidates.slice().reverse().map(candidate => recordLatest(cacheRoot, candidate)));
      const latest = JSON.parse(readFileSync(join(cacheRoot, "latest.json"), "utf8")) as DevBuildManifest;
      expect(latest.buildId).toBe("build-15");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("dev package install status", () => {
  test("distinguishes missing, untracked, current, and outdated installs", () => {
    const latest = manifest({ buildId: "latest" });
    expect(classifyDevInstall(latest, null, false)).toBe("not-installed");
    expect(classifyDevInstall(latest, null, true)).toBe("untracked");
    expect(classifyDevInstall(latest, installed({ buildId: "latest" }), true)).toBe("current");
    expect(classifyDevInstall(latest, installed({ buildId: "older" }), true)).toBe("outdated");
    expect(classifyDevInstall(null, installed({ buildId: "only" }), true)).toBe("installed-no-latest");
  });
});

describe("Bun-only development package contract", () => {
  test("package.json exposes the Bun development package command", async () => {
    const pkg = await Bun.file(new URL("package.json", root)).json() as {
      packageManager?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.packageManager).toMatch(/^bun@/);
    expect(pkg.scripts?.["dev:package"]).toBe("bun scripts/dev-package.ts");
    expect(pkg.scripts?.test).toBe("bun test --isolate ./tests");
    expect(pkg.dependencies?.zod).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("development packaging cannot invoke destructive product uninstall or npm", async () => {
    const source = await Bun.file(new URL("scripts/dev-package.ts", root)).text();
    expect(source).toContain('"pm", "pack"');
    expect(source).toContain('"add", "-g"');
    expect(source).toContain('"remove", "-g"');
    expect(source).toContain('"--git-common-dir"');
    expect(source).toContain("Global package replacement requires --yes");
    expect(source).toContain('run("bun", ["run", "test"])');
    expect(source).not.toContain("frogp uninstall");
    expect(source).not.toContain("getConfigDir");
    expect(source).not.toMatch(/spawnSync\(["']npm["']/);
    expect(source).not.toMatch(/run\(["']npm["']/);
  });

  test("install preflights before replacement and retains rollback", async () => {
    const source = await Bun.file(new URL("scripts/dev-package.ts", root)).text();
    const installStart = source.indexOf("async function installBuild");
    const installEnd = source.indexOf("function uninstallPackage", installStart);
    const installBody = source.slice(installStart, installEnd);
    const preflight = installBody.indexOf("preflightTarballInstall");
    const remove = installBody.indexOf("removeBunPackageOnly");
    const install = installBody.indexOf('run("bun", ["add", "-g"');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(remove);
    expect(remove).toBeLessThan(install);
    expect(installBody).toContain("restorePreviousInstall");
  });
});
