import { optionalString, parseFlags, requireString } from "./cli-utils";

function modelMatches(item: unknown, expected: string): boolean {
  if (!item || typeof item !== "object") return false;
  const row = item as Record<string, unknown>;
  return row.id === expected || row.display_name === expected || row.routeKey === expected;
}

export async function runCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const proxy = requireString(flags, "proxy").replace(/\/$/, "");
  const expectedModel = optionalString(flags, "expect-model");

  let health: Response;
  try {
    health = await fetch(`${proxy}/healthz`);
  } catch (err) {
    console.error(`healthz failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!health.ok) {
    console.error(`healthz failed: HTTP ${health.status} ${await health.text()}`);
    return 1;
  }
  const healthJson = await health.json() as { status?: string };
  if (healthJson.status !== "ok") {
    console.error(`healthz returned non-ok status: ${JSON.stringify(healthJson)}`);
    return 1;
  }

  let models: Response;
  try {
    models = await fetch(`${proxy}/v1/models`);
  } catch (err) {
    console.error(`/v1/models failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!models.ok) {
    console.error(`/v1/models failed: HTTP ${models.status} ${await models.text()}`);
    return 1;
  }
  const modelsJson = await models.json() as { data?: unknown[] };
  if (!Array.isArray(modelsJson.data)) {
    console.error(`/v1/models returned invalid payload: ${JSON.stringify(modelsJson)}`);
    return 1;
  }
  if (expectedModel && !modelsJson.data.some(item => modelMatches(item, expectedModel))) {
    const seen = modelsJson.data.map(item => {
      if (!item || typeof item !== "object") return String(item);
      const row = item as Record<string, unknown>;
      return `${String(row.id)}${row.display_name ? ` (${String(row.display_name)})` : ""}`;
    });
    console.error(`expected model ${expectedModel} not found in /v1/models. Saw: ${seen.join(", ")}`);
    return 1;
  }

  console.log(`health ok: ${proxy}`);
  return 0;
}
