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
  hideOutputFromAgents: boolean;
  status: StepStatus;
  skipReason: string | null;
  ownerNote: string;
  timeoutMs: number | null;
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
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface TerminalSession {
  id: string;
  hostId: number | null;
  hostName?: string;
  label?: string;
  connected?: boolean;
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
