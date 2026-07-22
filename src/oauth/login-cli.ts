import * as readline from "node:readline";
import { openUrl } from "../open-url";
import { loadConfig, readPid, saveConfig } from "../config";
import { OAUTH_PROVIDERS, runLogin } from "./index";
import { KEY_LOGIN_PROVIDERS, isKeyLoginProvider, validateApiKey, type KeyLoginProvider } from "./key-providers";
import { suggestClosest } from "../cli-suggest";
import type { FrogModelCapabilities, FrogProviderConfig } from "../types";

/** Push the new provider into a running proxy's live config so it routes without a restart. */
async function notifyRunningProxy(name: string, provider: unknown): Promise<void> {
  if (!readPid()) return;
  const cfg = loadConfig();
  try {
    await fetch(`http://localhost:${cfg.port}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, provider }),
    });
  } catch {
    /* proxy unreachable; disk config loads on next start */
  }
}
const KEY_LOGIN_ALIASES: Record<string, string> = {
  // Users type "frogp login openai" naturally. Keep that as API-key OpenAI;
  // ChatGPT/Codex account login is explicit as "frogp login codex".
  openai: "openai-apikey",
};

export function resolveKeyLoginRequest(name: string): { lookupName: string; saveName: string; alias: boolean } | null {
  if (isKeyLoginProvider(name)) return { lookupName: name, saveName: name, alias: false };
  const lookupName = KEY_LOGIN_ALIASES[name];
  if (lookupName && isKeyLoginProvider(lookupName)) return { lookupName, saveName: name, alias: true };
  return null;
}

export function loginProviderGroups(): { oauth: string[]; key: string[]; suggestions: string[]; openaiAlias: string } {
  const oauth = Object.keys(OAUTH_PROVIDERS);
  const key = Object.keys(KEY_LOGIN_PROVIDERS);
  return {
    oauth,
    key,
    suggestions: [...oauth, ...key, "openai"],
    openaiAlias: "openai is an alias for openai-apikey.",
  };
}

export function formatLoginProviderGroups(): string {
  const groups = loginProviderGroups();
  return (
    `  OAuth login:   ${groups.oauth.join(", ")}\n` +
    `  API-key login: ${groups.key.join(", ")}\n` +
    `  Alias:         ${groups.openaiAlias}`
  );
}

export function formatLoginUsage(): string {
  return `Usage: frogp login [--list|<provider>]\n${formatLoginProviderGroups()}`;
}

export function formatLoginFailure(provider: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Login failed for ${provider}: ${message}\nTry again: frogp login ${provider}`;
}

export async function handleLogin(provider?: string): Promise<void> {
  const name = (provider ?? "").trim().toLowerCase();
  if (name === "--list") {
    console.log(formatLoginProviderGroups());
    return;
  }
  if (name === "anthropic") {
    console.error("Anthropic Claude subscription OAuth login is not supported. Use `claude login` and `frogp claude` homes for Claude Code pass-through, or add an Anthropic Console API key as a custom provider.");
    process.exit(1);
  }
  if (!name) {
    console.error(formatLoginUsage());
    process.exit(1);
  }
  if (OAUTH_PROVIDERS[name]) return handleOAuthLogin(name);
  const keyLogin = resolveKeyLoginRequest(name);
  if (keyLogin) return handleKeyLogin(keyLogin);
  const suggestion = suggestClosest(name, loginProviderGroups().suggestions);
  console.error(formatLoginUsage() + (suggestion ? `\nDid you mean: frogp login ${suggestion}?` : ""));
  process.exit(1);
}

async function handleOAuthLogin(name: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let loginError: unknown;
  try {
    await runLogin(name, {
      onAuth: ({ url, instructions }) => {
        console.log(`\n🔐 Opening browser for ${name} login...\n${url}\n`);
        if (instructions) console.log(instructions);
        openUrl(url);
      },
      onProgress: (m) => console.log(`   ${m}`),
      onManualCodeInput: () =>
        new Promise((res) => rl.question("Paste redirect URL or code (or wait for browser): ", res)),
    });
  } catch (err) {
    loginError = err;
  } finally {
    rl.close();
  }
  if (loginError) {
    console.error(formatLoginFailure(name, loginError));
    process.exit(1);
  }
  await notifyRunningProxy(name, OAUTH_PROVIDERS[name].providerConfig);
  console.log(`\n✅ Logged in to ${name}. Try: frogp refresh`);
}

export function providerConfigFromKeyLoginProvider(def: KeyLoginProvider, key: string): FrogProviderConfig {
  return {
    adapter: def.adapter,
    baseUrl: def.baseUrl,
    apiKey: key,
    ...(def.defaultModel ? { defaultModel: def.defaultModel } : {}),
    ...(def.models ? { models: [...def.models] } : {}),
    ...(def.contextWindow !== undefined ? { contextWindow: def.contextWindow } : {}),
    ...(def.modelContextWindows ? { modelContextWindows: { ...def.modelContextWindows } } : {}),
    ...(def.modelCapabilities ? { modelCapabilities: cloneModelCapabilities(def.modelCapabilities) } : {}),
    ...(def.reasoningEfforts ? { reasoningEfforts: [...def.reasoningEfforts] } : {}),
    ...(def.modelReasoningEfforts ? { modelReasoningEfforts: cloneRecordOfArrays(def.modelReasoningEfforts) } : {}),
    ...(def.reasoningEffortMap ? { reasoningEffortMap: { ...def.reasoningEffortMap } } : {}),
    ...(def.modelReasoningEffortMap ? { modelReasoningEffortMap: cloneNestedRecord(def.modelReasoningEffortMap) } : {}),
    ...(def.noReasoningModels ? { noReasoningModels: [...def.noReasoningModels] } : {}),
    ...(def.noTemperatureModels ? { noTemperatureModels: [...def.noTemperatureModels] } : {}),
    ...(def.noTopPModels ? { noTopPModels: [...def.noTopPModels] } : {}),
    ...(def.noPenaltyModels ? { noPenaltyModels: [...def.noPenaltyModels] } : {}),
    ...(def.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...def.autoToolChoiceOnlyModels] } : {}),
    ...(def.preserveReasoningContentModels ? { preserveReasoningContentModels: [...def.preserveReasoningContentModels] } : {}),
    ...(def.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: def.escapeBuiltinToolNames } : {}),
  };
}

