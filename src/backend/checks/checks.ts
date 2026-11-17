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

/** The end of the detail of a pattern the time limit stopped. */
const SLOW = "did not finish in time; make the pattern simpler";

/**
 * Why a check failed, where its words say more than that it failed: a
 * pattern the time limit stopped, or which part of a value check failed.
 */
export type CheckWhy = "slow" | "not-captured" | "equals" | "matches";

/** What a check's detail tells of the run: never its output. */
export interface DetailRun {
  /** Pasted output (a terminal, outside or agent run) or a command's. */
  terminal: boolean;
  exitCode: number | null;
}

/**
 * A check's detail: its own words, the stream and the exit code, never the
 * output. Built from these alone, so the agent view can build it again
 * from the step's check filled with the values agents see (BUG-011).
 */
export function checkDetail(
  check: Check,
  ok: boolean,
  run: DetailRun,
  why: CheckWhy | null = null,
): string {
  switch (check.type) {
    case "exitCode":
      if (run.exitCode === null) return "no exit code";
      return ok
        ? `exit code ${run.exitCode}`
        : `exit code ${run.exitCode}, expected ${check.equals}`;
    case "contains":
    case "notContains": {
      const where = streamName(check.stream ?? "any", run.terminal);
      const text = quote(check.text);
      if (check.type === "contains") {
        return ok
          ? `${where} contains ${text}`
          : `expected ${where} to contain ${text}`;
      }
      return ok
        ? `${where} does not contain ${text}`
        : `expected ${where} not to contain ${text}`;
    }
    case "matches":
    case "notMatches": {
      if (!ok && why === "slow") return `/${check.pattern}/ ${SLOW}`;
      const where = streamName(check.stream ?? "any", run.terminal);
      if (check.type === "matches") {
        return ok
          ? `${where} matches /${check.pattern}/`
          : `expected ${where} to match /${check.pattern}/`;
      }
      return ok
        ? `${where} does not match /${check.pattern}/`
        : `expected ${where} not to match /${check.pattern}/`;
    }
    case "value": {
      if (ok) return `value ${check.name} as expected`;
      if (why === "not-captured") return `value ${check.name} was not captured`;
      if (why === "equals" && check.equals !== undefined) {
        return `expected value ${check.name} to be ${quote(check.equals)}`;
      }
      if (why === "slow" && check.matches !== undefined) {
        return `/${check.matches}/ ${SLOW}`;
      }
      if (why === "matches" && check.matches !== undefined) {
        return `expected value ${check.name} to match /${check.matches}/`;
      }
      return `value ${check.name} not as expected`;
    }
  }
}

/**
 * Why a stored result failed, read from its detail, which checkDetail
 * wrote; null when the detail says no more than that it failed.
 */
export function checkWhy(check: Check, result: CheckResult): CheckWhy | null {
  if (result.ok || check.type === "exitCode") return null;
  if (result.detail.endsWith(` ${SLOW}`)) return "slow";
  if (check.type !== "value") return null;
  if (result.detail === `value ${check.name} was not captured`) {
    return "not-captured";
  }
  if (result.detail.startsWith(`expected value ${check.name} to be `)) {
    return "equals";
  }
  if (result.detail.startsWith(`expected value ${check.name} to match `)) {
    return "matches";
  }
  return null;
}

/**
 * Tests each check against a finished run's full output (before any hiding
 * from agents) and the values captured from it. The caller hides secrets
 * first (see checkHidden). Details never repeat the output: only the check's
 * own words and the exit code. `test` runs each pattern: a when rule gives
 * one with a shared time limit (BUG-008).
 */
export function evaluateChecks(
  checks: Check[],
  run: CheckedRun,
  captured: Values,
  test: (pattern: string, input: string) => boolean | null = testPattern,
): CheckResult[] {
  const shown: DetailRun = {
    terminal: run.mode === "terminal",
    exitCode: run.exitCode,
  };
  return checks.map((check) => {
    const result = (ok: boolean, why: CheckWhy | null = null): CheckResult => ({
      label: check.label ?? describeCheck(check),
      ok,
      detail: checkDetail(check, ok, shown, why),
    });
    switch (check.type) {
      case "exitCode":
        return result(run.exitCode !== null && run.exitCode === check.equals);
      case "contains":
      case "notContains": {
        const found = texts(run, check.stream ?? "any").some((text) =>
          text.includes(check.text),
        );
        return result(check.type === "contains" ? found : !found);
      }
      case "matches":
      case "notMatches": {
        let found = false;
        for (const text of texts(run, check.stream ?? "any")) {
          const hit = test(check.pattern, text);
          if (hit === null) return result(false, "slow");
          if (hit) {
            found = true;
            break;
          }
        }
        return result(check.type === "matches" ? found : !found);
      }
      case "value": {
        const value = captured[check.name];
        if (value === undefined) return result(false, "not-captured");
        if (check.equals !== undefined && value !== check.equals) {
          return result(false, "equals");
        }
        if (check.matches !== undefined) {
          const hit = test(check.matches, value);
          if (hit === null) return result(false, "slow");
          if (!hit) return result(false, "matches");
        }
        return result(true);
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
  /** Captures whose pattern did not finish in time, by name. */
  slowCaptures: string[];
}

/**
 * Judges a run's output in the one safe order: find the secrets the step
 * captures, hide them and the secrets already known (`hidden`), take the
 * captures from the output with them hidden, then test the checks on `checked` with every secret hidden
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
  // Captures read the output with its secrets hidden, as checks do
  // (BUG-011): a capture never takes part of a secret or of typed input.
  const captures =
    options.captures === false
      ? { values: {}, slow: [] }
      : applyCaptures(step.captures, redact(output, hide));
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
    slowCaptures: captures.slow,
  };
}
