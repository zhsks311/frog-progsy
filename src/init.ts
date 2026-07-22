import * as readline from "node:readline";
import { injectClaudeCodeConfig } from "./claude-inject";
import { error, shouldColor, success, warn } from "./cli-color";
import { DEFAULT_PORT, getDefaultConfig, saveConfig } from "./config";
import { enrichProviderFromCatalog } from "./oauth/key-providers";
import { deriveInitProviders } from "./providers/derive";
import type { FrogConfig, FrogProviderConfig } from "./types";

export const DEFAULT_INIT_PROVIDER_ID = "anthropic";

function createPrompt(): { ask(question: string): Promise<string>; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY === true });
  const queued: string[] = [];
  const waiters: Array<{ resolve(answer: string): void; reject(error: Error): void }> = [];
  let closed = false;

  rl.on("line", line => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(line);
    } else {
      queued.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    const error = new Error("Input stream closed.");
    while (waiters.length > 0) {
      waiters.shift()?.reject(error);
    }
  });

  return {
    ask(question: string): Promise<string> {
      process.stdout.write(question);
      const queuedAnswer = queued.shift();
      if (queuedAnswer !== undefined) return Promise.resolve(queuedAnswer);
      if (closed) return Promise.reject(new Error("Input stream closed."));
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    close() { rl.close(); },
  };
}

type InitKind = "forward" | "oauth" | "key" | "local";
export interface InitProvider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  kind: InitKind;
  dashboardUrl?: string;
  defaultModel?: string;
}

export type InitChoice =
  | { kind: "provider"; index: number }
  | { kind: "custom" }
  | { kind: "error"; message: string };

export type PortInput =
  | { ok: true; port: number }
  | { ok: false; message: string };

export type YesNoInput =
  | { ok: true; value: boolean }
  | { ok: false; message: string };

/**
 * The full CLI provider menu, derived from the canonical provider registry so `frogp init`,
 * the GUI picker, key-login catalog, OAuth seeds, and metadata aliases cannot drift.
 */
export function buildInitProviders(): InitProvider[] {
  return deriveInitProviders();
}

export function parseInitChoice(input: string, providers: InitProvider[], defaultProviderId: string): InitChoice {
  const trimmed = input.trim();
  const defaultIndex = providers.findIndex(provider => provider.id === defaultProviderId);
  if (defaultIndex < 0) {
    return { kind: "error", message: `Default provider '${defaultProviderId}' is not available.` };
  }
  if (!trimmed) return { kind: "provider", index: defaultIndex };
  if (!/^\d+$/.test(trimmed)) {
    return { kind: "error", message: `Enter a number from 1 to ${providers.length + 1}.` };
  }

  const selected = Number(trimmed);
  if (selected >= 1 && selected <= providers.length) {
    return { kind: "provider", index: selected - 1 };
  }
  if (selected === providers.length + 1) return { kind: "custom" };
  return { kind: "error", message: `Enter a number from 1 to ${providers.length + 1}.` };
}

export function parsePortInput(input: string, defaultPort: number): PortInput {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, port: defaultPort };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Port must be an integer from 1 to 65535." };
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: "Port must be an integer from 1 to 65535." };
  }
  return { ok: true, port };
}

export function parseYesNoDefault(input: string, defaultYes: boolean): YesNoInput {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return { ok: true, value: defaultYes };
  if (trimmed === "y" || trimmed === "yes") return { ok: true, value: true };
  if (trimmed === "n" || trimmed === "no") return { ok: true, value: false };
  return { ok: false, message: "Enter y/yes or n/no." };
}

const KIND_HEADING: Record<InitKind, string> = {
  forward: "Forward auth",
  oauth: "Account login (OAuth — then run: frogp login <id>)",
  key: "API key (paste a key from the provider's dashboard)",
  local: "Local servers (usually no key)",
};

function printMenu(providers: InitProvider[]): void {
  console.log("Available providers:");
  let lastKind: InitKind | null = null;
  providers.forEach((p, i) => {
    if (p.kind !== lastKind) { console.log(`\n  ${KIND_HEADING[p.kind]}:`); lastKind = p.kind; }
    console.log(`   ${String(i + 1).padStart(2)}. ${p.label}`);
  });
  console.log(`\n   ${providers.length + 1}. custom (enter URL manually)`);
}

const envKeyFor = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

async function askUntilValid<T>(
  ask: (question: string) => Promise<string>,
  question: string,
  parse: (input: string) => T,
  isOk: (result: T) => boolean,
  message: (result: T) => string,
): Promise<T> {
  for (;;) {
    const result = parse(await ask(question));
    if (isOk(result)) return result;
    console.error(message(result));
  }
}

