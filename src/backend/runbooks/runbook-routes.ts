/** The runbook list, one runbook, and its status. */

import type { Router } from "express";
import { body, wrap } from "../core/http.js";
import { parseStatus } from "./parse.js";
import { runbookSummary } from "./view.js";
import { pathId, type PersonKit } from "./person-kit.js";
import { nextKind } from "../../shared/step-kinds.js";
import type { RunbookListEntry } from "../../shared/api.js";

/** GET /runbooks: registered before /colors, as it always was. */
export function registerRunbookList(router: Router, kit: PersonKit): void {
  const { store, use, removeSecrets } = kit;

  /**
   * @openapi
   * /plugin-api/runbooks/runbooks:
   *   get:
   *     summary: List runbooks, open ones first, with progress
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbooks }
   */
  router.get(
    "/runbooks",
    ...use,
    wrap(async (req) => {
      const rows = await store.listRunbooks({});
      const out: RunbookListEntry[] = [];
      for (const runbook of rows) {
        const steps = await store.listSteps(runbook.id);
        // A runbook an agent closed still has its secrets: delete them now.
        await removeSecrets(req, runbook, steps);
        // The kind of the next step (1.4.1): the list shows its color.
        out.push({
          ...runbookSummary(runbook, steps),
          nextKind: nextKind(steps),
        });
      }
      const order = { open: 0, done: 1, abandoned: 2 } as const;
      return out.sort((a, b) => order[a.status] - order[b.status]);
    }),
  );
}

/** GET /runbooks/:id and POST /runbooks/:id/status. */
export function registerRunbookRoutes(router: Router, kit: PersonKit): void {
  const { events, actor, use, act, showRunbook, bundleFor, removeSecrets } =
    kit;

  /**
   * @openapi
   * /plugin-api/runbooks/runbooks/{id}:
   *   get:
   *     summary: One runbook with resolved commands, values and every run
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       404: { description: Not found }
   */
  router.get(
    "/runbooks/:id",
    ...use,
    wrap(async (req) => {
      const id = pathId(req);
      const bundle = await bundleFor(id);
      return (await removeSecrets(req, bundle.runbook, bundle.steps))
        ? showRunbook(await bundleFor(id))
        : showRunbook(bundle);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/runbooks/{id}/status:
   *   post:
   *     summary: Mark a runbook open, done or abandoned
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/runbooks/:id/status",
    ...act,
    wrap(async (req) => {
      const id = pathId(req);
      const before = (await bundleFor(id)).runbook;
      const status = parseStatus(body(req).status);
      await events.changeRunbook(id, before.status, { status }, actor());
      const closed = await bundleFor(id);
      // Done or abandoned: the secrets it captured are deleted now.
      await removeSecrets(req, closed.runbook, closed.steps, true);
      return showRunbook(await bundleFor(id));
    }),
  );
}
