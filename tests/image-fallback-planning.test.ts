import { describe, expect, test } from "bun:test";
import { decideImageFallback } from "../src/image-fallback";
import type { FrogConfig, FrogParsedRequest, FrogProviderConfig } from "../src/types";

const routedTextOnlyProvider: FrogProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  apiKey: "routed-key",
  modelCapabilities: { "text-only-model": { input: ["text"] } },
};

const routedVisionProvider: FrogProviderConfig = {
  ...routedTextOnlyProvider,
  modelCapabilities: { "vision-model": { input: ["text", "image"] } },
};

const openAiForwardProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/backend-api/codex",
  authMode: "forward",
};
const preferredForwardProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://preferred-chatgpt.test/backend-api/codex",
  authMode: "forward",
  models: ["gpt-5.5", "gpt-5.4-mini"],
};
const oauthProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/backend-api/codex",
  authMode: "oauth",
  models: ["gpt-5.5"],
};
const anthropicForwardProvider: FrogProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authMode: "forward",
};

function parsedWithImage(modelId = "routed/text-only-model"): FrogParsedRequest {
  return {
    modelId,
    context: {
      messages: [{
        role: "user",
        content: [{ type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }],
        timestamp: 0,
      }],
    },
    stream: true,
    options: {},
  };
}

function config(forwardProvider: FrogProviderConfig, provider = routedTextOnlyProvider, enabled = true): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: provider,
      forward: forwardProvider,
    },
    imageFallback: { enabled },
  };
}

describe("image fallback planning", () => {
  test("describes text-only image requests only with an OpenAI Responses fallback provider", () => {
    const openAiPlan = decideImageFallback(
      config(openAiForwardProvider),
      "routed",
      routedTextOnlyProvider,
      "text-only-model",
      parsedWithImage(),
      new Headers({ authorization: "Bearer chatgpt" }),
    );
    expect(openAiPlan.action).toBe("describe");
    if (openAiPlan.action === "describe") expect(openAiPlan.forwardProvider).toBe(openAiForwardProvider);

    const anthropicPlan = decideImageFallback(
      config(anthropicForwardProvider),
      "routed",
      routedTextOnlyProvider,
      "text-only-model",
      parsedWithImage(),
      new Headers({ authorization: "Bearer chatgpt" }),
    );
    expect(anthropicPlan).toMatchObject({ action: "reject", code: "fallback_unavailable" });
  });

  test("rejects text-only images when fallback auth is local or disabled", () => {
    const localAuth = decideImageFallback(
      config(openAiForwardProvider),
      "routed",
      routedTextOnlyProvider,
      "text-only-model",
      parsedWithImage(),
      new Headers({ authorization: "Bearer local-frogprogsy" }),
    );
    expect(localAuth).toMatchObject({ action: "reject", code: "fallback_unavailable" });

    const disabled = decideImageFallback(
      config(openAiForwardProvider, routedTextOnlyProvider, false),
      "routed",
      routedTextOnlyProvider,
      "text-only-model",
      parsedWithImage(),
      new Headers({ authorization: "Bearer chatgpt" }),
    );
    expect(disabled).toMatchObject({ action: "reject", code: "text_only_model" });
    if (disabled.action === "reject") {
      expect(disabled.message).toContain("Image input rejected");
      expect(disabled.message).toContain("imageFallback.enabled is false");
      expect(disabled.message).toContain("modelCapabilities.input includes \"image\"");
    }
  });

  test("uses the configured fallback provider when one is selected", () => {
    const cfg = config(openAiForwardProvider);
    cfg.providers.preferred = preferredForwardProvider;
    cfg.imageFallback = { enabled: true, provider: "preferred" };

    const plan = decideImageFallback(
      cfg,
      "routed",
      routedTextOnlyProvider,
      "text-only-model",
      parsedWithImage(),
      new Headers({ authorization: "Bearer chatgpt" }),
    );

    expect(plan.action).toBe("describe");
    if (plan.action === "describe") expect(plan.forwardProvider).toBe(preferredForwardProvider);
  });

  test("uses configured OpenAI Responses OAuth provider without forwarded authorization", () => {
    const cfg = config(openAiForwardProvider);
    cfg.providers.codex = oauthProvider;
    cfg.imageFallback = { enabled: true, provider: "codex" };

    const plan = decideImageFallback(
      cfg,
      "routed",
      routedTextOnlyProvider,
      "text-only-model",
      parsedWithImage(),
      new Headers(),
    );

    expect(plan.action).toBe("describe");
    if (plan.action === "describe") {
      expect(plan.forwardProvider).toBe(oauthProvider);
      expect(plan.forwardProviderName).toBe("codex");
    }
  });

  test("skips native multimodal and image-free requests", () => {
    expect(decideImageFallback(
      config(openAiForwardProvider, routedVisionProvider),
      "routed",
      routedVisionProvider,
      "vision-model",
      parsedWithImage("routed/vision-model"),
      new Headers({ authorization: "Bearer chatgpt" }),
    )).toEqual({ action: "none" });

    expect(decideImageFallback(
      config(openAiForwardProvider),
      "routed",
      routedTextOnlyProvider,
      "text-only-model",
      { ...parsedWithImage(), context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] } },
      new Headers({ authorization: "Bearer chatgpt" }),
    )).toEqual({ action: "none" });
  });
});
