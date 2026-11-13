/**
 * Checks on a step's output: what the author says the output must show, as
 * rules Runbooks tests when the run ends, instead of only words in "expect".
 * A run whose checks fail makes its step failed, even with exit code 0.
 *
 * Pure functions, shared by the routes, the agent side and the tests.
 */

import {
  applyCaptures,
  findSecrets,
  MAX_CAPTURE_PATTERN,
  MAX_VALUE_LENGTH,
  testPattern,
  type Capture,
  type Values,
} from "../values/values.js";
import { NAME, regexProblem } from "../../shared/names.js";
import { redact, type SecretText } from "../running/redact.js";
import { isObject, unknownKey } from "../core/parse.js";
import {
  describeCheck,
  quote,
  streamName,
  type Check,
  type CheckResult,
  type CheckStream,
} from "../../shared/checks.js";

export type { Check, CheckResult } from "../../shared/checks.js";

const MAX_CHECKS = 20;
const MAX_CHECK_TEXT = 2000;
const MAX_CHECK_LABEL = 200;

const TYPES = [
  "exitCode",
  "contains",
  "notContains",
  "matches",
  "notMatches",
  "value",
] as const;
const STREAMS: CheckStream[] = ["stdout", "stderr", "any"];
const FIELDS: Record<Check["type"], string[]> = {
  exitCode: ["type", "equals", "label"],
  contains: ["type", "text", "stream", "label"],
  notContains: ["type", "text", "stream", "label"],
  matches: ["type", "pattern", "stream", "label"],
  notMatches: ["type", "pattern", "stream", "label"],
  value: ["type", "name", "equals", "matches", "label"],
};

/** Checks one check's shape. Returns what is wrong, or null. */
function checkProblem(raw: unknown): string | null {
  if (!isObject(raw)) return "must be an object with a type";
  const check = raw;
  if (!TYPES.includes(check.type as Check["type"])) {
    return `type must be one of ${TYPES.join(", ")}`;
  }
  const type = check.type as Check["type"];
  const unknown = unknownKey(check, FIELDS[type]);
  if (unknown !== undefined) {
    return `unknown field "${unknown}" for type ${type}`;
  }
  if (
    check.label !== undefined &&
    (typeof check.label !== "string" ||
      check.label.length > MAX_CHECK_LABEL ||
      check.label.trim() === "")
  ) {
    return `label must be text of 1 to ${MAX_CHECK_LABEL} characters`;
  }
  if (
    check.stream !== undefined &&
    !STREAMS.includes(check.stream as CheckStream)
  ) {
    return `stream must be one of ${STREAMS.join(", ")}`;
  }
  switch (type) {
    case "exitCode":
      return Number.isInteger(check.equals)
        ? null
        : "equals must be an integer exit code";
    case "contains":
    case "notContains":
      return typeof check.text === "string" &&
        check.text.length > 0 &&
        check.text.length <= MAX_CHECK_TEXT
        ? null
        : `text must be text of 1 to ${MAX_CHECK_TEXT} characters`;
    case "matches":
    case "notMatches":
      return regexProblem(check.pattern, "pattern", MAX_CAPTURE_PATTERN);
    case "value": {
      if (typeof check.name !== "string" || !NAME.test(check.name)) {
        return `name must match ${NAME.source}`;
      }
      if (
        check.equals !== undefined &&
        (typeof check.equals !== "string" ||
          check.equals.length > MAX_VALUE_LENGTH)
      ) {
        return `equals must be text of at most ${MAX_VALUE_LENGTH} characters`;
      }
      if (check.matches !== undefined) {
        return regexProblem(check.matches, "matches", MAX_CAPTURE_PATTERN);
      }
      return null;
    }
  }
}

/**
 * Checks a step's checks. `captureNames` are the step's captures: a value
 * check must name one of them. Returns what is wrong, naming the check, or
 * null.
 */
