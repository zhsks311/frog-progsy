type StatsSummary = {
  runId: string;
  suiteVersion: string;
  baselineSelected: string;
  primaryCandidate: string;
  qualityDelta: number;
  qualityDeltaCi95: [number, number];
  passesPrimaryGate: boolean;
  cost?: { answerCalls?: number; gradingCalls?: number; searchCalls?: number; promptTokens?: number; completionTokens?: number; estimatedUsd?: number };
  latency?: { wallClockMs?: { p50?: number; p95?: number } };
};

function value(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (flag === "--left" && positional[0]) return positional[0]!;
  if (flag === "--right" && positional[1]) return positional[1]!;
  throw new Error(`Missing ${flag}`);
}

function fmt(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(4) : "";
}

function row(label: string, left: string, right: string): string {
  return `| ${label} | ${left} | ${right} |`;
}

export function renderComparison(left: StatsSummary, right: StatsSummary): string {
  return [
    "| Field | Left | Right |",
    "| --- | --- | --- |",
    row("runId", left.runId, right.runId),
    row("suiteVersion", left.suiteVersion, right.suiteVersion),
    row("baselineSelected", left.baselineSelected, right.baselineSelected),
    row("primaryCandidate", left.primaryCandidate, right.primaryCandidate),
    row("qualityDelta", fmt(left.qualityDelta), fmt(right.qualityDelta)),
    row("qualityDeltaCi95", `[${fmt(left.qualityDeltaCi95?.[0])}, ${fmt(left.qualityDeltaCi95?.[1])}]`, `[${fmt(right.qualityDeltaCi95?.[0])}, ${fmt(right.qualityDeltaCi95?.[1])}]`),
    row("passesPrimaryGate", String(left.passesPrimaryGate), String(right.passesPrimaryGate)),
    row("answerCalls", String(left.cost?.answerCalls ?? 0), String(right.cost?.answerCalls ?? 0)),
    row("gradingCalls", String(left.cost?.gradingCalls ?? 0), String(right.cost?.gradingCalls ?? 0)),
    row("searchCalls", String(left.cost?.searchCalls ?? 0), String(right.cost?.searchCalls ?? 0)),
    row("estimatedUsd", fmt(left.cost?.estimatedUsd), fmt(right.cost?.estimatedUsd)),
    row("wallClockP50", fmt(left.latency?.wallClockMs?.p50), fmt(right.latency?.wallClockMs?.p50)),
    row("wallClockP95", fmt(left.latency?.wallClockMs?.p95), fmt(right.latency?.wallClockMs?.p95)),
  ].join("\n");
}

export async function runCommand(argv: string[]): Promise<number> {
  const leftPath = value(argv, "--left");
  const rightPath = value(argv, "--right");
  const left = JSON.parse(await Bun.file(leftPath).text()) as StatsSummary;
  const right = JSON.parse(await Bun.file(rightPath).text()) as StatsSummary;
  console.log(renderComparison(left, right));
  return 0;
}

if (import.meta.main) {
  runCommand(Bun.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
