/**
 * A run's error from its parts (BUG-014). The person reads it as stored;
 * agents read it built again, with only Termix's own words masked, since a
 * mask on a name the author wrote would show whether it equals a hidden
 * value.
 */

import type { RunErrorParts } from "../../shared/api.js";

/** Parts with nothing in them: a run that did not fail. */
export function noErrorParts(message: string | null = null): RunErrorParts {
  return {
    message,
    secretsMissing: [],
    secretNotStored: null,
    slowCaptures: [],
  };
}

/** Whether the parts say anything. */
export function hasError(parts: RunErrorParts): boolean {
  return Boolean(
    parts.message ||
    parts.secretsMissing.length ||
    parts.secretNotStored ||
    parts.slowCaptures.length,
  );
}

/** The error text, as runs have always stored it; null for none. */
export function errorText(parts: RunErrorParts): string | null {
  const text = [
    parts.message,
    ...parts.secretsMissing.map((name) => `secret ${name}: no match`),
    ...(parts.secretNotStored
      ? [
          `secret ${parts.secretNotStored.name}: could not be stored: ${parts.secretNotStored.why}`,
        ]
      : []),
    ...parts.slowCaptures.map((name) => `capture "${name}" did not finish`),
  ]
    .filter(Boolean)
    .join("; ");
  return text || null;
}
