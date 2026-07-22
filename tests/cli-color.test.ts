import { describe, expect, test } from "bun:test";
import { colorize, dim, error, shouldColor, success, warn } from "../src/cli-color";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/;

describe("shouldColor", () => {
  test("TTY with no opt-out enables color", () => {
    expect(shouldColor({}, true)).toBe(true);
  });

  test("non-TTY disables color by default", () => {
    expect(shouldColor({}, false)).toBe(false);
  });

  test("NO_COLOR disables color even on a TTY", () => {
    expect(shouldColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldColor({ NO_COLOR: "anything" }, true)).toBe(false);
  });

  test("empty NO_COLOR value does not disable color", () => {
    expect(shouldColor({ NO_COLOR: "" }, true)).toBe(true);
  });

  test("FORCE_COLOR=1 enables color even when non-TTY", () => {
    expect(shouldColor({ FORCE_COLOR: "1" }, false)).toBe(true);
  });

  test("NO_COLOR wins over FORCE_COLOR=1", () => {
    expect(shouldColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
    expect(shouldColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, false)).toBe(false);
  });

  test("FORCE_COLOR values other than 1 do not force color", () => {
    expect(shouldColor({ FORCE_COLOR: "0" }, false)).toBe(false);
    expect(shouldColor({ FORCE_COLOR: "true" }, false)).toBe(false);
  });
});

describe("colorize", () => {
  test("wraps text with ANSI codes only when enabled", () => {
    const colored = colorize("done", "success", true);
    expect(colored).toMatch(ANSI_PATTERN);
    expect(colored).toContain("done");
    expect(colored.endsWith("\x1b[0m")).toBe(true);
  });

  test("returns text unchanged when disabled", () => {
    expect(colorize("done", "success", false)).toBe("done");
    expect(success("a", false)).toBe("a");
    expect(warn("b", false)).toBe("b");
    expect(error("c", false)).toBe("c");
    expect(dim("d", false)).toBe("d");
  });

  test("each palette entry produces a distinct escape", () => {
    const wrapped = new Set([
      success("x", true),
      warn("x", true),
      error("x", true),
      dim("x", true),
    ]);
    expect(wrapped.size).toBe(4);
  });
});