async function handleKeyLogin(request: { lookupName: string; saveName: string; alias: boolean }): Promise<void> {
  const def = KEY_LOGIN_PROVIDERS[request.lookupName];
  console.log(`\n🔑 ${def.label} — opening ${def.dashboardUrl} so you can create/copy an API key...`);
  openUrl(def.dashboardUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await new Promise<string>((res) => rl.question(`Paste your ${def.label} API key: `, res))).trim();
  rl.close();
  if (!key) {
    console.error("No key entered.");
    process.exit(1);
  }
  process.stdout.write("   validating… ");
  const valid = await validateApiKey(def, key);
  console.log(valid === true ? "valid ✅" : valid === false ? "INVALID ❌" : "couldn't validate (may still work)");
  if (valid === false) {
    console.error("Provider rejected the key. Not saved.");
    process.exit(1);
  }
  const provider = providerConfigFromKeyLoginProvider(def, key);
  const config = loadConfig();
  config.providers[request.saveName] = provider;
  if (request.alias && (config.defaultProvider === request.saveName || !config.providers[config.defaultProvider])) {
    config.defaultProvider = request.saveName;
  }
  saveConfig(config);
  await notifyRunningProxy(request.saveName, provider);
  const aliasNote = request.alias ? ` (${request.lookupName})` : "";
  console.log(`✅ ${def.label}${aliasNote} added as "${request.saveName}". Try: frogp refresh`);
}

function cloneRecordOfArrays(input: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, [...value]]));
}

function cloneModelCapabilities(input: Record<string, FrogModelCapabilities>): Record<string, FrogModelCapabilities> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value, ...(value.input ? { input: [...value.input] } : {}) }]));
}

function cloneNestedRecord(input: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value }]));
}
