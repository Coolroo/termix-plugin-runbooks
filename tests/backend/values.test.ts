import { describe, expect, it } from "vitest";
import {
  applyCaptures,
  checkCaptures,
  checkValues,
  commandHash,
  placeholders,
  resolve,
} from "../../src/backend/values/values";
import { resolveStep } from "../../src/backend/values/effective";
import type { StepRow } from "../../src/backend/runbooks/store/types";

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

describe("resolved commands and their hashes", () => {
  // Pinned: a person approves this exact text and hash, so a change to how
  // {{name}} is filled must not move either.
  const cases: Array<{
    command: string;
    values: Record<string, string>;
    text: string;
    missing: string[];
    hash: string | null;
    stdinHash: string | null;
  }> = [
    {
      command: "deploy {{app}} to {{ host }}",
      values: { app: "web", host: "h1" },
      text: "deploy web to h1",
      missing: [],
      hash: "cbcd38f53ac57d52f17ee14fe005781a4f8477d1147e009010d64c36b2c7edf9",
      stdinHash:
        "e700e5a945856d27aabd4445dede86eadd3e741a3f9b2d02e01c826bd4f0d643",
    },
    {
      command: "rm {{f}}; echo {{g}} {{h}} {{g}}",
      values: { f: "a; b" },
      text: "rm a; b; echo {{g}} {{h}} {{g}}",
      missing: ["g", "h"],
      hash: null,
      stdinHash: null,
    },
    {
      command: "{{x}}-{{x}}-{{ x }}",
      values: { x: "1" },
      text: "1-1-1",
      missing: [],
      hash: "7f891759551e8861707099b9d4598625702fc339956d8158da3baad1cb6cf3ff",
      stdinHash:
        "e72e09801cd8e56f5305bfc2d201e1cd846623c93db8af1c14ebf9a5c7fe1435",
    },
    {
      command: "{{a}}{{b}}{{a}}",
      values: { a: "A", b: "B" },
      text: "ABA",
      missing: [],
      hash: "802843eeb6948a420ab38a39e3edd3caba1f61a38a415f6baef7700560c78ab9",
      stdinHash:
        "3fe6a90e0bacceca75c13b8e0bbb3a9e20801942ddc8790c0c2eadc66f426d76",
    },
    {
      command: "{{a}}{{b}}",
      values: { a: "x" },
      text: "x{{b}}",
      missing: ["b"],
      hash: null,
      stdinHash: null,
    },
    {
      // Replacement patterns in a value go in as they are.
      command: "{{d}}",
      values: { d: "$1 $& $$ $`|$'" },
      text: "$1 $& $$ $`|$'",
      missing: [],
      hash: "d79646020e119d0fb6f77ba552ff3fd4748b6c8a905b266c62f1396e10ece443",
      stdinHash:
        "b8f3bd930375c3634bf24557190c3522f6d401dbb24103ce4b6f4c5ea71a070b",
    },
    {
      command: "awk '{print $1}' {{{x}}} {{ x}} {{x }} {{ 1x }} {x} {{}} {{",
      values: { x: "v" },
      text: "awk '{print $1}' {v} v v {{ 1x }} {x} {{}} {{",
      missing: [],
      hash: "3bbadf9008b069f60b9a89b9fdd3db9cc1b161bba4cfd33f1f4f2b632f07e48b",
      stdinHash:
        "8a354fa7766cd8cc8f574ec233b0d8a243f6664b948c7cf3213284744b60ce91",
    },
    {
      // A value that looks like a placeholder is not filled again.
      command: "{{a}}",
      values: { a: "{{b}}", b: "no" },
      text: "{{b}}",
      missing: [],
      hash: "19dda03384405210246f5b9ab51adc963e7b3debea32d3bdd47924a8afe01c89",
      stdinHash:
        "8c77cdf6697f66a7ef4ab6e0d9d73a374d4a365845610c4535301afefba25bbb",
    },
    {
      command: "{{l}}",
      values: { l: "line1\nzwei – drei ✓\n" },
      text: "line1\nzwei – drei ✓\n",
      missing: [],
      hash: "d67bf3df24a6e1640974b76d515150afba0417822628418f69d889ff74bea850",
      stdinHash:
        "5329ccdc0d40dd87316759e498f16981b191e4d67a2049f257e277f61ad7d8a7",
    },
    {
      command: "{{y.z}} {{a-b}}",
      values: { "y.z": "a.b-c", "a-b": "A-B" },
      text: "a.b-c A-B",
      missing: [],
      hash: "0331a5aa1eb2fb65217f8132400d91f49caeecdd71cccc426a1af06221d79418",
      stdinHash:
        "c2c3c50373b61a1f8e7020db36e3d19de7cb618301e23c01b86e3473a9ca14b4",
    },
    {
      command: "{{toString}} {{constructor}} {{toString}}",
      values: {},
      text: "{{toString}} {{constructor}} {{toString}}",
      missing: ["toString", "constructor"],
      hash: null,
      stdinHash: null,
    },
  ];

  it.each(cases)("$command", (entry) => {
    expect(resolve(entry.command, entry.values)).toEqual({
      text: entry.text,
      missing: entry.missing,
    });
    const step = { command: entry.command, hostId: 7 } as StepRow;
    expect(resolveStep(step, entry.values)).toEqual({
      command: entry.text,
      hash: entry.hash,
      missing: entry.missing,
    });
    expect(
      resolveStep(step, entry.values, {
        from: "step",
        step: 2,
        stream: "stdout",
      }).hash,
    ).toBe(entry.stdinHash);
  });
});
