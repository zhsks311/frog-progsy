/**
 * Adversarial / boundary / property tests for routeModel.
 * These try to BREAK the resolver; every case asserts both providerName AND routeKind.
 * Approved acceptance criteria are cited as e.g. "[AC1]" from the implementation contract.
 */
import { describe, expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { computeModelAliases, deterministicModelAlias, GATEWAY_MODEL_ALIAS_PREFIX } from "../src/model-aliases";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

type ProviderSpec = Partial<FrogProviderConfig> & { adapter: string };

function mkConfig(providers: Record<string, ProviderSpec>, defaultProvider: string): FrogConfig {
  const full: Record<string, FrogProviderConfig> = {};
  for (const [name, spec] of Object.entries(providers)) {
    full[name] = { baseUrl: "https://example.test", ...spec } as FrogProviderConfig;
  }
  return { port: 0, providers: full, defaultProvider } as FrogConfig;
}

describe("routeModel adversarial / boundary / property tests", () => {
  // ─── ADV1: Empty config throws, not an undefined property access crash ───────────
  test("ADV1: zero providers + empty defaultProvider → throws with diagnostic, not crash", () => {
    const config = mkConfig({}, "");
    expect(() => routeModel(config, "gpt-4o")).toThrow(/No provider configured for model "gpt-4o"/);
    expect(() => routeModel(config, "gpt-4o")).toThrow(/Configured providers: \(none\)/);
  });

  // ─── ADV2: Declared model ids are exact, not prefix support claims ─────────────
  test("ADV2: declared stem 'gpt-5' does NOT capture 'gpt-50'", () => {
    const config = mkConfig(
      {
        p: { adapter: "openai-chat", models: ["gpt-5"] },
        openai: { adapter: "openai-responses" }, // on family allowlist → family fallback
      },
      "p",
    );
    const route = routeModel(config, "gpt-50");
    // `models: ["gpt-5"]` is an exact support declaration; it does not imply `gpt-50`.
    // "gpt-50" starts with "gpt-" → openai family, allowlist has "openai" with correct adapter.
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("openai");
  });

  test("ADV2b: declared stem 'gpt-5' does NOT capture 'gpt-5-mini'", () => {
    const config = mkConfig(
      {
        p: { adapter: "openai-chat", models: ["gpt-5"] },
        openai: { adapter: "openai-responses" },
      },
      "p",
    );
    const route = routeModel(config, "gpt-5-mini");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("openai");
  });

  // ─── ADV3: Custom slash/dot/colon suffixes do not become implicit prefixes ─────
  test("ADV3: custom declared stems with suffixes fall through to default", () => {
    for (const modelId of ["mymodel-v2", "mymodel.v2", "mymodel/v2", "mymodel:v2"]) {
      const config = mkConfig({ p: { adapter: "openai-chat", models: ["mymodel"] } }, "p");
      const route = routeModel(config, modelId);
      expect(route.routeKind).toBe("default");
      expect(route.providerName).toBe("p");
      expect(route.modelId).toBe(modelId);
    }
  });

  // ─── ADV4: 3-way exact-default collision → deterministic lexicographic winner + sorted candidates
  // Related to [AC1], [AC3]
  test("ADV4: 3-way collision on defaultModel → lex winner 'alpha', ambiguousCandidates sorted", () => {
    const config = mkConfig(
      {
        zebra: { adapter: "openai-chat", defaultModel: "shared-model" },
        alpha: { adapter: "openai-chat", defaultModel: "shared-model" },
        mango: { adapter: "openai-chat", defaultModel: "shared-model" },
      },
      "no-such-default",
    );
    const route = routeModel(config, "shared-model");
    expect(route.routeKind).toBe("exact-default");
    expect(route.providerName).toBe("alpha"); // lexicographic first among [alpha,mango,zebra]
    expect(route.ambiguousCandidates).toEqual(["alpha", "mango", "zebra"]); // fully sorted
  });

  // ─── ADV5: defaultProvider tie-break beats lexicographic ordering ─────────────
  // Related to [AC2]: defaultProvider wins; ambiguousCandidates must be absent.
  test("ADV5: defaultProvider='mango' wins 3-way collision; no ambiguousCandidates recorded", () => {
    const config = mkConfig(
      {
        zebra: { adapter: "openai-chat", defaultModel: "shared-model" },
        alpha: { adapter: "openai-chat", defaultModel: "shared-model" },
        mango: { adapter: "openai-chat", defaultModel: "shared-model" },
      },
      "mango", // not the lex winner but IS the defaultProvider
    );
    const route = routeModel(config, "shared-model");
    expect(route.routeKind).toBe("exact-default");
    expect(route.providerName).toBe("mango");
    expect(route.ambiguousCandidates).toBeUndefined(); // tie-break by defaultProvider → no ambiguity
  });

  // ─── ADV6: Adapter guard — openai allowlisted but wrong adapter → skipped ─────
  // [AC13] generalized: the adapter guard applies to any allowlisted provider.
  test("ADV6: 'openai' allowlisted for gpt-* but adapter='anthropic' → guard skips → default", () => {
    const config = mkConfig(
      {
        openai: { adapter: "anthropic" }, // wrong adapter; should be openai-responses or openai-chat
        kimi: { adapter: "openai-chat" }, // NOT on openai family allowlist
      },
      "kimi",
    );
    const route = routeModel(config, "gpt-4o");
    // openai on allowlist but adapter guard fails; kimi not on allowlist → family candidate = null
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("kimi");
  });

  // ─── ADV6b: Wrong-adapter allowlisted provider skipped; next sibling wins ─────
  test("ADV6b: openai skipped (bad adapter); openai-apikey (correct adapter) wins via family", () => {
    const config = mkConfig(
      {
        openai: { adapter: "anthropic" },            // wrong adapter, skipped
        "openai-apikey": { adapter: "openai-chat" }, // 2nd on allowlist, correct adapter
      },
      "some-default",
    );
    const route = routeModel(config, "gpt-4o");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("openai-apikey");
  });

  // ─── ADV7: Allowlist guard — kimi/ollama/qwen-portal only → gpt-4o never 'family' ─
  // [AC13]: the allowlist is the ONLY candidate source; adapter-matching non-allowlist providers
  // must never leak in.
  test("ADV7: only kimi/ollama/qwen-portal configured → gpt-4o falls to default, routeKind≠family", () => {
    const config = mkConfig(
      {
        kimi: { adapter: "openai-chat" },
        ollama: { adapter: "openai-chat" },
        "qwen-portal": { adapter: "openai-chat" },
      },
      "kimi",
    );
    const route = routeModel(config, "gpt-4o");
    expect(route.routeKind).not.toBe("family"); // allowlist guard prevents leakage
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("kimi");
  });

  // ─── ADV8: Slash in id, prefix is NOT a configured provider → s2 skips → default ─
  // [AC4] adversarial: s2 only fires if the slash-prefix IS a configured provider key.
  test("ADV8: 'notaprovider/gpt-4o' → s2 skips; full id starts with 'notaprovider/' so family misses → default", () => {
    const config = mkConfig(
      { openai: { adapter: "openai-responses" } },
      "openai",
    );
    const route = routeModel(config, "notaprovider/gpt-4o");
    // s2: provName="notaprovider" → not in providers → skip
    // s6: "notaprovider/gpt-4o".startsWith("gpt-") → false → family miss
    // s7: default
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("openai");
    expect(route.modelId).toBe("notaprovider/gpt-4o"); // full id passed through unchanged
  });

  // ─── ADV9: Empty string model id → routes to default if default exists ─────────
  test("ADV9: empty string model id with valid defaultProvider → routeKind='default'", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" } },
      "codex",
    );
    const route = routeModel(config, "");
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe(""); // empty string passed through
  });

  // ─── ADV9b: Empty string model id + missing default → throws ─────────────────
  test("ADV9b: empty string model id + defaultProvider not in providers → throws", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" } },
      "", // not a valid provider key
    );
    expect(() => routeModel(config, "")).toThrow(/No provider configured/);
  });

  // ─── ADV10: Very long model id → no crash ────────────────────────────────────
  test("ADV10: 2004-char model id ('gpt-' + 2000 x-chars) does not crash; routes via family", () => {
    const longId = "gpt-" + "x".repeat(2000);
    const config = mkConfig({ openai: { adapter: "openai-responses" } }, "openai");
    // "gpt-xxxx..." starts with "gpt-" → openai family, openai has correct adapter
    expect(() => routeModel(config, longId)).not.toThrow();
    const route = routeModel(config, longId);
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("openai");
  });

  // ─── ADV11: Unicode model id → no crash ──────────────────────────────────────
  test("ADV11: unicode model id does not crash; routes to default", () => {
    const unicodeId = "模型-v1.0-pro";
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" } },
      "codex",
    );
    expect(() => routeModel(config, unicodeId)).not.toThrow();
    const route = routeModel(config, unicodeId);
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("codex");
  });

  // ─── ADV12: Alias precedence over s3 client-default ──────────────────────────
  // Deterministic aliases start with "claude-frogp-" (a "claude-" prefix).
  // On a non-Anthropic default, s3 would redirect claude-* ids. But s1 must fire first.
  test("ADV12: alias (which starts with 'claude-') beats s3 client-default on non-Anthropic default", () => {
    const config = mkConfig(
      {
        "some-provider": {
          adapter: "openai-chat",
          models: ["Model-X"],
          defaultModel: "some-default-model",
        },
      },
      "some-provider", // non-Anthropic default → s3 would redirect claude-* if s1 missed
    );
    const alias = deterministicModelAlias("some-provider", "Model-X");
    // alias = "claude-frogp-some-provider-model-x" — starts with "claude-"
    expect(alias.startsWith("claude-")).toBe(true); // verify the premise

    const route = routeModel(config, alias);
    expect(route.routeKind).toBe("alias"); // s1 wins; s3 never fires
    expect(route.providerName).toBe("some-provider");
    expect(route.modelId).toBe("Model-X");
  });

  // ─── ADV13: Declared stem equal to model id → s4/s5 exact matching wins ───────
  test("ADV13: exact-length model id is exact-default/exact-model", () => {
    const config = mkConfig(
      {
        p: { adapter: "openai-chat", models: ["gpt-5"] },   // s5 candidate
        q: { adapter: "openai-chat", defaultModel: "gpt-5" }, // s4 candidate
      },
      "no-such-default",
    );
    const route = routeModel(config, "gpt-5");
    // s4 picks q (exact defaultModel), s5 picks p (exact models[]); s4 fires before s5.
    expect(route.routeKind).toBe("exact-default");
    expect(route.providerName).toBe("q");
  });

  // ─── ADV14: Family fallback is not preempted by provider-declared stems ───────
  test("ADV14a: 'gpt-4o' routes via family, not a provider declaring 'gpt-4'", () => {
    const config = mkConfig(
      {
        "my-openai": { adapter: "openai-chat", models: ["gpt-4"] },
        openai: { adapter: "openai-responses" }, // on allowlist
      },
      "openai",
    );
    const route = routeModel(config, "gpt-4o");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("openai");
  });

  test("ADV14b: 'gpt-4-turbo' also routes via family, not a provider declaring 'gpt-4'", () => {
    const config = mkConfig(
      {
        "my-openai": { adapter: "openai-chat", models: ["gpt-4"] },
        openai: { adapter: "openai-responses" },
      },
      "openai",
    );
    const route = routeModel(config, "gpt-4-turbo");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("openai");
  });

  // ─── ADV15: s5 exact-models[] 3-way collision with defaultProvider tie-break ──
  test("ADV15: models[] 3-way collision; defaultProvider='gamma' wins with no ambiguousCandidates", () => {
    const config = mkConfig(
      {
        alpha: { adapter: "openai-chat", models: ["shared-model-v2"] },
        beta: { adapter: "openai-chat", models: ["shared-model-v2"] },
        gamma: { adapter: "openai-chat", models: ["shared-model-v2"] },
      },
      "gamma",
    );
    const route = routeModel(config, "shared-model-v2");
    expect(route.routeKind).toBe("exact-model");
    expect(route.providerName).toBe("gamma");
    expect(route.ambiguousCandidates).toBeUndefined(); // defaultProvider wins → no tie-break recorded
  });

  // ─── ADV16: Groq model routes to groq, not openai ────────────────────────────
  test("ADV16: 'llama-3.1-70b' routes to groq family, not openai family", () => {
    const config = mkConfig(
      {
        openai: { adapter: "openai-responses" },
        groq: { adapter: "openai-chat" },
      },
      "openai",
    );
    const route = routeModel(config, "llama-3.1-70b");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("groq");
  });

  // ─── ADV17: o3-mini routes via o3- prefix to openai family ───────────────────
  test("ADV17: 'o3-mini' routes to openai family via 'o3-' prefix", () => {
    const config = mkConfig(
      { openai: { adapter: "openai-responses" } },
      "openai",
    );
    const route = routeModel(config, "o3-mini");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("openai");
  });

  // ─── ADV18: Longer declared stems still do not imply prefix routing ────────────
  test("ADV18: 'gpt-5.5-turbo' ignores declared stems and uses curated family", () => {
    const config = mkConfig(
      {
        short: { adapter: "openai-chat", models: ["gpt-5"] },
        long: { adapter: "openai-chat", models: ["gpt-5.5"] },
        codex: { adapter: "openai-responses" },
      },
      "short",
    );
    const route = routeModel(config, "gpt-5.5-turbo");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("codex");
  });

  // ─── ADV19: defaultProvider missing from providers + no family match → throws ─
  test("ADV19: defaultProvider not in providers.keys + unresolvable id → throws", () => {
    const config = mkConfig(
      { kimi: { adapter: "openai-chat" } },
      "nonexistent-provider",
    );
    expect(() => routeModel(config, "totally-unknown-xyz")).toThrow(/No provider configured for model "totally-unknown-xyz"/);
  });

  // ─── ADV20: models[] collision is insertion-order independent ─────────────────
  // [AC1] generalized to s5 (exact-models).
  test("ADV20: exact-model collision is insertion-order independent; 'codex' < 'openai-apikey' lex", () => {
    const forward = mkConfig(
      {
        "openai-apikey": { adapter: "openai-responses", models: ["special-model-v3"] },
        codex: { adapter: "openai-responses", models: ["special-model-v3"] },
      },
      "no-such-default",
    );
    const reversed = mkConfig(
      {
        codex: { adapter: "openai-responses", models: ["special-model-v3"] },
        "openai-apikey": { adapter: "openai-responses", models: ["special-model-v3"] },
      },
      "no-such-default",
    );
    const a = routeModel(forward, "special-model-v3");
    const b = routeModel(reversed, "special-model-v3");
    expect(a.providerName).toBe("codex");
    expect(a.routeKind).toBe("exact-model");
    expect(b.providerName).toBe(a.providerName);
    expect(b.routeKind).toBe(a.routeKind);
  });

  // ─── ADV21: s3 does NOT redirect claude-* when defaultProvider IS Anthropic ──
  // isAnthropicProviderName("anthropic") → true → s3 skips.
  test("ADV21: claude-* does NOT redirect to defaultModel when defaultProvider is 'anthropic'", () => {
    const config = mkConfig(
      { anthropic: { adapter: "anthropic" } },
      "anthropic",
    );
    const route = routeModel(config, "claude-sonnet-4-6");
    // s3 skips → s6 family: "claude-" prefix → anthropic family, allowlist=["anthropic"], adapter ok
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("anthropic");
  });

  // ─── ADV22: "anthropic-<suffix>" provider name also bypasses s3 redirect ──────
  // isAnthropicProviderName("anthropic-eu") → true (startsWith("anthropic-")).
  // But "anthropic-eu" is NOT on the anthropic family allowlist → family null → default.
  test("ADV22: 'anthropic-eu' as defaultProvider → s3 bypassed; 'anthropic-eu' not on allowlist → default", () => {
    const config = mkConfig(
      { "anthropic-eu": { adapter: "anthropic" } },
      "anthropic-eu",
    );
    const route = routeModel(config, "claude-opus-4");
    // s3 skips (isAnthropicProviderName("anthropic-eu") === true)
    // s6: "claude-" matches anthropic family; allowlist=["anthropic"]; "anthropic-eu" not on it → null
    // s7: defaultProvider "anthropic-eu" exists → default
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("anthropic-eu");
  });

  // ─── ADV23: routeKind is NEVER the string "ambiguous" even under multi-candidate ties ─
  // The spec explicitly states RouteKind has no "ambiguous" value.
  test("ADV23: routeKind is never 'ambiguous'; the resolving stage is always recorded", () => {
    const config = mkConfig(
      {
        alpha: { adapter: "openai-chat", defaultModel: "model-z" },
        beta: { adapter: "openai-chat", defaultModel: "model-z" },
        gamma: { adapter: "openai-chat", defaultModel: "model-z" },
      },
      "no-such-default",
    );
    const route = routeModel(config, "model-z");
    const validKinds = [
      "alias", "qualified", "client-default", "exact-default",
      "exact-model", "family", "default",
    ] as const;
    expect(route.routeKind).not.toBe("ambiguous" as never);
    expect(validKinds).toContain(route.routeKind);
    // ambiguousCandidates carries the tie-break metadata, not routeKind
    expect(route.ambiguousCandidates).toEqual(["alpha", "beta", "gamma"]);
  });

  // ─── ADV24: Slash in id is qualified only when the slash-prefix is a provider ──
  test("ADV24: 'mymodel/v2' with stem 'mymodel' in models[] → default, not qualified", () => {
    const config = mkConfig(
      { p: { adapter: "openai-chat", models: ["mymodel"] } },
      "p",
    );
    const route = routeModel(config, "mymodel/v2");
    // s2: provName="mymodel" → not in config.providers → skips; no implicit prefix stage exists.
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("p");
    expect(route.modelId).toBe("mymodel/v2");
  });

  // ─── ADV25: Groq provider not configured → llama-* falls to default, not family ─
  test("ADV25: groq not configured → 'llama-3.1-70b' falls to default, routeKind≠family", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" } },
      "codex",
    );
    const route = routeModel(config, "llama-3.1-70b");
    // groq allowlist: ["groq"], but "groq" not in config.providers → family candidate null → s8
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("codex");
  });

  // ─── ADV26: Multiple declared stems do not create hidden prefix candidates ─────
  test("ADV26: same provider with two related stems still routes extended ids via family", () => {
    const config = mkConfig(
      {
        p: { adapter: "openai-chat", models: ["gpt-5", "gpt-5.5"] },
        q: { adapter: "openai-chat", models: ["gpt-5.5"] },
        codex: { adapter: "openai-responses" },
      },
      "p",
    );
    const route = routeModel(config, "gpt-5.5-turbo");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("codex");
    expect(route.ambiguousCandidates).toBeUndefined();
  });

  // ─── ADV27: Family fallback selects first valid allowlist entry in order ──────
  // openai allowlist = ["openai", "openai-apikey", "codex"]; only codex configured.
  test("ADV27: family allowlist order — only 'codex' configured; 'openai' and 'openai-apikey' absent", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses" } },
      "codex",
    );
    const route = routeModel(config, "gpt-4o");
    // "openai" → not in providers; "openai-apikey" → not in providers; "codex" → in providers + correct adapter
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("codex");
  });

  // ─── ADV28: Unknown current-prefix gateway alias fails closed (typed 404) ──────
  // The gateway alias namespace is exact-only. An id carrying the live prefix that resolves to
  // nothing must throw at the router, NOT drift into default/family/client-default routing.
  test("ADV28: unknown 'claude-frogp-*' id throws instead of drifting to the default provider", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5", models: ["gpt-5.5"] } },
      "codex",
    );
    const unknown = `${GATEWAY_MODEL_ALIAS_PREFIX}codex-nonexistent-model`;
    expect(unknown.startsWith("claude-frogp-")).toBe(true); // premise: current gateway prefix
    expect(() => routeModel(config, unknown)).toThrow(/Unknown gateway model alias/);
  });

  // ─── ADV29: Known deterministic gateway alias still routes exact ──────────────
  test("ADV29: known deterministic gateway alias routes to its exact provider/model (routeKind='alias')", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5", models: ["gpt-5.5"] } },
      "codex",
    );
    const alias = deterministicModelAlias("codex", "gpt-5.5");
    const route = routeModel(config, alias);
    expect(route.routeKind).toBe("alias");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
  });

  // ─── ADV30: Collision-suffix gateway alias is not swallowed by the fail-closed guard ─
  test("ADV30: collision-suffix gateway alias still routes exact through routeModel", () => {
    const config = mkConfig(
      { p: { adapter: "openai-chat", models: ["gpt-5.5", "gpt-5-5"] } },
      "p",
    );
    const aliases = computeModelAliases([
      { provider: "p", model: "gpt-5.5" },
      { provider: "p", model: "gpt-5-5" },
    ]);
    const aliasA = aliases.get("p/gpt-5.5")!;
    expect(aliasA).toMatch(/^claude-frogp-p-gpt-5-5-[a-f0-9]{6}$/); // collision suffix present
    const route = routeModel(config, aliasA);
    expect(route.routeKind).toBe("alias");
    expect(route.providerName).toBe("p");
    expect(route.modelId).toBe("gpt-5.5");
  });

  // ─── ADV31: Built-in 'claude-*' ids (no gateway prefix) keep their existing routing ─
  // The fail-closed guard is scoped to the gateway prefix; ordinary Claude built-ins must be
  // unaffected and still redirect to the default provider on a non-Anthropic default.
  test("ADV31: built-in 'claude-sonnet-*' (no gateway prefix) still redirects to default provider", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5", models: ["gpt-5.5"] } },
      "codex",
    );
    const route = routeModel(config, "claude-sonnet-4-6");
    expect(route.routeKind).toBe("client-default");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
  });
});
