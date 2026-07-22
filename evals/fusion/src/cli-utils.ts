export function parseFlags(argv: string[]): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    if (!key) throw new Error("Empty flag is not allowed");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, true);
    } else {
      out.set(key, next);
      i++;
    }
  }
  return out;
}

export function requireString(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required --${name} <value>`);
  return value;
}

export function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected --${name} <value>`);
  return value;
}

export function hasFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}