export async function runInit(): Promise<void> {
  const colorEnabled = shouldColor(process.env, process.stdout.isTTY === true);
  const prompt = createPrompt();

  try {
    console.log("\n🔧 frogprogsy (frogp) setup\n");

    const providers = buildInitProviders();
    const defaultProviderIndex = providers.findIndex(provider => provider.id === DEFAULT_INIT_PROVIDER_ID);
    if (defaultProviderIndex < 0) {
      throw new Error(`Default init provider '${DEFAULT_INIT_PROVIDER_ID}' is not available.`);
    }
    const defaultProvider = providers[defaultProviderIndex];

    printMenu(providers);

    const choiceQuestion = `\nSelect provider (number) [${defaultProviderIndex + 1}. ${defaultProvider.label}]: `;
    const choice = await askUntilValid(
      prompt.ask,
      choiceQuestion,
      input => parseInitChoice(input, providers, DEFAULT_INIT_PROVIDER_ID),
      result => result.kind !== "error",
      result => result.kind === "error" ? error(result.message, colorEnabled) : "",
    );

    let providerName: string;
    let providerConfig: FrogProviderConfig;
    let oauthHint = false;

    if (choice.kind === "provider") {
      const p = providers[choice.index];
      providerName = p.id;
      console.log(`\n📡 ${p.label}`);
      console.log(`   Base URL: ${p.baseUrl}`);

      if (p.kind === "forward") {
        providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "forward", ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}) };
        enrichProviderFromCatalog(p.id, providerConfig);
        console.log("   No key stored — forwards Claude Code/gateway credentials when present.");
      } else if (p.kind === "oauth") {
        providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "oauth", ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}) };
        oauthHint = true;
      } else {
        // key + local: collect a key (local usually blank).
        if (p.dashboardUrl) console.log(`   🔑 Get your key: ${p.dashboardUrl}`);
        const env = envKeyFor(p.id);
        const hint = p.kind === "local" ? "API key (usually blank — press Enter): " : `API key (paste, or env var $${env}): `;
        const apiKey = (await prompt.ask(`\n${hint}`)).trim();
        const modelChoice = (await prompt.ask(`Default model${p.defaultModel ? ` [${p.defaultModel}]` : " (optional)"}: `)).trim();
        const defaultModel = modelChoice || p.defaultModel;
        providerConfig = {
          adapter: p.adapter,
          baseUrl: p.baseUrl,
          ...(p.kind === "key" ? { apiKey: apiKey || `\${${env}}` } : apiKey ? { apiKey } : {}),
          ...(defaultModel ? { defaultModel } : {}),
        };
        // Apply the catalog's models / vision classification (same enrichment as the GUI).
        enrichProviderFromCatalog(p.id, providerConfig);
      }
    } else {
      providerName = await askUntilValid(
        prompt.ask,
        "Provider name: ",
        input => input.trim(),
        value => value.length > 0,
        () => error("Provider name is required.", colorEnabled),
      );
      const baseUrl = await askUntilValid(
        prompt.ask,
        "Base URL (e.g. http://localhost:11434/v1): ",
        input => input.trim(),
        value => value.length > 0,
        () => error("Base URL is required.", colorEnabled),
      );
      const adapter = (await prompt.ask("Adapter [openai-chat]: ")).trim() || "openai-chat";
      const apiKey = (await prompt.ask("API key (optional): ")).trim();
      const defaultModel = (await prompt.ask("Default model: ")).trim();
      providerConfig = {
        adapter,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      };
    }

    const portResult = await askUntilValid(
      prompt.ask,
      `\nProxy port [${DEFAULT_PORT}]: `,
      input => parsePortInput(input, DEFAULT_PORT),
      result => result.ok,
      result => result.ok ? "" : error(result.message, colorEnabled),
    );
    if (!portResult.ok) throw new Error(portResult.message);

    const injectAnswer = await askUntilValid(
      prompt.ask,
      "Inject into Claude Code settings.json? [Y/n]: ",
      input => parseYesNoDefault(input, true),
      result => result.ok,
      result => result.ok ? "" : error(result.message, colorEnabled),
    );
    if (!injectAnswer.ok) throw new Error(injectAnswer.message);

    const config: FrogConfig = {
      ...getDefaultConfig(),
      port: portResult.port,
      providers: { [providerName]: providerConfig },
      defaultProvider: providerName,
    };

    saveConfig(config);
    console.log(success(`\n✅ Config saved to ~/.frogprogsy/config.json`, colorEnabled));
    if (oauthHint) console.log(`🔐 Authenticate this provider with:  frogp login ${providerName}`);

    if (injectAnswer.value) {
      console.log("Fetching available models from provider...");
      const result = await injectClaudeCodeConfig(portResult.port, config);
      console.log(result.success ? success(`✅ ${result.message}`, colorEnabled) : warn(`⚠️  ${result.message}`, colorEnabled));
    }

    console.log(`\n🚀 Setup complete! Run 'frogp start' to start the proxy.`);
  } catch (err) {
    console.error(error(err instanceof Error ? err.message : String(err), colorEnabled));
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}