export function checksProblem(
  input: unknown,
  captureNames?: string[],
): string | null {
  if (!Array.isArray(input)) return "checks must be an array";
  if (input.length > MAX_CHECKS) {
    return `a step may have at most ${MAX_CHECKS} checks`;
  }
  for (const [index, raw] of input.entries()) {
    const problem = checkProblem(raw);
    if (problem) return `checks[${index}]: ${problem}`;
    const check = raw as Check;
    if (
      check.type === "value" &&
      captureNames &&
      !captureNames.includes(check.name)
    ) {
      return `checks[${index}]: "${check.name}" is not a capture of this step`;
    }
  }
  return null;
}

/** A check with only its own fields, in a fixed order. */
export function normalizeCheck(check: Check): Check {
  const label = check.label?.trim() ? { label: check.label.trim() } : {};
  switch (check.type) {
    case "exitCode":
      return { type: check.type, equals: check.equals, ...label };
    case "contains":
    case "notContains":
      return {
        type: check.type,
        text: check.text,
        stream: check.stream ?? "any",
        ...label,
      };
    case "matches":
    case "notMatches":
      return {
        type: check.type,
        pattern: check.pattern,
        stream: check.stream ?? "any",
        ...label,
      };
    case "value":
      return {
        type: check.type,
        name: check.name,
        ...(check.equals !== undefined ? { equals: check.equals } : {}),
        ...(check.matches !== undefined ? { matches: check.matches } : {}),
        ...label,
      };
  }
}

/** What a run left to check. */
export interface CheckedRun {
  mode: "exec" | "terminal";
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  pastedOutput: string | null;
}

/** The texts a stream selection reads: the pasted output for a terminal run. */
function texts(run: CheckedRun, stream: CheckStream): string[] {
  if (run.mode === "terminal") return [run.pastedOutput ?? ""];
  if (stream === "stdout") return [run.stdout ?? ""];
  if (stream === "stderr") return [run.stderr ?? ""];
  return [run.stdout ?? "", run.stderr ?? ""];
}

/**
 * Tests each check against a finished run's full output (before any hiding
 * from agents) and the values captured from it. The caller hides secrets
 * first (see checkHidden). Details never repeat the output: only the check's
 * own words and the exit code.
 */
export function evaluateChecks(
  checks: Check[],
  run: CheckedRun,
  captured: Values,
): CheckResult[] {
  return checks.map((check) => {
    const label = check.label ?? describeCheck(check);
    const result = (ok: boolean, detail: string): CheckResult => ({
      label,
      ok,
      detail,
    });
    const terminal = run.mode === "terminal";
    switch (check.type) {
      case "exitCode": {
        if (run.exitCode === null) return result(false, "no exit code");
        return run.exitCode === check.equals
          ? result(true, `exit code ${run.exitCode}`)
          : result(
              false,
              `exit code ${run.exitCode}, expected ${check.equals}`,
            );
      }
      case "contains":
      case "notContains": {
        const stream = check.stream ?? "any";
        const where = streamName(stream, terminal);
        const found = texts(run, stream).some((text) =>
          text.includes(check.text),
        );
        if (check.type === "contains") {
          return found
            ? result(true, `${where} contains ${quote(check.text)}`)
            : result(
                false,
                `expected ${where} to contain ${quote(check.text)}`,
              );
        }
        return found
          ? result(
              false,
              `expected ${where} not to contain ${quote(check.text)}`,
            )
          : result(true, `${where} does not contain ${quote(check.text)}`);
      }
      case "matches":
      case "notMatches": {
        const stream = check.stream ?? "any";
        const where = streamName(stream, terminal);
        let found = false;
        for (const text of texts(run, stream)) {
          const hit = testPattern(check.pattern, text);
          if (hit === null) {
            return result(
              false,
              `/${check.pattern}/ did not finish in time; make the pattern simpler`,
            );
          }
          if (hit) {
            found = true;
            break;
          }
        }
        if (check.type === "matches") {
          return found
            ? result(true, `${where} matches /${check.pattern}/`)
            : result(false, `expected ${where} to match /${check.pattern}/`);
        }
        return found
          ? result(false, `expected ${where} not to match /${check.pattern}/`)
          : result(true, `${where} does not match /${check.pattern}/`);
      }
      case "value": {
        const value = captured[check.name];
        if (value === undefined) {
          return result(false, `value ${check.name} was not captured`);
        }
        if (check.equals !== undefined && value !== check.equals) {
          return result(
            false,
            `expected value ${check.name} to be ${quote(check.equals)}`,
          );
        }
        if (check.matches !== undefined) {
          const hit = testPattern(check.matches, value);
          if (hit === null) {
            return result(
              false,
              `/${check.matches}/ did not finish in time; make the pattern simpler`,
            );
          }
          if (!hit) {
            return result(
              false,
              `expected value ${check.name} to match /${check.matches}/`,
            );
          }
        }
        return result(true, `value ${check.name} as expected`);
      }
    }
  });
}

