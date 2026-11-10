/**
 * Everything an agent may do, shared by the REST routes and the MCP tools.
 *
 * An agent proposes: it writes runbooks and steps and reads what happened. It
 * never runs a step, never skips or reopens one and never writes the owner's
 * notes; those routes do not exist on this side at all. The one step it may
 * end is its own: a step with owner "agent", once it is its turn (1.4.0).
 */

import type {
  AmendKind,
  NewStep,
  RunbookRow,
  StepRow,
  Store,
  TokenHost,
  TokenRow,
} from "./store.js";
import {
  agentValues,
  agentView,
  amendmentView,
  checkStepShape,
  completeStep,
  InputError,
  LIMITS,
  loadBundle,
  openPath,
  parseOwner,
  parseStatus,
  parseStepInput,
  parseSummary,
  type AuthorStep,
  parseTitle,
  secretReadsProblem,
  parseValues,
  runbookSummary,
} from "./service.js";
import type { LiveRuns } from "./live.js";
import { StdinPositionError, storeStdin } from "./stdin.js";
import { checkHidden } from "./checks.js";
import { findSecrets } from "./values.js";
import { now } from "./store.js";
import {
  isBefore,
  stepLabel,
  suffixAt,
  suffixIndex,
  type StepNumber,
} from "../shared/steps.js";
import {
  agentEvent,
  createEvents,
  effectiveNotify,
  EVENTS_PAGE,
  EVENTS_PAGE_MAX,
  parseNotify,
  RUNBOOK_EVENTS,
  type Events,
} from "./events.js";

export interface AgentCaller {
  token: TokenRow;
}

export type AgentHost = TokenHost;

export type AgentOps = ReturnType<typeof createAgentOps>;

/** An audit line an agent's action writes, without a request. */
export type AgentAudit = (line: {
  action: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  details: string;
  success: boolean;
}) => Promise<void>;

