import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectGuiBuildSkewNotice } from "../gui/src/build-skew";
import { buildHealthzPayload } from "../src/server";
import { formatGuiBuildWarning, resolveGuiBuildIdentity } from "../src/build-identity";
import { computeGuiSourceHash, listGuiBuildInputFiles } from "../gui/vite.config";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "frogp-gui-build-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMeta(dir: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "build-meta.json"), typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

describe("GUI/server build identity contract", () => {
  test("healthz payload preserves legacy fields and adds GUI build identity fields", () => {
    const payload = buildHealthzPayload(12.5);
    expect(payload.status).toBe("ok");
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(payload.uptime).toBe(12.5);
    expect(payload.serverBuildId).toBe(`frogprogsy-server@${payload.version}`);
    expect(payload).toHaveProperty("guiBuildId");
    expect(["ok", "missing", "malformed", "version-mismatch", "source-mismatch-dev"]).toContain(payload.guiBuildStatus);
  });

  test("build-meta manifest states are deterministic and explicit", () => {
    withTempDir(dir => {
      expect(resolveGuiBuildIdentity(dir, "1.2.3", "server@1.2.3")).toEqual({
        serverBuildId: "server@1.2.3",
        guiBuildId: null,
        guiBuildStatus: "missing",
      });

      writeMeta(dir, "{not json");
      expect(resolveGuiBuildIdentity(dir, "1.2.3", "server@1.2.3")).toEqual({
        serverBuildId: "server@1.2.3",
        guiBuildId: null,
        guiBuildStatus: "malformed",
      });

      writeMeta(dir, { schemaVersion: 1, appBuildId: "app-1", version: "9.9.9", generatedAt: "2026-07-03T00:00:00.000Z" });
      expect(resolveGuiBuildIdentity(dir, "1.2.3", "server@1.2.3")).toEqual({
        serverBuildId: "server@1.2.3",
        guiBuildId: "app-1",
        guiBuildStatus: "version-mismatch",
      });

      writeMeta(dir, { schemaVersion: 1, appBuildId: "app-1", version: "1.2.3", generatedAt: "2026-07-03T00:00:00.000Z", sourceHash: "abc" });
      expect(resolveGuiBuildIdentity(dir, "1.2.3", "server@1.2.3")).toEqual({
        serverBuildId: "server@1.2.3",
        guiBuildId: "app-1",
        guiBuildStatus: "ok",
      });
    });
  });

  test("GUI detects old-server, artifact problem, and bundle mismatch cases", () => {
    expect(detectGuiBuildSkewNotice({ status: "ok", version: "0.0.1" }, "bundle-1")).toEqual({
      kind: "old-server",
      status: "old-server",
      expectedBuildId: "bundle-1",
      servedBuildId: null,
    });
    expect(detectGuiBuildSkewNotice({ guiBuildStatus: "missing", guiBuildId: null }, "bundle-1")?.kind).toBe("artifact-problem");
    expect(detectGuiBuildSkewNotice({ guiBuildStatus: "ok", guiBuildId: "served-2" }, "bundle-1")).toEqual({
      kind: "bundle-mismatch",
      status: "ok",
      expectedBuildId: "bundle-1",
      servedBuildId: "served-2",
    });
    expect(detectGuiBuildSkewNotice({ guiBuildStatus: "ok", guiBuildId: "bundle-1" }, "bundle-1")).toBeNull();
  });

  test("CLI warning text points at rebuild or refresh without changing status JSON shape", () => {
    expect(formatGuiBuildWarning({ serverBuildId: "s", guiBuildId: null, guiBuildStatus: "missing" })).toContain("bun run build:gui");
    expect(formatGuiBuildWarning({ serverBuildId: "s", guiBuildId: "old", guiBuildStatus: "version-mismatch" })).toContain("frogp refresh");

    const cli = readFileSync(join(repoRoot, "src/cli.ts"), "utf8");
    expect(cli).toContain("printGuiBuildWarning()");
    expect(cli).toContain("if (flags.includes(\"--json\"))");
  });

  test("GUI source hash includes shipped Vite entry and public artifact inputs", () => {
    withTempDir(root => {
      const guiDir = join(root, "gui");
      mkdirSync(join(guiDir, "src"), { recursive: true });
      mkdirSync(join(guiDir, "public"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8");
      writeFileSync(join(guiDir, "package.json"), JSON.stringify({ dependencies: { react: "x" } }), "utf8");
      writeFileSync(join(guiDir, "index.html"), "<div id=\"root\"></div>", "utf8");
      writeFileSync(join(guiDir, "src/main.tsx"), "console.log('main')", "utf8");
      writeFileSync(join(guiDir, "public/marker.txt"), "public-a", "utf8");

      // listGuiBuildInputFiles returns native absolute paths (backslashes on Windows);
      // normalize only these derived test-relative strings so the portable slash
      // assertions below are cross-platform without touching product path behavior.
      const inputs = listGuiBuildInputFiles(guiDir, root)
        .map(file => file.slice(root.length + 1).replaceAll("\\", "/"))
        .sort();
      expect(inputs).toContain("gui/index.html");
      expect(inputs).toContain("gui/public/marker.txt");
      expect(inputs).toContain("gui/package.json");
      expect(inputs).toContain("package.json");

      const initial = computeGuiSourceHash(guiDir, root);
      writeFileSync(join(guiDir, "index.html"), "<div id=\"root\" data-changed=\"1\"></div>", "utf8");
      const afterIndexChange = computeGuiSourceHash(guiDir, root);
      expect(afterIndexChange).not.toBe(initial);

      writeFileSync(join(guiDir, "index.html"), "<div id=\"root\"></div>", "utf8");
      writeFileSync(join(guiDir, "public/marker.txt"), "public-b", "utf8");
      const afterPublicChange = computeGuiSourceHash(guiDir, root);
      expect(afterPublicChange).not.toBe(initial);
    });
  });

  test("Vite and App source wire app build id and user-facing skew banner", () => {
    const vite = readFileSync(join(repoRoot, "gui/vite.config.ts"), "utf8");
    const app = readFileSync(join(repoRoot, "gui/src/App.tsx"), "utf8");
    const env = readFileSync(join(repoRoot, "gui/src/vite-env.d.ts"), "utf8");
    const en = readFileSync(join(repoRoot, "gui/src/i18n/en.ts"), "utf8");
    const ko = readFileSync(join(repoRoot, "gui/src/i18n/ko.ts"), "utf8");
    const zh = readFileSync(join(repoRoot, "gui/src/i18n/zh.ts"), "utf8");

    expect(vite).toContain("build-meta.json");
    expect(vite).toContain("__APP_BUILD_ID__");
    expect(env).toContain("declare const __APP_BUILD_ID__: string");
    expect(app).toContain("detectGuiBuildSkewNotice(data, __APP_BUILD_ID__)");
    expect(app).toContain("app.buildSkewTitle");
    for (const locale of [en, ko, zh]) {
      expect(locale).toContain("app.buildSkewTitle");
      expect(locale).toContain("app.buildSkewBody");
    }
  });
});
