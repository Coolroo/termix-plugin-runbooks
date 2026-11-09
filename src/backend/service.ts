/**
 * What a runbook looks like to a person and to an agent, and the checks on
 * what an author may write. Shared by the person routes, the agent routes and
 * the MCP tools.
 */

import type {
  EventRow,
  NewStep,
  RunRow,
  RunbookOwner,
  RunbookRow,
  RunbookStatus,
  StepOwner,
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
import {
  MAX_STDIN_BYTES,
  normalizeStdin,
  showStdin,
  STDIN_PREVIEW_CHARS,
  stdinKey,
  secretNameProblem,
  stdinProblem,
  type StdinSource,
} from "./stdin.js";

/** A step as an author writes it: stdin names an earlier step by position. */
export type AuthorStep = Omit<NewStep, "stdin"> & {
  stdin: StdinSource | null;
};

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
  ownerTask: 64,
  ownerAgent: 200,
  ownerLabel: 80,
  agentNote: 2_000,
  agentOutputBytes: 65_536,
};

export const STEP_OWNERS: StepOwner[] = ["person", "agent"];

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

/**
 * Who a runbook belongs to: { task?, agent?, label? }, each a short string.
 * Null (or an object with nothing in it) clears it.
 */
export function parseOwner(value: unknown): RunbookOwner | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(
      "owner must be an object { task, agent, label } or null",
    );
  }
  const raw = value as Record<string, unknown>;
  const limits = {
    task: LIMITS.ownerTask,
    agent: LIMITS.ownerAgent,
    label: LIMITS.ownerLabel,
  } as const;
  for (const key of Object.keys(raw)) {
    if (!(key in limits)) throw new InputError(`unknown owner field "${key}"`);
  }
  const out: RunbookOwner = {};
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const field = raw[key];
    if (field === undefined || field === null) continue;
    const given = text(field, `owner.${key}`, limits[key]).trim();
    if (/[\u0000-\u001f\u007f]/.test(given)) {
      throw new InputError(`owner.${key} must not contain control characters`);
    }
    if (given) out[key] = given;
  }
  return Object.keys(out).length ? out : null;
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
): Partial<AuthorStep> {
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
    "stdin",
    "secretCaptures",
    "owner",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new InputError(`unknown step field "${key}"`);
  }
  const out: Partial<AuthorStep> = {};
  const has = (key: string) =>
    !options.partial || Object.prototype.hasOwnProperty.call(raw, key);

  if (has("title")) out.title = parseTitle(raw.title);
  if (has("owner")) {
    const owner = raw.owner ?? "person";
    if (!STEP_OWNERS.includes(owner as StepOwner)) {
      throw new InputError('owner must be "person" or "agent"');
    }
    out.owner = owner as StepOwner;
  }
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
  if (has("secretCaptures")) {
    const captures = raw.secretCaptures ?? [];
    const problem = secretCapturesProblem(captures);
    if (problem) throw new InputError(problem);
    out.secretCaptures = (captures as Capture[]).map(({ name, pattern }) => ({
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
  if (has("stdin")) {
    if (raw.stdin === null || raw.stdin === undefined) out.stdin = null;
    else {
      const problem = stdinProblem(raw.stdin);
      if (problem) throw new InputError(problem);
      out.stdin = normalizeStdin(raw.stdin);
    }
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

export const MAX_SECRET_CAPTURES = 10;

/** Checks secret capture rules: as captures, at most 10, distinct names. */
export function secretCapturesProblem(input: unknown): string | null {
  if (!Array.isArray(input)) return "secretCaptures must be an array";
  if (input.length > MAX_SECRET_CAPTURES) {
    return `a step may have at most ${MAX_SECRET_CAPTURES} secretCaptures`;
  }
  const problem = checkCaptures(input);
  if (problem)
    return `secretCaptures: ${problem.replace(/^capture/, "secret")}`;
  const names = new Set<string>();
  for (const entry of input as Capture[]) {
    const nameProblem = secretNameProblem(entry.name, "secret name");
    if (nameProblem) return `secretCaptures: ${nameProblem}`;
    if (names.has(entry.name)) {
      return `secretCaptures: secret "${entry.name}" is named twice`;
    }
    names.add(entry.name);
  }
  return null;
}

/**
 * A secret a step reads by name must be captured by an earlier step of the
 * same runbook. Returns the problem, or null.
 */
export function secretReadsProblem(
  steps: Array<{
    position: number;
    title?: string;
    stdin: { from: string; name?: string } | null;
    secretCaptures: Capture[];
  }>,
): string | null {
  for (const step of steps) {
    const stdin = step.stdin;
    if (!stdin || stdin.from !== "secret" || stdin.name === undefined) continue;
    const captured = steps.some(
      (other) =>
        other.position < step.position &&
        other.secretCaptures.some((capture) => capture.name === stdin.name),
    );
    if (!captured) {
      return `step ${step.position} reads secret ${stdin.name}, which no earlier step captures (secretCaptures)`;
    }
  }
  return null;
}

/** A full new step, after parseStepInput without `partial`. */
export function completeStep(parsed: Partial<AuthorStep>): AuthorStep {
  const step: AuthorStep = {
    title: parsed.title!,
    body: parsed.body ?? "",
    hostId: parsed.hostId ?? null,
    command: parsed.command ?? null,
    expect: parsed.expect ?? "",
    captures: parsed.captures ?? [],
    secretCaptures: parsed.secretCaptures ?? [],
    hideOutputFromAgents: parsed.hideOutputFromAgents ?? false,
    timeoutMs: parsed.timeoutMs ?? null,
    checks: parsed.checks ?? [],
    waitAfterPreviousSeconds: parsed.waitAfterPreviousSeconds ?? null,
    waitReason: parsed.waitReason ?? null,
    stdin: parsed.stdin ?? null,
    owner: parsed.owner ?? "person",
  };
  checkStepShape(step);
  return step;
}

/**
 * A command needs a host to run on, captures and checks need a command, and
 * a value check names one of the step's captures. An agent step is never run
 * by Termix: its command only says what the agent will run, and its checks
 * test the output the agent hands in.
 */
export function checkStepShape(step: {
  hostId: number | null;
  command: string | null;
  captures: Capture[];
  checks?: Check[];
  waitAfterPreviousSeconds?: number | null;
  waitReason?: string | null;
  stdin?: unknown;
  secretCaptures?: Capture[];
  owner?: StepOwner;
}): void {
  if (step.owner === "agent") {
    checkAgentStepShape(step);
    return;
  }
  if ((step.secretCaptures ?? []).length > 0 && step.command === null) {
    throw new InputError(
      "secretCaptures need a command whose output they read",
    );
  }
  if (step.waitReason && !step.waitAfterPreviousSeconds) {
    throw new InputError("waitReason needs waitAfterPreviousSeconds");
  }
  if (step.command !== null && step.hostId === null) {
    throw new InputError("a step with a command needs a hostId");
  }
  if (step.stdin && step.command === null) {
    throw new InputError("stdin needs a command that reads it");
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

function checkAgentStepShape(step: Parameters<typeof checkStepShape>[0]): void {
  if (step.captures.length > 0) {
    throw new InputError(
      "an agent step cannot have captures: Termix never runs it, so it has no output to capture from",
    );
  }
  if ((step.secretCaptures ?? []).length > 0) {
    throw new InputError(
      "an agent step cannot have secretCaptures: Termix never runs it",
    );
  }
  if (step.stdin) {
    throw new InputError(
      "an agent step cannot have stdin: Termix never runs it",
    );
  }
  if (step.waitAfterPreviousSeconds || step.waitReason) {
    throw new InputError(
      "an agent step cannot have a wait timer: the agent completes it when it is its turn",
    );
  }
  const checks = step.checks ?? [];
  if (checks.some((check) => check.type === "exitCode")) {
    throw new InputError(
      "an agent step has no exit code: use contains, notContains, matches or notMatches checks on its output",
    );
  }
  const problem = checksProblem(checks, []);
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

/**
 * The command as it runs, and the hash a person approves: the host, the
 * command and, for a step with standard input, the input's source (never
 * the input itself).
 */
export function resolveStep(
  step: StepRow,
  values: Values,
  stdin: StdinSource | null = null,
): ResolvedStep {
  if (step.command === null || step.hostId === null) {
    return { command: null, hash: null, missing: [] };
  }
  const resolved = resolve(step.command, values);
  return {
    command: resolved.text,
    hash: resolved.missing.length
      ? null
      : commandHash(step.hostId, resolved.text, stdin ? stdinKey(stdin) : null),
    missing: resolved.missing,
  };
}

/** A step's stdin source as views show it: earlier steps by position. */
export function stepStdin(step: StepRow, steps: StepRow[]): StdinSource | null {
  const positions = new Map(steps.map((other) => [other.id, other.position]));
  return showStdin(step.stdin, (id) => positions.get(id) ?? null);
}

export type StdinText = { text: string } | { problem: string };

/**
 * The input of a step or value source as it stands now, or why there is
 * none. Null for a secret: only a Run reads a secret, as the person.
 */
export function stdinText(
  source: StdinSource,
  step: StepRow,
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
  values: Values,
): StdinText | null {
  let text: string;
  if (source.from === "step") {
    const from = steps.find((other) => other.position === source.step);
    if (!from || from.position >= step.position) {
      return { problem: `step ${source.step} is not an earlier step` };
    }
    const latest = [...(runsByStep.get(from.id) ?? [])]
      .sort((a, b) => b.id - a.id)
      .find((run) => run.status === "done" || run.status === "failed");
    if (!latest) {
      return { problem: `step ${source.step} has no finished run yet` };
    }
    if (latest.mode === "manual") {
      return { problem: `step ${source.step} has no command output` };
    }
    if (latest.status === "failed" && !source.allowFailed) {
      return { problem: `the last run of step ${source.step} failed` };
    }
    text =
      latest.mode === "terminal"
        ? (latest.pastedOutput ?? "")
        : (latest[source.stream] ?? "");
  } else if (source.from === "value") {
    if (!Object.prototype.hasOwnProperty.call(values, source.name)) {
      return { problem: `value ${source.name} has no value yet` };
    }
    text = `${values[source.name]}\n`;
  } else {
    return null;
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_STDIN_BYTES) {
    return {
      problem: `the input is ${Math.ceil(bytes / 1024)} KB; at most ${MAX_STDIN_BYTES / 1024} KB`,
    };
  }
  return { text };
}

/** What the page shows of a step's input: its source, size and start. */
export interface StdinView {
  source: StdinSource;
  /** Bytes of a step or value input; null for a secret or a problem. */
  bytes: number | null;
  /** The first characters of a step or value input; never a secret. */
  preview: string | null;
  /** Why a Run would be refused now, if it would. */
  problem: string | null;
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

/** A secret a step captures, as the API, MCP and the page show it. */
export interface SecretState {
  name: string;
  /** The position of the step that captures it. */
  step: number;
  /** Stored in OpenBao Secrets now: captured, not deleted, not expired. */
  set: boolean;
  expiresAt: string | null;
}

/** Every secret the runbook's steps capture, by name: never a value. */
export function secretStates(
  bundle: Pick<RunbookBundle, "runbook" | "steps" | "runsByStep">,
  at = Date.now(),
): SecretState[] {
  const removedAt = bundle.runbook.secretsRemovedAt;
  const out: SecretState[] = [];
  for (const step of bundle.steps) {
    const runs = [...(bundle.runsByStep.get(step.id) ?? [])].sort(
      (a, b) => b.id - a.id,
    );
    for (const capture of step.secretCaptures) {
      let entry: { name: string; expiresAt: string } | undefined;
      const run = runs.find((candidate) => {
        entry = candidate.secrets?.captured.find(
          (stored) => stored.name === capture.name,
        );
        return Boolean(entry);
      });
      const removed = Boolean(
        run && removedAt && run.finishedAt && run.finishedAt <= removedAt,
      );
      const set = Boolean(
        entry && !removed && Date.parse(entry.expiresAt) > at,
      );
      out.push({
        name: capture.name,
        step: step.position,
        set,
        expiresAt: set ? entry!.expiresAt : null,
      });
    }
  }
  return out;
}

/**
 * Whether a closed runbook still has secrets to delete: it has steps that
 * capture secrets, and none were deleted since the last one was stored.
 */
export function secretsPending(runbook: RunbookRow, steps: StepRow[]): boolean {
  if (!steps.some((step) => step.secretCaptures.length > 0)) return false;
  if (!runbook.secretsRemovedAt) return true;
  return Boolean(
    runbook.secretsStoredAt &&
    runbook.secretsStoredAt > runbook.secretsRemovedAt,
  );
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

export interface ViewOptions {
  /** Whether the OpenBao Secrets service is there now. */
  secretsAvailable?: boolean;
  /** Why a step that uses secrets cannot run without it. */
  noSecrets?: string;
  /** Whether agent notifications are on (1.3.0). */
  notifyEnabled?: boolean;
  /** The runbook's "sent" events, newest first (1.3.0). */
  sent?: EventRow[];
}

/**
 * What the person sees of who a runbook belongs to: the owner's label, or
 * the name of the token that made it.
 */
export function agentLabel(runbook: RunbookRow): string {
  return runbook.owner?.label ?? runbook.createdBy;
}

/**
 * An agent step's command with its values filled in, to show what the agent
 * will run. Never a hash: nothing in Termix runs it.
 */
function agentCommand(step: StepRow, values: Values): ResolvedStep {
  if (step.command === null) return { command: null, hash: null, missing: [] };
  const resolved = resolve(step.command, values);
  return { command: resolved.text, hash: null, missing: resolved.missing };
}

/** The whole runbook as the Termix UI shows it. */
export function personView(
  bundle: RunbookBundle,
  hostName: HostNames,
  options: ViewOptions = {},
) {
  const { runbook, steps, runsByStep } = bundle;
  const values = valuesObject(bundle.values);
  const next = steps.find((step) => step.status === "pending");
  const stdinView = (step: StepRow, source: StdinSource): StdinView => {
    const found = stdinText(source, step, steps, runsByStep, values);
    if (!found) {
      return {
        source,
        bytes: null,
        preview: null,
        problem: options.secretsAvailable
          ? null
          : (options.noSecrets ?? "no secrets"),
      };
    }
    if ("problem" in found) {
      return { source, bytes: null, preview: null, problem: found.problem };
    }
    return {
      source,
      bytes: Buffer.byteLength(found.text),
      preview: found.text.slice(0, STDIN_PREVIEW_CHARS),
      problem: null,
    };
  };
  return {
    ...runbookSummary(runbook, steps),
    summary: runbook.summary,
    values: runbook.values,
    effectiveValues: [...bundle.values.values()],
    nextStepId: next?.id ?? null,
    owner: runbook.owner,
    agentLabel: agentLabel(runbook),
    notifyEnabled: Boolean(options.notifyEnabled),
    // Send to agent needs notifications on and an agent to send to.
    canSendToAgent: Boolean(options.notifyEnabled && runbook.owner),
    secretsAvailable: Boolean(options.secretsAvailable),
    secrets: secretStates(bundle),
    steps: steps.map((step) => {
      const source = stepStdin(step, steps);
      const resolved =
        step.owner === "agent"
          ? agentCommand(step, values)
          : resolveStep(step, values, source);
      return {
        ...step,
        stdin: source ? stdinView(step, source) : null,
        // A step that captures secrets cannot run without the service.
        secretsProblem:
          step.secretCaptures.length > 0 && !options.secretsAvailable
            ? (options.noSecrets ?? "no secrets")
            : null,
        hostName: step.hostId === null ? null : hostName(step.hostId),
        resolvedCommand: resolved.command,
        commandHash: resolved.hash,
        missing: resolved.missing,
        wait: waitState(step, steps, runsByStep),
        runs: runsByStep.get(step.id) ?? [],
        // Each time a person sent this step to the agent, with the note.
        sent: (options.sent ?? [])
          .filter((event) => event.stepId === step.id)
          .map((event) => ({
            id: event.id,
            createdBy: event.createdBy,
            createdAt: event.createdAt,
            note: event.note,
          })),
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
    owner: runbook.owner,
    summary: runbook.summary,
    values: runbook.values,
    effectiveValues: values,
    secrets: secretStates(bundle),
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
        owner: step.owner,
        body: step.body,
        hostId: step.hostId,
        hostName: step.hostId === null ? null : hostName(step.hostId),
        command: step.command,
        missing: used.filter((name) => !known.has(name)),
        expect: step.expect,
        captures: step.captures,
        secretCaptures: step.secretCaptures,
        checks: step.checks,
        hideOutputFromAgents: step.hideOutputFromAgents,
        status: step.status,
        skipReason: step.skipReason,
        ownerNote: step.ownerNote,
        timeoutMs: step.timeoutMs,
        waitAfterPreviousSeconds: step.waitAfterPreviousSeconds,
        waitReason: step.waitReason,
        waitUntil: agentWaitUntil(waitState(step, steps, runsByStep)),
        stdin: stepStdin(step, steps),
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
    // Where its standard input came from and its size, never the input.
    stdin: run.stdin,
    // Secret names it read or stored, never a value.
    secrets: run.secrets,
    // A manual run's note (a step with no command marked by hand).
    note: run.note,
    // Seconds of the wait timer left when the person started it anyway.
    startedEarlySeconds: run.startedEarlySeconds,
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
