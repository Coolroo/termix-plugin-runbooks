/** What an agent reads: its runbooks, one runbook, its values and events. */

import type { Store } from "../../runbooks/store/store.js";
import { loadBundle, openPath, runbookSummary } from "../../runbooks/view.js";
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
    for (const runbook of rows) {
      out.push({
        ...runbookSummary(runbook, await store.listSteps(runbook.id)),
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

  return { getRunbook, listEvents, listRunbooks, getValues };
}
