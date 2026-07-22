import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INIT_PROVIDER_ID,
  parseInitChoice,
  parsePortInput,
  parseYesNoDefault,
  type InitProvider,
} from "../src/init";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

const providers: InitProvider[] = [
  { id: "anthropic", label: "Anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", kind: "forward" },
  { id: "codex", label: "OpenAI Codex/ChatGPT", adapter: "openai-chat", baseUrl: "https://chatgpt.com/backend-api/codex", kind: "oauth" },
  { id: "openai", label: "OpenAI", adapter: "openai-chat", baseUrl: "https://api.openai.com/v1", kind: "key" },
];

function withHomes<T>(prefix: string, fn: (frogHome: string, claudeHome: string) => T): T {
  const frogHome = mkdtempSync(join(tmpdir(), prefix));
  const claudeHome = join(frogHome, "claude");
  mkdirSync(claudeHome, { recursive: true });
  try {
    return fn(frogHome, claudeHome);
  } finally {
    rmSync(frogHome, { recursive: true, force: true });
  }
}

function runInit(input: string, frogHome: string, claudeHome: string) {
  return spawnSync(process.execPath, [cliPath, "init"], {
    cwd: repoRoot,
    env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome, NODE_ENV: "test" },
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("init input parsers", () => {
  test("parseInitChoice resolves empty input by default provider id, not position", () => {
    const reordered = [providers[2], providers[0], providers[1]];
    expect(parseInitChoice("", reordered, DEFAULT_INIT_PROVIDER_ID)).toEqual({ kind: "provider", index: 1 });
  });

  test("parseInitChoice accepts provider numbers and custom number", () => {
    expect(parseInitChoice("1", providers, DEFAULT_INIT_PROVIDER_ID)).toEqual({ kind: "provider", index: 0 });
    expect(parseInitChoice("2", providers, DEFAULT_INIT_PROVIDER_ID)).toEqual({ kind: "provider", index: 1 });
    expect(parseInitChoice("4", providers, DEFAULT_INIT_PROVIDER_ID)).toEqual({ kind: "custom" });
  });

  test("parseInitChoice rejects non-numeric and out-of-range input", () => {
    expect(parseInitChoice("abc", providers, DEFAULT_INIT_PROVIDER_ID).kind).toBe("error");
    expect(parseInitChoice("0", providers, DEFAULT_INIT_PROVIDER_ID).kind).toBe("error");
    expect(parseInitChoice("5", providers, DEFAULT_INIT_PROVIDER_ID).kind).toBe("error");
  });

  test("parsePortInput accepts default and valid ports", () => {
    expect(parsePortInput("", 10100)).toEqual({ ok: true, port: 10100 });
    expect(parsePortInput("1", 10100)).toEqual({ ok: true, port: 1 });
    expect(parsePortInput("65535", 10100)).toEqual({ ok: true, port: 65535 });
  });

  test("parsePortInput rejects invalid ports", () => {
    for (const input of ["0", "-1", "abc", "70000"]) {
      expect(parsePortInput(input, 10100).ok).toBe(false);
    }
  });

  test("parseYesNoDefault accepts defaults and y/yes/n/no", () => {
    expect(parseYesNoDefault("", true)).toEqual({ ok: true, value: true });
    expect(parseYesNoDefault("", false)).toEqual({ ok: true, value: false });
    expect(parseYesNoDefault("y", false)).toEqual({ ok: true, value: true });
    expect(parseYesNoDefault("YES", false)).toEqual({ ok: true, value: true });
    expect(parseYesNoDefault("n", true)).toEqual({ ok: true, value: false });
    expect(parseYesNoDefault("No", true)).toEqual({ ok: true, value: false });
  });

  test("parseYesNoDefault rejects other input", () => {
    expect(parseYesNoDefault("maybe", true).ok).toBe(false);
  });
});

describe("frogp init CLI", () => {
  test("invalid provider input followed by EOF fails without writing config", () => {
    withHomes("frogp-init-invalid-", (frogHome, claudeHome) => {
      const result = runInit("abc\n", frogHome, claudeHome);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Input stream closed");
      expect(existsSync(join(frogHome, "config.json"))).toBe(false);
      expect(readdirSync(frogHome).sort()).toEqual(["claude"]);
    });
  });

  test("empty stdin fails without writing config or Claude settings", () => {
    withHomes("frogp-init-eof-", (frogHome, claudeHome) => {
      const result = runInit("", frogHome, claudeHome);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(frogHome, "config.json"))).toBe(false);
      expect(readdirSync(claudeHome)).toEqual([]);
    });
  });

  test("default Anthropic forward setup saves config after all answers and skips injection when declined", () => {
    withHomes("frogp-init-success-", (frogHome, claudeHome) => {
      const result = runInit("\n\nn\n", frogHome, claudeHome);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const configPath = join(frogHome, "config.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.defaultProvider).toBe(DEFAULT_INIT_PROVIDER_ID);
      expect(config.port).toBe(3764);
      expect(config.providers.anthropic.authMode).toBe("forward");
      expect(config.providers.anthropic.apiKey).toBeUndefined();
      expect(config.providers.anthropic.defaultModel).toBe("claude-sonnet-4-6");
      expect(config.providers.anthropic.models).toContain("claude-sonnet-4-6");
      expect(readdirSync(claudeHome)).toEqual([]);
    });
  });

  test("invalid port input reprompts and accepts a valid follow-up", () => {
    withHomes("frogp-init-port-", (frogHome, claudeHome) => {
      // provider default → bad port "70000" → good port "10200" → decline injection
      const result = runInit("\n70000\n10200\nn\n", frogHome, claudeHome);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Port must be an integer from 1 to 65535.");
      const config = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8"));
      expect(config.port).toBe(10200);
      expect(readdirSync(claudeHome)).toEqual([]);
    });
  });

  test("invalid yes/no answer reprompts instead of saving prematurely", () => {
    withHomes("frogp-init-yesno-", (frogHome, claudeHome) => {
      // provider default → port default → invalid "maybe" → valid "n"
      const result = runInit("\n\nmaybe\nn\n", frogHome, claudeHome);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Enter y/yes or n/no.");
      expect(existsSync(join(frogHome, "config.json"))).toBe(true);
      expect(readdirSync(claudeHome)).toEqual([]);
    });
  });

  test("blank custom provider details reprompt and valid follow-up saves the custom provider", () => {
    withHomes("frogp-init-custom-", (frogHome, claudeHome) => {
      // custom menu number (providers.length + 1 at runtime) is discovered from the live menu,
      // so drive it with an intentionally large flow: pick custom, blank name → reprompt,
      // then valid name/url, default adapter, no key, no model, default port, decline injection.
      const menu = runInit("", frogHome, claudeHome).stdout;
      const customMatch = menu.match(/(\d+)\. custom \(enter URL manually\)/);
      expect(customMatch).not.toBeNull();
      const customNumber = customMatch![1];
      const input = `${customNumber}\n\nmyprov\n\nhttp://localhost:11434/v1\n\n\n\n\nn\n`;
      const result = runInit(input, frogHome, claudeHome);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Provider name is required.");
      expect(result.stderr).toContain("Base URL is required.");
      const config = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8"));
      expect(config.defaultProvider).toBe("myprov");
      expect(config.providers.myprov.baseUrl).toBe("http://localhost:11434/v1");
      expect(readdirSync(claudeHome)).toEqual([]);
    });
  });
});
