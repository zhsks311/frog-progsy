import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FROGPROGSY_AUTH_FILE lets an isolated-config eval server share the real auth store so OAuth
// refresh-token rotation never forks the credential chain (a copied auth.json invalidates the
// original login on first refresh).
describe("FROGPROGSY_AUTH_FILE override", () => {
  test("loadAuthStore reads and saveCredential writes the override file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frog-authfile-"));
    const authFile = join(dir, "shared-auth.json");
    writeFileSync(authFile, JSON.stringify({ demo: { access: "a1", refresh: "r1", expires: 1 } }), { mode: 0o600 });

    const homeDir = mkdtempSync(join(tmpdir(), "frog-authfile-home-"));
    const prevHome = process.env.FROGPROGSY_HOME;
    const prevAuth = process.env.FROGPROGSY_AUTH_FILE;
    process.env.FROGPROGSY_HOME = homeDir; // isolated home WITHOUT its own auth.json
    process.env.FROGPROGSY_AUTH_FILE = authFile;
    try {
      const { loadAuthStore, saveCredential, getCredential } = await import("../src/oauth/store");
      expect(loadAuthStore().demo?.access).toBe("a1");

      saveCredential("demo", { access: "a2", refresh: "r2", expires: 2 } as never);
      // The write must land in the shared file, not the isolated home.
      const onDisk = JSON.parse(await Bun.file(authFile).text()) as Record<string, { access: string }>;
      expect(onDisk.demo.access).toBe("a2");
      expect(await Bun.file(join(homeDir, "auth.json")).exists()).toBe(false);
      expect(getCredential("demo")?.access).toBe("a2");
    } finally {
      if (prevHome === undefined) delete process.env.FROGPROGSY_HOME; else process.env.FROGPROGSY_HOME = prevHome;
      if (prevAuth === undefined) delete process.env.FROGPROGSY_AUTH_FILE; else process.env.FROGPROGSY_AUTH_FILE = prevAuth;
    }
  });
});
