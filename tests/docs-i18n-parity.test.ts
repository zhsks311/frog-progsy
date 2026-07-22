import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";

// Docs i18n parity guard — the documentation counterpart of the dashboard i18n policy
// (gui/src/i18n: en is the source of truth; ko/zh are compile-checked against its keys).
//
// English docs are the source of truth. Korean (ko) and Chinese (zh-cn) trees must stay
// structurally synchronized so translations cannot silently drift:
//   1. identical file sets (no missing or extra pages per locale),
//   2. identical frontmatter keys,
//   3. identical heading-depth sequences (titles are translated, structure is not),
//   4. identical fence count + info-string sequence,
//   5. byte-identical fence bodies for machine-content fences (code/config is code),
//      while prose-ish fences (text/txt/bash diagrams, commands with comments) may localize,
//   6. identical multiset of high-precision decimal tokens (pins evidence numbers such as
//      eval deltas/CIs so one locale cannot quote different results).
// The README triple (README.md / README.ko.md / README.zh-CN.md) follows the same rules.

const DOCS_ROOT = "docs-site/content/docs";
const LOCALES = ["ko", "zh-cn"] as const;
/** Fences whose bodies are machine content and must be byte-identical across locales. */
const STRICT_FENCE_INFOS = new Set(["json", "jsonc", "ts", "tsx", "js", "javascript", "typescript"]);

function mdFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) out.push(...mdFiles(path, base));
    else if (entry.endsWith(".md")) out.push(path.slice(base.length + 1));
  }
  return out.sort();
}

function frontmatterKeys(text: string): string[] {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .filter(line => /^[A-Za-z0-9_-]+:/.test(line))
    .map(line => line.split(":")[0]!)
    .sort();
}

function headingDepths(text: string): number[] {
  const body = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  return [...body.matchAll(/^(#{1,6}) /gm)].map(m => m[1]!.length);
}

function fences(text: string): { info: string; body: string }[] {
  return [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)].map(m => ({
    info: m[1]!.trim().toLowerCase(),
    body: m[2]!,
  }));
}

/** High-precision decimals (3+ fraction digits) — evidence deltas, CI bounds, hashes-as-numbers. */
function decimalTokens(text: string): string[] {
  return (text.match(/[+-]?\d+\.\d{3,}/g) ?? []).sort();
}

function assertParity(label: string, enText: string, locText: string): void {
  expect(frontmatterKeys(locText), `${label}: frontmatter keys must match en`).toEqual(frontmatterKeys(enText));
  expect(headingDepths(locText), `${label}: heading-depth sequence must match en`).toEqual(headingDepths(enText));

  const enFences = fences(enText);
  const locFences = fences(locText);
  expect(locFences.map(f => f.info), `${label}: fence info sequence must match en`).toEqual(enFences.map(f => f.info));
  for (let i = 0; i < enFences.length; i++) {
    if (STRICT_FENCE_INFOS.has(enFences[i]!.info)) {
      expect(locFences[i]!.body, `${label}: fence #${i} (${enFences[i]!.info}) is machine content and must be byte-identical`).toBe(enFences[i]!.body);
    }
  }

  expect(decimalTokens(locText), `${label}: high-precision numeric claims must match en`).toEqual(decimalTokens(enText));
}

describe("docs i18n parity (en is the source of truth)", () => {
  const enSet = mdFiles(`${DOCS_ROOT}/en`);

  test("locale trees contain exactly the same pages as en", () => {
    for (const locale of LOCALES) {
      expect(mdFiles(`${DOCS_ROOT}/${locale}`), `${locale} file set must equal en`).toEqual(enSet);
    }
  });

  for (const locale of LOCALES) {
    test(`${locale} pages are structurally synchronized with en`, () => {
      for (const rel of enSet) {
        const enText = readFileSync(`${DOCS_ROOT}/en/${rel}`, "utf8");
        const locText = readFileSync(`${DOCS_ROOT}/${locale}/${rel}`, "utf8");
        assertParity(`${locale}/${rel}`, enText, locText);
      }
    });
  }

  test("README triple is structurally synchronized", () => {
    const en = readFileSync("README.md", "utf8");
    for (const file of ["README.ko.md", "README.zh-CN.md"]) {
      const loc = readFileSync(file, "utf8");
      expect(headingDepths(loc), `${file}: heading-depth sequence must match README.md`).toEqual(headingDepths(en));
      const enF = fences(en);
      const locF = fences(loc);
      expect(locF.map(f => f.info), `${file}: fence info sequence must match README.md`).toEqual(enF.map(f => f.info));
      for (let i = 0; i < enF.length; i++) {
        if (STRICT_FENCE_INFOS.has(enF[i]!.info)) {
          expect(locF[i]!.body, `${file}: fence #${i} (${enF[i]!.info}) must be byte-identical`).toBe(enF[i]!.body);
        }
      }
      expect(decimalTokens(loc), `${file}: numeric claims must match README.md`).toEqual(decimalTokens(en));
    }
  });
});
