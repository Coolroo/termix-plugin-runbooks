/**
 * Decision steps (1.4.6) on the server: the choice a step ended with, read
 * back from its run, and the steps that ran on it.
 */

import type { RunRow, StepRow } from "../runbooks/store/types.js";
import { ruleStepIds } from "../conditions/conditions.js";
import type { DecisionChoice } from "../../shared/decisions.js";
import type { StepName } from "../../shared/api.js";
import { stepBrief } from "../../shared/steps.js";

/** The run a choice makes: its output is the chosen ids, one per line. */
export function choiceOutput(chosen: string[]): string {
  return `${chosen.join("\n")}\n`;
}

/**
 * What a Decision step chose: its latest decision run, while the step is
 * done. Null for any other step, or one pending, skipped or reopened.
 */
export function stepChoice(
  step: Pick<StepRow, "id" | "status" | "decision">,
  runsByStep: Map<number, readonly RunRow[]>,
): DecisionChoice | null {
  if (!step.decision || step.status !== "done") return null;
  const run = [...(runsByStep.get(step.id) ?? [])]
    .sort((a, b) => b.id - a.id)
    .find((other) => other.mode === "decision" && other.status === "done");
  if (!run) return null;
  return {
    chosen: (run.stdout ?? "").split("\n").filter(Boolean),
    by: run.userId,
    at: run.finishedAt ?? run.startedAt,
  };
}

/**
 * The steps whose when rule reads this step and that already ran (D8):
 * a new choice leaves them as history.
 */
export function ranOnChoice(
  step: StepRow,
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
): StepName[] {
  if (!step.decision) return [];
  return steps
    .filter(
      (other) =>
        ruleStepIds(other.when).includes(step.id) &&
        (runsByStep.get(other.id) ?? []).length > 0,
    )
    .map(stepBrief);
}
