/**
 * What an agent does to a step once the runbook runs (1.4.0): it ends its
 * own step (complete_step) or amends a step (amend_step).
 */

import type { AmendKind } from "../../runbooks/store/types.js";
import { now, type Store } from "../../runbooks/store/store.js";
import { amendmentView } from "../../runbooks/view.js";
import {
  checkStepCount,
  completeStep,
  LIMITS,
  parseStepInput,
  type AuthorStep,
} from "../../runbooks/parse.js";
import { blockingProblem } from "../../runbooks/gates.js";
import { judgeOutput } from "../../checks/checks.js";
import { stepResource } from "../../core/audit.js";
import { InputError } from "../../core/errors.js";
import { optionalText, parseOutcome } from "../../core/parse.js";
import { isOneLine } from "../../../shared/names.js";
import {
  isAgentStep,
  stepLabel,
  suffixAt,
  suffixIndex,
} from "../../../shared/steps.js";
import type { Events } from "../events.js";
import type { Access, AgentCaller } from "./access.js";
import type { Reads } from "./reads.js";
import type { AgentAudit } from "./ops.js";
import { checkSecretReads, objectBody, toStored } from "./authoring.js";

export function createComplete(
  store: Store,
  events: Events,
  options: { audit?: AgentAudit },
  { checkHosts, ownStep }: Access,
  { getRunbook }: Pick<Reads, "getRunbook">,
) {
  /**
   * Ends an agent step: done or failed, with a note and the output the
   * agent got. Only a step with owner "agent", in an open runbook, still
   * pending, and only once every earlier step ended (done, failed or
   * skipped). Records a run in mode agent; checks test the output.
   */
  async function completeAgentStep(
    caller: AgentCaller,
    stepId: number,
    input: unknown,
  ) {
    const { step, runbook } = await ownStep(caller, stepId);
    if (!isAgentStep(step)) {
      throw new InputError(
        "this step is for a person; an agent completes only steps with owner agent",
        403,
        { code: "person-step" },
      );
    }
    if (runbook.status !== "open") {
      throw new InputError(`runbook is ${runbook.status}`, 409, {
        code: "closed",
      });
    }
    if (step.status !== "pending") {
      throw new InputError(
        `this step already ended (${step.status}); only a person can reopen it`,
        409,
        { code: "ended" },
      );
    }
    const steps = await store.listSteps(runbook.id);
    const blocking = blockingProblem(step, steps, "; it is not your turn yet");
    if (blocking) throw blocking;
    const parsed = parseCompletion(input);
    // An agent step has no secrets to find today; the order is the same as
    // a person's run anyway: checks see the output with secrets hidden.
    // Mark failed tests no checks; an agent step takes no captures.
    const { results, final } = judgeOutput(
      step,
      parsed.outcome,
      parsed.outcome === "done"
        ? {
            mode: "terminal",
            exitCode: null,
            stdout: null,
            stderr: null,
            pastedOutput: parsed.output ?? "",
          }
        : null,
      parsed.output,
      [],
      { captures: false },
    );
    const at = now();
    const by = caller.token.name;
    await events.endStep(step, {
      status: final,
      reason:
        final === "done"
          ? null
          : parsed.outcome === "failed"
            ? "manual"
            : "check",
      by,
      at,
      run: () =>
        store.insertRun({
          stepId: step.id,
          runbookId: runbook.id,
          mode: "agent",
          status: final,
          hostId: null,
          command: step.command ?? "",
          commandHash: "",
          userId: caller.token.name,
          startedAt: at,
          finishedAt: at,
          stdout: parsed.output,
          note: parsed.note,
          checks: results,
        }),
    });
    await options.audit?.({
      action: "runbooks_step_agent_complete",
      ...stepResource(step),
      details: `runbook ${runbook.id} step ${stepLabel(step)} marked ${parsed.outcome} by agent token ${caller.token.name}${
        final !== parsed.outcome ? ", checks failed" : ""
      }`,
      success: true,
    });
    return getRunbook(caller, runbook.id);
  }

  /**
   * Amends a step in place (1.4.0): a fixed version of a step that did not
   * end done (kind replace), or an extra step after any step (kind substep).
   * The new step keeps the step's position and gets the next letter (3a,
   * 3b); no other step moves. A replaced step's status becomes "replaced":
   * it stays with its runs and counts as ended. The new step is checked
   * like any new step.
   */
  async function amendStep(
    caller: AgentCaller,
    stepId: number,
    input: unknown,
  ) {
    const { step, runbook } = await ownStep(caller, stepId);
    const parsed = parseAmendment(input);
    if (runbook.status !== "open") {
      throw new InputError(
        `runbook is ${runbook.status}; set status to open before changing steps`,
        409,
        { code: "closed" },
      );
    }
    const steps = await store.listSteps(runbook.id);
    const runs = await store.listRuns({ stepId: step.id });
    if (
      runs.some(
        (run) => run.status === "running" || run.status === "awaiting-output",
      )
    ) {
      throw new InputError(
        `step ${stepLabel(step)} is running; wait until its run ends`,
        409,
        { code: "running" },
      );
    }
    if (parsed.kind === "replace") {
      if (step.status === "done") {
        throw new InputError(
          `step ${stepLabel(step)} ended done, so it cannot be replaced; add a sub-step instead (kind substep)`,
          409,
          { code: "done" },
        );
      }
      if (step.status === "replaced") {
        const by = amendmentView(step, steps).replacedBy;
        throw new InputError(
          `step ${stepLabel(step)} was already replaced${
            by ? ` by ${by.label}; amend ${by.label} instead` : ""
          }`,
          409,
          { code: "replaced", replacedBy: by },
        );
      }
    }
    checkStepCount(steps.length + 1);
    let fresh = parsed.step;
    // Output the person hid from agents stays hidden in its fixed version.
    if (parsed.kind === "replace" && step.hideOutputFromAgents) {
      fresh = { ...fresh, hideOutputFromAgents: true };
    }
    await checkHosts(caller, [fresh]);
    const group = steps.filter((s) => s.position === step.position);
    const last = Math.max(-1, ...group.map((s) => suffixIndex(s.suffix)));
    const own = { position: step.position, suffix: suffixAt(last + 1) };
    checkSecretReads([...steps, { ...fresh, ...own }]);
    const stored = toStored(fresh, own, steps, "step: ");
    const by = caller.token.name;
    let newId = 0;
    await events.around(runbook.id, by, async () => {
      newId = await store.insertStep(runbook.id, step.position, stored, {
        suffix: own.suffix,
        amendsStepId: step.id,
        amendKind: parsed.kind,
        amendReason: parsed.reason,
        amendedBy: by,
      });
      if (parsed.kind === "replace") {
        await store.updateStep(step.id, {
          status: "replaced",
          endedAt: step.endedAt ?? now(),
        });
      }
      await events.record({
        runbook,
        stepId: newId,
        type: "amended",
        reason: parsed.kind,
        by,
      });
      await store.touchRunbook(runbook.id);
      await store.persist();
    });
    await options.audit?.({
      action: "runbooks_step_amend",
      ...stepResource({ id: newId, title: fresh.title }),
      details: `runbook ${runbook.id} step ${stepLabel(step)} ${
        parsed.kind === "replace" ? "replaced by" : "got sub-step"
      } ${stepLabel(own)} from agent token ${by}`,
      success: true,
    });
    return getRunbook(caller, runbook.id);
  }

  return { completeAgentStep, amendStep };
}

