/**
 * What an agent writes before a person runs it: runbooks, and steps added,
 * changed, removed or put in a new order. A step that ran stays as it is.
 */

import type { NewStep, StepRow } from "../../runbooks/store/types.js";
import type { Store } from "../../runbooks/store/store.js";
import {
  checkStepCount,
  checkStepShape,
  completeStep,
  parseOwner,
  parseStatus,
  parseStepInput,
  parseSummary,
  parseTitle,
  parseValues,
  type AuthorStep,
} from "../../runbooks/parse.js";
import { secretReadsProblem } from "../../secrets/secret-view.js";
import { StdinPositionError, storeStdin } from "../../running/stdin.js";
import {
  hiddenValueNames,
  RuleError,
  ruleStepIds,
  ruleValueNames,
  showWhen,
  storeWhen,
  type KnownStep,
} from "../../conditions/conditions.js";
import { InputError } from "../../core/errors.js";
import { strictObject } from "../../core/parse.js";
import {
  isAgentStep,
  isBefore,
  stepLabel,
  type StepNumber,
} from "../../../shared/steps.js";
import { fillChecks, type Check } from "../../../shared/checks.js";
import { parseNotify, type Events } from "../events.js";
import type { Access, AgentCaller } from "./access.js";
import type { Reads } from "./reads.js";

/**
 * A step and the step number it has, or will have, with what a when rule
 * may read of it: its captures, its decision, whether it hides its output
 * from agents and whether it is interactive.
 */
type Numbered = KnownStep;

/** What a Numbered step keeps of a step as written. */
const known = (step: AuthorStep) => ({
  captures: step.captures,
  decision: step.decision,
  hideOutputFromAgents: step.hideOutputFromAgents,
  interactive: step.interactive,
});

/** A step and its amendments: the steps that share its position. */
function groupOf(steps: StepRow[], head: StepRow): StepRow[] {
  return [
    head,
    ...steps.filter((s) => s.suffix && s.position === head.position),
  ];
}

/**
 * A request body as an object, with only `keys` when given; null, an array
 * or a scalar is refused.
 */
export function objectBody(
  input: unknown,
  keys: readonly string[] | null = null,
): Record<string, unknown> {
  return strictObject(input, keys, { notObject: "body must be an object" });
}

function parseSteps(input: unknown): AuthorStep[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new InputError("steps must be an array");
  return input.map((raw, index) => {
    try {
      return completeStep(parseStepInput(raw));
    } catch (error) {
      if (error instanceof InputError) {
        throw new InputError(`steps[${index}]: ${error.message}`);
      }
      throw error;
    }
  });
}

/**
 * The step as stored: a stdin step source and the steps a when rule names
 * by id, for a step numbered `own` among `known`, the steps before it
 * with their numbers then. `hiddenValues` are the values that steps hidden
 * from agents capture (BUG-008): the rule may not read them.
 */
export function toStored(
  step: AuthorStep,
  own: StepNumber,
  known: Numbered[],
  label: string,
  hiddenValues: ReadonlySet<string>,
): NewStep {
  const idOf = (ref: { position: number; suffix: string | null }) =>
    known.find(
      (other) =>
        other.position === ref.position &&
        (other.suffix ?? null) === ref.suffix,
    )?.id ?? null;
  checkAgentChecks(step, hiddenValues, label);
  try {
    return {
      ...step,
      stdin: storeStdin(step.stdin, own, idOf),
      when: step.when
        ? storeWhen(step.when, { own, known, hiddenValues })
        : null,
    };
  } catch (error) {
    if (error instanceof StdinPositionError || error instanceof RuleError) {
      throw new InputError(`${label}${error.message}`);
    }
    throw error;
  }
}

/**
 * Works out every new step as stored before any is stored (BUG-013), so a
 * check, when rule or stdin that a later step gets wrong refuses the
 * request with nothing stored. Each new step stands in with an id no step
 * has; the route then stores the steps with their real ids.
 */
function checkStored(
  added: ReadonlyArray<AuthorStep & StepNumber>,
  before: Numbered[],
  hiddenValues: ReadonlySet<string>,
): void {
  const made: Numbered[] = [];
  for (const [index, step] of added.entries()) {
    const own = { position: step.position, suffix: step.suffix };
    toStored(
      step,
      own,
      [...before, ...made],
      `steps[${index}]: `,
      hiddenValues,
    );
    made.push({ ...own, id: -(index + 1), ...known(step) });
  }
}

