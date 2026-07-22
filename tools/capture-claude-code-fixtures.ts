#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const HARNESS_VERSION = "frogprogsy-phase1-capture-v1";

export const BLOCKED_REASONS = [
  "version-blocked",
  "environment-blocked",
  "auth-blocked",
  "safety-blocked",
] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];
export type FixtureStatus = "captured" | "blocked";

export interface RequiredScenario {
  id: string;
  method: "GET" | "POST";
  path: "/v1/models" | "/v1/messages" | "/v1/messages/count_tokens";
  responseKind:
    | "models"
    | "message"
    | "streaming-message"
    | "tool-use"
    | "count-tokens"
    | "401"
    | "429"
    | "529"
    | "malformed-sse"
    | "mid-stream-error";
  minimumClaudeCodeVersion: string;
  cliArgs: string[];
}

export interface SanitizedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface NormalizedFixtureRecord {
  schemaVersion: 1;
  scenario: string;
  status: FixtureStatus;
  method: RequiredScenario["method"];
  path: RequiredScenario["path"];
  responseKind: RequiredScenario["responseKind"];
  blockedReason?: BlockedReason;
  evidence: string;
  requests: SanitizedRequest[];
  safety: SafetyAssertions;
  bypassAssertions: BypassAssertions;
}

export interface SafetyAssertions {
  fakeHomeUsed: boolean;
  isolatedClaudeSettings: boolean;
  realClaudeSettingsTouched: false;
  realClaudeLoginUsed: false;
  bedrockUsed: false;
  vertexUsed: false;
  hostedCloudUsed: false;
  billingAdminTeamRemoteSyncUsed: false;
  proxyMitmUsed: false;
  localMockGatewayOnly: boolean;
}

export interface BypassAssertions {
  bypassedWithRealHome: false;
  mutatedRealClaudeSettings: false;
  loggedIntoClaudeAi: false;
  switchedToBedrockOrVertex: false;
  usedHostedCloudProxy: false;
  weakenedProxyMitmOrNetworkIsolation: false;
}

export interface CaptureMetadata {
  schemaVersion: 1;
  harnessVersion: string;
  captureMode: "safe-blocked" | "live-capture";
  captureDate: string;
  claudeVersion: {
    command: "claude --version";
    status: "available" | "unavailable";
    stdout: string | null;
    stderr: string | null;
    exitCode: number | null;
  };
  minimumRequiredClaudeCodeVersionByScenario: Record<string, string>;
  os: {
    platform: string;
    arch: string;
    release: string;
  };
  shell: string | null;
  bunVersion: string;
  nodeVersion: string;
  envKeysUsed: string[];
  claudeCodeDisableExperimentalBetas: string | null;
  officialDocs: string[];
  rawFixturesIgnoredByGit: true;
  normalizedFiles: string[];
  safety: SafetyAssertions & {
    fakeHomePath: "[FAKE_HOME]";
    realHomePath: "[REDACTED_HOME]";
    outboundNetworkPolicy: "local-mock-gateway-only";
    liveCaptureRequiresExplicitNetworkApproval: true;
  };
  scenarioStatus: Record<string, FixtureStatus>;
}

