/** OAuth token store at ~/.frogprogsy/auth.json, keyed by provider name. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir, atomicWriteFile, hardenConfigDir, hardenExistingSecret, ensureConfigDirForWrite } from "../config";
import type { OAuthCredentials } from "./types";

function authPath(): string {
  // FROGPROGSY_AUTH_FILE lets an isolated-config process (e.g. the eval harness server with its
  // own FROGPROGSY_HOME) share the REAL auth store. OAuth refresh tokens rotate on use, so a
  // copied auth.json forks the token chain and invalidates the original login — sharing one
  // file (re-read on every access, atomic write) is the safe mode for side-by-side servers.
  const override = process.env["FROGPROGSY_AUTH_FILE"]?.trim();
  if (override) return resolve(override);
  return join(getConfigDir(), "auth.json");
}
type AuthStore = Record<string, OAuthCredentials>;

export function loadAuthStore(): AuthStore {
  const path = authPath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AuthStore;
  } catch {
    return {};
  }
}

function persist(store: AuthStore): void {
  ensureConfigDirForWrite("write OAuth token store");
  atomicWriteFile(authPath(), JSON.stringify(store, null, 2) + "\n");
}

export function getCredential(provider: string): OAuthCredentials | null {
  return loadAuthStore()[provider] ?? null;
}

export function saveCredential(provider: string, cred: OAuthCredentials): void {
  const store = loadAuthStore();
  store[provider] = cred;
  persist(store);
}

export function removeCredential(provider: string): void {
  const store = loadAuthStore();
  delete store[provider];
  persist(store);
}
