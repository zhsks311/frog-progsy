#!/usr/bin/env bun
/**
 * P0 live passthrough probe (consented, controlled).
 *
 * Goal: prove that the REAL Claude Code executable, launched token-free
 * (`ANTHROPIC_BASE_URL` + `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, with
 * `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`
 * removed), reaches a loopback-only mock Anthropic gateway carrying the CURRENT
 * logged-in subscription OAuth bearer UNCHANGED, and that a pre-seeded gateway
 * model-cache alias (exact `{baseUrl,fetchedAt,models:[{id,display_name?}]}`
 * byte shape, mode 0600) is accepted by a real non-interactive message.
 *
 * Safety invariants (fail-closed):
 *  - Never mutates native auth / Keychain / settings.json. The ONLY file the
 *    probe writes is `~/.claude/cache/gateway-models.json`, backed up before and
 *    restored byte-for-byte (+ mode) in `finally` (or deleted if it did not
 *    exist).
 *  - Never emits token bytes, email, org name/id, or absolute home paths. All
 *    credential/token evidence is sha256[:8] + byte length only. A final leak
 *    scan aborts the artifact write if any secret/home/username/token substring
 *    is present.
 *  - Every child process is bounded by a timeout; partial or ambiguous evidence
 *    is recorded as FAIL, never waited on.
 *  - The real interactive `/model` picker proof is INTENTIONALLY NOT executed.
 *    A safe PTY proof is not constructible on this machine: a sandbox HOME that
 *    would isolate mutable state strips the unscoped native subscription
 *    (empirically loggedIn=false), and the only native-auth-preserving config
 *    writes into the shared, concurrently-written Claude state file
 *    (`~/.claude.json` / `~/.claude/.claude.json`), which the P0 restore
 *    contract forbids clobbering. Per the P0 contract, the absence of a safe
 *    real `/model` picker proof means non-interactive `-p --model` acceptance is
 *    a limitation only and the verdict is FAIL — never PASS. Connector state is
 *    proven as eligibility only (connectors-disabled warning absent), never a
 *    live third-party call.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// ── constants ────────────────────────────────────────────────────────────────

export const CLAUDE_VERSION = "2.1.215";
export const PROBE_MODEL_ID = "claude-frogp-probe-model";
export const PROBE_MODEL_DISPLAY = "probe/local-model";
export const SENTINEL = "local-frogprogsy";
export const NATIVE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CACHE_SCHEMA = "{baseUrl,fetchedAt,models:[{id,display_name?}]}";
export const FORBIDDEN_AUTH_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

// ── pure, testable helpers ───────────────────────────────────────────────────

/** sha256 hex, first 8 chars + ":" + byte length. Never returns raw bytes. */
export function fingerprint(value: string | Buffer): string {
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const hex = createHash("sha256").update(buf).digest("hex");
  return `${hex.slice(0, 8)}:${buf.byteLength}`;
}

/** Full sha256 hex (for internal equality only; never stored). */
export function fullHash(value: string | Buffer): string {
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return createHash("sha256").update(buf).digest("hex");
}

export interface RedactedHash {
  sha256_8: string;
  length: number;
}

export function redactHash(value: string | Buffer): RedactedHash {
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return { sha256_8: fullHash(buf).slice(0, 8), length: buf.byteLength };
}

/** The EXACT target byte shape P1's final writer must emit. */
export function buildProbeCache(baseUrl: string, now: number): {
  baseUrl: string;
  fetchedAt: number;
  models: Array<{ id: string; display_name: string }>;
} {
  return {
    baseUrl,
    fetchedAt: now,
    models: [{ id: PROBE_MODEL_ID, display_name: PROBE_MODEL_DISPLAY }],
  };
}

export function serializeProbeCache(cache: unknown): string {
  return `${JSON.stringify(cache, null, 2)}\n`;
}

/**
 * Build the token-free launch environment. Starts from an allowlist (never
 * inherits the caller's ANTHROPIC_ or CLAUDE vars), pins the real HOME/USER so
 * native subscription OAuth resolves, sets the gateway base URL + discovery, and
 * hard-removes the three forbidden auth carriers.
 */