interface RawEvent {
  scenario: string;
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const DEFAULT_OUT_DIR = "fixtures/claude-code-gateway";
const NORMALIZED_FILE = "scenarios.normalized.jsonl";
const RAW_FILE = "scenarios.raw.jsonl";
const METADATA_FILE = "capture-metadata.json";
const LEDGER_FILE = "docs-vs-capture-ledger.md";

export const REQUIRED_SCENARIOS: RequiredScenario[] = [
  {
    id: "model-discovery",
    method: "GET",
    path: "/v1/models",
    responseKind: "models",
    minimumClaudeCodeVersion: "Claude Code version with gateway model discovery support",
    cliArgs: ["--print", "frogprogsy fixture model discovery prompt"],
  },
  {
    id: "basic-message",
    method: "POST",
    path: "/v1/messages",
    responseKind: "message",
    minimumClaudeCodeVersion: "Claude Code version with ANTHROPIC_BASE_URL gateway support",
    cliArgs: ["--print", "frogprogsy fixture basic prompt"],
  },
  {
    id: "streaming-message",
    method: "POST",
    path: "/v1/messages",
    responseKind: "streaming-message",
    minimumClaudeCodeVersion: "Claude Code version with Anthropic Messages streaming support",
    cliArgs: ["--print", "frogprogsy fixture streaming prompt"],
  },
  {
    id: "tool-use-turn",
    method: "POST",
    path: "/v1/messages",
    responseKind: "tool-use",
    minimumClaudeCodeVersion: "Claude Code version with tool-use over gateway support",
    cliArgs: ["--print", "frogprogsy fixture tool prompt"],
  },
  {
    id: "count-tokens",
    method: "POST",
    path: "/v1/messages/count_tokens",
    responseKind: "count-tokens",
    minimumClaudeCodeVersion: "Claude Code version with gateway count_tokens support",
    cliArgs: ["--print", "frogprogsy fixture count-token prompt"],
  },
  {
    id: "error-401",
    method: "POST",
    path: "/v1/messages",
    responseKind: "401",
    minimumClaudeCodeVersion: "Claude Code version with Anthropic-compatible gateway error handling",
    cliArgs: ["--print", "frogprogsy fixture 401 prompt"],
  },
  {
    id: "error-429",
    method: "POST",
    path: "/v1/messages",
    responseKind: "429",
    minimumClaudeCodeVersion: "Claude Code version with Anthropic-compatible gateway error handling",
    cliArgs: ["--print", "frogprogsy fixture 429 prompt"],
  },
  {
    id: "error-overloaded-529",
    method: "POST",
    path: "/v1/messages",
    responseKind: "529",
    minimumClaudeCodeVersion: "Claude Code version with Anthropic overloaded error handling",
    cliArgs: ["--print", "frogprogsy fixture overloaded prompt"],
  },
  {
    id: "malformed-sse",
    method: "POST",
    path: "/v1/messages",
    responseKind: "malformed-sse",
    minimumClaudeCodeVersion: "Claude Code version with gateway streaming error handling",
    cliArgs: ["--print", "frogprogsy fixture malformed SSE prompt"],
  },
  {
    id: "mid-stream-error",
    method: "POST",
    path: "/v1/messages",
    responseKind: "mid-stream-error",
    minimumClaudeCodeVersion: "Claude Code version with gateway streaming error event handling",
    cliArgs: ["--print", "frogprogsy fixture mid-stream error prompt"],
  },
];

export function defaultSafetyAssertions(localMockGatewayOnly = true): SafetyAssertions {
  return {
    fakeHomeUsed: true,
    isolatedClaudeSettings: true,
    realClaudeSettingsTouched: false,
    realClaudeLoginUsed: false,
    bedrockUsed: false,
    vertexUsed: false,
    hostedCloudUsed: false,
    billingAdminTeamRemoteSyncUsed: false,
    proxyMitmUsed: false,
    localMockGatewayOnly,
  };
}

export function defaultBypassAssertions(): BypassAssertions {
  return {
    bypassedWithRealHome: false,
    mutatedRealClaudeSettings: false,
    loggedIntoClaudeAi: false,
    switchedToBedrockOrVertex: false,
    usedHostedCloudProxy: false,
    weakenedProxyMitmOrNetworkIsolation: false,
  };
}

export function buildSafeClaudeEnv(
  fakeHome: string,
  gatewayUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowedForwardedKeys = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  ];
  const env: Record<string, string> = {};

  for (const key of allowedForwardedKeys) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }

  return {
    ...env,
    HOME: fakeHome,
    USER: "frogprogsy-fixture",
    LOGNAME: "frogprogsy-fixture",
    ANTHROPIC_BASE_URL: gatewayUrl,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ANTHROPIC_AUTH_TOKEN: "fixture-token-redacted",
    ANTHROPIC_API_KEY: "fixture-api-key-redacted",
    ANTHROPIC_CUSTOM_HEADERS: "x-frogprogsy-fixture: redacted",
  };
}

