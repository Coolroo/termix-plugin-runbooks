/**
 * What agents may see of a runbook's output and values (BUG-010): the one
 * mask that the agent view and every when rule use. A step hidden from
 * agents shows "[hidden by owner]" for its output and its captured values,
 * and a value it captured is replaced wherever other text holds it. A rule
 * that reads only what this mask gives cannot tell an agent anything that
 * the agent view does not already show.
 *
 * BUG-011: what a hidden step shows depends only on facts agents see (its
 * runs, their mode and status), never on what it printed or captured. A
 * step that reads hidden data on standard input counts as hidden, and text
 * an agent wrote, or a person's choice, is never masked: a mask there would
 * show whether that text equals a hidden value.
 */

import crypto from "node:crypto";
import type { RunRow, StepRow } from "../runbooks/store/types.js";
import type { EffectiveValue, RunMode } from "../../shared/api.js";
import { escapePattern } from "../../shared/checks.js";
import { stepCaptures } from "../values/effective.js";

export const HIDDEN = "[hidden by owner]";

/** A hidden value shorter than this is not replaced in other text. */
const MIN_MASKED = 4;

/**
 * Runs in these modes take captures from the output they end with; a
 * decision run holds its value (a hidden decision from before BUG-010).
 */
const CAPTURING: ReadonlySet<RunMode> = new Set([
  "exec",
  "terminal",
  "outside",
  "decision",
]);

/** The fields of a step the mask reads. */
type MaskStep = Pick<
  StepRow,
  "id" | "hideOutputFromAgents" | "stdin" | "captures" | "decision"
>;

/** The fields of a run that hold output or values. */
type RunOutput = Pick<
  RunRow,
  | "stepId"
  | "mode"
  | "status"
  | "stdout"
  | "stderr"
  | "pastedOutput"
  | "captured"
>;

export interface AgentMask {
  /**
   * The steps whose output agents do not see: those that hide it, and
   * those that read a hidden step's output or a hidden value on standard
   * input (BUG-011).
   */
  hiddenSteps: ReadonlySet<number>;
  /** Names a cache by this mask: it changes when the replaced texts do. */
  key: string;
  /** The text with each hidden value replaced. */
  text: (value: string | null) => string | null;
  /** A run's output and captured values as agents read them. */
  run: <T extends RunOutput>(run: T) => T;
  /**
   * The values a step's runs captured, oldest run first, as agents read
   * them. A hidden step that ended done in a run that takes captures shows
   * each capture it declares, hidden, whether it matched or not (BUG-011).
   */
  stepValues: (
    step: Pick<StepRow, "id" | "status" | "captures" | "decision">,
    runsByStep: Map<number, readonly RunRow[]>,
  ) => EffectiveValue[];
}

/**
 * The steps hidden from agents (BUG-011): those that hide their output, and
 * those whose standard input is a hidden step's output or a value that a
 * hidden step captures, worked out again until nothing changes.
 */
export function hiddenStepIds(steps: ReadonlyArray<MaskStep>): Set<number> {
  const hidden = new Set<number>();
  const names = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (hidden.has(step.id)) continue;
      const stdin = step.stdin;
      if (
        step.hideOutputFromAgents ||
        (stdin?.from === "step" && hidden.has(stdin.stepId)) ||
        (stdin?.from === "value" && names.has(stdin.name))
      ) {
        hidden.add(step.id);
        for (const name of valueNames(step)) names.add(name);
        changed = true;
      }
    }
  }
  return hidden;
}

/** The values a step sets: its captures and its decision's value. */
function valueNames(step: Pick<StepRow, "captures" | "decision">): string[] {
  return [
    ...step.captures.map((capture) => capture.name),
    ...(step.decision?.value ? [step.decision.value] : []),
  ];
}

/** A hidden step's run ended with captures: they show, hidden. */
function capturedHidden(run: Pick<RunRow, "mode" | "status">): boolean {
  return run.status === "done" && CAPTURING.has(run.mode);
}

/**
 * The mask for a runbook: `runs` are all its runs, since a hidden step's
 * earlier runs captured values that later text may still hold.
 */
export function agentMask(
  steps: ReadonlyArray<MaskStep>,
  runs: Iterable<Pick<RunRow, "stepId" | "captured">>,
): AgentMask {
  const hiddenSteps = hiddenStepIds(steps);
  const declared = new Map(steps.map((step) => [step.id, valueNames(step)]));
  const found = new Set<string>();
  for (const run of runs) {
    if (!hiddenSteps.has(run.stepId)) continue;
    for (const value of Object.values(run.captured ?? {})) {
      // Very short values would mask unrelated text and say little anyway.
      if (value.length < MIN_MASKED) continue;
      found.add(value);
      // As a check's pattern holds it (BUG-007).
      found.add(escapePattern(value));
    }
  }
  const texts = [...found].sort((a, b) => b.length - a.length);
  const text = (value: string | null) => {
    if (value === null) return value;
    let out = value;
    for (const secret of texts) out = out.split(secret).join(HIDDEN);
    return out;
  };
  const hiddenText = (value: string | null) =>
    value === null ? value : HIDDEN;
  const hiddenCaptures = (stepId: number) =>
    Object.fromEntries(
      (declared.get(stepId) ?? []).map((name) => [name, HIDDEN]),
    );
  return {
    hiddenSteps,
    key: crypto
      .createHash("sha256")
      .update(texts.join("\0"))
      .update(`\0\0${[...hiddenSteps].sort((a, b) => a - b).join(",")}`)
      .digest("base64"),
    text,
    run(run) {
      if (hiddenSteps.has(run.stepId)) {
        return {
          ...run,
          stdout: hiddenText(run.stdout),
          stderr: hiddenText(run.stderr),
          pastedOutput: hiddenText(run.pastedOutput),
          captured: capturedHidden(run) ? hiddenCaptures(run.stepId) : {},
        };
      }
      // An agent's own output, and the ids a person chose, as written.
      if (run.mode === "agent" || run.mode === "decision") return run;
      return {
        ...run,
        stdout: text(run.stdout),
        stderr: text(run.stderr),
        pastedOutput: text(run.pastedOutput),
        // A visible step's capture may hold a hidden value too (BUG-010).
        captured:
          run.captured &&
          Object.fromEntries(
            Object.entries(run.captured).map(([name, value]) => [
              name,
              text(value)!,
            ]),
          ),
      };
    },
    stepValues(step, runsByStep) {
      if (hiddenSteps.has(step.id)) {
        const ended = [...(runsByStep.get(step.id) ?? [])]
          .filter(capturedHidden)
          .filter((run) => run.mode !== "decision" || step.status === "done")
          .sort((a, b) => b.id - a.id)[0];
        if (!ended) return [];
        return valueNames(step).map((name) => ({
          name,
          value: HIDDEN,
          source: "capture" as const,
          stepId: step.id,
          runId: ended.id,
        }));
      }
      // A decision's value is one of the author's option ids.
      const keep = step.decision !== null;
      return stepCaptures(step, runsByStep).map(({ name, value, runId }) => ({
        name,
        value: keep ? value : text(value)!,
        source: "capture" as const,
        stepId: step.id,
        runId,
      }));
    },
  };
}
