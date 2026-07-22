import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/claude-catalog";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { buildInitProviders } from "../src/init";
import { OAUTH_PROVIDERS, loggedOutOAuthProviders, reconcileOAuthProviderConfig } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import {
  deriveFeaturedProviderIds,
  deriveInitProviders,
  deriveJawcodeAliases,
  deriveKeyLoginMap,
  deriveOAuthProviderConfig,
  deriveProviderPresets,
} from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { FrogConfig } from "../src/types";
import { resolveAdapter } from "../src/server";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    priority: 1,
    visibility: "list",
    supports_websockets: true,
  };
}

const EXPECTED_KEY_PROVIDER_IDS = [
  "anthropic", "openai-apikey", "umans", "opencode-go", "neuralwatt", "openrouter", "groq", "google", "azure-openai",
  "deepseek", "cerebras", "together", "fireworks", "firepass", "moonshot",
  "huggingface", "nvidia", "venice", "zai", "nanogpt", "synthetic", "qwen-portal",
  "qianfan", "alibaba", "parallel", "zenmux", "litellm", "ollama-cloud", "mistral",
  "minimax", "minimax-cn", "kimi-code", "opencode-zen", "vercel-ai-gateway",
  "xiaomi", "kilo", "cloudflare-ai-gateway", "github-copilot", "gitlab-duo",
];

