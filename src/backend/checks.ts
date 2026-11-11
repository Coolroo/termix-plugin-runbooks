/**
 * Checks on a step's output: what the author says the output must show, as
 * rules Runbooks tests when the run ends, instead of only words in "expect".
 * A run whose checks fail makes its step failed, even with exit code 0.
 *
 * Pure functions, shared by the routes, the agent side and the tests.
 */

import {
  MAX_CAPTURE_PATTERN,
  MAX_VALUE_LENGTH,
  testPattern,
  VALUE_NAME,
  type Values,
} from "./values.js";
import { redact, type SecretText } from "./redact.js";
import {
  describeCheck,
  quote,
  streamName,
  type Check,
  type CheckResult,
  type CheckStream,
} from "../shared/checks.js";

export {
  describeCheck,
  type Check,
  type CheckResult,
  type CheckStream,
} from "../shared/checks.js";

export const MAX_CHECKS = 20;
export const MAX_CHECK_TEXT = 2000;
export const MAX_CHECK_LABEL = 200;

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

function patternProblem(pattern: unknown, field: string): string | null {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return `${field} must be a regular expression`;
  }
  if (pattern.length > MAX_CAPTURE_PATTERN) {
    return `${field} is longer than ${MAX_CAPTURE_PATTERN} characters`;
  }
  try {
    new RegExp(pattern, "m");
  } catch {
    return `${field} is not a valid regular expression`;
  }
  return null;
}

/** Checks one check's shape. Returns what is wrong, or null. */
function checkProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "must be an object with a type";
  }
  const check = raw as Record<string, unknown>;
  if (!TYPES.includes(check.type as Check["type"])) {
    return `type must be one of ${TYPES.join(", ")}`;
  }
  const type = check.type as Check["type"];
  for (const key of Object.keys(check)) {
    if (!FIELDS[type].includes(key)) {
      return `unknown field "${key}" for type ${type}`;
    }
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
      return patternProblem(check.pattern, "pattern");
    case "value": {
      if (typeof check.name !== "string" || !VALUE_NAME.test(check.name)) {
        return `name must match ${VALUE_NAME.source}`;
      }
      if (
        check.equals !== undefined &&
        (typeof check.equals !== "string" ||
          check.equals.length > MAX_VALUE_LENGTH)
      ) {
        return `equals must be text of at most ${MAX_VALUE_LENGTH} characters`;
      }
      if (check.matches !== undefined) {
        return patternProblem(check.matches, "matches");
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
    Object.fromEntries(
      Object.entries(captured).map(([name, value]) => [
        name,
        redact(value, hide),
      ]),
    ),
  );
}
