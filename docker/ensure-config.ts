import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.FROGPROGSY_HOME || "/config";
const configPath = join(home, "config.json");
const bindHostname = process.env.FROGP_DOCKER_BIND_HOSTNAME || "0.0.0.0";
const port = Number(process.env.FROGP_DOCKER_PORT || "3764");

function defaultConfig() {
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3764,
    hostname: bindHostname,
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-sonnet-4-6",
      },
    },
    defaultProvider: "anthropic",
    websockets: false,
  };
}

function atomicWrite(path: string, content: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

mkdirSync(home, { recursive: true, mode: 0o700 });

let config: Record<string, unknown> = defaultConfig();
if (existsSync(configPath)) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = { ...defaultConfig(), ...parsed };
    }
  } catch {
    config = defaultConfig();
  }
}

// Docker port publishing needs the proxy to bind beyond container loopback.
// Make the bind host explicit and overridable via FROGP_DOCKER_BIND_HOSTNAME.
config.hostname = bindHostname;
if (typeof config.port !== "number" || !Number.isFinite(config.port)) {
  config.port = 3764;
}

atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