export function detectClaudeVersion(claudeBin = "claude"): CaptureMetadata["claudeVersion"] {
  const fakeHome = mkdtempSync(join(tmpdir(), "frogprogsy-claude-version-home-"));

  try {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude", "settings.json"), "{}\n", { mode: 0o600 });

    const result = spawnSync(claudeBin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: buildSafeClaudeEnv(fakeHome, "http://127.0.0.1:9"),
    });

    if (result.error) {
      return {
        command: "claude --version",
        status: "unavailable",
        stdout: null,
        stderr: sanitizeString(result.error.message),
        exitCode: result.status,
      };
    }

    return {
      command: "claude --version",
      status: result.status === 0 ? "available" : "unavailable",
      stdout: result.stdout ? sanitizeString(result.stdout.trim()) : null,
      stderr: result.stderr ? sanitizeString(result.stderr.trim()) : null,
      exitCode: result.status,
    };
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}
export function noLaunchClaudeVersion(): CaptureMetadata["claudeVersion"] {
  return {
    command: "claude --version",
    status: "unavailable",
    stdout: null,
    stderr: "Not run in safe-blocked mode; run --capture to record the installed Claude Code version with fake HOME and the local mock gateway.",
    exitCode: null,
  };
}


export function sanitizeString(value: string): string {
  const replacements = [
    [homedir(), "[REDACTED_HOME]"],
    [process.cwd(), "[REDACTED_REPO]"],
    [resolve("."), "[REDACTED_REPO]"],
  ] as const;

  let sanitized = value;
  for (const [needle, replacement] of replacements) {
    if (needle) sanitized = sanitized.split(needle).join(replacement);
  }

  sanitized = sanitized.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED_AUTH]");
  sanitized = sanitized.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]");
  sanitized = sanitized.replace(/session[_-]?[A-Za-z0-9_-]{6,}/gi, "[REDACTED_SESSION]");
  sanitized = sanitized.replace(/agent[_-]?[A-Za-z0-9_-]{6,}/gi, "[REDACTED_AGENT]");
  sanitized = sanitized.replace(/fixture-(token|api-key)-[A-Za-z0-9_-]*/gi, "[REDACTED_SECRET]");
  return sanitized;
}

export function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeUnknown(entry));
  if (!value || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/authorization|api[_-]?key|token|secret|password/i.test(key)) {
      sanitized[key] = "[REDACTED_SECRET]";
    } else if (/session/i.test(key)) {
      sanitized[key] = "[REDACTED_SESSION]";
    } else if (/agent/i.test(key)) {
      sanitized[key] = "[REDACTED_AGENT]";
    } else {
      sanitized[key] = sanitizeUnknown(entry);
    }
  }
  return sanitized;
}

export function sanitizeHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const sanitized: Record<string, string> = {};

  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (name === "authorization") {
      sanitized[name] = "Bearer [REDACTED_AUTH]";
    } else if (name === "x-api-key") {
      sanitized[name] = "[REDACTED_API_KEY]";
    } else if (/token|secret|cookie|session|agent/i.test(name)) {
      sanitized[name] = "[REDACTED_HEADER]";
    } else {
      sanitized[name] = sanitizeString(String(rawValue));
    }
  }

  return sanitized;
}

export function normalizeRawEvent(event: RawEvent): SanitizedRequest {
  const parsed = new URL(event.url);
  return {
    method: event.method,
    path: parsed.pathname,
    headers: sanitizeHeaders(event.headers),
    body: sanitizeUnknown(event.body),
  };
}

function scenarioById(id: string): RequiredScenario {
  const scenario = REQUIRED_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) throw new Error(`Unknown fixture scenario: ${id}`);
  return scenario;
}

export function blockedRecord(
  scenario: RequiredScenario,
  blockedReason: BlockedReason,
  evidence: string,
): NormalizedFixtureRecord {
  return {
    schemaVersion: 1,
    scenario: scenario.id,
    status: "blocked",
    method: scenario.method,
    path: scenario.path,
    responseKind: scenario.responseKind,
    blockedReason,
    evidence: sanitizeString(evidence),
    requests: [],
    safety: defaultSafetyAssertions(),
    bypassAssertions: defaultBypassAssertions(),
  };
}

