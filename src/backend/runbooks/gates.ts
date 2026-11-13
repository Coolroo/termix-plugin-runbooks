/**
 * The questions a step must pass before a person or an agent acts on it:
 * the step is theirs, the runbook is open, the step was not replaced, the
 * revision is the one they saw, its values are there, earlier steps ended,
 * and the runbook's wait is over. Each route asks them in its own order:
 * clients key on which refusal comes first.
 */

import type { StepRow } from "./store/types.js";
import type {
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
 * step counts as ended: its status is not pending. `suffix` ends the
 * message.
 */
export function blockingProblem(
  step: StepRow,
  steps: StepRow[],
  suffix = "",
): InputError | null {
  const blocking = steps.filter(
    (other) => isBefore(other, step) && other.status === "pending",
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
 * The wait the author asked for after the previous step, while it runs:
 * the 409 wait unless `waitAnyway`, and the seconds a start now skips
 * (null when no wait runs).
 */
export function waitProblem(
  step: StepRow,
  bundle: Pick<RunbookBundle, "steps" | "runsByStep">,
  waitAnyway: boolean,
): { problem: InputError | null; skippedSeconds: number | null } {
  const wait = waitState(step, bundle.steps, bundle.runsByStep);
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