/**
 * Tests the checks against the output with its secrets hidden (1.4.1): the
 * same text Runbooks keeps and shows. A check for "[secret:api_token]" then
 * passes, and a check that names part of a secret's real value can never
 * pass or fail on that value, so an author learns nothing about it.
 * Captured values are hidden the same way.
 */
export function checkHidden(
  checks: Check[],
  run: CheckedRun,
  captured: Values,
  hide: SecretText[],
): CheckResult[] {
  return evaluateChecks(
    checks,
    {
      ...run,
      stdout: redact(run.stdout, hide),
      stderr: redact(run.stderr, hide),
      pastedOutput: redact(run.pastedOutput, hide),
    },
    hideValues(captured, hide),
  );
}

/** Values with every secret in `hide` replaced. */
function hideValues(values: Values, hide: SecretText[]): Values {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, redact(value, hide)]),
  );
}

/** What judgeOutput makes of a run's output. */
export interface Judgement {
  /** Done only when the outcome was done and every check passed. */
  final: "done" | "failed";
  /** The checks' results; null when they were not tested. */
  results: CheckResult[] | null;
  /** Every secret to replace in what the run keeps. */
  hide: SecretText[];
  /** The secrets the step's secretCaptures found, and the ones not found. */
  found: { values: Values; missing: string[] };
  /** The step's captures with secrets hidden; {} unless final is done. */
  captured: Values;
  /** Why captures did not match. */
  captureErrors: string[];
}

/**
 * Judges a run's output in the one safe order: find the secrets the step
 * captures, hide them and the secrets already known (`hidden`), take the
 * captures, then test the checks on `checked` with every secret hidden
 * (1.4.1: checks never see a secret). Checks are not tested when `checked`
 * is null or the step has none. Without `captures`, no capture is taken
 * and value checks see none (an agent's step).
 */
export function judgeOutput(
  step: {
    checks: Check[];
    captures: Capture[];
    secretCaptures: Capture[];
  },
  outcome: "done" | "failed",
  checked: CheckedRun | null,
  output: string | null,
  hidden: SecretText[],
  options: { captures?: boolean } = {},
): Judgement {
  const found = findSecrets(step.secretCaptures, output);
  const hide: SecretText[] = [
    ...hidden,
    ...Object.entries(found.values).map(([name, value]) => ({ name, value })),
  ];
  const captures =
    options.captures === false
      ? { values: {}, errors: [] }
      : applyCaptures(step.captures, output);
  const results =
    checked && step.checks.length > 0
      ? checkHidden(step.checks, checked, captures.values, hide)
      : null;
  const final =
    outcome === "done" && (results ?? []).every((check) => check.ok)
      ? "done"
      : "failed";
  return {
    final,
    results,
    hide,
    found,
    captured: final === "done" ? hideValues(captures.values, hide) : {},
    captureErrors: captures.errors,
  };
}
