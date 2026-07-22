/** OpenAI Codex OAuth (ChatGPT account device-code flow). */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalTokenImportMode, OAuthController, OAuthCredentials } from "./types";

export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`;
export const CODEX_DEVICE_URL = `${CODEX_OAUTH_ISSUER}/codex/device`;

const CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEVICE_CODE_REQUEST_ATTEMPTS = 3;
const DEVICE_CODE_RETRY_BASE_MS = 250;

type TokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
};

type DeviceCodePayload = {
  user_code?: unknown;
  device_auth_id?: unknown;
  interval?: unknown;
};

type DevicePollPayload = {
  authorization_code?: unknown;
  code_verifier?: unknown;
};

function requestSignal(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error(`Codex OAuth cancelled: ${signal.reason}`));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void = () => {};
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Codex OAuth cancelled: ${signal?.reason}`));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length < 2 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function codexAccountIdFromAccessToken(accessToken: string | undefined): string | undefined {
  if (!accessToken) return undefined;
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId === "string" && accountId.length > 0) return accountId;
  }
  return undefined;
}

function tokenExpiresAtMs(accessToken: string, expiresIn: unknown): number {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000 - CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS;
  }
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    return exp * 1000 - CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS;
  }
  return Date.now() + 3600 * 1000 - CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS;
}

function credentialsFromTokenPayload(payload: TokenPayload, refreshFallback = ""): OAuthCredentials {
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Codex token response did not include an access token");
  }
  const refresh = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
    ? payload.refresh_token
    : refreshFallback;
  if (!refresh) throw new Error("Codex token response did not include a refresh token");
  const accountId = codexAccountIdFromAccessToken(payload.access_token);
  return {
    refresh,
    access: payload.access_token,
    expires: tokenExpiresAtMs(payload.access_token, payload.expires_in),
    ...(accountId ? { accountId } : {}),
  };
}

async function postCodexToken(body: Record<string, string>, signal?: AbortSignal): Promise<TokenPayload> {
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal: requestSignal(signal),
  });
  if (response.status === 429) {
    throw new Error("Codex OAuth quota/rate limit returned HTTP 429; credentials are not fixed by re-login");
  }
  if (!response.ok) {
    throw new Error(`Codex token request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenPayload;
}

function readCodexCliToken(): OAuthCredentials | null {
  const codexHome = (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  const authPath = join(codexHome, "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const payload = JSON.parse(readFileSync(authPath, "utf8")) as { tokens?: TokenPayload };
    const tokens = payload.tokens;
    if (!tokens) return null;
    const cred = credentialsFromTokenPayload(tokens);
    // Do not import expired access tokens. They may be refreshable, but sharing the Codex CLI refresh token
    // causes rotation races; the built-in device flow below creates an frogprogsy-owned session instead.
    return cred.expires > Date.now() ? cred : null;
  } catch {
    return null;
  }
}

export async function requestCodexDeviceCode(signal?: AbortSignal): Promise<{ userCode: string; deviceAuthId: string; intervalMs: number }> {
  let response: Response | undefined;
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= DEVICE_CODE_REQUEST_ATTEMPTS; attempt++) {
    try {
      response = await fetch(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
        signal: requestSignal(signal, 15_000),
      });
    } catch (error) {
      lastNetworkError = error;
      if (signal?.aborted || attempt === DEVICE_CODE_REQUEST_ATTEMPTS) throw error;
      await sleep(DEVICE_CODE_RETRY_BASE_MS * attempt, signal);
      continue;
    }

    if (response.status < 500 || attempt === DEVICE_CODE_REQUEST_ATTEMPTS) break;
    await response.arrayBuffer();
    await sleep(DEVICE_CODE_RETRY_BASE_MS * attempt, signal);
  }

  if (!response) throw lastNetworkError;
  if (!response.ok) throw new Error(`Codex device-code request failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as DeviceCodePayload;
  if (typeof data.user_code !== "string" || typeof data.device_auth_id !== "string") {
    throw new Error("Codex device-code response missing user_code or device_auth_id");
  }
  const intervalSeconds = typeof data.interval === "number" && Number.isFinite(data.interval) ? data.interval : 5;
  return {
    userCode: data.user_code,
    deviceAuthId: data.device_auth_id,
    intervalMs: Math.max(3, intervalSeconds) * 1000,
  };
}

async function pollDeviceAuthorization(deviceAuthId: string, userCode: string, intervalMs: number, signal?: AbortSignal): Promise<DevicePollPayload> {
  const deadline = Date.now() + DEVICE_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(intervalMs, signal);
    const response = await fetch(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: requestSignal(signal, 15_000),
    });
    if (response.status === 200) return (await response.json()) as DevicePollPayload;
    if (response.status === 403 || response.status === 404) continue;
    throw new Error(`Codex device authorization polling failed: ${response.status} ${await response.text()}`);
  }
  throw new Error("Codex login timed out after 15 minutes");
}

async function runDeviceCodeLogin(ctrl: OAuthController): Promise<OAuthCredentials> {
  ctrl.onProgress?.("Requesting Codex device code...");
  const device = await requestCodexDeviceCode(ctrl.signal);
  ctrl.onAuth?.({
    url: CODEX_DEVICE_URL,
    code: device.userCode,
    instructions: `OpenAI Codex device login code: ${device.userCode}\nOpen ${CODEX_DEVICE_URL}, sign in with your ChatGPT/Codex account, and enter the code.`,
  });
  ctrl.onProgress?.("Waiting for Codex device authorization...");
  const auth = await pollDeviceAuthorization(device.deviceAuthId, device.userCode, device.intervalMs, ctrl.signal);
  if (typeof auth.authorization_code !== "string" || typeof auth.code_verifier !== "string") {
    throw new Error("Codex device authorization response missing authorization_code or code_verifier");
  }
  ctrl.onProgress?.("Exchanging Codex authorization code for tokens...");
  const tokens = await postCodexToken({
    grant_type: "authorization_code",
    code: auth.authorization_code,
    redirect_uri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: auth.code_verifier,
  }, ctrl.signal);
  return credentialsFromTokenPayload(tokens);
}

export async function loginCodex(ctrl: OAuthController, opts?: { importLocal?: LocalTokenImportMode }): Promise<OAuthCredentials> {
  const importLocal = opts?.importLocal ?? "off";
  if (importLocal !== "off") {
    const local = readCodexCliToken();
    if (local) {
      ctrl.onProgress?.("Found Codex CLI token, importing automatically");
      return local;
    }
    if (importLocal === "only") {
      throw new Error("No fresh Codex CLI token found at ~/.codex/auth.json. Run 'frogp login codex' for device-code OAuth.");
    }
  }
  return runDeviceCodeLogin(ctrl);
}

export async function refreshCodexToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (!refreshToken) throw new Error("Codex credentials are expired and do not include a refresh token");
  const payload = await postCodexToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  }, signal);
  return credentialsFromTokenPayload(payload, refreshToken);
}

export function isCodexBackendBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname.toLowerCase() === "chatgpt.com" && parsed.pathname.includes("/backend-api/codex");
  } catch {
    return false;
  }
}

export function codexBackendHeaders(accessToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0 (frogprogsy)",
    originator: "codex_cli_rs",
  };
  const accountId = codexAccountIdFromAccessToken(accessToken);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}
