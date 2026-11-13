/** Run, Stop, Send to terminal, Mark done or failed, and Done by hand. */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import { optionalText, parseOutcome } from "../core/parse.js";
import { now } from "../runbooks/store/store.js";
import { pathId, type PersonKit } from "../runbooks/person-kit.js";
import { LIMITS } from "../runbooks/parse.js";
import {
  agentStepProblem,
  requireActionable,
  requireRevision,
  requireValues,
} from "../runbooks/gates.js";
import { valuesObject } from "../values/effective.js";
import { resolve } from "../values/values.js";
import { judgeOutput, type CheckResult } from "../checks/checks.js";
import { isAgentStep, isOutsideStep, stepLabel } from "../../shared/steps.js";
import { redact } from "./redact.js";
import { describeStdin, stepStdin } from "./stdin.js";
import { createRunner, MAX_OUTPUT_BYTES } from "./runner.js";

/** How long Stop waits for the run to be written before it answers. */
const STOP_WAIT_MS = 5000;
const NO_HOST_KEY =
  "open a Terminal to this host once to store its host key, then run the step again";

export function registerRunRoutes(router: Router, kit: PersonKit): void {
  const {
    store,
    live,
    events,
    actor,
    act,
    claim,
    claimed,
    showRunbook,
    shownRun,
    bundleFor,
    stepContext,
    checkRunnable,
    auditSkippedWait,
    storedNote,
    audit,
  } = kit;
  const { readStdin, madeSecretTexts, finishRun, execute } = createRunner(kit);

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/run:
   *   post:
   *     summary: Start a step's command over SSH, as the signed-in person
   *     description: >
   *       Body { revision, commandHash, confirmRepeat?, outOfOrder?,
   *       waitAnyway? }. Answers
   *       at once with the run in status running; read the runbook for its
   *       output as it arrives. Refused
   *       with 409 when the step changed since it was shown, an earlier step is
   *       still pending, or the command already ran (until confirmed).
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run, still running }
   *       400: { description: The step's host is not an SSH host }
   *       409: { description: Stale, out of order, wait, repeat or no stored host key }
   */
  router.post(
    "/steps/:id/run",
    ...act,
    wrap(async (req) => {
      const stepId = pathId(req);
      const release = claim(stepId);
      let handedOff = false;
      try {
        const { step, bundle } = await stepContext(stepId);
        const target = await checkRunnable(step, bundle, body(req));
        // Without a stored key, a connection with no person to ask accepts
        // whatever key the server shows. Refuse rather than trust it.
        if (!target.host.hostKeyFingerprint) {
          throw new InputError(NO_HOST_KEY, 409, { code: "no-host-key" });
        }
        const input = target.stdin
          ? await readStdin(step, bundle, target.stdin)
          : null;
        const hidden = await madeSecretTexts(step, bundle);
        await auditSkippedWait(req, step, target.skippedWait);
        const startedAt = now();
        const runId = await store.insertRun({
          stepId: step.id,
          runbookId: step.runbookId,
          mode: "exec",
          status: "running",
          hostId: target.hostId,
          command: target.command,
          commandHash: target.hash,
          userId: actor(),
          startedAt,
          stdout: "",
          stderr: "",
          stdin: input?.record ?? null,
          startedEarlySeconds: target.skippedWait,
          secrets: input?.secret
            ? { used: [input.secret.name], captured: [] }
            : null,
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
        const record = live.start({
          runId,
          stepId: step.id,
          runbookId: step.runbookId,
          startedAt,
        });
        // Started inside the request, so it keeps acting as this person
        // after the answer is sent.
        record.done = execute(
          req,
          runId,
          step,
          {
            by: actor(),
            hostId: target.hostId,
            command: target.command,
            stdin: input?.bytes,
            used: input?.secret ? [input.secret] : [],
            hidden,
          },
          release,
        );
        handedOff = true;
        return shownRun(runId);
      } finally {
        if (!handedOff) release();
      }
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/stop:
   *   post:
   *     summary: Stop the step's running command
   *     description: >
   *       Sends TERM where the server takes signals, then closes the
   *       command's channel. The run ends failed with "stopped by <user>".
   *       A person only; refused for a Termix API key.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   *       409: { description: The step is not running }
   */
  router.post(
    "/steps/:id/stop",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(pathId(req));
      const record = live.byStep(step.id);
      if (!record) {
        throw new InputError("this step is not running", 409, {
          code: "not-running",
        });
      }
      if (!record.stoppedBy) {
        record.stoppedBy = actor();
        record.stop?.();
        await audit(
          req,
          "runbooks_step_stop",
          step,
          `runbook ${step.runbookId} step ${stepLabel(step)} run ${record.runId} stopped`,
          true,
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        record.done,
        new Promise((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS))),
      ]);
      clearTimeout(timer);
      return shownRun(record.runId);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/terminal:
   *   post:
   *     summary: Record that the person sent the command to a terminal
   *     description: >
   *       Same checks as run. Makes a run in mode terminal that waits for the
   *       person to paste the output (runs/{id}/complete).
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   */
  router.post(
    "/steps/:id/terminal",
    ...act,
    wrap(async (req) =>
      claimed(pathId(req), async (stepId) => {
        const { step, bundle } = await stepContext(stepId);
        if (isAgentStep(step)) throw agentStepProblem();
        const stdin = stepStdin(step, bundle.steps);
        if (stdin) {
          throw new InputError(
            `This step gets input from ${describeStdin(stdin)}: use Run`,
            409,
            { code: "stdin-run-only" },
          );
        }
        const target = await checkRunnable(step, bundle, body(req), {
          agentChecked: true,
        });
        await auditSkippedWait(req, step, target.skippedWait);
        const runId = await store.insertRun({
          stepId: step.id,
          runbookId: step.runbookId,
          mode: "terminal",
          status: "awaiting-output",
          startedEarlySeconds: target.skippedWait,
          hostId: target.hostId,
          command: target.command,
          commandHash: target.hash,
          userId: actor(),
          startedAt: now(),
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
        await audit(
          req,
          "runbooks_step_terminal",
          step,
          `runbook ${step.runbookId} step ${stepLabel(step)} sent to a terminal on host ${target.hostId}`,
          true,
        );
        return store.getRun(runId);
      }),
    ),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/runs/{id}/complete:
   *   post:
   *     summary: Finish a terminal run with the pasted output
   *     description: Body { pastedOutput, exitCode?, outcome done|failed }.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   */
  router.post(
    "/runs/:id/complete",
    ...act,
    wrap(async (req) => {
      const run = await store.getRun(pathId(req));
      if (!run) throw new InputError("run not found", 404);
      if (run.mode !== "terminal" || run.status !== "awaiting-output") {
        throw new InputError("this run is not waiting for output", 409);
      }
      const input = body(req);
      const outcome = parseOutcome(input.outcome);
      const pasted =
        optionalText(input.pastedOutput, "pastedOutput", MAX_OUTPUT_BYTES) ??
        "";
      if (outcome === "done" && pasted.trim() === "") {
        throw new InputError(
          "paste at least one line of the output to mark the run done",
        );
      }
      const exitCode = input.exitCode ?? null;
      if (exitCode !== null && !Number.isInteger(exitCode)) {
        throw new InputError("exitCode must be an integer or null");
      }
      const step = await store.getStep(run.stepId);
      if (!step) throw new InputError("step not found", 404);
      const hidden = await madeSecretTexts(
        step,
        await bundleFor(step.runbookId),
      );
      const { final, stored } = await finishRun(
        run.id,
        step,
        outcome,
        pasted,
        { pastedOutput: pasted, exitCode: exitCode as number | null },
        {
          // Mark done tests the checks on what was pasted; Mark failed
          // does not.
          checked:
            outcome === "done"
              ? {
                  mode: "terminal",
                  exitCode: exitCode as number | null,
                  stdout: null,
                  stderr: null,
                  pastedOutput: pasted,
                }
              : undefined,
          by: actor(),
          reason: "manual",
          hidden,
        },
      );
      await audit(
        req,
        "runbooks_step_complete",
        step,
        `runbook ${step.runbookId} step ${stepLabel(step)} marked ${outcome}${
          final !== outcome ? ", checks failed" : ""
        }${storedNote(stored)}`,
        true,
      );
      return store.getRun(run.id);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/manual:
   *   post:
   *     summary: Mark a step with no command, or one run outside Termix, done or failed
   *     description: >
   *       Body { outcome: done|failed, note? }. Records a run in mode manual
   *       with who, when, the outcome and the note. Refused with 400 for a
   *       step that Termix runs. A step run outside Termix (1.4.0) also
   *       takes { revision, output? }: the revision the person saw (409
   *       stale otherwise) and the pasted output, which its checks test
   *       and its captures read; it records a run in mode outside with the
   *       resolved command. A person only.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: Stale, missing values, or a closed runbook }
   */
  router.post(
    "/steps/:id/manual",
    ...act,
    wrap(async (req) =>
      claimed(pathId(req), async (stepId) => {
        const { step, bundle } = await stepContext(stepId);
        requireActionable(step, bundle);
        const outside = isOutsideStep(step);
        if (!outside && (step.hostId !== null || step.command !== null)) {
          throw new InputError(
            "this step has a command: use Run or Send to terminal",
          );
        }
        const input = body(req);
        const outcome = parseOutcome(input.outcome);
        const note = optionalText(input.note, "note", LIMITS.ownerNote) ?? "";
        // A step run outside Termix: the command the person copied, the
        // output they pasted, and the revision they saw.
        let command = "";
        let pasted: string | null = null;
        let results: CheckResult[] | null = null;
        let captured: Record<string, string> = {};
        let final: "done" | "failed" = outcome;
        if (outside) {
          requireRevision(step, input);
          const resolved = resolve(step.command!, valuesObject(bundle.values));
          requireValues(resolved.missing);
          command = resolved.text;
          const output =
            optionalText(input.output, "output", MAX_OUTPUT_BYTES, {
              bytes: true,
            }) ?? "";
          // Done on a step with checks needs the output they read (1.4.1),
          // as a terminal run's Mark done does. Failed needs nothing.
          if (
            outcome === "done" &&
            step.checks.length > 0 &&
            output.trim() === ""
          ) {
            throw new InputError(
              "paste at least one line of the output to mark the step done",
            );
          }
          // An outside step cannot capture or read secrets today; the order
          // is finishRun's anyway: find the secrets, then check the output
          // with them hidden (1.4.1).
          const judged = judgeOutput(
            step,
            outcome,
            {
              mode: "terminal",
              exitCode: null,
              stdout: null,
              stderr: null,
              pastedOutput: output,
            },
            output,
            await madeSecretTexts(step, bundle),
          );
          pasted = output === "" ? null : redact(output, judged.hide);
          ({ results, captured, final } = judged);
        }
        const at = now();
        await events.endStep(step, {
          status: final,
          reason: outcome === "done" ? "check" : "manual",
          by: actor(),
          at,
          run: () =>
            store.insertRun({
              stepId: step.id,
              runbookId: step.runbookId,
              mode: outside ? "outside" : "manual",
              status: final,
              hostId: null,
              command,
              commandHash: "",
              userId: actor(),
              startedAt: at,
              finishedAt: at,
              pastedOutput: pasted,
              note: note.trim() === "" ? null : note,
              checks: results,
              captured,
            }),
        });
        await audit(
          req,
          "runbooks_step_manual",
          step,
          `runbook ${step.runbookId} step ${stepLabel(step)} marked ${final} by hand${
            outside ? " (run outside Termix)" : ""
          }`,
          true,
        );
        return showRunbook(await bundleFor(step.runbookId));
      }),
    ),
  );
}
