import { describe, expect, test } from "bun:test";
import { resolveSearchApiProvider, runSearchApi } from "../src/web-search-fallback/search-api";

describe("key-based search API providers", () => {
  test("normalizes Tavily answer and result content without leaking keys", async () => {
    const realFetch = globalThis.fetch;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        answer: "Tavily synthesized answer",
        results: [
          { title: "Tavily result", url: "https://docs.example/tavily", content: "Tavily content" },
          { title: "Duplicate", url: "https://docs.example/tavily", content: "duplicate" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const provider = resolveSearchApiProvider("tavily", { provider: "tavily", apiKey: "secret", maxResults: 2 });
      if (!provider || "error" in provider) throw new Error("provider did not resolve");

      const outcome = await runSearchApi("query", provider);

      expect(body?.api_key).toBe("secret");
      expect(outcome.answer).toBe("Tavily synthesized answer");
      expect(outcome.sources).toEqual([
        { title: "Tavily result", url: "https://docs.example/tavily", snippet: "Tavily content" },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("normalizes Exa result text and rejects unsupported providers before fetch", async () => {
    const realFetch = globalThis.fetch;
    let apiKey = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      apiKey = String((init?.headers as Record<string, string>)["x-api-key"] ?? "");
      return new Response(JSON.stringify({
        results: [
          { title: "Exa result", url: "https://docs.example/exa", text: "Exa text" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const unsupported = resolveSearchApiProvider("custom", { provider: "custom", apiKey: "secret" });
      expect(unsupported).toEqual({ error: "unsupported_provider" });

      const provider = resolveSearchApiProvider("exa", { provider: "exa", apiKey: "exa-secret", maxResults: 1 });
      if (!provider || "error" in provider) throw new Error("provider did not resolve");

      const outcome = await runSearchApi("query", provider);

      expect(apiKey).toBe("exa-secret");
      expect(outcome.sources).toEqual([
        { title: "Exa result", url: "https://docs.example/exa", snippet: "Exa text" },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
