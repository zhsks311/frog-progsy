import { join } from "node:path";

type Severity = "warning" | "info";
type MappingWarning = { code: string; message: string; severity: Severity };
type Category = "coding" | "reasoning" | "analysis" | "agent_protocol";

type ResponseRecord = {
  taskId: string;
  profile: string;
  requestModel: string;
  responseText: string;
  thinkingText?: string;
  stopReason: string;
  usage: { inputTokens: number | null; outputTokens: number };
  usageMissing?: boolean;
  wallClockMs: number;
  stageLatency?: unknown;
  sseEvents?: Record<string, number>;
  error?: string;
};

type Manifest = {
  runId?: string;
  suiteVersion?: string;
  suitePath?: string;
  profiles?: string[];
};

type SuiteTask = { id: string; category?: Category };

type RequestLogEntry = {
  id?: string;
  startedAt?: string;
  endpoint?: string;
  method?: string;
  route?: {
    requestedModelLabel?: string;
    routedModelLabel?: string;
    provider?: string;
    adapter?: string;
    routeKind?: string;
  };
  diagnostics?: Array<Record<string, unknown>>;
};

type TruncationBucket = { rows: number; truncated: number; outputTokens: number; errors: number };
type CountMap = Record<string, number>;

const MISSING_KEY = "(missing)";
const UNKNOWN_CATEGORY = "uncategorized";

type CliOptions = { run: string; logsUrl: string };

function requireValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing ${flag}`);
  return args[i + 1]!;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    run: requireValue(argv, "--run"),
    logsUrl: requireValue(argv, "--logs-url"),
  };
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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

async function readTaskCategories(manifest: Manifest, warnings: MappingWarning[]): Promise<Map<string, string>> {
  const categories = new Map<string, string>();
  if (!manifest.suitePath) {
    warnings.push({ code: "suite_mapping_unavailable", message: "manifest.suitePath is missing; category buckets use uncategorized", severity: "warning" });
    return categories;
  }
  if (!(await Bun.file(manifest.suitePath).exists())) {
    warnings.push({ code: "suite_mapping_unavailable", message: `manifest.suitePath is not readable: ${manifest.suitePath}`, severity: "warning" });
    return categories;
  }
  const tasks = await readJsonl<SuiteTask>(manifest.suitePath);
  for (const task of tasks) {
    if (task.id && task.category) categories.set(task.id, task.category);
  }
  return categories;
}

function key(value: unknown): string {
  return typeof value === "string" && value ? value : MISSING_KEY;
}

function increment(map: CountMap, name: string): void {
  map[name] = (map[name] || 0) + 1;
}

function emptyTruncationBucket(): TruncationBucket {
  return { rows: 0, truncated: 0, outputTokens: 0, errors: 0 };
}

function addTruncation(bucket: TruncationBucket, response: ResponseRecord): void {
  bucket.rows++;
  if (response.stopReason === "max_tokens") bucket.truncated++;
  bucket.outputTokens += response.usage?.outputTokens || 0;
  if (response.error) bucket.errors++;
}

function addTruncationBy(map: Record<string, TruncationBucket>, name: string, response: ResponseRecord): void {
  map[name] ||= emptyTruncationBucket();
  addTruncation(map[name]!, response);
}

function dominant(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best: string | null = null;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

async function fetchLogs(logsUrl: string): Promise<RequestLogEntry[]> {
  const response = await fetch(logsUrl);
  if (!response.ok) throw new Error(`Failed to fetch logs-url: HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("logs-url response must be a JSON array");
  return body as RequestLogEntry[];
}

