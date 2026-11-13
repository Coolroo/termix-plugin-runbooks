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
} from "../../tables.js";
import type { Values } from "../../values/values.js";
import { compareSteps } from "../../../shared/steps.js";
import type {
  Amendment,
  EventRow,
  NewStep,
  RunbookOwner,
  RunbookRow,
  RunbookStatus,
  RunRow,
  RunStatus,
  StepRow,
  StepStatus,
  TokenHost,
  TokenRow,
} from "./types.js";
import {
  columns,
  toEvent,
  toRun,
  toRunbook,
  toStep,
  toToken,
} from "./mappers.js";

// Drizzle's table and client types are per dialect; the store treats them
// loosely and returns its own row types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Table = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Drizzle = any;

export const now = () => new Date().toISOString();

/** Every condition at once; none: no WHERE. */
function allOf(conditions: SQL[]): SQL | undefined {
  return conditions.length ? and(...conditions) : undefined;
}

export type Store = Awaited<ReturnType<typeof createStore>>;

/** Fields of a new run that insertRun fills when they are left out. */
type RunDefaults =
  | "captured"
  | "checks"
  | "stdin"
  | "secrets"
  | "note"
  | "startedEarlySeconds"
  | "finishedAt"
  | "exitCode"
  | "stdout"
  | "stderr"
  | "truncated"
  | "timedOut"
  | "pastedOutput"
  | "error";

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

  /** The row with this id, as `map` reads it, or null. */
  async function one<T>(
    table: Table,
    id: number,
    map: (row: Record<string, unknown>) => T,
  ): Promise<T | null> {
    if (!Number.isInteger(id)) return null;
    const rows = await (
      await client()
    )
      .select()
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    return rows[0] ? map(rows[0]) : null;
  }

  function getRunbook(id: number): Promise<RunbookRow | null> {
    return one(runbooks, id, toRunbook);
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
      .where(allOf(conditions))
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
    // Amendments share their parent's position: (position, suffix) orders.
    return rows.map(toStep).sort(compareSteps);
  }

  function getStep(id: number): Promise<StepRow | null> {
    return one(steps, id, toStep);
  }

  async function insertStep(
    runbookId: number,
    position: number,
    step: NewStep,
    amendment: Amendment | null = null,
  ): Promise<number> {
    const at = now();
    return insertId(steps, {
      suffix: amendment?.suffix ?? null,
      amendsStepId: amendment?.amendsStepId ?? null,
      amendKind: amendment?.amendKind ?? null,
      amendReason: amendment?.amendReason ?? null,
      amendedBy: amendment?.amendedBy ?? null,
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
      outsideWhere: step.where,
      generate: step.generate ? JSON.stringify(step.generate) : null,
      ask: step.ask ? JSON.stringify(step.ask) : null,
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
    const set: Record<string, unknown> = {
      updatedAt: now(),
      // The API's "where" is the column outsideWhere (WHERE is SQL).
      ...columns(patch, { where: "outsideWhere" }),
    };
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
      .where(allOf(conditions))
      .orderBy(desc(runs.id));
    return rows.map(toRun);
  }

  function getRun(id: number): Promise<RunRow | null> {
    return one(runs, id, toRun);
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

  /**
   * Adds a run. What a run that has not ended, or ended by hand, does not
   * have may be left out: no exit code, output, error or end time, not
   * truncated, not timed out.
   */
  async function insertRun(
    input: Omit<RunRow, "id" | RunDefaults> &
      Partial<Pick<RunRow, RunDefaults>>,
  ): Promise<number> {
    return insertId(runs, {
      finishedAt: null,
      exitCode: null,
      stdout: null,
      stderr: null,
      truncated: false,
      timedOut: false,
      pastedOutput: null,
      error: null,
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
    await (
      await client()
    )
      .update(runs)
      .set(columns(patch))
      .where(eq(runs.id, id));
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

  function getToken(id: number): Promise<TokenRow | null> {
    return one(tokens, id, toToken);
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
    const row = await one(tokens, id, (found) => found);
    if (!row) return false;
    if (!row.revokedAt) {
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
      .where(allOf(conditions))
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