describe("provider registry parity", () => {
  test("registry ids are unique", () => {
    const ids = PROVIDER_REGISTRY.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("key-login export is derived from the registry", () => {
    expect(KEY_LOGIN_PROVIDERS).toEqual(deriveKeyLoginMap());
    expect(Object.keys(KEY_LOGIN_PROVIDERS)).toEqual(EXPECTED_KEY_PROVIDER_IDS);
    expect(Object.keys(deriveKeyLoginMap())).toEqual(EXPECTED_KEY_PROVIDER_IDS);
    expect(KEY_LOGIN_PROVIDERS.minimax.defaultModel).toBe("MiniMax-M2.5");
    expect(KEY_LOGIN_PROVIDERS.umans).toMatchObject({
      label: "Umans AI Coding Plan",
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      defaultModel: "umans-coder",
      escapeBuiltinToolNames: true,
    });
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-glm-5.2"]?.input).toEqual(["text"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"]).toBe(262_144);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-coder"]?.input).toEqual(["text", "image"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-glm-5.2"]?.input).toEqual(["text"]);
  });

  test("CLI init providers are derived from the registry", () => {
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(buildInitProviders().find(p => p.id === "azure-openai")?.adapter).toBe("azure-openai");
  });

  test("OAuth provider configs use canonical registry values", () => {
    const codex = OAUTH_PROVIDERS.codex.providerConfig;
    const supportedCodexFallbacks = [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ];

    expect(codex.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(codex.defaultModel).toBe("gpt-5.5");
    expect(codex.models).toEqual(supportedCodexFallbacks);
    expect(codex.noTemperatureModels).toEqual(supportedCodexFallbacks);
    expect(codex.noTopPModels).toEqual(supportedCodexFallbacks);
    expect(codex.modelContextWindows?.["gpt-5.3-codex"]).toBeUndefined();
    expect(codex.modelContextWindows?.["gpt-5.3-codex-spark"]).toBe(128_000);
    expect(OAUTH_PROVIDERS.kimi.providerConfig.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(OAUTH_PROVIDERS.anthropic).toBeUndefined();
    expect(OAUTH_PROVIDERS.xai.providerConfig.defaultModel).toBe("grok-4.3");
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelCapabilities).toBeUndefined();
  });

  test("logged-out OAuth providers are reported without deleting provider settings", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
        codex: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "oauth" },
        local: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" },
      },
    };

    const loggedOut = loggedOutOAuthProviders(config, provider => provider === "codex");

    expect(loggedOut).toEqual(["xai"]);
    expect(config.providers.xai).toBeDefined();
    expect(config.providers.codex).toBeDefined();
    expect(config.providers.local).toBeDefined();
    expect(config.defaultProvider).toBe("xai");
  });

  test("logged-in OAuth credentials restore a missing non-Anthropic provider config", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "codex",
      providers: {
        codex: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "oauth" },
      },
    };

    const changed = reconcileOAuthProviderConfig(config, provider => provider === "xai");

    expect(changed).toBe(true);
    expect(config.providers.xai).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "oauth",
      defaultModel: "grok-4.3",
    });
    expect(config.providers.xai?.models).toContain("grok-4.3");
  });

  test("a logged-out default OAuth provider does not reset to the native fallback", () => {
    const config: FrogConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
      },
    };

    const loggedOut = loggedOutOAuthProviders(config, () => false);

    expect(loggedOut).toEqual(["xai"]);
    expect(config.defaultProvider).toBe("xai");
    expect(config.providers.xai).toBeDefined();
    expect(config.providers.anthropic).toBeUndefined();
  });

  test("GUI preset projection preserves current featured set plus key catalog and custom", () => {
    const featured = deriveFeaturedProviderIds();
    expect(featured).toEqual([
      "codex", "xai", "anthropic", "kimi", "openai-apikey", "umans", "opencode-go", "openrouter",
      "groq", "google", "azure-openai", "ollama", "vllm", "lm-studio",
    ]);

    const presets = deriveProviderPresets();
    expect(presets.some(p => p.id === "openai-forward")).toBe(false);
    expect(presets.at(-1)?.id).toBe("custom");
    expect(presets.find(p => p.id === "kimi")?.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(presets.find(p => p.id === "anthropic")?.defaultModel).toBe("claude-sonnet-4-6");
    expect(presets.find(p => p.id === "umans")).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      auth: "key",
      defaultModel: "umans-coder",
    });
    expect(presets.find(p => p.id === "azure-openai")?.adapter).toBe("azure-openai");
  });

  test("Umans registry metadata reaches routed Claude Code catalog entries", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      {
        provider: "umans",
        id: "umans-coder",
        contextWindow: KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"],
        inputModalities: KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-coder"]?.input,
        reasoningEfforts: KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-coder"],
      },
      {
        provider: "umans",
        id: "umans-glm-5.2",
        contextWindow: KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"],
        inputModalities: KEY_LOGIN_PROVIDERS.umans.modelCapabilities?.["umans-glm-5.2"]?.input,
        reasoningEfforts: KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-glm-5.2"],
      },
    ]);
    const coder = entries.find(e => e.slug === "umans/umans-coder");
    const glm = entries.find(e => e.slug === "umans/umans-glm-5.2");

    expect(coder?.context_window).toBe(262_144);
    expect(coder?.input_modalities).toEqual(["text", "image"]);
    expect(glm?.context_window).toBe(405_504);
    expect(glm?.input_modalities).toEqual(["text"]);
    expect(glm?.default_reasoning_level).toBe("high");
  });

  test("jawcode metadata aliases are derived from the registry", () => {
    expect(deriveJawcodeAliases()).toEqual({
      xai: "xai",
      anthropic: "anthropic",
      kimi: "moonshot",
      "opencode-go": "opencode-go",
      openrouter: "openrouter",
      google: "google",
      gemini: "google",
      moonshot: "moonshot",
      minimax: "minimax",
      "minimax-cn": "minimax",
    });
    expect(resolveJawcodeProvider("gemini")).toBe("google");
    expect(resolveJawcodeProvider("minimax-cn")).toBe("minimax");
  });

  test("legacy azure adapter spelling remains accepted", () => {
    const adapter = resolveAdapter({
      adapter: "azure",
      baseUrl: "https://example.openai.azure.com/openai/deployments/demo",
      apiKey: "key",
      defaultModel: "deployment",
    });
    expect("nativeRelay" in adapter && adapter.nativeRelay).toBe(true);
  });

  test("MiniMax metadata lookup tolerates routed lowercase ids", () => {
    expect(getJawcodeModelMetadata("minimax", "MiniMax-M2.5")?.contextWindow).toBe(204_800);
    expect(getJawcodeModelMetadata("minimax", "minimax-m2.5")).toBeUndefined();

    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "minimax", id: "minimax-m2.5" },
    ]);
    const routed = entries.find(e => e.slug === "minimax/minimax-m2.5");
    expect(routed?.context_window).toBe(204_800);
    expect(routed?.max_context_window).toBe(204_800);
  });
});
describe("classifier model back-fill (G001)", () => {
  test("deriveOAuthProviderConfig('codex') includes classifierModel gpt-5.4-mini", () => {
    const cfg = deriveOAuthProviderConfig("codex");
    expect(cfg?.classifierModel).toBe("gpt-5.4-mini");
  });
});
