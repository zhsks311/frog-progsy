import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Static proof of the dual-auth "eight seams" structure (structure/09_claude-dual-auth.md).
 *
 * All provider request-auth resolution funnels through the central `resolveProviderAuth` seam, and
 * the two low-level credential brokers (`getValidAccessToken`, `getClaudeGrantAccessToken`) are only
 * ever called DIRECTLY from a minimal, reviewed allowlist. Every other surface must go through the
 * central seam, so a new caller that bypasses it (and thereby skips auth-mode dispatch / fail-closed
 * semantics / redaction) is caught here without running the server.
 *
 * This guard targets function *calls* only. A plain `authMode === "oauth"` comparison or a
 * provider-delete credential cleanup (`removeCredential`) is NOT an auth-acquisition call and is not
 * forbidden — asserted explicitly below.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(REPO_ROOT, "src");

function rel(path: string): string {
  return relative(REPO_ROOT, path).split("\\").join("/");
}

function collectSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...collectSrcFiles(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Direct (bare) calls of `fnName`: the identifier immediately followed by `(`, NOT preceded by `.`
 * (a property/dependency-injected call like `deps.getClaudeGrantAccessToken(...)` is the central
 * seam's own dispatch and is allowed) and NOT a `function` declaration.
 */
function findDirectCalls(text: string, fnName: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split("\n");
  const re = new RegExp(`(^|[^.\\w])${fnName}\\s*\\(`, "g");
  lines.forEach((line, index) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(0, m.index + m[1].length);
      if (/\bfunction\s+$/.test(before)) continue; // the definition itself
      out.push({ line: index + 1, text: line.trim() });
    }
  });
  return out;
}

/** Slice a top-level function body from its declaration to the next top-level function declaration. */
function topLevelFunctionBody(source: string, name: string): string | null {
  const re = /\n((?:export )?(?:async )?function (\w+))\s*(?:<[^>]*>)?\(/g;
  const decls: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) decls.push({ name: m[2]!, index: m.index });
  const i = decls.findIndex(d => d.name === name);
  if (i === -1) return null;
  const start = decls[i]!.index;
  const end = i + 1 < decls.length ? decls[i + 1]!.index : source.length;
  return source.slice(start, end);
}

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// ── low-level broker allowlists ──────────────────────────────────────────────

// getValidAccessToken is DEFINED in oauth/index.ts and referenced by the central seam
// (provider-auth.ts) as its default oauth resolver. After model-listing centralization (task 46)
// there are no bare direct calls left; these two files are the only legitimate reference sites.
const GET_VALID_ACCESS_TOKEN_ALLOWLIST = new Set([
  "src/oauth/index.ts",
  "src/provider-auth.ts",
]);

// getClaudeGrantAccessToken is DEFINED in claude-grant-auth.ts and dispatched by the central seam
// (provider-auth.ts, via injected deps — a property call, not a bare call). The ONLY sanctioned bare
// direct call is the consented live probe (claude-grant-probe.ts): it acquires the bound grant's
// token through its OWN injectable getAccessToken seam (defaulting to the broker) to validate the
// grant against the real gateway — a distinct low-level concern from request-auth. Every request-auth
// surface (server seams, fallback, model listing, connection test) goes through resolveProviderAuth.
const GET_CLAUDE_GRANT_ALLOWLIST = new Set([
  "src/claude-grant-auth.ts",  // definition
  "src/provider-auth.ts",      // central seam dispatch (deps.getClaudeGrantAccessToken)
  "src/claude-grant-probe.ts", // consented live-probe low-level exception (own injectable seam)
]);

