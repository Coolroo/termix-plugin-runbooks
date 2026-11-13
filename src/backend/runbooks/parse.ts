/**
 * The checks on what an author may write: a runbook's fields and a step's,
 * and the shape each kind of step must have. Shared by the person routes,
 * the agent routes and the MCP tools.
 */

import type {
  NewStep,
  RunbookOwner,
  RunbookStatus,
  StepOwner,
} from "./store/types.js";
import {
  checkCaptures,
  checkValues,
  type Capture,
  type Values,
} from "../values/values.js";
import { checksProblem, normalizeCheck, type Check } from "../checks/checks.js";
import {
  normalizeStdin,
  stdinProblem,
  type StdinSource,
} from "../running/stdin.js";
import {
  parseAsk,
  parseGenerate,
  type AskSpec,
  type GenerateSpec,
} from "../../shared/secret-steps.js";
import { isOneLine } from "../../shared/names.js";
import { InputError } from "../core/errors.js";
import { strictObject } from "../core/parse.js";
import { secretCapturesProblem } from "../secrets/secret-view.js";

/** A step as an author writes it: stdin names an earlier step by position. */
export type AuthorStep = Omit<NewStep, "stdin"> & {
  stdin: StdinSource | null;
};

const RUNBOOK_STATUSES: RunbookStatus[] = ["open", "done", "abandoned"];

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
  amendReason: 500,
  where: 80,
};

const STEP_OWNERS: StepOwner[] = ["person", "agent"];

/** A runbook holds at most LIMITS.stepsPerRunbook steps, amendments too. */
export function checkStepCount(count: number): void {
  if (count > LIMITS.stepsPerRunbook) {
    throw new InputError(
      `a runbook may have at most ${LIMITS.stepsPerRunbook} steps`,
    );
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
  const limits = {
    task: LIMITS.ownerTask,
    agent: LIMITS.ownerAgent,
    label: LIMITS.ownerLabel,
  } as const;
  const raw = strictObject(value, Object.keys(limits), {
    notObject: "owner must be an object { task, agent, label } or null",
    field: "owner",
  });
  const out: RunbookOwner = {};
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const field = raw[key];
    if (field === undefined || field === null) continue;
    const given = text(field, `owner.${key}`, limits[key]).trim();
    if (!isOneLine(given)) {
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

/** The fields a step as an author writes it may have. */
const STEP_FIELDS = [
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
  "where",
  "generate",
  "ask",
];

/**
 * A step as an author writes it. `partial` allows leaving fields out (an
 * edit); the result then holds only the fields that were given.
 */
export function parseStepInput(
  input: unknown,
  options: { partial?: boolean } = {},
): Partial<AuthorStep> {
  const raw = strictObject(input, STEP_FIELDS, {
    notObject: "a step must be an object",
    field: "step",
  });
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
  if (has("where")) {
    const where = raw.where;
    if (where === null || where === undefined || where === "") {
      out.where = null;
    } else {
      const value = text(where, "where", LIMITS.where).trim();
      if (!isOneLine(value)) {
        throw new InputError("where must be one line");
      }
      out.where = value === "" ? null : value;
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
  if (has("generate")) {
    if (raw.generate === null || raw.generate === undefined) {
      out.generate = null;
    } else {
      try {
        out.generate = parseGenerate(raw.generate);
      } catch (error) {
        throw new InputError((error as Error).message);
      }
    }
  }
  if (has("ask")) {
    if (raw.ask === null || raw.ask === undefined) out.ask = null;
    else {
      try {
        out.ask = parseAsk(raw.ask);
      } catch (error) {
        throw new InputError((error as Error).message);
      }
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
    where: parsed.where ?? null,
    generate: parsed.generate ?? null,
    ask: parsed.ask ?? null,
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
  where?: string | null;
  generate?: GenerateSpec | null;
  ask?: AskSpec | null;
}): void {
  if (step.generate || step.ask) {
    checkSecretStepShape(step);
    return;
  }
  if (step.owner === "agent") {
    if (step.where) {
      throw new InputError(
        "where is for a person's step: an agent step's command needs no host",
      );
    }
    checkAgentStepShape(step);
    return;
  }
  if (step.where) {
    checkOutsideStepShape(step);
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
    throw new InputError(
      "a step with a command needs a hostId, or where for a command the person runs outside Termix",
    );
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

/**
 * A person step run outside Termix (1.4.0): a command, no host, and where.
 * Termix never runs it, so nothing that only a Run gives works: standard
 * input, secret captures and exit codes.
 */
function checkOutsideStepShape(
  step: Parameters<typeof checkStepShape>[0],
): void {
  if (step.command === null) {
    throw new InputError("where needs a command the person runs there");
  }
  if (step.hostId !== null) {
    throw new InputError(
      "a step with where runs outside Termix: leave out hostId",
    );
  }
  if (step.stdin) {
    throw new InputError(
      "a step run outside Termix cannot have stdin: Termix never runs it",
    );
  }
  if ((step.secretCaptures ?? []).length > 0) {
    throw new InputError(
      "a step run outside Termix cannot have secretCaptures: the pasted output is not kept as a secret",
    );
  }
  if (step.waitReason && !step.waitAfterPreviousSeconds) {
    throw new InputError("waitReason needs waitAfterPreviousSeconds");
  }
  const checks = step.checks ?? [];
  if (checks.some((check) => check.type === "exitCode")) {
    throw new InputError(
      "a step run outside Termix has no exit code: use contains, notContains, matches, notMatches or value checks on the pasted output",
    );
  }
  const problem = checksProblem(
    checks,
    step.captures.map((capture) => capture.name),
  );
  if (problem) throw new InputError(problem);
}

/**
 * A Make a secret or Ask for a secret step (1.4.2): a person's step that
 * runs no command. Only a person's click makes or saves its value.
 */
function checkSecretStepShape(
  step: Parameters<typeof checkStepShape>[0],
): void {
  if (step.generate && step.ask) {
    throw new InputError("a step has either generate or ask, not both");
  }
  const what = step.generate
    ? "a Make a secret step"
    : "an Ask for a secret step";
  if (step.owner === "agent") {
    throw new InputError(
      `${what} is for a person: an agent can never make, see or save a secret`,
    );
  }
  const extra: Array<[boolean, string]> = [
    [step.command !== null, "command"],
    [step.hostId !== null, "hostId"],
    [Boolean(step.where), "where"],
    [Boolean(step.stdin), "stdin"],
    [step.captures.length > 0, "captures"],
    [(step.secretCaptures ?? []).length > 0, "secretCaptures"],
    [(step.checks ?? []).length > 0, "checks"],
  ];
  const found = extra.find(([present]) => present);
  if (found) {
    throw new InputError(
      `${what} cannot have ${found[1]}: Termix runs no command for it`,
    );
  }
  if (step.waitReason && !step.waitAfterPreviousSeconds) {
    throw new InputError("waitReason needs waitAfterPreviousSeconds");
  }
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
