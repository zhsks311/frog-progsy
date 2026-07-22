#!/usr/bin/env bun

const COMMANDS = [
  "prepare-home",
  "hash-config",
  "serve",
  "health",
  "stop-server",
  "run",
  "grade",
  "diagnostics",
  "stats",
  "compare",
] as const;

type Command = typeof COMMANDS[number];

function usage(): void {
  console.error([
    "Usage: bun tools/eval-fusion.ts <cmd> [args]",
    `Commands: ${COMMANDS.join(", ")}`,
  ].join("\n"));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || !COMMANDS.includes(cmd as Command)) {
    usage();
    return 2;
  }

  try {
    const mod = await import(`../evals/fusion/src/${cmd}.ts`);
    if (typeof mod.runCommand !== "function") {
      console.error(`Command ${cmd} does not export runCommand(argv: string[]): Promise<number>`);
      return 2;
    }
    return await mod.runCommand(rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
