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
    // to, set by the agent (1.4.0). Null: no owner.
    owner: text(),
    // JSON array of the event types the agent wants delivered (1.4.0).
    // Null: the default list.
    notify: text(),
    // The folder the list shows it in (1.4.11), one level: at most 60
    // characters, no "/". Null: No folder.
    folder: varchar(60),
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
    // pending | done | failed | skipped | replaced (1.4.0: a fixed version
    // of it was made; it counts as ended)
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
    // person | agent: who does the step (1.4.0). Null on older steps: person.
    owner: varchar(16),
    // Where a person runs a command outside Termix (1.4.0), such as
    // "Windows PC, PowerShell as admin": a person step with a command and
    // no host. Termix never runs it. Null: not such a step.
    outsideWhere: varchar(255),
    // Amendments (1.4.0). An amendment keeps its parent's position and gets
    // a suffix (a, b, c: 3a, 3b), so later steps never renumber. Null on a
    // step that is not an amendment.
    suffix: varchar(8),
    // The step it amends, and how: replace (a fixed version; the old step's
    // status becomes "replaced") or substep (an extra step after it).
    amendsStepId: integer(),
    amendKind: varchar(16),
    // Why, as the agent said it (up to 500 characters), and the token name.
    amendReason: text(),
    amendedBy: varchar(255),
    // JSON { name, format, length, store }: a Make a secret step (1.4.2),
    // whose value the server makes when a person clicks Make it. Null: not
    // such a step. Never the value.
    generate: text(),
    // JSON { name, label, pattern, store }: an Ask for a secret step
    // (1.4.2), whose value a person pastes once. Null: not such a step.
    ask: text(),
    // either | terminal | run: whether Run, Send to terminal or both may
    // start the command (1.4.6). Null on older steps: either.
    runIn: varchar(16),
    // One line for the person: why runIn is not either (1.4.6).
    runInReason: varchar(255),
    // JSON: the step's when rule (1.4.6), steps by id. Null: no rule, the
    // step is always needed. Its state is never stored.
    whenJson: text(),
    // JSON { options, multiple, min, max, value }: a Decision step (1.4.6),
    // where a person chooses from these options. Null: not such a step.
    decision: text(),
    // True: Run opens a terminal (pty) for the command, so a person can
    // type into programs that read one, such as sudo (1.4.6). Null on
    // older steps: false.
    interactive: boolean(),
    // JSON { host, name, action, force, waitFor, waitSeconds, value }: a VM
    // step (1.4.7), whose button asks HAW VM Manager to act on one VM as
    // the person who presses it. Null: not such a step.
    vm: text(),
    // JSON array of items: a sequence step (1.4.10), whose one Run runs
    // each item in order (src/shared/sequence.ts). Null: a step with one
    // command, or none, as before.
    sequence: text(),
    // The folder each run item, or the one command, starts in (1.4.10).
    // Null: the login's home, as before.
    workdir: text(),
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
    // exec | terminal | secret (1.4.2: a person made or saved a secret
    // step's value; host 0, empty command, never the value) | outside (1.4.0: a step run outside Termix, marked
    // done or failed by a person with the pasted output; host 0) |
    // manual (1.2.0: a step with no command marked done
    // or failed by a person; host 0, empty command) | agent (1.4.0: an agent
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
    // JSON array of { at, chars, hidden, ended }: what a person typed into
    // the running command, by size only. The text is never here (1.4.6).
    inputsJson: text(),
    // JSON { message, secretsMissing, secretNotStored, slowCaptures }: the
    // parts that error was made from, so agents get it built (1.4.6).
    errorPartsJson: text(),
    // Where a terminal run's pasted output came from (1.4.9): pasted (by
    // the person), captured (read from the terminal, kept as read) or
    // captured-edited. Null for no pasted output, and for older runs.
    outputSource: varchar(16),
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
 * What happened to a runbook that an agent may want to hear about (1.4.0):
 * agent-turn, step-failed, runbook-done, sent, step-done and (1.4.0)
 * amended. Ids and labels
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
    // runbook-done: done | abandoned; amended (1.4.0): replace | substep.
    // Null otherwise.
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
 * Named values the plugin keeps for itself (1.4.0). "signing-secret": the
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

