import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalProfile, EvalTask, RunManifest } from "./schema";

type Usage = { inputTokens: number | null; outputTokens: number };
type StageLatency = { panelStageMs: number | null; judgeStageMs: number | null; finalStreamMs: number | null };
type ResponseRecord = {
  taskId: string;
  profile: string;
  requestModel: string;
  responseText: string;
  thinkingText?: string;
  stopReason: string;
  usage: Usage;
  usageMissing?: boolean;
  wallClockMs: number;
  stageLatency?: StageLatency;
  sseEvents?: Record<string, number>;
  error?: string;
};

type CliOptions = {
  suite: string;
  proxy: string;
  profiles: string;
  out: string;
  /** Append to an existing run dir (multi-server pilot phases share one paired run). */
  append: boolean;
};

function requireValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing ${flag}`);
  return args[i + 1]!;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    suite: requireValue(argv, "--suite"),
    proxy: requireValue(argv, "--proxy").replace(/\/$/, ""),
    profiles: requireValue(argv, "--profiles"),
    out: requireValue(argv, "--out"),
    append: argv.includes("--append"),
  };
}

async function pathExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function sha256String(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${path}:${index + 1}: invalid JSONL: ${(error as Error).message}`);
      }
    });
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await appendFile(path, JSON.stringify(value) + "\n");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

function profileName(path: string, profile: Partial<EvalProfile>): string {
  return String(profile.name || basename(path).replace(/\.json$/i, ""));
}

function suiteVersionFromTasks(tasks: EvalTask[], suitePath: string): string {
  return tasks[0]?.suiteVersion || basename(suitePath).replace(/\.jsonl$/i, "");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function hashDirectory(path: string): Promise<string> {
  const h = createHash("sha256");
  async function walk(dir: string, prefix = ""): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        h.update(rel);
        h.update("\0");
        h.update(Buffer.from(await Bun.file(full).arrayBuffer()));
      }
    }
  }
  await walk(path);
  return h.digest("hex");
}

async function maybeHashPath(path: string): Promise<string> {
  if (!path) return sha256String("");
  if (await isDirectory(path)) return hashDirectory(path);
  if (!(await pathExists(path))) return sha256String("");
  return sha256File(path);
}

async function rubricsDirectoryForSuite(suitePath: string): Promise<string> {
  const suiteDir = dirname(resolve(suitePath));
  const candidates = [
    join(suiteDir, "..", "rubrics"),
    join(suiteDir, "rubrics"),
    resolve("evals", "fusion", "rubrics"),
  ];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  return candidates[0]!;
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

function tokenCount(value: unknown): number | undefined {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

type ParseState = {
  responseText: string;
  thinkingText: string;
  stopReason: string;
  usage: Usage;
  counts: Record<string, number>;
  stageLatency: StageLatency;
  lastPanelAt: number | null;
  judgeAt: number | null;
  lastFinalTextAt: number | null;
};

function usageFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function applyUsage(state: ParseState, usage: Record<string, unknown> | undefined): void {
  const inputTokens = tokenCount(usage?.input_tokens);
  const outputTokens = tokenCount(usage?.output_tokens);
  if (inputTokens !== undefined) state.usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) state.usage.outputTokens = outputTokens;
}

function recordStageMarker(state: ParseState, text: string, arrivedAtMs: number): void {
  if (text.includes("[panel ")) {
    state.stageLatency.panelStageMs = Math.max(0, arrivedAtMs);
    state.lastPanelAt = arrivedAtMs;
  }
  if (text.includes("[judge]")) {
    state.stageLatency.judgeStageMs = Math.max(0, arrivedAtMs - (state.lastPanelAt ?? 0));
    state.judgeAt = arrivedAtMs;
  }
}

function addEventText(state: ParseState, event: unknown, arrivedAtMs: number): void {
  if (!event || typeof event !== "object") return;
  const obj = event as Record<string, unknown>;
  const type = String(obj.type || "unknown");
  state.counts[type] = (state.counts[type] || 0) + 1;
  applyUsage(state, usageFrom(obj.usage));

  if (type === "content_block_start") {
    const block = obj.content_block as Record<string, unknown> | undefined;
    if (block?.type === "text") {
      state.responseText += normalizeContent(block.text);
      state.lastFinalTextAt = arrivedAtMs;
    }
    if (block?.type === "thinking") {
      const text = normalizeContent(block.thinking);
      state.thinkingText += text;
      recordStageMarker(state, text, arrivedAtMs);
    }
  } else if (type === "content_block_delta") {
    const delta = obj.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta") {
      state.responseText += normalizeContent(delta.text);
      state.lastFinalTextAt = arrivedAtMs;
    }
    if (delta?.type === "thinking_delta") {
      const text = normalizeContent(delta.thinking);
      state.thinkingText += text;
      recordStageMarker(state, text, arrivedAtMs);
    }
  } else if (type === "message_delta") {
    const delta = obj.delta as Record<string, unknown> | undefined;
    if (delta?.stop_reason) state.stopReason = String(delta.stop_reason);
  } else if (type === "message_start") {
    const message = obj.message as Record<string, unknown> | undefined;
    applyUsage(state, usageFrom(message?.usage));
  } else if (type === "message_stop") {
    state.stopReason ||= "stop";
  }
}

