import { describe, expect, it } from "vitest";
import {
  isOneLine,
  NAME,
  PLACEHOLDER,
  regexProblem,
  secretLabel,
  secretNameProblem,
} from "../../../src/shared/names";

describe("names and patterns", () => {
  it("a placeholder holds a name", () => {
    const names = [..."{{a}} {{ b.c-d }} {{1x}} {{_e}}".matchAll(PLACEHOLDER)];
    expect(names.map((match) => match[1])).toEqual(["a", "b.c-d", "_e"]);
    for (const [, name] of names) expect(NAME.test(name)).toBe(true);
  });

  it("checks a secret name", () => {
    expect(secretNameProblem("api_token", "secret name")).toBeNull();
    expect(secretNameProblem("1x", "stdin.name")).toBe(
      `stdin.name must match ${NAME.source}`,
    );
    expect(secretNameProblem(7, "ask.name")).toMatch(/must match/);
    expect(secretNameProblem("x".repeat(65), "ask.name")).toBe(
      "ask.name is longer than 64 characters",
    );
  });

  it("checks a regular expression an author writes", () => {
    expect(regexProblem("^ok (\\d+)$", "pattern", 300)).toBeNull();
    expect(regexProblem("", "pattern", 300)).toBe(
      "pattern must be a regular expression",
    );
    expect(regexProblem(3, "ask.pattern", 300, "say so")).toBe("say so");
    expect(regexProblem("x".repeat(11), "matches", 10)).toBe(
      "matches is longer than 10 characters",
    );
    expect(regexProblem("(", "pattern", 300)).toBe(
      "pattern is not a valid regular expression",
    );
  });

  it("tells one line from text with control characters", () => {
    expect(isOneLine("web-1 · console")).toBe(true);
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb"]) {
      expect(isOneLine(bad)).toBe(false);
    }
  });

  it("names the secret a stdin source reads", () => {
    expect(secretLabel({ from: "secret", name: "api_token" })).toBe(
      "api_token",
    );
    expect(secretLabel({ from: "secret", library: "shared/db" })).toBe(
      "shared/db",
    );
    expect(secretLabel({ from: "value", name: "x" })).toBeNull();
    expect(secretLabel(null)).toBeNull();
  });
});
