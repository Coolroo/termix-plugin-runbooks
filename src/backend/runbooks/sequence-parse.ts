/**
 * A step's sequence and workdir as an author writes them (1.4.10): the
 * checks on each item, with errors that name the item ("sequence[2]: ...").
 * Phase 1 takes `run` and `delay` items; phase 2 adds the `wait` item and
 * `retry` on a run item, with their schedule (src/shared/schedule.ts).
 * Phase 3 adds the wait events built in (event-parse.ts).
 */

import { InputError } from "../core/errors.js";
import { strictObject } from "../core/parse.js";
import { checksProblem, normalizeCheck, type Check } from "../checks/checks.js";
import { checkCaptures, type Capture } from "../values/values.js";
import { isOneLine } from "../../shared/names.js";
import {
  isCommandItem,
  SEQUENCE_LIMITS,
  type DelayItemSpec,
  type OnFail,
  type RetrySpec,
  type RunItemSpec,
  type SequenceItem,
  type WaitItemSpec,
} from "../../shared/sequence.js";
import {
  RETRY_ON,
  SCHEDULE_LIMITS,
  type RetryOn,
} from "../../shared/schedule.js";
import { isEventType } from "../../shared/events.js";
import { sleepProblem } from "./no-sleep.js";
import {
  parseSchedule,
  SCHEDULE_FIELDS,
  shortText,
  wholeNumber,
} from "./item-fields.js";
import { parseEventItem } from "./event-parse.js";
const RUN_FIELDS = [
  "type",
  "label",
  "command",
  "checks",
  "captures",
  "timeoutMs",
  "onFail",
  "interactive",
  "retry",
];
const RETRY_FIELDS = ["attempts", "within", "retryOn", ...SCHEDULE_FIELDS];
const WAIT_FIELDS = [
  "type",
  "label",
  "command",
  "checks",
  "stopIf",
  "captures",
  "timeoutMs",
  "onFail",
  "within",
  "attempts",
  ...SCHEDULE_FIELDS,
];
const DELAY_FIELDS = ["type", "label", "seconds", "reason"];

export interface SequenceRules {
  /** Refuse a command that waits a fixed time (no-sleep.ts). */
  banSleep: boolean;
  /** The longest command, and the time limits of one, as for a step. */
  commandMax: number;
  timeoutMin: number;
  timeoutMax: number;
}

/** What a run item and a wait item share: the command and its output. */
interface CommandParts {
  command: string;
  checks: Check[];
  captures: Array<{ name: string; pattern: string }>;
  timeoutMs: number | null;
  onFail: OnFail;
}

function parseCommandParts(
  raw: Record<string, unknown>,
  field: string,
  rules: SequenceRules,
  kind: "run" | "wait",
): CommandParts {
  const command = raw.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new InputError(`${field}.command is required for a ${kind} item`);
  }
  if (command.length > rules.commandMax) {
    throw new InputError(
      `${field}.command is longer than ${rules.commandMax} characters`,
    );
  }
  if (command.includes("\0")) {
    throw new InputError(`${field}.command must not contain NUL characters`);
  }
  if (rules.banSleep) {
    const problem = sleepProblem(command, `${field}.command`);
    if (problem) throw new InputError(problem, 400, { code: "sleep" });
  }
  const captures = raw.captures ?? [];
  const captureProblem = checkCaptures(captures);
  if (captureProblem) throw new InputError(`${field}: ${captureProblem}`);
  const capturesOut = (captures as Capture[]).map(({ name, pattern }) => ({
    name,
    pattern,
  }));
  const checks = raw.checks ?? [];
  const checkProblem = checksProblem(
    checks,
    capturesOut.map((capture) => capture.name),
  );
  if (checkProblem) {
    throw new InputError(
      `${field}: ${checkProblem.replace("of this step", "of this item")}`,
    );
  }
  let timeoutMs: number | null = null;
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    const timeout = raw.timeoutMs;
    if (
      !Number.isInteger(timeout) ||
      (timeout as number) < rules.timeoutMin ||
      (timeout as number) > rules.timeoutMax
    ) {
      throw new InputError(
        `${field}.timeoutMs must be an integer from ${rules.timeoutMin} to ${rules.timeoutMax}`,
      );
    }
    timeoutMs = timeout as number;
  }
  const onFail = raw.onFail ?? "stop";
  if (onFail !== "stop" && onFail !== "continue") {
    throw new InputError(`${field}.onFail must be "stop" or "continue"`);
  }
  return {
    command,
    checks: (checks as Check[]).map(normalizeCheck),
    captures: capturesOut,
    timeoutMs,
    onFail,
  };
}

