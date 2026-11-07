/**
 * The plugin's tables, read and written through Drizzle on every database
 * Termix supports. No RETURNING (MySQL has none) except through insertId.
 */

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  type SQL,
} from "drizzle-orm";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";
import {
  runbooks as runbooksDef,
  runs as runsDef,
  steps as stepsDef,
  tokens as tokensDef,
} from "./tables.js";
import { parseJson, type Capture, type Values } from "./values.js";
import type { Check, CheckResult } from "./checks.js";

// Drizzle's table and client types are per dialect; the store treats them
// loosely and returns its own row types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Table = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Drizzle = any;

export type RunbookStatus = "open" | "done" | "abandoned";
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
  mode: "exec" | "terminal";
  status: RunStatus;
  hostId: number;
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
    checks: parseJson<Check[]>(row.checks, []),
  };
}

function toRun(row: Record<string, unknown>): RunRow {
  return {
    ...(row as unknown as RunRow),
    id: Number(row.id),
    stepId: Number(row.stepId),
    runbookId: Number(row.runbookId),
    hostId: Number(row.hostId),
    exitCode:
      row.exitCode === null || row.exitCode === undefined
        ? null
        : Number(row.exitCode),
    truncated: Boolean(row.truncated),
    timedOut: Boolean(row.timedOut),
    captured: parseJson<Values>(row.captured, {}),
    checks: parseJson<CheckResult[] | null>(row.checks, null),
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
}

export type Store = Awaited<ReturnType<typeof createStore>>;

export async function createStore(db: PluginDatabase) {
  const runbooks: Table = await db.define(runbooksDef);
  const steps: Table = await db.define(stepsDef);
  const runs: Table = await db.define(runsDef);
  const tokens: Table = await db.define(tokensDef);
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
  }): Promise<number> {
    const at = now();
    return insertId(runbooks, {
      title: input.title,
      summary: input.summary,
      status: "open",
      values: JSON.stringify(input.values),
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
        key === "captures" || key === "checks" ? JSON.stringify(value) : value;
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
    input: Omit<RunRow, "id" | "captured" | "checks"> & {
      captured?: Values;
      checks?: CheckResult[] | null;
    },
  ): Promise<number> {
    return insertId(runs, {
      ...input,
      captured: input.captured ? JSON.stringify(input.captured) : null,
      checks: input.checks ? JSON.stringify(input.checks) : null,
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
        (key === "captured" || key === "checks") && value !== null
          ? JSON.stringify(value)
          : value;
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

  return {
    persist: (lazy = false) => db.persist(lazy ? { lazy: true } : undefined),
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
