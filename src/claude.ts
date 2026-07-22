#!/usr/bin/env bun
import { runClaudeLauncherProcess } from "./claude-launchers";

try {
  await runClaudeLauncherProcess(process.argv.slice(2), "claude");
} catch (error) {
  console.error(`frogprogsy claude launcher failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
