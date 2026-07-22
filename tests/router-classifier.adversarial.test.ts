/**
 * G001 Adversarial / property / boundary test suite for haiku-class classifier routing.
 *
 * Goal: try to BREAK routeModel by feeding it edge cases, invariant violations, and adversarial
 * configs. Every test here is intentionally hostile — it is not trying to show the happy path.
 */
import { describe, expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { deterministicModelAlias } from "../src/model-aliases";
import type { FrogConfig } from "../src/types";

/** Canonical adversarial base config: codex default + classifierModel + anthropic as side provider. */
function coreConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "codex",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "oauth",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.5", "gpt-5.4-mini"],
        classifierModel: "gpt-5.4-mini",
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        defaultModel: "claude-sonnet-4-6",
        models: [
          "claude-haiku-4-5",
          "claude-haiku-4-5-20251001",
          "claude-3-5-haiku-20241022",
          "claude-sonnet-4-6",
        ],
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — Haiku-class positive IDs must route to classifierModel
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: haiku-class positive ids → classifierModel", () => {
  const haikuIds = [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-20241022",
  ];

  for (const id of haikuIds) {
    test(`${id} → codex/gpt-5.4-mini + classifierRoute:true`, () => {
      const r = routeModel(coreConfig(), id);
      expect(r.providerName).toBe("codex");
      expect(r.modelId).toBe("gpt-5.4-mini");
      expect(r.classifierRoute).toBe(true);
      // INVARIANT: must never route to the full default model when classifierModel is set
      expect(r.modelId).not.toBe("gpt-5.5");
      expect(r.warning).toBeUndefined();
    });
  }

  test("claude-haiku- (bare haiku prefix, no version) also triggers classifier", () => {
    const r = routeModel(coreConfig(), "claude-haiku-");
    expect(r.classifierRoute).toBe(true);
    expect(r.modelId).toBe("gpt-5.4-mini");
    expect(r.modelId).not.toBe("gpt-5.5");
  });

  test("claude-3-5-haiku (prefix only, no date) triggers classifier", () => {
    const r = routeModel(coreConfig(), "claude-3-5-haiku");
    expect(r.classifierRoute).toBe(true);
    expect(r.modelId).toBe("gpt-5.4-mini");
    expect(r.modelId).not.toBe("gpt-5.5");
  });

  test("claude-3-5-haiku-20250101 (future date stamp) triggers classifier", () => {
    const r = routeModel(coreConfig(), "claude-3-5-haiku-20250101");
    expect(r.classifierRoute).toBe(true);
    expect(r.modelId).toBe("gpt-5.4-mini");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — Missing classifierModel → fallback + warning + no classifierRoute
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: missing classifierModel → warning fallback", () => {
  function noClassifierModelConfig(): FrogConfig {
    const cfg = coreConfig();
    delete (cfg.providers.codex as { classifierModel?: string }).classifierModel;
    return cfg;
  }

  const haikuIds = [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-20241022",
  ];

  for (const id of haikuIds) {
    test(`${id} without classifierModel → gpt-5.5 + warning + classifierRoute falsy`, () => {
      const r = routeModel(noClassifierModelConfig(), id);
      expect(r.providerName).toBe("codex");
      expect(r.modelId).toBe("gpt-5.5");
      expect(r.classifierRoute).toBeFalsy();
      // Warning must be present
      expect(typeof r.warning).toBe("string");
      expect(r.warning!.length).toBeGreaterThan(0);
      // Warning should mention the haiku model id
      expect(r.warning).toContain(id);
    });
  }

  test("warning contains 'classifierModel' or 'classifierFallback' in its text", () => {
    const r = routeModel(noClassifierModelConfig(), "claude-haiku-4-5");
    expect(r.warning).toMatch(/classifierModel|classifierFallback/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — Negative IDs must NOT trigger the classifier
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: non-haiku ids not misdetected", () => {
  const negatives: Array<{ id: string; expectedModel: string; label?: string }> = [
    { id: "claude-sonnet-4-6", expectedModel: "gpt-5.5" },
    { id: "claude-opus-4-8", expectedModel: "gpt-5.5" },
    { id: "default", expectedModel: "gpt-5.5" },
    // Bare claude- prefix (no haiku) should not fire classifier
    { id: "claude-", expectedModel: "gpt-5.5", label: "bare claude- prefix" },
    // Typo: close but not haiku
    { id: "claude-haik", expectedModel: "gpt-5.5", label: "typo claude-haik" },
    // Case-sensitive: uppercase MUST NOT fire
    {
      id: "CLAUDE-HAIKU-4-5",
      expectedModel: "CLAUDE-HAIKU-4-5",
      label: "uppercase haiku (must be case-sensitive)",
    },
    // Adjacent-sounding names that are NOT haiku
    { id: "claude-code-ultra", expectedModel: "gpt-5.5", label: "claude-code-ultra" },
    // 'claude-3-haiku' has '3' not '3-5' — does NOT match either prefix
    { id: "claude-3-haiku-20241022", expectedModel: "gpt-5.5", label: "claude-3-haiku (not 3-5)" },
  ];

  for (const { id, expectedModel, label } of negatives) {
    test(`"${label ?? id}" does NOT trigger classifier`, () => {
      const r = routeModel(coreConfig(), id);
      expect(r.classifierRoute).toBeFalsy();
      expect(r.warning).toBeUndefined();
      expect(r.modelId).toBe(expectedModel);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4 — classifierFallback precedence over per-provider classifierModel
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: classifierFallback precedence", () => {
  test("classifierFallback.provider+model overrides codex classifierModel", () => {
    const cfg = coreConfig();
    cfg.classifierFallback = { provider: "anthropic", model: "claude-haiku-4-5" };
    const r = routeModel(cfg, "claude-haiku-4-5");
    expect(r.providerName).toBe("anthropic");
    expect(r.modelId).toBe("claude-haiku-4-5");
    expect(r.classifierRoute).toBe(true);
    // Must NOT have used codex's gpt-5.4-mini
    expect(r.modelId).not.toBe("gpt-5.4-mini");
  });

  test("classifierFallback with missing provider falls through to per-provider classifierModel", () => {
    const cfg = coreConfig();
    cfg.classifierFallback = { model: "claude-haiku-4-5" }; // no .provider
    const r = routeModel(cfg, "claude-haiku-4-5");
    // fb.provider is undefined → resolveClassifierRoute must fall through to codex classifierModel
    expect(r.providerName).toBe("codex");
    expect(r.modelId).toBe("gpt-5.4-mini");
    expect(r.classifierRoute).toBe(true);
  });

  test("classifierFallback pointing to nonexistent provider falls through to per-provider classifierModel", () => {
    const cfg = coreConfig();
    cfg.classifierFallback = { provider: "nonexistent-provider", model: "some-model" };
    const r = routeModel(cfg, "claude-haiku-4-5");
    expect(r.providerName).toBe("codex");
    expect(r.modelId).toBe("gpt-5.4-mini");
    expect(r.classifierRoute).toBe(true);
  });

  test("classifierFallback with empty-string provider falls through to per-provider", () => {
    const cfg = coreConfig();
    cfg.classifierFallback = { provider: "", model: "some-model" };
    const r = routeModel(cfg, "claude-haiku-4-5");
    // empty string provider: providers[""] is undefined → falls through
    expect(r.providerName).toBe("codex");
    expect(r.modelId).toBe("gpt-5.4-mini");
    expect(r.classifierRoute).toBe(true);
  });

  test("classifierFallback applies to all haiku-class ids, not just the first", () => {
    const cfg = coreConfig();
    cfg.classifierFallback = { provider: "anthropic", model: "claude-haiku-4-5" };
    for (const id of [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-3-5-haiku-20241022",
    ]) {
      const r = routeModel(cfg, id);
      expect(r.providerName).toBe("anthropic");
      expect(r.modelId).toBe("claude-haiku-4-5");
      expect(r.classifierRoute).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5 — Alias (s1) and qualified (s2) beat the classifier (s3)
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: s1/s2 ordering beats s3 classifier", () => {
  test("qualified anthropic/claude-haiku-4-5 routes via s2, not classifier (s3)", () => {
    const cfg = coreConfig();
    const r = routeModel(cfg, "anthropic/claude-haiku-4-5");
    expect(r.providerName).toBe("anthropic");
    expect(r.modelId).toBe("claude-haiku-4-5");
    expect(r.routeKind).toBe("qualified");
    expect(r.classifierRoute).toBeFalsy();
    // Must not have triggered the classifier path
    expect(r.warning).toBeUndefined();
  });

  test("deterministic alias for codex/gpt-5.4-mini routes via s1 (alias)", () => {
    const cfg = coreConfig();
    // Compute the actual deterministic alias key that resolveConfiguredModelAlias will find
    const aliasKey = deterministicModelAlias("codex", "gpt-5.4-mini");
    const r = routeModel(cfg, aliasKey);
    expect(r.routeKind).toBe("alias");
    expect(r.providerName).toBe("codex");
    expect(r.modelId).toBe("gpt-5.4-mini");
    // Alias must not produce classifierRoute or warning
    expect(r.classifierRoute).toBeFalsy();
    expect(r.warning).toBeUndefined();
  });

  test("deterministic alias for anthropic/claude-haiku-4-5 routes via s1 (not classifier)", () => {
    const cfg = coreConfig();
    const aliasKey = deterministicModelAlias("anthropic", "claude-haiku-4-5");
    const r = routeModel(cfg, aliasKey);
    expect(r.routeKind).toBe("alias");
    expect(r.providerName).toBe("anthropic");
    expect(r.modelId).toBe("claude-haiku-4-5");
    expect(r.classifierRoute).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6 — Anthropic default provider skips s3
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: anthropic default provider skips classifier", () => {
  function anthropicDefaultConfig(): FrogConfig {
    return {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          defaultModel: "claude-sonnet-4-6",
          models: [
            "claude-haiku-4-5",
            "claude-haiku-4-5-20251001",
            "claude-3-5-haiku-20241022",
            "claude-sonnet-4-6",
          ],
        },
      },
    };
  }

  for (const id of [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-20241022",
  ]) {
    test(`${id} with anthropic defaultProvider routes natively, no classifier`, () => {
      const r = routeModel(anthropicDefaultConfig(), id);
      expect(r.providerName).toBe("anthropic");
      expect(r.modelId).toBe(id);
      expect(r.classifierRoute).toBeFalsy();
      expect(r.warning).toBeUndefined();
    });
  }

  test("anthropic-pro (anthropic-prefixed name) also skips s3", () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "anthropic-pro",
      providers: {
        "anthropic-pro": {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"],
        },
      },
    };
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"]) {
      const r = routeModel(cfg, id);
      expect(r.providerName).toBe("anthropic-pro");
      expect(r.modelId).toBe(id);
      expect(r.classifierRoute).toBeFalsy();
    }
  });

  test("anthropic-enterprise (deeper anthropic- prefix) skips s3", () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "anthropic-enterprise",
      providers: {
        "anthropic-enterprise": {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-haiku-4-5"],
        },
      },
    };
    const r = routeModel(cfg, "claude-haiku-4-5");
    expect(r.providerName).toBe("anthropic-enterprise");
    expect(r.modelId).toBe("claude-haiku-4-5");
    expect(r.classifierRoute).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7 — Invariant property tests
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: invariant property checks", () => {
  test("INVARIANT: haiku-class id NEVER routes to gpt-5.5 when classifierModel is set", () => {
    const cfg = coreConfig(); // has classifierModel: "gpt-5.4-mini"
    for (const id of [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-3-5-haiku-20241022",
      "claude-haiku-",
      "claude-3-5-haiku",
    ]) {
      const r = routeModel(cfg, id);
      expect(r.modelId).not.toBe("gpt-5.5");
    }
  });

  test("INVARIANT: classifierRoute is true IFF route came from classifier path", () => {
    const haikuR = routeModel(coreConfig(), "claude-haiku-4-5");
    expect(haikuR.classifierRoute).toBe(true);
    const sonnetR = routeModel(coreConfig(), "claude-sonnet-4-6");
    expect(sonnetR.classifierRoute).toBeFalsy();
    const opusR = routeModel(coreConfig(), "claude-opus-4-8");
    expect(opusR.classifierRoute).toBeFalsy();
    const defaultR = routeModel(coreConfig(), "default");
    expect(defaultR.classifierRoute).toBeFalsy();
  });

  test("INVARIANT: warning is undefined for all non-haiku ids even without classifierModel", () => {
    const cfg = coreConfig();
    delete (cfg.providers.codex as { classifierModel?: string }).classifierModel;
    for (const id of ["claude-sonnet-4-6", "claude-opus-4-8", "default"]) {
      const r = routeModel(cfg, id);
      expect(r.warning).toBeUndefined();
    }
  });

  test("INVARIANT: classifierRoute is never set on the warning-fallback path", () => {
    const cfg = coreConfig();
    delete (cfg.providers.codex as { classifierModel?: string }).classifierModel;
    const r = routeModel(cfg, "claude-haiku-4-5");
    // Must have warning, must NOT have classifierRoute
    expect(typeof r.warning).toBe("string");
    expect(r.classifierRoute).toBeFalsy();
  });

  test("INVARIANT: routeKind is 'client-default' on all classifier routes", () => {
    const r = routeModel(coreConfig(), "claude-haiku-4-5");
    expect(r.routeKind).toBe("client-default");
    expect(r.classifierRoute).toBe(true);
  });

  test("INVARIANT: providerName always matches a key in config.providers", () => {
    const cfg = coreConfig();
    const ids = [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-3-5-haiku-20241022",
      "claude-sonnet-4-6",
      "default",
    ];
    for (const id of ids) {
      const r = routeModel(cfg, id);
      expect(cfg.providers[r.providerName]).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8 — Adversarial boundary/edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe("G001-adversarial: boundary and edge cases", () => {
  test("empty string model id does not crash", () => {
    expect(() => routeModel(coreConfig(), "")).not.toThrow();
  });

  test("empty string model id does not trigger classifier", () => {
    const r = routeModel(coreConfig(), "");
    expect(r.classifierRoute).toBeFalsy();
    expect(r.warning).toBeUndefined();
  });

  test("UPPERCASE CLAUDE-HAIKU-4-5 does not trigger classifier (must be case-sensitive)", () => {
    const r = routeModel(coreConfig(), "CLAUDE-HAIKU-4-5");
    expect(r.classifierRoute).toBeFalsy();
    expect(r.warning).toBeUndefined();
    // Does NOT start with claude- so falls through to s7 default
    expect(r.modelId).toBe("CLAUDE-HAIKU-4-5");
  });

  test("Claude-Haiku-4-5 (mixed-case) does not trigger classifier", () => {
    const r = routeModel(coreConfig(), "Claude-Haiku-4-5");
    expect(r.classifierRoute).toBeFalsy();
    expect(r.warning).toBeUndefined();
  });

  test("claude-haiku4-5 (missing hyphen between haiku and version) does not trigger classifier", () => {
    // Does NOT start with "claude-haiku-" (it starts with "claude-haiku4")
    const r = routeModel(coreConfig(), "claude-haiku4-5");
    expect(r.classifierRoute).toBeFalsy();
    expect(r.warning).toBeUndefined();
  });

  test("fully absent default provider returns error for unknown model", () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "missing",
      providers: {},
    };
    expect(() => routeModel(cfg, "claude-haiku-4-5")).toThrow();
  });

  test("no classifierModel AND no defaultModel: warning still emits without crash", () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        codex: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com",
          authMode: "oauth",
          // No defaultModel, no classifierModel
        },
      },
    };
    // Should not throw — returns a route (possibly with the haiku id as modelId)
    expect(() => routeModel(cfg, "claude-haiku-4-5")).not.toThrow();
    const r = routeModel(cfg, "claude-haiku-4-5");
    // classifierModel absent → warning path; no classifierRoute
    expect(r.classifierRoute).toBeFalsy();
    expect(typeof r.warning).toBe("string");
  });

  test("classifierFallback with both provider+model set: both fields are required to route", () => {
    // Only provider, no model
    const cfg1 = coreConfig();
    cfg1.classifierFallback = { provider: "anthropic" };
    const r1 = routeModel(cfg1, "claude-haiku-4-5");
    // fb.model is undefined → resolveClassifierRoute's fb check fails → falls through to per-provider
    expect(r1.providerName).toBe("codex");
    expect(r1.modelId).toBe("gpt-5.4-mini");
    expect(r1.classifierRoute).toBe(true);
  });

  test("anthropic provider in config but non-anthropic defaultProvider: haiku routes to classifier", () => {
    // Having an 'anthropic' key in providers must NOT bypass the classifier redirect
    // when the defaultProvider is 'codex'
    const r = routeModel(coreConfig(), "claude-haiku-4-5");
    expect(r.providerName).toBe("codex");  // codex, not anthropic
    expect(r.modelId).toBe("gpt-5.4-mini");
    expect(r.classifierRoute).toBe(true);
  });
});
