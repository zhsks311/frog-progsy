import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseFlags, requireString } from "./cli-utils";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function runCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const configPath = requireString(flags, "config");
  const expectFile = requireString(flags, "expect-file");
  const actual = sha256File(configPath);
  const expected = readFileSync(expectFile, "utf8").trim();
  if (actual === expected) {
    console.log(`config sha256 ok: ${actual}`);
    return 0;
  }
  console.error([
    "config sha256 mismatch",
    `  config: ${configPath}`,
    `  expected (${expectFile}): ${expected}`,
    `  actual: ${actual}`,
  ].join("\n"));
  return 1;
}
