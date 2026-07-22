import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { ensureConfigDirForWrite, getConfigDir } from "./config";
import { parseEnvFlag } from "./watchdog";

const REPO = "zhsks311/frog-progsy";
/** Fires exactly once from the first interactive `frogp start`. */
const MARKER = ".star-prompted";

function ghAvailable(): boolean {
  const r = spawnSync("gh", ["--version"], { stdio: "ignore", timeout: 3000, windowsHide: true });
  return !r.error && r.status === 0;
}

function starRepo(): { ok: boolean; error?: string } {
  const r = spawnSync("gh", ["api", "-X", "PUT", `/user/starred/${REPO}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "").trim() || `gh exited ${r.status}` };
  return { ok: true };
}

/**
 * First interactive `frogp start`: a one-time `[Y/n]` "star on GitHub?" prompt.
 * On yes, stars the repo via the user's `gh` auth. No-op under an external
 * supervisor, for non-TTY/piped runs, when already prompted, or when `gh` is
 * unavailable. Never throws.
 */
export async function maybeShowStarPrompt(): Promise<void> {
  try {
    if (parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR) || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const dir = getConfigDir();
    const marker = join(dir, MARKER);
    if (existsSync(marker)) return;
    if (!ghAvailable()) return; // can't star without gh — stay silent and re-check on a later start
    try { ensureConfigDirForWrite("write star prompt marker"); writeFileSync(marker, new Date().toISOString()); } catch { /* best-effort */ }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let yes = false;
    try {
      const ans = (await rl.question("\n  \x1b[38;5;141m⭐ Enjoying frogprogsy? Star it on GitHub?\x1b[0m [Y/n] ")).trim().toLowerCase();
      yes = ans === "" || ans === "y" || ans === "yes";
    } finally {
      rl.close();
    }
    if (!yes) return;
    const r = starRepo();
    console.log(r.ok ? "  Thanks for the star! ⭐\n" : `  Couldn't star automatically (${r.error}) — ${REPO}\n`);
  } catch { /* never let the star prompt disrupt startup */ }
}
