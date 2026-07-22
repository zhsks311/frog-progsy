import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCategory, EvalTask } from "./schema";

export type ResponseRecord = {
  taskId: string;
  profile: string;
  requestModel: string;
  responseText: string;
  thinkingText?: string;
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
  wallClockMs?: number;
  error?: string;
};

export type TaskWithCategory = EvalTask & { category: EvalCategory };

function isFusionResponse(response: ResponseRecord): boolean {
  const profile = response.profile.toLowerCase();
  const model = response.requestModel.toLowerCase();
  return profile.includes("fusion") || profile.startsWith("f0-") || model.includes("frogp/mix") || model.includes("fusion");
}

export function proxyContractScore(task: TaskWithCategory, response: ResponseRecord): number | undefined {
  if (task.category !== "agent_protocol") return undefined;

  const checks = [
    Boolean(response.stopReason),
    !response.error,
    typeof response.responseText === "string",
    !response.thinkingText || !response.responseText.includes(response.thinkingText),
  ];
  if (isFusionResponse(response)) checks.push(Boolean(response.thinkingText));

  return checks.filter(Boolean).length / checks.length;
}

type GradeRecord = {
  taskId: string;
  profile: string;
  grader: string;
  qualityScore: number;
  proxyContractScore?: number;
  judgeMeta?: { judge: string; positionSwap: boolean; verdictAB?: string; verdictBA?: string; adjudicated?: boolean };
  rationaleRedacted?: string;
};

type Options = {
  run: string;
  rubrics: string;
  positionSwap: boolean;
  maxAdjudicationRate: number;
  maxJudgeRetries: number;
  judgeModel: string;
};

