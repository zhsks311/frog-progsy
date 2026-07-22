import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("Responses WebSocket retirement", () => {
  test("server explicitly rejects legacy Responses WebSocket upgrades", async () => {
    const server = await readText("src/server.ts");

    expect(server).toContain("Responses WebSocket is a Codex/OpenAI Responses-only behavior and is retired");
    expect(server).toContain("unsupported_endpoint");
    expect(server).toContain("Responses WebSocket is retired; use POST /v1/messages streaming SSE.");
    expect(server).toContain("OpenAI Responses inbound route is retired for Claude Code; use POST /v1/messages.");
    expect(server).toContain("POST /v1/messages  → provider translation");
    expect(server).not.toContain("POST /v1/responses → provider translation");
  });

  test("catalog and provider injection never advertise supports_websockets", async () => {
    const catalog = await readText("src/claude-catalog.ts");
    const inject = await readText("src/claude-inject.ts");

    expect(catalog).toContain("Responses WebSocket behavior is retired");
    expect(catalog).toContain("delete entry.supports_websockets");
    expect(inject).toContain("Responses WebSocket support is retired for the Claude Messages data plane");
    expect(inject).not.toContain("supports_websockets = true");
  });
});
