// Test-environment isolation preload.
//
// Registered via bunfig.toml `[test].preload`, this module runs once before the test files in every
// Bun test process. `bun test --isolate` gives each file a fresh global object, but `process.env` remains
// process-wide. This preload therefore owns one throwaway FROGPROGSY_HOME for the process and reasserts
// it before and after every test. Consequences:
//   - Tests never read or write the real ~/.frogprogsy — including a live proxy's config.json,
//     frogp.pid, or frogp.port (active-port) files. A proxy running on port 3764 is invisible.
//   - Even when the caller exports FROGPROGSY_HOME pointing at the real home, or a prior test deletes or
//     replaces it, the preload overwrites it before the next test.
//   - NODE_ENV=test is rearmed before every test so src/config.ts's default-dir write guard is a second fence.
//   - The caller's original env is restored and the captured temp dir is removed when the process exits.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach } from "bun:test";

const HOME_KEY = "FROGPROGSY_HOME";

// Capture whatever the caller had (possibly the REAL home) so it is restored verbatim on exit.
const originalHome = process.env[HOME_KEY];
const originalNodeEnv = process.env.NODE_ENV;

// A fresh, unique home for this test process. Absolute path from mkdtempSync.
export const isolatedHome = mkdtempSync(join(tmpdir(), "frogprogsy-test-home-"));

function forceIsolatedEnv(): void {
  process.env[HOME_KEY] = isolatedHome;
  process.env.NODE_ENV = "test";
}

forceIsolatedEnv();
beforeEach(forceIsolatedEnv);
afterEach(forceIsolatedEnv);

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  // Restore the caller's original env so the redirect is transparent to the parent process.
  if (originalHome === undefined) delete process.env[HOME_KEY];
  else process.env[HOME_KEY] = originalHome;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  try {
    rmSync(isolatedHome, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
}

// `exit` only allows synchronous work, which is exactly what env restore + rmSync need.
process.on("exit", cleanup);
afterAll(cleanup);
