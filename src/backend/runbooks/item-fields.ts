/**
 * Field readers that every sequence item shares (1.4.10): short texts,
 * whole numbers and the attempt schedule (phase 2), with errors that name
 * the field as the author wrote it ("sequence[2].every").
 */

import { InputError } from "../core/errors.js";
import { isOneLine } from "../../shared/names.js";
import {
  BACKOFFS,
  JITTERS,
  SCHEDULE_LIMITS,
  type Backoff,
  type Jitter,
  type Schedule,
} from "../../shared/schedule.js";

export const SCHEDULE_FIELDS = [
  "every",
  "backoff",
  "factor",
  "maxDelay",
  "jitter",
];

/** A short one-line text, or null when left out or empty. */
export function shortText(
  value: unknown,
  field: string,
  max: number,
): string | null {
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

/** An integer from min to max, or null when left out or null. */
export function wholeNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new InputError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

/**
 * The delays between attempts (phase 2): every (default 5 s), backoff
 * (default fixed), factor (exponential only, default 2), maxDelay (default
 * 300 s, or every when that is longer) and jitter (default none).
 */
export function parseSchedule(
  raw: Record<string, unknown>,
  field: string,
): Schedule {
  const every =
    wholeNumber(
      raw.every,
      `${field}.every`,
      SCHEDULE_LIMITS.everyMin,
      SCHEDULE_LIMITS.everyMax,
    ) ?? SCHEDULE_LIMITS.every;
  const backoff = (raw.backoff ?? "fixed") as Backoff;
  if (!BACKOFFS.includes(backoff)) {
    throw new InputError(
      `${field}.backoff must be "fixed", "linear" or "exponential"`,
    );
  }
  let factor: number = SCHEDULE_LIMITS.factor;
  if (raw.factor !== undefined && raw.factor !== null) {
    if (backoff !== "exponential") {
      throw new InputError(
        `${field}.factor is for backoff "exponential" only; leave it out`,
      );
    }
    if (
      typeof raw.factor !== "number" ||
      !Number.isFinite(raw.factor) ||
      raw.factor < SCHEDULE_LIMITS.factorMin ||
      raw.factor > SCHEDULE_LIMITS.factorMax
    ) {
      throw new InputError(
        `${field}.factor must be a number from ${SCHEDULE_LIMITS.factorMin} to ${SCHEDULE_LIMITS.factorMax}`,
      );
    }
    factor = raw.factor;
  }
  const maxDelay =
    wholeNumber(
      raw.maxDelay,
      `${field}.maxDelay`,
      SCHEDULE_LIMITS.everyMin,
      SCHEDULE_LIMITS.maxDelayMax,
    ) ?? Math.max(SCHEDULE_LIMITS.maxDelay, every);
  if (maxDelay < every) {
    throw new InputError(
      `${field}.maxDelay (${maxDelay}) must be at least every (${every})`,
    );
  }
  const jitter = (raw.jitter ?? "none") as Jitter;
  if (!JITTERS.includes(jitter)) {
    throw new InputError(`${field}.jitter must be "none", "full" or "equal"`);
  }
  return { every, backoff, factor, maxDelay, jitter };
}
