import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseMessagesRequest } from "../src/messages/parser";
import type { FrogProviderConfig } from "../src/types";

function messagesRequest() {
  return {
    model: "claude-sonnet-test",
    messages: [{ role: "user", content: "Search current docs" }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
        allowed_domains: ["docs.anthropic.com", "docs.anthropic.com"],
        blocked_domains: ["example.com"],
        user_location: { type: "approximate", country: "KR" },
      },
      { name: "read_file", description: "Read", input_schema: { type: "object" } },
    ],
  };
}

describe("Messages web_search server tool parsing", () => {
  test("preserves Anthropic web_search server tool without exposing it as a function tool", () => {
    const source = messagesRequest();
    const parsed = parseMessagesRequest(source);

    expect(parsed._webSearchRequest).toMatchObject({
      kind: "anthropic_server",
      source: "anthropic_messages",
      type: "web_search_20250305",
      name: "web_search",
      maxUses: 2,
      allowedDomains: ["docs.anthropic.com"],
      blockedDomains: ["example.com"],
      userLocation: { type: "approximate", country: "KR" },
    });
    expect(parsed._webSearchRequest?.raw).toEqual(source.tools[0]);
    expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["read_file"]);

    const responsesBody = parsed._rawBody as Record<string, unknown>;
    expect(responsesBody.tools).toEqual([
      { type: "function", name: "read_file", description: "Read", parameters: { type: "object" } },
    ]);
    expect(parsed._messagesRawBody).toBe(source);
  });

  test("Anthropic adapter passes raw web_search tool only when native capability is known", () => {
    const parsed = parseMessagesRequest(messagesRequest());
    const nativeProvider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.test",
      apiKey: "key",
      modelCapabilities: { "claude-sonnet-test": { webSearch: true, input: ["text"] } },
    };
    const textOnlyProvider: FrogProviderConfig = {
      ...nativeProvider,
      modelCapabilities: { "claude-sonnet-test": { webSearch: false, input: ["text"] } },
    };

    const nativeBody = JSON.parse(createAnthropicAdapter(nativeProvider).buildRequest(parsed).body) as Record<string, unknown>;
    expect(nativeBody.tools).toEqual([
      messagesRequest().tools[0],
      { name: "read_file", description: "Read", input_schema: { type: "object" } },
    ]);

    const nonNativeBody = JSON.parse(createAnthropicAdapter(textOnlyProvider).buildRequest(parsed).body) as Record<string, unknown>;
    expect(nonNativeBody.tools).toEqual([
      { name: "read_file", description: "Read", input_schema: { type: "object" } },
    ]);
  });

  test("native web_search tool_choice is not custom-tool renamed", () => {
    const parsed = parseMessagesRequest({
      ...messagesRequest(),
      tool_choice: { type: "tool", name: "web_search" },
    });
    const provider: FrogProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.test",
      apiKey: "key",
      escapeBuiltinToolNames: true,
      modelCapabilities: { "claude-sonnet-test": { webSearch: true, input: ["text"] } },
    };

    const body = JSON.parse(createAnthropicAdapter(provider).buildRequest(parsed).body) as Record<string, unknown>;

    expect(body.tool_choice).toEqual({ type: "tool", name: "web_search" });
  });
});
