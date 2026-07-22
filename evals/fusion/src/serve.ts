import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FrogConfig } from "../../../src/types";
import { optionalString, parseFlags, parsePort, requireString } from "./cli-utils";

export async function runCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const home = resolve(requireString(flags, "home"));
  const host = optionalString(flags, "host") ?? "127.0.0.1";
  const port = parsePort(optionalString(flags, "port") ?? "3764");
  const pidFile = requireString(flags, "pid-file");

  const config = JSON.parse(readFileSync(`${home}/config.json`, "utf8")) as FrogConfig;
  const configuredHost = config.hostname ?? "127.0.0.1";
  if (host !== configuredHost) {
    console.error(`serve cannot bind --host ${host} with canonical config hostname ${configuredHost}. Prepare config with hostname=${host} to keep config hash stable.`);
    return 2;
  }

  process.env.FROGPROGSY_HOME = home;
  process.env.FROGPROGSY_NO_CLAUDE_WRITES = "1";
  // OAuth refresh tokens rotate on use — a copied auth.json forks the chain and kills the real
  // login. Share the live auth store instead (store re-reads per access, writes atomically).
  const authFile = optionalString(flags, "auth-file");
  if (authFile) process.env.FROGPROGSY_AUTH_FILE = resolve(authFile);
  const { startServer } = await import("../../../src/server");
  const server = startServer(port);
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });

  const shutdown = () => {
    try { server.stop(true); } finally { process.exit(0); }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise<never>(() => {});
}
