/**
 * Checks on a step's output, as the server stores them and the Termix UI
 * shows them. The server tests them (src/backend/checks/checks.ts); this file holds
 * the shapes and the words, which both sides use.
 */

import { fillPlain, uniqueNames, type TextValues } from "./fill.js";

export type CheckStream = "stdout" | "stderr" | "any";

export type Check =
  | { type: "exitCode"; equals: number; label?: string }
  | {
      type: "contains" | "notContains";
      text: string;
      stream?: CheckStream;
      label?: string;
    }
  | {
      type: "matches" | "notMatches";
      pattern: string;
      stream?: CheckStream;
      label?: string;
    }
  | {
      type: "value";
      name: string;
      equals?: string;
      matches?: string;
      label?: string;
    };

export interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

/** Text for a detail: quoted and cut short. */
export function quote(text: string): string {
  const short = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `'${short.replace(/\n/g, "\\n")}'`;
}

export function streamName(stream: CheckStream, terminal: boolean): string {
  if (terminal) return "the pasted output";
  return stream === "any" ? "the output" : stream;
}

/** What a check tests, in a few words, for a check without a label. */
export function describeCheck(check: Check): string {
  const where = streamName(
    "stream" in check ? (check.stream ?? "any") : "any",
    false,
  );
  switch (check.type) {
    case "exitCode":
      return `exit code is ${check.equals}`;
    case "contains":
      return `${where} contains ${quote(check.text)}`;
    case "notContains":
      return `${where} does not contain ${quote(check.text)}`;
    case "matches":
      return `${where} matches /${check.pattern}/`;
    case "notMatches":
      return `${where} does not match /${check.pattern}/`;
    case "value":
      if (check.equals !== undefined) {
        return `value ${check.name} is ${quote(check.equals)}`;
      }
      if (check.matches !== undefined) {
        return `value ${check.name} matches /${check.matches}/`;
      }
      return `value ${check.name} is captured`;
  }
}

/** A value as literal text in a regular expression (BUG-007). */
export function escapePattern(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** A step's checks with their values filled in. */
export interface FilledChecks {
  checks: Check[];
  /** Names the checks use that have no value, in order of first use. */
  missing: string[];
}

/**
 * Fills {{name}} in checks with the values the command gets (BUG-007): as
 * plain text in `contains` and `notContains` text and a value check's
 * `equals`, and as escaped literal text in a pattern (`matches`,
 * `notMatches`, a value check's `matches`), so a value with a dot matches
 * only a dot. A name with no value stays as written and is in `missing`: a
 * step whose checks miss a value cannot run, as with its command.
 */
export function fillChecks(
  checks: readonly Check[],
  values: TextValues,
): FilledChecks {
  const missing: string[][] = [];
  const escaped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, escapePattern(value)]),
  );
  const plain = (text: string) => {
    const filled = fillPlain(text, values);
    missing.push(filled.missing);
    return filled.text;
  };
  const pattern = (text: string) => {
    const filled = fillPlain(text, escaped);
    missing.push(filled.missing);
    return filled.text;
  };
  const filled = checks.map((check): Check => {
    switch (check.type) {
      case "exitCode":
        return check;
      case "contains":
      case "notContains":
        return { ...check, text: plain(check.text) };
      case "matches":
      case "notMatches":
        return { ...check, pattern: pattern(check.pattern) };
      case "value":
        return {
          ...check,
          ...(check.equals !== undefined
            ? { equals: plain(check.equals) }
            : {}),
          ...(check.matches !== undefined
            ? { matches: pattern(check.matches) }
            : {}),
        };
    }
  });
  return { checks: filled, missing: uniqueNames(...missing) };
}
