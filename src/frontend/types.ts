import type { Check, CheckResult } from "../shared/checks";

export type { Check, CheckResult };

export type RunbookStatus = "open" | "done" | "abandoned";

/** Who a runbook belongs to, as the agent set it (1.4.0). */
export interface RunbookOwner {
  task?: string;
  agent?: string;
  label?: string;
}

/** Where a Run takes the command's standard input from (1.2.0). */
export type StdinSource =
  | {
      from: "step";
      /** A position, or an amendment's label ("3a", 1.4.0). */
      step: number | string;
      stream: "stdout" | "stderr";
      allowFailed?: boolean;
    }
  | { from: "value"; name: string }
  | { from: "secret"; name: string }
  | { from: "secret"; library: string };

/** A secret a step captures, as the server shows it: never its value. */
export interface SecretState {
  name: string;
  /** The step that captures it: its position, or its label ("3a"). */
  step: number | string;
  set: boolean;
  expiresAt: string | null;
}

/** A step's input as the page shows it: never a secret's value. */
export interface StdinView {
  source: StdinSource;
  bytes: number | null;
  /** The first 200 characters of a step or value input. */
  preview: string | null;
  /** Why a Run would be refused now. */
  problem: string | null;
}
/** "replaced" (1.4.0): an amendment replaced it; it counts as ended. */
export type StepStatus = "pending" | "done" | "failed" | "skipped" | "replaced";

/** How an agent amended a step (1.4.0), shown on the new step. */
export interface StepAmendment {
  kind: "replace" | "substep";
  reason: string;
  /** The token name of the agent. */
  by: string;
  /** The step it amends. */
  stepId: number | null;
  stepLabel: string | null;
  /** For a fixed version: the command it replaces, shown struck through. */
  oldCommand: string | null;
}

export interface Progress {
  done: number;
  failed: number;
  total: number;
}

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
  amendedPending?: number;
}

export interface Run {
  id: number;
  stepId: number;
  runbookId: number;
  mode: "exec" | "terminal" | "manual" | "agent" | "outside";
  status: "running" | "awaiting-output" | "done" | "failed";
  /** Null for a manual or agent run. */
  hostId: number | null;
  command: string;
  commandHash: string;
  /** A manual run's note. */
  note?: string | null;
  /** Seconds of the wait timer left when it was started anyway. */
  startedEarlySeconds?: number | null;
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
  checks?: CheckResult[] | null;
  /** The command is running now; stdout and stderr are what arrived so far. */
  running?: boolean;
  /** When the running command last printed anything. */
  lastOutputAt?: string | null;
  /** For a running run: time since it started, as the server saw it. */
  elapsedMs?: number | null;
  /** For a running run: time since its last output (or start). */
  silentMs?: number | null;
  /** The output shows only when the run ends: it captures a secret. */
  outputHeld?: boolean;
  /** The source and size of the standard input it got. */
  stdin?: (StdinSource & { bytes: number }) | null;
  /** Secrets it read or stored, by name. */
  secrets?: {
    used: string[];
    captured: Array<{ name: string; expiresAt: string }>;
  } | null;
}

/** A "sent" event on a step: who sent it to the agent, when, the note. */
export interface SentToAgent {
  id: number;
  createdBy: string;
  createdAt: string;
  note: string | null;
}

/** The wait a step asks for after the step before it, as the server saw it. */
export interface StepWait {
  previous: { id: number; position: number; label?: string; title: string };
  seconds: number;
  reason: string | null;
  previousEnded: boolean;
  until: string | null;
  remainingMs: number;
}

export interface Step {
  id: number;
  runbookId: number;
  position: number;
  /** 1.4.0: where the person runs the command outside Termix; null if not. */
  where?: string | null;
  /** 1.4.0: "3", or "3a" for an amendment. */
  label?: string;
  suffix?: string | null;
  /** 1.4.0: how an agent amended a step; null when it is not an amendment. */
  amendment?: StepAmendment | null;
  /** 1.4.0: the step that replaced this one, while it is replaced. */
  replacedBy?: { id: number; label: string } | null;
  title: string;
  body: string;
  hostId: number | null;
  hostName: string | null;
  command: string | null;
  resolvedCommand: string | null;
  commandHash: string | null;
  missing: string[];
  expect: string;
  captures: Array<{ name: string; pattern: string }>;
  /** Rules tested on the output when a run ends. */
  checks?: Check[];
  hideOutputFromAgents: boolean;
  status: StepStatus;
  skipReason: string | null;
  ownerNote: string;
  timeoutMs: number | null;
  waitAfterPreviousSeconds?: number | null;
  waitReason?: string | null;
  /** Null when the step asks for no wait or is the first step. */
  wait?: StepWait | null;
  /** Where a Run takes standard input from; null for none. */
  stdin?: StdinView | null;
  /** Secrets a run takes from the output, by name and pattern. */
  secretCaptures?: Array<{ name: string; pattern: string }>;
  /** Why a step that captures secrets cannot run now. */
  secretsProblem?: string | null;
  /** Who does it: a person runs it, an agent completes it (1.4.0). */
  owner?: "person" | "agent";
  /** Each time a person sent it to the agent, newest first (1.4.0). */
  sent?: SentToAgent[];
  revision: number;
  runs: Run[];
}

export interface EffectiveValue {
  name: string;
  value: string;
  source: "author" | "capture";
  stepId?: number;
  runId?: number;
}

export interface Runbook extends RunbookSummary {
  summary: string;
  values: Record<string, string>;
  effectiveValues: EffectiveValue[];
  nextStepId: number | null;
  /** Who the runbook belongs to; null when the agent did not say. */
  owner?: RunbookOwner | null;
  /** The owner's label, or the name of the token that made it. */
  agentLabel?: string;
  /** Whether agent notifications are on. */
  notifyEnabled?: boolean;
  /** Notifications are on and the runbook has an owner: Send to agent. */
  canSendToAgent?: boolean;
  /** Whether the OpenBao Secrets service is there. */
  secretsAvailable?: boolean;
  /** Every secret the steps capture: never a value. */
  secrets?: SecretState[];
  steps: Step[];
}

export interface TokenInfo {
  id: number;
  name: string;
  prefix: string;
  createdBy: string;
  hosts: Array<{
    id: number;
    name: string | null;
    address: string;
    folder: string | null;
    /** False for a host found not to take SSH; agents do not get it. */
    ssh?: boolean;
  }>;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A session as the SSH Terminal plugin's terminal.listSessions lists it. */
export interface TerminalSession {
  /** The terminal tab's id. */
  id: string;
  hostId: number | string | null;
  hostName?: string;
  label?: string;
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
