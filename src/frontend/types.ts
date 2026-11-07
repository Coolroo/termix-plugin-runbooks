import type { Check, CheckResult } from "../shared/checks";

export type { Check, CheckResult };

export type RunbookStatus = "open" | "done" | "abandoned";
export type StepStatus = "pending" | "done" | "failed" | "skipped";

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
}

export interface Run {
  id: number;
  stepId: number;
  runbookId: number;
  mode: "exec" | "terminal";
  status: "running" | "awaiting-output" | "done" | "failed";
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
}

/** The wait a step asks for after the step before it, as the server saw it. */
export interface StepWait {
  previous: { id: number; position: number; title: string };
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
