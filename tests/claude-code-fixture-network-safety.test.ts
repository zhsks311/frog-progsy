import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildSafeClaudeEnv, readNormalizedRecords, type CaptureMetadata } from "../tools/capture-claude-code-fixtures.ts";

async function metadata(): Promise<CaptureMetadata> {
  return JSON.parse(await readFile("fixtures/claude-code-gateway/capture-metadata.json", "utf8")) as CaptureMetadata;
}

describe("Claude Code fixture network and settings safety", () => {
  test("metadata proves fake HOME, isolated settings, and local-only capture policy", async () => {
    const data = await metadata();

    expect(data.safety.fakeHomeUsed).toBe(true);
    expect(data.safety.isolatedClaudeSettings).toBe(true);
    expect(data.safety.fakeHomePath).toBe("[FAKE_HOME]");
    expect(data.safety.realHomePath).toBe("[REDACTED_HOME]");
    expect(data.safety.realClaudeSettingsTouched).toBe(false);
    expect(data.safety.realClaudeLoginUsed).toBe(false);
    expect(data.safety.localMockGatewayOnly).toBe(true);
    expect(data.safety.outboundNetworkPolicy).toBe("local-mock-gateway-only");
    expect(data.safety.liveCaptureRequiresExplicitNetworkApproval).toBe(true);
  });

  test("fixtures do not cross explicit non-target boundaries", async () => {
    const data = await metadata();
    const records = await readNormalizedRecords("fixtures/claude-code-gateway");

    expect(data.safety.bedrockUsed).toBe(false);
    expect(data.safety.vertexUsed).toBe(false);
    expect(data.safety.hostedCloudUsed).toBe(false);
    expect(data.safety.billingAdminTeamRemoteSyncUsed).toBe(false);
    expect(data.safety.proxyMitmUsed).toBe(false);

    for (const record of records) {
      expect(record.safety.realClaudeSettingsTouched).toBe(false);
      expect(record.safety.realClaudeLoginUsed).toBe(false);
      expect(record.safety.bedrockUsed).toBe(false);
      expect(record.safety.vertexUsed).toBe(false);
      expect(record.safety.hostedCloudUsed).toBe(false);
      expect(record.safety.billingAdminTeamRemoteSyncUsed).toBe(false);
      expect(record.safety.proxyMitmUsed).toBe(false);
      expect(record.safety.localMockGatewayOnly).toBe(true);
    }
  });
  test("live capture environment allowlists only local-safe variables", () => {
    const env = buildSafeClaudeEnv("/tmp/fake-home", "http://127.0.0.1:12345", {
      PATH: "/usr/bin",
      HOME: "/Users/real-user",
      ANTHROPIC_AUTH_TOKEN: "real-token",
      ANTHROPIC_API_KEY: "real-key",
      HTTPS_PROXY: "http://proxy.example",
      AWS_SECRET_ACCESS_KEY: "real-aws-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/real-user/gcp.json",
      CLAUDE_CONFIG_DIR: "/Users/real-user/.claude",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp/fake-home");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:12345");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-token-redacted");
    expect(env.ANTHROPIC_API_KEY).toBe("fixture-api-key-redacted");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });
});