async function parseSseResponse(response: Response, startedAt: number): Promise<Omit<ResponseRecord, "taskId" | "profile" | "requestModel" | "wallClockMs">> {
  const state: ParseState = {
    responseText: "",
    thinkingText: "",
    stopReason: "",
    usage: { inputTokens: null, outputTokens: 0 },
    counts: {},
    stageLatency: { panelStageMs: null, judgeStageMs: null, finalStreamMs: null },
    lastPanelAt: null,
    judgeAt: null,
    lastFinalTextAt: null,
  };
  let pending = "";
  const consumeLine = (raw: string) => {
    if (raw.startsWith("data:")) pending += raw.slice(5).trimStart();
    if (raw === "" && pending) {
      const arrivedAtMs = Math.round(performance.now() - startedAt);
      if (pending !== "[DONE]") addEventText(state, JSON.parse(pending), arrivedAtMs);
      pending = "";
    }
  };

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffer) consumeLine(buffer);
  } else {
    for (const raw of (await response.text()).split(/\r?\n/)) consumeLine(raw);
  }
  if (pending && pending !== "[DONE]") addEventText(state, JSON.parse(pending), Math.round(performance.now() - startedAt));
  if (state.judgeAt !== null && state.lastFinalTextAt !== null) {
    state.stageLatency.finalStreamMs = Math.max(0, state.lastFinalTextAt - state.judgeAt);
  }
  return {
    responseText: state.responseText,
    thinkingText: state.thinkingText || undefined,
    stopReason: state.stopReason || (response.ok ? "unknown" : "error"),
    usage: state.usage,
    usageMissing: state.usage.inputTokens === null ? true : undefined,
    stageLatency: state.stageLatency,
    sseEvents: state.counts,
  };
}

/**
 * Optional forward-auth headers for eval requests, sourced from the environment so the token is
 * never persisted in run artifacts, manifests, or command lines. Set EVAL_FORWARD_BEARER when the
 * eval home routes an anthropic provider in authMode "forward" (the post pass-through-redesign
 * path for Claude subscription credentials); the proxy relays these allowlisted headers upstream.
 */
function forwardAuthHeaders(): Record<string, string> {
  const bearer = process.env.EVAL_FORWARD_BEARER;
  if (!bearer) return {};
  return {
    authorization: `Bearer ${bearer}`,
    "anthropic-beta": process.env.EVAL_FORWARD_BETA ?? "claude-code-20250219,oauth-2025-04-20",
  };
}

export function buildTaskMessages(task: EvalTask): Array<{ role: "user"; content: string | Array<{ type: "text"; text: string }> }> {
  const answerInstruction = typeof task.answerInstruction === "string" ? task.answerInstruction : "";
  if (!answerInstruction) return [{ role: "user", content: task.prompt }];
  return [{
    role: "user",
    content: [
      { type: "text", text: task.prompt },
      { type: "text", text: "Benchmark answer format instruction: " + answerInstruction },
    ],
  }];
}

