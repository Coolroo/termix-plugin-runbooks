/**
 * What a runbook looks like to a person and to an agent, and the checks on
 * what an author may write. Shared by the person routes, the agent routes and
 * the MCP tools.
 */

import type {
  NewStep,
  RunRow,
  RunbookRow,
  RunbookStatus,
  StepRow,
  Store,
} from "./store.js";
import {
  checkCaptures,
  checkValues,
  commandHash,
  placeholders,
  resolve,
  type Capture,
  type Values,
} from "./values.js";
import { checksProblem, normalizeCheck, type Check } from "./checks.js";
import type { LiveRuns, ShownRun } from "./live.js";

export const HIDDEN = "[hidden by owner]";
export const RUNBOOK_STATUSES: RunbookStatus[] = ["open", "done", "abandoned"];

export const LIMITS = {
  title: 200,
  summary: 50_000,
  body: 50_000,
  expect: 20_000,
  command: 32_000,
  ownerNote: 20_000,
  stepsPerRunbook: 200,
  timeoutDefault: 120_000,
  timeoutMin: 1_000,
  timeoutMax: 600_000,
  waitMin: 1,
  waitMax: 86_400,
  waitReason: 500,
};

export class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function text(
  value: unknown,
  field: string,
  max: number,
  options: { required?: boolean } = {},
): string {
  if (value === undefined || value === null) {
    if (options.required) throw new InputError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") {
    throw new InputError(`${field} must be a string`);
  }
  if (options.required && value.trim() === "") {
    throw new InputError(`${field} is required`);
  }
  if (value.length > max) {
    throw new InputError(`${field} is longer than ${max} characters`);
  }
  return value;
}

export function parseTitle(value: unknown): string {
  return text(value, "title", LIMITS.title, { required: true }).trim();
}

export function parseSummary(value: unknown): string {
  return text(value, "summary", LIMITS.summary);
}

export function parseValues(value: unknown): Values {
  if (value === undefined) return {};
  const problem = checkValues(value);
  if (problem) throw new InputError(problem);
  return { ...(value as Values) };
}

export function parseStatus(value: unknown): RunbookStatus {
  if (!RUNBOOK_STATUSES.includes(value as RunbookStatus)) {
    throw new InputError(
      `status must be one of ${RUNBOOK_STATUSES.join(", ")}`,
    );
  }
  return value as RunbookStatus;
}

/**
 * A step as an author writes it. `partial` allows leaving fields out (an
 * edit); the result then holds only the fields that were given.
 */
export function parseStepInput(
  input: unknown,
  options: { partial?: boolean } = {},
): Partial<NewStep> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InputError("a step must be an object");
  }
  const raw = input as Record<string, unknown>;
  const known = new Set([
    "title",
    "body",
    "hostId",
    "command",
    "expect",
    "captures",
    "hideOutputFromAgents",
    "timeoutMs",
    "checks",
    "waitAfterPreviousSeconds",
    "waitReason",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new InputError(`unknown step field "${key}"`);
  }
  const out: Partial<NewStep> = {};
  const has = (key: string) =>
    !options.partial || Object.prototype.hasOwnProperty.call(raw, key);

  if (has("title")) out.title = parseTitle(raw.title);
  if (has("body")) out.body = text(raw.body, "body", LIMITS.body);
  if (has("expect")) out.expect = text(raw.expect, "expect", LIMITS.expect);
  if (has("hostId")) {
    const hostId = raw.hostId;
    if (hostId === null || hostId === undefined) out.hostId = null;
    else if (Number.isInteger(hostId) && (hostId as number) > 0) {
      out.hostId = hostId as number;
    } else throw new InputError("hostId must be a positive integer or null");
  }
  if (has("command")) {
    const command = raw.command;
    if (command === null || command === undefined || command === "") {
      out.command = null;
    } else {
      const value = text(command, "command", LIMITS.command);
      if (value.trim() === "") out.command = null;
      else if (value.includes("\0")) {
        throw new InputError("command must not contain NUL characters");
      } else out.command = value;
    }
  }
  if (has("captures")) {
    const captures = raw.captures ?? [];
    const problem = checkCaptures(captures);
    if (problem) throw new InputError(problem);
    out.captures = (captures as Capture[]).map(({ name, pattern }) => ({
      name,
      pattern,
    }));
  }
  if (has("waitAfterPreviousSeconds")) {
    const wait = raw.waitAfterPreviousSeconds;
    if (wait === null || wait === undefined)
      out.waitAfterPreviousSeconds = null;
    else if (
      Number.isInteger(wait) &&
      (wait as number) >= LIMITS.waitMin &&
      (wait as number) <= LIMITS.waitMax
    ) {
      out.waitAfterPreviousSeconds = wait as number;
    } else {
      throw new InputError(
        `waitAfterPreviousSeconds must be an integer from ${LIMITS.waitMin} to ${LIMITS.waitMax}`,
      );
    }
  }
  if (has("waitReason")) {
    const reason = raw.waitReason;
    if (reason === null || reason === undefined || reason === "") {
      out.waitReason = null;
    } else {
      const value = text(reason, "waitReason", LIMITS.waitReason).trim();
      out.waitReason = value === "" ? null : value;
    }
  }
  if (has("checks")) {
    const checks = raw.checks ?? [];
    const problem = checksProblem(checks);
    if (problem) throw new InputError(problem);
    out.checks = (checks as Check[]).map(normalizeCheck);
  }
  if (has("hideOutputFromAgents")) {
    const hide = raw.hideOutputFromAgents ?? false;
    if (typeof hide !== "boolean") {
      throw new InputError("hideOutputFromAgents must be true or false");
    }
    out.hideOutputFromAgents = hide;
  }
  if (has("timeoutMs")) {
    const timeout = raw.timeoutMs;
    if (timeout === null || timeout === undefined) out.timeoutMs = null;
    else if (
      Number.isInteger(timeout) &&
      (timeout as number) >= LIMITS.timeoutMin &&
      (timeout as number) <= LIMITS.timeoutMax
    ) {
      out.timeoutMs = timeout as number;
    } else {
      throw new InputError(
        `timeoutMs must be an integer from ${LIMITS.timeoutMin} to ${LIMITS.timeoutMax}`,
      );
    }
  }
  return out;
}