/** A run item's retry (phase 2): attempts are required, 2 to 500. */
function parseRetry(value: unknown, field: string): RetrySpec | null {
  if (value === undefined || value === null) return null;
  const raw = strictObject(value, RETRY_FIELDS, {
    notObject: `${field} must be an object, such as {"attempts":5,"backoff":"exponential","every":2}`,
    field,
  });
  if (raw.attempts === undefined || raw.attempts === null) {
    throw new InputError(
      `${field}.attempts is required: the most attempts, ${SCHEDULE_LIMITS.retryAttemptsMin} to ${SCHEDULE_LIMITS.attempts}`,
    );
  }
  const attempts = wholeNumber(
    raw.attempts,
    `${field}.attempts`,
    SCHEDULE_LIMITS.retryAttemptsMin,
    SCHEDULE_LIMITS.attempts,
  )!;
  const within = wholeNumber(
    raw.within,
    `${field}.within`,
    1,
    SCHEDULE_LIMITS.within,
  );
  let retryOn: RetryOn[] = [...RETRY_ON];
  if (raw.retryOn !== undefined && raw.retryOn !== null) {
    if (
      !Array.isArray(raw.retryOn) ||
      raw.retryOn.length === 0 ||
      raw.retryOn.some((each) => !RETRY_ON.includes(each as RetryOn))
    ) {
      throw new InputError(
        `${field}.retryOn must be a list of one or more of "exit", "check", "timeout" and "connect"`,
      );
    }
    // In a fixed order, each once.
    retryOn = RETRY_ON.filter((each) =>
      (raw.retryOn as unknown[]).includes(each),
    );
  }
  return { attempts, within, retryOn, ...parseSchedule(raw, field) };
}

function parseRunItem(
  raw: Record<string, unknown>,
  field: string,
  rules: SequenceRules,
): RunItemSpec {
  strictObject(raw, RUN_FIELDS, {
    notObject: `${field} must be an object`,
    field: `${field}`,
  });
  const parts = parseCommandParts(raw, field, rules, "run");
  const interactive = raw.interactive ?? false;
  if (typeof interactive !== "boolean") {
    throw new InputError(`${field}.interactive must be true or false`);
  }
  if (
    interactive &&
    parts.checks.some((check) => "stream" in check && check.stream === "stderr")
  ) {
    throw new InputError(
      `${field}: an interactive item has one output stream: a check cannot read stream "stderr"; use "stdout" or "any"`,
    );
  }
  const retry = parseRetry(raw.retry, `${field}.retry`);
  if (retry && interactive) {
    throw new InputError(
      `${field}: an interactive item cannot have retry: Runbooks cannot type into it again for you`,
    );
  }
  return {
    type: "run",
    label: shortText(raw.label, `${field}.label`, SEQUENCE_LIMITS.label),
    ...parts,
    interactive,
    retry,
  };
}

/**
 * A wait item (phase 2): a command and at least one check, run until the
 * checks pass, within a time limit (required, up to 2 hours).
 */
function parseWaitItem(
  raw: Record<string, unknown>,
  field: string,
  rules: SequenceRules,
): WaitItemSpec {
  strictObject(raw, WAIT_FIELDS, {
    notObject: `${field} must be an object`,
    field: `${field}`,
  });
  const parts = parseCommandParts(raw, field, rules, "wait");
  if (parts.checks.length === 0) {
    throw new InputError(
      `${field}.checks needs at least one check: what the output looks like when the wait is over, such as {"type":"contains","text":"healthy"}`,
    );
  }
  const stopIf = raw.stopIf ?? [];
  // No captures: a stopIf check reads the attempt's output, and an attempt
  // that does not pass captures nothing.
  const stopProblem = checksProblem(stopIf, []);
  if (stopProblem) {
    throw new InputError(
      `${field}.stopIf: ${stopProblem.replace(/is not a capture of this step/, "cannot be read: stopIf reads output only")}`,
    );
  }
  if (raw.within === undefined || raw.within === null) {
    throw new InputError(
      `${field}.within is required: the most seconds the wait may take, 1 to ${SCHEDULE_LIMITS.within}`,
    );
  }
  const within = wholeNumber(
    raw.within,
    `${field}.within`,
    1,
    SCHEDULE_LIMITS.within,
  )!;
  const attempts = wholeNumber(
    raw.attempts,
    `${field}.attempts`,
    1,
    SCHEDULE_LIMITS.attempts,
  );
  return {
    type: "wait",
    label: shortText(raw.label, `${field}.label`, SEQUENCE_LIMITS.label),
    ...parts,
    stopIf: (stopIf as Check[]).map(normalizeCheck),
    within,
    attempts,
    ...parseSchedule(raw, field),
  };
}

