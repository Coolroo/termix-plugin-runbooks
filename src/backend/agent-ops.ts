/**
 * Everything an agent may do, shared by the REST routes and the MCP tools.
 *
 * An agent proposes: it writes runbooks and steps and reads what happened. It
 * never runs a step, never marks one done or skipped and never writes the
 * owner's notes; those routes do not exist on this side at all.
 */

import type {
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
  checkStepShape,
  completeStep,
  InputError,
  LIMITS,
  loadBundle,
  openPath,
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

export interface AgentCaller {
  token: TokenRow;
}

export type AgentHost = TokenHost;

export type AgentOps = ReturnType<typeof createAgentOps>;

export function createAgentOps(store: Store, live?: LiveRuns) {
  const owner = (caller: AgentCaller) => caller.token.createdBy;

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
   * The step as stored: a stdin step source by id, for a step at
   * `position` in an order where `idAt` gives the step at each position.
   */
  function toStored(
    step: AuthorStep,
    position: number,
    idAt: (position: number) => number | null,
    label: string,
  ): NewStep {
    try {
      return { ...step, stdin: storeStdin(step.stdin, position, idAt) };
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

  async function renumber(runbookId: number, order: number[]): Promise<void> {
    const steps = await store.listSteps(runbookId);
    const byId = new Map(steps.map((step) => [step.id, step]));
    let position = 1;
    for (const id of order) {
      const step = byId.get(id);
      if (!step) continue;
      if (step.position !== position) {
        await store.updateStep(id, { position });
      }
      position++;
    }
  }

  async function getRunbook(caller: AgentCaller, runbookId: number) {
    await ownRunbook(caller, runbookId);
    const bundle = (await loadBundle(store, runbookId, live))!;
    return agentView(bundle, await hostNamer(caller));
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
    });
    const ids: number[] = [];
    for (const [index, step] of steps.entries()) {
      const stored = toStored(
        step,
        index + 1,
        (position) => ids[position - 1] ?? null,
        `steps[${index}]: `,
      );
      ids.push(await store.insertStep(id, index + 1, stored));
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
      if (!["title", "summary", "values", "status"].includes(key)) {
        throw new InputError(`unknown field "${key}"`);
      }
    }
    await store.touchRunbook(runbookId, {
      title: raw.title === undefined ? undefined : parseTitle(raw.title),
      summary:
        raw.summary === undefined ? undefined : parseSummary(raw.summary),
      values: raw.values === undefined ? undefined : parseValues(raw.values),
      status: raw.status === undefined ? undefined : parseStatus(raw.status),
    });
    await store.persist();
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
    let insertAt = existing.length;
    if (raw.position !== undefined && raw.position !== null) {
      const wanted = raw.position;
      if (
        !Number.isInteger(wanted) ||
        (wanted as number) < 1 ||
        (wanted as number) > existing.length + 1
      ) {
        throw new InputError(
          `position must be an integer from 1 to ${existing.length + 1}`,
        );
      }
      insertAt = (wanted as number) - 1;
    }
    const withRuns = await store.stepsWithRuns(existing.map((s) => s.id));
    const moved = existing.slice(insertAt).filter((s) => withRuns.has(s.id));
    if (moved.length > 0) {
      throw new InputError(
        `cannot insert before step ${moved[0].position}: it already ran; add the steps after it`,
        409,
      );
    }
    await checkHosts(caller, steps);
    checkSecretReads(
      [
        ...existing.slice(0, insertAt),
        ...steps,
        ...existing.slice(insertAt),
      ].map((step, index) => ({ ...step, position: index + 1 })),
    );
    // Positions in stdin are those after the insert, as the answer shows.
    const before = existing.slice(0, insertAt).map((s) => s.id);
    const newIds: number[] = [];
    for (const [index, step] of steps.entries()) {
      const known = [...before, ...newIds];
      const stored = toStored(
        step,
        insertAt + index + 1,
        (position) => known[position - 1] ?? null,
        `steps[${index}]: `,
      );
      newIds.push(await store.insertStep(runbookId, 0, stored));
    }
    const order = [
      ...before,
      ...newIds,
      ...existing.slice(insertAt).map((s) => s.id),
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
        "this step already ran, so it cannot change; add a new step instead",
        409,
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
        step.position,
        (position) => all.find((s) => s.position === position)?.id ?? null,
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
    const reader = steps.find(
      (s) => s.stdin?.from === "step" && s.stdin.stepId === stepId,
    );
    if (reader) {
      throw new InputError(
        `step ${reader.position} reads this step's output; change or remove it first`,
        409,
      );
    }
    const after = steps.filter(
      (s) => s.position > (steps.find((x) => x.id === stepId)?.position ?? 0),
    );
    const withRuns = await store.stepsWithRuns(after.map((s) => s.id));
    if (withRuns.size > 0) {
      throw new InputError(
        "a later step already ran, so the steps before it cannot move",
        409,
      );
    }
    checkSecretReads(
      steps
        .filter((s) => s.id !== stepId)
        .map((s, index) => ({ ...s, position: index + 1 })),
      409,
    );
    await store.deleteStep(stepId);
    await renumber(
      runbook.id,
      steps.filter((s) => s.id !== stepId).map((s) => s.id),
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
    if (
      !Array.isArray(stepIds) ||
      stepIds.length !== steps.length ||
      new Set(stepIds).size !== steps.length ||
      !steps.every((step) => stepIds.includes(step.id))
    ) {
      throw new InputError(
        "stepIds must list every step of the runbook exactly once",
      );
    }
    const newPositionOf = (id: number) => (stepIds as number[]).indexOf(id) + 1;
    for (const step of steps) {
      if (
        step.stdin?.from === "step" &&
        newPositionOf(step.stdin.stepId) >= newPositionOf(step.id)
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
    checkSecretReads(
      steps.map((s) => ({ ...s, position: newPositionOf(s.id) })),
    );
    await renumber(runbookId, stepIds as number[]);
    await store.touchRunbook(runbookId);
    await store.persist();
    return getRunbook(caller, runbookId);
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
  };
}
