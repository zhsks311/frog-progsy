import { createHash } from "node:crypto";
import { mkdir, readFile, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type SharedAssetCopy = {
  source: string;
  target: string;
  reason: string;
};

export type SharedAssetMismatch = SharedAssetCopy & {
  sourceSha256: string;
  targetSha256: string | null;
};

export const SHARED_ASSET_COPIES: readonly SharedAssetCopy[] = [
  {
    source: "assets/dashboard.png",
    target: "docs-site/src/assets/dashboard.png",
    reason: "docs-site home page dashboard image",
  },
  {
    source: "assets/claude-app-picker.png",
    target: "docs-site/src/assets/claude-app-picker.png",
    reason: "docs-site model picker image",
  },
  {
    source: "assets/logo-light.png",
    target: "docs-site/src/assets/logo-light.png",
    reason: "docs-site light theme logo",
  },
  {
    source: "assets/logo-dark.png",
    target: "docs-site/src/assets/logo-dark.png",
    reason: "docs-site dark theme logo",
  },
  {
    source: "assets/logo-light.png",
    target: "gui/public/logo.png",
    reason: "GUI public logo; GUI currently uses one neutral logo file",
  },
] as const;

function abs(path: string): string {
  return resolve(process.cwd(), path);
}

async function sha256(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(abs(path));
    return createHash("sha256").update(bytes).digest("hex");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function findSharedAssetMismatches(): Promise<SharedAssetMismatch[]> {
  const mismatches: SharedAssetMismatch[] = [];

  for (const copy of SHARED_ASSET_COPIES) {
    const sourceSha256 = await sha256(copy.source);
    if (!sourceSha256) throw new Error(`Missing shared asset source: ${copy.source}`);

    const targetSha256 = await sha256(copy.target);
    if (targetSha256 !== sourceSha256) {
      mismatches.push({ ...copy, sourceSha256, targetSha256 });
    }
  }

  return mismatches;
}

export async function syncSharedAssets(): Promise<SharedAssetMismatch[]> {
  const mismatches = await findSharedAssetMismatches();

  for (const mismatch of mismatches) {
    await mkdir(dirname(abs(mismatch.target)), { recursive: true });
    await copyFile(abs(mismatch.source), abs(mismatch.target));
  }

  return mismatches;
}

function formatMismatch(mismatch: SharedAssetMismatch): string {
  const targetState = mismatch.targetSha256 ? mismatch.targetSha256.slice(0, 12) : "missing";
  return `${mismatch.target} <- ${mismatch.source} (${mismatch.reason}; target=${targetState}, source=${mismatch.sourceSha256.slice(0, 12)})`;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    const mismatches = await findSharedAssetMismatches();
    if (mismatches.length > 0) {
      throw new Error(`Shared brand assets are out of sync:\n${mismatches.map(formatMismatch).join("\n")}`);
    }
    console.log(`shared brand assets in sync (${SHARED_ASSET_COPIES.length} copies checked)`);
    return;
  }

  const copied = await syncSharedAssets();
  if (copied.length === 0) {
    console.log(`shared brand assets already in sync (${SHARED_ASSET_COPIES.length} copies checked)`);
    return;
  }

  console.log(`synced ${copied.length} shared brand asset copy/copies:`);
  for (const item of copied) console.log(`- ${item.target} <- ${item.source}`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
