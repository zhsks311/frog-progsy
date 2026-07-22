import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../evals/fusion/src/diagnostics";

type LogEntry = {
  id: string;
  endpoint: string;
  method: string;
  route: {
    requestedModelLabel?: string;
    routedModelLabel?: string;
    provider: string;
    adapter?: string;
    routeKind?: string;
  };
  diagnostics?: Array<Record<string, unknown>>;
};

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await Bun.write(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function makeRunDir(): Promise<{ runDir: string; suitePath: string }> {
  const runDir = mkdtempSync(join(tmpdir(), "eval-fusion-diagnostics-"));
  const suitePath = join(runDir, "suite.jsonl");
  await writeJsonl(suitePath, [
    { id: "task-1", category: "coding" },
    { id: "task-2", category: "reasoning" },
    { id: "task-3", category: "analysis" },
  ]);
  await Bun.write(join(runDir, "manifest.json"), JSON.stringify({
    runId: "run-diagnostics-test",
    suiteVersion: "local-test-suite",
    suitePath,
    profiles: ["baseline", "dispatch"],
  }, null, 2));
  await Bun.write(join(runDir, "cost.json"), JSON.stringify({ searchCalls: 2, searchCallsSource: "synthetic" }, null, 2));
  await writeJsonl(join(runDir, "responses.jsonl"), [
    response("task-1", "baseline", "end_turn", 10),
    response("task-2", "baseline", "end_turn", 20),
    response("task-3", "baseline", "end_turn", 30, "synthetic response failure"),
    response("task-1", "dispatch", "end_turn", 40),
    response("task-2", "dispatch", "max_tokens", 50),
    response("task-3", "dispatch", "end_turn", 60),
  ]);
  return { runDir, suitePath };
}

function response(taskId: string, profile: string, stopReason: string, outputTokens: number, error?: string) {
  return {
    taskId,
    profile,
    requestModel: `${profile}-request`,
    responseText: error ? "" : `${taskId} ${profile} answer`,
    stopReason,
    usage: { inputTokens: 100, outputTokens },
    wallClockMs: 123,
    ...(error ? { error } : {}),
  };
}

function messageLog(id: string, provider: string, routedModelLabel: string | undefined, diagnostics?: Array<Record<string, unknown>>): LogEntry {
  return {
    id,
    endpoint: "/v1/messages",
    method: "POST",
    route: {
      // Qualified request matching the routed model — these fixtures are not about the
      // routed_model_mismatch guard (covered by dedicated tests below).
      requestedModelLabel: routedModelLabel ? `${provider}/${routedModelLabel}` : (id.startsWith("baseline") ? "baseline-request" : "dispatch-request"),
      ...(routedModelLabel ? { routedModelLabel } : {}),
      provider,
      adapter: `${provider}-adapter`,
      routeKind: id.startsWith("baseline") ? "single" : "dispatch",
    },
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function fullLogs(): LogEntry[] {
  return [
    { id: "health", endpoint: "/health", method: "GET", route: { provider: "excluded", routedModelLabel: "excluded", routeKind: "excluded" } },
    messageLog("baseline-1", "anthropic", "claude-3"),
    messageLog("baseline-2", "anthropic", "claude-3"),
    messageLog("baseline-3", "anthropic", "claude-3"),
    messageLog("dispatch-1", "openai", "gpt-4.1", [{ kind: "adapter", code: "normalized_stop", provider: "openai", surface: "response", rawValueHash: "abc", rawValueLength: 12 }]),
    messageLog("dispatch-2", "openai", undefined),
    messageLog("dispatch-3", "openai", "claude-3"),
  ];
}

async function withLogServer<T>(logs: LogEntry[], fn: (url: string) => Promise<T>): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/logs") return Response.json(logs);
      return new Response("not found", { status: 404 });
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/api/logs`);
  } finally {
    server.stop(true);
  }
}

async function readDiagnostics(runDir: string): Promise<any> {
  return JSON.parse(await Bun.file(join(runDir, "diagnostics.json")).text());
}

describe("eval fusion diagnostics", () => {
  test("writes aggregate diagnostics from chronological tail request logs", async () => {
    const { runDir } = await makeRunDir();
    try {
      await withLogServer(fullLogs(), async (logsUrl) => {
        expect(await runCommand(["--run", runDir, "--logs-url", logsUrl])).toBe(0);
      });

      expect(await Bun.file(join(runDir, "diagnostics.json")).exists()).toBe(true);
      const diagnostics = await readDiagnostics(runDir);
      expect(diagnostics.responseCount).toBe(6);
      expect(diagnostics.logEntryCount).toBe(6);
      expect(diagnostics.mappingMethod).toBe("chronological-tail");

      expect(diagnostics.truncation.total).toEqual({ rows: 6, truncated: 1, outputTokens: 210, errors: 1 });
      expect(diagnostics.truncation.byProfile.baseline).toEqual({ rows: 3, truncated: 0, outputTokens: 60, errors: 1 });
      expect(diagnostics.truncation.byProfile.dispatch).toEqual({ rows: 3, truncated: 1, outputTokens: 150, errors: 0 });
      expect(diagnostics.truncation.byRoutedModelLabel["claude-3"]).toEqual({ rows: 4, truncated: 0, outputTokens: 120, errors: 1 });
      expect(diagnostics.truncation.byRoutedModelLabel["gpt-4.1"]).toEqual({ rows: 1, truncated: 0, outputTokens: 40, errors: 0 });
      expect(diagnostics.truncation.byRoutedModelLabel["(missing)"]).toEqual({ rows: 1, truncated: 1, outputTokens: 50, errors: 0 });

      expect(diagnostics.routing.byProvider).toEqual({ anthropic: 3, openai: 3 });
      expect(diagnostics.routing.byRoutedModelLabel).toEqual({ "claude-3": 4, "gpt-4.1": 1, "(missing)": 1 });
      expect(diagnostics.routing.byProvider.excluded).toBeUndefined();

      expect(diagnostics.diagnostics).toEqual([
        { kind: "adapter", code: "normalized_stop", provider: "openai", surface: "response", rawValueHash: "abc", rawValueLength: 12, taskId: "task-1", profile: "dispatch" },
      ]);
      expect(diagnostics.mappingWarnings).toContainEqual({ code: "missing_routed_model_label", message: "Mapped log entry for task-2/dispatch is missing route.routedModelLabel", severity: "info" });
      expect(diagnostics.mappingWarnings).toContainEqual({ code: "response_row_error", message: "Response row task-3/baseline has error: synthetic response failure", severity: "info" });
      expect(diagnostics.mappingWarnings.some((warning: any) => warning.severity === "warning")).toBe(false);
      expect(diagnostics.sameModelSubset).toEqual({ baselineModelLabel: "claude-3", rows: [{ taskId: "task-3", profile: "dispatch", routedModelLabel: "claude-3" }] });
      expect(diagnostics.search).toEqual({ searchCalls: 2, searchCallsSource: "synthetic" });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("warns and maps only the alignable response tail when logs are undersized", async () => {
    const { runDir } = await makeRunDir();
    try {
      const undersizedLogs = fullLogs().filter((entry) => entry.endpoint === "/v1/messages").slice(2);
      await withLogServer(undersizedLogs, async (logsUrl) => {
        expect(await runCommand(["--run", runDir, "--logs-url", logsUrl])).toBe(0);
      });

      const diagnostics = await readDiagnostics(runDir);
      expect(diagnostics.logEntryCount).toBe(4);
      expect(diagnostics.truncation.total).toEqual({ rows: 4, truncated: 1, outputTokens: 180, errors: 1 });
      expect(diagnostics.mappingWarnings).toContainEqual({
        code: "insufficient_log_entries",
        message: "Only 4 / 6 /v1/messages log entries are available; aggregates use mapped tail rows only",
        severity: "warning",
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
  test("silent model substitution on a direct-model request is a warning-severity mismatch", async () => {
    const { runDir, suitePath } = await makeRunDir();
    try {
      await writeJsonl(join(runDir, "responses.jsonl"), [response("task-1", "baseline", "end_turn", 50)]);
      const logs: LogEntry[] = [{
        id: "baseline-1",
        endpoint: "/v1/messages",
        method: "POST",
        route: { requestedModelLabel: "claude-opus-4-8", routedModelLabel: "gpt-5.5", provider: "codex", routeKind: "client-default" },
      }];
      await withLogServer(logs, async (url) => {
        expect(await runCommand(["--run", runDir, "--logs-url", url])).toBe(0);
      });
      const diagnostics = await readDiagnostics(runDir);
      const mismatch = diagnostics.mappingWarnings.filter((w: any) => w.code === "routed_model_mismatch");
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0].severity).toBe("warning");
      expect(mismatch[0].message).toContain("claude-opus-4-8");
      expect(mismatch[0].message).toContain("gpt-5.5");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("qualified requests and frogp aliases do not false-positive the mismatch guard", async () => {
    const { runDir, suitePath } = await makeRunDir();
    try {
      await writeJsonl(join(runDir, "responses.jsonl"), [
        response("task-1", "baseline", "end_turn", 50),
        response("task-2", "dispatch", "end_turn", 50),
      ]);
      const logs: LogEntry[] = [
        {
          id: "baseline-1", endpoint: "/v1/messages", method: "POST",
          route: { requestedModelLabel: "anthropic/claude-opus-4-8", routedModelLabel: "claude-opus-4-8", provider: "anthropic", routeKind: "exact-model" },
        },
        {
          id: "dispatch-1", endpoint: "/v1/messages", method: "POST",
          route: { requestedModelLabel: "frogp/mix", routedModelLabel: "gpt-5.5", provider: "codex", routeKind: "qualified" },
        },
      ];
      await withLogServer(logs, async (url) => {
        expect(await runCommand(["--run", runDir, "--logs-url", url])).toBe(0);
      });
      const diagnostics = await readDiagnostics(runDir);
      expect(diagnostics.mappingWarnings.filter((w: any) => w.code === "routed_model_mismatch")).toHaveLength(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