export function createAgentOps(
  store: Store,
  live?: LiveRuns,
  options: { audit?: AgentAudit; events?: Events } = {},
) {
  const owner = (caller: AgentCaller) => caller.token.createdBy;
  const events = options.events ?? createEvents(store);

  /**
   * The hosts this token may name in steps: the list a person chose when they
   * made or last edited the token, without the hosts found not to take SSH.
   * Nothing secret is in it.
   */
  async function listHosts(caller: AgentCaller): Promise<AgentHost[]> {
    return caller.token.hosts
      .filter((host) => host.ssh !== false)
      .map(({ id, name, address, folder }) => ({
        id,
        name,
        address,
        folder,
      }));
  }

  async function hostNamer(caller: AgentCaller) {
    const names = new Map<number, string>();
    for (const host of caller.token.hosts) {
      names.set(host.id, host.name || host.address);
    }
    return (hostId: number) => names.get(hostId) ?? null;
  }

  async function checkHosts(
    caller: AgentCaller,
    stepList: Array<{ hostId?: number | null }>,
  ): Promise<void> {
    const wanted = [
      ...new Set(
        stepList
          .map((step) => step.hostId)
          .filter((id): id is number => typeof id === "number"),
      ),
    ];
    if (wanted.length === 0) return;
    const known = new Set((await listHosts(caller)).map((host) => host.id));
    const notSsh = new Set(
      caller.token.hosts
        .filter((host) => host.ssh === false)
        .map((host) => host.id),
    );
    for (const hostId of wanted) {
      if (notSsh.has(hostId)) {
        throw new InputError(
          `host ${hostId} is not an SSH host; Runbooks runs commands over SSH only`,
        );
      }
      if (!known.has(hostId)) {
        throw new InputError(
          `host ${hostId} is not a host this token may use; call list_hosts`,
        );
      }
    }
  }

  async function ownRunbook(
    caller: AgentCaller,
    runbookId: number,
  ): Promise<RunbookRow> {
    const runbook = await store.getRunbook(runbookId);
    if (!runbook || runbook.createdByUserId !== owner(caller)) {
      throw new InputError("runbook not found", 404);
    }
    return runbook;
  }

  async function ownStep(
    caller: AgentCaller,
    stepId: number,
  ): Promise<{ step: StepRow; runbook: RunbookRow }> {
    const step = await store.getStep(stepId);
    if (!step) throw new InputError("step not found", 404);
    const runbook = await store.getRunbook(step.runbookId);
    if (!runbook || runbook.createdByUserId !== owner(caller)) {
      throw new InputError("step not found", 404);
    }
    return { step, runbook };
  }

  function requireOpen(runbook: RunbookRow): void {
    if (runbook.status !== "open") {
      throw new InputError(
        `runbook is ${runbook.status}; set status to open before changing steps`,
        409,
      );
    }
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
   * The step as stored: a stdin step source by id, for a step numbered
   * `own` among `known`, the steps before it with their numbers then.
   */
  function toStored(
    step: AuthorStep,
    own: StepNumber,
    known: Numbered[],
    label: string,
  ): NewStep {
    const idOf = (ref: { position: number; suffix: string | null }) =>
      known.find(
        (other) =>
          other.position === ref.position &&
          (other.suffix ?? null) === ref.suffix,
      )?.id ?? null;
    try {
      return { ...step, stdin: storeStdin(step.stdin, own, idOf) };
    } catch (error) {
      if (error instanceof StdinPositionError) {
        throw new InputError(`${label}${error.message}`);
      }
      throw error;
    }
  }

  /** A secret read by name needs an earlier step that captures it. */
  function checkSecretReads(
    steps: Parameters<typeof secretReadsProblem>[0],
    status = 400,
  ): void {
    const problem = secretReadsProblem(steps);
    if (problem) throw new InputError(problem, status);
  }

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

  async function getRunbook(caller: AgentCaller, runbookId: number) {
    await ownRunbook(caller, runbookId);
    const bundle = (await loadBundle(store, runbookId, live))!;
    const positions = new Map(bundle.steps.map((s) => [s.id, s]));
    const recent = await store.listEvents({
      runbookId,
      limit: RUNBOOK_EVENTS,
      order: "newest",
    });
    return {
      ...agentView(bundle, await hostNamer(caller)),
      notify: effectiveNotify(bundle.runbook),
      events: recent.map((event) => {
        const {
          openPath: _path,
          runbookId: _id,
          ...rest
        } = agentEvent(event, positions);
        return rest;
      }),
    };
  }

  /**
   * Events of every runbook this token sees, oldest first after `since`:
   * for an agent that polls, and for a receiver that missed a webhook.
   */
  async function listEvents(
    caller: AgentCaller,
    query: { since?: unknown; limit?: unknown } = {},
  ) {
    const number = (value: unknown, name: string, fallback: number) => {
      if (value === undefined || value === null || value === "") {
        return fallback;
      }
      const parsed = typeof value === "string" ? Number(value) : value;
      if (!Number.isInteger(parsed) || (parsed as number) < 0) {
        throw new InputError(`${name} must be a whole number`);
      }
      return parsed as number;
    };
    const since = number(query.since, "since", 0);
    const limit = Math.min(
      Math.max(number(query.limit, "limit", EVENTS_PAGE), 1),
      EVENTS_PAGE_MAX,
    );
    const rows = await store.listEvents({
      ownerUserId: owner(caller),
      afterId: since,
      limit,
      order: "oldest",
    });
    const positions = new Map<number, StepNumber>();
    for (const runbookId of new Set(rows.map((row) => row.runbookId))) {
      for (const step of await store.listSteps(runbookId)) {
        positions.set(step.id, step);
      }
    }
    return {
      events: rows.map((row) => agentEvent(row, positions)),
      next: rows.length ? rows[rows.length - 1].id : since,
    };
  }

  async function listRunbooks(
    caller: AgentCaller,
    filter: { status?: unknown } = {},
  ) {
    const status =
      filter.status === undefined || filter.status === ""
        ? undefined
        : parseStatus(filter.status);
    const rows = await store.listRunbooks({
      ownerUserId: owner(caller),
      status,
    });
    const out: Array<ReturnType<typeof runbookSummary> & { openPath: string }> =
      [];
    for (const runbook of rows) {
      out.push({
        ...runbookSummary(runbook, await store.listSteps(runbook.id)),
        openPath: openPath(runbook.id),
      });
    }
    return out;
  }

  async function createRunbook(caller: AgentCaller, input: unknown) {
    if (!input || typeof input !== "object") {
      throw new InputError("body must be an object");
    }
    const raw = input as Record<string, unknown>;
    const title = parseTitle(raw.title);
    const summary = parseSummary(raw.summary);
    const values = parseValues(raw.values);
    const runbookOwner = parseOwner(raw.owner);
    const notify = parseNotify(raw.notify);
    const steps = parseSteps(raw.steps);
    if (steps.length > LIMITS.stepsPerRunbook) {
      throw new InputError(
        `a runbook may have at most ${LIMITS.stepsPerRunbook} steps`,
      );
    }
    await checkHosts(caller, steps);
    checkSecretReads(
      steps.map((step, index) => ({ ...step, position: index + 1 })),
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
      const stored = toStored(step, own, made, `steps[${index}]: `);
      made.push({ ...own, id: await store.insertStep(id, index + 1, stored) });
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
    if (!input || typeof input !== "object") {
      throw new InputError("body must be an object");
    }
    const raw = input as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (
        !["title", "summary", "values", "status", "owner", "notify"].includes(
          key,
        )
      ) {
        throw new InputError(`unknown field "${key}"`);
      }
    }
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
    await events.around(runbookId, caller.token.name, async () => {
      await store.touchRunbook(runbookId, patch);
      const after = (await store.getRunbook(runbookId))!;
      await events.statusChanged(after, before.status, caller.token.name);
      await store.persist();
    });
    return getRunbook(caller, runbookId);
  }

  async function addSteps(
    caller: AgentCaller,
    runbookId: number,
    input: unknown,
  ) {
    const runbook = await ownRunbook(caller, runbookId);
    requireOpen(runbook);
    const raw = (input ?? {}) as Record<string, unknown>;
    const steps = parseSteps(raw.steps);
    if (steps.length === 0) throw new InputError("steps must not be empty");
    const existing = await store.listSteps(runbookId);
    if (existing.length + steps.length > LIMITS.stepsPerRunbook) {
      throw new InputError(
        `a runbook may have at most ${LIMITS.stepsPerRunbook} steps`,
      );
    }
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
    const made: Numbered[] = [];
    for (const [index, step] of added.entries()) {
      const stored = toStored(
        step,
        step,
        [...before, ...made],
        `steps[${index}]: `,
      );
      made.push({
        id: await store.insertStep(runbookId, 0, stored),
        position: step.position,
        suffix: null,
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
    });
    await checkHosts(caller, [patch]);
    checkSecretReads(
      (await store.listSteps(runbook.id)).map((other) =>
        other.id === stepId
          ? {
              ...other,
              stdin: patch.stdin !== undefined ? patch.stdin : other.stdin,
              secretCaptures: patch.secretCaptures ?? other.secretCaptures,
            }
          : other,
      ),
    );
    const { stdin, ...rest } = patch;
    const stored: Partial<NewStep> = { ...rest };
    if (stdin !== undefined) {
      const all = await store.listSteps(runbook.id);
      stored.stdin = toStored(
        { ...(patch as AuthorStep), stdin },
        step,
        all,
        "",
      ).stdin;
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
    const stepIds = (input as { stepIds?: unknown } | null)?.stepIds;
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
    if (step.owner !== "agent") {
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
    // A replaced step counts as ended: its status is not pending.
    const blocking = steps.filter(
      (other) => isBefore(other, step) && other.status === "pending",
    );
    if (blocking.length > 0) {
      throw new InputError(
        `step ${stepLabel(blocking[0])} (${blocking[0].title}) is still pending; it is not your turn yet`,
        409,
        {
          code: "order",
          blocking: blocking.map((other) => ({
            id: other.id,
            position: other.position,
            label: stepLabel(other),
            title: other.title,
          })),
        },
      );
    }
    const parsed = parseCompletion(input);
    // An agent step has no secrets to find today; the order is the same as
    // a person's run anyway: checks see the output with secrets hidden.
    const found = findSecrets(step.secretCaptures, parsed.output);
    const results =
      parsed.outcome === "done" && step.checks.length > 0
        ? checkHidden(
            step.checks,
            {
              mode: "terminal",
              exitCode: null,
              stdout: null,
              stderr: null,
              pastedOutput: parsed.output ?? "",
            },
            {},
            Object.entries(found.values).map(([name, value]) => ({
              name,
              value,
            })),
          )
        : null;
    const final =
      parsed.outcome === "done" && (results ?? []).every((check) => check.ok)
        ? "done"
        : "failed";
    const at = now();
    const by = caller.token.name;
    await events.around(runbook.id, by, async () => {
      await store.insertRun({
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
        exitCode: null,
        stdout: parsed.output,
        stderr: null,
        truncated: false,
        timedOut: false,
        pastedOutput: null,
        error: null,
        note: parsed.note,
        checks: results,
      });
      await store.updateStep(step.id, {
        status: final,
        skipReason: null,
        endedAt: at,
      });
      await events.stepEnded(
        step,
        final,
        final === "done"
          ? null
          : parsed.outcome === "failed"
            ? "manual"
            : "check",
        by,
      );
      await store.touchRunbook(runbook.id);
      await store.persist();
    });
    await options.audit?.({
      action: "runbooks_step_agent_complete",
      resourceType: "runbooks_step",
      resourceId: String(step.id),
      resourceName: step.title.slice(0, 200),
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
    if (steps.length + 1 > LIMITS.stepsPerRunbook) {
      throw new InputError(
        `a runbook may have at most ${LIMITS.stepsPerRunbook} steps`,
      );
    }
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
      resourceType: "runbooks_step",
      resourceId: String(newId),
      resourceName: fresh.title.slice(0, 200),
      details: `runbook ${runbook.id} step ${stepLabel(step)} ${
        parsed.kind === "replace" ? "replaced by" : "got sub-step"
      } ${stepLabel(own)} from agent token ${by}`,
      success: true,
    });
    return getRunbook(caller, runbook.id);
  }

  async function getValues(caller: AgentCaller, runbookId: number) {
    await ownRunbook(caller, runbookId);
    const bundle = (await loadBundle(store, runbookId, live))!;
    return { runbookId, values: agentValues(bundle) };
  }

  return {
    listHosts,
    listRunbooks,
    getRunbook,
    createRunbook,
    updateRunbook,
    addSteps,
    updateStep,
    removeStep,
    reorderSteps,
    getValues,
    completeAgentStep,
    amendStep,
    listEvents,
  };
}

/** A step and the step number it has, or will have. */
type Numbered = StepNumber & { id: number };

/** A step and its amendments: the steps that share its position. */
function groupOf(steps: StepRow[], head: StepRow): StepRow[] {
  return [
    head,
    ...steps.filter((s) => s.suffix && s.position === head.position),
  ];
}

/** { kind, reason, step } as an agent amends a step. */
function parseAmendment(input: unknown): {
  kind: AmendKind;
  reason: string;
  step: AuthorStep;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InputError("body must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["kind", "reason", "step"].includes(key)) {
      throw new InputError(`unknown field "${key}"`);
    }
  }
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
  if (/[\u0000-\u001f\u007f]/.test(reason)) {
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
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InputError("body must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["outcome", "note", "output"].includes(key)) {
      throw new InputError(`unknown field "${key}"`);
    }
  }
  if (raw.outcome !== "done" && raw.outcome !== "failed") {
    throw new InputError('outcome must be "done" or "failed"');
  }
  const note = raw.note ?? null;
  if (note !== null && typeof note !== "string") {
    throw new InputError("note must be a string");
  }
  if (typeof note === "string" && note.length > LIMITS.agentNote) {
    throw new InputError(`note is longer than ${LIMITS.agentNote} characters`);
  }
  const output = raw.output ?? null;
  if (output !== null && typeof output !== "string") {
    throw new InputError("output must be a string");
  }
  if (
    typeof output === "string" &&
    Buffer.byteLength(output) > LIMITS.agentOutputBytes
  ) {
    throw new InputError(
      `output is larger than ${LIMITS.agentOutputBytes / 1024} KB`,
    );
  }
  return {
    outcome: raw.outcome,
    note: note && note.trim() ? note : null,
    output,
  };
}