function value(args: string[], flag: string, fallback?: string): string {
  const i = args.indexOf(flag);
  if (i < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${flag}`);
  }
  if (!args[i + 1]) throw new Error(`Missing value for ${flag}`);
  return args[i + 1]!;
}

function parseArgs(argv: string[]): Options {
  return {
    run: value(argv, "--run"),
    rubrics: value(argv, "--rubrics"),
    positionSwap: argv.includes("--position-swap"),
    maxAdjudicationRate: Number(value(argv, "--max-adjudication-rate", "0.10")),
    maxJudgeRetries: Number(value(argv, "--max-judge-retries", "1")),
    judgeModel: value(argv, "--judge-model", "claude-opus-4-8"),
  };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await appendFile(path, JSON.stringify(value) + "\n");
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

type Rational = { numerator: bigint; denominator: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1n;
}

function rational(numerator: bigint, denominator: bigint): Rational | undefined {
  if (denominator === 0n) return undefined;
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return { numerator: (numerator / divisor) * sign, denominator: (denominator / divisor) * sign };
}

// Adversarial model output can carry absurd magnitudes ("1e1000000000"); unbounded BigInt
// exponentiation would exhaust memory instead of grading 0, so parsing rejects extremes.
const MAX_RATIONAL_EXPONENT = 300;
const MAX_RATIONAL_DIGITS = 320;

function pow10(exp: number): bigint {
  return 10n ** BigInt(exp);
}

function parseDecimalRational(text: string): Rational | undefined {
  const match = text.trim().match(/^([-+])?(\d*)(?:\.(\d+))?(?:e([-+]?\d+))?$/i);
  if (!match) return undefined;
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";
  if (!whole && !fraction) return undefined;
  if (whole.length + fraction.length > MAX_RATIONAL_DIGITS) return undefined;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isFinite(exponent) || Math.abs(exponent) > MAX_RATIONAL_EXPONENT) return undefined;
  const sign = match[1] === "-" ? -1n : 1n;
  let numerator = BigInt((whole || "0") + fraction) * sign;
  let denominator = pow10(fraction.length);
  if (exponent > 0) numerator *= pow10(exponent);
  if (exponent < 0) denominator *= pow10(-exponent);
  return rational(numerator, denominator);
}

function parseRational(text: string): Rational | undefined {
  const trimmed = text.trim();
  const fraction = trimmed.match(/^([-+]?\d+)\s*\/\s*([-+]?\d+)$/);
  if (fraction) {
    // Same DoS guard as decimals: oversized digit strings never reach BigInt conversion.
    const numeratorDigits = fraction[1]!.replace(/^[-+]/, "");
    const denominatorDigits = fraction[2]!.replace(/^[-+]/, "");
    if (numeratorDigits.length > MAX_RATIONAL_DIGITS || denominatorDigits.length > MAX_RATIONAL_DIGITS) return undefined;
    return rational(BigInt(fraction[1]!), BigInt(fraction[2]!));
  }
  return parseDecimalRational(trimmed);
}

function rationalEquals(left: Rational, right: Rational): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

function rationalToNumber(value: Rational): number {
  return Number(value.numerator) / Number(value.denominator);
}

function replaceBalancedCommand(text: string, command: string): string {
  const marker = `\\${command}{`;
  let result = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(marker, index);
    if (start < 0) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, start);
    let depth = 1;
    let cursor = start + marker.length;
    const contentStart = cursor;
    for (; cursor < text.length; cursor++) {
      if (text[cursor] === "{") depth++;
      if (text[cursor] === "}") depth--;
      if (depth === 0) break;
    }
    if (depth === 0) {
      result += text.slice(contentStart, cursor);
      index = cursor + 1;
    } else {
      result += text.slice(start);
      break;
    }
  }
  return result;
}

/** Convert common LaTeX fraction commands with signed integer parts into plain a/b text. */
function normalizeLatexFractions(text: string): string {
  let current = text;
  for (let i = 0; i < 10; i++) {
    const next = current.replace(/\\d?frac\{\s*([-+]?\d+)\s*\}\{\s*([-+]?\d+)\s*\}/g, "$1/$2");
    if (next === current) return next;
    current = next;
  }
  return current;
}

/** Strip benchmark answer math wrappers and fold text for format-tolerant exact matching. */
function canonicalizeFormatTolerantText(text: string): string {
  let current = normalizeLatexFractions(normalize(text));
  for (let i = 0; i < 10; i++) {
    const next = replaceBalancedCommand(current, "boxed")
      .replace(/\$([^$]*)\$/g, "$1")
      .replace(/\\\((.*?)\\\)/g, "$1")
      .replace(/\\\[(.*?)\\\]/g, "$1");
    if (next === current) break;
    current = normalizeLatexFractions(next);
  }
  return normalize(current);
}

function numericScore(answer: string, reference: unknown): number {
  const expected = typeof reference === "number" ? reference : Number((reference as Record<string, unknown>)?.value ?? reference);
  const tolerance = Number((reference as Record<string, unknown>)?.tolerance ?? 1e-9);
  const match = answer.match(/[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i);
  if (!match || !Number.isFinite(expected)) return 0;
  return Math.abs(Number(match[0]) - expected) <= tolerance ? 1 : 0;
}

export function usesFormatTolerantScoring(task: EvalTask): boolean {
  return task.suiteVersion === "local-suite-v2" || task.tags.includes("format-tolerant");
}

function referenceValues(reference: unknown): unknown[] {
  if (reference && typeof reference === "object" && Array.isArray((reference as Record<string, unknown>).values)) {
    return (reference as Record<string, unknown>).values as unknown[];
  }
  return [typeof reference === "object" && reference !== null && "value" in reference ? (reference as Record<string, unknown>).value : reference];
}

function referenceTolerance(reference: unknown): number {
  const tolerance = Number((reference as Record<string, unknown>)?.tolerance ?? 1e-9);
  return Number.isFinite(tolerance) ? tolerance : 1e-9;
}

type CommandSpan = { content: string; start: number };

function extractBalancedCommandSpans(text: string, command: string): CommandSpan[] {
  const marker = `\\${command}{`;
  const spans: CommandSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(marker, index);
    if (start < 0) break;
    let depth = 1;
    let cursor = start + marker.length;
    const contentStart = cursor;
    for (; cursor < text.length; cursor++) {
      if (text[cursor] === "{") depth++;
      if (text[cursor] === "}") depth--;
      if (depth === 0) break;
    }
    if (depth === 0) {
      spans.push({ content: text.slice(contentStart, cursor), start });
      index = cursor + 1;
    } else {
      break;
    }
  }
  return spans;
}

function extractBalancedCommandContents(text: string, command: string): string[] {
  return extractBalancedCommandSpans(text, command).map((span) => span.content);
}

function lastNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

const numericTokenPattern = /[-+]?\d+\s*\/\s*[-+]?\d+|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi;

function numericTokens(text: string): string[] {
  return [...canonicalizeFormatTolerantText(text).matchAll(numericTokenPattern)].map((match) => match[0]!.replace(/\s+/g, ""));
}

/**
 * Tail of the LAST explicit answer marker ("answer:" or "=") on the line, so earlier
 * intermediate equations ("x=2 so answer: 3") do not create false conflicting candidates.
 */
function finalMarkedSegment(line: string, markers: RegExp): string | undefined {
  const matches = [...line.matchAll(markers)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return undefined;
  return line.slice(last.index + last[0].length);
}

function parseTokens(tokens: string[]): Rational[] {
  return tokens.map(parseRational).filter((value): value is Rational => !!value);
}

/**
 * Extract final-answer numeric candidates for tolerant graders, rejecting unmarked conflicting
 * values. Precedence: last \boxed{...} content, then the tail after the LAST strong "answer:"
 * marker. A bare "=" is a weak marker — each "=" contributes only its immediate following
 * numeric token, so an equation list like "x=2 and y=3" yields conflicting candidates (rejected)
 * instead of being misread as a single final answer.
 */
function extractNumericCandidates(answer: string): Rational[] {
  const marked = extractBalancedCommandContents(answer, "boxed").at(-1);
  if (marked !== undefined) return parseTokens(numericTokens(marked));
  const line = lastNonEmptyLine(answer);
  const answerTail = finalMarkedSegment(line, /answer\s*:/gi);
  if (answerTail !== undefined) return parseTokens(numericTokens(answerTail));
  const equals = [...line.matchAll(/=/g)];
  if (equals.length) {
    const immediate = equals
      .map((match) => numericTokens(line.slice(match.index! + 1))[0])
      .filter((token): token is string => token !== undefined);
    const parsed = parseTokens(immediate);
    if (parsed.length) return parsed;
  }
  return parseTokens(numericTokens(line));
}

function distinctRationals(values: Rational[]): Rational[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.numerator}/${value.denominator}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function referenceRationals(reference: unknown): Rational[] {
  return referenceValues(reference).map((value) => parseRational(String(value))).filter((value): value is Rational => !!value);
}

function tolerantNumericScore(answer: string, reference: unknown): number {
  const candidates = distinctRationals(extractNumericCandidates(answer));
  if (!candidates.length) return 0;
  const refs = referenceRationals(reference);
  const hasReferenceList = !!(reference && typeof reference === "object" && Array.isArray((reference as Record<string, unknown>).values));
  if (candidates.length > 1 && !hasReferenceList) return 0;
  if (!refs.length) return 0;
  const tolerance = referenceTolerance(reference);
  return candidates.every((candidate) => refs.some((ref) => Math.abs(rationalToNumber(candidate) - rationalToNumber(ref)) <= tolerance)) ? 1 : 0;
}

/**
 * Single final-answer candidate for tolerant exact matching, chosen by source position: the
 * LAST explicit final-answer marker wins between \boxed{...} and an "answer:" marker, so an
 * earlier correct box cannot override a later contradictory "Answer:" (and vice versa). With
 * no explicit marker the whole answer is the candidate. The bare "=" marker is intentionally
 * excluded to avoid accepting false equations for textual references.
 */
function exactCandidate(answer: string): string {
  const boxedSpans = extractBalancedCommandSpans(answer, "boxed");
  // Precedence compares the LAST BALANCED box position, so a trailing unbalanced "\boxed{"
  // fragment cannot promote an earlier box over a later contradictory "answer:" marker.
  const lastBoxed = boxedSpans.at(-1);
  const lastBoxedStart = lastBoxed?.start ?? -1;
  const markerMatches = [...answer.matchAll(/answer\s*:/gi)];
  const lastMarker = markerMatches.at(-1);
  const markerStart = lastMarker?.index ?? -1;
  if (lastMarker && markerStart > lastBoxedStart) {
    const tail = answer.slice(markerStart + lastMarker[0].length);
    return tail.split(/\r?\n/).find((line) => line.trim()) ?? tail;
  }
  if (lastBoxed) return lastBoxed.content;
  return answer;
}

function tolerantExactScore(answer: string, reference: unknown): number {
  const right = canonicalizeFormatTolerantText(typeof reference === "string" ? reference : JSON.stringify(reference));
  const rightRational = parseRational(right);
  const left = canonicalizeFormatTolerantText(exactCandidate(answer));
  const leftRational = parseRational(left);
  if (leftRational && rightRational) return rationalEquals(leftRational, rightRational) ? 1 : 0;
  return left === right ? 1 : 0;
}

function schemaScore(answer: string, reference: unknown): number {
  try {
    const parsed = JSON.parse(answer);
    const required = Array.isArray((reference as Record<string, unknown>)?.required) ? ((reference as Record<string, unknown>).required as string[]) : [];
    return required.every((key) => Object.prototype.hasOwnProperty.call(parsed, key)) ? 1 : 0;
  } catch {
    return 0;
  }
}

function factsScore(answer: string, reference: unknown): number {
  const facts = Array.isArray(reference) ? reference : Array.isArray((reference as Record<string, unknown>)?.facts) ? ((reference as Record<string, unknown>).facts as unknown[]) : [];
  if (!facts.length) return 0;
  const haystack = normalize(answer);
  const hits = facts.filter((fact) => haystack.includes(normalize(String(fact)))).length;
  return hits / facts.length;
}

export function deterministicScore(task: EvalTask, answer: string): number | undefined {
  const tolerant = usesFormatTolerantScoring(task);
  if (task.grader === "exact") return tolerant ? tolerantExactScore(answer, task.reference) : (normalize(answer) === normalize(typeof task.reference === "string" ? task.reference : JSON.stringify(task.reference)) ? 1 : 0);
  if (task.grader === "numeric") return tolerant ? tolerantNumericScore(answer, task.reference) : numericScore(answer, task.reference);
  if (task.grader === "schema") return schemaScore(answer, task.reference);
  if (task.grader === "facts") return factsScore(answer, task.reference);
  return undefined;
}

export type PairwiseVerdict = "A" | "B" | "tie";

function flip(verdict: PairwiseVerdict): PairwiseVerdict {
  if (verdict === "A") return "B";
  if (verdict === "B") return "A";
  return "tie";
}

export function resolvePositionSwapVerdict(verdictAB: PairwiseVerdict, verdictBA?: PairwiseVerdict): PairwiseVerdict {
  if (!verdictBA) return verdictAB;
  const baInOriginalOrder = flip(verdictBA);
  return verdictAB === baInOriginalOrder ? verdictAB : "tie";
}

function scoreFromVerdict(verdict: PairwiseVerdict): number {
  if (verdict === "A") return 1;
  if (verdict === "B") return 0;
  return 0.5;
}

function parseVerdict(text: string): { verdict: PairwiseVerdict; rationale: string; lowConfidence: boolean } {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      const raw = String(obj.verdict || obj.winner || "tie").toUpperCase();
      return { verdict: raw === "A" ? "A" : raw === "B" ? "B" : "tie", rationale: String(obj.rationale || ""), lowConfidence: obj.confidence === "low" || Number(obj.confidence) < 0.6 };
    } catch {}
  }
  const lowered = text.toLowerCase();
  return { verdict: lowered.includes("winner: a") ? "A" : lowered.includes("winner: b") ? "B" : "tie", rationale: text.slice(0, 500), lowConfidence: lowered.includes("low confidence") };
}

function anonymizedJudgePrompt(task: EvalTask, rubric: string, answerA: string, answerB: string): string {
  return [
    "You are grading two anonymous answers for one evaluation task.",
    "Do not infer model identity. Ignore profile names and panel traces if present.",
    "Return strict JSON: {\"verdict\":\"A\"|\"B\"|\"tie\",\"confidence\":0..1,\"rationale\":\"short\"}.",
    "Rubric:\n" + rubric,
    "Task prompt:\n" + task.prompt,
    "Reference:\n" + (typeof task.reference === "string" ? task.reference : JSON.stringify(task.reference)),
    "Answer A:\n" + answerA,
    "Answer B:\n" + answerB,
  ].join("\n\n");
}

async function callJudge(proxy: string, judgeModel: string, prompt: string, maxRetries: number): Promise<{ verdict: PairwiseVerdict; rationale: string; lowConfidence: boolean; latencyMs: number; retries: number }> {
  let last = "";
  const started = performance.now();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${proxy.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: judgeModel, stream: false, max_tokens: 512, messages: [{ role: "user", content: prompt }] }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const content = Array.isArray(parsed.content) ? parsed.content.map((p) => (typeof p === "object" && p ? String((p as Record<string, unknown>).text ?? "") : String(p))).join("") : String(parsed.content ?? text);
      return { ...parseVerdict(content), latencyMs: Math.round(performance.now() - started), retries: attempt };
    } catch (error) {
      last = (error as Error).message;
    }
  }
  return { verdict: "tie", rationale: `judge failed: ${last.slice(0, 200)}`, lowConfidence: true, latencyMs: Math.round(performance.now() - started), retries: maxRetries };
}

async function hashFile(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function rubricText(dir: string, task: EvalTask): Promise<string> {
  if (!task.rubricId) return "Prefer factual correctness, completeness, instruction-following, and concise risk handling.";
  const path = join(dir, `${task.rubricId}.md`);
  if (await Bun.file(path).exists()) return Bun.file(path).text();
  return "Prefer factual correctness, completeness, instruction-following, and concise risk handling.";
}

async function suitePathFromManifest(manifest: { suiteVersion: string; suitePath?: string }): Promise<string> {
  if (manifest.suitePath && await Bun.file(manifest.suitePath).exists()) return manifest.suitePath;
  return join("evals", "fusion", "suites", `${manifest.suiteVersion}.jsonl`);
}

export async function runCommand(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const manifest = JSON.parse(await Bun.file(join(opts.run, "manifest.json")).text()) as { proxyUrl?: string; suiteVersion: string; suitePath?: string };
  const suitePath = await suitePathFromManifest(manifest);
  const tasks = await readJsonl<TaskWithCategory>(suitePath);
  const responses = await readJsonl<ResponseRecord>(join(opts.run, "responses.jsonl"));
  const gradesPath = join(opts.run, "grades.jsonl");
  await Bun.write(gradesPath, "");

  let gradingCalls = 0;
  let adjudicationCalls = 0;
  let retries = 0;
  const gradingLatency: number[] = [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const grouped = new Map<string, ResponseRecord[]>();
  for (const response of responses) {
    const task = taskById.get(response.taskId);
    if (!task) continue;
    const direct = deterministicScore(task, response.responseText || "");
    const contractScore = proxyContractScore(task, response);
    if (direct !== undefined || response.error) {
      await appendJsonl(gradesPath, { taskId: response.taskId, profile: response.profile, grader: task.grader, qualityScore: response.error ? 0 : direct, proxyContractScore: contractScore } satisfies GradeRecord);
    } else {
      const list = grouped.get(response.taskId) || [];
      list.push(response);
      grouped.set(response.taskId, list);
    }
  }

  const maxAdjudications = Math.floor([...grouped.values()].reduce((sum, rows) => sum + Math.max(0, rows.length - 1), 0) * opts.maxAdjudicationRate);
  for (const [taskId, rows] of grouped) {
    const task = taskById.get(taskId)!;
    const baseline = rows[0]!;
    await appendJsonl(gradesPath, { taskId, profile: baseline.profile, grader: task.grader, qualityScore: 0.5, proxyContractScore: proxyContractScore(task, baseline), judgeMeta: { judge: opts.judgeModel, positionSwap: opts.positionSwap } } satisfies GradeRecord);
    for (const candidate of rows.slice(1)) {
      const rubric = await rubricText(opts.rubrics, task);
      const ab = await callJudge(manifest.proxyUrl || "", opts.judgeModel, anonymizedJudgePrompt(task, rubric, candidate.responseText, baseline.responseText), opts.maxJudgeRetries);
      gradingCalls++;
      retries += ab.retries;
      gradingLatency.push(ab.latencyMs);
      let verdictBA: PairwiseVerdict | undefined;
      let baRationale = "";
      if (opts.positionSwap) {
        const ba = await callJudge(manifest.proxyUrl || "", opts.judgeModel, anonymizedJudgePrompt(task, rubric, baseline.responseText, candidate.responseText), opts.maxJudgeRetries);
        gradingCalls++;
        retries += ba.retries;
        gradingLatency.push(ba.latencyMs);
        verdictBA = ba.verdict;
        baRationale = ba.rationale;
      }
      let verdict = resolvePositionSwapVerdict(ab.verdict, verdictBA);
      let adjudicated = false;
      if (verdict === "tie" && adjudicationCalls < maxAdjudications && ab.lowConfidence) {
        const adj = await callJudge(manifest.proxyUrl || "", opts.judgeModel, anonymizedJudgePrompt(task, rubric, candidate.responseText, baseline.responseText), opts.maxJudgeRetries);
        gradingCalls++;
        adjudicationCalls++;
        retries += adj.retries;
        gradingLatency.push(adj.latencyMs);
        verdict = adj.verdict;
        adjudicated = true;
      }
      await appendJsonl(gradesPath, {
        taskId,
        profile: candidate.profile,
        grader: task.grader,
        qualityScore: scoreFromVerdict(verdict),
        proxyContractScore: proxyContractScore(task, candidate),
        judgeMeta: { judge: opts.judgeModel, positionSwap: opts.positionSwap, verdictAB: ab.verdict, verdictBA, adjudicated },
        rationaleRedacted: [ab.rationale, baRationale].filter(Boolean).join(" | ").slice(0, 1000),
      } satisfies GradeRecord);
    }
  }

  const costPath = join(opts.run, "cost.json");
  const cost = (await Bun.file(costPath).exists()) ? JSON.parse(await Bun.file(costPath).text()) : {};
  // Spread the prior cost record first so run-produced fields (searchCallsSource, promptTokensMissing,
  // searchMs provenance) survive the grade rewrite; only grading-owned fields are overwritten.
  await Bun.write(costPath, JSON.stringify({ ...cost, answerCalls: cost.answerCalls || responses.length, gradingCalls, adjudicationCalls, searchCalls: cost.searchCalls || 0, retries: (cost.retries || 0) + retries, promptTokens: cost.promptTokens ?? 0, completionTokens: cost.completionTokens || 0, estimatedUsd: cost.estimatedUsd || 0 }, null, 2));
  const latencyPath = join(opts.run, "latency.json");
  const latency = (await Bun.file(latencyPath).exists()) ? JSON.parse(await Bun.file(latencyPath).text()) : {};
  const sorted = gradingLatency.sort((a, b) => a - b);
  const pick = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0;
  await Bun.write(latencyPath, JSON.stringify({ ...latency, gradingMs: { p50: pick(0.5), p95: pick(0.95) } }, null, 2));
  await Bun.write(join(opts.run, "graders.sha256"), await hashFile(fileURLToPath(import.meta.url)));
  return 0;
}

if (import.meta.main) {
  runCommand(Bun.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
