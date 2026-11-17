/**
 * Runbook events (1.4.0): what happened to a runbook that its agent may want
 * to hear about. The server records them on state changes; agents read them
 * through the agent API and MCP, and the notifier delivers the ones a
 * runbook's `notify` lists (and every "sent") to the admin's webhook.
 *
 * An event holds ids and labels only. The one text it may hold is the
 * person's note on a "sent" event, which agents read through the API and the
 * webhook never carries.
 */

import type { EventRow, RunbookRow, StepRow } from "../runbooks/store/types.js";
import { now, type Store } from "../runbooks/store/store.js";
import { InputError } from "../core/errors.js";
import { loadBundle, nextStep, openPath } from "../runbooks/view.js";
import { anyCutOff, notNeededIds } from "../conditions/conditions.js";
import { isAgentStep, stepLabel, type StepNumber } from "../../shared/steps.js";

const EVENT_TYPES = [
  "agent-turn",
  "step-failed",
  "runbook-done",
  "sent",
  "step-done",
  // 1.4.0: an agent amended a step; reason replace or substep.
  "amended",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** What a runbook delivers when the agent did not say. */
const DEFAULT_NOTIFY: EventType[] = [
  "agent-turn",
  "step-failed",
  "runbook-done",
  "sent",
];

export type FailReason =
  "exit" | "check" | "stopped" | "interrupted" | "secret" | "manual";

/** Events of one runbook in an agent's read of it. */
export const RUNBOOK_EVENTS = 100;
export const EVENTS_PAGE = 100;
export const EVENTS_PAGE_MAX = 500;

/** Who caused an event that nobody did, such as a restart. */
export const SYSTEM = "termix";

/** An event type list as an agent writes it; null keeps the default. */
export function parseNotify(value: unknown): EventType[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new InputError(
      `notify must be a list of event types: ${EVENT_TYPES.join(", ")}`,
    );
  }
  const out: EventType[] = [];
  for (const entry of value) {
    if (!EVENT_TYPES.includes(entry as EventType)) {
      throw new InputError(
        `notify: "${String(entry)}" is not an event type; use ${EVENT_TYPES.join(", ")}`,
      );
    }
    if (!out.includes(entry as EventType)) out.push(entry as EventType);
  }
  return out;
}

export function effectiveNotify(runbook: RunbookRow): EventType[] {
  return (runbook.notify as EventType[] | null) ?? DEFAULT_NOTIFY;
}

/** Whether the webhook gets this event: "sent" always goes. */
export function wanted(runbook: RunbookRow, type: EventType): boolean {
  return type === "sent" || effectiveNotify(runbook).includes(type);
}

/**
 * The step whose turn it is, if it is an agent's: the first pending step of
 * an open runbook that is needed (1.4.6), when its owner is the agent.
 * Every step before it ended, or is not needed. Undefined when the time
 * limit cut a rule, so the steps not needed are not known yet (BUG-010).
 */
async function agentTurn(
  store: Store,
  runbook: RunbookRow,
): Promise<StepRow | null | undefined> {
  if (runbook.status !== "open") return null;
  const steps = await store.listSteps(runbook.id);
  let notNeeded = new Set<number>();
  if (steps.some((step) => step.when)) {
    const bundle = await loadBundle(store, runbook.id);
    if (!bundle) return null;
    if (anyCutOff(bundle.conditions)) return undefined;
    notNeeded = notNeededIds(bundle.conditions);
  }
  const next = nextStep(steps, notNeeded);
  return next && isAgentStep(next) ? next : null;
}

/** An event as agents read it. */
export function agentEvent(
  event: EventRow,
  positions: Map<number, StepNumber>,
) {
  const step = event.stepId === null ? null : positions.get(event.stepId);
  return {
    id: event.id,
    type: event.type,
    reason: event.reason,
    runbookId: event.runbookId,
    stepId: event.stepId,
    stepPosition: step?.position ?? null,
    // "3a" for an amendment (1.4.0), "3" otherwise.
    stepLabel: step ? stepLabel(step) : null,
    note: event.note,
    createdBy: event.createdBy,
    createdAt: event.createdAt,
    deliveredAt: event.deliveredAt,
    openPath: openPath(event.runbookId),
  };
}

/** What the events module needs from the notifier, if there is one. */
export interface Delivery {
  /** Whether new events should be queued for the webhook now. */
  enabled: () => Promise<boolean>;
  /** Try what is due now, without waiting. */
  kick: () => void;
}

export type Events = ReturnType<typeof createEvents>;

