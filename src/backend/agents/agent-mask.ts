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
 *
 * BUG-016: a hidden value from a small fixed set (a VM's state, a
 * decision's option id) is never replaced in other text, since whether
 * "running" is replaced tells which one it is. A step whose command,
 * checks or standard input reads such a value counts as hidden instead,
 * and so do the values it sets.
 */

import crypto from "node:crypto";
import type { RunRow, StepRow } from "../runbooks/store/types.js";
import type { EffectiveValue, RunMode } from "../../shared/api.js";
import { escapePattern } from "../../shared/checks.js";
import { stepCaptures } from "../values/effective.js";
import { placeholders } from "../values/values.js";
import { isAgentStep, stepValueNames } from "../../shared/steps.js";
import { runItems } from "../../shared/sequence.js";

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
  "vm",
]);

/** The fields of a step the mask reads. */
type MaskStep = Pick<
  StepRow,
  | "id"
  | "owner"
  | "hideOutputFromAgents"
  | "stdin"
  | "command"
  | "checks"
  | "captures"
  | "decision"
  | "vm"
  | "sequence"
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
    step: Pick<
      StepRow,
      "id" | "status" | "captures" | "decision" | "vm" | "sequence"
    >,
    runsByStep: Map<number, readonly RunRow[]>,
  ) => EffectiveValue[];
}

/** Which steps are hidden from agents, and which of their values are kept. */
interface Hiding {
  steps: Set<number>;
  /** By hidden step: the values it sets that are never replaced in text. */
  unmasked: Map<number, ReadonlySet<string>>;
}

/**
 * The steps hidden from agents (BUG-011): those that hide their output, and
 * those whose standard input is a hidden step's output or a value that a
 * hidden step captures. Also (BUG-016) those whose command, checks or
 * standard input reads a hidden value from a small fixed set, or whose
 * standard input is the output of such a step or of a hidden VM or
 * Decision step: every value they set is kept from text masks too, as it
 * may be the fixed value again. Worked out again until nothing changes.
 */
function hiding(steps: ReadonlyArray<MaskStep>): Hiding {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const hidden = new Set<number>();
  /** Steps that read a fixed-set value: all they set counts as one. */
  const fixedReaders = new Set<number>();
  const names = new Set<string>();
  const fixed = new Set<string>();
  /** A hidden step whose output holds a fixed-set value (a VM's state). */
  const fixedOutput = (id: number) => {
    const source = byId.get(id);
    return (
      hidden.has(id) &&
      (fixedReaders.has(id) || Boolean(source?.vm || source?.decision))
    );
  };
  let size = -1;
  while (size !== hidden.size + fixedReaders.size + names.size + fixed.size) {
    size = hidden.size + fixedReaders.size + names.size + fixed.size;
    for (const step of steps) {
      const stdin = step.stdin;
      if (
        readNames(step).some((name) => fixed.has(name)) ||
        (stdin?.from === "step" && fixedOutput(stdin.stepId))
      ) {
        fixedReaders.add(step.id);
      }
      if (
        step.hideOutputFromAgents ||
        fixedReaders.has(step.id) ||
        (stdin?.from === "step" && hidden.has(stdin.stepId)) ||
        (stdin?.from === "value" && names.has(stdin.name))
      ) {
        hidden.add(step.id);
        for (const name of valueNames(step)) names.add(name);
        for (const name of unmaskedNames(step, fixedReaders)) fixed.add(name);
      }
    }
  }
  return {
    steps: hidden,
    unmasked: new Map(
      [...hidden].map((id) => {
        const step = steps.find((x) => x.id === id)!;
        return [id, new Set(unmaskedNames(step, fixedReaders))];
      }),
    ),
  };
}

/**
 * The values a step sets: its captures (a sequence's in its run items,
 * 1.4.10), its decision's or VM's values.
 */
function valueNames(
  step: Pick<StepRow, "captures" | "decision" | "vm" | "sequence">,
): string[] {
  return stepValueNames(step);
}

/**
 * The values a step sets from a small fixed set that agents can read in
 * the runbook (BUG-016): a VM's state and a decision's option ids.
 */
function fixedValueNames(step: Pick<StepRow, "decision" | "vm">): string[] {
  return [
    ...(step.decision?.value ? [step.decision.value] : []),
    ...(step.vm?.value ? [`${step.vm.value}.state`] : []),
  ];
}

/** A hidden step's values that no text mask replaces. */
function unmaskedNames(
  step: MaskStep,
  fixedReaders: ReadonlySet<number>,
): string[] {
  return fixedReaders.has(step.id) ? valueNames(step) : fixedValueNames(step);
}

/**
 * The values a step's command, checks and standard input read; for a
 * sequence (1.4.10), every run item's command and checks. An agent step's
 * checks read the values agents see, and Termix runs nothing of it.
 */
function readNames(
  step: Pick<StepRow, "owner" | "command" | "checks" | "stdin" | "sequence">,
): string[] {
  if (isAgentStep(step)) return [];
  const items = runItems(step.sequence);
  const checks = [...step.checks, ...items.flatMap((item) => item.checks)];
  return [
    ...placeholders(step.command),
    ...items.flatMap((item) => placeholders(item.command)),
    ...placeholders(JSON.stringify(checks)),
    ...checks.flatMap((check) => (check.type === "value" ? [check.name] : [])),
    ...(step.stdin?.from === "value" ? [step.stdin.name] : []),
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
  const { steps: hiddenSteps, unmasked } = hiding(steps);
  const declared = new Map(steps.map((step) => [step.id, valueNames(step)]));
  const found = new Set<string>();
  for (const run of runs) {
    if (!hiddenSteps.has(run.stepId)) continue;
    const kept = unmasked.get(run.stepId);
    for (const [name, value] of Object.entries(run.captured ?? {})) {
      // A value from a fixed set: the steps that read it are hidden.
      if (kept?.has(name)) continue;
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
