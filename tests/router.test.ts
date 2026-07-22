import { describe, expect, test } from "bun:test";
import { routeModel } from "../src/router";
import type { FrogConfig } from "../src/types";

function baseConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "codex",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "oauth",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.5"],
      },
    },
  };
}

describe("routeModel", () => {
  test("maps Claude Code default model sentinel to the configured provider default", () => {
    const route = routeModel(baseConfig(), "default");

    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
  });

  test("keeps unknown explicit model ids as requested on the default provider", () => {
    const route = routeModel(baseConfig(), "future-model-id");

    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("future-model-id");
  });
});
describe("haiku-class classifier routing (G001)", () => {
  function codexConfig(): FrogConfig {
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
      },
    };
  }

  test("haiku-4-5 routes to codex classifierModel gpt-5.4-mini", () => {
    const route = routeModel(codexConfig(), "claude-haiku-4-5");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.4-mini");
    expect(route.classifierRoute).toBe(true);
  });

  test("haiku fallback to defaultModel when classifierModel absent, with warning", () => {
    const cfg = codexConfig();
    delete (cfg.providers.codex as { classifierModel?: string }).classifierModel;
    const route = routeModel(cfg, "claude-haiku-4-5");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
    expect(route.classifierRoute).toBeFalsy();
    expect(typeof route.warning).toBe("string");
    expect(route.warning!.length).toBeGreaterThan(0);
  });

  test("claude-3-5-haiku-20241022 is recognized as haiku-class", () => {
    const route = routeModel(codexConfig(), "claude-3-5-haiku-20241022");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.4-mini");
    expect(route.classifierRoute).toBe(true);
  });

  test("claude-sonnet-4-6 uses defaultModel without classifierRoute or warning", () => {
    const route = routeModel(codexConfig(), "claude-sonnet-4-6");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
    expect(route.classifierRoute).toBeFalsy();
    expect(route.warning).toBeUndefined();
  });

  test("claude-opus-4-8 uses defaultModel without classifierRoute or warning", () => {
    const route = routeModel(codexConfig(), "claude-opus-4-8");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
    expect(route.classifierRoute).toBeFalsy();
    expect(route.warning).toBeUndefined();
  });

  test("default sentinel uses defaultModel without classifierRoute or warning", () => {
    const route = routeModel(codexConfig(), "default");
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
    expect(route.classifierRoute).toBeFalsy();
    expect(route.warning).toBeUndefined();
  });

  test("classifierFallback takes precedence over per-provider classifierModel", () => {
    const cfg = codexConfig();
    cfg.classifierFallback = { provider: "anthropic", model: "claude-haiku-4-5" };
    cfg.providers.anthropic = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "oauth",
      defaultModel: "claude-sonnet-4-6",
    };
    const route = routeModel(cfg, "claude-haiku-4-5");
    expect(route.providerName).toBe("anthropic");
    expect(route.modelId).toBe("claude-haiku-4-5");
    expect(route.classifierRoute).toBe(true);
  });

  test("anthropic defaultProvider resolves haiku natively (s3 skipped)", () => {
    const cfg: FrogConfig = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          defaultModel: "claude-sonnet-4-6",
          models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
        },
      },
    };
    const route = routeModel(cfg, "claude-haiku-4-5");
    expect(route.providerName).toBe("anthropic");
    expect(route.modelId).toBe("claude-haiku-4-5");
    expect(route.classifierRoute).toBeFalsy();
  });
});
