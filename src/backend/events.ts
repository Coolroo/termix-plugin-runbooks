/**
 * Runbook events (1.3.0): what happened to a runbook that its agent may want
 * to hear about. The server records them on state changes; agents read them
 * through the agent API and MCP, and the notifier delivers the ones a
 * runbook's `notify` lists (and every "sent") to the admin's webhook.
 *
 * An event holds ids and labels only. The one text it may hold is the
 * person's note on a "sent" event, which agents read through the API and the
 * webhook never carries.
 */

import type { EventRow, RunbookRow, StepRow, Store } from "./store.js";
import { now } from "./store.js";
import { InputError, openPath } from "./service.js";

export const EVENT_TYPES = [
  "agent-turn",
  "step-failed",
  "runbook-done",
  "sent",
  "step-done",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** What a runbook delivers when the agent did not say. */
export const DEFAULT_NOTIFY: EventType[] = [
  "agent-turn",
  "step-failed",
  "runbook-done",
  "sent",
];

export type FailReason =
  "exit" | "check" | "stopped" | "interrupted" | "secret" | "manual";

/** The note a person may send with a step, in characters. */
export const MAX_SENT_NOTE = 500;
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
 * an open runbook, when its owner is the agent. Every step before it ended.
 */
export function agentTurn(
  runbook: RunbookRow,
  steps: StepRow[],
): StepRow | null {
  if (runbook.status !== "open") return null;
  const next = steps.find((step) => step.status === "pending");
  return next && next.owner === "agent" ? next : null;
}

/** An event as agents read it. */
export function agentEvent(event: EventRow, positions: Map<number, number>) {
  return {
    id: event.id,
    type: event.type,
    reason: event.reason,
    runbookId: event.runbookId,
    stepId: event.stepId,
    stepPosition:
      event.stepId === null ? null : (positions.get(event.stepId) ?? null),
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

  async function turn(runbookId: number): Promise<number | null> {
    const runbook = await store.getRunbook(runbookId);
    if (!runbook) return null;
    return agentTurn(runbook, await store.listSteps(runbookId))?.id ?? null;
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

  return {
    /** The notifier, once it exists. */
    setDelivery(next: Delivery | null): void {
      delivery = next;
    },

    turn,
    record,

    /**
     * Runs a change to a runbook's steps or status, then records
     * "agent-turn" when the change made an agent step the next one.
     */
    async around<T>(
      runbookId: number,
      by: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const before = await turn(runbookId);
      const result = await fn();
      const runbook = await store.getRunbook(runbookId);
      if (runbook) {
        const after = agentTurn(runbook, await store.listSteps(runbookId));
        if (after && after.id !== before) {
          await record({ runbook, stepId: after.id, type: "agent-turn", by });
          await store.persist();
        }
      }
      return result;
    },

    /** A step ended done or failed: step-failed, or step-done if wanted. */
    async stepEnded(
      step: StepRow,
      status: "done" | "failed",
      reason: FailReason | null,
      by: string,
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
        await record({ runbook, stepId: step.id, type: "step-done", by });
      }
    },

    /** A runbook's status changed: runbook-done when it closed. */
    async statusChanged(
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
    },
  };
}
