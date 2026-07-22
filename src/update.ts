import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import {
  DEFAULT_PORT,
  loadConfig,
  readActivePort,
  readPid,
  removePid,
  removeActivePort,
  writeShutdownIntent,
} from "./config";
import { parseEnvFlag } from "./watchdog";

const PKG = "frogprogsy";
const HERE = dirname(fileURLToPath(import.meta.url)); // .../frogprogsy/src

type Installer = "bun" | "source" | "unsupported";

function bunGlobalPackageRoot(): string | null {
  const result = spawnSync("bun", ["pm", "bin", "-g"], { encoding: "utf8", timeout: 12000, windowsHide: true });
  if (result.status !== 0) return null;
  const binDir = result.stdout.trim();
  for (const name of ["frogp", "frogp.exe", "frogp.cmd"]) {
    const bin = join(binDir, name);
    if (!existsSync(bin)) continue;
    try {
      return dirname(dirname(realpathSync(bin)));
    } catch {
      return null;
    }
  }
  return null;
}

/** Infer whether frogprogsy is a Bun global package, a source checkout, or unsupported. */
export function detectInstall(): Installer {
  if (!HERE.split(sep).includes("node_modules")) return "source";
  try {
    return bunGlobalPackageRoot() === realpathSync(join(HERE, "..")) ? "bun" : "unsupported";
  } catch {
    return "unsupported";
  }
}

function currentVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version as string) ?? "?";
  } catch {
    return "?";
  }
}

function isDevPackageInstall(): boolean {
  return existsSync(join(HERE, "..", ".frogprogsy-dev-build.json"));
}

/** Latest published version from the package registry through Bun. */
function latestVersion(): string | null {
  const r = spawnSync("bun", ["pm", "view", PKG, "version"], { encoding: "utf8", timeout: 12000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Health-poll helper (inlined — do not import from cli.ts to avoid circularity)
// ---------------------------------------------------------------------------

async function pollHealthz(resolvePort: () => number, timeoutMs = 12_000): Promise<{ ok: boolean; port: number }> {
  const deadline = Date.now() + timeoutMs;
  let port = resolvePort();
  while (Date.now() < deadline) {
    port = resolvePort(); // re-resolve each poll: the respawned proxy may pick a new port (findAvailablePort)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(750),
      });
      if (res.ok) return { ok: true, port };
    } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 200));
  }
  return { ok: false, port };
}

// ---------------------------------------------------------------------------
// Kill helper (inlined — do not import from cli.ts to avoid circularity)
// ---------------------------------------------------------------------------

function killRunningProxy(): void {
  const pid = readPid();
  if (!pid) return;
  try {
    writeShutdownIntent(pid);
    process.kill(pid, "SIGTERM");
    // Spin-wait up to 5 s for the process to exit.
    const deadline = Date.now() + 5_000;
    const marker = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; } // gone
      Atomics.wait(marker, 0, 0, 50);
    }
  } catch { /* already gone */ }
  removePid();
  removeActivePort();
}

// ---------------------------------------------------------------------------
// Public API (exported for tests)
// ---------------------------------------------------------------------------

/**
 * After a successful install-managed update, write shutdown intent, stop the running proxy,
 * spawn `frogp start` detached, then poll /healthz until healthy or deadline.
 * Exits the process with code 1 on failure.
 */
export async function ensureAfterUpdate(): Promise<void> {
  console.log("♻️  Restarting proxy after update…");
  killRunningProxy();

  const child = spawn(process.execPath, [process.argv[1], "start"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const result = await pollHealthz(() => readActivePort() ?? loadConfig().port ?? DEFAULT_PORT);
  if (!result.ok) {
    console.error(
      `❌ Proxy did not become healthy on port ${result.port} after update. Run: frogp start`,
    );
    process.exit(1);
  }
  console.log(`✅ Proxy restarted and healthy on port ${result.port}.`);
}

/**
 * Decide what to do after a successful non-source update:
 * - source install → print manual hint
 * - FROGP_EXTERNAL_SUPERVISOR set → print external-supervisor restart hint
 * - otherwise → auto-ensure (stop + detached respawn + health poll)
 */
export async function planUpdateRestart(installer: Installer): Promise<void> {
  if (installer === "source") {
    console.log("Restart the proxy:  git pull && bun install && frogp stop && frogp start");
    return;
  }
  if (installer === "unsupported") {
    console.log("Unsupported package manager: reinstall with Bun before restarting.");
    return;
  }
  if (parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR)) {
    // External-supervisor-managed proxies re-inject on their own restart; skip auto-ensure.
    console.log(
      "External-supervisor-managed proxy: the supervisor will restart. Or run manually: frogp stop && frogp start",
    );
    return;
  }
  await ensureAfterUpdate();
}

/**
 * `frogp update` — self-update a Bun-managed global package. Source checkouts
 * use git pull; packages installed by another manager are rejected explicitly.
 */
export async function runUpdate(noRestart = false): Promise<void> {

  const installer = detectInstall();
  const current = currentVersion();
  console.log(`frogprogsy v${current} (installed via ${installer})`);

  if (installer === "source") {
    console.log("Running from a source checkout — update with:  git pull && bun install");
    return;
  }
  if (installer === "unsupported") {
    console.error("⚠️  This installation is not managed by Bun.");
    console.error("    Reinstall with Bun: bun add -g frogprogsy");
    process.exit(1);
  }
  if (isDevPackageInstall()) {
    console.error("⚠️  This is an explicitly installed development build.");
    console.error("    Replace it from the source repository with: bun run dev:package reinstall --yes");
    process.exit(1);
  }

  const latest = latestVersion();
  if (latest === null) {
    console.error("⚠️  Could not find frogprogsy in the package registry (not published yet, or the registry is unreachable).");
    console.error("    Nothing was changed. If you installed from a git checkout, update with: git pull && bun install");
    process.exit(1);
  }
  if (latest === current) {
    console.log(`Already on the latest version (v${latest}).`);
    return;
  }

  const cmdArgs = ["add", "-g", `${PKG}@latest`];
  console.log(`Updating to v${latest}…\n$ bun ${cmdArgs.join(" ")}`);

  const r = spawnSync("bun", cmdArgs, { stdio: "inherit", timeout: 180000, windowsHide: true });
  if (r.status === 0) {
    console.log(`\n✅ Updated to v${latest}.`);
    if (noRestart) {
      console.log("Restart the proxy manually: frogp stop && frogp start");
    } else {
      await planUpdateRestart(installer);
    }
  } else {
    console.error(`\n⚠️  Update failed (bun exit ${r.status ?? "?"}). Try manually: bun ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
}
