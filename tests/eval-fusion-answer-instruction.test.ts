import { describe, expect, test } from "bun:test";
import { buildTaskMessages } from "../evals/fusion/src/run";
import { validateEvalTask, type EvalTask } from "../evals/fusion/src/schema";

const baseTaskJson = {
  id: "answer-format",
  suiteVersion: "local-suite-v1",
  category: "reasoning",
  prompt: "Solve the problem.",
  allowedClientTools: [],
  reference: "42",
  grader: "exact",
  weight: 1,
  tags: [],
  maxTokens: 128,
  timeoutBudget: 1000,
};

describe("eval fusion answerInstruction metadata", () => {
  test("schema accepts optional answerInstruction", () => {
    const task = validateEvalTask({ ...baseTaskJson, answerInstruction: "Return only the final fraction." });
    expect(task.answerInstruction).toBe("Return only the final fraction.");
  });

  test.each([[42], [null], [["final only"]]])("schema rejects non-string answerInstruction %#", (answerInstruction) => {
    expect(() => validateEvalTask({ ...baseTaskJson, answerInstruction })).toThrow("Invalid field task.answerInstruction: expected string");
  });

  test("v1 task JSON without answerInstruction validates unchanged", () => {
    expect(validateEvalTask(baseTaskJson)).toEqual(baseTaskJson);
  });

  test("buildTaskMessages serializes one user message with two text blocks for instructions", () => {
    const task = validateEvalTask({ ...baseTaskJson, answerInstruction: "Return only the final answer." });
    expect(buildTaskMessages(task)).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Solve the problem." },
        { type: "text", text: "Benchmark answer format instruction: Return only the final answer." },
      ],
    }]);
  });

  test("buildTaskMessages preserves plain string content without instructions", () => {
    const task = validateEvalTask(baseTaskJson) as EvalTask;
    expect(buildTaskMessages(task)).toEqual([{ role: "user", content: "Solve the problem." }]);
  });
});
