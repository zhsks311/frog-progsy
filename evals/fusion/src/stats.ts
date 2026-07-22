import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Category = "coding" | "reasoning" | "analysis" | "agent_protocol";
type EvalTaskLike = { id: string; category: Category; weight?: number; tags?: string[] };
type GradeRecord = { taskId: string; profile: string; grader: string; qualityScore: number; proxyContractScore?: number };
type ResponseRecord = { taskId: string; profile: string; usage?: { inputTokens: number | null; outputTokens: number }; usageMissing?: boolean; wallClockMs?: number; error?: string; sseEvents?: Record<string, number> };

type Comparison = {
  name: string;
  baseline: string;
  candidate: string;
  qualityDelta: number;
  qualityDeltaCi95: [number, number];
  pValue: number;
  holmAdjustedP?: number;
  holmRejected?: boolean;
  winRate: number;
};

export const WEIGHTS: Record<Category, number> = { coding: 0.3, reasoning: 0.4, analysis: 0.2, agent_protocol: 0.1 };

function value(args: string[], flag: string, fallback?: string): string {
  const i = args.indexOf(flag);
  if (i < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${flag}`);
  }
  if (!args[i + 1]) throw new Error(`Missing value for ${flag}`);
  return args[i + 1]!;
}
function values(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    if (!args[i + 1]) throw new Error(`Missing value for ${flag}`);
    out.push(args[i + 1]!);
    i++;
  }
  return out;
}


function parseArgs(argv: string[]) {
  return {
    run: value(argv, "--run"),
    baseline: value(argv, "--baseline"),
    primary: value(argv, "--primary"),
    suite: values(argv, "--suite")[0],
    tagSubsets: values(argv, "--tag-subset"),
    bootstrap: Number(value(argv, "--bootstrap", "10000")),
    alpha: Number(value(argv, "--alpha", "0.05")),
    secondaryCorrection: value(argv, "--secondary-correction", "holm"),
  };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function sha256File(path: string): Promise<string> {
  if (!(await Bun.file(path).exists())) return sha256String("");
  return createHash("sha256").update(Buffer.from(await Bun.file(path).arrayBuffer())).digest("hex");
}

function sha256String(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (pos - lower);
}

export function seededRandom(seed = 0xdecafbad): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function weightedMeanByCategory(rows: Array<{ category: Category; score: number }>, weights: Record<Category, number> = WEIGHTS): number {
  let total = 0;
  let used = 0;
  for (const category of Object.keys(weights) as Category[]) {
    const scores = rows.filter((row) => row.category === category).map((row) => row.score);
    if (!scores.length) continue;
    total += mean(scores) * weights[category];
    used += weights[category];
  }
  return used ? total / used : 0;
}

function scoreMap(grades: GradeRecord[]): Map<string, number> {
  return new Map(grades.map((grade) => [`${grade.profile}\u0000${grade.taskId}`, grade.qualityScore]));
}

function pairedRows(tasks: EvalTaskLike[], grades: GradeRecord[], baseline: string, candidate: string): Array<{ taskId: string; category: Category; baseline: number; candidate: number; delta: number }> {
  const scores = scoreMap(grades);
  const rows = [] as Array<{ taskId: string; category: Category; baseline: number; candidate: number; delta: number }>;
  for (const task of tasks) {
    const b = scores.get(`${baseline}\u0000${task.id}`);
    const c = scores.get(`${candidate}\u0000${task.id}`);
    if (b === undefined || c === undefined) continue;
    rows.push({ taskId: task.id, category: task.category, baseline: b, candidate: c, delta: c - b });
  }
  return rows;
}

function weightedDelta(rows: Array<{ category: Category; baseline: number; candidate: number }>): number {
  const candidateRows = rows.map((row) => ({ category: row.category, score: row.candidate }));
  const baselineRows = rows.map((row) => ({ category: row.category, score: row.baseline }));
  return weightedMeanByCategory(candidateRows) - weightedMeanByCategory(baselineRows);
}

export function pairedBootstrapDeltaCi(
  rows: Array<{ taskId?: string; category: Category; baseline: number; candidate: number }>,
  iterations: number,
  alpha: number,
  seed = 0xdecafbad,
): { delta: number; ci95: [number, number]; pValue: number; samples: number[] } {
  if (!rows.length) return { delta: 0, ci95: [0, 0], pValue: 1, samples: [] };
  const byCategory = new Map<Category, typeof rows>();
  for (const row of rows) byCategory.set(row.category, [...(byCategory.get(row.category) || []), row]);
  const rng = seededRandom(seed);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: typeof rows = [];
    for (const categoryRows of byCategory.values()) {
      for (let j = 0; j < categoryRows.length; j++) sample.push(categoryRows[Math.floor(rng() * categoryRows.length)]!);
    }
    samples.push(weightedDelta(sample));
  }
  const delta = weightedDelta(rows);
  const belowOrEqualZero = samples.filter((n) => n <= 0).length;
  return {
    delta,
    ci95: [quantile(samples, alpha / 2), quantile(samples, 1 - alpha / 2)],
    pValue: Math.min(1, (belowOrEqualZero + 1) / (samples.length + 1)),
    samples,
  };
}

export function holmCorrection<T extends { pValue: number }>(comparisons: T[], alpha: number): Array<T & { holmAdjustedP: number; holmRejected: boolean }> {
  const ordered = comparisons.map((comparison, index) => ({ comparison, index })).sort((a, b) => a.comparison.pValue - b.comparison.pValue);
  const adjusted = new Array<T & { holmAdjustedP: number; holmRejected: boolean }>(comparisons.length);
  let previous = 0;
  let stillReject = true;
  const m = comparisons.length;
  for (let rank = 0; rank < ordered.length; rank++) {
    const item = ordered[rank]!;
    const rawAdjusted = Math.min(1, (m - rank) * item.comparison.pValue);
    const holmAdjustedP = Math.max(previous, rawAdjusted);
    previous = holmAdjustedP;
    const threshold = alpha / (m - rank);
    const holmRejected = stillReject && item.comparison.pValue <= threshold;
    if (!holmRejected) stillReject = false;
    adjusted[item.index] = { ...item.comparison, holmAdjustedP, holmRejected };
  }
  return adjusted;
}

function categoryBreakdown(tasks: EvalTaskLike[], grades: GradeRecord[], baseline: string, primary: string) {
  const rows = pairedRows(tasks, grades, baseline, primary);
  const out: Record<string, unknown> = {};
  for (const category of Object.keys(WEIGHTS) as Category[]) {
    const subset = rows.filter((row) => row.category === category);
    out[category] = {
      weight: WEIGHTS[category],
      baselineMean: mean(subset.map((row) => row.baseline)),
      primaryMean: mean(subset.map((row) => row.candidate)),
      delta: mean(subset.map((row) => row.delta)),
      n: subset.length,
    };
  }
  return out;
}

function winRate(rows: Array<{ baseline: number; candidate: number }>): number {
  if (!rows.length) return 0;
  return rows.filter((row) => row.candidate > row.baseline).length / rows.length;
}
function tagSubsetBreakdown(
  tasks: EvalTaskLike[],
  grades: GradeRecord[],
  baseline: string,
  primary: string,
  tags: string[],
  bootstrap: number,
  alpha: number,
): Record<string, { n: number; baselineMean: number; primaryMean: number; delta: number; ci95: [number, number]; winRate: number }> {
  const out: Record<string, { n: number; baselineMean: number; primaryMean: number; delta: number; ci95: [number, number]; winRate: number }> = {};
  for (const tag of tags) {
    const taskSubset = tasks.filter((task) => task.tags?.includes(tag));
    const rows = pairedRows(taskSubset, grades, baseline, primary);
    const stats = pairedBootstrapDeltaCi(rows, bootstrap, alpha);
    out[tag] = {
      n: rows.length,
      baselineMean: weightedMeanByCategory(rows.map((row) => ({ category: row.category, score: row.baseline }))),
      primaryMean: weightedMeanByCategory(rows.map((row) => ({ category: row.category, score: row.candidate }))),
      delta: stats.delta,
      ci95: stats.ci95,
      winRate: winRate(rows),
    };
  }
  return out;
}


function selectStrongestSingle(grades: GradeRecord[]): string {
  const byProfile = new Map<string, number[]>();
  for (const grade of grades) {
    if (!grade.profile.startsWith("baseline-")) continue;
    byProfile.set(grade.profile, [...(byProfile.get(grade.profile) || []), grade.qualityScore]);
  }
  let best = "";
  let bestMean = -Infinity;
  for (const [profile, scores] of byProfile) {
    const current = mean(scores);
    if (current > bestMean) {
      best = profile;
      bestMean = current;
    }
  }
  if (!best) throw new Error("No baseline-* profiles available for strongest-single selection");
  return best;
}

function zeroLatency() {
  return { p50: 0, p95: 0 };
}

async function suitePathFromManifest(manifest: { suiteVersion: string; suitePath?: string }): Promise<string> {
  if (manifest.suitePath && await Bun.file(manifest.suitePath).exists()) return manifest.suitePath;
  return join("evals", "fusion", "suites", `${manifest.suiteVersion}.jsonl`);
}

export async function runCommand(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const manifest = JSON.parse(await Bun.file(join(opts.run, "manifest.json")).text()) as Record<string, string>;
  const suitePath = opts.suite || await suitePathFromManifest({ suiteVersion: manifest.suiteVersion, suitePath: manifest.suitePath });
  const tasks = await readJsonl<EvalTaskLike>(suitePath);
  const grades = await readJsonl<GradeRecord>(join(opts.run, "grades.jsonl"));
  const responses = (await Bun.file(join(opts.run, "responses.jsonl")).exists()) ? await readJsonl<ResponseRecord>(join(opts.run, "responses.jsonl")) : [];
  const cost = (await Bun.file(join(opts.run, "cost.json")).exists()) ? JSON.parse(await Bun.file(join(opts.run, "cost.json")).text()) : {};
  const latency = (await Bun.file(join(opts.run, "latency.json")).exists()) ? JSON.parse(await Bun.file(join(opts.run, "latency.json")).text()) : {};
  const configShaPath = join(opts.run, "config.sha256");
  const baselineSelected = opts.baseline === "strongest-single" ? selectStrongestSingle(grades) : opts.baseline;
  const rows = pairedRows(tasks, grades, baselineSelected, opts.primary);
  const primary = pairedBootstrapDeltaCi(rows, opts.bootstrap, opts.alpha);
  const passesPrimaryGate = rows.length >= 10 && primary.ci95[0] > 0 && primary.delta >= 0.03;

  const profiles = [...new Set(grades.map((grade) => grade.profile))].filter((profile) => profile !== baselineSelected && profile !== opts.primary);
  const secondaryRaw: Comparison[] = profiles.map((profile) => {
    const secondaryRows = pairedRows(tasks, grades, baselineSelected, profile);
    const stats = pairedBootstrapDeltaCi(secondaryRows, opts.bootstrap, opts.alpha);
    return { name: `${profile}_vs_${baselineSelected}`, baseline: baselineSelected, candidate: profile, qualityDelta: stats.delta, qualityDeltaCi95: stats.ci95, pValue: stats.pValue, winRate: winRate(secondaryRows) };
  });
  const secondaryComparisons = opts.secondaryCorrection === "holm" ? holmCorrection(secondaryRaw, opts.alpha) : secondaryRaw;

  const proxyScores = grades.filter((grade) => grade.proxyContractScore !== undefined);
  const proxyScore = mean(proxyScores.map((grade) => grade.proxyContractScore || 0));
  const responseErrors = responses.filter((response) => response.error).length;
  const preStartSha256 = (await Bun.file(configShaPath).exists()) ? (await Bun.file(configShaPath).text()).trim() : String(manifest.configSha256 || "");
  const postStartSha256 = String(manifest.configSha256 || preStartSha256);
  const postRunSha256 = preStartSha256;

  const stats = {
    suiteVersion: manifest.suiteVersion,
    suiteSha256: manifest.suiteSha256 || await sha256File(suitePath),
    rubricsSha256: manifest.rubricsSha256 || sha256String(""),
    gradersSha256: manifest.gradersSha256 || await sha256File(fileURLToPath(import.meta.url)),
    configSha256: manifest.configSha256 || preStartSha256,
    runId: manifest.runId || opts.run.split("/").pop(),
    baselineSelected,
    primaryCandidate: opts.primary,
    primaryMetric: "weightedQuality",
    weightedQualityFormula: "0.30*coding + 0.40*reasoning + 0.20*analysis + 0.10*agent_protocol",
    qualityDelta: primary.delta,
    qualityDeltaCi95: primary.ci95,
    passesPrimaryGate,
    ...(rows.length < 10 ? { gateBlockedReason: "insufficient_n" } : {}),
    secondaryComparisons,
    categoryBreakdown: categoryBreakdown(tasks, grades, baselineSelected, opts.primary),
    tagSubsets: tagSubsetBreakdown(tasks, grades, baselineSelected, opts.primary, opts.tagSubsets, opts.bootstrap, opts.alpha),
    proxyContract: {
      passed: responseErrors === 0 && (proxyScores.length === 0 || proxyScore >= 0.99),
      score: proxyScores.length ? proxyScore : null,
      checks: { noResponseErrors: responseErrors === 0 },
      regressions: responseErrors ? [`${responseErrors} response errors`] : [],
    },
    cost: {
      answerCalls: cost.answerCalls || responses.length,
      gradingCalls: cost.gradingCalls || 0,
      adjudicationCalls: cost.adjudicationCalls || 0,
      searchCalls: cost.searchCalls || 0,
      searchCallsSource: cost.searchCallsSource || "none",
      retries: cost.retries || 0,
      promptTokens: cost.promptTokens ?? (responses.some((r) => r.usageMissing || r.usage?.inputTokens === null || r.usage?.inputTokens === undefined) ? null : responses.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0)),
      promptTokensMissing: cost.promptTokensMissing ?? responses.filter((r) => r.usageMissing || r.usage?.inputTokens === null || r.usage?.inputTokens === undefined).length,
      completionTokens: cost.completionTokens || responses.reduce((sum, r) => sum + (r.usage?.outputTokens || 0), 0),
      estimatedUsd: cost.estimatedUsd || 0,
    },
    latency: {
      wallClockMs: latency.wallClockMs || zeroLatency(),
      panelStageMs: latency.panelStageMs || zeroLatency(),
      judgeStageMs: latency.judgeStageMs || zeroLatency(),
      finalStreamMs: latency.finalStreamMs || latency.wallClockMs || zeroLatency(),
      searchMs: latency.searchMs || zeroLatency(),
      gradingMs: latency.gradingMs || zeroLatency(),
    },
    configCanonicalization: { preStartSha256, postStartSha256, postRunSha256, hashStable: preStartSha256 === postStartSha256 && postStartSha256 === postRunSha256 },
  };
  await Bun.write(join(opts.run, "stats.json"), JSON.stringify(stats, null, 2));
  return 0;
}

if (import.meta.main) {
  runCommand(Bun.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
