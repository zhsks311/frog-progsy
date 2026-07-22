import { describe, expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { deterministicModelAlias } from "../src/model-aliases";
import type { FrogConfig, FrogProviderConfig } from "../src/types";

type ProviderSpec = Partial<FrogProviderConfig> & { adapter: string };

function mkConfig(providers: Record<string, ProviderSpec>, defaultProvider: string): FrogConfig {
  const full: Record<string, FrogProviderConfig> = {};
  for (const [name, spec] of Object.entries(providers)) {
    full[name] = { baseUrl: "https://example.test", ...spec } as FrogProviderConfig;
  }
  return { port: 0, providers: full, defaultProvider } as FrogConfig;
}

describe("routeModel deterministic matching", () => {
  // AC1 — collision resolves identically regardless of config.providers key insertion order.
  test("AC1: gpt-5.5 collision is insertion-order independent", () => {
    const forward = mkConfig(
      {
        codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" },
        "openai-apikey": { adapter: "openai-responses", defaultModel: "gpt-5.5" },
      },
      "no-such-default",
    );
    const reversed = mkConfig(
      {
        "openai-apikey": { adapter: "openai-responses", defaultModel: "gpt-5.5" },
        codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" },
      },
      "no-such-default",
    );
    const a = routeModel(forward, "gpt-5.5");
    const b = routeModel(reversed, "gpt-5.5");
    expect(a.providerName).toBe("codex"); // lexicographic: "codex" < "openai-apikey"
    expect(a.routeKind).toBe("exact-default");
    expect(b.providerName).toBe(a.providerName);
    expect(b.routeKind).toBe(a.routeKind);
  });

  // AC2 — the configured default provider wins a tie when it is among the candidates.
  test("AC2: defaultProvider wins the collision tie", () => {
    const config = mkConfig(
      {
        codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" },
        "openai-apikey": { adapter: "openai-responses", defaultModel: "gpt-5.5" },
      },
      "openai-apikey",
    );
    const route = routeModel(config, "gpt-5.5");
    expect(route.providerName).toBe("openai-apikey");
    expect(route.routeKind).toBe("exact-default");
    expect(route.ambiguousCandidates).toBeUndefined();
  });

  // AC3 — lexicographic tie-break records the sorted candidate set.
  test("AC3: lexicographic tie-break records ambiguousCandidates", () => {
    const config = mkConfig(
      {
        codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" },
        "openai-apikey": { adapter: "openai-responses", defaultModel: "gpt-5.5" },
      },
      "no-such-default",
    );
    const route = routeModel(config, "gpt-5.5");
    expect(route.providerName).toBe("codex");
    expect(route.ambiguousCandidates).toEqual(["codex", "openai-apikey"]);
  });

  // AC4 — explicit provider/model namespace always wins, even when a bare id would resolve elsewhere.
  test("AC4: provider/model qualified id wins", () => {
    const config = mkConfig(
      {
        codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" },
        "openai-apikey": { adapter: "openai-responses", defaultModel: "gpt-5.5" },
      },
      "codex",
    );
    const route = routeModel(config, "openai-apikey/gpt-5.5");
    expect(route.providerName).toBe("openai-apikey");
    expect(route.modelId).toBe("gpt-5.5");
    expect(route.routeKind).toBe("qualified");
  });

  // AC5 — a configured (deterministic) model alias resolves first.
  test("AC5: configured alias wins", () => {
    const config = mkConfig(
      { "provider-a": { adapter: "openai-chat", models: ["Model-X"] } },
      "provider-a",
    );
    const alias = deterministicModelAlias("provider-a", "Model-X");
    const route = routeModel(config, alias);
    expect(route.providerName).toBe("provider-a");
    expect(route.modelId).toBe("Model-X");
    expect(route.routeKind).toBe("alias");
  });

  // AC6 — claude-* built-in id redirects to a non-Anthropic default provider's defaultModel.
  test("AC6: claude-* client-default redirect", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" } },
      "codex",
    );
    const route = routeModel(config, "claude-sonnet-4-6");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
    expect(route.routeKind).toBe("client-default");
  });

  // AC7 — explicit anthropic/<model> still routes to Anthropic.
  test("AC7: anthropic explicit qualified route", () => {
    const config = mkConfig(
      {
        anthropic: { adapter: "anthropic" },
        codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" },
      },
      "codex",
    );
    const route = routeModel(config, "anthropic/claude-opus-4-8");
    expect(route.providerName).toBe("anthropic");
    expect(route.modelId).toBe("claude-opus-4-8");
    expect(route.routeKind).toBe("qualified");
  });

  // AC8 — exact defaultModel match takes precedence over a models[] match.
  test("AC8: exact-default precedence over exact-model", () => {
    const config = mkConfig(
      {
        x: { adapter: "openai-chat", defaultModel: "m1" },
        y: { adapter: "openai-chat", models: ["m1"] },
      },
      "no-such-default",
    );
    const route = routeModel(config, "m1");
    expect(route.providerName).toBe("x");
    expect(route.routeKind).toBe("exact-default");
  });

  // AC9 — provider-declared model ids are exact ids, not implicit prefixes.
  test("AC9: declared model stems do not imply upstream prefix support", () => {
    const config = mkConfig(
      {
        p: { adapter: "openai-chat", models: ["gpt-5"] },
        q: { adapter: "openai-chat", models: ["gpt-5.5"] },
        codex: { adapter: "openai-responses" },
      },
      "p",
    );
    const route = routeModel(config, "gpt-5.5-turbo");
    expect(route.providerName).toBe("codex");
    expect(route.routeKind).toBe("family");
  });

  // AC10 — an unroutable id throws a helpful diagnostic.
  test("AC10: unknown model throws", () => {
    const config = mkConfig({ kimi: { adapter: "openai-chat", models: ["kimi-k2.7-code"] } }, "");
    expect(() => routeModel(config, "totally-unknown-zzz")).toThrow(/No provider configured for model "totally-unknown-zzz"/);
  });

  // AC11 — single-provider configs resolve to the sole provider unchanged.
  test("AC11: single provider unchanged", () => {
    const config = mkConfig(
      { kimi: { adapter: "openai-chat", defaultModel: "kimi-k2.7-code", models: ["kimi-k2.7-code"] } },
      "kimi",
    );
    const route = routeModel(config, "kimi-k2.7-code");
    expect(route.providerName).toBe("kimi");
    expect(route.routeKind).toBe("exact-default");
  });

  // AC12 — bare/undeclared family ids route via the curated family fallback (regression lock).
  test("AC12: bare undeclared family routing (regression lock)", () => {
    const config = mkConfig(
      {
        codex: { adapter: "openai-responses", defaultModel: "gpt-5.5" },
        groq: { adapter: "openai-chat" },
      },
      "no-such-default",
    );
    for (const id of ["gpt-4o", "gpt-6o"]) {
      const route = routeModel(config, id);
      expect(route.providerName).toBe("codex");
      expect(route.routeKind).toBe("family");
    }
    for (const id of ["llama-3.1-70b", "mixtral-8x7b", "gemma-2-9b"]) {
      const route = routeModel(config, id);
      expect(route.providerName).toBe("groq");
      expect(route.routeKind).toBe("family");
    }
  });

  // AC13 — the family fallback NEVER sources candidates from adapter breadth (allowlist only).
  test("AC13: s6 allowlist guard prevents adapter-breadth leakage", () => {
    const config = mkConfig(
      {
        kimi: { adapter: "openai-chat", models: ["kimi-k2.7-code"] },
        ollama: { adapter: "openai-chat" },
        "qwen-portal": { adapter: "openai-chat" },
      },
      "kimi",
    );
    const route = routeModel(config, "gpt-4o");
    // No openai/openai-apikey/codex configured -> gpt-4o must NOT route to a stray openai-chat provider.
    expect(route.routeKind).not.toBe("family");
    expect(route.routeKind).toBe("default");
    expect(route.providerName).toBe("kimi"); // via default fallback, not via family
  });

  // AC14 — gemini/qwen have no curated family and fall through unchanged.
  test("AC14: gemini/qwen fall through (not family)", () => {
    const config = mkConfig(
      {
        google: { adapter: "google", defaultModel: "gemini-3-pro" },
        "qwen-portal": { adapter: "openai-chat" },
      },
      "google",
    );
    for (const id of ["gemini-2.5-pro", "qwen-3-coder"]) {
      const route = routeModel(config, id);
      expect(route.routeKind).not.toBe("family");
      expect(route.routeKind).toBe("default");
    }
  });

  // AC16 — empty candidate stages are no-ops (pickDeterministic([]) -> null) and never throw.
  test("AC16: empty-candidate stages fall through without throwing", () => {
    const config = mkConfig(
      { codex: { adapter: "openai-responses", defaultModel: "gpt-5.5", models: ["gpt-5.4"] } },
      "codex",
    );
    // s4 (defaultModel) and s5 (models[]) both miss "gpt-4o"; only s6 family resolves.
    const route = routeModel(config, "gpt-4o");
    expect(route.routeKind).toBe("family");
    expect(route.providerName).toBe("codex");
  });
});
