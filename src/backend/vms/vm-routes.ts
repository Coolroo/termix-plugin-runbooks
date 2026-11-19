/**
 * VM steps (1.4.7) on the person side: the card's read of the VM, the
 * button that asks HAW to act as the person who pressed it, and Done or
 * Failed after a console. HAW checks the person's role and the host's own
 * limits; Runbooks adds the gates every step has (revision, order, wait,
 * when, the repeat guard) and its own confirm for force (H5).
 */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import { optionalText, parseOutcome } from "../core/parse.js";
import { now } from "../runbooks/store/store.js";
import { pathId, type PersonKit } from "../runbooks/person-kit.js";
import { LIMITS } from "../runbooks/parse.js";
import type { StepRow } from "../runbooks/store/types.js";
import {
  blockingProblem,
  conditionProblem,
  requireActionable,
  requireRevision,
  requireValues,
  waitProblem,
} from "../runbooks/gates.js";
import { notNeededIds } from "../conditions/conditions.js";
import { valuesObject } from "../values/effective.js";
import { fillChecks } from "../../shared/checks.js";
import {
  hostRefusal,
  isVmPower,
  vmVerb,
  type VmSpec,
  type VmStepState,
} from "../../shared/vms.js";
import type { RepeatConflict } from "../../shared/api.js";
import { NO_HAW, type Haw } from "./haw.js";
import { createVmRunner, vmHash, vmRef } from "./vm-run.js";

const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The VM step's field, or 400. */
function vmOf(step: StepRow): VmSpec {
  if (!step.vm) {
    throw new InputError("this step is not a VM step", 400, {
      code: "not-vm-step",
    });
  }
  return step.vm;
}

/** The role an action needs in HAW: viewer to show, operator otherwise. */
function roleProblem(spec: VmSpec, role: string | null): InputError | null {
  const operator = role === "owner" || role === "operator";
  if (spec.action === "show" ? role !== null : operator) return null;
  return new InputError(
    spec.action === "show"
      ? "you have no role in HAW: an owner of HAW gives you one"
      : `your role in HAW (${role ?? "none"}) cannot ${spec.action === "console" ? "open a VM's console" : "start or stop VMs"}: it takes operator or owner`,
    403,
    { code: "role" },
  );
}

