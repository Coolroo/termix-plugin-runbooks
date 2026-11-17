/**
 * The questions a step must pass before a person or an agent acts on it:
 * the step is theirs, the runbook is open, the step was not replaced, the
 * revision is the one they saw, its values are there, earlier steps ended,
 * and the runbook's wait is over. Each route asks them in its own order:
 * clients key on which refusal comes first.
 */

import type { StepRow } from "./store/types.js";
import type {
  NotNeededConflict,
  OrderConflict,
  StepWait,
  WaitConflict,
} from "../../shared/api.js";
import {
  isAgentStep,
  isBefore,
  stepBrief,
  stepLabel,
} from "../../shared/steps.js";
import { InputError } from "../core/errors.js";
import { amendmentView, type RunbookBundle } from "./view.js";
import { notNeededIds, type StepCondition } from "../conditions/conditions.js";
import { waitState } from "../running/wait.js";

/** Why a person cannot run, send or mark an agent step. */
export const AGENT_STEP =
  "this step is for the agent: it completes it itself; you can Skip or Reopen it";

/** The 409 for an agent step on a person's route. */
export function agentStepProblem(): InputError {
  return new InputError(AGENT_STEP, 409, { code: "agent-step" });
}

/** Why a replaced step does not run (1.4.0). */
export function replacedProblem(step: StepRow, steps: StepRow[]): InputError {
  const by = amendmentView(step, steps).replacedBy;
  return new InputError(
    `step ${stepLabel(step)} was replaced${by ? ` by ${by.label}` : ""}; run the new step instead`,
    409,
    { code: "replaced", replacedBy: by },
  );
}

/**
 * A person may act on this step now: it is not an agent step (unless
 * `agentOk`), its runbook is open and it was not replaced. In that order.
 */
export function requireActionable(
  step: StepRow,
  bundle: Pick<RunbookBundle, "runbook" | "steps">,
  options: { agentOk?: boolean } = {},
): void {
  if (!options.agentOk && isAgentStep(step)) throw agentStepProblem();
  if (bundle.runbook.status !== "open") {
    throw new InputError(`this runbook is ${bundle.runbook.status}`, 409);
  }
  if (step.status === "replaced") throw replacedProblem(step, bundle.steps);
}

/**
 * The 409 when the author said the step starts the other way (1.4.6):
 * Run on a terminal-only step, Send to terminal on a Run-only one.
 */
export function runInProblem(
  step: StepRow,
  via: "run" | "terminal",
): InputError | null {
  if (step.runIn === "either" || step.runIn === via) return null;
  const why = step.runInReason ? ` (${step.runInReason})` : "";
  return step.runIn === "terminal"
    ? new InputError(
        `this step runs only in a terminal${why}: use Send to terminal`,
        409,
        { code: "terminal-only", reason: step.runInReason },
      )
    : new InputError(`this step runs only with Run${why}: use Run`, 409, {
        code: "run-only",
        reason: step.runInReason,
      });
}

/** The 409 for a step that changed since the person saw it. */
export function staleProblem(): InputError {
  return new InputError("the step changed; reload", 409, { code: "stale" });
}

/** The body names the revision of the step the person saw. */
export function requireRevision(
  step: StepRow,
  input: Record<string, unknown>,
): void {
  if (input.revision !== step.revision) throw staleProblem();
}

/** Every value the step's command names is set. */
export function requireValues(missing: string[]): void {
  if (missing.length > 0) {
    throw new InputError(`values missing: ${missing.join(", ")}`, 409, {
      code: "missing-values",
      missing,
    });
  }
}

/**
 * The 409 order when an earlier step is still pending, or null. A replaced
 * step counts as ended: its status is not pending. So does a step that is
 * not needed (1.4.6), in `notNeeded`. `suffix` ends the message.
 */
export function blockingProblem(
  step: StepRow,
  steps: StepRow[],
  suffix = "",
  notNeeded: ReadonlySet<number> = new Set(),
): InputError | null {
  const blocking = steps.filter(
    (other) =>
      isBefore(other, step) &&
      other.status === "pending" &&
      !notNeeded.has(other.id),
  );
  if (blocking.length === 0) return null;
  return new InputError(
    `step ${stepLabel(blocking[0])} (${blocking[0].title}) is still pending${suffix}`,
    409,
    {
      code: "order",
      blocking: blocking.map(stepBrief),
    } satisfies OrderConflict,
  );
}

/**
 * A step its when rule says is not needed (1.4.6): the 409 not-needed
 * unless `anyway` (D3, the owner's choice: a person may start it after a
 * "Run anyway?" question). `overridden` is the condition a start now
 * passes over, for the audit log; null when the step is needed.
 */
export function conditionProblem(
  step: StepRow,
  bundle: Pick<RunbookBundle, "conditions">,
  anyway: boolean,
): { problem: InputError | null; overridden: StepCondition | null } {
  const condition = bundle.conditions.get(step.id);
  if (!condition?.notNeeded) return { problem: null, overridden: null };
  if (anyway) return { problem: null, overridden: condition };
  return {
    problem: new InputError(
      `step ${stepLabel(step)} is not needed: ${condition.reason}`,
      409,
      {
        code: "not-needed",
        rule: condition.rule,
        reason: condition.reason,
      } satisfies NotNeededConflict,
    ),
    overridden: condition,
  };
}

/**
 * The wait the author asked for after the previous step, while it runs:
 * the 409 wait unless `waitAnyway`, and the seconds a start now skips
 * (null when no wait runs).
 */
export function waitProblem(
  step: StepRow,
  bundle: Pick<RunbookBundle, "steps" | "runsByStep" | "conditions">,
  waitAnyway: boolean,
): { problem: InputError | null; skippedSeconds: number | null } {
  const wait = waitState(
    step,
    bundle.steps,
    bundle.runsByStep,
    notNeededIds(bundle.conditions),
  );
  const waiting: StepWait | null = wait && wait.remainingMs > 0 ? wait : null;
  if (!waiting) return { problem: null, skippedSeconds: null };
  const remainingSeconds = Math.ceil(waiting.remainingMs / 1000);
  if (waitAnyway) return { problem: null, skippedSeconds: remainingSeconds };
  return {
    problem: new InputError(
      `the runbook says to wait ${remainingSeconds} s more after step ${waiting.previous.label}${
        waiting.reason ? ` (${waiting.reason})` : ""
      }`,
      409,
      {
        code: "wait",
        remainingSeconds,
        reason: waiting.reason,
        waitUntil: waiting.until,
        previous: waiting.previous,
      } satisfies WaitConflict,
    ),
    skippedSeconds: remainingSeconds,
  };
}
