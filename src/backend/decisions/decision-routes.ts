/** Confirm on a Decision step (1.4.6): the person's choice ends the step. */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import { now } from "../runbooks/store/store.js";
import { pathId, type PersonKit } from "../runbooks/person-kit.js";
import {
  blockingProblem,
  conditionProblem,
  requireActionable,
  requireRevision,
} from "../runbooks/gates.js";
import { notNeededIds } from "../conditions/conditions.js";
import { choiceOutput } from "./decisions.js";
import { choiceProblem, inOrder } from "../../shared/decisions.js";
import { stepLabel } from "../../shared/steps.js";

export function registerDecisionRoutes(router: Router, kit: PersonKit): void {
  const {
    store,
    events,
    actor,
    act,
    claimed,
    showRunbook,
    bundleFor,
    stepContext,
    auditNotNeeded,
    audit,
  } = kit;

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/decide:
   *   post:
   *     summary: Confirm a choice on a Decision step
   *     description: >
   *       1.4.6. Body { revision, chosen: [option id], outOfOrder?,
   *       conditionAnyway? }. Records a run in mode decision whose output
   *       is the chosen ids, one per line, sets the step's value when it
   *       has one, and ends the step done. A person only; an ended step is
   *       reopened first (409 ended).
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       400: { description: Not a decision step, or a choice it does not take }
   *       409: { description: Stale, ended, not needed or out of order }
   */
  router.post(
    "/steps/:id/decide",
    ...act,
    wrap(async (req) =>
      claimed(pathId(req), async (stepId) => {
        const { step, bundle } = await stepContext(stepId);
        const spec = step.decision;
        if (!spec) {
          throw new InputError("this step is not a decision step", 400, {
            code: "not-decision-step",
          });
        }
        // D7 (the owner's choice): a decision is always a person's.
        requireActionable(step, bundle, { agentOk: true });
        const input = body(req);
        requireRevision(step, input);
        if (step.status !== "pending") {
          throw new InputError(
            `step ${stepLabel(step)} ended; Reopen it to choose again`,
            409,
            { code: "ended" },
          );
        }
        const problem = choiceProblem(spec, input.chosen);
        if (problem) throw new InputError(problem, 400, { code: "choice" });
        const chosen = inOrder(spec, input.chosen as string[]);
        const condition = conditionProblem(
          step,
          bundle,
          input.conditionAnyway === true,
        );
        if (condition.problem) throw condition.problem;
        if (input.outOfOrder !== true) {
          const blocking = blockingProblem(
            step,
            bundle.steps,
            "",
            notNeededIds(bundle.conditions),
          );
          if (blocking) throw blocking;
        }
        await auditNotNeeded(req, step, condition.overridden);
        const at = now();
        await events.endStep(step, {
          status: "done",
          reason: null,
          by: actor(),
          at,
          note: `chose ${chosen.join(", ")}`,
          run: () =>
            store.insertRun({
              stepId: step.id,
              runbookId: step.runbookId,
              mode: "decision",
              status: "done",
              hostId: null,
              command: "",
              commandHash: "",
              userId: actor(),
              startedAt: at,
              finishedAt: at,
              stdout: choiceOutput(chosen),
              captured: spec.value ? { [spec.value]: chosen.join(",") } : {},
            }),
        });
        await audit(
          req,
          "runbooks_step_decide",
          step,
          `runbook ${step.runbookId} step ${stepLabel(step)}: chose ${chosen.join(", ")}`,
          true,
        );
        return showRunbook(await bundleFor(step.runbookId));
      }),
    ),
  );
}
