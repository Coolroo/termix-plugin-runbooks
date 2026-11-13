/**
 * Names and the rules on them, in one place: what a value or secret name
 * looks like, what a {{name}} placeholder is, what a library secret is, and
 * the checks on a regular expression an author writes and on one-line text.
 * The server checks with these, the MCP schemas tell agents their sources,
 * and the UI reads them. No React and no Node here.
 */

import type { StdinSource } from "./api.js";

/** A value or secret name: what may sit between {{ and }}. */
export const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** {{name}} in a command or a step's text, with spaces allowed inside. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

/** A secret's name is a value name of at most this many characters. */
export const MAX_SECRET_NAME = 64;

/** A library secret: "mine/<name>" or "shared/<name>". */
export const LIBRARY_REF =
  /^(mine|shared)\/([A-Za-z0-9._-]{1,200}(?:\/[A-Za-z0-9._-]{1,200}){0,3})$/;

/** A secret name a step captures, reads, makes or asks for. */
export function secretNameProblem(name: unknown, field: string): string | null {
  if (typeof name !== "string" || !NAME.test(name)) {
    return `${field} must match ${NAME.source}`;
  }
  if (name.length > MAX_SECRET_NAME) {
    return `${field} is longer than ${MAX_SECRET_NAME} characters`;
  }
  return null;
}

/**
 * A regular expression an author writes (a capture, a check, an ask): text,
 * at most `max` characters, and one JavaScript can read. `empty` is what to
 * say when it is not text or is empty. Returns the problem, or null.
 */
export function regexProblem(
  pattern: unknown,
  field: string,
  max: number,
  empty = `${field} must be a regular expression`,
): string | null {
  if (typeof pattern !== "string" || pattern.length === 0) return empty;
  if (pattern.length > max) {
    return `${field} is longer than ${max} characters`;
  }
  try {
    new RegExp(pattern);
  } catch {
    return `${field} is not a valid regular expression`;
  }
  return null;
}

/** Whether the source is a secret, and its name as runs and audits say it. */
export function secretLabel(source: StdinSource | null): string | null {
  if (!source || source.from !== "secret") return null;
  return "name" in source ? source.name : source.library;
}

/** Whether a text is one line: no line breaks and no control characters. */
export function isOneLine(text: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(text);
}
