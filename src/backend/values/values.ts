/**
 * Values, placeholders, captures and the command hash. Pure functions, so the
 * routes, the MCP tools and the tests all share one definition.
 */

import crypto from "node:crypto";
import vm from "node:vm";
import { fillPlain, type FilledText } from "../../shared/fill.js";
import { NAME, PLACEHOLDER, regexProblem } from "../../shared/names.js";

const MAX_VALUES = 200;
export const MAX_VALUE_LENGTH = 4096;
const MAX_CAPTURES = 20;
export const MAX_CAPTURE_PATTERN = 300;
/** Captures only look at this much output, and stop after this long. */
const CAPTURE_INPUT_LIMIT = 256 * 1024;
const CAPTURE_TIME_LIMIT_MS = 250;

export type Values = Record<string, string>;

export interface Capture {
  name: string;
  pattern: string;
}

/** Every distinct {{name}} in a text, in order of first use. */
export function placeholders(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * The text with every known {{name}} replaced, literally, and the names it
 * uses that have no value.
 */
export type Resolved = FilledText;

/**
 * Replaces {{name}} with its value as plain text. No escaping and no
 * evaluation: what the person sees is exactly what runs. The same filler
 * as a step's `where` (src/shared/fill.ts), with no marker: a name with no
 * value stays as written.
 */
export function resolve(text: string, values: Values): Resolved {
  return fillPlain(text, values);
}

/**
 * sha256 of the host id and the resolved command, the run's identity, and
 * of the standard input's source when the step has one (1.2.0). A step with
 * no input hashes as it did before.
 */
export function commandHash(
  hostId: number,
  command: string,
  stdinKey: string | null = null,
): string {
  return crypto
    .createHash("sha256")
    .update(
      stdinKey === null
        ? `${hostId}\n${command}`
        : `${hostId}\n${command}\n\0stdin ${stdinKey}`,
      "utf8",
    )
    .digest("hex");
}

/** Checks author values. Returns an error message, or null. */
export function checkValues(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "values must be an object of name to string";
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_VALUES) {
    return `values may have at most ${MAX_VALUES} names`;
  }
  for (const [name, value] of entries) {
    if (!NAME.test(name)) {
      return `value name "${name}" must match ${NAME.source}`;
    }
    if (typeof value !== "string") {
      return `value "${name}" must be a string`;
    }
    if (value.length > MAX_VALUE_LENGTH) {
      return `value "${name}" is longer than ${MAX_VALUE_LENGTH} characters`;
    }
  }
  return null;
}

/** Checks capture rules. Returns an error message, or null. */
export function checkCaptures(input: unknown): string | null {
  if (!Array.isArray(input)) return "captures must be an array";
  if (input.length > MAX_CAPTURES) {
    return `a step may have at most ${MAX_CAPTURES} captures`;
  }
  for (const entry of input) {
    if (!entry || typeof entry !== "object") {
      return "each capture must be { name, pattern }";
    }
    const { name, pattern } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name)) {
      return `capture name must match ${NAME.source}`;
    }
    const problem = regexProblem(
      pattern,
      `capture "${name}" pattern`,
      MAX_CAPTURE_PATTERN,
      `capture "${name}" needs a pattern`,
    );
    if (problem) return problem;
    const compiled = new RegExp(pattern as string);
    // One capturing group, by counting what an empty match attempt reports.
    const groups = new RegExp(`${compiled.source}|`).exec("")!.length - 1;
    if (groups !== 1) {
      return `capture "${name}" pattern must have exactly one capturing group`;
    }
  }
  return null;
}

/**
 * Applies capture rules to output: the first match's group, per rule. Runs in
 * a separate context with a time limit, so a pattern that backtracks forever
 * stops instead of holding the server.
 */
export function applyCaptures(
  captures: Capture[],
  output: string | null | undefined,
): { values: Values; errors: string[] } {
  const values: Values = {};
  const errors: string[] = [];
  if (!output || captures.length === 0) return { values, errors };
  const input = output.slice(0, CAPTURE_INPUT_LIMIT);
  const sandbox = vm.createContext({ input, pattern: "" });
  for (const capture of captures) {
    sandbox.pattern = capture.pattern;
    try {
      const found = vm.runInContext(
        "(() => { const m = new RegExp(pattern, 'm').exec(input); return m && m[1] != null ? String(m[1]) : null; })()",
        sandbox,
        { timeout: CAPTURE_TIME_LIMIT_MS },
      ) as string | null;
      if (found !== null) {
        values[capture.name] = found.slice(0, MAX_VALUE_LENGTH);
      }
    } catch {
      errors.push(`capture "${capture.name}" did not finish`);
    }
  }
  return { values, errors };
}

/**
 * Applies secret capture rules to output (1.2.0): like applyCaptures, but
 * an empty match counts as no match, so a later step never gets an empty
 * secret, and a value is never cut short.
 */
export function findSecrets(
  captures: Capture[],
  output: string | null | undefined,
): { values: Values; missing: string[] } {
  const values: Values = {};
  const missing: string[] = [];
  const input = (output ?? "").slice(0, CAPTURE_INPUT_LIMIT);
  const sandbox = vm.createContext({ input, pattern: "" });
  for (const capture of captures) {
    sandbox.pattern = capture.pattern;
    let found: string | null = null;
    try {
      found = vm.runInContext(
        "(() => { const m = new RegExp(pattern, 'm').exec(input); return m && m[1] != null ? String(m[1]) : null; })()",
        sandbox,
        { timeout: CAPTURE_TIME_LIMIT_MS },
      ) as string | null;
    } catch {
      found = null;
    }
    if (found) values[capture.name] = found;
    else missing.push(capture.name);
  }
  return { values, missing };
}

/**
 * Whether a pattern (JavaScript, multiline) matches somewhere in the text.
 * Null when it did not finish within the captures' time limit: it runs in a
 * separate context, so a pattern that backtracks forever stops instead of
 * holding the server.
 */
export function testPattern(
  pattern: string,
  input: string,
  timeLimitMs = CAPTURE_TIME_LIMIT_MS,
): boolean | null {
  const sandbox = vm.createContext({
    input: input.slice(0, CAPTURE_INPUT_LIMIT),
    pattern,
  });
  try {
    return vm.runInContext("new RegExp(pattern, 'm').test(input)", sandbox, {
      timeout: timeLimitMs,
    }) as boolean;
  } catch {
    return null;
  }
}

/**
 * Whether a pattern (JavaScript) matches the whole text, as an Ask for a
 * secret step checks a value (1.4.2). Null when it did not finish within
 * the captures' time limit: it runs in a separate context.
 */
export function matchesWhole(
  pattern: string,
  input: string,
  timeLimitMs = CAPTURE_TIME_LIMIT_MS,
): boolean | null {
  const sandbox = vm.createContext({ input, pattern });
  try {
    return vm.runInContext(
      "new RegExp('^(?:' + pattern + ')$').test(input)",
      sandbox,
      { timeout: timeLimitMs },
    ) as boolean;
  } catch {
    return null;
  }
}

/** JSON text to an object, or a fallback for anything malformed. */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