export async function runCommand(argv: string[]): Promise<number> {
  try {
    const opts = parseArgs(argv);
    const responsesPath = join(opts.run, "responses.jsonl");
    const manifestPath = join(opts.run, "manifest.json");
    const responses = await readJsonl<ResponseRecord>(responsesPath);
    const manifest = await readJson<Manifest>(manifestPath);
    const mappingWarnings: MappingWarning[] = [];
    const taskCategories = await readTaskCategories(manifest, mappingWarnings);
    const logs = await fetchLogs(opts.logsUrl);
    const messageLogs = logs.filter((entry) => entry.endpoint === "/v1/messages");
    const alignable = Math.min(responses.length, messageLogs.length);

    if (messageLogs.length < responses.length) {
      mappingWarnings.push({
        code: "insufficient_log_entries",
        message: `Only ${messageLogs.length} / ${responses.length} /v1/messages log entries are available; aggregates use mapped tail rows only`,
        severity: "warning",
      });
    }

    const responseStart = responses.length - alignable;
    const logStart = messageLogs.length - alignable;
    const mappedRows: Array<{ response: ResponseRecord; log: RequestLogEntry; category: string; routedModelLabel: string; requestedModelLabel: string; provider: string; routeKind: string }> = [];

    for (let i = 0; i < alignable; i++) {
      const response = responses[responseStart + i]!;
      const log = messageLogs[logStart + i]!;
      const routedModelLabel = key(log.route?.routedModelLabel);
      if (response.error) {
        mappingWarnings.push({ code: "response_row_error", message: `Response row ${response.taskId}/${response.profile} has error: ${response.error}`, severity: "info" });
      }
      if (!log.route?.routedModelLabel) {
        mappingWarnings.push({ code: "missing_routed_model_label", message: `Mapped log entry for ${response.taskId}/${response.profile} is missing route.routedModelLabel`, severity: "info" });
      }
      // A direct-model request whose routed model differs from the requested model means the
      // proxy silently substituted another model (e.g. bare-slug client-default routing to the
      // home default provider). That mislabels the whole lane, so it is aggregate-distorting:
      // severity "warning". Alias requests (frogp/*) are excluded — routing is their purpose,
      // and qualified requests only mismatch when the model part itself differs (the proxy
      // strips the provider namespace in routedModelLabel).
      const requestedRaw = log.route?.requestedModelLabel;
      const routedRaw = log.route?.routedModelLabel;
      if (requestedRaw && routedRaw && !requestedRaw.startsWith("frogp")) {
        const requestedModel = requestedRaw.includes("/") ? requestedRaw.slice(requestedRaw.indexOf("/") + 1) : requestedRaw;
        if (requestedModel !== routedRaw) {
          mappingWarnings.push({ code: "routed_model_mismatch", message: `${response.taskId}/${response.profile}: requested ${requestedRaw} but proxy routed ${routedRaw} (silent model substitution)`, severity: "warning" });
        }
      }
      mappedRows.push({
        response,
        log,
        category: taskCategories.get(response.taskId) || UNKNOWN_CATEGORY,
        routedModelLabel,
        requestedModelLabel: key(log.route?.requestedModelLabel),
        provider: key(log.route?.provider),
        routeKind: key(log.route?.routeKind),
      });
    }

    const truncation = {
      total: emptyTruncationBucket(),
      byProfile: {} as Record<string, TruncationBucket>,
      byCategory: {} as Record<string, TruncationBucket>,
      byTaskId: {} as Record<string, TruncationBucket>,
      byRoutedModelLabel: {} as Record<string, TruncationBucket>,
    };
    const routing = {
      byProfile: {} as CountMap,
      byCategory: {} as CountMap,
      byTaskId: {} as CountMap,
      byRequestedModelLabel: {} as CountMap,
      byRoutedModelLabel: {} as CountMap,
      byProvider: {} as CountMap,
      byRouteKind: {} as CountMap,
    };
    const diagnostics: Array<Record<string, unknown>> = [];

    // Info-level mapping warnings describe row/log metadata quality but do not remove rows from aggregates.
    // Only warning-severity mapping issues indicate truncation/routing aggregates may be distorted.
    for (const row of mappedRows) {
      addTruncation(truncation.total, row.response);
      addTruncationBy(truncation.byProfile, row.response.profile, row.response);
      addTruncationBy(truncation.byCategory, row.category, row.response);
      addTruncationBy(truncation.byTaskId, row.response.taskId, row.response);
      addTruncationBy(truncation.byRoutedModelLabel, row.routedModelLabel, row.response);

      increment(routing.byProfile, row.response.profile);
      increment(routing.byCategory, row.category);
      increment(routing.byTaskId, row.response.taskId);
      increment(routing.byRequestedModelLabel, row.requestedModelLabel);
      increment(routing.byRoutedModelLabel, row.routedModelLabel);
      increment(routing.byProvider, row.provider);
      increment(routing.byRouteKind, row.routeKind);

      for (const diagnostic of row.log.diagnostics || []) {
        diagnostics.push({ ...diagnostic, taskId: row.response.taskId, profile: row.response.profile });
      }
    }

    const baselineProfile = manifest.profiles?.[0] || null;
    const baselineModelLabel = baselineProfile
      ? dominant(mappedRows.filter((row) => row.response.profile === baselineProfile && row.routedModelLabel !== MISSING_KEY).map((row) => row.routedModelLabel))
      : null;
    const sameModelRows = baselineModelLabel
      ? mappedRows
        .filter((row) => row.response.profile !== baselineProfile && row.routedModelLabel === baselineModelLabel)
        .map((row) => ({ taskId: row.response.taskId, profile: row.response.profile, routedModelLabel: row.routedModelLabel }))
      : [];

    const costPath = join(opts.run, "cost.json");
    const cost = (await Bun.file(costPath).exists()) ? await readJson<{ searchCalls?: number; searchCallsSource?: string }>(costPath) : {};
    const output = {
      runId: manifest.runId || opts.run.split(/[\\/]/).pop(),
      suiteVersion: manifest.suiteVersion || "",
      responseCount: responses.length,
      logEntryCount: messageLogs.length,
      mappingMethod: "chronological-tail",
      mappingWarnings,
      truncation,
      routing,
      sameModelSubset: { baselineModelLabel, rows: sameModelRows },
      diagnostics,
      search: { searchCalls: cost.searchCalls || 0, searchCallsSource: cost.searchCallsSource || "none" },
    };

    await Bun.write(join(opts.run, "diagnostics.json"), JSON.stringify(output, null, 2));
    console.log(`diagnostics: ${truncation.total.truncated}/${truncation.total.rows} truncated, ${mappingWarnings.length} warnings`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  runCommand(Bun.argv.slice(2)).then((code) => process.exit(code));
}
