/**
 * What the person routes send, in one definition. The server's view
 * builders (personView, runbookSummary, amendmentView, progress, ...) are
 * typed with these, and the Runbooks tab reads them, so a field the server
 * stops sending, or one the page reads but the server never sends, fails
 * the type check on both sides.
 *
 * Shared by the server and the UI. Types only: no React and no Node here.
 */

import type { Check, CheckResult } from "./checks.js";
import type { AskField, ByHand, GenerateField } from "./secret-steps.js";

export type {
  AuthorStore,
  AskField,
  ByHand,
  GenerateField,
} from "./secret-steps.js";
export type { Check, CheckResult };

export type RunbookStatus = "open" | "done" | "abandoned";
/** "replaced" (1.4.0): an amendment replaced it; it counts as ended. */
export type StepStatus = "pending" | "done" | "failed" | "skipped" | "replaced";
/** Who does a step (1.4.0): a person runs it, an agent completes it. */
export type StepOwner = "person" | "agent";
/** How an amendment amends its step (1.4.0). */
export type AmendKind = "replace" | "substep";
export type RunMode =
  "exec" | "terminal" | "manual" | "agent" | "outside" | "secret";
export type RunStatus = "running" | "awaiting-output" | "done" | "failed";

/** The agent and task a runbook belongs to (1.4.0), as the agent set it. */
export interface RunbookOwner {
  /** A task id, such as "T-42". */
  task?: string;
  /** An address of the agent session that the receiver understands. */
  agent?: string;
  /** Shown to the person. */
  label?: string;
}

export type StdinStream = "stdout" | "stderr";

/**
 * Where a Run takes the command's standard input from (1.2.0), as an
 * author writes it and every view shows it. `step` is a position (3) or,
 * for an amendment, its label ("3a", 1.4.0).
 */
export type StdinSource =
  | {
      from: "step";
      step: number | string;
      stream: StdinStream;
      allowFailed?: boolean;
    }
  | { from: "value"; name: string }
  | { from: "secret"; name: string }
  | { from: "secret"; library: string };

/** What a run keeps of its input: where it came from and its size only. */
export type RunStdin = StdinSource & { bytes: number };

/** What the page shows of a step's input: its source, size and start. */
export interface StdinView {
  source: StdinSource;
  /** Bytes of a step or value input; null for a secret or a problem. */
  bytes: number | null;
  /** The first characters of a step or value input; never a secret. */
  preview: string | null;
  /** Why a Run would be refused now, if it would. */
  problem: string | null;
  /**
   * 1.4.2: where to get the secret by hand, when the step that makes it (or
   * the library) is done by hand now: an engine, a path, a field, and the
   * step that makes it.
   */
  byHand?: ByHand & { step: string | null };
}

/** A secret a step captures, as the API, MCP and the page show it. */
export interface SecretState {
  name: string;
  /** The step that captures it: its position, or its label ("3a"). */
  step: number | string;
  /** Stored in OpenBao Secrets now: captured, not deleted, not expired. */
  set: boolean;
  expiresAt: string | null;
}

/** What a Make a secret or Ask for a secret step shows (1.4.2). */
export interface SecretStepView {
  kind: "generate" | "ask";
  name: string;
  /** ready: Make it or Save; by-hand: instructions and Done or Failed. */
  mode: "ready" | "by-hand";
  /** Why it is done by hand, when it is. */
  reason: string | null;
  /** Where the person keeps the value by hand, in OpenBao or Vault. */
  byHand: ByHand;
  /** For the runbook's secrets: whether it is stored now, and until when. */
  set: boolean;
  expiresAt: string | null;
}

/** The secrets a run read or stored, by name. Never their values. */
export interface RunSecrets {
  used: string[];
  captured: Array<{ name: string; expiresAt: string }>;
  /**
   * The secret a Make a secret or Ask for a secret step made or saved
   * (1.4.2): its name, how, and where it went. Never the value.
   */
  made?: {
    name: string;
    how: "made" | "saved";
    store: "runbook" | "library" | "app";
    /** "mine/db", "web/host-1#token"; null for the runbook's secrets. */
    where: string | null;
    expiresAt: string | null;
  };
}