export function buildTokenFreeEnv(
  realHome: string,
  realUser: string,
  mockUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allow = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"];
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = baseEnv[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  env.HOME = realHome;
  env.USER = realUser;
  env.LOGNAME = realUser;
  env.TERM = "dumb";
  env.ANTHROPIC_BASE_URL = mockUrl;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  for (const k of FORBIDDEN_AUTH_ENV) delete env[k];
  return env;
}

/** Native (no gateway) environment for read-only status / mcp queries. */
export function buildNativeEnv(
  realHome: string,
  realUser: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allow = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"];
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = baseEnv[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  env.HOME = realHome;
  env.USER = realUser;
  env.LOGNAME = realUser;
  env.TERM = "dumb";
  for (const k of FORBIDDEN_AUTH_ENV) delete env[k];
  return env;
}

export interface RequestFacts {
  method: string;
  path: string;
  authScheme: "bearer" | "x-api-key" | "other" | "none";
  bearerFingerprint: string | null;
  xApiKeyPresent: boolean;
  sentinelPresent: boolean;
  anthropicVersionPresent: boolean;
  anthropicBetaTokens: string[];
  anthropicBetaHasOAuth: boolean;
  modelInBody: string | null;
}

export function analyzeRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  bodyText: string,
): RequestFacts {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const auth = lower["authorization"];
  const xApiKey = lower["x-api-key"];
  let authScheme: RequestFacts["authScheme"] = "none";
  let bearerFingerprint: string | null = null;
  if (typeof auth === "string" && auth.trim() !== "") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) {
      authScheme = "bearer";
      bearerFingerprint = fingerprint(m[1]!.trim());
    } else {
      authScheme = "other";
    }
  } else if (typeof xApiKey === "string" && xApiKey.trim() !== "") {
    authScheme = "x-api-key";
  }

  const betaRaw = lower["anthropic-beta"] ?? "";
  const anthropicBetaTokens = betaRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const haystack = `${Object.values(lower).join("\u0000")}\u0000${bodyText}`;

  let modelInBody: string | null = null;
  try {
    const parsed = bodyText ? JSON.parse(bodyText) : null;
    if (parsed && typeof parsed === "object" && "model" in parsed) {
      modelInBody = String((parsed as { model?: unknown }).model);
    }
  } catch {
    modelInBody = null;
  }

  return {
    method,
    path,
    authScheme,
    bearerFingerprint,
    xApiKeyPresent: typeof xApiKey === "string" && xApiKey.trim() !== "",
    sentinelPresent: haystack.includes(SENTINEL),
    anthropicVersionPresent: typeof lower["anthropic-version"] === "string" && lower["anthropic-version"].trim() !== "",
    anthropicBetaTokens,
    anthropicBetaHasOAuth: anthropicBetaTokens.some((t) => /oauth/i.test(t)),
    modelInBody,
  };
}

export interface ConnectorEligibility {
  listRan: boolean;
  claudeAiConnectorsPresent: boolean;
  anyConnectorConnected: boolean;
  connectorsDisabledWarningPresent: boolean;
  connectorsDisabledWarningAbsent: boolean;
}

/** Derive redacted connector-eligibility booleans from `claude mcp list` text. */
export function parseMcpConnectors(output: string): ConnectorEligibility {
  const text = output ?? "";
  const disabled = /connectors?\s+are\s+disabled|connectors?\s+disabled|disabled\s+connectors?|connector[s]?\s+.{0,40}\bdisabled\b/i.test(text);
  return {
    listRan: true,
    claudeAiConnectorsPresent: /claude\.ai\s+/i.test(text),
    anyConnectorConnected: /Connected/i.test(text),
    connectorsDisabledWarningPresent: disabled,
    connectorsDisabledWarningAbsent: !disabled,
  };
}

/** Replace secrets / home / username with stable redaction markers. */
export function sanitize(text: string, secrets: string[]): string {
  let out = text ?? "";
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join("<redacted>");
  }
  // long token-ish runs (JWT/base64url) → redact defensively.
  out = out.replace(/[A-Za-z0-9_\-]{40,}/g, "<redacted-long>");
  return out;
}

/** Fail-closed: throw if any forbidden substring survives into the artifact. */
export function assertNoLeak(jsonString: string, secrets: string[]): void {
  for (const s of secrets) {
    if (s && s.length > 0 && jsonString.includes(s)) {
      throw new Error(`redaction guard: artifact contains a forbidden substring (len ${s.length})`);
    }
  }
  if (/eyJ[A-Za-z0-9_\-]{20,}\./.test(jsonString)) {
    throw new Error("redaction guard: artifact contains a JWT-shaped token");
  }
  if (/-----BEGIN/.test(jsonString)) {
    throw new Error("redaction guard: artifact contains a PEM block");
  }
}

