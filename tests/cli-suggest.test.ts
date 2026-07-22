import { describe, expect, test } from "bun:test";
import { editDistance, suggestClosest } from "../src/cli-suggest";

describe("editDistance", () => {
  test("exact match is zero", () => {
    expect(editDistance("status", "status")).toBe(0);
  });

  test("insertion, deletion, and substitution each cost one", () => {
    expect(editDistance("statu", "status")).toBe(1); // insertion
    expect(editDistance("statuss", "status")).toBe(1); // deletion
    expect(editDistance("statas", "status")).toBe(1); // substitution
  });

  test("case is normalized before comparing", () => {
    expect(editDistance("STATUS", "status")).toBe(0);
    expect(editDistance("Statu", "status")).toBe(1);
  });

  test("empty strings degrade to the other string's length", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });
});

describe("suggestClosest", () => {
  const commands = ["init", "start", "stop", "status", "refresh", "login", "logout"];

  test("suggests within the default max distance of 2", () => {
    expect(suggestClosest("statu", commands)).toBe("status");
    expect(suggestClosest("refrsh", commands)).toBe("refresh");
    expect(suggestClosest("logn", commands)).toBe("login");
  });

  test("returns null beyond the max distance", () => {
    expect(suggestClosest("zzzzzzzz", commands)).toBe(null);
    expect(suggestClosest("completely-different", commands)).toBe(null);
  });

  test("respects a custom max distance", () => {
    expect(suggestClosest("stotr", commands, 1)).toBe(null);
    expect(suggestClosest("stakt", commands, 2)).toBe("start");
  });

  test("breaks ties by candidate iteration order", () => {
    // Both candidates are distance 1 from the input — the earlier one must win.
    expect(suggestClosest("ab", ["ax", "ay"])).toBe("ax");
    expect(suggestClosest("ab", ["ay", "ax"])).toBe("ay");
  });

  test("case-normalizes input against candidates", () => {
    expect(suggestClosest("STATU", commands)).toBe("status");
  });
});