export function createEvents(store: Store) {
  let delivery: Delivery | null = null;

  /** The agent step whose turn it is; undefined when not known yet. */
  async function turn(runbookId: number): Promise<number | null | undefined> {
    const runbook = await store.getRunbook(runbookId);
    if (!runbook) return null;
    const step = await agentTurn(store, runbook);
    return step === undefined ? undefined : (step?.id ?? null);
  }

  /** Writes one event; queues it for the webhook when wanted and on. */
  async function record(input: {
    runbook: RunbookRow;
    stepId: number | null;
    type: EventType;
    reason?: string | null;
    note?: string | null;
    by: string;
  }): Promise<number> {
    const queue =
      wanted(input.runbook, input.type) &&
      delivery !== null &&
      (await delivery.enabled().catch(() => false));
    const id = await store.insertEvent({
      runbookId: input.runbook.id,
      stepId: input.stepId,
      ownerUserId: input.runbook.createdByUserId,
      type: input.type,
      reason: input.reason ?? null,
      note: input.note ?? null,
      createdBy: input.by,
      nextAttemptAt: queue ? now() : null,
    });
    if (queue) delivery?.kick();
    return id;
  }

  /**
   * Runs a change to a runbook's steps or status, then records
   * "agent-turn" when the change made an agent step the next one. When the
   * time limit cut a rule before or after, the turn is not known, and no
   * agent-turn is sent (BUG-010): a wrong one would call the agent to a
   * step that may not be needed.
   */
  async function around<T>(
    runbookId: number,
    by: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const before = await turn(runbookId);
    const result = await fn();
    const runbook = await store.getRunbook(runbookId);
    if (runbook && before !== undefined) {
      const after = await agentTurn(store, runbook);
      if (after && after.id !== before) {
        await record({ runbook, stepId: after.id, type: "agent-turn", by });
        await store.persist();
      }
    }
    return result;
  }

  /** A step ended done or failed: step-failed, or step-done if wanted. */
  async function stepEnded(
    step: StepRow,
    status: "done" | "failed",
    reason: FailReason | null,
    by: string,
    note: string | null = null,
  ): Promise<void> {
    const runbook = await store.getRunbook(step.runbookId);
    if (!runbook) return;
    if (status === "failed") {
      await record({
        runbook,
        stepId: step.id,
        type: "step-failed",
        reason: reason ?? "exit",
        by,
      });
    } else if (effectiveNotify(runbook).includes("step-done")) {
      await record({ runbook, stepId: step.id, type: "step-done", by, note });
    }
  }

  /** A runbook's status changed: runbook-done when it closed. */
  async function statusChanged(
    runbook: RunbookRow,
    from: RunbookRow["status"],
    by: string,
  ): Promise<void> {
    if (runbook.status === from || runbook.status === "open") return;
    await record({
      runbook,
      stepId: null,
      type: "runbook-done",
      reason: runbook.status,
      by,
    });
  }

  return {
    /** The notifier, once it exists. */
    setDelivery(next: Delivery | null): void {
      delivery = next;
    },

    turn,
    record,
    around,
    stepEnded,
    statusChanged,

    /**
     * Ends a step done or failed as one change (inside around): writes the
     * run first (`run`), sets the step's status and end time, records
     * step-failed or step-done, then touches the runbook with `touch` and
     * persists. `touch: false` leaves both to the caller. With
     * `keepReplaced`, a step replaced while its run was written keeps
     * "replaced" and only gets its end time.
     */
    async endStep(
      step: StepRow,
      end: {
        status: "done" | "failed";
        reason: FailReason | null;
        by: string;
        at: string;
        run?: () => Promise<unknown>;
        keepReplaced?: boolean;
        touch?: RunbookPatch | false;
        /** 1.4.6: what step-done carries, such as a decision's choice. */
        note?: string | null;
      },
    ): Promise<void> {
      await around(step.runbookId, end.by, async () => {
        await end.run?.();
        const replaced =
          end.keepReplaced &&
          (await store.getStep(step.id))?.status === "replaced";
        await store.updateStep(
          step.id,
          replaced
            ? { endedAt: end.at }
            : { status: end.status, skipReason: null, endedAt: end.at },
        );
        await stepEnded(step, end.status, end.reason, end.by, end.note ?? null);
        if (end.touch !== false) {
          await store.touchRunbook(step.runbookId, end.touch);
          await store.persist();
        }
      });
    },

    /**
     * Changes a runbook's fields (its status among them) as one change:
     * runbook-done when it closed, agent-turn when one comes up.
     */
    async changeRunbook(
      runbookId: number,
      from: RunbookRow["status"],
      patch: RunbookPatch,
      by: string,
    ): Promise<void> {
      await around(runbookId, by, async () => {
        await store.touchRunbook(runbookId, patch);
        const after = (await store.getRunbook(runbookId))!;
        await statusChanged(after, from, by);
        await store.persist();
      });
    },
  };
}

/** What a change may set on a runbook (Store.touchRunbook). */
type RunbookPatch = Parameters<Store["touchRunbook"]>[1];
