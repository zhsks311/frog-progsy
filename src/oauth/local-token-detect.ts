/**
 * Local token auto-detection — reads an existing Grok CLI credential (~/.grok/auth.json).
 * Read-only: never writes to external credential stores and never reads Claude Code subscription tokens.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "./types";

const XAI_AUTH_KEY_PREFIX = "https://auth.x.ai::";

export function detectGrokCliToken(): OAuthCredentials | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;

    const entry = Object.entries(raw).find(([key]) => key.startsWith(XAI_AUTH_KEY_PREFIX))?.[1];
    if (!entry?.key || !entry?.refresh_token) return null;

    const accessToken = entry.key as string;
    const refreshToken = entry.refresh_token as string;
    const expiresAt = entry.expires_at ? new Date(entry.expires_at as string).getTime() : 0;

    return {
      refresh: refreshToken,
      access: accessToken,
      expires: expiresAt,
      accountId: entry.user_id as string | undefined,
      email: entry.email as string | undefined,
    };
  } catch {
    return null;
  }
}