/*
 * The items of a sequence step's run (1.4.10), one row each: what the item
 * ran, its output, exit code, check results, captures, start and end. The
 * run row keeps the whole: its status, and the items' output joined. The
 * attempts of a wait item, or of a run item with retry, are rows of
 * run_attempts, by item id.
 */
export const runItems = defineTable(
  "run_items",
  {
    id: id(),
    runId: integer().notNull(),
    stepId: integer().notNull(),
    runbookId: integer().notNull(),
    // 1-based: the item's place in the step's sequence.
    position: integer().notNull(),
    // run | delay | wait | port | http | file | container | unit | log | job
    type: varchar(16).notNull(),
    label: text(),
    // A run or wait item's command as it ran, values filled in; null for a
    // delay.
    command: text(),
    // A delay's seconds and reason.
    seconds: integer(),
    reason: text(),
    // stop | continue
    onFail: varchar(16).notNull(),
    // waiting | running | passed | failed | skipped
    status: varchar(16).notNull(),
    startedAt: timestamp(),
    finishedAt: timestamp(),
    // When a running delay ends, unless a person skips it.
    plannedEndAt: timestamp(),
    exitCode: integer(),
    // A wait or retried item's: the last attempt's output.
    stdout: text(),
    stderr: text(),
    truncated: boolean().notNull(),
    timedOut: boolean().notNull(),
    error: text(),
    // JSON array of { label, ok, detail }, one per check of the item.
    checks: text(),
    // JSON object, name -> string: kept only when the item passed.
    captured: text(),
    // The person who skipped a delay.
    skippedBy: varchar(255),
    // Continue from item N: the run this passed item was carried from.
    fromRunId: integer(),
    // Phase 2, a wait item or a run item with retry: the most attempts,
    // when its time limit ends, and when the next attempt starts while it
    // waits between two. Null on any other item.
    maxAttempts: integer(),
    endsBy: timestamp(),
    nextAttemptAt: timestamp(),
    // Phase 3, an event item: the state its last check read, in fixed
    // words ("healthy", "HTTP 503").
    result: varchar(120),
  },
  {
    indexes: [
      { name: "idx_p_runbooks_run_items_run", columns: ["runId"] },
      { name: "idx_p_runbooks_run_items_runbook", columns: ["runbookId"] },
    ],
  },
);

/*
 * The attempts of a wait item, or of a run item with retry (1.4.10, phase
 * 2), one row each, by run item id: its output (capped as a run's), exit
 * code, check and stopIf results, start, end, and why it did not pass.
 */
export const runAttempts = defineTable(
  "run_attempts",
  {
    id: id(),
    itemId: integer().notNull(),
    runId: integer().notNull(),
    runbookId: integer().notNull(),
    // 1-based.
    attempt: integer().notNull(),
    // running | passed | failed
    status: varchar(16).notNull(),
    startedAt: timestamp().notNull(),
    finishedAt: timestamp(),
    exitCode: integer(),
    stdout: text(),
    stderr: text(),
    truncated: boolean().notNull(),
    timedOut: boolean().notNull(),
    error: text(),
    // JSON arrays of { label, ok, detail }: the item's checks, and a wait
    // item's stopIf checks (ok: it matched).
    checks: text(),
    stopIf: text(),
    // exit | check | timeout | connect | stop-if | stopped | interrupted |
    // not-yet | fail-state; null while it runs and when it passed.
    why: varchar(16),
    // Phase 3, an event's check: the state it read, in fixed words.
    result: varchar(120),
  },
  {
    indexes: [
      { name: "idx_p_runbooks_run_attempts_item", columns: ["itemId"] },
      { name: "idx_p_runbooks_run_attempts_runbook", columns: ["runbookId"] },
    ],
  },
);

// termix-plugin migrations reads this list.
export const tables = [
  runbooks,
  steps,
  runs,
  tokens,
  events,
  state,
  runItems,
  runAttempts,
];