/** A full new step, after parseStepInput without `partial`. */
export function completeStep(parsed: Partial<NewStep>): NewStep {
  const step: NewStep = {
    title: parsed.title!,
    body: parsed.body ?? "",
    hostId: parsed.hostId ?? null,
    command: parsed.command ?? null,
    expect: parsed.expect ?? "",
    captures: parsed.captures ?? [],
    hideOutputFromAgents: parsed.hideOutputFromAgents ?? false,
    timeoutMs: parsed.timeoutMs ?? null,
    checks: parsed.checks ?? [],
    waitAfterPreviousSeconds: parsed.waitAfterPreviousSeconds ?? null,
    waitReason: parsed.waitReason ?? null,
  };
  checkStepShape(step);
  return step;
}

/**
 * A command needs a host to run on, captures and checks need a command, and
 * a value check names one of the step's captures.
 */
export function checkStepShape(step: {
  hostId: number | null;
  command: string | null;
  captures: Capture[];
  checks?: Check[];
  waitAfterPreviousSeconds?: number | null;
  waitReason?: string | null;
}): void {
  if (step.waitReason && !step.waitAfterPreviousSeconds) {
    throw new InputError("waitReason needs waitAfterPreviousSeconds");
  }
  if (step.command !== null && step.hostId === null) {
    throw new InputError("a step with a command needs a hostId");
  }
  if (step.captures.length > 0 && step.command === null) {
    throw new InputError("captures need a command whose output they read");
  }
  const checks = step.checks ?? [];
  if (checks.length > 0 && step.command === null) {
    throw new InputError("checks need a command whose output they read");
  }
  const problem = checksProblem(
    checks,
    step.captures.map((capture) => capture.name),
  );
  if (problem) throw new InputError(problem);
}

export interface EffectiveValue {
  name: string;
  value: string;
  source: "author" | "capture";
  stepId?: number;
  runId?: number;
}

/**
 * Author values, then captured values in step order (each step's runs oldest
 * first). A later value wins.
 */
export function effectiveValues(
  runbook: RunbookRow,
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
): Map<string, EffectiveValue> {
  const out = new Map<string, EffectiveValue>();
  for (const [name, value] of Object.entries(runbook.values)) {
    out.set(name, { name, value, source: "author" });
  }
  for (const step of steps) {
    const stepRuns = [...(runsByStep.get(step.id) ?? [])].sort(
      (a, b) => a.id - b.id,
    );
    for (const run of stepRuns) {
      for (const [name, value] of Object.entries(run.captured ?? {})) {
        out.set(name, {
          name,
          value,
          source: "capture",
          stepId: step.id,
          runId: run.id,
        });
      }
    }
  }
  return out;
}

export function valuesObject(map: Map<string, EffectiveValue>): Values {
  const values: Values = {};
  for (const [name, entry] of map) values[name] = entry.value;
  return values;
}

export interface ResolvedStep {
  command: string | null;
  hash: string | null;
  missing: string[];
}

export function resolveStep(step: StepRow, values: Values): ResolvedStep {
  if (step.command === null || step.hostId === null) {
    return { command: null, hash: null, missing: [] };
  }
  const resolved = resolve(step.command, values);
  return {
    command: resolved.text,
    hash: resolved.missing.length
      ? null
      : commandHash(step.hostId, resolved.text),
    missing: resolved.missing,
  };
}