export interface Gate {
  id: string;
  pass: boolean;
  detail: string;
}

export function computeVerdict(gates: Gate[]): "PASS" | "FAIL" {
  return gates.every((g) => g.pass) ? "PASS" : "FAIL";
}

// ── live orchestration ───────────────────────────────────────────────────────

interface MockCapture extends RequestFacts {}

function timeoutSpawn(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs: number },
): { status: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string } {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: opts.env,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
  });
  const timedOut = (r as { signal?: string }).signal === "SIGKILL" || Boolean(r.error && /ETIMEDOUT|timed?\s*out/i.test(String(r.error)));
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut,
    error: r.error ? String(r.error.message ?? r.error) : undefined,
  };
}

/**
 * Async spawn (Bun.spawn) with a hard timeout. MUST be used for any child that
 * runs while the in-process mock `Bun.serve` is live, so the event loop stays
 * free to answer the gateway requests (a synchronous spawn would deadlock the
 * server against the child).
 */
async function spawnAsync(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    env: opts.env,
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, opts.timeoutMs);
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { status: typeof status === "number" ? status : null, stdout, stderr, timedOut };
}

function readNativeCredential(account: string): string | null {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", NATIVE_KEYCHAIN_SERVICE, "-a", account, "-w"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (r.status === 0) return (r.stdout ?? "").replace(/\n$/, "");
  return null;
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  ok: boolean;
}

function claudeAuthStatus(bin: string, env: Record<string, string>): AuthStatus {
  const r = timeoutSpawn(bin, ["auth", "status", "--json"], { env, timeoutMs: 20_000 });
  if (r.status !== 0 || !r.stdout.trim()) {
    return { loggedIn: false, authMethod: null, subscriptionType: null, ok: false };
  }
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    return {
      loggedIn: j.loggedIn === true,
      authMethod: typeof j.authMethod === "string" ? j.authMethod : null,
      subscriptionType: typeof j.subscriptionType === "string" ? j.subscriptionType : null,
      ok: true,
    };
  } catch {
    return { loggedIn: false, authMethod: null, subscriptionType: null, ok: false };
  }
}

