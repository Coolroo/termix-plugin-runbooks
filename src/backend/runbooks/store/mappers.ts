/**
 * Between database rows and the store's row types: numbers, booleans and
 * JSON columns read back, and a patch written as columns.
 */

import { parseJson, type Capture, type Values } from "../../values/values.js";
import type { Check, CheckResult } from "../../checks/checks.js";
import type { StoredStdin } from "../../running/stdin.js";
import type { AskSpec, GenerateSpec } from "../../../shared/secret-steps.js";
import type {
  RunbookOwner,
  RunSecrets,
  RunStdin,
  TokenHost,
} from "../../../shared/api.js";
import type {
  EventRow,
  RunbookRow,
  RunRow,
  StepRow,
  TokenRow,
} from "./types.js";

/** A nullable number column: null when empty, else a number. */
function optNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** A nullable text column: null when empty, else text. */
function optString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A patch as columns: JSON columns as text, left-out fields skipped. */
export function columns(
  patch: Record<string, unknown>,
  rename: Record<string, string> = {},
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    set[rename[key] ?? key] =
      JSON_COLUMNS.has(key) && value !== null ? JSON.stringify(value) : value;
  }
  return set;
}

export function toRunbook(row: Record<string, unknown>): RunbookRow {
  return {
    ...(row as unknown as RunbookRow),
    id: Number(row.id),
    revision: Number(row.revision),
    values: parseJson<Values>(row.values, {}),
    secretsStoredAt: (row.secretsStoredAt as string | null | undefined) ?? null,
    secretsRemovedAt:
      (row.secretsRemovedAt as string | null | undefined) ?? null,
    owner: parseJson<RunbookOwner | null>(row.owner, null),
    notify: parseJson<string[] | null>(row.notify, null),
  };
}

export function toEvent(row: Record<string, unknown>): EventRow {
  return {
    id: Number(row.id),
    runbookId: Number(row.runbookId),
    stepId: optNumber(row.stepId),
    ownerUserId: String(row.ownerUserId),
    type: String(row.type),
    reason: optString(row.reason),
    note: optString(row.note),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
    deliveredAt: optString(row.deliveredAt),
    attempts: Number(row.attempts),
    nextAttemptAt: optString(row.nextAttemptAt),
    lastError: optString(row.lastError),
  };
}

export function toStep(row: Record<string, unknown>): StepRow {
  return {
    ...(row as unknown as StepRow),
    id: Number(row.id),
    runbookId: Number(row.runbookId),
    position: Number(row.position),
    hostId: optNumber(row.hostId),
    timeoutMs: optNumber(row.timeoutMs),
    waitAfterPreviousSeconds: optNumber(row.waitAfterPreviousSeconds),
    waitReason: (row.waitReason as string | null | undefined) ?? null,
    endedAt: (row.endedAt as string | null | undefined) ?? null,
    revision: Number(row.revision),
    hideOutputFromAgents: Boolean(row.hideOutputFromAgents),
    captures: parseJson<Capture[]>(row.captures, []),
    secretCaptures: parseJson<Capture[]>(row.secretCaptures, []),
    checks: parseJson<Check[]>(row.checks, []),
    stdin: parseJson<StoredStdin | null>(row.stdin, null),
    generate: parseJson<GenerateSpec | null>(row.generate, null),
    ask: parseJson<AskSpec | null>(row.ask, null),
    owner: row.owner === "agent" ? "agent" : "person",
    where: (row.outsideWhere as string | null | undefined) || null,
    suffix: (row.suffix as string | null | undefined) || null,
    amendsStepId: optNumber(row.amendsStepId),
    amendKind:
      row.amendKind === "replace" || row.amendKind === "substep"
        ? row.amendKind
        : null,
    amendReason: (row.amendReason as string | null | undefined) ?? null,
    amendedBy: (row.amendedBy as string | null | undefined) ?? null,
  };
}

export function toRun(row: Record<string, unknown>): RunRow {
  return {
    ...(row as unknown as RunRow),
    id: Number(row.id),
    stepId: Number(row.stepId),
    runbookId: Number(row.runbookId),
    hostId:
      row.mode === "manual" ||
      row.mode === "agent" ||
      row.mode === "outside" ||
      row.mode === "secret"
        ? null
        : Number(row.hostId),
    note: (row.note as string | null | undefined) ?? null,
    startedEarlySeconds: optNumber(row.startedEarlySeconds),
    exitCode: optNumber(row.exitCode),
    truncated: Boolean(row.truncated),
    timedOut: Boolean(row.timedOut),
    captured: parseJson<Values>(row.captured, {}),
    checks: parseJson<CheckResult[] | null>(row.checks, null),
    stdin: parseJson<RunStdin | null>(row.stdin, null),
    secrets: parseJson<RunSecrets | null>(row.secrets, null),
  };
}

export function toToken(row: Record<string, unknown>): TokenRow {
  return {
    ...(row as unknown as TokenRow),
    id: Number(row.id),
    hosts: parseJson<TokenHost[]>(row.hosts, []),
  };
}

/** Columns the store keeps as JSON text. */
const JSON_COLUMNS = new Set([
  "generate",
  "ask",
  "captures",
  "checks",
  "captured",
  "stdin",
  "secrets",
  "secretCaptures",
]);
