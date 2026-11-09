import {
  boolean,
  defineTable,
  id,
  integer,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

/*
 * Stored as p_runbooks_<name>. Links between these tables are plain integers:
 * the SDK only gives foreign keys to users and ssh_data, and a host id here is
 * deliberately not refHost(), so deleting a host never deletes the history of
 * what ran on it.
 *
 * Times are ISO strings set by the plugin, so they compare as text on every
 * database. JSON columns are text the plugin encodes itself. No text column
 * has a default: MySQL refuses defaults on TEXT.
 */

export const runbooks = defineTable(
  "runbooks",
  {
    id: id(),
    title: text().notNull(),
    summary: text().notNull(),
    // open | done | abandoned
    status: varchar(16).notNull(),
    // JSON object, name -> string, set by the author.
    values: text().notNull(),
    // Token name for an agent, user id for a person. For display.
    createdBy: varchar(255).notNull(),
    // The Termix user the author acts for (a token's creator).
    createdByUserId: varchar(255).notNull(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
    revision: integer().notNull(),
    // When a run last stored a secret this runbook captured, and when they
    // were last deleted from OpenBao Secrets (1.2.0). Never the secrets.
    secretsStoredAt: timestamp(),
    secretsRemovedAt: timestamp(),
  },
  {
    indexes: [
      { name: "idx_p_runbooks_runbooks_status", columns: ["status"] },
      { name: "idx_p_runbooks_runbooks_owner", columns: ["createdByUserId"] },
    ],
  },
);

export const steps = defineTable(
  "steps",
  {
    id: id(),
    runbookId: integer().notNull(),
    position: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    // Null: a manual step, text only.
    hostId: integer(),
    command: text(),
    expect: text().notNull(),
    // JSON array of { name, pattern }.
    captures: text().notNull(),
    hideOutputFromAgents: boolean().notNull(),
    // pending | done | failed | skipped
    status: varchar(16).notNull(),
    skipReason: text(),
    ownerNote: text().notNull(),
    timeoutMs: integer(),
    // JSON array of checks on the output (1.1.0). Null on older steps: none.
    checks: text(),
    // Seconds to wait after the step before it ended (1.1.0), and why.
    waitAfterPreviousSeconds: integer(),
    waitReason: text(),
    // When the step last ended: its run finished, or it was skipped (1.1.0).
    // Null while pending, and on steps that ended before 1.1.0.
    endedAt: timestamp(),
    // JSON: where a Run takes the command's standard input from (1.2.0): an
    // earlier step's output (by step id), a value or a secret, by name only.
    stdin: text(),
    // JSON array of { name, pattern }: secrets a run takes from its output
    // and stores in OpenBao Secrets (1.2.0). Null: none.
    secretCaptures: text(),
    revision: integer().notNull(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  {
    indexes: [{ name: "idx_p_runbooks_steps_runbook", columns: ["runbookId"] }],
  },
);

export const runs = defineTable(
  "runs",
  {
    id: id(),
    stepId: integer().notNull(),
    runbookId: integer().notNull(),
    // exec | terminal | manual (1.2.0: a step with no command marked done
    // or failed by a person; host 0, empty command)
    mode: varchar(16).notNull(),
    // running | awaiting-output | done | failed
    status: varchar(24).notNull(),
    hostId: integer().notNull(),
    command: text().notNull(),
    commandHash: varchar(64).notNull(),
    userId: varchar(255).notNull(),
    startedAt: timestamp().notNull(),
    finishedAt: timestamp(),
    exitCode: integer(),
    stdout: text(),
    stderr: text(),
    truncated: boolean().notNull(),
    timedOut: boolean().notNull(),
    pastedOutput: text(),
    error: text(),
    // JSON object, name -> string.
    captured: text(),
    // JSON array of { label, ok, detail }, one per check (1.1.0). Null when
    // the run's checks were not evaluated.
    checks: text(),
    // JSON: the source of the standard input the run got and its size; never
    // the input itself (1.2.0).
    stdin: text(),
    // JSON { used: [names], captured: [{ name, expiresAt }] }: the secrets
    // the run read or stored, by name only. Values are never here (1.2.0).
    secrets: text(),
    // The person's note on a manual run, from the step's notes (1.2.0).
    note: text(),
    // Seconds of the step's wait timer still left when the person started
    // it anyway (1.2.0). Null: not early.
    startedEarlySeconds: integer(),
  },
  {
    indexes: [
      { name: "idx_p_runbooks_runs_step", columns: ["stepId"] },
      { name: "idx_p_runbooks_runs_runbook", columns: ["runbookId"] },
      { name: "idx_p_runbooks_runs_hash", columns: ["commandHash"] },
    ],
  },
);

export const tokens = defineTable(
  "tokens",
  {
    id: id(),
    name: varchar(255).notNull(),
    // sha256 hex of the whole token. The token itself is never stored.
    tokenHash: varchar(64).notNull().unique(),
    prefix: varchar(16).notNull(),
    createdBy: varchar(255).notNull(),
    // JSON array of { id, name, address, folder, ssh }: the hosts this token
    // may name in steps, chosen by the person who made it.
    hosts: text().notNull(),
    createdAt: timestamp().notNull(),
    lastUsedAt: timestamp(),
    revokedAt: timestamp(),
  },
  {},
);

// termix-plugin migrations reads this list.
export const tables = [runbooks, steps, runs, tokens];