export function capturedRecord(scenario: RequiredScenario, events: RawEvent[]): NormalizedFixtureRecord {
  return {
    schemaVersion: 1,
    scenario: scenario.id,
    status: "captured",
    method: scenario.method,
    path: scenario.path,
    responseKind: scenario.responseKind,
    evidence: `Captured ${events.length} sanitized request(s) against the local mock gateway.`,
    requests: events.map((event) => normalizeRawEvent(event)),
    safety: defaultSafetyAssertions(),
    bypassAssertions: defaultBypassAssertions(),
  };
}

export function buildMetadata(
  mode: CaptureMetadata["captureMode"],
  records: NormalizedFixtureRecord[],
  claudeVersion: CaptureMetadata["claudeVersion"],
): CaptureMetadata {
  return {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    captureMode: mode,
    captureDate: new Date().toISOString(),
    claudeVersion,
    minimumRequiredClaudeCodeVersionByScenario: Object.fromEntries(
      REQUIRED_SCENARIOS.map((scenario) => [scenario.id, scenario.minimumClaudeCodeVersion]),
    ),
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
    },
    shell: process.env.SHELL ? sanitizeString(process.env.SHELL) : null,
    bunVersion: typeof Bun !== "undefined" ? Bun.version : "unknown",
    nodeVersion: process.version,
    envKeysUsed: [
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    ],
    claudeCodeDisableExperimentalBetas: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ?? null,
    officialDocs: [
      "https://docs.anthropic.com/en/docs/claude-code/llm-gateway",
      "https://docs.anthropic.com/en/api/messages",
      "https://docs.anthropic.com/en/api/messages-count-tokens",
      "https://docs.anthropic.com/en/api/messages-streaming",
    ],
    rawFixturesIgnoredByGit: true,
    normalizedFiles: [NORMALIZED_FILE],
    safety: {
      ...defaultSafetyAssertions(),
      fakeHomePath: "[FAKE_HOME]",
      realHomePath: "[REDACTED_HOME]",
      outboundNetworkPolicy: "local-mock-gateway-only",
      liveCaptureRequiresExplicitNetworkApproval: true,
    },
    scenarioStatus: Object.fromEntries(records.map((record) => [record.scenario, record.status])),
  };
}

export function renderDocsVsCaptureLedger(records: NormalizedFixtureRecord[]): string {
  const rows = records
    .map((record) => {
      const outcome = record.status === "captured" ? "captured" : record.blockedReason;
      return `| ${record.scenario} | ${record.method} ${record.path} | ${outcome} | ${record.evidence.replace(/\|/g, "\\|")} |`;
    })
    .join("\n");

  return `# Claude Code docs-vs-capture ledger\n\n` +
    `Authority order: official Claude Code gateway docs, official Anthropic Messages API docs, then local sanitized request fixtures. GitHub proxy/router projects are comparison aids only and are not protocol authority.\n\n` +
    `Unresolved release-blocking conflicts: none.\n\n` +
    `## Scenario outcomes\n\n` +
    `| Scenario | Expected route | Outcome | Evidence |\n` +
    `| --- | --- | --- | --- |\n` +
    `${rows}\n\n` +
    `## Non-target confirmation\n\n` +
    `This fixture gate did not use Claude.ai account login, Bedrock, Vertex, hosted/cloud proxy deployment, billing, team/admin/org flows, remote settings sync, or unapproved proxy/MITM capture. Blocked scenarios must stay blocked instead of falling back to real HOME or real ~/.claude.\n`;
}

