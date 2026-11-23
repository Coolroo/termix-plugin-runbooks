/** Run, Stop, Send to terminal, Mark done or failed, and Done by hand. */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import { optionalText, parseOutcome } from "../core/parse.js";
import { now } from "../runbooks/store/store.js";
import {
  pathId,
  vmStepProblem,
  type PersonKit,
} from "../runbooks/person-kit.js";
import { LIMITS } from "../runbooks/parse.js";
import {
  agentStepProblem,
  conditionProblem,
  requireActionable,
  requireRevision,
  requireValues,
} from "../runbooks/gates.js";
import { agentCommand, valuesObject } from "../values/effective.js";
import { judgeOutput, type CheckResult } from "../checks/checks.js";
import { isAgentStep, isOutsideStep, stepLabel } from "../../shared/steps.js";
import { redact } from "./redact.js";
import { describeStdin, stepStdin } from "./stdin.js";
import { createRunner, LINE_END, MAX_OUTPUT_BYTES } from "./runner.js";
import { MAX_PASTED_CHARS, MAX_TYPED_BYTES } from "../../shared/limits.js";
import { OUTPUT_SOURCES, type OutputSource } from "../../shared/api.js";
import { resumeIndex } from "../../shared/sequence.js";
import { createSequenceRunner } from "./sequence-run.js";

/** How long Stop waits for the run to be written before it answers. */
const STOP_WAIT_MS = 5000;
const NO_HOST_KEY =
  "open a Terminal to this host once to store its host key, then run the step again";

/**
 * Where Mark done's output came from (1.4.9): the page says so, and the
 * person saw and could change it. Pasted when left out, as before.
 */