describe("static provider-auth seam guard", () => {
  test("getValidAccessToken is called directly only from the reviewed allowlist", () => {
    const offenders: string[] = [];
    for (const file of collectSrcFiles(SRC_DIR)) {
      const relPath = rel(file);
      const calls = findDirectCalls(readFileSync(file, "utf8"), "getValidAccessToken");
      if (calls.length === 0) continue;
      if (GET_VALID_ACCESS_TOKEN_ALLOWLIST.has(relPath)) continue;
      for (const c of calls) offenders.push(`${relPath}:${c.line}: ${c.text}`);
    }
    expect(offenders).toEqual([]);
  });

  test("getClaudeGrantAccessToken is called directly only from the reviewed allowlist", () => {
    const offenders: string[] = [];
    for (const file of collectSrcFiles(SRC_DIR)) {
      const relPath = rel(file);
      const calls = findDirectCalls(readFileSync(file, "utf8"), "getClaudeGrantAccessToken");
      if (calls.length === 0) continue;
      if (GET_CLAUDE_GRANT_ALLOWLIST.has(relPath)) continue;
      for (const c of calls) offenders.push(`${relPath}:${c.line}: ${c.text}`);
    }
    expect(offenders).toEqual([]);
  });

  test("model-listing auth is centralized through the seam (no low-level models dispatch remains)", () => {
    // Task 46 removed resolveModelsAuthToken; oauth/index no longer dispatches any broker, and the
    // per-provider model fetch (claude-catalog) resolves its credential via resolveProviderAuth.
    const oauthIndex = read("src/oauth/index.ts");
    expect(topLevelFunctionBody(oauthIndex, "resolveModelsAuthToken")).toBeNull();
    expect(findDirectCalls(oauthIndex, "getClaudeGrantAccessToken")).toEqual([]);

    const catalogBody = topLevelFunctionBody(read("src/claude-catalog.ts"), "fetchProviderModels");
    expect(catalogBody).not.toBeNull();
    expect(catalogBody!).toContain("resolveProviderAuth(");
    expect(findDirectCalls(catalogBody!, "getClaudeGrantAccessToken")).toEqual([]);
    expect(findDirectCalls(catalogBody!, "getValidAccessToken")).toEqual([]);
  });

  test("the consented live probe is the only sanctioned low-level grant-broker caller", () => {
    const probe = read("src/claude-grant-probe.ts");
    // The probe validates a bound grant against the real gateway, so it acquires the grant token
    // directly — but through its OWN injectable getAccessToken seam (defaulting to the broker), which
    // keeps it testable without a real Keychain and is why it is allowlisted above.
    expect(findDirectCalls(probe, "getClaudeGrantAccessToken").length).toBeGreaterThan(0);
    expect(probe).toMatch(/getAccessToken/);
    // It never routes request-auth through the central seam nor calls the oauth broker.
    expect(findDirectCalls(probe, "getValidAccessToken")).toEqual([]);
  });

  test("the central seam dispatches both auth modes via injected deps and imports the low-level brokers", () => {
    const src = read("src/provider-auth.ts");
    expect(src).toContain('from "./claude-grant-auth"');
    expect(src).toContain('from "./oauth/index"');
    // Dispatch is through injected deps (property calls), never a bare call that would bypass tests.
    expect(src).toContain("deps.getOAuthAccessToken(");
    expect(src).toContain("deps.getClaudeGrantAccessToken(");
    // No bare direct calls in the seam itself.
    expect(findDirectCalls(src, "getValidAccessToken")).toEqual([]);
    expect(findDirectCalls(src, "getClaudeGrantAccessToken")).toEqual([]);
  });

  test("one-way import graph: the low-level oauth module never imports the central seam", () => {
    const oauthIndex = read("src/oauth/index.ts");
    // "provider-auth" appears in oauth/index.ts prose ("mirrors resolveProviderAuth", "not
    // importing provider-auth") — assert on an actual import statement, not the bare substring.
    expect(oauthIndex).not.toMatch(/from\s+"\.\.?\/provider-auth"/);
    // grant core is a leaf too.
    expect(read("src/claude-grant-auth.ts")).not.toContain('from "./provider-auth"');
  });
});

