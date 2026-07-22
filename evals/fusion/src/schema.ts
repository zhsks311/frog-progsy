export type EvalCategory = "coding" | "reasoning" | "analysis" | "agent_protocol";
export type EvalGrader = "exact" | "numeric" | "schema" | "facts" | "rubric";

export interface EvalTask {
  id: string;
  suiteVersion: string;
  category: EvalCategory;
  prompt: string;
  allowedClientTools: string[];
  reference: string | Record<string, unknown>;
  grader: EvalGrader;
  rubricId?: string;
  weight: number;
  tags: string[];
  maxTokens: number;
  /** Eval-only benchmark instruction metadata, not a product behavior. */
  answerInstruction?: string;
  timeoutBudget: number;
}

export interface EvalProfile {
  name: string;
  description: string;
  targetModel: string;
  modelMixing?: unknown;
}

export interface RunManifest {
  runId: string;
  suiteVersion: string;
  suiteSha256: string;
  rubricsSha256: string;
  gradersSha256: string;
  configSha256: string;
  profiles: string[];
  startedAt: string;
  proxyUrl: string;
}

export const WEIGHTS: Record<EvalCategory, number> = {
  coding: 0.30,
  reasoning: 0.40,
  analysis: 0.20,
  agent_protocol: 0.10,
};

export interface EvalResponseRecord {
  taskId: string;
  profile: string;
  requestModel: string;
  responseText: string;
  thinkingText?: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  wallClockMs: number;
  sseEvents?: unknown;
  error?: string;
}

export interface EvalGradeRecord {
  taskId: string;
  profile: string;
  grader: EvalGrader;
  qualityScore: number;
  proxyContractScore?: number;
  judgeMeta?: {
    judge: string;
    positionSwap: boolean;
    verdictAB: string;
    verdictBA: string;
    adjudicated: boolean;
  };
  rationaleRedacted?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fieldPath(path: string, field: string): string {
  return path ? `${path}.${field}` : field;
}

export function requireField<T>(obj: Record<string, unknown>, field: string, path: string, check: (value: unknown) => value is T, expected: string): T {
  if (!(field in obj)) throw new Error(`Missing required field ${fieldPath(path, field)}`);
  const value = obj[field];
  if (!check(value)) throw new Error(`Invalid field ${fieldPath(path, field)}: expected ${expected}`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isReference = (value: unknown): value is string | Record<string, unknown> => isString(value) || isRecord(value);
const isCategory = (value: unknown): value is EvalCategory => value === "coding" || value === "reasoning" || value === "analysis" || value === "agent_protocol";
const isGrader = (value: unknown): value is EvalGrader => value === "exact" || value === "numeric" || value === "schema" || value === "facts" || value === "rubric";

export function validateEvalTask(value: unknown, path = "task"): EvalTask {
  if (!isRecord(value)) throw new Error(`Invalid ${path}: expected object`);
  const task: EvalTask = {
    id: requireField(value, "id", path, isString, "string"),
    suiteVersion: requireField(value, "suiteVersion", path, isString, "string"),
    category: requireField(value, "category", path, isCategory, "coding|reasoning|analysis|agent_protocol"),
    prompt: requireField(value, "prompt", path, isString, "string"),
    allowedClientTools: requireField(value, "allowedClientTools", path, isStringArray, "string[]"),
    reference: requireField(value, "reference", path, isReference, "string|object"),
    grader: requireField(value, "grader", path, isGrader, "exact|numeric|schema|facts|rubric"),
    weight: requireField(value, "weight", path, isNumber, "number"),
    tags: requireField(value, "tags", path, isStringArray, "string[]"),
    maxTokens: requireField(value, "maxTokens", path, isNumber, "number"),
    timeoutBudget: requireField(value, "timeoutBudget", path, isNumber, "number"),
  };
  if ("rubricId" in value) {
    if (!isString(value.rubricId)) throw new Error(`Invalid field ${path}.rubricId: expected string`);
    task.rubricId = value.rubricId;
  }
  if ("answerInstruction" in value) {
    if (!isString(value.answerInstruction)) throw new Error(`Invalid field ${path}.answerInstruction: expected string`);
    task.answerInstruction = value.answerInstruction;
  }
  return task;
}

export function validateEvalProfile(value: unknown, path = "profile"): EvalProfile {
  if (!isRecord(value)) throw new Error(`Invalid ${path}: expected object`);
  const profile: EvalProfile = {
    name: requireField(value, "name", path, isString, "string"),
    description: requireField(value, "description", path, isString, "string"),
    targetModel: requireField(value, "targetModel", path, isString, "string"),
  };
  if ("modelMixing" in value) profile.modelMixing = value.modelMixing;
  return profile;
}

export function parseJsonl(text: string, path = "jsonl"): unknown[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed)];
    } catch (err) {
      throw new Error(`Invalid JSON at ${path}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function parseEvalTasksJsonl(text: string, path = "suite.jsonl"): EvalTask[] {
  return parseJsonl(text, path).map((value, index) => validateEvalTask(value, `${path}:${index + 1}`));
}