/** A run as it is stored, and as the routes that end a run send it. */
export interface RunRecord {
  id: number;
  stepId: number;
  runbookId: number;
  mode: RunMode;
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
  captured: Record<string, string>;
  /** One result per check of the step; null when they were not tested. */
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

/** A run as a runbook shows it: with what a running command printed. */
export interface Run extends RunRecord {
  /** The command is running now; stdout and stderr are what arrived so far. */
  running: boolean;
  /** When the running command last printed anything. */
  lastOutputAt: string | null;
  /** For a running run: time since it started, as the server saw it. */
  elapsedMs: number | null;
  /** For a running run: time since its last output (or start). */
  silentMs: number | null;
  /** The output shows only when the run ends: it captures a secret. */
  outputHeld?: boolean;
}

/** A run in a 409 repeat answer: who ran it, when, and how it ended. */
export interface RunSummary {
  runId: number;
  stepId: number;
  runbookId: number;
  /** The same step ran, not only the same command on the same host. */
  sameStep: boolean;
  mode: RunMode;
  status: RunStatus;
  userId: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

/** How an agent amended a step (1.4.0), shown on the new step. */
export interface StepAmendment {
  kind: AmendKind;
  reason: string;
  /** The token name of the agent. */
  by: string;
  /** The step it amends. */
  stepId: number | null;
  stepLabel: string | null;
  /** For a fixed version: the command it replaces, shown struck through. */
  oldCommand: string | null;
}

/** What a step shows of amendments (1.4.0). */
export interface AmendmentView {
  /** "3", or "3a" for an amendment. */
  label: string;
  /** How an agent amended it; null when it is not an amendment. */
  amendment: StepAmendment | null;
  /** The step that replaced it, while it is replaced. */
  replacedBy: { id: number; label: string } | null;
}

/** A step a wait or an order question names. */
export interface StepName {
  id: number;
  position: number;
  /** "3", or "3a" for an amendment. */
  label: string;
  title: string;
}

/** The wait a step asks for after the step before it, as the server saw it. */
export interface StepWait {
  /** The step before this one, whose end starts the timer. */
  previous: StepName;
  seconds: number;
  reason: string | null;
  /** Whether the previous step has ended; no timer runs before it has. */
  previousEnded: boolean;
  /** When the wait is over; null until the previous step ended. */
  until: string | null;
  /** Milliseconds still to wait, 0 when over or not started. */
  remainingMs: number;
}

/** A "sent" event on a step: who sent it to the agent, when, the note. */
export interface SentToAgent {
  id: number;
  createdBy: string;
  createdAt: string;
  note: string | null;
}

/** A step as the Termix UI shows it. */
export interface Step extends AmendmentView {
  id: number;
  runbookId: number;
  position: number;
  /** 1.4.0: the letter of an amendment (3a); null for a step that is not one. */
  suffix: string | null;
  /** 1.4.0: where the person runs the command outside Termix; null if not. */
  where: string | null;
  title: string;
  body: string;
  hostId: number | null;
  hostName: string | null;
  command: string | null;
  resolvedCommand: string | null;
  commandHash: string | null;
  /** Names the command uses that have no value: it cannot run. */
  missing: string[];
  expect: string;
  /** 1.4.3: body, expect and where with their values filled in. */
  resolvedBody: string;
  resolvedExpect: string;
  resolvedWhere: string | null;
  /** 1.4.3: names body, expect and where use that have no value. */
  textMissing: string[];
  captures: Array<{ name: string; pattern: string }>;
  /** Rules tested on the output when a run ends. */
  checks: Check[];
  hideOutputFromAgents: boolean;
  status: StepStatus;
  skipReason: string | null;
  ownerNote: string;
  timeoutMs: number | null;
  waitAfterPreviousSeconds: number | null;
  waitReason: string | null;
  /** Null when the step asks for no wait or is the first step. */
  wait: StepWait | null;
  /** Where a Run takes standard input from; null for none. */
  stdin: StdinView | null;
  /** Secrets a run takes from the output, by name and pattern. */
  secretCaptures: Array<{ name: string; pattern: string }>;
  /** Why a step that captures secrets cannot run now. */
  secretsProblem: string | null;
  /** Who does it: a person runs it, an agent completes it (1.4.0). */
  owner: StepOwner;
  /** 1.4.2: Make a secret; null on any other step. */
  generate: GenerateField | null;
  /** 1.4.2: Ask for a secret; null on any other step. */
  ask: AskField | null;
  /** 1.4.2: what a secret step shows; null on any other step. */
  secretStep: SecretStepView | null;
  /** Each time a person sent it to the agent, newest first (1.4.0). */
  sent: SentToAgent[];
  revision: number;
  runs: Run[];
}

export interface Progress {
  done: number;
  failed: number;
  total: number;
}

/** A runbook's own fields and progress, in every view of it. */
export interface RunbookSummary {
  id: number;
  title: string;
  status: RunbookStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  progress: Progress;
  /** Amendments that have not run yet (1.4.0): the list shows "amended". */
  amendedPending: number;
}

/** A runbook in GET /runbooks. */
export interface RunbookListEntry extends RunbookSummary {
  /** The kind of the next step (1.4.1), null when none is pending. */
  nextKind: string | null;
}

/** A value a command gets: the author's, or captured from a run. */
export interface EffectiveValue {
  name: string;
  value: string;
  source: "author" | "capture";
  stepId?: number;
  runId?: number;
}

/** The whole runbook as the Termix UI shows it. */
export interface Runbook extends RunbookSummary {
  summary: string;
  values: Record<string, string>;
  effectiveValues: EffectiveValue[];
  nextStepId: number | null;
  /** Who the runbook belongs to; null when the agent did not say. */
  owner: RunbookOwner | null;
  /** The owner's label, or the name of the token that made it. */
  agentLabel: string;
  /** Whether agent notifications are on. */
  notifyEnabled: boolean;
  /** Notifications are on and the runbook has an owner: Send to agent. */
  canSendToAgent: boolean;
  /** Whether the OpenBao Secrets service is there. */
  secretsAvailable: boolean;
  /** Every secret the steps capture: never a value. */
  secrets: SecretState[];
  steps: Step[];
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

/** An agent token as GET /tokens shows it: never its hash. */
export interface TokenInfo {
  id: number;
  name: string;
  prefix: string;
  createdBy: string;
  hosts: TokenHost[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * The 409 answers the page asks the person about before it sends a run or
 * a secret again: a repeat, a wait timer, an earlier step still pending,
 * and a step that changed. `error` says it in words.
 */
export type ConflictBody = { error: string } & (
  RepeatConflict | WaitConflict | OrderConflict | StaleConflict
);

export interface RepeatConflict {
  code: "repeat";
  /** The run before; null for a secret step that ended without one. */
  repeat: RunSummary | null;
}

export interface WaitConflict {
  code: "wait";
  remainingSeconds: number;
  reason: string | null;
  waitUntil: string | null;
  previous: StepName;
}

export interface OrderConflict {
  code: "order";
  /** The earlier steps still pending, in order. */
  blocking: StepName[];
}

export interface StaleConflict {
  code: "stale";
}
