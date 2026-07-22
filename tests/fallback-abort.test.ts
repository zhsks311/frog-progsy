import { afterEach, describe, expect, test } from "bun:test";
import { runWebSearch } from "../src/web-search-fallback/executor";
import { runWithWebSearch } from "../src/web-search-fallback/loop";
import { describeImage } from "../src/image-fallback/describe";
import { parseRequest } from "../src/responses/parser";
import type { ProviderAdapter } from "../src/adapters/base";
import type { FrogProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

const forwardProvider: FrogProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test",
  authMode: "forward",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installAbortAwareFetch(): () => AbortSignal {
  let seenSignal: AbortSignal | undefined;
  globalThis.fetch = ((_, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((_, reject) => {
      seenSignal?.addEventListener("abort", () => reject(new Error("aborted by turn")), { once: true });
    });
  }) as typeof fetch;
  return () => {
    if (!seenSignal) throw new Error("fetch was not called");
    return seenSignal;
  };
}

describe("fallback abort propagation", () => {
  test("web-search loop routed-provider fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return []; },
    };
    const response = runWithWebSearch({
      parsed: parseRequest({
        model: "routed/model",
        input: "Search for current docs",
        stream: true,
        tools: [{ type: "web_search" }],
      }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      incomingHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      abortSignal: turn.signal,
    });

    const signal = getSignal();
    expect(signal).toBe(turn.signal);
    expect(signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(signal.aborted).toBe(true);
    expect((await response).status).toBe(502);
  });

  test("web-search fallback fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const outcome = runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      "chatgpt",
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      turn.signal,
    );
    await Promise.resolve();

    const signal = getSignal();
    expect(signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(signal.aborted).toBe(true);
    expect((await outcome).error).toBe("aborted by turn");
  });

  test("vision fallback fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const outcome = describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      "chatgpt",
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      turn.signal,
    );
    await Promise.resolve();

    const signal = getSignal();
    expect(signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(signal.aborted).toBe(true);
    expect((await outcome).error).toBe("aborted by turn");
  });
});