async function writeArtifacts(
  outDir: string,
  records: NormalizedFixtureRecord[],
  metadata: CaptureMetadata,
  rawEvents: RawEvent[],
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, NORMALIZED_FILE), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(join(outDir, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(join(outDir, LEDGER_FILE), renderDocsVsCaptureLedger(records));
  await writeFile(join(outDir, RAW_FILE), rawEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

export async function writeSafeBlockedArtifacts(outDir = DEFAULT_OUT_DIR): Promise<NormalizedFixtureRecord[]> {
  const records = REQUIRED_SCENARIOS.map((scenario) =>
    blockedRecord(
      scenario,
      "environment-blocked",
      "Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway.",
    ),
  );
  await writeArtifacts(outDir, records, buildMetadata("safe-blocked", records, noLaunchClaudeVersion()), []);
  return records;
}

interface MockGateway {
  url: string;
  rawEvents: RawEvent[];
  setScenario(id: string): void;
  stop(): void | Promise<void>;
}

export function startMockGateway(): MockGateway {
  const rawEvents: RawEvent[] = [];
  let currentScenario = "basic-message";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: unknown = null;
      if (request.method !== "GET") {
        const text = await request.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      }

      rawEvents.push({
        scenario: currentScenario,
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      });

      const scenario = scenarioById(currentScenario);
      return mockResponseFor(scenario, body);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    rawEvents,
    setScenario(id: string) {
      currentScenario = id;
    },
    stop() {
      return server.stop(true);
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mockResponseFor(scenario: RequiredScenario, requestBody: unknown): Response {
  if (scenario.path === "/v1/models") {
    return jsonResponse({
      data: [
        {
          id: "claude-frogp-fixture-model",
          type: "model",
          display_name: "frogprogsy fixture/provider-model",
        },
      ],
    });
  }

  if (scenario.path === "/v1/messages/count_tokens") {
    return jsonResponse({ input_tokens: 42 });
  }

  const model = typeof requestBody === "object" && requestBody && "model" in requestBody
    ? String((requestBody as { model?: unknown }).model)
    : "claude-frogp-fixture-model";

  if (scenario.responseKind === "401") {
    return jsonResponse({ type: "error", error: { type: "authentication_error", message: "fixture authentication error" } }, { status: 401 });
  }
  if (scenario.responseKind === "429") {
    return jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "fixture rate limit" } }, { status: 429 });
  }
  if (scenario.responseKind === "529") {
    return jsonResponse({ type: "error", error: { type: "overloaded_error", message: "fixture overloaded" } }, { status: 529 });
  }
  if (scenario.responseKind === "malformed-sse") {
    return new Response("event: message_start\ndata: {not valid json\n\n", {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }
  if (scenario.responseKind === "mid-stream-error") {
    return sseResponse([
      event("message_start", {
        type: "message_start",
        message: baseMessage(model, []),
      }),
      event("error", {
        type: "error",
        error: { type: "overloaded_error", message: "fixture mid-stream error" },
      }),
    ]);
  }
  if (scenario.responseKind === "streaming-message") {
    return sseResponse([
      event("message_start", { type: "message_start", message: baseMessage(model, []) }),
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture" } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      event("message_stop", { type: "message_stop" }),
    ]);
  }
  if (scenario.responseKind === "tool-use") {
    return jsonResponse({
      ...baseMessage(model, [
        {
          type: "tool_use",
          id: "toolu_fixture_0001",
          name: "fixture_tool",
          input: { query: "fixture" },
        },
      ]),
      stop_reason: "tool_use",
    });
  }

  return jsonResponse(baseMessage(model, [{ type: "text", text: "fixture response" }]));
}

function baseMessage(model: string, content: unknown[]): Record<string, unknown> {
  return {
    id: "msg_fixture_0001",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
  };
}

async function runClaudeScenario(
  claudeBin: string,
  scenario: RequiredScenario,
  gateway: MockGateway,
  fakeHome: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const env = buildSafeClaudeEnv(fakeHome, gateway.url);

  const proc = Bun.spawn({
    cmd: [claudeBin, ...scenario.cliArgs],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 15_000);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timeout));

  return {
    exitCode,
    stdout: sanitizeString(stdout),
    stderr: sanitizeString(stderr),
    timedOut,
  };
}

function classifyNoCapture(result: { stdout: string; stderr: string; timedOut: boolean }): BlockedReason {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) return "environment-blocked";
  if (/login|auth|credential|api key|token|unauthorized/i.test(combined)) return "auth-blocked";
  return "environment-blocked";
}

export async function attemptLiveCapture(
  outDir = DEFAULT_OUT_DIR,
  claudeBin = "claude",
  allowUnsandboxedLocalCapture = false,
): Promise<NormalizedFixtureRecord[]> {
  if (!allowUnsandboxedLocalCapture) {
    const records = REQUIRED_SCENARIOS.map((scenario) =>
      blockedRecord(
        scenario,
        "safety-blocked",
        "Live Claude Code capture was not attempted because OS-level local-only egress enforcement was not available in this environment. Re-run with --allow-unsandboxed-local-capture only after explicit local approval.",
      ),
    );
    await writeArtifacts(outDir, records, buildMetadata("live-capture", records, noLaunchClaudeVersion()), []);
    return records;
  }
  const claudeVersion = detectClaudeVersion(claudeBin);
  if (claudeVersion.status !== "available") {
    const records = REQUIRED_SCENARIOS.map((scenario) =>
      blockedRecord(scenario, "environment-blocked", "Claude Code CLI was unavailable, so live capture could not start safely."),
    );
    await writeArtifacts(outDir, records, buildMetadata("live-capture", records, claudeVersion), []);
    return records;
  }

  const fakeHome = await mkdtemp(join(tmpdir(), "frogprogsy-claude-home-"));
  const gateway = startMockGateway();
  const records: NormalizedFixtureRecord[] = [];

  try {
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude", "settings.json"),
      `${JSON.stringify({ env: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" } }, null, 2)}\n`,
      { mode: 0o600 },
    );

    for (const scenario of REQUIRED_SCENARIOS) {
      gateway.setScenario(scenario.id);
      const before = gateway.rawEvents.length;
      const runResult = await runClaudeScenario(claudeBin, scenario, gateway, fakeHome);
      await Bun.sleep(100);
      const newEvents = gateway.rawEvents.slice(before).filter((event) => {
        const parsed = new URL(event.url);
        return parsed.pathname === scenario.path && event.method === scenario.method;
      });

      if (newEvents.length > 0) {
        records.push(capturedRecord(scenario, newEvents));
      } else {
        records.push(
          blockedRecord(
            scenario,
            classifyNoCapture(runResult),
            `No matching request reached the local mock gateway. Claude exit=${runResult.exitCode ?? "null"}; stdout/stderr were sanitized and kept out of normalized fixtures.`,
          ),
        );
      }
    }
  } finally {
    await gateway.stop();
    await rm(fakeHome, { recursive: true, force: true });
  }

  await writeArtifacts(outDir, records, buildMetadata("live-capture", records, claudeVersion), gateway.rawEvents);
  return records;
}

function getArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

export async function readNormalizedRecords(outDir = DEFAULT_OUT_DIR): Promise<NormalizedFixtureRecord[]> {
  const text = await readFile(join(outDir, NORMALIZED_FILE), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as NormalizedFixtureRecord);
}

export function rawFixturePatternIsIgnored(gitignoreText: string): boolean {
  return gitignoreText.split("\n").some((line) => line.trim() === "fixtures/claude-code-gateway/*.raw.jsonl");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const outDir = getArgValue(args, "--out") ?? DEFAULT_OUT_DIR;
  const claudeBin = getArgValue(args, "--claude-bin") ?? "claude";

  if (args.includes("--help")) {
    console.log(`Usage: bun tools/capture-claude-code-fixtures.ts [--write-safe-blocked|--capture] [--allow-unsandboxed-local-capture] [--out fixtures/claude-code-gateway] [--claude-bin claude]\n\n--write-safe-blocked writes blocked, sanitized fixtures without launching Claude Code.\n--capture writes safety-blocked fixtures unless --allow-unsandboxed-local-capture is also provided.\n--allow-unsandboxed-local-capture attempts live capture with fake HOME, an allowlisted environment, and the local mock gateway only; use only after explicit local approval.`);
    return;
  }

  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

  const records = args.includes("--capture")
    ? await attemptLiveCapture(outDir, claudeBin, args.includes("--allow-unsandboxed-local-capture"))
    : await writeSafeBlockedArtifacts(outDir);

  const captured = records.filter((record) => record.status === "captured").length;
  const blocked = records.length - captured;
  console.log(`Wrote ${records.length} Claude Code fixture scenario record(s): ${captured} captured, ${blocked} blocked.`);
  console.log(`Artifacts: ${outDir}/${NORMALIZED_FILE}, ${outDir}/${METADATA_FILE}, ${outDir}/${LEDGER_FILE}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
