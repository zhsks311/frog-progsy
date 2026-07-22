import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseEvalTasksJsonl, type EvalTask } from "../evals/fusion/src/schema";

/**
 * Binding Critic amendment for the suite-v2 plan: this test validates
 * evals/fusion/suites/local-suite-v2.provenance.json — required top-level and per-task fields,
 * the origin enum, zero verbatim v1 copies, quota bounds, category counts, sha256 consistency,
 * and format-tolerant + answerInstructionApplied coverage for v2 exact/numeric tasks.
 */

const SUITE_PATH = "evals/fusion/suites/local-suite-v2.jsonl";
const PROVENANCE_PATH = "evals/fusion/suites/local-suite-v2.provenance.json";
const V1_SUITE_PATH = "evals/fusion/suites/local-suite-v1.jsonl";
const RUBRICS_DIR = "evals/fusion/rubrics";

const TOP_LEVEL_FIELDS = [
  "suiteVersion", "createdAt", "frozenAt", "taskCount", "categoryCounts", "weights",
  "answerEqualizer", "normalizationContract", "searchEligibleDefinition",
  "baselineSelectionRule", "taskQuotas", "tasks", "sha256",
] as const;

const PER_TASK_FIELDS = [
  "id", "category", "origin", "sourceTaskIds", "changeClasses", "provenanceRationale",
  "grader", "rubricId", "tags", "maxTokens", "answerInstructionApplied", "searchEligible",
  "author", "reviewer",
] as const;

const ORIGINS = new Set(["modified_from_v1_concept", "new_task", "control_from_v1_concept"]);

type ProvenanceTask = Record<(typeof PER_TASK_FIELDS)[number], unknown> & {
  id: string; category: string; origin: string; sourceTaskIds: string[]; grader: string;
  rubricId: string | null; tags: string[]; maxTokens: number;
  answerInstructionApplied: boolean; searchEligible: boolean;
};