/**
 * An agent step's checks may not use a value that a step hidden from
 * agents captures (BUG-011): the agent hands in the output they test, so
 * such a check would tell it whether a guess equals the hidden value.
 * Agent steps are checked with the values agents see whatever the rule
 * (complete.ts); this refuses the check when the step is written.
 */
export function checkAgentChecks(
  step: { owner?: string | null; checks?: readonly Check[] },
  hiddenValues: ReadonlySet<string>,
  label: string,
): void {
  if (!isAgentStep(step)) return;
  for (const [index, check] of (step.checks ?? []).entries()) {
    const name = fillChecks([check], {}).missing.find((used) =>
      hiddenValues.has(used),
    );
    if (name) {
      throw new InputError(
        `${label}checks[${index}]: an agent step's check cannot use {{${name}}}, a value of a step hidden from agents`,
      );
    }
  }
}

/** A step whose when rule names `stepId`, if any (1.4.6). */
function ruleReader(steps: StepRow[], stepId: number): StepRow | undefined {
  return steps.find((s) => ruleStepIds(s.when).includes(stepId));
}

/** The values a step sets: its captures and its decision's value. */
function valueNamesOf(step: Numbered): string[] {
  return [
    ...(step.captures ?? []).map((capture) => capture.name),
    ...(step.decision?.value ? [step.decision.value] : []),
  ];
}

/**
 * Checks again each rule that reads a step whose captures, decision or
 * terminal changed (BUG-008): by naming the step, or by reading a value it
 * sets, before or after the change. `steps` are the steps after it. A rule
 * of a step that ran is history and is left as it is. Throws a 409 `when`.
 * With `from`, only rules of steps after it are checked: an amendment's
 * replacement is read only by those (D1, BUG-010).
 */
export function recheckReaders(
  steps: StepRow[],
  before: StepRow,
  after: StepRow,
  withRuns: ReadonlySet<number>,
  from: StepNumber | null = null,
): void {
  const names = new Set([...valueNamesOf(before), ...valueNamesOf(after)]);
  const hiddenValues = hiddenValueNames(steps);
  for (const reader of steps) {
    if (!reader.when || withRuns.has(reader.id)) continue;
    if (from && !isBefore(from, reader)) continue;
    if (
      !ruleStepIds(reader.when).includes(after.id) &&
      !ruleValueNames(reader.when).some((name) => names.has(name))
    ) {
      continue;
    }
    try {
      storeWhen(showWhen(reader.when, steps), {
        own: reader,
        known: steps,
        hiddenValues,
      });
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      throw new InputError(
        `step ${stepLabel(reader)} has a when rule that this change breaks (${error.message}); change that rule first`,
        409,
        { code: "when" },
      );
    }
  }
}

/** A secret read by name needs an earlier step that captures it. */
export function checkSecretReads(
  steps: Parameters<typeof secretReadsProblem>[0],
  status = 400,
): void {
  const problem = secretReadsProblem(steps);
  if (problem) throw new InputError(problem, status);
}

