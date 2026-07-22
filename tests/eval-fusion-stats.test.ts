import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePositionSwapVerdict, proxyContractScore, runCommand as gradeFusion } from "../evals/fusion/src/grade";
import { runCommand as runFusion } from "../evals/fusion/src/run";
import { holmCorrection, pairedBootstrapDeltaCi, runCommand as statsFusion, weightedMeanByCategory } from "../evals/fusion/src/stats";
import { runCommand as stopFusionServer } from "../evals/fusion/src/stop-server";

const roots: string[] = [];
const isPosix = process.platform !== "win32";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("eval fusion stats", () => {
  test("weighted mean uses registered category weights", () => {
    const score = weightedMeanByCategory([
      { category: "coding", score: 0.5 },
      { category: "reasoning", score: 1.0 },
      { category: "analysis", score: 0.25 },
      { category: "agent_protocol", score: 0.0 },
    ]);
    expect(score).toBeCloseTo(0.3 * 0.5 + 0.4 * 1.0 + 0.2 * 0.25 + 0.1 * 0.0, 10);
  });

  test("bootstrap CI is reproducible with deterministic seed", () => {
    const rows = [
      { taskId: "c1", category: "coding" as const, baseline: 0.4, candidate: 0.8 },
      { taskId: "c2", category: "coding" as const, baseline: 0.8, candidate: 0.7 },
      { taskId: "r1", category: "reasoning" as const, baseline: 0.2, candidate: 0.9 },
      { taskId: "r2", category: "reasoning" as const, baseline: 0.6, candidate: 0.7 },
      { taskId: "a1", category: "analysis" as const, baseline: 0.5, candidate: 0.5 },
      { taskId: "p1", category: "agent_protocol" as const, baseline: 1.0, candidate: 1.0 },
    ];
    const first = pairedBootstrapDeltaCi(rows, 2000, 0.05, 12345);
    const second = pairedBootstrapDeltaCi(rows, 2000, 0.05, 12345);
    expect(second.delta).toBe(first.delta);
    expect(second.ci95).toEqual(first.ci95);
    expect(second.pValue).toBe(first.pValue);
    expect(first.delta).toBeGreaterThan(0);
  });

  test("Holm correction applies monotonic adjusted p values and rejection gate", () => {
    const corrected = holmCorrection([
      { name: "a", pValue: 0.01 },
      { name: "b", pValue: 0.04 },
      { name: "c", pValue: 0.20 },
    ], 0.05);
    expect(corrected.map((row) => row.holmAdjustedP)).toEqual([0.03, 0.08, 0.2]);
    expect(corrected.map((row) => row.holmRejected)).toEqual([true, false, false]);
  });

  test("stats writes paired bootstrap comparison for requested tag subset", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-stats-"));
    roots.push(root);
    const outDir = join(root, "run");
    mkdirSync(outDir, { recursive: true });
    const suite = join(root, "suite.jsonl");
    writeFileSync(suite, [
      { id: "hard-coding", category: "coding", tags: ["hard"] },
      { id: "hard-reasoning", category: "reasoning", tags: ["hard", "smoke"] },
      { id: "easy-analysis", category: "analysis", tags: ["easy"] },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ suiteVersion: "temp-suite", runId: "tag-run" }));
    writeFileSync(join(outDir, "grades.jsonl"), [
      { taskId: "hard-coding", profile: "baseline-a", grader: "g", qualityScore: 0.2 },
      { taskId: "hard-coding", profile: "primary-a", grader: "g", qualityScore: 0.5 },
      { taskId: "hard-reasoning", profile: "baseline-a", grader: "g", qualityScore: 0.4 },
      { taskId: "hard-reasoning", profile: "primary-a", grader: "g", qualityScore: 0.8 },
      { taskId: "easy-analysis", profile: "baseline-a", grader: "g", qualityScore: 1.0 },
      { taskId: "easy-analysis", profile: "primary-a", grader: "g", qualityScore: 0.0 },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    expect(await statsFusion(["--run", outDir, "--suite", suite, "--baseline", "baseline-a", "--primary", "primary-a", "--bootstrap", "200", "--tag-subset", "hard"])).toBe(0);
    const stats = JSON.parse(await Bun.file(join(outDir, "stats.json")).text());
    expect(stats.tagSubsets.hard.n).toBe(2);
    expect(stats.tagSubsets.hard.baselineMean).toBeCloseTo((0.3 * 0.2 + 0.4 * 0.4) / 0.7, 10);
    expect(stats.tagSubsets.hard.primaryMean).toBeCloseTo((0.3 * 0.5 + 0.4 * 0.8) / 0.7, 10);
    expect(stats.tagSubsets.hard.delta).toBeCloseTo(stats.tagSubsets.hard.primaryMean - stats.tagSubsets.hard.baselineMean, 10);
    expect(stats.tagSubsets.hard.ci95).toHaveLength(2);
    expect(stats.tagSubsets.hard.winRate).toBe(1);
  });

  test.skipIf(!isPosix)("stop-server removes pid file when pid is a real defunct child", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-stop-"));
    roots.push(root);
    const childPidPath = join(root, "child.pid");
    const serverPidPath = join(root, "server.pid");
    const parent = Bun.spawn(["python3", "-c", [
      "import os, subprocess, sys, time",
      "child = subprocess.Popen([sys.executable, '-c', 'import os; os._exit(0)'])",
      "open(os.environ['CHILD_PID_PATH'], 'w').write(str(child.pid))",
      "sys.stdout.flush()",
      "time.sleep(30)",
    ].join("\n")], { env: { ...process.env, CHILD_PID_PATH: childPidPath }, stdout: "ignore", stderr: "ignore" });

    try {
      for (let i = 0; i < 50 && !existsSync(childPidPath); i++) await Bun.sleep(20);
      const childPid = readFileSync(childPidPath, "utf8").trim();
      expect(childPid).not.toBe("");
      writeFileSync(serverPidPath, childPid);
      await Bun.sleep(100);

      expect(await stopFusionServer(["--pid-file", serverPidPath])).toBe(0);
      expect(existsSync(serverPidPath)).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      await parent.exited.catch(() => undefined);
    }
  });

  test("stop-server terminates a live server process and clears its pid file on every platform", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-stop-live-"));
    roots.push(root);
    const serverPidPath = join(root, "server.pid");
    // A genuinely running, cross-platform child that stays alive until it is signalled.
    const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000);"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(serverPidPath, String(child.pid));
      await Bun.sleep(100);
      expect(await stopFusionServer(["--pid-file", serverPidPath])).toBe(0);
      expect(existsSync(serverPidPath)).toBe(false);
      await child.exited.catch(() => undefined);
      // Terminated on every platform: POSIX kills via signal (signalCode), Windows via exit code.
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }
  });

  test("position-swap conflicting verdicts resolve to tie", () => {
    expect(resolvePositionSwapVerdict("A", "A")).toBe("tie");
    expect(resolvePositionSwapVerdict("A", "B")).toBe("A");
    expect(resolvePositionSwapVerdict("B", "A")).toBe("B");
    expect(resolvePositionSwapVerdict("tie", "tie")).toBe("tie");
  });

  test("run drains SSE before wall-clock measurement and captures message_start usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-run-"));
    roots.push(root);
    const suiteDir = join(root, "suites");
    const rubricsDir = join(root, "rubrics");
    const outDir = join(root, "run");
    mkdirSync(suiteDir, { recursive: true });
    mkdirSync(rubricsDir, { recursive: true });
    const suite = join(suiteDir, "suite.jsonl");
    const profile = join(root, "profile.json");
    writeFileSync(join(rubricsDir, "rubric.md"), "non-empty rubric\n");
    writeFileSync(suite, JSON.stringify({
      id: "agent-001",
      suiteVersion: "temp-suite",
      category: "agent_protocol",
      prompt: "hello",
      allowedClientTools: [],
      reference: "ok",
      grader: "exact",
      rubricId: "rubric",
      weight: 1,
      tags: [],
      maxTokens: 16,
      timeoutBudget: 1000,
    }) + "\n");
    writeFileSync(profile, JSON.stringify({ name: "f0-current", description: "test", targetModel: "frogp/mix" }) + "\n");

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        await Bun.sleep(80);
        return new Response([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
          "",
          'data: {"type":"content_block_start","content_block":{"type":"thinking","thinking":"plan"}}',
          "",
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
          "",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
          "",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      },
    });

    try {
      expect(await runFusion(["--suite", suite, "--profiles", profile, "--proxy", `http://127.0.0.1:${server.port}`, "--out", outDir])).toBe(0);
    } finally {
      server.stop(true);
    }

    const response = JSON.parse(await Bun.file(join(outDir, "responses.jsonl")).text());
    expect(response.wallClockMs).toBeGreaterThanOrEqual(75);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(response.thinkingText).toBe("plan");
    const manifest = JSON.parse(await Bun.file(join(outDir, "manifest.json")).text());
    expect(manifest.rubricsSha256).not.toBe(createHash("sha256").update("").digest("hex"));
    expect(await gradeFusion(["--run", outDir, "--rubrics", rubricsDir])).toBe(0);
    const gradersShaPath = join(outDir, "graders.sha256");
    expect(existsSync(gradersShaPath)).toBe(true);
    const graderModule = fileURLToPath(new URL("../evals/fusion/src/grade.ts", import.meta.url));
    const expectedGradersSha = createHash("sha256").update(readFileSync(graderModule)).digest("hex");
    expect((await Bun.file(gradersShaPath).text()).trim()).toBe(expectedGradersSha);
    const grade = JSON.parse((await Bun.file(join(outDir, "grades.jsonl")).text()).trim());
    expect(grade.proxyContractScore).toBe(1);
    expect(await statsFusion(["--run", outDir, "--baseline", "f0-current", "--primary", "f0-current", "--bootstrap", "100"])).toBe(0);
    const stats = JSON.parse(await Bun.file(join(outDir, "stats.json")).text());
    expect(stats.proxyContract.score).toBe(1);
  });

  test("run derives fusion stage latency from SSE event arrival markers and later usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-run-"));
    roots.push(root);
    const suiteDir = join(root, "suites");
    const rubricsDir = join(root, "rubrics");
    const outDir = join(root, "run");
    mkdirSync(suiteDir, { recursive: true });
    mkdirSync(rubricsDir, { recursive: true });
    const suite = join(suiteDir, "suite.jsonl");
    const profile = join(root, "profile.json");
    writeFileSync(join(rubricsDir, "rubric.md"), "non-empty rubric\n");
    writeFileSync(suite, JSON.stringify({
      id: "fusion-001",
      suiteVersion: "temp-suite",
      category: "reasoning",
      prompt: "hello",
      allowedClientTools: [],
      reference: "ok",
      grader: "exact",
      rubricId: "rubric",
      weight: 1,
      tags: [],
      maxTokens: 16,
      timeoutBudget: 1000,
    }) + "\n");
    writeFileSync(profile, JSON.stringify({ name: "f1-full-context-min", description: "test", targetModel: "frogp/mix" }) + "\n");

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        const events = [
          ['data: {"type":"message_start","message":{"usage":{"output_tokens":1}}}\n\n', 0],
          ['data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"[panel a/b]\\npanel answer\\n\\n"}}\n\n', 30],
          ['data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"[judge]\\n{}\\n\\n"}}\n\n', 40],
          ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"o"}}\n\n', 25],
          ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"k"}}\n\n', 25],
          ['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":21,"output_tokens":3}}\n\n', 0],
          ['data: {"type":"message_stop"}\n\n', 0],
        ] as const;
        return new Response(new ReadableStream({
          async start(controller) {
            for (const [chunk, delay] of events) {
              if (delay) await Bun.sleep(delay);
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });

    try {
      expect(await runFusion(["--suite", suite, "--profiles", profile, "--proxy", `http://127.0.0.1:${server.port}`, "--out", outDir])).toBe(0);
    } finally {
      server.stop(true);
    }

    const response = JSON.parse(await Bun.file(join(outDir, "responses.jsonl")).text());
    expect(response.usage).toEqual({ inputTokens: 21, outputTokens: 3 });
    expect(response.usageMissing).toBeUndefined();
    expect(response.stageLatency.panelStageMs).toBeGreaterThanOrEqual(20);
    expect(response.stageLatency.judgeStageMs).toBeGreaterThanOrEqual(30);
    expect(response.stageLatency.finalStreamMs).toBeGreaterThanOrEqual(45);
    const latency = JSON.parse(await Bun.file(join(outDir, "latency.json")).text());
    expect(latency.panelStageMs.p50).toBe(response.stageLatency.panelStageMs);
    expect(latency.judgeStageMs.p50).toBe(response.stageLatency.judgeStageMs);
    expect(latency.finalStreamMs.p50).toBe(response.stageLatency.finalStreamMs);
    const cost = JSON.parse(await Bun.file(join(outDir, "cost.json")).text());
    expect(cost.promptTokens).toBe(21);
    expect(cost.promptTokensMissing).toBe(0);
  });

  test("run marks missing prompt token usage instead of reporting zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-run-"));
    roots.push(root);
    const suiteDir = join(root, "suites");
    const rubricsDir = join(root, "rubrics");
    const outDir = join(root, "run");
    mkdirSync(suiteDir, { recursive: true });
    mkdirSync(rubricsDir, { recursive: true });
    const suite = join(suiteDir, "suite.jsonl");
    const profile = join(root, "profile.json");
    writeFileSync(join(rubricsDir, "rubric.md"), "non-empty rubric\n");
    writeFileSync(suite, JSON.stringify({
      id: "fusion-usage-missing",
      suiteVersion: "temp-suite",
      category: "reasoning",
      prompt: "hello",
      allowedClientTools: [],
      reference: "ok",
      grader: "exact",
      rubricId: "rubric",
      weight: 1,
      tags: [],
      maxTokens: 16,
      timeoutBudget: 1000,
    }) + "\n");
    writeFileSync(profile, JSON.stringify({ name: "f1-full-context-min", description: "test", targetModel: "frogp/mix" }) + "\n");

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response([
          'data: {"type":"message_start","message":{"usage":{"output_tokens":1}}}',
          "",
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
          "",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
          "",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      },
    });

    try {
      expect(await runFusion(["--suite", suite, "--profiles", profile, "--proxy", `http://127.0.0.1:${server.port}`, "--out", outDir])).toBe(0);
    } finally {
      server.stop(true);
    }

    const response = JSON.parse(await Bun.file(join(outDir, "responses.jsonl")).text());
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: 3 });
    expect(response.usageMissing).toBe(true);
    const cost = JSON.parse(await Bun.file(join(outDir, "cost.json")).text());
    expect(cost.promptTokens).toBeNull();
    expect(cost.promptTokensMissing).toBe(1);
  });

  test("run extracts panel web_search metrics from serve logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-run-"));
    roots.push(root);
    const suiteDir = join(root, "suites");
    const rubricsDir = join(root, "rubrics");
    const outDir = join(root, "run");
    mkdirSync(suiteDir, { recursive: true });
    mkdirSync(rubricsDir, { recursive: true });
    const suite = join(suiteDir, "suite.jsonl");
    const profile = join(root, "profile.json");
    writeFileSync(join(rubricsDir, "rubric.md"), "non-empty rubric\n");
    writeFileSync(suite, JSON.stringify({
      id: "fusion-search-log",
      suiteVersion: "temp-suite",
      category: "reasoning",
      prompt: "hello",
      allowedClientTools: [],
      reference: "ok",
      grader: "exact",
      rubricId: "rubric",
      weight: 1,
      tags: [],
      maxTokens: 16,
      timeoutBudget: 1000,
    }) + "\n");
    writeFileSync(profile, JSON.stringify({ name: "f1-full-context-min", description: "test", targetModel: "frogp/mix" }) + "\n");

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        writeFileSync(join(outDir, "serve-10100.log"), [
          "frogprogsy: model-mixing: panel web_search #1 (a/b) tier=no_key sources=2 latencyMs=123 query=\"a\"",
          "frogprogsy: model-mixing: panel web_search #2 (a/b) tier=no_key sources=1 latencyMs=45 query=\"b\"",
        ].join("\n") + "\n");
        return new Response([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}',
          "",
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
          "",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      },
    });

    try {
      expect(await runFusion(["--suite", suite, "--profiles", profile, "--proxy", `http://127.0.0.1:${server.port}`, "--out", outDir])).toBe(0);
    } finally {
      server.stop(true);
    }

    const cost = JSON.parse(await Bun.file(join(outDir, "cost.json")).text());
    expect(cost.searchCalls).toBe(2);
    expect(cost.searchCallsSource).toBe("serve-log");
    const latency = JSON.parse(await Bun.file(join(outDir, "latency.json")).text());
    expect(latency.searchMs).toEqual({ p50: 45, p95: 123 });

    writeFileSync(join(outDir, "grades.jsonl"), [
      { taskId: "fusion-search-log", profile: "baseline-a", grader: "g", qualityScore: 0.2 },
      { taskId: "fusion-search-log", profile: "f1-full-context-min", grader: "g", qualityScore: 0.8 },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(await statsFusion(["--run", outDir, "--suite", suite, "--baseline", "baseline-a", "--primary", "f1-full-context-min", "--bootstrap", "50"])).toBe(0);
    const stats = JSON.parse(await Bun.file(join(outDir, "stats.json")).text());
    expect(stats.cost.searchCalls).toBe(2);
    expect(stats.cost.searchCallsSource).toBe("serve-log");
    expect(stats.latency.searchMs).toEqual({ p50: 45, p95: 123 });
  });

  test("stats blocks the primary gate for paired n below 10", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-eval-stats-"));
    roots.push(root);
    const outDir = join(root, "run");
    mkdirSync(outDir, { recursive: true });
    const suite = join(root, "suite.jsonl");
    writeFileSync(suite, JSON.stringify({ id: "single", category: "reasoning" }) + "\n");
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ suiteVersion: "temp-suite", runId: "small-n" }));
    writeFileSync(join(outDir, "grades.jsonl"), [
      { taskId: "single", profile: "baseline-a", grader: "g", qualityScore: 0.1 },
      { taskId: "single", profile: "primary-a", grader: "g", qualityScore: 0.9 },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    expect(await statsFusion(["--run", outDir, "--suite", suite, "--baseline", "baseline-a", "--primary", "primary-a", "--bootstrap", "100"])).toBe(0);
    const stats = JSON.parse(await Bun.file(join(outDir, "stats.json")).text());
    expect(stats.qualityDelta).toBeGreaterThan(0.03);
    expect(stats.passesPrimaryGate).toBe(false);
    expect(stats.gateBlockedReason).toBe("insufficient_n");
  });

  test("agent protocol proxy contract score is deterministic from response records", () => {
    const task = {
      id: "agent-001",
      suiteVersion: "temp-suite",
      category: "agent_protocol" as const,
      prompt: "hello",
      allowedClientTools: [],
      reference: "ok",
      grader: "rubric" as const,
      weight: 1,
      tags: [],
      maxTokens: 16,
      timeoutBudget: 1000,
    };

    expect(proxyContractScore(task, {
      taskId: "agent-001",
      profile: "f0-current",
      requestModel: "frogp/mix",
      responseText: "final answer",
      thinkingText: "private plan",
      stopReason: "end_turn",
    })).toBe(1);

    expect(proxyContractScore(task, {
      taskId: "agent-001",
      profile: "f0-current",
      requestModel: "frogp/mix",
      responseText: "final answer",
      stopReason: "end_turn",
    })).toBeLessThan(1);
  });
});
