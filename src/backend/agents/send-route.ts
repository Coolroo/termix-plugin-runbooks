/** Send a step to the runbook's agent (1.4.0), and hide its output from agents. */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import { optionalText } from "../core/parse.js";
import { pathId, type PersonKit } from "../runbooks/person-kit.js";
import { stepLabel } from "../../shared/steps.js";
import { MAX_SENT_NOTE } from "../../shared/limits.js";

export function registerSendRoutes(router: Router, kit: PersonKit): void {
  const {
    store,
    events,
    notify,
    actor,
    act,
    showRunbook,
    bundleFor,
    stepContext,
    audit,
  } = kit;

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/send-to-agent:
   *   post:
   *     summary: Send a step to the runbook's agent, with an optional note
   *     description: >
   *       Body { note? } (up to 500 characters). Records a "sent" event,
   *       which the notification webhook always delivers. Needs agent
   *       notifications on and a runbook with an owner. A person only.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: Notifications are off, or the runbook has no owner }
   */
  router.post(
    "/steps/:id/send-to-agent",
    ...act,
    wrap(async (req) => {
      const { step, bundle } = await stepContext(pathId(req));
      const raw = optionalText(body(req).note, "note", MAX_SENT_NOTE) ?? "";
      if (!(await notify.enabled())) {
        throw new InputError(
          "agent notifications are off; an admin turns them on in the plugin's settings",
          409,
          { code: "notify-off" },
        );
      }
      if (!bundle.runbook.owner) {
        throw new InputError(
          "this runbook does not say which agent it belongs to",
          409,
          { code: "no-owner" },
        );
      }
      const note = raw.trim() ? raw : null;
      await events.record({
        runbook: bundle.runbook,
        stepId: step.id,
        type: "sent",
        note,
        by: actor(),
      });
      await store.persist();
      await audit(
        req,
        "runbooks_step_sent",
        step,
        `runbook ${step.runbookId} step ${stepLabel(step)} sent to the agent${
          note ? ", with a note" : ""
        }`,
        true,
      );
      return showRunbook(await bundleFor(step.runbookId));
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/hide:
   *   post:
   *     summary: Hide or show a step's output to agents
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/steps/:id/hide",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(pathId(req));
      const hidden = body(req).hidden;
      if (typeof hidden !== "boolean") {
        throw new InputError("hidden must be true or false");
      }
      await store.updateStep(step.id, { hideOutputFromAgents: hidden });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      return showRunbook(await bundleFor(step.runbookId));
    }),
  );
}
