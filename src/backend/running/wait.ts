/** The wait timer a step asks for after the step before it (1.1.0). */

import type { RunRow, StepRow } from "../runbooks/store/types.js";
import { compareSteps, isBefore, stepBrief } from "../../shared/steps.js";
import type { StepWait } from "../../shared/api.js";

/**
 * The wait a step asks for after the step before it (in the runbook's
 * order). The timer starts when that step last ended: its latest run
 * finished, or it was marked done or skipped. A pending previous step has
 * not ended. A replaced step is not the step before: its replacement stands
 * in its place. Null for a step with no wait, or with no step before it.
 */
export function waitState(
  step: StepRow,
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
  at = Date.now(),
): StepWait | null {
  if (!step.waitAfterPreviousSeconds) return null;
  const previous = steps
    .filter((other) => isBefore(other, step) && other.status !== "replaced")
    .sort((a, b) => compareSteps(b, a))[0];
  if (!previous) return null;
  const base = {
    previous: stepBrief(previous),
    seconds: step.waitAfterPreviousSeconds,
    reason: step.waitReason,
  };
  if (previous.status === "pending") {
    return { ...base, previousEnded: false, until: null, remainingMs: 0 };
  }
  const times = [
    previous.endedAt,
    ...(runsByStep.get(previous.id) ?? []).map((run) => run.finishedAt),
  ]
    .filter((time): time is string => Boolean(time))
    .map((time) => Date.parse(time))
    .filter((time) => !Number.isNaN(time));
  // A step that ended before 1.1.0 has no end time: its last change is.
  const ended = times.length
    ? Math.max(...times)
    : Date.parse(previous.updatedAt);
  const until = ended + step.waitAfterPreviousSeconds * 1000;
  return {
    ...base,
    previousEnded: true,
    until: new Date(until).toISOString(),
    remainingMs: Math.max(0, until - at),
  };
}
