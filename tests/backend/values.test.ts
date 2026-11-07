import { describe, expect, it } from "vitest";
import {
  applyCaptures,
  checkCaptures,
  checkValues,
  commandHash,
  placeholders,
  resolve,
} from "../../src/backend/values";

describe("values", () => {
  it("finds and resolves placeholders literally", () => {
    expect(placeholders("a {{x}} {{ y.z }} {{x}} {{1no}} {x}")).toEqual([
      "x",
      "y.z",
    ]);
    expect(resolve("rm {{f}}; echo {{g}}", { f: "a; b" })).toEqual({
      text: "rm a; b; echo {{g}}",
      missing: ["g"],
    });
    // A value that looks like a placeholder is not resolved again.
    expect(resolve("{{a}}", { a: "{{b}}", b: "no" }).text).toBe("{{b}}");
    expect(resolve("{{toString}}", {}).missing).toEqual(["toString"]);
  });

  it("hashes host and command together", () => {
    expect(commandHash(1, "ls")).not.toBe(commandHash(2, "ls"));
    expect(commandHash(1, "ls")).toBe(commandHash(1, "ls"));
    expect(commandHash(1, "ls")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks names, values and capture patterns", () => {
    expect(checkValues({ ok_1: "v", "a.b-c": "" })).toBeNull();
    expect(checkValues({ "bad name": "v" })).toMatch(/must match/);
    expect(checkValues({ a: 1 })).toMatch(/string/);
    expect(checkValues([])).toMatch(/object/);
    expect(checkCaptures([{ name: "a", pattern: "x(\\d+)" }])).toBeNull();
    expect(checkCaptures([{ name: "a", pattern: "x(?:\\d+)" }])).toMatch(
      /one capturing group/,
    );
    expect(checkCaptures([{ name: "a", pattern: "(" }])).toMatch(/valid/);
  });

  it("captures the first match and stops a runaway pattern", () => {
    const { values } = applyCaptures(
      [
        { name: "a", pattern: "id=(\\w+)" },
        { name: "b", pattern: "nope=(\\w+)" },
      ],
      "id=one id=two",
    );
    expect(values).toEqual({ a: "one" });

    const started = Date.now();
    const slow = applyCaptures(
      [{ name: "x", pattern: "^(a+)+$" }],
      "a".repeat(40) + "!",
    );
    expect(slow.values).toEqual({});
    expect(slow.errors[0]).toMatch(/did not finish/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
