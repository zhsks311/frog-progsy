import { describe, expect, test } from "bun:test";
import { deterministicScore, usesFormatTolerantScoring } from "../evals/fusion/src/grade";
import type { EvalTask } from "../evals/fusion/src/schema";

function task(overrides: Partial<EvalTask>): EvalTask {
  return {
    id: "normalize",
    suiteVersion: "local-suite-v2",
    category: "reasoning",
    prompt: "Answer exactly.",
    allowedClientTools: [],
    reference: "3/11",
    grader: "exact",
    weight: 1,
    tags: [],
    maxTokens: 128,
    timeoutBudget: 1000,
    ...overrides,
  };
}

describe("eval fusion format-tolerant normalization", () => {
  test("uses format-tolerant scoring only for local-suite-v2 or format-tolerant tag", () => {
    expect(usesFormatTolerantScoring(task({ suiteVersion: "local-suite-v2", tags: [] }))).toBe(true);
    expect(usesFormatTolerantScoring(task({ suiteVersion: "local-suite-v1", tags: ["format-tolerant"] }))).toBe(true);
    expect(usesFormatTolerantScoring(task({ suiteVersion: "local-suite-v1", tags: [] }))).toBe(false);
  });

  test("tolerant exact unwraps boxed display fractions", () => {
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "\\boxed{\\dfrac{3}{11}}")) .toBe(1);
  });

  test("tolerant exact reduces equivalent fractions", () => {
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "$\\frac{6}{22}$")).toBe(1);
  });

  test.each([
    ["0.2727272727", { value: 0.272727, tolerance: 1e-3 }],
    ["2.5e-1", { value: 0.25 }],
    ["1/4", { value: 0.25 }],
  ])("tolerant numeric accepts normalized numeric answer %s", (answer, reference) => {
    expect(deterministicScore(task({ grader: "numeric", reference }), answer)).toBe(1);
  });

  test("tolerant numeric rejects multiple conflicting candidates without list reference", () => {
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 3 / 11 } }), "3/11 or maybe 5/11")).toBe(0);
  });

  test("tolerant numeric rejects a wrong value", () => {
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 0.25 } }), "answer: 0.5")).toBe(0);
  });

  test("v1 exact remains strict for LaTeX wrappers", () => {
    expect(deterministicScore(task({ suiteVersion: "local-suite-v1", tags: [], grader: "exact", reference: "3/11" }), "\\boxed{\\dfrac{3}{11}}")) .toBe(0);
  });

  test("v1 numeric remains strict and unchanged", () => {
    expect(deterministicScore(task({ suiteVersion: "local-suite-v1", tags: [], grader: "numeric", reference: { value: 42 } }), "answer: 42")).toBe(1);
  });

  test("reference.values list allows multiple numeric candidates", () => {
    expect(deterministicScore(task({ grader: "numeric", reference: { values: [0.25, 0.5] } }), "1/4 or maybe 1/2")).toBe(1);
  });

  test("tolerant exact matches prose-wrapped boxed final answers", () => {
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "Let me work through this.\nThe answer is \\boxed{\\dfrac{3}{11}}")).toBe(1);
  });

  test("tolerant exact unwraps nested boxes and inline/display math wrappers", () => {
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "\\boxed{\\boxed{3/11}}")).toBe(1);
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "\\(\\frac{3}{11}\\)")).toBe(1);
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "\\[\\dfrac{3}{11}\\]")).toBe(1);
  });

  test("tolerant exact accepts an answer: marker tail but not a bare equation", () => {
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "I computed several values. Answer: 3/11")).toBe(1);
    // "=" is excluded for exact so a false equation cannot smuggle the reference in.
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "5/11 = 3/11")).toBe(0);
  });

  test("tolerant numeric accepts leading-decimal answers", () => {
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 0.5 } }), ".5")).toBe(1);
  });

  test("tolerant numeric uses the LAST answer marker on the final line", () => {
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 3 } }), "x=2 so answer: 3")).toBe(1);
  });

  test("bare equation lists yield conflicting candidates instead of a final answer", () => {
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 3 } }), "so x=2 and y=3")).toBe(0);
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 42 } }), "answer = 42")).toBe(1);
  });

  test("absurd exponents grade 0 quickly instead of exhausting memory", () => {
    const started = performance.now();
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 1 } }), "1e1000000000")).toBe(0);
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 1 } }), "answer: 1e-999999")).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("unbalanced boxed input does not crash or hang", () => {
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "\\boxed{3/11")).toBe(0);
  });

  test("the LAST explicit final answer wins between boxed and answer: marker", () => {
    // Earlier correct box must not override a later contradictory explicit answer.
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "\\boxed{3/11}\nOn reflection, Answer: 5/11")).toBe(0);
    // And a later correct box wins over an earlier wrong marker.
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "Answer: 5/11 was my draft.\nFinal: \\boxed{3/11}")).toBe(1);
  });

  test("a trailing unbalanced box cannot promote an earlier box over a later answer marker", () => {
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), "\\boxed{3/11}\nAnswer: 5/11\n\\boxed{")).toBe(0);
  });

  test("oversized fraction digits grade 0 quickly instead of feeding BigInt", () => {
    const started = performance.now();
    const huge = "9".repeat(100_000);
    expect(deterministicScore(task({ grader: "numeric", reference: { value: 1 } }), `answer: ${huge}/${huge}`)).toBe(0);
    expect(deterministicScore(task({ grader: "exact", reference: "3/11" }), `${huge}/${huge}`)).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
