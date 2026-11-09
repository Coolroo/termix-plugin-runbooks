/**
 * The plugin's tables, read and written through Drizzle on every database
 * Termix supports. No RETURNING (MySQL has none) except through insertId.
 */

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  type SQL,
} from "drizzle-orm";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";
import {
  events as eventsDef,
  runbooks as runbooksDef,
  runs as runsDef,
  steps as stepsDef,
  tokens as tokensDef,
} from "./tables.js";
import { parseJson, type Capture, type Values } from "./values.js";
import type { Check, CheckResult } from "./checks.js";
import type { RunStdin, StoredStdin } from "./stdin.js";

/** The secrets a run read or stored, by name. Never their values. */
export interface RunSecrets {
  used: string[];
  captured: Array<{ name: string; expiresAt: string }>;
}

// Drizzle's table and client types are per dialect; the store treats them
// loosely and returns its own row types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Table = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Drizzle = any;

export type RunbookStatus = "open" | "done" | "abandoned";
export type StepOwner = "person" | "agent";

/** The agent and task a runbook belongs to (1.3.0), as the agent set it. */
export interface RunbookOwner {
  /** A task id, such as "T-176". */
  task?: string;
  /** An address of the agent session that the receiver understands. */
  agent?: string;
  /** Shown to the person. */
  label?: string;
}
export type StepStatus = "pending" | "done" | "failed" | "skipped";
export type RunStatus = "running" | "awaiting-output" | "done" | "failed";

export interface RunbookRow {
  id: number;
  title: string;
  summary: string;
  status: RunbookStatus;
  values: Values;
  createdBy: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** When a run last stored a captured secret (1.2.0). */
  secretsStoredAt: string | null;
  /** When the runbook's secrets were last deleted (1.2.0). */
  secretsRemovedAt: string | null;
  /** Who the runbook belongs to (1.3.0); null: nobody said. */
  owner: RunbookOwner | null;
  /** Event types the agent wants delivered (1.3.0); null: the default. */
  notify: string[] | null;
}

