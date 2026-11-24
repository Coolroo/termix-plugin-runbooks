/** What an agent reads: its runbooks, one runbook, its values and events. */

import type { Store } from "../../runbooks/store/store.js";
import {
  loadBundle,
  loadNotNeeded,
  openPath,
  runbookSummary,
} from "../../runbooks/view.js";
import { parseStatus } from "../../runbooks/parse.js";
import type { LiveRuns } from "../../running/live.js";
import { InputError } from "../../core/errors.js";
import type { RunbookSummary } from "../../../shared/api.js";
import type { StepNumber } from "../../../shared/steps.js";
import { agentValues, agentView } from "../agent-view.js";
import {
  agentEvent,
  effectiveNotify,
  EVENTS_PAGE,
  EVENTS_PAGE_MAX,
  RUNBOOK_EVENTS,
} from "../events.js";
import type { Access, AgentCaller } from "./access.js";
import { RULE_TIME_BUDGET_MS } from "../../conditions/conditions.js";
import { PatternBudget } from "../../values/values.js";

export type Reads = ReturnType<typeof createReads>;

export function createReads(
  store: Store,
  live: LiveRuns | undefined,
  { owner, ownRunbook, hostNamer }: Access,
) {
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
    const out: Array<RunbookSummary & { openPath: string }> = [];
    // One time limit for every runbook's rules (BUG-008).
    const budget = new PatternBudget(RULE_TIME_BUDGET_MS);
    for (const runbook of rows) {
      const steps = await store.listSteps(runbook.id);
      out.push({
        ...runbookSummary(
          runbook,
          steps,
          await loadNotNeeded(store, runbook.id, steps, budget),
        ),
        openPath: openPath(runbook.id),
      });
    }
    return out;
  }

  async function getValues(caller: AgentCaller, runbookId: number) {
    await ownRunbook(caller, runbookId);
    const bundle = (await loadBundle(store, runbookId, live))!;
    return { runbookId, values: agentValues(bundle) };
  }

  /**
   * One attempt of a wait or retried item, with its output (BUG-022 M2):
   * the runbook's view gives attempts without it. Masked exactly as the
   * runbook's view masks the attempt: it is taken from that same view.
   */
  async function getAttempt(
    caller: AgentCaller,
    runbookId: number,
    query: { runId?: unknown; item?: unknown; attempt?: unknown },
  ) {
    await ownRunbook(caller, runbookId);
    const number = (value: unknown, name: string) => {
      const parsed = typeof value === "string" ? Number(value) : value;
      if (!Number.isInteger(parsed) || (parsed as number) < 1) {
        throw new InputError(`${name} must be a whole number from 1`);
      }
      return parsed as number;
    };
    const runId = number(query.runId, "runId");
    const position = number(query.item, "item");
    const attempt = number(query.attempt, "attempt");
    const item = (await store.listRunItems({ runbookId, runId })).find(
      (each) => each.position === position,
    );
    const row = item
      ? (
          await store.listRunAttempts({ itemId: item.id }, { output: false })
        ).find((each) => each.attempt === attempt)
      : undefined;
    if (!row) throw new InputError("attempt not found", 404);
    const bundle = (await loadBundle(
      store,
      runbookId,
      live,
      undefined,
      row.id,
    ))!;
    const view = agentView(bundle, await hostNamer(caller));
    for (const step of view.steps) {
      const shown = step.runs
        .find((run) => run.id === runId)
        ?.items?.find((each) => each.position === position)
        ?.attempts?.find((each) => each.attempt === attempt);
      if (shown) return { runbookId, runId, item: position, ...shown };
    }
    throw new InputError("attempt not found", 404);
  }

  return { getRunbook, listEvents, listRunbooks, getValues, getAttempt };
}
