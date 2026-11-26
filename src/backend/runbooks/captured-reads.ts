/**
 * Captured values in commands (BUG-022 M3; the owner, 2026-11-23, "Must
 * match a pattern"). A value that a step or a sequence item captures from
 * a host's output may go into a command Termix runs (a step's command, a
 * run or wait item's command, a job's command, an event's names, paths and
 * URL) only when the step or item that captures it checks it with a
 * `value` check that has `matches`, the author's pattern. Otherwise the
 * runbook is refused when written: a value an earlier item captures is
 * filled in after the person approved the Run, so without the pattern the
 * host's output could change what runs (as root, for a job).
 *
 * At run time a value that fails its pattern fails the capturing step or
 * item, so it never reaches a later command; and a value a later item of
 * the same sequence reads must match the pattern as a whole, line breaks
 * included (sequence-run.ts), so a pattern without ^ and $ still holds.
 *
 * Not affected: the runbook's own values, which the agent sets and the
 * card shows before Run; a decision's option ids; a VM step's values,
 * which have a fixed form (VM_VALUE_FORMS); secrets, which never become
 * values.
 */

import type { Check } from "../../shared/checks.js";
import { isCommandItem, type SequenceItem } from "../../shared/sequence.js";
import {
  isAgentStep,
  isOutsideStep,
  stepLabel,
  type StepNumber,
} from "../../shared/steps.js";
import { placeholders } from "../values/values.js";
import { itemTextNames } from "../values/effective.js";

/** A step as this rule reads it; `id` once it is stored. */
export interface CapturingStep extends StepNumber {
  id?: number;
  owner?: string | null;
  command: string | null;
  where?: string | null;
  captures: Array<{ name: string }>;
  checks: readonly Check[];
  sequence?: readonly SequenceItem[] | null;
}

/** A step or item that captures a value, or whose text reads one. */
interface Place {
  /** "step 3" or "step 3 item 2", as the message names it. */
  label: string;
  /** The same before and after a change: the step's id when stored. */
  key: string;
}

/** The pattern a value check gives the value, or null for none. */
export function valuePattern(
  checks: readonly Check[],
  name: string,
): string | null {
  for (const check of checks) {
    if (
      check.type === "value" &&
      check.name === name &&
      typeof check.matches === "string" &&
      check.matches !== ""
    ) {
      return check.matches;
    }
  }
  return null;
}

/** The step, or its item at `index`, as a place. */
function place(step: CapturingStep, index: number | null): Place {
  const item = index === null ? "" : ` item ${index + 1}`;
  return {
    label: `step ${stepLabel(step)}${item}`,
    key: `${step.id !== undefined ? `#${step.id}` : stepLabel(step)}${item}`,
  };
}

/** Every step and item of the runbook that captures `name`. */
function capturersOf(
  steps: readonly CapturingStep[],
  name: string,
): Array<Place & { checks: readonly Check[] }> {
  const found: Array<Place & { checks: readonly Check[] }> = [];
  for (const step of steps) {
    if (step.captures.some((capture) => capture.name === name)) {
      found.push({ ...place(step, null), checks: step.checks });
    }
    for (const [index, item] of (step.sequence ?? []).entries()) {
      if (
        isCommandItem(item) &&
        item.captures.some((capture) => capture.name === name)
      ) {
        found.push({ ...place(step, index), checks: item.checks });
      }
    }
  }
  return found;
}

/** What a step runs, as text that may hold {{name}}, and where it is. */
function readers(
  step: CapturingStep,
): Array<Place & { field: string; names: string[] }> {
  // Termix runs nothing of an agent's step or a step run outside it: the
  // agent or the person runs the text they see.
  if (isAgentStep(step) || isOutsideStep(step)) return [];
  const out: Array<Place & { field: string; names: string[] }> = [];
  if (step.command && !step.sequence) {
    out.push({
      ...place(step, null),
      field: "command",
      names: placeholders(step.command),
    });
  }
  for (const [index, item] of (step.sequence ?? []).entries()) {
    out.push({
      ...place(step, index),
      field:
        item.type === "run" || item.type === "wait" || item.type === "job"
          ? "command"
          : "text",
      names: itemTextNames(item),
    });
  }
  return out;
}

/** One captured value a command uses whose capturer has no pattern. */
export interface CapturedRead {
  /** The same for the same reader, name and capturer before a change. */
  key: string;
  message: string;
}

/**
 * Every captured value a command uses whose capturer has no pattern for
 * it, as the 400 says it.
 */
export function capturedReads(steps: readonly CapturingStep[]): CapturedRead[] {
  const out: CapturedRead[] = [];
  for (const step of steps) {
    for (const reader of readers(step)) {
      for (const name of reader.names) {
        for (const capturer of capturersOf(steps, name)) {
          if (valuePattern(capturer.checks, name) !== null) continue;
          out.push({
            key: `${reader.key}|${name}|${capturer.key}`,
            message: `${reader.label} uses {{${name}}} in its ${reader.field}, a value that ${capturer.label} captures from a host's output. A captured value goes into a command only when what captures it checks it with a pattern: add {"type":"value","name":"${name}","matches":"^[0-9.]+$"} (with a pattern that fits the value) to the checks of ${capturer.label}`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The first captured read that `after` has and `before` did not, or null:
 * a change is refused for what it brings, so a runbook stored before the
 * rule can still be changed elsewhere.
 */
export function newCapturedRead(
  before: readonly CapturingStep[],
  after: readonly CapturingStep[],
): string | null {
  const known = new Set(capturedReads(before).map((read) => read.key));
  return (
    capturedReads(after).find((read) => !known.has(read.key))?.message ?? null
  );
}