/** { kind, reason, step } as an agent amends a step. */
function parseAmendment(input: unknown): {
  kind: AmendKind;
  reason: string;
  step: AuthorStep;
} {
  const raw = objectBody(input, ["kind", "reason", "step"]);
  if (raw.kind !== "replace" && raw.kind !== "substep") {
    throw new InputError('kind must be "replace" or "substep"');
  }
  if (typeof raw.reason !== "string" || raw.reason.trim() === "") {
    throw new InputError("reason is required: say why you amend the step");
  }
  const reason = raw.reason.trim();
  if (reason.length > LIMITS.amendReason) {
    throw new InputError(
      `reason is longer than ${LIMITS.amendReason} characters`,
    );
  }
  if (!isOneLine(reason)) {
    throw new InputError("reason must be one line, without control characters");
  }
  let step: AuthorStep;
  try {
    step = completeStep(parseStepInput(raw.step));
  } catch (error) {
    if (error instanceof InputError) {
      throw new InputError(`step: ${error.message}`, error.status);
    }
    throw error;
  }
  return { kind: raw.kind, reason, step };
}

/** { outcome, note?, output? } as an agent completes its step. */
function parseCompletion(input: unknown): {
  outcome: "done" | "failed";
  note: string | null;
  output: string | null;
} {
  const raw = objectBody(input, ["outcome", "note", "output"]);
  const outcome = parseOutcome(raw.outcome, "agent");
  const note = optionalText(raw.note, "note", LIMITS.agentNote, {
    wording: "agent",
  });
  const output = optionalText(raw.output, "output", LIMITS.agentOutputBytes, {
    bytes: true,
    wording: "agent",
  });
  return {
    outcome,
    note: note && note.trim() ? note : null,
    output,
  };
}