function parseOutputSource(value: unknown): OutputSource {
  if (value === undefined || value === null) return "pasted";
  if (!OUTPUT_SOURCES.includes(value as OutputSource)) {
    throw new InputError(
      `outputSource must be one of ${OUTPUT_SOURCES.join(", ")}`,
    );
  }
  return value as OutputSource;
}

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
    auditNotNeeded,
    storedNote,
    audit,
  } = kit;
  const { readStdin, madeSecretTexts, finishRun, execute } = createRunner(kit);
  const sequences = createSequenceRunner(kit);

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
        const target = await checkRunnable(step, bundle, body(req), {
          via: "run",
        });
        // Without a stored key, a connection with no person to ask accepts
        // whatever key the server shows. Refuse rather than trust it.
        if (!target.host.hostKeyFingerprint) {
          throw new InputError(NO_HOST_KEY, 409, { code: "no-host-key" });
        }
        // 1.4.10: a sequence runs its items one after another.
        if (step.sequence && target.items) {
          const hidden = await madeSecretTexts(step, bundle);
          await auditSkippedWait(req, step, target.skippedWait);
          await auditNotNeeded(req, step, target.overridden);
          const runId = await sequences.start(
            req,
            step,
            bundle,
            {
              by: actor(),
              hostId: target.hostId,
              command: target.command,
              hash: target.hash,
              items: target.items,
              skippedWait: target.skippedWait,
            },
            hidden,
            release,
          );
          handedOff = true;
          return shownRun(runId);
        }
        const input = target.stdin
          ? await readStdin(step, bundle, target.stdin)
          : null;
        const hidden = await madeSecretTexts(step, bundle);
        await auditSkippedWait(req, step, target.skippedWait);
        await auditNotNeeded(req, step, target.overridden);
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
            checks: target.checks,
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
   * /plugin-api/runbooks/steps/{id}/continue:
   *   post:
   *     summary: Continue a sequence step from the item where it stopped
   *     description: >
   *       Body { revision, commandHash, fromItem?, waitAnyway?, outOfOrder?,
   *       conditionAnyway? } (1.4.10). The step's latest run must be a
   *       sequence run that failed, was stopped, or was cut off by a
   *       restart. Makes a new run: the items that passed are carried over
   *       and do not run again, and the first item that did not pass runs
   *       next. fromItem, when given, must be that item's number. Refused
   *       with 409 when the sequence changed since that run.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The new run, still running }
   *       409: { description: Nothing to continue, changed, stale, wait or order }
   */
  router.post(
    "/steps/:id/continue",
    ...act,
    wrap(async (req) => {
      const stepId = pathId(req);
      const release = claim(stepId);
      let handedOff = false;
      try {
        const { step, bundle } = await stepContext(stepId);
        if (!step.sequence) {
          throw new InputError(
            "only a sequence step continues from an item: use Run",
            400,
            { code: "not-sequence" },
          );
        }
        const latest = bundle.runsByStep.get(step.id)?.[0];
        const index = latest?.items ? resumeIndex(latest.items) : null;
        if (
          !latest ||
          latest.mode !== "exec" ||
          latest.status !== "failed" ||
          index === null
        ) {
          throw new InputError(
            "this step has no stopped or failed sequence run to continue: use Run",
            409,
            { code: "nothing-to-continue" },
          );
        }
        const input = body(req);
        // The person chose to go on from this run: it is not a repeat.
        const target = await checkRunnable(
          step,
          bundle,
          { ...input, confirmRepeat: true },
          { via: "run" },
        );
        if (!target.host.hostKeyFingerprint) {
          throw new InputError(NO_HOST_KEY, 409, { code: "no-host-key" });
        }
        if (
          !target.items ||
          latest.commandHash !== target.hash ||
          latest.items!.length !== step.sequence.length
        ) {
          throw new InputError(
            "the sequence changed since that run: run it again from item 1",
            409,
            { code: "changed" },
          );
        }
        if (
          input.fromItem !== undefined &&
          input.fromItem !== null &&
          input.fromItem !== index + 1
        ) {
          throw new InputError(`that run goes on from item ${index + 1}`, 409, {
            code: "changed",
          });
        }
        const hidden = await madeSecretTexts(step, bundle);
        await auditSkippedWait(req, step, target.skippedWait);
        await auditNotNeeded(req, step, target.overridden);
        const runId = await sequences.start(
          req,
          step,
          bundle,
          {
            by: actor(),
            hostId: target.hostId,
            command: target.command,
            hash: target.hash,
            items: target.items,
            skippedWait: target.skippedWait,
          },
          hidden,
          release,
          { run: latest, index },
        );
        handedOff = true;
        await audit(
          req,
          "runbooks_step_continue",
          step,
          `runbook ${step.runbookId} step ${stepLabel(step)} run ${runId} continues run ${latest.id} from item ${index + 1}`,
          true,
        );
        return shownRun(runId);
      } finally {
        if (!handedOff) release();
      }
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/skip-delay:
   *   post:
   *     summary: End the delay item that runs now, and go on
   *     description: >
   *       1.4.10. The delay item ends as skipped, which counts as passed,
   *       and the next item starts. A person only.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   *       409: { description: No delay of this step runs now }
   */
  router.post(
    "/steps/:id/skip-delay",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(pathId(req));
      const record = live.byStep(step.id);
      if (!record?.skipDelay) {
        throw new InputError("no delay of this step is running", 409, {
          code: "no-delay",
        });
      }
      await record.skipDelay(actor());
      return shownRun(record.runId);
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
          via: "terminal",
        });
        await auditSkippedWait(req, step, target.skippedWait);
        await auditNotNeeded(req, step, target.overridden);
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
   *     description: >
   *       Body { pastedOutput, exitCode?, outcome done|failed, outputSource? }.
   *       outputSource is pasted (the default), captured (read from the
   *       terminal by the page, 1.4.9) or captured-edited.
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
        optionalText(input.pastedOutput, "pastedOutput", MAX_PASTED_CHARS) ??
        "";
      if (outcome === "done" && pasted.trim() === "") {
        throw new InputError(
          "paste at least one line of the output to mark the run done",
        );
      }
      // Text read from the terminal is kept as the pasted output, so its
      // secrets are hidden and its checks and captures run as for a paste.
      const source = parseOutputSource(input.outputSource);
      const exitCode = input.exitCode ?? null;
      if (exitCode !== null && !Number.isInteger(exitCode)) {
        throw new InputError("exitCode must be an integer or null");
      }
      const step = await store.getStep(run.stepId);
      if (!step) throw new InputError("step not found", 404);
      const bundle = await bundleFor(step.runbookId);
      // Checks get the values the runbook has now (BUG-007); Mark done
      // cannot test a check whose value is not set.
      const { checks, missing } = agentCommand(
        step,
        valuesObject(bundle.values),
      );
      if (outcome === "done") requireValues(missing);
      const hidden = await madeSecretTexts(step, bundle);
      const { final, stored } = await finishRun(
        run.id,
        step,
        outcome,
        pasted,
        {
          pastedOutput: pasted,
          exitCode: exitCode as number | null,
          outputSource: pasted === "" ? null : source,
        },
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
          checks,
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
   * /plugin-api/runbooks/runs/{id}/input:
   *   post:
   *     summary: Type into a running command
   *     description: >
   *       Body { text, hidden?, end? } (1.4.6). Writes text to the running
   *       command's standard input as it is (the page adds the line end: LF, or CR
   *       for an interactive step, where a trailing LF becomes CR),
   *       then ends the input when end is true: EOF, or Ctrl-D for an
   *       interactive step. Only the person who started the run; refused
   *       for a Termix API key. The text is never stored or logged: the run
   *       keeps { at, chars, hidden, ended }, and a hidden text of 4
   *       characters or more is hidden in its output as [secret:typed].
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   *       400: { description: No text and no end, or more than 4 KB }
   *       403: { description: Another person started the run }
   *       409: { description: Not running, input from stdin, or input ended }
   */
  router.post(
    "/runs/:id/input",
    ...act,
    wrap(async (req) => {
      const run = await store.getRun(pathId(req));
      if (!run) throw new InputError("run not found", 404);
      const input = body(req);
      const text = input.text ?? "";
      if (typeof text !== "string") {
        throw new InputError("text must be a string");
      }
      for (const flag of ["hidden", "end"] as const) {
        if (input[flag] !== undefined && typeof input[flag] !== "boolean") {
          throw new InputError(`${flag} must be true or false`);
        }
      }
      const hidden = input.hidden === true;
      const end = input.end === true;
      if (text === "" && !end) {
        throw new InputError("type some text, or end the input");
      }
      if (Buffer.byteLength(text, "utf8") > MAX_TYPED_BYTES) {
        throw new InputError(
          `at most ${MAX_TYPED_BYTES / 1024} KB at once`,
          400,
          { code: "too-long" },
        );
      }
      const record = run.status === "running" ? live.get(run.id) : undefined;
      if (run.mode !== "exec" || !record) {
        throw new InputError("this run is not running", 409, {
          code: "not-running",
        });
      }
      if (run.stdin) {
        throw new InputError(
          `this run got its input from ${describeStdin(run.stdin)}: it takes no typed input`,
          409,
          { code: "stdin-source" },
        );
      }
      // D6: only the person who started it, who sees what they answer.
      if (run.userId !== actor()) {
        throw new InputError(
          `only ${run.userId}, who started this run, can type into it`,
          403,
          { code: "not-your-run" },
        );
      }
      const closed = () =>
        new InputError(
          "the command takes no input now: it has not started yet, or its input was ended",
          409,
          { code: "input-closed" },
        );
      if (!record.input?.open()) throw closed();
      const step = await store.getStep(run.stepId);
      if (!step) throw new InputError("step not found", 404);
      if (text !== "" && !record.input.send(text, hidden)) throw closed();
      if (end && !record.input.end()) throw closed();
      const chars = [...text.replace(LINE_END, "")].length;
      live.typed(run.id, { at: now(), chars, hidden, ended: end });
      // The size and the flags only: never the text.
      const what =
        text === ""
          ? "input ended"
          : `input sent: ${chars} characters${hidden ? ", hidden" : ""}${
              end ? ", then input ended" : ""
            }`;
      await audit(
        req,
        "runbooks_step_input",
        step,
        `runbook ${step.runbookId} step ${stepLabel(step)} run ${run.id}: ${what}`,
        true,
      );
      return shownRun(run.id);
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
        if (step.decision) {
          throw new InputError(
            "this is a decision step: choose an option and press Confirm",
            400,
            { code: "decision" },
          );
        }
        if (step.vm) throw vmStepProblem();
        const outside = isOutsideStep(step);
        if (!outside && (step.hostId !== null || step.command !== null)) {
          throw new InputError(
            "this step has a command: use Run or Send to terminal",
          );
        }
        const input = body(req);
        const outcome = parseOutcome(input.outcome);
        const note = optionalText(input.note, "note", LIMITS.ownerNote) ?? "";
        // A step its rule says is not needed (1.4.6), unless "anyway".
        const condition = conditionProblem(
          step,
          bundle,
          input.conditionAnyway === true,
        );
        if (condition.problem) throw condition.problem;
        // A step run outside Termix: the command the person copied, the
        // output they pasted, and the revision they saw.
        let command = "";
        let pasted: string | null = null;
        let results: CheckResult[] | null = null;
        let captured: Record<string, string> = {};
        let final: "done" | "failed" = outcome;
        if (outside) {
          requireRevision(step, input);
          // The command's values and the checks' (BUG-007).
          const resolved = agentCommand(step, valuesObject(bundle.values));
          requireValues(resolved.missing);
          command = resolved.command!;
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
            { ...step, checks: resolved.checks },
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
        // Every question passed: the step ends now (BUG-008).
        await auditNotNeeded(req, step, condition.overridden);
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
              outputSource: pasted === null ? null : "pasted",
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