/** Something that happened to a runbook (1.3.0). */
export interface EventRow {
  id: number;
  runbookId: number;
  stepId: number | null;
  ownerUserId: string;
  type: string;
  reason: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  deliveredAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface StepRow {
  id: number;
  runbookId: number;
  position: number;
  title: string;
  body: string;
  hostId: number | null;
  command: string | null;
  expect: string;
  captures: Capture[];
  hideOutputFromAgents: boolean;
  checks: Check[];
  waitAfterPreviousSeconds: number | null;
  waitReason: string | null;
  /** When the step last ended (run finished or skipped); null while pending. */
  endedAt: string | null;
  /** Where a Run takes standard input from (1.2.0); null for none. */
  stdin: StoredStdin | null;
  /** Secrets a run takes from its output (1.2.0). */
  secretCaptures: Capture[];
  /** Who does the step (1.3.0): a person runs it, an agent completes it. */
  owner: StepOwner;
  status: StepStatus;
  skipReason: string | null;
  ownerNote: string;
  timeoutMs: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  id: number;
  stepId: number;
  runbookId: number;
  mode: "exec" | "terminal" | "manual" | "agent";
  status: RunStatus;
  /** Null for a manual or agent run: Termix ran nothing on a host. */
  hostId: number | null;
  command: string;
  commandHash: string;
  userId: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  truncated: boolean;
  timedOut: boolean;
  pastedOutput: string | null;
  error: string | null;
  captured: Values;
  /** One result per check of the step; null when they were not evaluated. */
  checks: CheckResult[] | null;
  /** The source and size of the standard input it got; null for none. */
  stdin: RunStdin | null;
  /** Secrets it read or stored, by name; null for none. */
  secrets: RunSecrets | null;
  /** A manual run's note, from the step's notes (1.2.0). */
  note: string | null;
  /** Seconds of the wait still left when it started anyway (1.2.0). */
  startedEarlySeconds: number | null;
}

/** A host a token may name, as the person saw it when they chose it. */
export interface TokenHost {
  id: number;
  name: string | null;
  address: string;
  folder: string | null;
  /**
   * Whether the host took SSH when it was last checked. Snapshots from
   * before 1.0.1 have no flag and count as SSH until checked; a host marked
   * false is never offered to agents.
   */
  ssh?: boolean;
}

export interface TokenRow {
  id: number;
  name: string;
  tokenHash: string;
  prefix: string;
  createdBy: string;
  hosts: TokenHost[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const now = () => new Date().toISOString();

function toRunbook(row: Record<string, unknown>): RunbookRow {
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

function toEvent(row: Record<string, unknown>): EventRow {
  const optional = (value: unknown) =>
    value === null || value === undefined ? null : String(value);
  return {
    id: Number(row.id),
    runbookId: Number(row.runbookId),
    stepId:
      row.stepId === null || row.stepId === undefined
        ? null
        : Number(row.stepId),
    ownerUserId: String(row.ownerUserId),
    type: String(row.type),
    reason: optional(row.reason),
    note: optional(row.note),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
    deliveredAt: optional(row.deliveredAt),
    attempts: Number(row.attempts),
    nextAttemptAt: optional(row.nextAttemptAt),
    lastError: optional(row.lastError),
  };
}

function toStep(row: Record<string, unknown>): StepRow {
  return {
    ...(row as unknown as StepRow),
    id: Number(row.id),
    runbookId: Number(row.runbookId),
    position: Number(row.position),
    hostId:
      row.hostId === null || row.hostId === undefined
        ? null
        : Number(row.hostId),
    timeoutMs:
      row.timeoutMs === null || row.timeoutMs === undefined
        ? null
        : Number(row.timeoutMs),
    waitAfterPreviousSeconds:
      row.waitAfterPreviousSeconds === null ||
      row.waitAfterPreviousSeconds === undefined
        ? null
        : Number(row.waitAfterPreviousSeconds),
    waitReason: (row.waitReason as string | null | undefined) ?? null,
    endedAt: (row.endedAt as string | null | undefined) ?? null,
    revision: Number(row.revision),
    hideOutputFromAgents: Boolean(row.hideOutputFromAgents),
    captures: parseJson<Capture[]>(row.captures, []),
    secretCaptures: parseJson<Capture[]>(row.secretCaptures, []),
    checks: parseJson<Check[]>(row.checks, []),
    stdin: parseJson<StoredStdin | null>(row.stdin, null),
    owner: row.owner === "agent" ? "agent" : "person",
  };
}

function toRun(row: Record<string, unknown>): RunRow {
  return {
    ...(row as unknown as RunRow),
    id: Number(row.id),
    stepId: Number(row.stepId),
    runbookId: Number(row.runbookId),
    hostId:
      row.mode === "manual" || row.mode === "agent" ? null : Number(row.hostId),
    note: (row.note as string | null | undefined) ?? null,
    startedEarlySeconds:
      row.startedEarlySeconds === null || row.startedEarlySeconds === undefined
        ? null
        : Number(row.startedEarlySeconds),
    exitCode:
      row.exitCode === null || row.exitCode === undefined
        ? null
        : Number(row.exitCode),
    truncated: Boolean(row.truncated),
    timedOut: Boolean(row.timedOut),
    captured: parseJson<Values>(row.captured, {}),
    checks: parseJson<CheckResult[] | null>(row.checks, null),
    stdin: parseJson<RunStdin | null>(row.stdin, null),
    secrets: parseJson<RunSecrets | null>(row.secrets, null),
  };
}

function toToken(row: Record<string, unknown>): TokenRow {
  return {
    ...(row as unknown as TokenRow),
    id: Number(row.id),
    hosts: parseJson<TokenHost[]>(row.hosts, []),
  };
}

export interface NewStep {
  title: string;
  body: string;
  hostId: number | null;
  command: string | null;
  expect: string;
  captures: Capture[];
  hideOutputFromAgents: boolean;
  timeoutMs: number | null;
  checks: Check[];
  waitAfterPreviousSeconds: number | null;
  waitReason: string | null;
  stdin: StoredStdin | null;
  secretCaptures: Capture[];
  owner: StepOwner;
}

/** Columns the store keeps as JSON text. */
const JSON_COLUMNS = new Set([
  "captures",
  "checks",
  "captured",
  "stdin",
  "secrets",
  "secretCaptures",
]);

export type Store = Awaited<ReturnType<typeof createStore>>;

export async function createStore(db: PluginDatabase) {
  const runbooks: Table = await db.define(runbooksDef);
  const steps: Table = await db.define(stepsDef);
  const runs: Table = await db.define(runsDef);
  const tokens: Table = await db.define(tokensDef);
  const events: Table = await db.define(eventsDef);
  const client = (): Promise<Drizzle> => db.client<Drizzle>();

  /** Inserts one row and returns its id. MySQL has no RETURNING. */
  async function insertId(
    table: Table,
    values: Record<string, unknown>,
  ): Promise<number> {
    const drizzle = await client();
    if (db.dialect === "mysql") {
      const result = await drizzle.insert(table).values(values);
      const header = Array.isArray(result) ? result[0] : result;
      return Number(header?.insertId);
    }
    const rows = await drizzle
      .insert(table)
      .values(values)
      .returning({ id: table.id });
    return Number(rows[0].id);
  }

  async function getRunbook(id: number): Promise<RunbookRow | null> {
    if (!Number.isInteger(id)) return null;
    const rows = await (
      await client()
    )
      .select()
      .from(runbooks)
      .where(eq(runbooks.id, id))
      .limit(1);
    return rows[0] ? toRunbook(rows[0]) : null;
  }

  async function listRunbooks(filter: {
    ownerUserId?: string;
    status?: RunbookStatus;
  }): Promise<RunbookRow[]> {
    const conditions: SQL[] = [];
    if (filter.ownerUserId) {
      conditions.push(eq(runbooks.createdByUserId, filter.ownerUserId));
    }
    if (filter.status) conditions.push(eq(runbooks.status, filter.status));
    const rows = await (
      await client()
    )
      .select()
      .from(runbooks)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(runbooks.updatedAt));
    return rows.map(toRunbook);
  }

  async function createRunbook(input: {
    title: string;
    summary: string;
    values: Values;
    createdBy: string;
    createdByUserId: string;
    owner?: RunbookOwner | null;
    notify?: string[] | null;
  }): Promise<number> {
    const at = now();
    return insertId(runbooks, {
      notify: input.notify ? JSON.stringify(input.notify) : null,
      title: input.title,
      summary: input.summary,
      status: "open",
      values: JSON.stringify(input.values),
      owner: input.owner ? JSON.stringify(input.owner) : null,
      createdBy: input.createdBy,
      createdByUserId: input.createdByUserId,
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });
  }

  /** Changes fields and bumps the runbook's revision. */
  async function touchRunbook(
    id: number,
    patch: Partial<{
      title: string;
      summary: string;
      status: RunbookStatus;
      values: Values;
      secretsStoredAt: string;
      secretsRemovedAt: string;
      owner: RunbookOwner | null;
      notify: string[] | null;
    }> = {},
  ): Promise<void> {
    const current = await getRunbook(id);
    if (!current) return;
    const set: Record<string, unknown> = {
      updatedAt: now(),
      revision: current.revision + 1,
    };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.values !== undefined) set.values = JSON.stringify(patch.values);
    if (patch.secretsStoredAt !== undefined) {
      set.secretsStoredAt = patch.secretsStoredAt;
    }
    if (patch.secretsRemovedAt !== undefined) {
      set.secretsRemovedAt = patch.secretsRemovedAt;
    }
    if (patch.owner !== undefined) {
      set.owner = patch.owner ? JSON.stringify(patch.owner) : null;
    }
    if (patch.notify !== undefined) {
      set.notify = patch.notify ? JSON.stringify(patch.notify) : null;
    }
    await (await client()).update(runbooks).set(set).where(eq(runbooks.id, id));
  }

  async function listSteps(runbookId: number): Promise<StepRow[]> {
    const rows = await (
      await client()
    )
      .select()
      .from(steps)
      .where(eq(steps.runbookId, runbookId))
      .orderBy(asc(steps.position), asc(steps.id));
    return rows.map(toStep);
  }

  async function getStep(id: number): Promise<StepRow | null> {
    if (!Number.isInteger(id)) return null;
    const rows = await (
      await client()
    )
      .select()
      .from(steps)
      .where(eq(steps.id, id))
      .limit(1);
    return rows[0] ? toStep(rows[0]) : null;
  }

  async function insertStep(
    runbookId: number,
    position: number,
    step: NewStep,
  ): Promise<number> {
    const at = now();
    return insertId(steps, {
      runbookId,
      position,
      title: step.title,
      body: step.body,
      hostId: step.hostId,
      command: step.command,
      expect: step.expect,
      captures: JSON.stringify(step.captures),
      checks: JSON.stringify(step.checks),
      hideOutputFromAgents: step.hideOutputFromAgents,
      status: "pending",
      skipReason: null,
      ownerNote: "",
      timeoutMs: step.timeoutMs,
      waitAfterPreviousSeconds: step.waitAfterPreviousSeconds,
      waitReason: step.waitReason,
      stdin: step.stdin ? JSON.stringify(step.stdin) : null,
      secretCaptures: step.secretCaptures.length
        ? JSON.stringify(step.secretCaptures)
        : null,
      owner: step.owner,
      endedAt: null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
  }

  /** Changes a step. `edit` also bumps its revision (content changed). */
  async function updateStep(
    id: number,
    patch: Partial<
      NewStep & {
        position: number;
        status: StepStatus;
        skipReason: string | null;
        ownerNote: string;
        endedAt: string | null;
      }
    >,
    options: { edit?: boolean } = {},
  ): Promise<void> {
    const current = await getStep(id);
    if (!current) return;
    const set: Record<string, unknown> = { updatedAt: now() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      set[key] =
        JSON_COLUMNS.has(key) && value !== null ? JSON.stringify(value) : value;
    }
    if (options.edit) set.revision = current.revision + 1;
    await (await client()).update(steps).set(set).where(eq(steps.id, id));
  }

  async function deleteStep(id: number): Promise<void> {
    await (await client()).delete(steps).where(eq(steps.id, id));
  }

  async function listRuns(filter: {
    runbookId?: number;
    stepId?: number;
    status?: RunStatus;
  }): Promise<RunRow[]> {
    const conditions: SQL[] = [];
    if (filter.status !== undefined) {
      conditions.push(eq(runs.status, filter.status));
    }
    if (filter.runbookId !== undefined) {
      conditions.push(eq(runs.runbookId, filter.runbookId));
    }
    if (filter.stepId !== undefined) {
      conditions.push(eq(runs.stepId, filter.stepId));
    }
    const rows = await (
      await client()
    )
      .select()
      .from(runs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(runs.id));
    return rows.map(toRun);
  }

  async function getRun(id: number): Promise<RunRow | null> {
    if (!Number.isInteger(id)) return null;
    const rows = await (
      await client()
    )
      .select()
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** Step ids among `stepIds` that have at least one run. */
  async function stepsWithRuns(stepIds: number[]): Promise<Set<number>> {
    if (stepIds.length === 0) return new Set();
    const rows = await (
      await client()
    )
      .select({ stepId: runs.stepId })
      .from(runs)
      .where(inArray(runs.stepId, stepIds));
    return new Set(rows.map((row: { stepId: unknown }) => Number(row.stepId)));
  }

  /** The newest run of this hash that started at or after `since`. */
  async function lastRunOfHash(
    hash: string,
    since: string,
  ): Promise<RunRow | null> {
    const rows = await (
      await client()
    )
      .select()
      .from(runs)
      .where(and(eq(runs.commandHash, hash), gte(runs.startedAt, since)))
      .orderBy(desc(runs.id))
      .limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async function insertRun(
    input: Omit<
      RunRow,
      | "id"
      | "captured"
      | "checks"
      | "stdin"
      | "secrets"
      | "note"
      | "startedEarlySeconds"
    > & {
      note?: string | null;
      startedEarlySeconds?: number | null;
      captured?: Values;
      checks?: CheckResult[] | null;
      stdin?: RunStdin | null;
      secrets?: RunSecrets | null;
    },
  ): Promise<number> {
    return insertId(runs, {
      ...input,
      // A manual run has no host; the column takes none.
      hostId: input.hostId ?? 0,
      note: input.note ?? null,
      startedEarlySeconds: input.startedEarlySeconds ?? null,
      captured: input.captured ? JSON.stringify(input.captured) : null,
      checks: input.checks ? JSON.stringify(input.checks) : null,
      stdin: input.stdin ? JSON.stringify(input.stdin) : null,
      secrets: input.secrets ? JSON.stringify(input.secrets) : null,
    });
  }

  async function updateRun(
    id: number,
    patch: Partial<Omit<RunRow, "id">>,
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      set[key] =
        JSON_COLUMNS.has(key) && value !== null ? JSON.stringify(value) : value;
    }
    await (await client()).update(runs).set(set).where(eq(runs.id, id));
  }

  async function listTokens(): Promise<TokenRow[]> {
    const rows = await (
      await client()
    )
      .select()
      .from(tokens)
      .orderBy(desc(tokens.id));
    return rows.map(toToken);
  }

  async function activeTokens(): Promise<TokenRow[]> {
    const rows = await (
      await client()
    )
      .select()
      .from(tokens)
      .where(isNull(tokens.revokedAt));
    return rows.map(toToken);
  }

  async function findTokenByHash(hash: string): Promise<TokenRow | null> {
    const rows = await (
      await client()
    )
      .select()
      .from(tokens)
      .where(eq(tokens.tokenHash, hash))
      .limit(1);
    return rows[0] ? toToken(rows[0]) : null;
  }

  async function createToken(input: {
    name: string;
    tokenHash: string;
    prefix: string;
    createdBy: string;
    hosts: TokenHost[];
  }): Promise<number> {
    return insertId(tokens, {
      ...input,
      hosts: JSON.stringify(input.hosts),
      createdAt: now(),
      lastUsedAt: null,
      revokedAt: null,
    });
  }

  async function markTokenUsed(id: number): Promise<void> {
    await (
      await client()
    )
      .update(tokens)
      .set({ lastUsedAt: now() })
      .where(eq(tokens.id, id));
  }

  async function getToken(id: number): Promise<TokenRow | null> {
    if (!Number.isInteger(id)) return null;
    const rows = await (
      await client()
    )
      .select()
      .from(tokens)
      .where(eq(tokens.id, id))
      .limit(1);
    return rows[0] ? toToken(rows[0]) : null;
  }

  async function setTokenHosts(id: number, hosts: TokenHost[]): Promise<void> {
    await (
      await client()
    )
      .update(tokens)
      .set({ hosts: JSON.stringify(hosts) })
      .where(eq(tokens.id, id));
  }

  async function revokeToken(id: number): Promise<boolean> {
    const rows = await (
      await client()
    )
      .select()
      .from(tokens)
      .where(eq(tokens.id, id))
      .limit(1);
    if (!rows[0]) return false;
    if (!rows[0].revokedAt) {
      await (
        await client()
      )
        .update(tokens)
        .set({ revokedAt: now() })
        .where(eq(tokens.id, id));
    }
    return true;
  }

  async function insertEvent(
    input: Omit<
      EventRow,
      "id" | "deliveredAt" | "attempts" | "lastError" | "createdAt"
    >,
  ): Promise<number> {
    return insertId(events, {
      ...input,
      createdAt: now(),
      deliveredAt: null,
      attempts: 0,
      lastError: null,
    });
  }

  async function getEvent(id: number): Promise<EventRow | null> {
    if (!Number.isInteger(id)) return null;
    const rows = await (
      await client()
    )
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  /**
   * Events of one runbook (newest first), or of one person's runbooks after
   * an id (oldest first, for an agent that polls).
   */
  async function listEvents(filter: {
    runbookId?: number;
    ownerUserId?: string;
    afterId?: number;
    limit: number;
    order: "newest" | "oldest";
  }): Promise<EventRow[]> {
    const conditions: SQL[] = [];
    if (filter.runbookId !== undefined) {
      conditions.push(eq(events.runbookId, filter.runbookId));
    }
    if (filter.ownerUserId !== undefined) {
      conditions.push(eq(events.ownerUserId, filter.ownerUserId));
    }
    if (filter.afterId !== undefined) {
      conditions.push(gt(events.id, filter.afterId));
    }
    const rows = await (
      await client()
    )
      .select()
      .from(events)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(filter.order === "newest" ? desc(events.id) : asc(events.id))
      .limit(filter.limit);
    return rows.map(toEvent);
  }

  /** Events whose delivery is due at `at`, oldest first. */
  async function dueEvents(at: string, limit: number): Promise<EventRow[]> {
    const rows = await (
      await client()
    )
      .select()
      .from(events)
      .where(
        and(isNotNull(events.nextAttemptAt), lte(events.nextAttemptAt, at)),
      )
      .orderBy(asc(events.id))
      .limit(limit);
    return rows.map(toEvent);
  }

  async function updateEvent(
    id: number,
    patch: Partial<
      Pick<EventRow, "deliveredAt" | "attempts" | "nextAttemptAt" | "lastError">
    >,
  ): Promise<void> {
    await (await client()).update(events).set(patch).where(eq(events.id, id));
  }

  return {
    persist: (lazy = false) => db.persist(lazy ? { lazy: true } : undefined),
    insertEvent,
    getEvent,
    listEvents,
    dueEvents,
    updateEvent,
    getRunbook,
    listRunbooks,
    createRunbook,
    touchRunbook,
    listSteps,
    getStep,
    insertStep,
    updateStep,
    deleteStep,
    listRuns,
    getRun,
    stepsWithRuns,
    lastRunOfHash,
    insertRun,
    updateRun,
    listTokens,
    activeTokens,
    findTokenByHash,
    createToken,
    getToken,
    setTokenHosts,
    markTokenUsed,
    revokeToken,
  };
}