export interface WaitState {
  /** The step before this one, whose end starts the timer. */
  previous: { id: number; position: number; title: string };
  seconds: number;
  reason: string | null;
  /** Whether the previous step has ended; no timer runs before it has. */
  previousEnded: boolean;
  /** When the wait is over; null until the previous step ended. */
  until: string | null;
  /** Milliseconds still to wait, 0 when over or not started. */
  remainingMs: number;
}

/**
 * The wait a step asks for after the step before it (by position). The
 * timer starts when that step last ended: its latest run finished, or it was
 * marked done or skipped. A pending previous step has not ended. Null for a
 * step with no wait, or with no step before it.
 */
export function waitState(
  step: StepRow,
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
  at = Date.now(),
): WaitState | null {
  if (!step.waitAfterPreviousSeconds) return null;
  const previous = steps
    .filter((other) => other.position < step.position)
    .sort((a, b) => b.position - a.position)[0];
  if (!previous) return null;
  const base = {
    previous: {
      id: previous.id,
      position: previous.position,
      title: previous.title,
    },
    seconds: step.waitAfterPreviousSeconds,
    reason: step.waitReason,
  };
  if (previous.status === "pending") {
    return { ...base, previousEnded: false, until: null, remainingMs: 0 };
  }
  const times = [
    previous.endedAt,
    ...(runsByStep.get(previous.id) ?? []).map((run) => run.finishedAt),
  ]
    .filter((time): time is string => Boolean(time))
    .map((time) => Date.parse(time))
    .filter((time) => !Number.isNaN(time));
  // A step that ended before 1.1.0 has no end time: its last change is.
  const ended = times.length
    ? Math.max(...times)
    : Date.parse(previous.updatedAt);
  const until = ended + step.waitAfterPreviousSeconds * 1000;
  return {
    ...base,
    previousEnded: true,
    until: new Date(until).toISOString(),
    remainingMs: Math.max(0, until - at),
  };
}

export interface RunbookBundle {
  runbook: RunbookRow;
  steps: StepRow[];
  runs: ShownRun[];
  runsByStep: Map<number, ShownRun[]>;
  values: Map<string, EffectiveValue>;
}

/** Runs as stored, with nothing running live in this process. */
function stored(list: RunRow[]): ShownRun[] {
  return list.map((run) => ({
    ...run,
    running: run.status === "running",
    lastOutputAt: null,
    elapsedMs: null,
    silentMs: null,
  }));
}

/**
 * A runbook with its steps and runs. With `live`, running runs carry the
 * output that has arrived so far.
 */
export async function loadBundle(
  store: Store,
  runbookId: number,
  live?: LiveRuns,
): Promise<RunbookBundle | null> {
  const runbook = await store.getRunbook(runbookId);
  if (!runbook) return null;
  const steps = await store.listSteps(runbookId);
  const rows = await store.listRuns({ runbookId });
  const runs = live ? live.show(rows) : stored(rows);
  const runsByStep = new Map<number, ShownRun[]>();
  for (const run of runs) {
    const list = runsByStep.get(run.stepId) ?? [];
    list.push(run);
    runsByStep.set(run.stepId, list);
  }
  return {
    runbook,
    steps,
    runs,
    runsByStep,
    values: effectiveValues(runbook, steps, runsByStep),
  };
}

export function progress(steps: StepRow[]) {
  const finished = steps.filter(
    (step) => step.status === "done" || step.status === "skipped",
  ).length;
  return {
    done: finished,
    failed: steps.filter((step) => step.status === "failed").length,
    total: steps.length,
  };
}

/**
 * The link that opens a runbook in the Runbooks tab, relative to the Termix
 * address: the plugin does not know the address people use. Termix keeps a
 * `?view=` link across a sign-in, so it works signed out too.
 */
export function openPath(runbookId: number): string {
  return `/?view=runbook&id=${runbookId}`;
}

export function runbookSummary(runbook: RunbookRow, steps: StepRow[]) {
  return {
    id: runbook.id,
    title: runbook.title,
    status: runbook.status,
    createdBy: runbook.createdBy,
    createdAt: runbook.createdAt,
    updatedAt: runbook.updatedAt,
    revision: runbook.revision,
    progress: progress(steps),
  };
}

type HostNames = (hostId: number) => string | null;

