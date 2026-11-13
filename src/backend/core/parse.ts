/**
 * Reading what a request sends: the small checks every route makes on a
 * body. Each caller keeps its own words.
 */

import { InputError } from "./errors.js";

/** A plain object: not null, not an array. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The first key of `raw` that is not one of `keys`, if any. */
export function unknownKey(
  raw: Record<string, unknown>,
  keys: readonly string[] | ReadonlySet<string>,
): string | undefined {
  const known = (key: string) =>
    Array.isArray(keys)
      ? keys.includes(key)
      : (keys as ReadonlySet<string>).has(key);
  return Object.keys(raw).find((key) => !known(key));
}

/**
 * `input` as an object with only `keys` (any keys when null), or a 400:
 * `notObject` when it is not an object, `unknown <field> field "key"` for
 * a key it may not have.
 */
export function strictObject(
  input: unknown,
  keys: readonly string[] | ReadonlySet<string> | null,
  what: { notObject: string; field?: string },
): Record<string, unknown> {
  if (!isObject(input)) throw new InputError(what.notObject);
  const key = keys ? unknownKey(input, keys) : undefined;
  if (key !== undefined) {
    throw new InputError(
      `unknown ${what.field ? `${what.field} ` : ""}field "${key}"`,
    );
  }
  return input;
}

/**
 * The words of a refusal. "person": the person routes' "<field> must be text
 * of at most <max>". "agent": the agent API's "<field> must be a string" and
 * "<field> is longer than <max> characters" (or "larger than <max> KB").
 */
export type Wording = "person" | "agent";

/**
 * Text a body may leave out: null when it is not there; refused when it is
 * not a string or is longer than `max` characters (`max` bytes with
 * `bytes`). `message` replaces the person wording's refusal.
 */
export function optionalText(
  value: unknown,
  field: string,
  max: number,
  options: { bytes?: boolean; wording?: Wording; message?: string } = {},
): string | null {
  if (value === undefined || value === null) return null;
  const size = (text: string) =>
    options.bytes ? Buffer.byteLength(text) : text.length;
  if (options.wording === "agent") {
    if (typeof value !== "string") {
      throw new InputError(`${field} must be a string`);
    }
    if (size(value) > max) {
      throw new InputError(
        options.bytes
          ? `${field} is larger than ${max / 1024} KB`
          : `${field} is longer than ${max} characters`,
      );
    }
    return value;
  }
  if (typeof value !== "string" || size(value) > max) {
    throw new InputError(
      options.message ??
        `${field} must be text of at most ${
          options.bytes ? `${max / 1024} KB` : `${max} characters`
        }`,
    );
  }
  return value;
}

/** How a person or an agent ends a step or a run: done or failed. */
export function parseOutcome(
  value: unknown,
  wording: Wording = "person",
): "done" | "failed" {
  if (value !== "done" && value !== "failed") {
    throw new InputError(
      wording === "agent"
        ? 'outcome must be "done" or "failed"'
        : "outcome must be done or failed",
    );
  }
  return value;
}
