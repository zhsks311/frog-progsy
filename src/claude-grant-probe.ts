/**
 * Consented Branch-B live probe.
 *
 * Verifies that an isolated Claude subscription grant's bound Anthropic provider actually works, by
 * exercising two real Anthropic surfaces with the grant's scoped Bearer token:
 *   - `GET  /v1/models`   (catalog reachability + auth)
 *   - `POST /v1/messages` (a minimal `max_tokens: 1` completion with the Claude Code identity shape)
 *
 * This is only ever invoked AFTER explicit CLI consent (`--live --yes`). It resolves ONLY the bound
 * grant token via the auth core seam and NEVER falls back to a forwarded header, an API key, an OAuth
 * login, or another provider/credential. Every HTTP / network / parse failure fails closed as a fixed
 * typed `ClaudeGrantProbeError`. The result carries ONLY redacted metadata (HTTP statuses, a model
 * count, the selected model id, and a non-reversible token fingerprint). No response body, raw token,
 * header value, credential, or filesystem path is ever returned or logged.
 */
import { createHash } from "node:crypto";
import { ClaudeGrantError, getClaudeGrantAccessToken } from "./claude-grant-auth";
import { assertAllowedClaudeGrantTarget } from "./provider-auth";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "./oauth/anthropic";
import type { FrogConfig, FrogProviderConfig } from "./types";

/** Anthropic messages/models API version pinned for the probe (matches the anthropic adapter). */
const ANTHROPIC_VERSION = "2023-06-01";
/** Bounded per-request timeout so the probe always fails closed instead of hanging. */
const PROBE_TIMEOUT_MS = 10_000;

export type ClaudeGrantProbeErrorCode =
  | "not_bound"
  | "invalid_target"
  | "token_unavailable"
  | "models_request_failed"
  | "models_unreadable"
  | "no_model"
  | "message_request_failed"
  | "probe_failed";

/**
 * Fixed, fail-closed probe error. Messages are constructed to never contain a token, credential,
 * response body, header value, or filesystem path.
 */
export class ClaudeGrantProbeError extends Error {
  readonly code: ClaudeGrantProbeErrorCode;
  readonly providerName?: string;
  constructor(code: ClaudeGrantProbeErrorCode, message: string, providerName?: string) {
    super(message);
    this.name = "ClaudeGrantProbeError";
    this.code = code;
    this.providerName = providerName;
  }
}

/** Non-reversible token fingerprint (sha256 first 8 hex chars + length). Never the token itself. */
export interface TokenFingerprint {
  sha256_8: string;
  length: number;
}

/** Redacted success metadata. Deliberately carries NO body, token, header, credential, or path. */
export interface ClaudeGrantLiveProbeResult {
  ok: true;
  /** `GET /v1/models` HTTP status. */
  status: number;
  /** Number of models returned by `GET /v1/models`. */
  modelCount: number;
  /** Deterministically selected model id exercised by `POST /v1/messages`. */
  modelId: string;
  /** `POST /v1/messages` HTTP status. */
  messageStatus: number;
  /** Non-reversible fingerprint of the bound grant access token. */
  tokenFingerprint: TokenFingerprint;
}

interface ProbeRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
interface ProbeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}
export type ProbeFetch = (input: string, init: ProbeRequestInit) => Promise<ProbeResponse>;

/** Resolver for the bound grant's access token; injected in tests, defaults to the auth core seam. */
export type GrantAccessTokenResolver = (
  config: FrogConfig,
  providerName: string,
  provider: FrogProviderConfig,
) => Promise<string>;

export interface ClaudeGrantLiveProbeDeps {
  /** Resolve ONLY the bound grant token. Never a forward header / API key / other credential. */
  getAccessToken: GrantAccessTokenResolver;
  /** HTTP transport. Injected in tests so the helper is network-zero. */
  fetch: ProbeFetch;
  /**
   * Assert the provider targets ONLY the real Anthropic subscription API, run BEFORE the broker so an
   * invalid binding fails closed with zero broker/network calls. Defaults to the strict production
   * guard (`assertAllowedClaudeGrantTarget`); tests may override to admit reserved-host fixtures. MUST
   * throw on reject, and MUST NOT surface the rejected host / path / url.
   */
  validateTarget: (provider: FrogProviderConfig) => void;
}

function resolveProbeDeps(override?: Partial<ClaudeGrantLiveProbeDeps>): ClaudeGrantLiveProbeDeps {
  return {
    getAccessToken: override?.getAccessToken ?? ((config, providerName, provider) => getClaudeGrantAccessToken(config, providerName, provider)),
    fetch: override?.fetch ?? ((input, init) => globalThis.fetch(input, init as RequestInit) as unknown as Promise<ProbeResponse>),
    validateTarget: override?.validateTarget ?? assertAllowedClaudeGrantTarget,
  };
}

function fingerprint(token: string): TokenFingerprint {
  return { sha256_8: createHash("sha256").update(token).digest("hex").slice(0, 8), length: token.length };
}

