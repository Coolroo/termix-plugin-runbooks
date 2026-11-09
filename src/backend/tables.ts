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
    // JSON { task?, agent?, label? }: the agent and task the runbook belongs
    // to, set by the agent (1.3.0). Null: no owner.
    owner: text(),
    // JSON array of the event types the agent wants delivered (1.3.0).
    // Null: the default list.
    notify: text(),
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
    // person | agent: who does the step (1.3.0). Null on older steps: person.
    owner: varchar(16),
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
    // or failed by a person; host 0, empty command) | agent (1.3.0: an agent
    // step the agent completed; host 0, userId is the token name)
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

/*
 * What happened to a runbook that an agent may want to hear about (1.3.0):
 * agent-turn, step-failed, runbook-done, sent and step-done. Ids and labels
 * only; a note is kept only on a "sent" event. The delivery columns say
 * whether the webhook got it: nextAttemptAt is set while a delivery is due,
 * and cleared when it was delivered or given up.
 */
export const events = defineTable(
  "events",
  {
    id: id(),
    runbookId: integer().notNull(),
    // Null for an event about the whole runbook.
    stepId: integer(),
    // The runbook's createdByUserId: the agent API lists events by it.
    ownerUserId: varchar(255).notNull(),
    type: varchar(24).notNull(),
    // step-failed: exit | check | stopped | interrupted | secret | manual;
    // runbook-done: done | abandoned. Null otherwise.
    reason: varchar(24),
    // The person's note on a "sent" event, up to 500 characters.
    note: text(),
    // A person's user id, a token name, or "termix".
    createdBy: varchar(255).notNull(),
    createdAt: timestamp().notNull(),
    deliveredAt: timestamp(),
    attempts: integer().notNull(),
    nextAttemptAt: timestamp(),
    // Why the last delivery failed: short, never a secret.
    lastError: text(),
  },
  {
    indexes: [
      { name: "idx_p_runbooks_events_runbook", columns: ["runbookId"] },
      { name: "idx_p_runbooks_events_owner", columns: ["ownerUserId"] },
      { name: "idx_p_runbooks_events_due", columns: ["nextAttemptAt"] },
    ],
  },
);

/*
 * Named values the plugin keeps for itself (1.3.0). "signing-secret": the
 * key notifications are signed with, sealed with ctx.secrets.seal, so it is
 * never in the database in the clear and delivery can read it without an
 * acting user. updatedBy and updatedAt say who made it and when.
 */
export const state = defineTable(
  "state",
  {
    id: id(),
    name: varchar(64).notNull().unique(),
    // Sealed. Never sent to a browser after the answer that made it.
    value: text().notNull(),
    updatedBy: varchar(255).notNull(),
    updatedAt: timestamp().notNull(),
  },
  {},
);

// termix-plugin migrations reads this list.
export const tables = [runbooks, steps, runs, tokens, events, state];
