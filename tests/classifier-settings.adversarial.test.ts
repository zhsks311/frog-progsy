/**
 * Adversarial / red-team tests for the classifier-config MANAGEMENT API:
 *   GET  /api/classifier-settings
 *   PUT  /api/classifier-settings
 *
 * Server is booted against an isolated temp config that has BOTH a codex provider
 * and an anthropic forward provider, ensuring broad-enumeration is tested end-to-end.
 *
 * Each test that starts a server stops it in its own finally-block so a
 * mid-test failure cannot bleed a port or config into the next test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { FrogConfig } from "../src/types";

// ── Shared test fixtures ─────────────────────────────────────────────────────

let testDir = "";
let previousFrogHome: string | undefined;

/** Config with BOTH a codex provider and an anthropic forward provider. */
function adversarialConfig(): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com",
        authMode: "forward",
        defaultModel: "gpt-4o-mini",
        models: ["gpt-4o-mini", "gpt-5.4-mini"],
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-haiku-4-5",
        models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
      },
    },
  } as FrogConfig;
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "frog-adv-classifier-"));
  process.env.FROGPROGSY_HOME = testDir;
  saveConfig(adversarialConfig());
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

// ── AC: Broad enumeration — NOT filtered to openai-responses+forward ─────────

describe("GET /api/classifier-settings — broad enumeration", () => {
  test("returns BOTH codex/openai-responses and anthropic/forward providers", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/classifier-settings", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        providers: { name: string; classifierModel: string; models: string[] }[];
        classifierFallback: { provider: string; model: string };
      };
      expect(Array.isArray(body.providers)).toBe(true);
      const names = body.providers.map(p => p.name);
      expect(names).toContain("codex");
      expect(names).toContain("anthropic");
      expect(names.length).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

  test("each provider entry has correct shape (name string, classifierModel string, models array)", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/classifier-settings", server.url));
      const body = await res.json() as {
        providers: { name: string; classifierModel: string; models: string[] }[];
        classifierFallback: { provider: string; model: string };
      };
      for (const prov of body.providers) {
        expect(typeof prov.name).toBe("string");
        expect(typeof prov.classifierModel).toBe("string");
        expect(Array.isArray(prov.models)).toBe(true);
      }
      // classifierFallback defaults to empty strings when unset
      expect(body.classifierFallback.provider).toBe("");
      expect(body.classifierFallback.model).toBe("");
    } finally {
      await server.stop(true);
    }
  });
});

// ── AC: Valid model set → 200, persisted, NO warning ─────────────────────────

describe("PUT /api/classifier-settings — valid model", () => {
  test("set codex.classifierModel to a known model → 200, persisted, empty warnings", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "gpt-4o-mini" } } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as {
        ok: boolean;
        warnings: string[];
        providers: { name: string; classifierModel: string }[];
      };
      expect(body.ok).toBe(true);
      // No warnings for a known model
      expect(body.warnings).toEqual([]);
      // Value persisted in response
      const codex = body.providers.find(p => p.name === "codex")!;
      expect(codex.classifierModel).toBe("gpt-4o-mini");

      // GET confirms persistence
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as { providers: { name: string; classifierModel: string }[] };
      const codexGet = getBody.providers.find(p => p.name === "codex")!;
      expect(codexGet.classifierModel).toBe("gpt-4o-mini");
    } finally {
      await server.stop(true);
    }
  });
});

// ── AC: Unknown model → 200 (NOT 400), non-empty warnings, value STILL saved ─

describe("PUT /api/classifier-settings — unknown model (warn-only)", () => {
  test("unknown model → 200 with non-empty warnings array", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "totally-fake-model-xyz" } } }),
      });
      // MUST be 200, never 400
      expect(put.status).toBe(200);
      const body = await put.json() as {
        ok: boolean;
        warnings: string[];
        providers: { name: string; classifierModel: string }[];
      };
      expect(body.ok).toBe(true);
      // Warn, not reject
      expect(Array.isArray(body.warnings)).toBe(true);
      expect(body.warnings.length).toBeGreaterThan(0);
      // Warning mentions the bad model name
      expect(body.warnings[0]).toContain("totally-fake-model-xyz");
    } finally {
      await server.stop(true);
    }
  });

  test("unknown model is still persisted (warn-only, always saves)", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "totally-fake-model-xyz" } } }),
      });
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const body = await get.json() as { providers: { name: string; classifierModel: string }[] };
      const codex = body.providers.find(p => p.name === "codex")!;
      expect(codex.classifierModel).toBe("totally-fake-model-xyz");
    } finally {
      await server.stop(true);
    }
  });
});

