/**
 * Types of the page. What the server sends is defined once, in
 * src/shared/api.ts, and re-exported here; this file adds what only the
 * page has: terminal sessions and the body of a refused request.
 */

import type { ConflictBody } from "../shared/api";

export type {
  AskField,
  AuthorStore,
  ByHand,
  Check,
  CheckResult,
  ConflictBody,
  EffectiveValue,
  GenerateField,
  Progress,
  Run,
  RunRecord,
  Runbook,
  RunbookListEntry,
  RunbookOwner,
  RunbookStatus,
  RunbookSummary,
  RunStdin,
  SecretState,
  SecretStepView,
  SentToAgent,
  StdinSource,
  StdinView,
  Step,
  StepAmendment,
  StepName,
  StepStatus,
  StepWait,
  TokenInfo,
} from "../shared/api";

/** A session as the SSH Terminal plugin's terminal.listSessions lists it. */
export interface TerminalSession {
  /** The terminal tab's id. */
  id: string;
  hostId: number | string | null;
  /** The socket is open. */
  connected?: boolean;
  /** Shown on screen rather than behind another tab. */
  visible?: boolean;
}

/** The body of a refused request, from an axios-style error. */
export function errorBody(error: unknown): {
  status: number | null;
  data: Record<string, unknown>;
} {
  const response = (error as { response?: { status?: number; data?: unknown } })
    ?.response;
  const data =
    response?.data && typeof response.data === "object"
      ? (response.data as Record<string, unknown>)
      : {};
  return { status: response?.status ?? null, data };
}

/** What the server said went wrong, or `fallback` when it said nothing. */
export function errorMessage(error: unknown, fallback: string): string {
  const { data } = errorBody(error);
  return typeof data.error === "string" ? data.error : fallback;
}

const CONFLICTS: ReadonlySet<unknown> = new Set([
  "repeat",
  "wait",
  "order",
  "stale",
]);

/**
 * A 409 answer the page asks the person about (a repeat, a wait, an
 * earlier step still pending, a step that changed), or null for any other
 * refusal.
 */
export function parseConflict(error: unknown): ConflictBody | null {
  const { status, data } = errorBody(error);
  return status === 409 && CONFLICTS.has(data.code)
    ? (data as unknown as ConflictBody)
    : null;
}