async function callTask(proxy: string, task: EvalTask, profile: EvalProfile): Promise<Omit<ResponseRecord, "taskId" | "profile" | "requestModel">> {
  const body: Record<string, unknown> = {
    model: profile.targetModel,
    stream: true,
    max_tokens: task.maxTokens,
    messages: buildTaskMessages(task),
  };
  if (task.allowedClientTools?.length) {
    body.tools = task.allowedClientTools.map((name) => ({
      name,
      description: `Allowed eval client tool: ${name}`,
      input_schema: { type: "object", additionalProperties: true },
    }));
  }
  const started = performance.now();
  const response = await fetch(`${proxy}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...forwardAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const wallClockMs = Math.round(performance.now() - started);
    return {
      responseText: "",
      stopReason: "error",
      usage: { inputTokens: null, outputTokens: 0 },
      wallClockMs,
      error: `${response.status} ${response.statusText}: ${errorText.slice(0, 1000)}`,
    };
  }
  const parsed = await parseSseResponse(response, started);
  const wallClockMs = Math.round(performance.now() - started);
  return { ...parsed, wallClockMs };
}

async function runWithRetry(proxy: string, task: EvalTask, profile: EvalProfile): Promise<Omit<ResponseRecord, "taskId" | "profile" | "requestModel">> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callTask(proxy, task, profile);
      if (!result.error) return result;
      lastError = result.error;
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  return {
    responseText: "",
    stopReason: "error",
    usage: { inputTokens: null, outputTokens: 0 },
    wallClockMs: 0,
    error: lastError || "request failed",
  };
}

type ServeSearchMetrics = { searchCalls: number; searchCallsSource: "none" | "serve-log"; searchLatencies: number[] };

async function collectServeSearchMetrics(runDir: string): Promise<ServeSearchMetrics> {
  const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
  const logFiles = entries
    .filter((entry) => entry.isFile() && /^serve.*\.log$/.test(entry.name))
    .map((entry) => join(runDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
  if (!logFiles.length) return { searchCalls: 0, searchCallsSource: "none", searchLatencies: [] };

  let searchCalls = 0;
  const searchLatencies: number[] = [];
  const marker = /panel web_search #\d+.*?\blatencyMs=(\d+(?:\.\d+)?)/g;
  for (const logFile of logFiles) {
    const text = await readFile(logFile, "utf8").catch(() => "");
    for (const match of text.matchAll(marker)) {
      searchCalls++;
      const latency = Number(match[1]);
      if (Number.isFinite(latency) && latency >= 0) searchLatencies.push(latency);
    }
  }
  return { searchCalls, searchCallsSource: "serve-log", searchLatencies };
}
function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

export async function runCommand(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const outExists = await pathExists(opts.out);
  if (outExists && !opts.append) throw new Error(`Refusing to overwrite existing run directory: ${opts.out} (use --append to add profiles to a paired run)`);
  await mkdir(opts.out, { recursive: true });

  const tasks = await readJsonl<EvalTask>(opts.suite);
  const profilePaths = opts.profiles.split(",").map((p) => p.trim()).filter(Boolean);
  const profiles = await Promise.all(profilePaths.map(async (path) => ({ path, profile: await readJson<EvalProfile>(path) })));
  const profileNames = profiles.map(({ path, profile }) => profileName(path, profile));
  const suiteVersion = suiteVersionFromTasks(tasks, opts.suite);
  const runId = basename(opts.out) || randomUUID();
  const responsesPath = join(opts.out, "responses.jsonl");

  const manifestPath = join(opts.out, "manifest.json");
  const priorManifest = opts.append && (await pathExists(manifestPath)) ? await readJson<RunManifest>(manifestPath) : undefined;
  const manifest: RunManifest & { suitePath?: string } = priorManifest
    ? { ...priorManifest, profiles: [...new Set([...priorManifest.profiles, ...profileNames])] }
    : ({
      runId,
      suiteVersion,
      suiteSha256: await sha256File(opts.suite),
      suitePath: opts.suite,
      rubricsSha256: await maybeHashPath(await rubricsDirectoryForSuite(opts.suite)),
      gradersSha256: await sha256File(fileURLToPath(import.meta.url)),
      configSha256: (await pathExists(join(opts.out, "config.sha256"))) ? (await Bun.file(join(opts.out, "config.sha256")).text()).trim() : sha256String(""),
      profiles: profileNames,
      startedAt: new Date().toISOString(),
      proxyUrl: opts.proxy,
    } as RunManifest);
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  // Resume support: with --append --skip-existing, task×profile pairs that already have a clean
  // (error-free) record are skipped so an interrupted long run can continue without duplicates.
  const skipExisting = process.argv.includes("--skip-existing") || (Array.isArray(Bun.argv) && Bun.argv.includes("--skip-existing"));
  const existingClean = new Set<string>();
  if (skipExisting && (await pathExists(responsesPath))) {
    for (const r of await readJsonl<ResponseRecord>(responsesPath)) {
      if (!r.error) existingClean.add(`${r.taskId}::${r.profile}`);
    }
  }

  const records: ResponseRecord[] = [];
  for (const { path, profile } of profiles) {
    const name = profileName(path, profile);
    for (const task of tasks) {
      if (existingClean.has(`${task.id}::${name}`)) continue;
      const result = await runWithRetry(opts.proxy, task, profile);
      const record: ResponseRecord = {
        taskId: task.id,
        profile: name,
        requestModel: profile.targetModel,
        ...result,
      };
      records.push(record);
      await appendJsonl(responsesPath, record);
    }
  }

  // Cost/latency always recomputed over the FULL response set so --append phases stay accurate.
  const allRecords = await readJsonl<ResponseRecord>(responsesPath);
  const answerCalls = allRecords.length;
  const promptTokensMissing = allRecords.filter((r) => r.usageMissing || r.usage?.inputTokens === null || r.usage?.inputTokens === undefined).length;
  const promptTokensKnown = allRecords.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0);
  const promptTokens = promptTokensMissing ? null : promptTokensKnown;
  const completionTokens = allRecords.reduce((sum, r) => sum + (r.usage?.outputTokens || 0), 0);
  const retries = allRecords.filter((r) => r.error).length;
  const searchMetrics = await collectServeSearchMetrics(opts.out);
  await Bun.write(join(opts.out, "cost.json"), JSON.stringify({ answerCalls, gradingCalls: 0, adjudicationCalls: 0, searchCalls: searchMetrics.searchCalls, searchCallsSource: searchMetrics.searchCallsSource, retries, promptTokens, promptTokensMissing, completionTokens, estimatedUsd: 0 }, null, 2));
  const latencyValues = (key: keyof StageLatency) => allRecords.map((r) => r.stageLatency?.[key]).filter((n): n is number => typeof n === "number" && n > 0);
  const wall = allRecords.map((r) => r.wallClockMs).filter((n) => n > 0);
  await Bun.write(join(opts.out, "latency.json"), JSON.stringify({
    wallClockMs: { p50: quantile(wall, 0.5), p95: quantile(wall, 0.95) },
    panelStageMs: { p50: quantile(latencyValues("panelStageMs"), 0.5), p95: quantile(latencyValues("panelStageMs"), 0.95) },
    judgeStageMs: { p50: quantile(latencyValues("judgeStageMs"), 0.5), p95: quantile(latencyValues("judgeStageMs"), 0.95) },
    finalStreamMs: { p50: quantile(latencyValues("finalStreamMs"), 0.5), p95: quantile(latencyValues("finalStreamMs"), 0.95) },
    searchMs: { p50: quantile(searchMetrics.searchLatencies, 0.5), p95: quantile(searchMetrics.searchLatencies, 0.95) },
  }, null, 2));
  return 0;
}

if (import.meta.main) {
  runCommand(Bun.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