async function loadAll() {
  const suiteText = await Bun.file(SUITE_PATH).text();
  const tasks = parseEvalTasksJsonl(suiteText, SUITE_PATH);
  const provenance = JSON.parse(await Bun.file(PROVENANCE_PATH).text()) as Record<string, unknown> & { tasks: ProvenanceTask[] };
  const v1Tasks = parseEvalTasksJsonl(await Bun.file(V1_SUITE_PATH).text(), V1_SUITE_PATH);
  return { suiteText, tasks, provenance, v1Tasks };
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

describe("suite v2 provenance contract", () => {
  test("provenance has every required top-level field", async () => {
    const { provenance } = await loadAll();
    for (const field of TOP_LEVEL_FIELDS) expect(provenance).toHaveProperty(field);
    expect(provenance.suiteVersion).toBe("local-suite-v2");
  });

  test("every per-task provenance row has every required field and a valid origin", async () => {
    const { provenance } = await loadAll();
    for (const row of provenance.tasks) {
      for (const field of PER_TASK_FIELDS) expect(row).toHaveProperty(field);
      expect(ORIGINS.has(row.origin)).toBe(true);
      if (row.origin === "new_task") expect(row.sourceTaskIds).toEqual([]);
      else expect((row.sourceTaskIds as string[]).length).toBeGreaterThan(0);
      expect(String(row.provenanceRationale).length).toBeGreaterThan(10);
    }
  });

  test("suite and provenance agree 1:1 on ids, grader, tags, maxTokens, category", async () => {
    const { tasks, provenance } = await loadAll();
    const byId = new Map(provenance.tasks.map((row) => [row.id, row]));
    expect(provenance.tasks.length).toBe(tasks.length);
    for (const task of tasks) {
      const row = byId.get(task.id);
      expect(row).toBeDefined();
      expect(row!.category).toBe(task.category);
      expect(row!.grader).toBe(task.grader);
      expect(row!.maxTokens).toBe(task.maxTokens);
      expect([...(row!.tags as string[])].sort()).toEqual([...task.tags].sort());
      expect(row!.answerInstructionApplied).toBe(typeof task.answerInstruction === "string" && task.answerInstruction.length > 0);
    }
  });

  test("category counts, weights, and task count match the frozen v1 shape", async () => {
    const { tasks, provenance } = await loadAll();
    expect(tasks.length).toBe(60);
    expect(provenance.taskCount).toBe(60);
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[task.category] = (counts[task.category] || 0) + 1;
    expect(counts).toEqual({ reasoning: 24, coding: 18, analysis: 12, agent_protocol: 6 });
    expect(provenance.categoryCounts).toEqual(counts);
    const weightFor: Record<string, number> = { reasoning: 0.4, coding: 0.3, analysis: 0.2, agent_protocol: 0.1 };
    for (const task of tasks) expect(task.weight).toBe(weightFor[task.category]!);
  });

  test("quota bounds hold: zero verbatim v1 copies, derived and new ranges, search-eligible analysis", async () => {
    const { tasks, provenance, v1Tasks } = await loadAll();
    const v1Prompts = new Set(v1Tasks.map((task) => normalizePrompt(task.prompt)));
    for (const task of tasks) expect(v1Prompts.has(normalizePrompt(task.prompt))).toBe(false);

    const derived = provenance.tasks.filter((row) => row.origin === "modified_from_v1_concept" || row.origin === "control_from_v1_concept").length;
    const fresh = provenance.tasks.filter((row) => row.origin === "new_task").length;
    expect(derived).toBeGreaterThanOrEqual(30);
    expect(derived).toBeLessThanOrEqual(42);
    expect(fresh).toBeGreaterThanOrEqual(18);
    expect(fresh).toBeLessThanOrEqual(30);

    const analysis = provenance.tasks.filter((row) => row.category === "analysis");
    expect(analysis.length).toBe(12);
    const searchEligibleNew = analysis.filter((row) => row.searchEligible === true && (row.origin === "new_task" || (row.changeClasses as string[]).length > 0));
    expect(searchEligibleNew.length).toBeGreaterThanOrEqual(6);
    for (const row of analysis.filter((r) => r.searchEligible)) expect(row.tags).toContain("search-eligible");
  });

  test("sha256 consistency between provenance and the suite file bytes", async () => {
    const { provenance } = await loadAll();
    // Hash the actual on-disk suite bytes (no normalization). provenance.sha256 is frozen over the
    // tracked LF bytes, so this also verifies the `.gitattributes` `*.jsonl text eol=lf` contract:
    // if a checkout ever materializes CRLF, this raw-byte hash diverges and the test fails loudly.
    const actual = createHash("sha256").update(Buffer.from(await Bun.file(SUITE_PATH).arrayBuffer())).digest("hex");
    expect(provenance.sha256).toBe(actual);
  });

  test("every v2 exact/numeric task is format-tolerant with the answer equalizer applied", async () => {
    const { tasks } = await loadAll();
    for (const task of tasks.filter((t) => t.grader === "exact" || t.grader === "numeric")) {
      expect(task.tags).toContain("format-tolerant");
      if (task.category === "reasoning") {
        expect(typeof task.answerInstruction).toBe("string");
        expect((task.answerInstruction as string).length).toBeGreaterThan(10);
      }
    }
  });

  test("rubric tasks carry extension-less rubricIds whose files exist", async () => {
    const { tasks } = await loadAll();
    for (const task of tasks.filter((t) => t.grader === "rubric")) {
      expect(task.rubricId).toBeDefined();
      expect(task.rubricId!.endsWith(".md")).toBe(false);
      expect(await Bun.file(join(RUBRICS_DIR, `${task.rubricId}.md`)).exists()).toBe(true);
    }
  });

  test("all v2 ids are namespaced v2- and unique", async () => {
    const { tasks } = await loadAll();
    const ids = tasks.map((task: EvalTask) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("v2-")).toBe(true);
  });

  test("taskQuotas.actual matches computed origin and search-eligible counts", async () => {
    const { provenance } = await loadAll();
    const quotas = provenance.taskQuotas as Record<string, unknown>;
    const actual = quotas.actual as Record<string, number>;
    const computed = {
      modified_from_v1_concept: provenance.tasks.filter((r) => r.origin === "modified_from_v1_concept").length,
      new_task: provenance.tasks.filter((r) => r.origin === "new_task").length,
      control_from_v1_concept: provenance.tasks.filter((r) => r.origin === "control_from_v1_concept").length,
      searchEligibleAnalysis: provenance.tasks.filter((r) => r.category === "analysis" && r.searchEligible === true).length,
    };
    expect(actual).toEqual(computed);
  });

  test("provenance weights match the suite weight matrix", async () => {
    const { provenance } = await loadAll();
    expect(provenance.weights).toEqual({ reasoning: 0.4, coding: 0.3, analysis: 0.2, agent_protocol: 0.1 });
  });

  test("pre-registered baseline-selection rule internals are fixed", async () => {
    const { provenance } = await loadAll();
    const rule = provenance.baselineSelectionRule as Record<string, unknown>;
    expect(rule.candidates).toEqual(["baseline-gpt55", "baseline-opus48"]);
    expect(rule.tieBandAbsolute).toBe(0.005);
    expect(String(rule.tieBreak)).toContain("baseline-gpt55");
    expect(String(rule.disqualification)).toContain("proxyContract");
    expect(String(rule.recordBeforeCandidateCall)).toContain("baseline-selection.json");
  });

  test("budget matrix is exact per category and grader", async () => {
    const { tasks } = await loadAll();
    for (const task of tasks) {
      const expected = task.category === "reasoning"
        ? (task.grader === "rubric" ? 1200 : 700)
        : task.category === "coding" ? 1200
        : task.category === "analysis" ? 1500
        : 900;
      expect(`${task.id}:${task.maxTokens}`).toBe(`${task.id}:${expected}`);
    }
  });

  test("search-eligible analysis rows are genuinely new tasks", async () => {
    const { provenance } = await loadAll();
    const searchRows = provenance.tasks.filter((r) => r.category === "analysis" && r.searchEligible === true);
    expect(searchRows.length).toBeGreaterThanOrEqual(6);
    for (const row of searchRows) expect(row.origin).toBe("new_task");
  });
});
