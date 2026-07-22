const BUILD_STATUSES = new Set(["ok", "missing", "malformed", "version-mismatch", "source-mismatch-dev"]);

export type GuiBuildSkewKind = "old-server" | "artifact-problem" | "bundle-mismatch";

export interface GuiBuildSkewNotice {
  kind: GuiBuildSkewKind;
  status: string;
  expectedBuildId: string;
  servedBuildId: string | null;
}

function readStringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function detectGuiBuildSkewNotice(healthz: unknown, currentBuildId: string): GuiBuildSkewNotice | null {
  if (!healthz || typeof healthz !== "object" || Array.isArray(healthz)) return null;
  const data = healthz as Record<string, unknown>;
  const status = readStringField(data, "guiBuildStatus");
  const servedBuildId = readStringField(data, "guiBuildId");

  if (!status) {
    return { kind: "old-server", status: "old-server", expectedBuildId: currentBuildId, servedBuildId };
  }
  if (!BUILD_STATUSES.has(status) || status !== "ok") {
    return { kind: "artifact-problem", status, expectedBuildId: currentBuildId, servedBuildId };
  }
  if (servedBuildId && servedBuildId !== currentBuildId) {
    return { kind: "bundle-mismatch", status, expectedBuildId: currentBuildId, servedBuildId };
  }
  return null;
}