function parseDelayItem(
  raw: Record<string, unknown>,
  field: string,
): DelayItemSpec {
  strictObject(raw, DELAY_FIELDS, {
    notObject: `${field} must be an object`,
    field: `${field}`,
  });
  const seconds = raw.seconds;
  if (
    !Number.isInteger(seconds) ||
    (seconds as number) < SEQUENCE_LIMITS.delayMin ||
    (seconds as number) > SEQUENCE_LIMITS.delayMax
  ) {
    throw new InputError(
      `${field}.seconds must be an integer from ${SEQUENCE_LIMITS.delayMin} to ${SEQUENCE_LIMITS.delayMax}`,
    );
  }
  return {
    type: "delay",
    label: shortText(raw.label, `${field}.label`, SEQUENCE_LIMITS.label),
    seconds: seconds as number,
    reason: shortText(raw.reason, `${field}.reason`, SEQUENCE_LIMITS.reason),
  };
}

/**
 * A sequence as an author writes it: null when left out or null; a list of
 * 1 to 20 items otherwise. Capture names are unique across the items, so
 * {{name}} in a later item names one item.
 */
export function parseSequence(
  value: unknown,
  rules: SequenceRules,
): SequenceItem[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new InputError("sequence must be a list of items");
  }
  if (value.length === 0) {
    throw new InputError(
      "sequence must have at least one item; leave it out for a step with no command",
    );
  }
  if (value.length > SEQUENCE_LIMITS.items) {
    throw new InputError(
      `sequence may have at most ${SEQUENCE_LIMITS.items} items`,
    );
  }
  const items = value.map((raw, index): SequenceItem => {
    const field = `sequence[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InputError(`${field} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    switch (item.type) {
      case "run":
        return parseRunItem(item, field, rules);
      case "wait":
        return parseWaitItem(item, field, rules);
      case "delay":
        return parseDelayItem(item, field);
      default:
        if (typeof item.type === "string" && isEventType(item.type)) {
          return parseEventItem(item, field, rules);
        }
        throw new InputError(
          `${field}.type must be "run", "wait", "delay", "port", "http", "file", "container", "unit", "log" or "job"`,
        );
    }
  });
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!isCommandItem(item)) continue;
    for (const capture of item.captures) {
      if (seen.has(capture.name)) {
        throw new InputError(
          `sequence[${index}]: capture "${capture.name}" is already captured by an earlier item; give each capture its own name`,
        );
      }
      seen.add(capture.name);
    }
  }
  if (items.every((item) => item.type === "delay")) {
    throw new InputError(
      "sequence needs at least one item that is not a delay: a run, a wait or an event",
    );
  }
  return items;
}

/**
 * The folder every run item (or the step's one command) starts in: an
 * absolute path on the host, one line, up to 500 characters. Null when
 * left out or empty.
 */
export function parseWorkdir(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new InputError("workdir must be a string");
  }
  const dir = value.trim();
  if (dir === "") return null;
  if (dir.length > SEQUENCE_LIMITS.workdir) {
    throw new InputError(
      `workdir is longer than ${SEQUENCE_LIMITS.workdir} characters`,
    );
  }
  if (!isOneLine(dir) || dir.includes("\0")) {
    throw new InputError("workdir must be one line");
  }
  // Quoted as it is when it runs, so "~" would not be the home folder.
  if (!dir.startsWith("/")) {
    throw new InputError(
      'workdir must be an absolute path on the host, such as "/srv/app"',
    );
  }
  return dir;
}

/** Captures of a whole sequence, for the step-level checks on names. */
export function sequenceCaptures(sequence: SequenceItem[] | null): Capture[] {
  return (sequence ?? []).flatMap((item) =>
    isCommandItem(item) ? item.captures : [],
  );
}