export function createAuthoring(
  store: Store,
  events: Events,
  { owner, checkHosts, ownRunbook, ownStep, requireOpen }: Access,
  { getRunbook }: Pick<Reads, "getRunbook">,
) {
  /**
   * Numbers the steps that are not amendments 1, 2, 3 in `order`. Each
   * step's amendments (same position, with a suffix) move with it.
   */
  async function renumber(runbookId: number, order: number[]): Promise<void> {
    const steps = await store.listSteps(runbookId);
    const byId = new Map(steps.map((step) => [step.id, step]));
    let position = 1;
    for (const id of order) {
      const step = byId.get(id);
      if (!step || step.suffix) continue;
      if (step.position !== position) {
        for (const member of groupOf(steps, step)) {
          await store.updateStep(member.id, { position });
        }
      }
      position++;
    }
  }

  async function createRunbook(caller: AgentCaller, input: unknown) {
    const raw = objectBody(input);
    const title = parseTitle(raw.title);
    const summary = parseSummary(raw.summary);
    const values = parseValues(raw.values);
    const runbookOwner = parseOwner(raw.owner);
    const notify = parseNotify(raw.notify);
    const steps = parseSteps(raw.steps);
    checkStepCount(steps.length);
    await checkHosts(caller, steps);
    checkSecretReads(
      steps.map((step, index) => ({ ...step, position: index + 1 })),
    );
    const hiddenValues = hiddenValueNames(steps);
    // Before anything is stored (BUG-011, BUG-013).
    checkStored(
      steps.map((step, index) => ({
        ...step,
        position: index + 1,
        suffix: null,
      })),
      [],
      hiddenValues,
    );
    const id = await store.createRunbook({
      title,
      summary,
      values,
      createdBy: caller.token.name,
      createdByUserId: owner(caller),
      owner: runbookOwner,
      notify,
    });
    const made: Numbered[] = [];
    for (const [index, step] of steps.entries()) {
      const own = { position: index + 1, suffix: null };
      const stored = toStored(
        step,
        own,
        made,
        `steps[${index}]: `,
        hiddenValues,
      );
      made.push({
        ...own,
        id: await store.insertStep(id, index + 1, stored),
        ...known(step),
      });
    }
    await store.persist();
    return getRunbook(caller, id);
  }

  async function updateRunbook(
    caller: AgentCaller,
    runbookId: number,
    input: unknown,
  ) {
    await ownRunbook(caller, runbookId);
    const raw = objectBody(input, [
      "title",
      "summary",
      "values",
      "status",
      "owner",
      "notify",
    ]);
    const patch = {
      title: raw.title === undefined ? undefined : parseTitle(raw.title),
      summary:
        raw.summary === undefined ? undefined : parseSummary(raw.summary),
      values: raw.values === undefined ? undefined : parseValues(raw.values),
      status: raw.status === undefined ? undefined : parseStatus(raw.status),
      owner: raw.owner === undefined ? undefined : parseOwner(raw.owner),
      notify: raw.notify === undefined ? undefined : parseNotify(raw.notify),
    };
    const before = await ownRunbook(caller, runbookId);
    await events.changeRunbook(
      runbookId,
      before.status,
      patch,
      caller.token.name,
    );
    return getRunbook(caller, runbookId);
  }

  async function addSteps(
    caller: AgentCaller,
    runbookId: number,
    input: unknown,
  ) {
    const runbook = await ownRunbook(caller, runbookId);
    requireOpen(runbook);
    const raw = objectBody(input);
    const steps = parseSteps(raw.steps);
    if (steps.length === 0) throw new InputError("steps must not be empty");
    const existing = await store.listSteps(runbookId);
    checkStepCount(existing.length + steps.length);
    // Positions count steps, not amendments: those move with their step.
    const top = existing.filter((s) => !s.suffix);
    let insertAt = top.length;
    if (raw.position !== undefined && raw.position !== null) {
      const wanted = raw.position;
      if (
        !Number.isInteger(wanted) ||
        (wanted as number) < 1 ||
        (wanted as number) > top.length + 1
      ) {
        throw new InputError(
          `position must be an integer from 1 to ${top.length + 1}`,
        );
      }
      insertAt = (wanted as number) - 1;
    }
    const after = top
      .slice(insertAt)
      .flatMap((head) => groupOf(existing, head));
    const afterIds = new Set(after.map((s) => s.id));
    const before = existing.filter((s) => !afterIds.has(s.id));
    const withRuns = await store.stepsWithRuns(after.map((s) => s.id));
    const moved = after.filter((s) => withRuns.has(s.id));
    if (moved.length > 0) {
      throw new InputError(
        `cannot insert before step ${stepLabel(moved[0])}: it already ran; add the steps after it`,
        409,
      );
    }
    await checkHosts(caller, steps);
    // Numbers in stdin are those after the insert, as the answer shows.
    const shift = steps.length;
    const added = steps.map((step, index) => ({
      ...step,
      position: insertAt + index + 1,
      suffix: null,
    }));
    checkSecretReads([
      ...before,
      ...added,
      ...after.map((s) => ({ ...s, position: s.position + shift })),
    ]);
    const hiddenValues = hiddenValueNames([...existing, ...added]);
    // Before anything is stored (BUG-011, BUG-013).
    checkStored(added, before, hiddenValues);
    const made: Numbered[] = [];
    for (const [index, step] of added.entries()) {
      const stored = toStored(
        step,
        step,
        [...before, ...made],
        `steps[${index}]: `,
        hiddenValues,
      );
      made.push({
        id: await store.insertStep(runbookId, 0, stored),
        position: step.position,
        suffix: null,
        ...known(step),
      });
    }
    const order = [
      ...top.slice(0, insertAt).map((s) => s.id),
      ...made.map((s) => s.id),
      ...top.slice(insertAt).map((s) => s.id),
    ];
    await renumber(runbookId, order);
    await store.touchRunbook(runbookId);
    await store.persist();
    return getRunbook(caller, runbookId);
  }

  async function updateStep(
    caller: AgentCaller,
    stepId: number,
    input: unknown,
  ) {
    const { step, runbook } = await ownStep(caller, stepId);
    requireOpen(runbook);
    if ((await store.stepsWithRuns([stepId])).size > 0) {
      throw new InputError(
        "this step already ran, so it cannot change; amend it instead (amend_step)",
        409,
      );
    }
    if (step.status === "replaced") {
      throw new InputError(
        `step ${stepLabel(step)} was replaced, so it cannot change; amend its replacement instead`,
        409,
        { code: "replaced" },
      );
    }
    const patch = parseStepInput(input, { partial: true });
    if (Object.keys(patch).length === 0) {
      throw new InputError("nothing to change");
    }
    if (
      patch.hideOutputFromAgents === false &&
      step.hideOutputFromAgents === true
    ) {
      throw new InputError(
        "only the owner can show a hidden step's output to agents",
        403,
      );
    }
    checkStepShape({
      hostId: patch.hostId !== undefined ? patch.hostId : step.hostId,
      command: patch.command !== undefined ? patch.command : step.command,
      captures: patch.captures ?? step.captures,
      checks: patch.checks ?? step.checks,
      waitAfterPreviousSeconds:
        patch.waitAfterPreviousSeconds !== undefined
          ? patch.waitAfterPreviousSeconds
          : step.waitAfterPreviousSeconds,
      waitReason:
        patch.waitReason !== undefined ? patch.waitReason : step.waitReason,
      stdin: patch.stdin !== undefined ? patch.stdin : step.stdin,
      secretCaptures: patch.secretCaptures ?? step.secretCaptures,
      owner: patch.owner ?? step.owner,
      where: patch.where !== undefined ? patch.where : step.where,
      generate: patch.generate !== undefined ? patch.generate : step.generate,
      ask: patch.ask !== undefined ? patch.ask : step.ask,
      runIn: patch.runIn ?? step.runIn,
      runInReason:
        patch.runInReason !== undefined ? patch.runInReason : step.runInReason,
      decision: patch.decision !== undefined ? patch.decision : step.decision,
      interactive: patch.interactive ?? step.interactive,
      hideOutputFromAgents:
        patch.hideOutputFromAgents ?? step.hideOutputFromAgents,
    });
    await checkHosts(caller, [patch]);
    checkSecretReads(
      (await store.listSteps(runbook.id)).map((other) =>
        other.id === stepId
          ? {
              ...other,
              stdin: patch.stdin !== undefined ? patch.stdin : other.stdin,
              secretCaptures: patch.secretCaptures ?? other.secretCaptures,
              generate:
                patch.generate !== undefined ? patch.generate : other.generate,
              ask: patch.ask !== undefined ? patch.ask : other.ask,
            }
          : other,
      ),
    );
    const { stdin, when, ...rest } = patch;
    const stored: Partial<NewStep> = { ...rest };
    // The steps as they will be: what the rules read of this step changes.
    const changed: StepRow = {
      ...step,
      captures: patch.captures ?? step.captures,
      decision: patch.decision !== undefined ? patch.decision : step.decision,
      hideOutputFromAgents:
        patch.hideOutputFromAgents ?? step.hideOutputFromAgents,
      interactive: patch.interactive ?? step.interactive,
    };
    const all = (await store.listSteps(runbook.id)).map((other) =>
      other.id === stepId ? changed : other,
    );
    if (patch.owner !== undefined || patch.checks !== undefined) {
      checkAgentChecks(
        {
          owner: patch.owner ?? step.owner,
          checks: patch.checks ?? step.checks,
        },
        hiddenValueNames(all),
        "",
      );
    }
    if (stdin !== undefined || when !== undefined) {
      const done = toStored(
        { ...(patch as AuthorStep), stdin: stdin ?? null, when: when ?? null },
        step,
        all,
        "",
        hiddenValueNames(all),
      );
      if (stdin !== undefined) stored.stdin = done.stdin;
      if (when !== undefined) stored.when = done.when;
    }
    // A rule that reads this step must still fit it (BUG-008).
    if (
      patch.captures !== undefined ||
      patch.decision !== undefined ||
      patch.interactive !== undefined
    ) {
      recheckReaders(
        all,
        step,
        changed,
        await store.stepsWithRuns(all.map((s) => s.id)),
      );
    }
    await store.updateStep(stepId, stored, { edit: true });
    await store.touchRunbook(runbook.id);
    await store.persist();
    return getRunbook(caller, runbook.id);
  }

  async function removeStep(caller: AgentCaller, stepId: number) {
    const { runbook } = await ownStep(caller, stepId);
    requireOpen(runbook);
    if ((await store.stepsWithRuns([stepId])).size > 0) {
      throw new InputError(
        "this step already ran, so it stays in the history",
        409,
      );
    }
    const steps = await store.listSteps(runbook.id);
    const step = steps.find((s) => s.id === stepId)!;
    const reader = steps.find(
      (s) => s.stdin?.from === "step" && s.stdin.stepId === stepId,
    );
    if (reader) {
      throw new InputError(
        `step ${stepLabel(reader)} reads this step's output; change or remove it first`,
        409,
      );
    }
    const ruled = ruleReader(steps, stepId);
    if (ruled) {
      throw new InputError(
        `step ${stepLabel(ruled)} has a when rule that reads this step; change or remove it first`,
        409,
        { code: "when" },
      );
    }
    const amendments = steps.filter((s) => s.amendsStepId === stepId);
    if (amendments.length > 0) {
      throw new InputError(
        `step ${stepLabel(amendments[0])} amends this step; remove it first`,
        409,
        { code: "amended" },
      );
    }
    if (step.amendKind === "replace") {
      // The step it replaced is history now: its replacement stays.
      throw new InputError(
        "this step replaces another one; change it with update_step, or amend it",
        409,
        { code: "replacement" },
      );
    }
    // A sub-step leaves a gap in the letters: nothing after it moves.
    const moving = step.suffix
      ? []
      : steps.filter((s) => s.position > step.position);
    const withRuns = await store.stepsWithRuns(moving.map((s) => s.id));
    if (withRuns.size > 0) {
      throw new InputError(
        "a later step already ran, so the steps before it cannot move",
        409,
      );
    }
    checkSecretReads(
      steps
        .filter((s) => s.id !== stepId)
        .map((s) =>
          !step.suffix && s.position > step.position
            ? { ...s, position: s.position - 1 }
            : s,
        ),
      409,
    );
    await store.deleteStep(stepId);
    await renumber(
      runbook.id,
      steps.filter((s) => s.id !== stepId && !s.suffix).map((s) => s.id),
    );
    await store.touchRunbook(runbook.id);
    await store.persist();
    return getRunbook(caller, runbook.id);
  }

  async function reorderSteps(
    caller: AgentCaller,
    runbookId: number,
    input: unknown,
  ) {
    const runbook = await ownRunbook(caller, runbookId);
    requireOpen(runbook);
    const stepIds = objectBody(input).stepIds;
    const steps = await store.listSteps(runbookId);
    // Amendments are not listed: they move with the step they amend.
    const top = steps.filter((step) => !step.suffix);
    if (
      !Array.isArray(stepIds) ||
      stepIds.length !== top.length ||
      new Set(stepIds).size !== top.length ||
      !top.every((step) => stepIds.includes(step.id))
    ) {
      throw new InputError(
        `stepIds must list every step of the runbook exactly once${
          top.length < steps.length
            ? "; leave out amendments (such as 3a): they move with their step"
            : ""
        }`,
      );
    }
    const headOf = new Map<number, number>();
    for (const head of top) {
      for (const member of groupOf(steps, head)) headOf.set(member.id, head.id);
    }
    const newPositionOf = (id: number) =>
      (stepIds as number[]).indexOf(headOf.get(id) ?? id) + 1;
    const renumbered = new Map(
      steps.map((s) => [s.id, { ...s, position: newPositionOf(s.id) }]),
    );
    for (const step of steps) {
      if (
        step.stdin?.from === "step" &&
        renumbered.has(step.stdin.stepId) &&
        !isBefore(renumbered.get(step.stdin.stepId)!, renumbered.get(step.id)!)
      ) {
        throw new InputError(
          `step ${step.id} reads the output of step ${step.stdin.stepId}, which must stay before it`,
        );
      }
      for (const named of ruleStepIds(step.when)) {
        if (
          renumbered.has(named) &&
          !isBefore(renumbered.get(named)!, renumbered.get(step.id)!)
        ) {
          throw new InputError(
            `step ${step.id} has a when rule that reads step ${named}, which must stay before it`,
          );
        }
      }
    }
    const withRuns = await store.stepsWithRuns(steps.map((s) => s.id));
    for (const step of steps) {
      const newPosition = newPositionOf(step.id);
      if (withRuns.has(step.id) && newPosition !== step.position) {
        throw new InputError(
          `step ${step.id} already ran, so it keeps position ${step.position}`,
          409,
        );
      }
    }
    checkSecretReads([...renumbered.values()]);
    await renumber(runbookId, stepIds as number[]);
    await store.touchRunbook(runbookId);
    await store.persist();
    return getRunbook(caller, runbookId);
  }

  return {
    createRunbook,
    updateRunbook,
    addSteps,
    updateStep,
    removeStep,
    reorderSteps,
  };
}
