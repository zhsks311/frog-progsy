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
  "docs-site/source.config.ts",
] as const;

const TEXT_EXTENSIONS = new Set([".json", ".md", ".mdx", ".ts", ".tsx", ".js", ".mjs"]);
const ALLOWED_PROVIDER_INTERNAL = new Set([
  "src/adapters/openai-responses.ts",
  "tests/openai-responses-upstream.test.ts",
  "src/oauth/codex.ts",
]);

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

async function surfaceFiles(): Promise<string[]> {
  const files = (await Promise.all(SURFACES.map(surface => collectFiles(surface)))).flat();
  // Normalize Windows separators so the forward-slash allowlist and matcher paths stay platform-neutral.
  // On POSIX a backslash can be a literal filename character, so preserve it rather than rewriting the path.
  return files.map(file => process.platform === "win32" ? file.replace(/\\/g, "/") : file).sort();
}

function isAllowed(path: string, line: string, label: string): boolean {
  switch (label) {
    default:
      if (ALLOWED_PROVIDER_INTERNAL.has(path) && line.includes("/v1/responses")) return true;
      if (path.includes("docs-site/content/docs") && line.includes("OpenAI Responses provider")) return true;
      if ((path === "src/claude-inject.ts" || path === "src/claude-history-provider.ts") && /model_provider|model_providers\.frogprogsy|config\.toml/.test(line)) return true;
      if (line.includes("retired") || line.includes("no-op") || line.includes("unsupported")) return true;
      if (/legacy|ignored|does not expose|not expose|does not advertise|not advertise|does \*\*not\*\*|not the active|광고하지|노출하지|주입하지|레거시|不会广告|不会向|不把|不再宣传|旧的/i.test(line)) return true;
      return false;
  }
}

const STALE_MATCHERS = [
  {
    label: "Claude Code described as OpenAI Responses inbound",
    pattern: /Claude Code[^\n]{0,160}(?:Responses API|\/v1\/responses|Responses WebSocket|supports_websockets)/i,
  },
  {
    label: "public architecture describes OpenAI Responses inbound",
    pattern: /(?:(?:request|requests|traffic|요청|请求)[^\n]{0,120}(?:enters? as|enter as|들어와|进入|格式进入)[^\n]{0,80}OpenAI Responses|OpenAI Responses[^\n]{0,120}(?:Responses SSE|로 들어와|格式进入))/i,
  },
  {
    label: "current setup advertises Responses WebSocket",
    pattern: /(?:Responses WebSocket support is advertised|supports_websockets\s*=\s*true|supports_websockets[^\n]{0,80}(?:advertis|광고|广告)|["`]websockets["`]\s*:\s*true|websockets:\s*true|uses? the Responses WebSocket path|WebSocket transport[^\n]{0,120}Responses WebSocket)/i,
  },
  {
    label: "current setup advertises config.toml provider injection",
    pattern: /(?:(?:writes?|appends?|injects?|기록|추가|주입|写入|追加|注入)[^\n]{0,180}(?:config\.toml|\bmodel_provider\b|\[model_providers\.frogprogsy\])|(?:config\.toml|\bmodel_provider\b|\[model_providers\.frogprogsy\])[^\n]{0,180}(?:writes?|appends?|injects?|기록|추가|주입|写入|追加|注入))/i,
  },
  {
    label: "current setup advertises resume-history remapping",
    pattern: /syncResumeHistory(?![^\n]{0,80}(?:retired|no-op|ignored|legacy))/,
  },
];

describe("static stale Codex/open Responses guard", () => {
  test("current public setup surfaces do not advertise stale Codex or Responses-WebSocket contracts", async () => {
    const failures: string[] = [];
    for (const file of await surfaceFiles()) {
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        for (const matcher of STALE_MATCHERS) {
          if (!matcher.pattern.test(line)) continue;
          if (isAllowed(file, line, matcher.label)) continue;
          failures.push(`${file}:${index + 1}: ${matcher.label}: ${line.trim()}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });
});
