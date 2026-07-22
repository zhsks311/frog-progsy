import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const PUBLIC_DOC_ROOTS = [
  "README.md",
  "README.ko.md",
  "README.zh-CN.md",
  "docs-site/content/docs",
] as const;

const REQUIRED_DOCS = [
  "README.md",
  "README.ko.md",
  "README.zh-CN.md",
  "docs-site/content/docs/en/reference/cli.md",
  "docs-site/content/docs/ko/reference/cli.md",
  "docs-site/content/docs/zh-cn/reference/cli.md",
  "docs-site/content/docs/en/guides/web-dashboard.md",
  "docs-site/content/docs/ko/guides/web-dashboard.md",
  "docs-site/content/docs/zh-cn/guides/web-dashboard.md",
  "docs-site/content/docs/en/guides/claude-app-models.md",
  "docs-site/content/docs/ko/guides/claude-app-models.md",
  "docs-site/content/docs/zh-cn/guides/claude-app-models.md",
  "docs-site/content/docs/en/guides/troubleshooting.md",
  "docs-site/content/docs/ko/guides/troubleshooting.md",
  "docs-site/content/docs/zh-cn/guides/troubleshooting.md",
  "docs-site/content/docs/en/guides/claude-integration.md",
  "docs-site/content/docs/ko/guides/claude-integration.md",
  "docs-site/content/docs/zh-cn/guides/claude-integration.md",
] as const;

async function collectMarkdown(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return /\.(md|mdx)$/.test(path) ? [path] : [];
  const out: string[] = [];
  for (const entry of await readdir(path)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    out.push(...await collectMarkdown(join(path, entry)));
  }
  return out.sort();
}

function headingDepths(text: string): number[] {
  const body = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  return [...body.matchAll(/^(#{1,6}) /gm)].map(match => match[1]!.length);
}


describe("Claude Code model picker reload docs", () => {
  test("public docs do not advertise obsolete frogp sync", async () => {
    const files = (await Promise.all(PUBLIC_DOC_ROOTS.map(root => collectMarkdown(root)))).flat();
    const failures: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (/\bfrogp sync\b/.test(text)) failures.push(file);
    }
    expect(failures).toEqual([]);
  });

  test("README translations keep the English heading structure", async () => {
    const en = await readFile("README.md", "utf8");
    const failures: string[] = [];
    for (const file of ["README.ko.md", "README.zh-CN.md"]) {
      const text = await readFile(file, "utf8");
      if (JSON.stringify(headingDepths(text)) !== JSON.stringify(headingDepths(en))) failures.push(file);
    }
    expect(failures).toEqual([]);
  });

  test("required docs explain reload-models and no hot reload", async () => {
    const failures: string[] = [];
    for (const file of REQUIRED_DOCS) {
      const text = await readFile(file, "utf8");
      if (!text.includes("frogp claude reload-models <profile-id>")) failures.push(`${file}: missing stable profile-id reload-models command`);
      if (!text.includes("/model") || !/hot reload/i.test(text) || !/(?:already-open|이미 열|已(?:经)?打开|已经打开)/i.test(text)) {
        failures.push(`${file}: missing already-open /model no-hot-reload caveat`);
      }
      if (!/resume/i.test(text) || !/(?:start|new|fresh|시작|새|新的|新)/i.test(text)) failures.push(`${file}: missing start/resume guidance`);
      if (!text.includes("/v1/models")) failures.push(`${file}: missing /v1/models refetch detail`);
    }
    expect(failures).toEqual([]);
  });

  test("dashboard docs describe API reload separately from picker recovery", async () => {
    const files = [
      "docs-site/content/docs/en/guides/web-dashboard.md",
      "docs-site/content/docs/ko/guides/web-dashboard.md",
      "docs-site/content/docs/zh-cn/guides/web-dashboard.md",
    ];
    const failures: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (!/dashboard\/API|대시보드\/API|仪表盘\/API/.test(text)) failures.push(`${file}: missing dashboard/API reload wording`);
      if (!text.includes("modelReload")) failures.push(`${file}: missing refresh API modelReload metadata`);
    }
    expect(failures).toEqual([]);
  });
});
