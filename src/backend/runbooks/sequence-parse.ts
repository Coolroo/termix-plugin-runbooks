/**
 * A step's sequence and workdir as an author writes them (1.4.10): the
 * checks on each item, with errors that name the item ("sequence[2]: ...").
 * Phase 1 takes `run` and `delay` items; the plan's other types are refused
 * with a 400 that says they come later.
 */

import { InputError } from "../core/errors.js";
import { strictObject } from "../core/parse.js";
import { checksProblem, normalizeCheck, type Check } from "../checks/checks.js";
import { checkCaptures, type Capture } from "../values/values.js";
import { isOneLine } from "../../shared/names.js";
import {
  LATER_ITEM_TYPES,
  SEQUENCE_LIMITS,
  type DelayItemSpec,
  type RunItemSpec,
  type SequenceItem,
} from "../../shared/sequence.js";
import { sleepProblem } from "./no-sleep.js";

const RUN_FIELDS = [
  "type",
  "label",
  "command",
  "checks",
  "captures",
  "timeoutMs",
  "onFail",
  "interactive",
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

/** A short one-line text, or null when left out or empty. */
function shortText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new InputError(`${field} must be a string`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new InputError(`${field} is longer than ${max} characters`);
  }
  if (!isOneLine(text)) throw new InputError(`${field} must be one line`);
  return text === "" ? null : text;
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
  const command = raw.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new InputError(`${field}.command is required for a run item`);
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
  const interactive = raw.interactive ?? false;
  if (typeof interactive !== "boolean") {
    throw new InputError(`${field}.interactive must be true or false`);
  }
  const normalized = (checks as Check[]).map(normalizeCheck);
  if (
    interactive &&
    normalized.some((check) => "stream" in check && check.stream === "stderr")
  ) {
    throw new InputError(
      `${field}: an interactive item has one output stream: a check cannot read stream "stderr"; use "stdout" or "any"`,
    );
  }
  return {
    type: "run",
    label: shortText(raw.label, `${field}.label`, SEQUENCE_LIMITS.label),
    command,
    checks: normalized,
    captures: capturesOut,
    timeoutMs,
    onFail,
    interactive,
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
      case "delay":
        return parseDelayItem(item, field);
      default:
        if (
          (LATER_ITEM_TYPES as readonly string[]).includes(item.type as string)
        ) {
          throw new InputError(
            `${field}: the "${String(item.type)}" item comes in a later version of Runbooks; for now use "run" and "delay" items`,
            400,
            { code: "later-item" },
          );
        }
        throw new InputError(`${field}.type must be "run" or "delay"`);
    }
  });
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (item.type !== "run") continue;
    for (const capture of item.captures) {
      if (seen.has(capture.name)) {
        throw new InputError(
          `sequence[${index}]: capture "${capture.name}" is already captured by an earlier item; give each capture its own name`,
        );
      }
      seen.add(capture.name);
    }
  }
  if (!items.some((item) => item.type === "run")) {
    throw new InputError("sequence needs at least one run item");
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
    item.type === "run" ? item.captures : [],
  );
}
