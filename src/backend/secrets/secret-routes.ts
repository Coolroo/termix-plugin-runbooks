/** Make it or Save on a secret step (1.4.2). */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import { now } from "../runbooks/store/store.js";
import { pathId, type PersonKit } from "../runbooks/person-kit.js";
import {
  blockingProblem,
  requireActionable,
  requireRevision,
  waitProblem,
} from "../runbooks/gates.js";
import { matchesWhole } from "../values/values.js";
import { libraryRef } from "../running/stdin.js";
import { stepLabel } from "../../shared/steps.js";
import {
  describeFormat,
  describeStore,
  MAX_ASKED_BYTES,
} from "../../shared/secret-steps.js";
import type { RepeatConflict } from "../../shared/api.js";
import { APP_STORE_NEEDS, secretSpec } from "./secret-view.js";
import { SECRET_TTL_MS } from "./secrets.js";
import { generateSecret } from "./generate.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The value a person typed or pasted on an Ask for a secret step (1.4.2),
 * trimmed, or a refusal. The refusal never holds the value.
 */
function askedValue(
  raw: unknown,
  pattern: string | null,
  label: string,
): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InputError(`enter the ${label}`, 400, { code: "empty" });
  }
  const value = raw.trim();
  if (Buffer.byteLength(value) > MAX_ASKED_BYTES) {
    throw new InputError(
      `the value is longer than ${MAX_ASKED_BYTES / 1024} KB`,
      400,
      { code: "too-long" },
    );
  }
  if (value.includes("\0")) {
    throw new InputError("the value must not contain NUL characters", 400, {
      code: "pattern",
    });
  }
  if (pattern !== null) {
    const ok = matchesWhole(pattern, value);
    if (ok !== true) {
      throw new InputError(
        ok === null
          ? "the check of the value did not finish: ask the runbook's author for a simpler pattern"
          : `this does not look like the ${label}: it does not match the pattern the runbook gives (${pattern})`,
        400,
        { code: "pattern" },
      );
    }
  }
  return value;
}

export function registerSecretRoutes(router: Router, kit: PersonKit): void {
  const {
    secrets,
    events,
    store,
    actor,
    act,
    claimed,
    showRunbook,
    bundleFor,
    stepContext,
    runSummary,
    auditSkippedWait,
    audit,
  } = kit;

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/secret:
   *   post:
   *     summary: Make a secret step's value, or save the value a person pasted
   *     description: >
   *       1.4.2. Body { revision, value?, confirmRepeat?, outOfOrder?,
   *       waitAnyway? }. On a Make a secret step (generate) the server makes
   *       the value; on an Ask for a secret step (ask) the body's value is
   *       the one the person typed or pasted, checked against the step's
   *       pattern. The value goes to the step's store through OpenBao
   *       Secrets and is never in the answer, a run, an event or the audit
   *       log. A person only; refused for a Termix API key. 409 with code
   *       stale, order, wait or repeat as for Run; no-secrets,
   *       app-store-unsupported, app-store-off, app-not-allowed or exists
   *       when the store cannot take it.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       400: { description: Not a secret step, or a value that does not match }
   *       409: { description: Stale, out of order, wait, repeat, or refused by the store }
   */
  router.post(
    "/steps/:id/secret",
    ...act,
    wrap(async (req) =>
      claimed(pathId(req), async (stepId) => {
        const { step, bundle } = await stepContext(stepId);
        const spec = secretSpec(step);
        if (!spec) {
          throw new InputError("this step makes or asks for no secret", 400, {
            code: "not-secret-step",
          });
        }
        // A secret step is never an agent step: no agent-step question.
        requireActionable(step, bundle, { agentOk: true });
        const input = body(req);
        requireRevision(step, input);
        // An asked value is checked before anything else is asked about.
        let value: string;
        if (step.ask) {
          value = askedValue(input.value, step.ask.pattern, step.ask.label);
        } else {
          value = "";
        }
        if (input.outOfOrder !== true) {
          const blocking = blockingProblem(step, bundle.steps);
          if (blocking) throw blocking;
        }
        const wait = waitProblem(step, bundle, input.waitAnyway === true);
        if (wait.problem) throw wait.problem;
        const earlier = bundle.runsByStep.get(step.id)?.[0];
        if (step.status !== "pending" && input.confirmRepeat !== true) {
          throw new InputError(
            step.generate
              ? `step ${stepLabel(step)} made secret ${spec.name} already`
              : `step ${stepLabel(step)} saved secret ${spec.name} already`,
            409,
            {
              code: "repeat",
              repeat: earlier ? runSummary(earlier, true) : null,
            } satisfies RepeatConflict,
          );
        }
        // Made only now, after every question: it goes straight to its store.
        if (step.generate) {
          value = generateSecret(step.generate.format, step.generate.length);
        }
        const how = step.generate ? "made" : "saved";
        const dest = spec.store;
        let expiresAt: string | null = null;
        let where: string | null = null;
        if (dest.to === "runbook") {
          await secrets.require();
          expiresAt = new Date(Date.now() + SECRET_TTL_MS).toISOString();
          await secrets.putCaptured(
            step.runbookId,
            spec.name,
            value,
            expiresAt,
          );
        } else if (dest.to === "library") {
          const ref = libraryRef(dest.library);
          expiresAt = dest.expires
            ? new Date(Date.now() + dest.expires * DAY_MS).toISOString()
            : null;
          await secrets.createLibrary(ref.area, ref.name, value, {
            expiresAt,
            note: `From runbook ${step.runbookId} step ${stepLabel(step)}`,
          });
          where = dest.library;
        } else {
          if (!secrets.appSecrets()) {
            await secrets.require();
            throw new InputError(APP_STORE_NEEDS, 409, {
              code: "app-store-unsupported",
            });
          }
          await secrets.createAppField(dest.app, dest.host, dest.field, value);
          where = `${dest.app}/${dest.host}#${dest.field}`;
        }
        value = "";
        const at = now();
        const made = {
          name: spec.name,
          how,
          store: dest.to,
          where,
          expiresAt,
        } as const;
        await events.endStep(step, {
          status: "done",
          reason: null,
          by: actor(),
          at,
          run: () =>
            store.insertRun({
              stepId: step.id,
              runbookId: step.runbookId,
              mode: "secret",
              status: "done",
              hostId: null,
              command: "",
              commandHash: "",
              userId: actor(),
              startedAt: at,
              finishedAt: at,
              startedEarlySeconds: wait.skippedSeconds,
              secrets: {
                used: [],
                captured:
                  dest.to === "runbook" && expiresAt
                    ? [{ name: spec.name, expiresAt }]
                    : [],
                made,
              },
            }),
          touch: dest.to === "runbook" ? { secretsStoredAt: at } : {},
        });
        await auditSkippedWait(req, step, wait.skippedSeconds);
        await audit(
          req,
          "runbooks_step_secret",
          step,
          `runbook ${step.runbookId} step ${stepLabel(step)} ${how} secret ${spec.name}${
            step.generate
              ? ` (${describeFormat(step.generate.format, step.generate.length)})`
              : ""
          } in ${describeStore(dest)}`,
          true,
        );
        return showRunbook(await bundleFor(step.runbookId));
      }),
    ),
  );
}
