import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { deterministicModelAlias } from "../src/model-aliases";
import { applyLongContextRoute } from "../src/router";
import type { FrogConfig } from "../src/types";

const ORIGINAL_FROGPROGSY_HOME = process.env.FROGPROGSY_HOME;

afterEach(() => {
  if (ORIGINAL_FROGPROGSY_HOME === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = ORIGINAL_FROGPROGSY_HOME;
});

function baseConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "primary",
    providers: {
      primary: {
        adapter: "openai-responses",
        baseUrl: "https://primary.test",
        defaultModel: "small-model",
        models: ["small-model"],
      },
      long: {
        adapter: "openai-responses",
        baseUrl: "https://long.test",
        defaultModel: "long-model",
        models: ["long-model"],
      },
    },
  };
}

function request(modelId: string, text: string) {
  return {
    modelId,
    context: {
      messages: [{ role: "user" as const, content: text, timestamp: 0 }],
    },
  };
}


describe("applyLongContextRoute", () => {
  test("longContext 미설정 시 no-op", () => {
    expect(applyLongContextRoute(baseConfig(), request("small-model", "x".repeat(1000)))).toBeNull();
  });

  test("임계값 미만이면 no-op", () => {
    const cfg = baseConfig();
    cfg.longContext = { thresholdTokens: 1000, provider: "long", model: "long-model" };
    expect(applyLongContextRoute(cfg, request("small-model", "x".repeat(100)))).toBeNull();
  });

  test("임계값과 정확히 같으면 no-op, 1 token 초과부터 라우팅", () => {
    const cfg = baseConfig();
    cfg.longContext = { thresholdTokens: 10, provider: "long", model: "long-model" };
    expect(applyLongContextRoute(cfg, request("small-model", "x".repeat(40)))).toBeNull();
    expect(applyLongContextRoute(cfg, request("small-model", "x".repeat(41)))?.providerName).toBe("long");
  });

  test("model id만으로 임계값을 넘기지 않음", () => {
    const cfg = baseConfig();
    cfg.longContext = { thresholdTokens: 1, provider: "long", model: "long-model" };
    expect(applyLongContextRoute(cfg, request("very-long-model-name-that-should-not-count", ""))).toBeNull();
  });

  test("임계값 초과 시 지정 provider/model 반환", () => {
    const cfg = baseConfig();
    cfg.longContext = { thresholdTokens: 10, provider: "long", model: "long-model" };
    const route = applyLongContextRoute(cfg, request("small-model", "x".repeat(200)));
    expect(route?.providerName).toBe("long");
    expect(route?.modelId).toBe("long-model");
    expect(route?.provider).toEqual(cfg.providers.long);
    expect(route?.routeKind).toBe("long-context");
  });

  test("qualified id와 configured alias는 override 안 함", () => {
    const cfg = baseConfig();
    cfg.longContext = { thresholdTokens: 10, provider: "long", model: "long-model" };

    expect(applyLongContextRoute(cfg, request("primary/small-model", "x".repeat(200)))).toBeNull();

    const alias = deterministicModelAlias("primary", "small-model");
    expect(applyLongContextRoute(cfg, request(alias, "x".repeat(200)))).toBeNull();
  });

  test("persisted home alias가 있어도 helper는 caller 보호 정보 없이는 home을 보지 않음", () => {
    const cfg = baseConfig();
    cfg.longContext = { thresholdTokens: 10, provider: "long", model: "long-model" };
    const persistedAlias = deterministicModelAlias("ghost", "large-model");
    const home = mkdtempSync(join(tmpdir(), "frogp-router-long-context-"));
    process.env.FROGPROGSY_HOME = home;
    writeFileSync(join(home, "model-aliases.json"), JSON.stringify({
      schemaVersion: 1,
      aliases: {
        [persistedAlias]: {
          alias: persistedAlias,
          provider: "primary",
          model: "small-model",
          routeKey: "primary/small-model",
          displayName: "primary/small-model",
          createdAt: new Date(0).toISOString(),
        },
      },
    }));

    const route = applyLongContextRoute(cfg, request(persistedAlias, "x".repeat(200)));
    expect(route?.providerName).toBe("long");
    expect(route?.modelId).toBe("long-model");

    expect(applyLongContextRoute(cfg, {
      ...request(persistedAlias, "x".repeat(200)),
      protectedModelIds: [persistedAlias],
    })).toBeNull();
    expect(applyLongContextRoute(cfg, {
      ...request("external/model", "x".repeat(200)),
      resolvedRouteKind: "qualified",
    })).toBeNull();
  });

  test("invalid config는 no-op", () => {
    for (const longContext of [
      { thresholdTokens: -1, provider: "long", model: "long-model" },
      { thresholdTokens: 10, provider: "", model: "long-model" },
      { thresholdTokens: 10, provider: "long", model: "" },
      { thresholdTokens: 10, provider: "missing", model: "long-model" },
    ]) {
      const cfg = baseConfig();
      cfg.longContext = longContext;
      expect(applyLongContextRoute(cfg, request("small-model", "x".repeat(200)))).toBeNull();
    }
  });
});
