import { describe, expect, test } from "bun:test";
import { assertPublicHttpUrl, buildNoKeyQueryVariants, canonicalSearchUrl, planNoKeySearch, rrfFuse, runNoKeySearch } from "../src/web-search-fallback/no-key";

describe("no-key web search fallback", () => {
  test("canonicalizes URLs, fuses duplicate rankings, and blocks private URLs", async () => {
    expect(canonicalSearchUrl("https://Example.com/path?utm_source=x&b=2&a=1#frag")).toBe("https://example.com/path?a=1&b=2");
    expect(rrfFuse([
      [{ channel: "a", rank: 1, url: "https://example.com/a?utm_source=x", title: "A" }],
      [{ channel: "b", rank: 1, url: "https://example.com/a", title: "A2", snippet: "snippet" }],
    ], 5)).toEqual([{ channel: "a", rank: 1, url: "https://example.com/a", title: "A", snippet: "snippet", score: expect.any(Number) }]);
    await expect(assertPublicHttpUrl("http://127.0.0.1/admin")).rejects.toThrow("blocked private IP");
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow("unsupported URL scheme");
  });

  test("plans deterministic query variants and routes vertical endpoints by intent", () => {
    expect(buildNoKeyQueryVariants("검색해줘 gajae-code web search fallback")).toEqual([
      "검색해줘 gajae-code web search fallback",
      "gajae-code web search fallback",
    ]);
    expect(planNoKeySearch("best npm package github repo for web search")).toMatchObject({
      channels: ["ddg", "npm", "github"],
    });
    expect(planNoKeySearch("latest arxiv paper about retrieval")).toMatchObject({
      channels: ["ddg", "arxiv"],
    });
  });

  test("blocks loopback, mapped, and link-local URL forms before direct fetch", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.2/admin")).rejects.toThrow("blocked private IP");
    await expect(assertPublicHttpUrl("http://[::1]/admin")).rejects.toThrow("blocked private IP");
    await expect(assertPublicHttpUrl("http://[::ffff:7f00:1]/admin")).rejects.toThrow("blocked private IP");
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow("blocked private IP");
  });

  test("collects no-key vertical results without requiring keys or daemons", async () => {
    const realFetch = globalThis.fetch;
    const requestedHosts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);
      if (url.hostname === "api.duckduckgo.com") {
        return new Response(JSON.stringify({ Heading: "DDG", AbstractURL: "https://example.com/ddg", AbstractText: "DDG abstract" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "registry.npmjs.org") {
        return new Response(JSON.stringify({ objects: [{ package: { name: "pkg", description: "pkg desc", links: { npm: "https://www.npmjs.com/package/pkg" } } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "api.github.com") {
        return new Response(JSON.stringify({ items: [{ full_name: "owner/repo", html_url: "https://github.com/owner/repo", description: "repo desc" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "export.arxiv.org") {
        return new Response("<feed><entry><title>Paper</title><id>https://arxiv.org/abs/1234.5678</id><summary>paper summary</summary></entry></feed>", { status: 200, headers: { "content-type": "application/atom+xml" } });
      }
      return new Response("direct page", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    try {
      const outcome = await runNoKeySearch("frog search", { enabled: true, maxResults: 4, timeoutMs: 5000 });

      expect(requestedHosts).toEqual(expect.arrayContaining(["api.duckduckgo.com", "registry.npmjs.org", "api.github.com", "export.arxiv.org"]));
      expect(outcome.error).toBeUndefined();
      expect(outcome.provider).toBe("no-key");
      expect(outcome.sources.length).toBeGreaterThan(0);
      expect(outcome.answer).toContain("No-key search results");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("keeps successful vertical results when another no-key endpoint fails", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.duckduckgo.com") {
        return new Response(JSON.stringify({ Heading: "DDG", AbstractURL: "https://example.com/ddg", AbstractText: "DDG abstract" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "registry.npmjs.org") throw new Error("npm unavailable");
      if (url.hostname === "api.github.com") return new Response("rate limited", { status: 429 });
      if (url.hostname === "export.arxiv.org") return new Response("<feed></feed>", { status: 200, headers: { "content-type": "application/atom+xml" } });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await runNoKeySearch("frog search", { enabled: true, maxResults: 4, timeoutMs: 5000 });
      expect(outcome.error).toBeUndefined();
      expect(outcome.sources.map(source => source.url)).toContain("https://example.com/ddg");
      expect(outcome.answer).toContain("DDG abstract");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("drops private candidate URLs returned by public vertical endpoints", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.duckduckgo.com") {
        return new Response(JSON.stringify({ Heading: "private", AbstractURL: "http://127.0.0.1/admin", AbstractText: "should not leak" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "api.github.com") {
        return new Response(JSON.stringify({ items: [{ full_name: "private/repo", html_url: "http://169.254.169.254/latest/meta-data" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "registry.npmjs.org") return new Response(JSON.stringify({ objects: [] }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.hostname === "export.arxiv.org") return new Response("<feed></feed>", { status: 200, headers: { "content-type": "application/atom+xml" } });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await runNoKeySearch("github repo private candidate", { enabled: true, maxResults: 4, timeoutMs: 5000 });
      expect(outcome.sources).toEqual([]);
      expect(outcome.answer).toBe("");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