// ── AC: Unknown provider name → skipped with warning, config untouched ───────

describe("PUT /api/classifier-settings — ghost provider", () => {
  test("ghost-provider → 200, warning contains provider name, known providers unchanged", async () => {
    const server = startServer(0);
    try {
      // First ensure codex has a known baseline
      await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "gpt-4o-mini" } } }),
      });

      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { "ghost-provider": { classifierModel: "x" } } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as {
        ok: boolean;
        warnings: string[];
        providers: { name: string; classifierModel: string }[];
      };
      expect(body.ok).toBe(true);
      // Warning about the nonexistent provider
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.warnings.some(w => w.includes("ghost-provider"))).toBe(true);
      // Known provider config is untouched
      const codex = body.providers.find(p => p.name === "codex")!;
      expect(codex.classifierModel).toBe("gpt-4o-mini");
    } finally {
      await server.stop(true);
    }
  });

  test("ghost-provider does NOT appear in the providers list", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { "ghost-provider": { classifierModel: "x" } } }),
      });
      const body = await put.json() as { providers: { name: string }[] };
      const names = body.providers.map(p => p.name);
      expect(names).not.toContain("ghost-provider");
    } finally {
      await server.stop(true);
    }
  });
});

// ── AC: Empty classifierModel '' → deletes the field ─────────────────────────

describe("PUT /api/classifier-settings — empty model deletes field", () => {
  test("set then clear classifierModel with empty string → GET shows ''", async () => {
    const server = startServer(0);
    try {
      // Set
      await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "gpt-4o-mini" } } }),
      });

      // Clear with empty string
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "" } } }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json() as { providers: { name: string; classifierModel: string }[] };
      const codexPut = putBody.providers.find(p => p.name === "codex")!;
      expect(codexPut.classifierModel).toBe(""); // field deleted → snapshot returns ""

      // GET confirms deletion
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as { providers: { name: string; classifierModel: string }[] };
      const codexGet = getBody.providers.find(p => p.name === "codex")!;
      expect(codexGet.classifierModel).toBe("");
    } finally {
      await server.stop(true);
    }
  });

  test("whitespace-only classifierModel also clears the field", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { anthropic: { classifierModel: "claude-haiku-4-5" } } }),
      });
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { anthropic: { classifierModel: "   " } } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as { providers: { name: string; classifierModel: string }[] };
      const anth = body.providers.find(p => p.name === "anthropic")!;
      expect(anth.classifierModel).toBe("");
    } finally {
      await server.stop(true);
    }
  });
});

// ── AC: classifierFallback lifecycle ─────────────────────────────────────────