/** Normalize the provider base URL: strip a trailing `/v1` (or `/v1/`) so we can append `/v1/...`. */
function anthropicBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/** Parse the Anthropic `/v1/models` envelope into a list of model ids. `null` on malformed shape. */
function parseModelIds(text: string): string[] | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

/**
 * Deterministically pick the model to exercise: a configured `defaultModel`, else the first
 * configured `models` entry, else the lexicographically-first model id from the `/v1/models`
 * response (sorted so the choice is stable regardless of API ordering). Undefined when none exist.
 */
function selectModel(provider: FrogProviderConfig, modelIds: string[]): string | undefined {
  if (typeof provider.defaultModel === "string" && provider.defaultModel.trim() !== "") {
    return provider.defaultModel;
  }
  if (Array.isArray(provider.models)) {
    const configured = provider.models.find(model => typeof model === "string" && model.trim() !== "");
    if (configured) return configured;
  }
  if (modelIds.length > 0) {
    return [...modelIds].sort()[0];
  }
  return undefined;
}

/**
 * Run the consented live probe for `provider` (bound to a claude grant). Returns redacted metadata on
 * success. Throws a fixed `ClaudeGrantProbeError` — never leaking secrets — on any failure, and never
 * falls back to another credential, provider, forwarded header, or API key.
 */
export async function runClaudeGrantLiveProbe(
  config: FrogConfig,
  providerName: string,
  provider: FrogProviderConfig,
  depsOverride?: Partial<ClaudeGrantLiveProbeDeps>,
): Promise<ClaudeGrantLiveProbeResult> {
  const deps = resolveProbeDeps(depsOverride);

  // 0) Fail closed BEFORE the broker: the provider must be a claude-grant binding, and its target must
  //    be the real Anthropic subscription API (anthropic adapter, HTTPS api.anthropic.com, no embedded
  //    credentials / port / query / fragment / non-/v1 path). A subscription Bearer must never reach any
  //    other host, so both checks run with zero broker/network calls and never leak the rejected target.
  if (provider.authMode !== "claude-grant") {
    throw new ClaudeGrantProbeError("not_bound", `provider ${providerName} is not bound to a claude grant`, providerName);
  }
  try {
    deps.validateTarget(provider);
  } catch {
    // The guard throws a fixed, redacted error; re-wrap with a fixed message (no host/path/url).
    throw new ClaudeGrantProbeError("invalid_target", `provider ${providerName} is not bound to a valid Claude subscription endpoint`, providerName);
  }

  // 1) Resolve ONLY the bound grant token. not_bound (grant not attached) fails closed with zero
  //    network I/O; any other resolution failure (no credential, refresh failure) is token_unavailable.
  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken(config, providerName, provider);
  } catch (err) {
    if (err instanceof ClaudeGrantError && err.code === "not_bound") {
      throw new ClaudeGrantProbeError("not_bound", `provider ${providerName} is not bound to a claude grant`, providerName);
    }
    throw new ClaudeGrantProbeError("token_unavailable", `could not resolve the bound claude grant token for provider ${providerName}`, providerName);
  }
  const tokenFingerprint = fingerprint(accessToken);

  const base = anthropicBase(provider.baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    Authorization: `Bearer ${accessToken}`,
  };

  // 2) GET /v1/models — catalog reachability + auth.
  let modelsResponse: ProbeResponse;
  try {
    modelsResponse = await deps.fetch(`${base}/v1/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    throw new ClaudeGrantProbeError("models_request_failed", `the live probe GET /v1/models request failed for provider ${providerName}`, providerName);
  }
  if (!modelsResponse.ok) {
    throw new ClaudeGrantProbeError("models_request_failed", `the live probe GET /v1/models returned a non-success status (${modelsResponse.status}) for provider ${providerName}`, providerName);
  }
  const modelsText = await modelsResponse.text().catch(() => "");
  const modelIds = parseModelIds(modelsText);
  if (modelIds === null) {
    throw new ClaudeGrantProbeError("models_unreadable", `the live probe could not read the GET /v1/models response for provider ${providerName}`, providerName);
  }

  // 3) Deterministic model selection.
  const modelId = selectModel(provider, modelIds);
  if (!modelId) {
    throw new ClaudeGrantProbeError("no_model", `the live probe found no model to exercise for provider ${providerName}`, providerName);
  }

  // 4) POST /v1/messages — a minimal capped completion with the Claude Code identity system block.
  const body = JSON.stringify({
    model: modelId,
    max_tokens: 1,
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }],
    messages: [{ role: "user", content: "ping" }],
  });
  let messageResponse: ProbeResponse;
  try {
    messageResponse = await deps.fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    throw new ClaudeGrantProbeError("message_request_failed", `the live probe POST /v1/messages request failed for provider ${providerName}`, providerName);
  }
  if (!messageResponse.ok) {
    throw new ClaudeGrantProbeError("message_request_failed", `the live probe POST /v1/messages returned a non-success status (${messageResponse.status}) for provider ${providerName}`, providerName);
  }

  return {
    ok: true,
    status: modelsResponse.status,
    modelCount: modelIds.length,
    modelId,
    messageStatus: messageResponse.status,
    tokenFingerprint,
  };
}