function sseMessage(model: string): string {
  const base = {
    id: "msg_probe_0001",
    type: "message",
    role: "assistant",
    model,
    content: [] as unknown[],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    ev("message_start", { type: "message_start", message: base }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROBE_OK" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ev("message_stop", { type: "message_stop" }),
  ].join("");
}

function jsonMessage(model: string): string {
  return JSON.stringify({
    id: "msg_probe_0001",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "PROBE_OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 3 },
  });
}

export interface PtyModelProof {
  attempted: boolean;
  ran: boolean;
  ready: boolean;
  timedOut: boolean;
  pickerShowsProbeModel: boolean;
  statusShowsSubscription: boolean;
  statusShowsApiKey: boolean;
  note: string;
}

async function main(): Promise<number> {
  const realHome = homedir();
  const realUser = userInfo().username;
  const recordedAt = "2026-07-20";
  const artifactRel = "artifacts/claude-dual-auth/probe-passthrough-2026-07-20.json";
  const artifactAbs = join(process.cwd(), artifactRel);

  const claudeBin =
    process.env.PROBE_CLAUDE_BIN ||
    join(realHome, ".local", "share", "claude", "versions", CLAUDE_VERSION);

  const secrets: string[] = [realHome, realUser];
  const limitations: string[] = [
    "Single-session, single-version (2.1.215) observation against a loopback mock gateway; not a guarantee about other Claude Code versions or future behavior.",
    "Connector state proves ELIGIBILITY only (connectors-disabled warning absent + subscription auth). No real third-party connector call was made through the token-free gateway launch; connector invocation over the passthrough is UNVERIFIED and must not be inferred from eligibility.",
  ];

  // ── native credential fingerprints (before) ────────────────────────────────
  const credBeforeRaw = readNativeCredential(realUser);
  let accessTokenFp: string | null = null;
  let credStoreBefore: RedactedHash | null = null;
  if (credBeforeRaw) {
    secrets.push(credBeforeRaw);
    credStoreBefore = redactHash(credBeforeRaw);
    try {
      const parsed = JSON.parse(credBeforeRaw) as { claudeAiOauth?: { accessToken?: string } };
      const at = parsed.claudeAiOauth?.accessToken;
      if (typeof at === "string" && at.length > 0) {
        secrets.push(at);
        accessTokenFp = fingerprint(at);
      }
    } catch {
      /* structure unknown; fingerprint of whole store still recorded */
    }
  }

  const nativeEnv = buildNativeEnv(realHome, realUser);

  // ── version + auth gate (before) ────────────────────────────────────────────
  const versionRes = timeoutSpawn(claudeBin, ["--version"], { env: nativeEnv, timeoutMs: 15_000 });
  const versionOut = (versionRes.stdout || "").trim();
  const versionMatches = versionOut.startsWith(CLAUDE_VERSION);

  const authBefore = claudeAuthStatus(claudeBin, nativeEnv);
  const authGateOk = authBefore.ok && authBefore.loggedIn && authBefore.authMethod === "claude.ai";

  // ── connector eligibility (native, read-only, redacted booleans only) ───────
  let connectors: ConnectorEligibility = {
    listRan: false,
    claudeAiConnectorsPresent: false,
    anyConnectorConnected: false,
    connectorsDisabledWarningPresent: false,
    connectorsDisabledWarningAbsent: false,
  };
  if (authGateOk) {
    const mcp = timeoutSpawn(claudeBin, ["mcp", "list"], { env: nativeEnv, timeoutMs: 60_000 });
    if (!mcp.timedOut && (mcp.stdout || mcp.stderr)) {
      connectors = parseMcpConnectors(`${mcp.stdout}\n${mcp.stderr}`);
    }
  }

  // ── gateway cache backup ────────────────────────────────────────────────────
  const cacheDir = join(realHome, ".claude", "cache");
  const cachePath = join(cacheDir, "gateway-models.json");
  const cacheRel = "~/.claude/cache/gateway-models.json";
  const cacheExisted = existsSync(cachePath);
  let cacheOrigBytes: Buffer | null = null;
  let cacheOrigMode: number | null = null;
  let cacheBefore: RedactedHash | null = null;
  if (cacheExisted) {
    cacheOrigBytes = readFileSync(cachePath);
    cacheOrigMode = statSync(cachePath).mode & 0o777;
    cacheBefore = redactHash(cacheOrigBytes);
  }

  // ── probe body (mutated across the try/finally) ─────────────────────────────
  const captures: MockCapture[] = [];
  let cacheModeVerified: string | null = null;
  let cacheModeIs0600 = false;
  let messageExit: number | null = null;
  let messageTimedOut = false;
  let probeOkSeen = false;
  let unknownModelError = false;
  let messageAttempted = false;
  let probeError: string | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let ptyProof: PtyModelProof = {
    attempted: false,
    ran: false,
    ready: false,
    timedOut: false,
    pickerShowsProbeModel: false,
    statusShowsSubscription: false,
    statusShowsApiKey: false,
    note: "not executed — no safe /model PTY proof is constructible on this machine: a sandbox HOME isolates mutable state but strips the unscoped native subscription (empirically loggedIn=false), and the only native-auth-preserving configuration writes into the shared, concurrently-written Claude state file (~/.claude.json / ~/.claude/.claude.json), which the P0 restore contract forbids clobbering.",
  };

  const now = Date.now();
  try {
    // refuse to run unless the current default profile is a logged-in claude.ai subscription
    if (!authGateOk) {
      throw new Error("auth-precondition-not-met: refuse to run (requires loggedIn && authMethod=claude.ai)");
    }
    // write the probe cache with the EXACT target schema, mode 0600
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const probeCache = buildProbeCache("http://127.0.0.1:0", now); // baseUrl patched after server start
    writeFileSync(cachePath, serializeProbeCache(probeCache), { mode: 0o600 });
    chmodSync(cachePath, 0o600);
    const mode = statSync(cachePath).mode & 0o777;
    cacheModeIs0600 = mode === 0o600;
    cacheModeVerified = `0${mode.toString(8)}`;

    // start loopback-only mock gateway on an ephemeral port
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        let bodyText = "";
        if (request.method !== "GET") {
          try {
            bodyText = await request.text();
          } catch {
            bodyText = "";
          }
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of request.headers.entries()) headers[k] = v;
        captures.push(analyzeRequest(request.method, url.pathname, headers, bodyText));

        // models discovery
        if (url.pathname === "/v1/models") {
          return new Response(
            JSON.stringify({
              data: [{ id: PROBE_MODEL_ID, type: "model", display_name: PROBE_MODEL_DISPLAY }],
              has_more: false,
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.pathname === "/v1/messages/count_tokens") {
          return new Response(JSON.stringify({ input_tokens: 7 }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/v1/messages") {
          let model = PROBE_MODEL_ID;
          let stream = true;
          try {
            const parsed = bodyText ? (JSON.parse(bodyText) as { model?: unknown; stream?: unknown }) : {};
            if (typeof parsed.model === "string") model = parsed.model;
            if (parsed.stream === false) stream = false;
          } catch {
            /* keep defaults */
          }
          if (stream) {
            return new Response(sseMessage(model), {
              headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
            });
          }
          return new Response(jsonMessage(model), { headers: { "content-type": "application/json" } });
        }
        // any other path: benign JSON 200 (kept minimal; still captured above)
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    });

    const mockUrl = `http://127.0.0.1:${server.port}`;
    // rewrite the cache baseUrl to the real ephemeral URL (still exact schema, 0600)
    writeFileSync(cachePath, serializeProbeCache(buildProbeCache(mockUrl, now)), { mode: 0o600 });
    chmodSync(cachePath, 0o600);

    const tokenFreeEnv = buildTokenFreeEnv(realHome, realUser, mockUrl);
    const cwd = tmpdir();

    // non-interactive message exercising the cache alias under token-free auth
    messageAttempted = true;
    const msg = await spawnAsync(
      claudeBin,
      [
        "-p",
        "--model",
        PROBE_MODEL_ID,
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format",
        "text",
        "Reply with exactly the token PROBE_OK and nothing else.",
      ],
      { env: tokenFreeEnv, cwd, timeoutMs: 90_000 },
    );
    messageExit = msg.status;
    messageTimedOut = msg.timedOut;
    const combined = `${msg.stdout}\n${msg.stderr}`;
    probeOkSeen = /PROBE_OK/.test(msg.stdout);
    unknownModelError = /unknown model|model not found|invalid model|not a valid model|no such model/i.test(combined);

    // The real interactive /model picker proof is intentionally NOT executed:
    // no safe PTY is constructible here (a sandbox HOME that would isolate the
    // TUI's mutable state strips the unscoped native subscription; the only
    // native-auth-preserving config writes into the shared, concurrently-written
    // Claude state file, which the P0 restore contract forbids clobbering). The
    // picker-visibility gate therefore fails and the verdict is FAIL, per contract.
  } catch (e) {
    probeError = e instanceof Error ? e.message : String(e);
  } finally {
    // stop mock (best-effort)
    try {
      if (server) await server.stop(true);
    } catch {
      /* ignore */
    }
    // restore gateway cache byte-for-byte + mode, or delete if it did not exist
    try {
      if (cacheExisted && cacheOrigBytes && cacheOrigMode !== null) {
        writeFileSync(cachePath, cacheOrigBytes);
        chmodSync(cachePath, cacheOrigMode);
      } else if (!cacheExisted && existsSync(cachePath)) {
        unlinkSync(cachePath);
      }
    } catch (e) {
      probeError = `${probeError ? probeError + "; " : ""}restore-failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── restoration verification ────────────────────────────────────────────────
  let cacheAfter: RedactedHash | null = null;
  let cacheModeAfter: number | null = null;
  let restoreBytesEqual = false;
  let restoreModeEqual = false;
  let cacheDeletedOk = false;
  if (cacheExisted) {
    if (existsSync(cachePath)) {
      const afterBytes = readFileSync(cachePath);
      cacheAfter = redactHash(afterBytes);
      cacheModeAfter = statSync(cachePath).mode & 0o777;
      restoreBytesEqual = cacheOrigBytes !== null && fullHash(afterBytes) === fullHash(cacheOrigBytes);
      restoreModeEqual = cacheModeAfter === cacheOrigMode;
    }
  } else {
    cacheDeletedOk = !existsSync(cachePath);
  }
  const restored = cacheExisted ? restoreBytesEqual && restoreModeEqual : cacheDeletedOk;

  // ── native credential integrity + auth gate (after) ────────────────────────
  const credAfterRaw = readNativeCredential(realUser);
  let credStoreAfter: RedactedHash | null = null;
  let credStoreEqual = false;
  if (credAfterRaw) {
    if (!secrets.includes(credAfterRaw)) secrets.push(credAfterRaw);
    credStoreAfter = redactHash(credAfterRaw);
    credStoreEqual = credBeforeRaw !== null && fullHash(credAfterRaw) === fullHash(credBeforeRaw);
  }
  const authAfter = claudeAuthStatus(claudeBin, nativeEnv);
  const authAfterOk = authAfter.ok && authAfter.loggedIn && authAfter.authMethod === "claude.ai";

  // ── derive message-request facts ────────────────────────────────────────────
  const messageReqs = captures.filter((c) => c.method === "POST" && c.path === "/v1/messages");
  const primaryMsg = messageReqs[0] ?? null;
  const anyXApiKey = captures.some((c) => c.xApiKeyPresent);
  const anySentinel = captures.some((c) => c.sentinelPresent);
  const bearerReqs = captures.filter((c) => c.authScheme === "bearer" && c.bearerFingerprint);
  const bearerFps = Array.from(new Set(bearerReqs.map((c) => c.bearerFingerprint)));
  const bearerMatchesNative =
    accessTokenFp !== null && bearerReqs.length > 0 && bearerReqs.every((c) => c.bearerFingerprint === accessTokenFp);
  const modelsDiscoveryHit = captures.some((c) => c.method === "GET" && c.path === "/v1/models");
  const oauthCapabilityPresent =
    (primaryMsg?.anthropicBetaHasOAuth ?? false) || (primaryMsg?.authScheme === "bearer" && bearerMatchesNative);

  // ── gates ───────────────────────────────────────────────────────────────────
  const gates: Gate[] = [
    { id: "auth-precondition", pass: authGateOk, detail: "before: loggedIn && authMethod=claude.ai" },
    { id: "claude-version", pass: versionMatches, detail: `expected ${CLAUDE_VERSION}` },
    { id: "message-reached-mock", pass: !!primaryMsg, detail: "POST /v1/messages observed on loopback mock" },
    { id: "message-completed", pass: messageExit === 0 && !messageTimedOut && probeOkSeen, detail: "exit 0, no timeout, PROBE_OK returned" },
    { id: "model-accepted", pass: !!primaryMsg && primaryMsg.modelInBody === PROBE_MODEL_ID && !unknownModelError, detail: "cache-alias model accepted in request body, no unknown-model error" },
    { id: "model-visible-in-picker-pty", pass: ptyProof.attempted && ptyProof.ran && ptyProof.ready && ptyProof.pickerShowsProbeModel, detail: "REQUIRED: real /model picker proof rendered the probe model. Not obtained — no safe PTY constructible without stripping the native subscription or clobbering shared Claude state. Non-interactive `-p --model` acceptance is insufficient alone." },
    { id: "auth-scheme-bearer", pass: primaryMsg?.authScheme === "bearer", detail: "Authorization: Bearer on /v1/messages" },
    { id: "bearer-matches-native-subscription", pass: bearerMatchesNative, detail: "bearer sha256[:8]:len == native accessToken fingerprint (unchanged)" },
    { id: "no-x-api-key", pass: !anyXApiKey, detail: "no x-api-key header on any request" },
    { id: "no-sentinel", pass: !anySentinel, detail: `sentinel '${SENTINEL}' never present` },
    { id: "anthropic-oauth-capability", pass: oauthCapabilityPresent, detail: "anthropic-beta oauth marker and/or native bearer scheme present" },
    { id: "anthropic-version-header", pass: primaryMsg?.anthropicVersionPresent ?? false, detail: "anthropic-version header present" },
    { id: "cache-mode-0600", pass: cacheModeIs0600, detail: "probe cache final mode verified 0600 during probe" },
    { id: "connectors-disabled-warning-absent", pass: connectors.listRan && connectors.connectorsDisabledWarningAbsent, detail: "eligibility: connectors-disabled warning absent (not a live connector call)" },
    { id: "subscription-active-after", pass: authAfterOk, detail: "after: loggedIn && authMethod=claude.ai" },
    { id: "native-store-unchanged", pass: credStoreEqual, detail: "native Keychain credential sha256/len equal before/after" },
    { id: "restoration-succeeded", pass: restored, detail: cacheExisted ? "gateway cache restored byte-for-byte + mode" : "probe cache deleted (cache did not exist)" },
    { id: "no-probe-error", pass: probeError === null, detail: "no probe/restore error" },
  ];
  const verdict = computeVerdict(gates);
  if (!(ptyProof.attempted && ptyProof.ran && ptyProof.ready && ptyProof.pickerShowsProbeModel)) {
    limitations.push(
      "Required real /model picker proof was NOT obtained. A safe interactive PTY is not constructible on this machine: a sandbox HOME isolates the TUI's mutable state but strips the unscoped native subscription (verified loggedIn=false), while the only native-auth-preserving configuration mutates the shared, concurrently-written Claude state file that the P0 restore contract forbids clobbering. Per the P0 contract, non-interactive `-p --model` acceptance is a limitation only, so the picker-visibility gate fails and the verdict is FAIL.",
    );
  } else {
    limitations.push(
      "Probe-model picker visibility was confirmed via the expect PTY, but the real interactive experience beyond /status + /model was not exercised.",
    );
  }

  // ── artifact (redacted) ────────────────────────────────────────────────────
  const artifact = {
    schemaVersion: 1,
    kind: "claude-passthrough-probe",
    phase: "P0",
    recordedAt,
    verdict,
    consent: {
      networkSubscriptionAuthAllowed: true,
      currentDefaultProfileProbeConsented: true,
      source: "P0 approved live probe — explicit user consent for a controlled probe against the current logged-in default Claude profile with before/after integrity and unconditional restoration",
      tokensStored: false,
    },
    environment: {
      claudeCodeVersion: versionMatches ? CLAUDE_VERSION : sanitize(versionOut, secrets),
      claudeExecutableResolved: existsSync(claudeBin),
      loggedInBefore: authBefore.loggedIn,
      loggedInAfter: authAfter.loggedIn,
      authMethodBefore: authBefore.authMethod,
      authMethodAfter: authAfter.authMethod,
      subscriptionType: authBefore.subscriptionType,
      gateway: "local loopback mock only (127.0.0.1, ephemeral port)",
      tokenFreeLaunch: {
        set: ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1"],
        removed: [...FORBIDDEN_AUTH_ENV],
        inheritedAuthEnv: "none (env built from allowlist; ANTHROPIC_*/CLAUDE* not inherited)",
      },
    },
    cacheSchema: {
      shape: CACHE_SCHEMA,
      probeModelId: PROBE_MODEL_ID,
      probeModelDisplayName: PROBE_MODEL_DISPLAY,
      finalModeOctal: "0600",
      modeVerifiedDuringProbe: cacheModeVerified,
      path: cacheRel,
      note: "P1's final gateway-cache writer must emit this exact byte shape at mode 0600.",
    },
    message: {
      attempted: messageAttempted,
      requestReachedMock: !!primaryMsg,
      method: primaryMsg?.method ?? null,
      path: primaryMsg?.path ?? null,
      authScheme: primaryMsg?.authScheme ?? null,
      bearerFingerprint: primaryMsg?.bearerFingerprint ?? null,
      nativeAccessTokenFingerprint: accessTokenFp,
      bearerMatchesNativeSubscription: bearerMatchesNative,
      distinctBearerFingerprints: bearerFps,
      xApiKeyPresentAnyRequest: anyXApiKey,
      sentinelPresentAnyRequest: anySentinel,
      anthropicVersionHeaderPresent: primaryMsg?.anthropicVersionPresent ?? false,
      anthropicBetaTokens: primaryMsg?.anthropicBetaTokens ?? [],
      anthropicBetaHasOAuth: primaryMsg?.anthropicBetaHasOAuth ?? false,
      oauthCapabilityPresent,
      modelRequested: primaryMsg?.modelInBody ?? null,
      modelAccepted: !!primaryMsg && primaryMsg.modelInBody === PROBE_MODEL_ID && !unknownModelError,
      unknownModelError,
      probeOkReturned: probeOkSeen,
      exitCode: messageExit,
      timedOut: messageTimedOut,
    },
    ptyModelProof: {
      required: true,
      executed: ptyProof.attempted,
      method: "not executed — a safe interactive /model PTY proof is not constructible on this machine (sandbox HOME strips the native subscription; native-auth-preserving config mutates shared, concurrently-written Claude state that the P0 restore contract forbids clobbering)",
      reachedReadyState: ptyProof.ready,
      pickerShowedProbeModel: ptyProof.pickerShowsProbeModel,
      statusShowedSubscription: ptyProof.statusShowsSubscription,
      note: ptyProof.note,
    },
    modelDiscovery: {
      gatewayV1ModelsRequested: modelsDiscoveryHit,
      probeModelServedByMock: true,
    },
    connectorEligibility: {
      method: "read-only `claude mcp list` (native env); redacted booleans only",
      listRan: connectors.listRan,
      claudeAiConnectorsPresent: connectors.claudeAiConnectorsPresent,
      anyConnectorConnected: connectors.anyConnectorConnected,
      connectorsDisabledWarningPresent: connectors.connectorsDisabledWarningPresent,
      connectorsDisabledWarningAbsent: connectors.connectorsDisabledWarningAbsent,
      realThirdPartyConnectorCallVerified: false,
    },
    credentialStoreIntegrity: {
      beforeAfterEqual: credStoreEqual,
      store: {
        service: NATIVE_KEYCHAIN_SERVICE,
        status: credStoreBefore ? "present" : "absent",
        sha256_8Before: credStoreBefore?.sha256_8 ?? null,
        lengthBefore: credStoreBefore?.length ?? null,
        sha256_8After: credStoreAfter?.sha256_8 ?? null,
        lengthAfter: credStoreAfter?.length ?? null,
      },
      gatewayCache: {
        path: cacheRel,
        existedBefore: cacheExisted,
        sha256_8Before: cacheBefore?.sha256_8 ?? null,
        lengthBefore: cacheBefore?.length ?? null,
        modeBefore: cacheOrigMode !== null ? `0${cacheOrigMode.toString(8)}` : null,
        sha256_8After: cacheAfter?.sha256_8 ?? null,
        lengthAfter: cacheAfter?.length ?? null,
        modeAfter: cacheModeAfter !== null ? `0${cacheModeAfter.toString(8)}` : null,
      },
    },
    restoration: {
      gatewayCacheRestored: restored,
      restoreBytesEqual: cacheExisted ? restoreBytesEqual : null,
      restoreModeEqual: cacheExisted ? restoreModeEqual : null,
      cacheDeletedWhenAbsent: cacheExisted ? null : cacheDeletedOk,
      settingsJsonTouched: false,
      nativeCredentialsTouched: false,
      method: "try/finally: stop mock, restore gateway cache byte-for-byte + mode (or delete if absent)",
    },
    redaction: {
      fingerprintOnly: true,
      rawAccessTokenStored: false,
      rawRefreshTokenStored: false,
      emailStored: false,
      orgStored: false,
      absoluteHomePathStored: false,
      leakScanApplied: true,
    },
    gates: gates.map((g) => ({ id: g.id, pass: g.pass, detail: g.detail })),
    limitations,
    decision: {
      verdict,
      reason:
        verdict === "PASS"
          ? "Real Claude 2.1.215, launched token-free, reached the loopback gateway carrying the native subscription OAuth bearer UNCHANGED (fingerprint match), with no x-api-key/sentinel, accepted the exact-schema cache alias, kept subscription auth (claude.ai) intact before/after, connector eligibility held (disabled-warning absent), and all touched state was restored."
          : "One or more required gates failed or evidence was partial/ambiguous; see `gates`. Per the fail-closed contract this is FAIL. State restoration still ran unconditionally.",
      failedGates: gates.filter((g) => !g.pass).map((g) => g.id),
    },
  };

  const jsonString = `${JSON.stringify(artifact, null, 2)}\n`;
  assertNoLeak(jsonString, secrets);
  mkdirSync(join(process.cwd(), "artifacts", "claude-dual-auth"), { recursive: true });
  writeFileSync(artifactAbs, jsonString);

  // console summary (redacted)
  console.log(`verdict: ${verdict}`);
  console.log(`artifact: ${artifactRel}`);
  console.log(`restored: ${restored}`);
  if (verdict === "FAIL") {
    console.log(`failed gates: ${artifact.decision.failedGates.join(", ") || "(none — see partial evidence)"}`);
  }

  // exit nonzero on FAIL ONLY after restoration + artifact write
  return verdict === "PASS" ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`probe fatal: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    });
}
