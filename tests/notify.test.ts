/**
 * tests/notify.test.ts — unit tests for src/notify.ts
 * No OS calls; only buildNotifyCommand (pure) is tested.
 */
import { describe, expect, test } from "bun:test";
import { buildNotifyCommand, GIVE_UP_MESSAGE, GIVE_UP_TITLE } from "../src/notify";

describe("buildNotifyCommand", () => {
  test("darwin returns osascript command with display notification", () => {
    const argv = buildNotifyCommand("darwin", "Test Title", "Test message");
    expect(argv[0]).toBe("osascript");
    expect(argv[1]).toBe("-e");
    expect(argv[2]).toContain("display notification");
    expect(argv[2]).toContain("Test message");
    expect(argv[2]).toContain("Test Title");
  });

  test("linux returns notify-send with title and message args", () => {
    const argv = buildNotifyCommand("linux", "Test Title", "Test message");
    expect(argv[0]).toBe("notify-send");
    expect(argv[1]).toBe("Test Title");
    expect(argv[2]).toBe("Test message");
  });

  test("win32 returns powershell command", () => {
    const argv = buildNotifyCommand("win32", "Test Title", "Test message");
    expect(argv[0]).toBe("powershell");
    expect(argv).toContain("-NonInteractive");
    expect(argv[argv.length - 1]).toContain("ToastNotification");
  });

  test("unknown platform returns a non-empty argv (best-effort echo)", () => {
    const argv = buildNotifyCommand("freebsd" as NodeJS.Platform, "Title", "Msg");
    expect(argv.length).toBeGreaterThan(0);
  });

  test("give-up message MUST contain 'frogp start'", () => {
    const allPlatforms: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    for (const p of allPlatforms) {
      const argv = buildNotifyCommand(p, GIVE_UP_TITLE, GIVE_UP_MESSAGE);
      const all = argv.join(" ");
      expect(all).toContain("frogp start");
    }
  });

  test("give-up message MUST contain 'frogp status'", () => {
    const allPlatforms: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    for (const p of allPlatforms) {
      const argv = buildNotifyCommand(p, GIVE_UP_TITLE, GIVE_UP_MESSAGE);
      const all = argv.join(" ");
      expect(all).toContain("frogp status");
    }
  });

  test("give-up message MUST NOT contain 'frogp service install'", () => {
    expect(GIVE_UP_MESSAGE).not.toContain("frogp service install");
    const allPlatforms: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    for (const p of allPlatforms) {
      const argv = buildNotifyCommand(p, GIVE_UP_TITLE, GIVE_UP_MESSAGE);
      const all = argv.join(" ");
      expect(all).not.toContain("frogp service install");
    }
  });

  test("give-up message constant contains 'frogp start' and 'frogp status' at module level", () => {
    expect(GIVE_UP_MESSAGE).toContain("frogp start");
    expect(GIVE_UP_MESSAGE).toContain("frogp status");
    expect(GIVE_UP_MESSAGE).not.toContain("frogp service install");
  });
});
