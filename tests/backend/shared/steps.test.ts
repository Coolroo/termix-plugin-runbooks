import { describe, expect, it } from "vitest";
import {
  compareSteps,
  isAgentStep,
  isOutsideStep,
  parseStepRef,
  stepLabel,
  suffixAt,
  suffixIndex,
} from "../../../src/shared/steps";

describe("step numbers", () => {
  it("order (position, suffix) and read 3, '3' and '3a'", () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(suffixAt)).toEqual([
      "a",
      "b",
      "z",
      "aa",
      "ab",
      "zz",
      "aaa",
    ]);
    for (const n of [0, 5, 25, 26, 300, 702]) {
      expect(suffixIndex(suffixAt(n))).toBe(n);
    }
    const sorted = [
      { position: 4, suffix: null },
      { position: 3, suffix: "aa" },
      { position: 3, suffix: "b" },
      { position: 3, suffix: null },
      { position: 3, suffix: "a" },
    ].sort(compareSteps);
    expect(sorted.map(stepLabel)).toEqual(["3", "3a", "3b", "3aa", "4"]);
    expect(parseStepRef(3)).toEqual({ position: 3, suffix: null });
    expect(parseStepRef("3")).toEqual({ position: 3, suffix: null });
    expect(parseStepRef("3a")).toEqual({ position: 3, suffix: "a" });
    for (const bad of [0, -1, 1.5, "a3", "3A", "03", "", null]) {
      expect(parseStepRef(bad)).toBeNull();
    }
  });

  it("tells an agent step and a step run outside Termix", () => {
    expect(isAgentStep({ owner: "agent" })).toBe(true);
    expect(isAgentStep({ owner: "person" })).toBe(false);
    expect(isAgentStep({})).toBe(false);
    expect(isOutsideStep({ where: "Windows PC", command: "Get-Date" })).toBe(
      true,
    );
    expect(isOutsideStep({ where: "Windows PC", command: null })).toBe(false);
    expect(isOutsideStep({ where: null, command: "ls" })).toBe(false);
    expect(isOutsideStep({ where: "", command: "ls" })).toBe(false);
  });
});