export function registerVmRoutes(
  router: Router,
  kit: PersonKit,
  haw: Haw,
): void {
  const {
    store,
    use,
    act,
    claim,
    showRunbook,
    shownRun,
    bundleFor,
    stepContext,
    runSummary,
    auditSkippedWait,
    auditNotNeeded,
    audit,
  } = kit;
  const runner = createVmRunner(kit, haw);
  /** Power actions being pressed now, by vmHash: until their run is written. */
  const pressing = new Set<string>();

  /**
   * The host, the role and the verb, from HAW, before a person acts: the
   * reason the step cannot run, or null.
   */
  async function readiness(spec: VmSpec): Promise<{
    problem: InputError | null;
    role: string | null;
    hostName: string | null;
  }> {
    const { role } = await haw.me();
    const host = (await haw.hosts()).find((h) => h.hostId === spec.host);
    if (!host) {
      return {
        problem: new InputError(
          `host ${spec.host} is not a VM host in HAW, or you cannot see it`,
          404,
          { code: "not-a-vm-host" },
        ),
        role,
        hostName: null,
      };
    }
    const verb = vmVerb(spec.action);
    // HAW offers only the verbs it read from the host (BUG-016): none read
    // yet allows nothing.
    if (host.verbs.length === 0) {
      return {
        problem: new InputError(
          `HAW has not read ${host.name}'s verbs yet: check the host in HAW's tab, then try again`,
          409,
          { code: "verbs-unknown" },
        ),
        role,
        hostName: host.name,
      };
    }
    if (!host.verbs.includes(verb)) {
      return {
        problem: new InputError(
          `${host.name} does not offer ${verb}: its vmctl lists ${host.verbs.join(", ")}`,
          409,
          { code: "verb-not-offered" },
        ),
        role,
        hostName: host.name,
      };
    }
    return { problem: roleProblem(spec, role), role, hostName: host.name };
  }

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/vm:
   *   get:
   *     summary: What a VM step's card shows before the button is pressed
   *     description: >
   *       1.4.7. Reads, as the signed-in person, whether HAW can do the
   *       step's action now (ready, reason, code), the person's HAW role,
   *       the VM's details now (HAW's show) and whether the host's own
   *       limits refuse the action (refused). A read: not in HAW's record.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The VM step's state }
   *       400: { description: Not a VM step }
   */
  router.get(
    "/steps/:id/vm",
    ...use,
    wrap(async (req): Promise<VmStepState> => {
      const step = await store.getStep(pathId(req));
      if (!step) throw new InputError("step not found", 404);
      const spec = vmOf(step);
      const state: VmStepState = {
        ready: false,
        reason: null,
        code: null,
        vm: null,
        refused: null,
        role: null,
        hostName: null,
        at: now(),
      };
      const fail = (error: unknown) => {
        if (!(error instanceof InputError)) throw error;
        state.ready = false;
        state.reason = error.message;
        state.code = String(error.extra.code ?? "haw-error");
      };
      try {
        const ready = await readiness(spec);
        state.role = ready.role;
        state.hostName = ready.hostName;
        if (ready.problem) fail(ready.problem);
        else state.ready = true;
        if (state.code === "not-a-vm-host") return state;
        state.vm = await haw.show(spec.host, spec.name, vmRef(step));
        state.refused = hostRefusal(spec.action, state.vm);
      } catch (error) {
        fail(error);
      }
      return state;
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/vm:
   *   post:
   *     summary: Do a VM step's action through HAW, as the signed-in person
   *     description: >
   *       1.4.7. Body { revision, confirmRepeat?, confirmForce?,
   *       outOfOrder?, waitAnyway?, conditionAnyway? }. HAW checks the
   *       person's role and the host's limits. start, stop, restart and
   *       show answer at once with { run } in status running; the run
   *       waits for the step's waitFor (reading the VM every 2 seconds)
   *       and ends with the VM's details and a summary line as its output.
   *       console answers { run, consoleHost }: a run that waits for the
   *       person's Done or Failed (steps/{id}/vm/end) while they use the
   *       console in Remote Desktop. A person only.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: "{ run, consoleHost }" }
   *       400: { description: Not a VM step }
   *       403: { description: Runbooks may not act in HAW, or the person's HAW role is too low }
   *       409: { description: Stale, no HAW, not needed, out of order, wait, force, repeat or running }
   */
  router.post(
    "/steps/:id/vm",
    ...act,
    wrap(async (req) => {
      const stepId = pathId(req);
      const release = claim(stepId);
      let handedOff = false;
      let pressed: string | null = null;
      try {
        const { step, bundle } = await stepContext(stepId);
        requireActionable(step, bundle);
        const spec = vmOf(step);
        const input = body(req);
        requireRevision(step, input);
        const runs = bundle.runsByStep.get(step.id) ?? [];
        const open = runs.find(
          (run) => run.status === "running" || run.status === "awaiting-output",
        );
        // A console stays open until the person says Done or Failed: a
        // second press opens it again, with no new run.
        if (open && !(spec.action === "console" && open.mode === "vm")) {
          throw new InputError("this step is already running", 409, {
            code: "running",
          });
        }
        const filled = fillChecks(step.checks, valuesObject(bundle.values));
        requireValues(filled.missing);
        if (!(await haw.available())) {
          throw new InputError(NO_HAW, 409, { code: "no-haw" });
        }
        // HAW's answers before the questions a person could answer: no
        // answer to them gives a role or a host.
        const ready = await readiness(spec);
        if (ready.problem) throw ready.problem;
        if (open) return reopenConsole(step, spec, open.id);
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
        const wait = waitProblem(step, bundle, input.waitAnyway === true);
        if (wait.problem) throw wait.problem;
        // H5: turning off or resetting without the guest asks on its own.
        if (spec.force && input.confirmForce !== true) {
          throw new InputError(
            spec.action === "stop"
              ? `turn off ${spec.name} without shutting it down? Unsaved work in it is lost`
              : `reset ${spec.name} without shutting it down? Unsaved work in it is lost`,
            409,
            { code: "force", action: spec.action, name: spec.name },
          );
        }
        const hash = vmHash(spec);
        // The same action on the same VM from another step at once: that
        // press has not written its run yet, so the repeat guard below
        // cannot see it (BUG-016).
        if (isVmPower(spec.action)) {
          if (pressing.has(hash)) {
            throw new InputError(
              `${spec.action} ${spec.name} is being pressed on another step now`,
              409,
              { code: "running" },
            );
          }
          pressing.add(hash);
          pressed = hash;
        }
        if (isVmPower(spec.action) && input.confirmRepeat !== true) {
          const sameStep = runs[0];
          const since = new Date(Date.now() - REPEAT_WINDOW_MS).toISOString();
          const recent = sameStep ?? (await store.lastRunOfHash(hash, since));
          if (recent) {
            throw new InputError(
              sameStep
                ? "this step already ran"
                : `${spec.action} ${spec.name} ran on this host in the last 24 hours`,
              409,
              {
                code: "repeat",
                repeat: runSummary(recent, Boolean(sameStep)),
              } satisfies RepeatConflict,
            );
          }
        }
        await auditSkippedWait(req, step, wait.skippedSeconds);
        await auditNotNeeded(req, step, condition.overridden);
        if (spec.action === "console") {
          const result = await runner.openConsole(req, step, spec, {
            hash,
            startedEarlySeconds: wait.skippedSeconds,
          });
          return {
            run: await shownRun(result.runId),
            consoleHost: result.consoleHost,
          };
        }
        const runId = await runner.start(req, step, spec, {
          hash,
          startedEarlySeconds: wait.skippedSeconds,
          release,
        });
        handedOff = true;
        return { run: await shownRun(runId), consoleHost: null };
      } finally {
        // The run is written by now: the repeat guard sees it.
        if (pressed) pressing.delete(pressed);
        if (!handedOff) release();
      }
    }),
  );

  /** A second Open console on a console that is open: HAW is asked again. */
  async function reopenConsole(step: StepRow, spec: VmSpec, runId: number) {
    const answer = await haw.console(spec.host, spec.name, vmRef(step));
    return { run: await shownRun(runId), consoleHost: answer.consoleHost };
  }

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/vm/end:
   *   post:
   *     summary: Done or Failed after a VM step's console
   *     description: >
   *       1.4.7. Body { outcome: done|failed, note? }. Ends the console's
   *       run and the step. A person only.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: No console is open for this step }
   */
  router.post(
    "/steps/:id/vm/end",
    ...act,
    wrap(async (req) => {
      const stepId = pathId(req);
      const release = claim(stepId);
      try {
        const { step, bundle } = await stepContext(stepId);
        requireActionable(step, bundle);
        vmOf(step);
        const input = body(req);
        const outcome = parseOutcome(input.outcome);
        const note = optionalText(input.note, "note", LIMITS.ownerNote) ?? "";
        const open = (bundle.runsByStep.get(step.id) ?? []).find(
          (run) => run.mode === "vm" && run.status === "awaiting-output",
        );
        if (!open) {
          throw new InputError("no console is open for this step", 409, {
            code: "not-running",
          });
        }
        await runner.endConsole(step, open.id, outcome, note.trim() || null);
        await audit(
          req,
          "runbooks_step_vm",
          step,
          `${vmRef(step)}: console marked ${outcome}`,
          true,
        );
        return showRunbook(await bundleFor(step.runbookId));
      } finally {
        release();
      }
    }),
  );
}