/** The whole runbook as the Termix UI shows it. */
export function personView(bundle: RunbookBundle, hostName: HostNames) {
  const { runbook, steps, runsByStep } = bundle;
  const values = valuesObject(bundle.values);
  const next = steps.find((step) => step.status === "pending");
  return {
    ...runbookSummary(runbook, steps),
    summary: runbook.summary,
    values: runbook.values,
    effectiveValues: [...bundle.values.values()],
    nextStepId: next?.id ?? null,
    steps: steps.map((step) => {
      const resolved = resolveStep(step, values);
      return {
        ...step,
        hostName: step.hostId === null ? null : hostName(step.hostId),
        resolvedCommand: resolved.command,
        commandHash: resolved.hash,
        missing: resolved.missing,
        wait: waitState(step, steps, runsByStep),
        runs: runsByStep.get(step.id) ?? [],
      };
    }),
  };
}

/**
 * The runbook as an agent sees it: hidden steps' output, and values captured
 * from them, are replaced, also where such a value shows up in a command that
 * ran.
 */
export function agentView(bundle: RunbookBundle, hostName: HostNames) {
  const { runbook, steps, runsByStep } = bundle;
  const hiddenSteps = new Set(
    steps.filter((step) => step.hideOutputFromAgents).map((step) => step.id),
  );
  const values = agentValues(bundle, hiddenSteps);
  const secrets = hiddenCapturedTexts(bundle, hiddenSteps);
  const mask = (value: string | null) => {
    if (value === null) return value;
    let out = value;
    for (const secret of secrets) out = out.split(secret).join(HIDDEN);
    return out;
  };
  const next = steps.find((step) => step.status === "pending");
  return {
    ...runbookSummary(runbook, steps),
    openPath: openPath(runbook.id),
    summary: runbook.summary,
    values: runbook.values,
    effectiveValues: values,
    nextStepId: next?.id ?? null,
    steps: steps.map((step) => {
      const hidden = hiddenSteps.has(step.id);
      const used = placeholders(step.command);
      const known = new Set(values.map((entry) => entry.name));
      const stepRuns = runsByStep.get(step.id) ?? [];
      return {
        id: step.id,
        position: step.position,
        title: step.title,
        body: step.body,
        hostId: step.hostId,
        hostName: step.hostId === null ? null : hostName(step.hostId),
        command: step.command,
        missing: used.filter((name) => !known.has(name)),
        expect: step.expect,
        captures: step.captures,
        checks: step.checks,
        hideOutputFromAgents: step.hideOutputFromAgents,
        status: step.status,
        skipReason: step.skipReason,
        ownerNote: step.ownerNote,
        timeoutMs: step.timeoutMs,
        waitAfterPreviousSeconds: step.waitAfterPreviousSeconds,
        waitReason: step.waitReason,
        waitUntil: agentWaitUntil(waitState(step, steps, runsByStep)),
        revision: step.revision,
        editable: stepRuns.length === 0,
        runs: stepRuns.map((run) => agentRun(run, hidden, mask)),
      };
    }),
  };
}

/** The end of a wait that is running now, for agents; null otherwise. */
function agentWaitUntil(wait: WaitState | null): string | null {
  return wait && wait.remainingMs > 0 ? wait.until : null;
}

function agentRun(
  run: ShownRun,
  hidden: boolean,
  mask: (value: string | null) => string | null,
) {
  const hide = (value: string | null) =>
    hidden && value !== null ? HIDDEN : mask(value);
  return {
    id: run.id,
    stepId: run.stepId,
    mode: run.mode,
    status: run.status,
    hostId: run.hostId,
    command: mask(run.command),
    userId: run.userId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    stdout: hide(run.stdout),
    stderr: hide(run.stderr),
    pastedOutput: hide(run.pastedOutput),
    truncated: run.truncated,
    timedOut: run.timedOut,
    error: mask(run.error),
    running: run.running,
    lastOutputAt: run.lastOutputAt,
    checks: run.checks,
    captured: hidden
      ? Object.fromEntries(Object.keys(run.captured).map((k) => [k, HIDDEN]))
      : run.captured,
  };
}

function hiddenCapturedTexts(
  bundle: RunbookBundle,
  hiddenSteps: Set<number>,
): string[] {
  const texts = new Set<string>();
  for (const run of bundle.runs) {
    if (!hiddenSteps.has(run.stepId)) continue;
    for (const value of Object.values(run.captured)) {
      // Very short values would mask unrelated text and say little anyway.
      if (value.length >= 4) texts.add(value);
    }
  }
  return [...texts].sort((a, b) => b.length - a.length);
}

/** Effective values with those captured from hidden steps replaced. */
export function agentValues(
  bundle: RunbookBundle,
  hiddenSteps?: Set<number>,
): EffectiveValue[] {
  const hidden =
    hiddenSteps ??
    new Set(
      bundle.steps
        .filter((step) => step.hideOutputFromAgents)
        .map((step) => step.id),
    );
  return [...bundle.values.values()].map((entry) =>
    entry.source === "capture" && entry.stepId && hidden.has(entry.stepId)
      ? { ...entry, value: HIDDEN }
      : entry,
  );
}