describe("auth-acquisition seams route through the central resolveProviderAuth seam", () => {
  const SERVER_SEAMS = [
    "runCoordinatorCompletion",
    "runMixTurn",
    "handleResponses",
    "handleMessages",
    "handleCountTokens",
    "testProviderConnection",
  ] as const;

  test("each server.ts seam calls the central resolveProviderAuth seam", () => {
    const server = read("src/server.ts");
    const missing: string[] = [];
    for (const seam of SERVER_SEAMS) {
      const body = topLevelFunctionBody(server, seam);
      if (!body) {
        missing.push(`${seam}: function not found`);
        continue;
      }
      if (!body.includes("resolveProviderAuth(")) missing.push(`${seam}: no resolveProviderAuth call`);
    }
    expect(missing).toEqual([]);
  });

  test("the OpenAI-Responses fallback seam routes through the central seam", () => {
    const body = topLevelFunctionBody(read("src/fallback-openai-responses.ts"), "resolveOpenAIResponsesFallbackProvider");
    expect(body).not.toBeNull();
    expect(body!).toContain("resolveProviderAuth(");
    // Fallback must not reach past the seam to a low-level broker.
    expect(findDirectCalls(body!, "getValidAccessToken")).toEqual([]);
    expect(findDirectCalls(body!, "getClaudeGrantAccessToken")).toEqual([]);
  });

  test("model listing (claude-catalog) and the provider connection test route through the central seam", () => {
    // Task 46 centralized both former non-server surfaces through resolveProviderAuth.
    const catalogBody = topLevelFunctionBody(read("src/claude-catalog.ts"), "fetchProviderModels");
    expect(catalogBody).not.toBeNull();
    expect(catalogBody!).toContain("resolveProviderAuth(");

    const providerTest = read("src/provider-test.ts");
    expect(providerTest).toContain("resolveProviderAuth");
    // provider-test dispatches via an injectable resolver defaulting to resolveProviderAuth and no
    // longer calls the grant broker directly.
    expect(providerTest).toMatch(/resolveAuth\s*\?\?\s*resolveProviderAuth/);
    expect(findDirectCalls(providerTest, "getClaudeGrantAccessToken")).toEqual([]);
    expect(findDirectCalls(providerTest, "getValidAccessToken")).toEqual([]);
  });

  test("server.ts routes at least every named auth seam through resolveProviderAuth", () => {
    // The 6 server seams + the fallback + model listing (claude-catalog) + the connection test
    // (provider-test) all funnel through resolveProviderAuth; the consented live probe is the one
    // sanctioned low-level broker caller (covered above). This asserts the server-local count.
    const server = read("src/server.ts");
    const serverCalls = findDirectCalls(server, "resolveProviderAuth")
      .filter(c => !c.text.startsWith("import"));
    expect(serverCalls.length).toBeGreaterThanOrEqual(SERVER_SEAMS.length);
  });
});

describe("guard scope: authMode comparisons and provider-delete cleanup are not forbidden", () => {
  test("the direct-call detector ignores authMode comparisons and property accesses", () => {
    const benign = [
      'if (provider.authMode === "oauth") {',
      'if (route.provider.authMode === "oauth" || route.provider.authMode === "claude-grant") {',
      "resolved.apiKey = await deps.getClaudeGrantAccessToken(config, providerName, provider);",
      "return await deps.getOAuthAccessToken(providerName);",
    ].join("\n");
    expect(findDirectCalls(benign, "getValidAccessToken")).toEqual([]);
    expect(findDirectCalls(benign, "getClaudeGrantAccessToken")).toEqual([]);

    // A genuine bare call IS detected — proves the detector is not vacuous.
    const offending = "const t = await getValidAccessToken(name);";
    expect(findDirectCalls(offending, "getValidAccessToken").length).toBe(1);
  });

  test("provider-delete oauth credential cleanup is present and not treated as an acquisition call", () => {
    const server = read("src/server.ts");
    // The legitimate non-seam authMode read: on provider delete, drop the stored OAuth credential.
    expect(server).toContain("removeCredential(");
    expect(server).toMatch(/authMode === "oauth"/);
    // server.ts holds no bare low-level acquisition calls — all its auth goes through the seam.
    expect(findDirectCalls(server, "getValidAccessToken")).toEqual([]);
    expect(findDirectCalls(server, "getClaudeGrantAccessToken")).toEqual([]);
  });
});
