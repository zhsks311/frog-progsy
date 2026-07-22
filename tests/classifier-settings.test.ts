import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { validateClassifierModel, classifierSettingsSnapshot } from "../src/classifier-settings";
import type { FrogConfig } from "../src/types";

let testDir = "";
let previousFrogHome: string | undefined;

function baseConfig(): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-haiku-4-5",
        models: ["claude-haiku-4-5", "claude-sonnet-4-5"],
      },
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com",
        authMode: "forward",
        defaultModel: "gpt-4o-mini",
        models: ["gpt-4o-mini", "gpt-5.4-mini"],
      },
    },
  } as FrogConfig;
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "frog-classifier-"));
  process.env.FROGPROGSY_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

// ── Unit tests: validateClassifierModel ─────────────────────────────────────

describe("validateClassifierModel", () => {
  test("returns null for empty model string", () => {
    const config = baseConfig();
    expect(validateClassifierModel(config, "codex", "")).toBeNull();
  });

  test("returns null for known model in provider list", () => {
    const config = baseConfig();
    expect(validateClassifierModel(config, "codex", "gpt-4o-mini")).toBeNull();
  });

  test("returns null for defaultModel", () => {
    const config = baseConfig();
    expect(validateClassifierModel(config, "anthropic", "claude-haiku-4-5")).toBeNull();
  });

  test("returns warning string for unknown model", () => {
    const config = baseConfig();
    const result = validateClassifierModel(config, "codex", "not-a-real-model");
    expect(result).toBeTypeOf("string");
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    expect(result).toContain("not-a-real-model");
    expect(result).toContain("codex");
  });

  test("returns null for unknown provider (no list to validate against)", () => {
    const config = baseConfig();
    expect(validateClassifierModel(config, "nonexistent", "anything")).toBeNull();
  });

  test("returns null for provider with no models list (empty known set)", () => {
    const config = baseConfig();
    config.providers.bare = { adapter: "openai-responses", baseUrl: "https://example.com", authMode: "forward" };
    expect(validateClassifierModel(config, "bare", "some-model")).toBeNull();
  });
});

// ── Unit tests: classifierSettingsSnapshot ───────────────────────────────────

describe("classifierSettingsSnapshot", () => {
  test("includes ALL providers (not just forward/openai-responses)", () => {
    const config = baseConfig();
    const snap = classifierSettingsSnapshot(config);
    const names = snap.providers.map(p => p.name);
    expect(names).toContain("codex");
    expect(names).toContain("anthropic");
  });

  test("snapshot models are sorted unique", () => {
    const config = baseConfig();
    const snap = classifierSettingsSnapshot(config);
    const codex = snap.providers.find(p => p.name === "codex")!;
    expect(codex.models).toEqual([...codex.models].sort());
    expect(new Set(codex.models).size).toBe(codex.models.length);
  });

  test("classifierFallback defaults to empty strings", () => {
    const config = baseConfig();
    const snap = classifierSettingsSnapshot(config);
    expect(snap.classifierFallback.provider).toBe("");
    expect(snap.classifierFallback.model).toBe("");
  });
});

// ── Integration tests: GET/PUT /api/classifier-settings ─────────────────────

describe("GET /api/classifier-settings", () => {
  test("returns providers including both codex and anthropic (broad enumeration)", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/classifier-settings", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { providers: { name: string; classifierModel: string; models: string[] }[]; classifierFallback: { provider: string; model: string } };
      expect(Array.isArray(body.providers)).toBe(true);
      const names = body.providers.map(p => p.name);
      expect(names).toContain("codex");
      expect(names).toContain("anthropic");
      expect(body.classifierFallback).toMatchObject({ provider: "", model: "" });
    } finally {
      await server.stop(true);
    }
  });

  test("each provider entry has name, classifierModel string, and models array", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/classifier-settings", server.url));
      const body = await res.json() as { providers: { name: string; classifierModel: string; models: string[] }[] };
      for (const prov of body.providers) {
        expect(typeof prov.name).toBe("string");
        expect(typeof prov.classifierModel).toBe("string");
        expect(Array.isArray(prov.models)).toBe(true);
      }
    } finally {
      await server.stop(true);
    }
  });
});

describe("PUT /api/classifier-settings", () => {
  test("sets classifierModel for codex; GET reflects it", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "gpt-5.4-mini" } } }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json() as { ok: boolean; providers: { name: string; classifierModel: string }[] };
      expect(putBody.ok).toBe(true);
      const codex = putBody.providers.find(p => p.name === "codex")!;
      expect(codex.classifierModel).toBe("gpt-5.4-mini");

      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as { providers: { name: string; classifierModel: string }[] };
      const codexGet = getBody.providers.find(p => p.name === "codex")!;
      expect(codexGet.classifierModel).toBe("gpt-5.4-mini");
    } finally {
      await server.stop(true);
    }
  });

  test("unknown model still returns 200 with non-empty warnings array (warn-only)", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "not-a-real-model" } } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as { ok: boolean; warnings: string[]; providers: { name: string; classifierModel: string }[] };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.warnings)).toBe(true);
      expect(body.warnings.length).toBeGreaterThan(0);

      // Value is still persisted
      const codex = body.providers.find(p => p.name === "codex")!;
      expect(codex.classifierModel).toBe("not-a-real-model");
    } finally {
      await server.stop(true);
    }
  });

  test("unknown model persists across GET (warn-only, always saves)", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "not-a-real-model" } } }),
      });
      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const body = await get.json() as { providers: { name: string; classifierModel: string }[] };
      const codex = body.providers.find(p => p.name === "codex")!;
      expect(codex.classifierModel).toBe("not-a-real-model");
    } finally {
      await server.stop(true);
    }
  });

  test("sets classifierFallback provider+model", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classifierFallback: { provider: "anthropic", model: "claude-haiku-4-5" } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as { ok: boolean; warnings: string[]; classifierFallback: { provider: string; model: string } };
      expect(body.ok).toBe(true);
      expect(body.classifierFallback.provider).toBe("anthropic");
      expect(body.classifierFallback.model).toBe("claude-haiku-4-5");
    } finally {
      await server.stop(true);
    }
  });

  test("empty classifierModel string deletes the field", async () => {
    const server = startServer(0);
    try {
      // First set it
      await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "gpt-4o-mini" } } }),
      });
      // Then clear it
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { codex: { classifierModel: "" } } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as { providers: { name: string; classifierModel: string }[] };
      const codex = body.providers.find(p => p.name === "codex")!;
      expect(codex.classifierModel).toBe(""); // field deleted -> snapshot returns ""
    } finally {
      await server.stop(true);
    }
  });

  test("unknown provider name is skipped with a warning (not a 400)", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { nonexistent: { classifierModel: "whatever" } } }),
      });
      expect(put.status).toBe(200);
      const body = await put.json() as { ok: boolean; warnings: string[] };
      expect(body.ok).toBe(true);
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.warnings[0]).toContain("nonexistent");
    } finally {
      await server.stop(true);
    }
  });

  test("malformed JSON body returns 400", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json {{",
      });
      expect(put.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});
