import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const SURFACES = [
  "package.json",
  "README.md",
  "README.ko.md",
  "README.zh-CN.md",
  "src",
  "gui/src",
  "docs-site/content/docs",
] as const;

const TEXT_EXTENSIONS = new Set([".json", ".md", ".mdx", ".ts", ".tsx", ".js", ".mjs"]);

function extension(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx);
}

async function collectFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return TEXT_EXTENSIONS.has(extension(path)) ? [path] : [];
  const out: string[] = [];
  for (const entry of await readdir(path)) {
    if (entry === "dist" || entry === "node_modules" || entry.startsWith(".")) continue;
    out.push(...await collectFiles(join(path, entry)));
  }
  return out;
}

function isAllowedContext(line: string): boolean {
  return /not\s+(?:a\s+)?(?:goal|supported|included)|non-?target|does not|never|no hosted\/cloud|did not use|must not|forbidden/i.test(line);
}

const FORBIDDEN_SCOPE_CLAIMS = [
  {
    label: "hosted/cloud deployment product scope",
    pattern: /\b(?:hosted|cloud)\s+(?:deployment|service|proxy|sync|account|console)\b/i,
  },
  {
    label: "account/team/org/admin/billing product scope",
    pattern: /\b(?:team|org|admin|billing)\b[^\n]{0,100}\b(?:feature|flow|support|setup|route|api|dashboard|console)\b/i,
  },
  {
    label: "remote sync product scope",
    pattern: /\bremote[- ]sync\b|\bremote\s+settings\s+sync\b/i,
  },
];

describe("static non-goal scope guard", () => {
  test("current product surfaces do not introduce hosted, account, team, billing, or remote-sync scope", async () => {
    const failures: string[] = [];
    const files = (await Promise.all(SURFACES.map(surface => collectFiles(surface)))).flat().sort();
    for (const file of files) {
      const text = await readFile(file, "utf8");
      text.split("\n").forEach((line, index) => {
        for (const matcher of FORBIDDEN_SCOPE_CLAIMS) {
          if (!matcher.pattern.test(line)) continue;
          if (isAllowedContext(line)) continue;
          failures.push(`${file}:${index + 1}: ${matcher.label}: ${line.trim()}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });
});
