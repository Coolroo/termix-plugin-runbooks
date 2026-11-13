/** Skip, Reopen and the owner's note on a step. */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import { optionalText } from "../core/parse.js";
import { now } from "./store/store.js";
import { LIMITS } from "./parse.js";
import { amendmentView } from "./view.js";
import { replacedProblem } from "./gates.js";
import { pathId, type PersonKit } from "./person-kit.js";
import { stepLabel } from "../../shared/steps.js";

export function registerStepRoutes(router: Router, kit: PersonKit): void {
  const {
    store,
    events,
    actor,
    act,
    showRunbook,
    bundleFor,
    stepContext,
    audit,
  } = kit;

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/skip:
   *   post:
   *     summary: Skip a step, with a reason
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/steps/:id/skip",
    ...act,
    wrap(async (req) => {
      const { step, bundle } = await stepContext(pathId(req));
      // Skip the replacement instead: a replaced step already ended.
      if (step.status === "replaced") {
        throw replacedProblem(step, bundle.steps);
      }
      const reason =
        optionalText(body(req).reason, "reason", LIMITS.ownerNote, {
          message: "reason must be short text",
        }) ?? "";
      await events.around(step.runbookId, actor(), async () => {
        await store.updateStep(step.id, {
          status: "skipped",
          skipReason: reason,
          endedAt: now(),
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
      });
      await audit(req, "runbooks_step_skip", step, reason.slice(0, 500), true);
      return showRunbook(await bundleFor(step.runbookId));
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/reopen:
   *   post:
   *     summary: Put a step back to pending; its runs are kept
   *     description: >
   *       A replaced step (1.4.0) reopens only when its replacement was
   *       skipped and never ran; otherwise 409 with code replaced.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: A replaced step whose replacement is live }
   */
  router.post(
    "/steps/:id/reopen",
    ...act,
    wrap(async (req) => {
      const { step, bundle } = await stepContext(pathId(req));
      if (step.status === "replaced") {
        const by = amendmentView(step, bundle.steps).replacedBy;
        const replacement = by
          ? bundle.steps.find((other) => other.id === by.id)
          : undefined;
        const ran = Boolean(
          replacement && bundle.runsByStep.get(replacement.id)?.length,
        );
        if (replacement && (replacement.status !== "skipped" || ran)) {
          throw new InputError(
            `step ${stepLabel(step)} was replaced by ${by!.label}${
              ran
                ? ", which already ran"
                : "; skip it first to go back to this step"
            }`,
            409,
            { code: "replaced", replacedBy: by },
          );
        }
      }
      await events.around(step.runbookId, actor(), async () => {
        await store.updateStep(step.id, {
          status: "pending",
          skipReason: null,
          endedAt: null,
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
      });
      return showRunbook(await bundleFor(step.runbookId));
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/note:
   *   post:
   *     summary: Save the owner's note on a step
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: Saved }
   */
  router.post(
    "/steps/:id/note",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(pathId(req));
      const note =
        optionalText(body(req).ownerNote, "ownerNote", LIMITS.ownerNote) ?? "";
      await store.updateStep(step.id, { ownerNote: note });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      return { ok: true };
    }),
  );
}
