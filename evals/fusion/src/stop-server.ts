import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { parseFlags, requireString } from "./cli-utils";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isDefunctProcess(pid: number): boolean {
  try {
    const stat = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
    return stat.startsWith("Z");
  } catch {
    return false;
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removePidFile(pidFile: string): void {
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

async function waitUntilStopped(pid: number, timeoutMs: number): Promise<"stopped" | "defunct" | "alive"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return "stopped";
    if (isDefunctProcess(pid)) return "defunct";
    await sleep(100);
  }
  if (!isAlive(pid)) return "stopped";
  if (isDefunctProcess(pid)) return "defunct";
  return "alive";
}

export async function runCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const pidFile = requireString(flags, "pid-file");
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid pid in ${pidFile}: ${raw}`);

  if (!isAlive(pid) || isDefunctProcess(pid)) {
    removePidFile(pidFile);
    console.log(isAlive(pid) ? `server stopped as defunct zombie: ${pid}` : `server already stopped: ${pid}`);
    return 0;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removePidFile(pidFile);
    console.log(`server already stopped: ${pid}`);
    return 0;
  }
  const afterTerm = await waitUntilStopped(pid, 5000);
  if (afterTerm !== "alive") {
    removePidFile(pidFile);
    console.log(afterTerm === "defunct" ? `server stopped as defunct zombie: ${pid}` : `server stopped: ${pid}`);
    return 0;
  }

  console.warn(`server did not stop after SIGTERM within 5000ms; sending SIGKILL: ${pid}`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    removePidFile(pidFile);
    console.log(`server stopped before SIGKILL: ${pid}`);
    return 0;
  }
  const afterKill = await waitUntilStopped(pid, 5000);
  if (afterKill !== "alive") {
    removePidFile(pidFile);
    console.log(afterKill === "defunct" ? `server killed and left defunct zombie: ${pid}` : `server killed: ${pid}`);
    return 0;
  }

  removePidFile(pidFile);
  console.error(`server still alive after SIGKILL: ${pid}`);
  return 1;
}