describe("PUT /api/classifier-settings — classifierFallback", () => {
  test("set classifierFallback {provider:'anthropic',model:'claude-haiku-4-5'} → persisted", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classifierFallback: { provider: "anthropic", model: "claude-haiku-4-5" } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as {
        ok: boolean;
        warnings: string[];
        classifierFallback: { provider: string; model: string };
      };
      expect(body.ok).toBe(true);
      expect(body.warnings).toEqual([]);
      expect(body.classifierFallback.provider).toBe("anthropic");
      expect(body.classifierFallback.model).toBe("claude-haiku-4-5");

      // GET confirms
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as { classifierFallback: { provider: string; model: string } };
      expect(getBody.classifierFallback.provider).toBe("anthropic");
      expect(getBody.classifierFallback.model).toBe("claude-haiku-4-5");
    } finally {
      await server.stop(true);
    }
  });

  test("{provider:''} deletes classifierFallback; GET shows empty strings", async () => {
    const server = startServer(0);
    try {
      // First set
      await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classifierFallback: { provider: "anthropic", model: "claude-haiku-4-5" } }),
      });

      // Now delete with provider:''
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classifierFallback: { provider: "" } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as { classifierFallback: { provider: string; model: string } };
      expect(body.classifierFallback.provider).toBe("");
      expect(body.classifierFallback.model).toBe("");

      // GET confirms deletion
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as { classifierFallback: { provider: string; model: string } };
      expect(getBody.classifierFallback.provider).toBe("");
      expect(getBody.classifierFallback.model).toBe("");
    } finally {
      await server.stop(true);
    }
  });

  test("{provider:'ghost'} → saved + warning about unknown provider", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classifierFallback: { provider: "ghost" } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as {
        ok: boolean;
        warnings: string[];
        classifierFallback: { provider: string; model: string };
      };
      expect(body.ok).toBe(true);
      // Saved despite being unknown
      expect(body.classifierFallback.provider).toBe("ghost");
      // Warning about ghost not found
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.warnings.some(w => w.includes("ghost"))).toBe(true);

      // GET confirms the ghost value is persisted
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as { classifierFallback: { provider: string; model: string } };
      expect(getBody.classifierFallback.provider).toBe("ghost");
    } finally {
      await server.stop(true);
    }
  });
});

// ── AC: Malformed JSON → 400 ─────────────────────────────────────────────────

describe("PUT /api/classifier-settings — malformed body", () => {
  test("non-JSON body → 400", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json {{ garbage",
      });
      expect(put.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("non-JSON body returns error field in response", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "totally not JSON at all",
      });
      expect(put.status).toBe(400);
      const body = await put.json() as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("empty body → 400", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "",
      });
      expect(put.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

// ── AC: Idempotency — two identical PUTs converge to the same GET snapshot ───

describe("PUT /api/classifier-settings — idempotency", () => {
  test("two identical PUTs produce the same GET snapshot", async () => {
    const server = startServer(0);
    try {
      const payload = JSON.stringify({
        providers: { codex: { classifierModel: "gpt-4o-mini" } },
        classifierFallback: { provider: "anthropic", model: "claude-haiku-4-5" },
      });

      const put1 = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const body1 = await put1.json() as {
        providers: { name: string; classifierModel: string }[];
        classifierFallback: { provider: string; model: string };
      };

      const put2 = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const body2 = await put2.json() as {
        providers: { name: string; classifierModel: string }[];
        classifierFallback: { provider: string; model: string };
      };

      // Both PUTs agree on the final snapshot
      const normalize = (b: typeof body1) => ({
        providers: b.providers.map(p => ({ name: p.name, classifierModel: p.classifierModel })).sort((a, b) => a.name.localeCompare(b.name)),
        classifierFallback: b.classifierFallback,
      });
      expect(normalize(body1)).toEqual(normalize(body2));

      // GET also matches
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as typeof body1;
      expect(normalize(body1)).toEqual(normalize(getBody));
    } finally {
      await server.stop(true);
    }
  });

  test("two identical ghost-provider PUTs both produce the same warning + unchanged snapshot", async () => {
    const server = startServer(0);
    try {
      const payload = JSON.stringify({ providers: { "ghost-provider": { classifierModel: "x" } } });

      const run = async () => {
        const r = await fetch(new URL("/api/classifier-settings", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        return r.json() as Promise<{ ok: boolean; warnings: string[]; providers: { name: string; classifierModel: string }[] }>;
      };

      const b1 = await run();
      const b2 = await run();

      expect(b1.ok).toBe(true);
      expect(b2.ok).toBe(true);
      expect(b1.warnings.length).toBeGreaterThan(0);
      expect(b1.warnings[0]).toBe(b2.warnings[0]);

      const names1 = b1.providers.map(p => p.name).sort();
      const names2 = b2.providers.map(p => p.name).sort();
      expect(names1).toEqual(names2);
    } finally {
      await server.stop(true);
    }
  });
});
