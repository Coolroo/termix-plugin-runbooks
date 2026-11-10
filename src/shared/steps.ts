/**
 * Step numbers with amendments (1.4.0). A step keeps the number it was given
 * (`position`). An amendment shares its parent's number and gets a letter
 * (`suffix`): 3a, 3b, in the order they were made under step 3. Later steps
 * never renumber. The order of a runbook is (position, suffix): the step
 * without a suffix first, then a, b, ... z, aa, ab.
 *
 * Shared by the server and the UI.
 */

export interface StepNumber {
  position: number;
  suffix?: string | null;
}

/** "3" for step 3, "3a" for its first amendment. */
export function stepLabel(step: StepNumber): string {
  return `${step.position}${step.suffix ?? ""}`;
}

/**
 * How views and stdin name a step: its position as a number when it has no
 * suffix (as before 1.4.0), its label as text when it is an amendment.
 */
export function stepRef(step: StepNumber): number | string {
  return step.suffix ? stepLabel(step) : step.position;
}

/** The suffix of the n-th amendment (0-based) under one position. */
export function suffixAt(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** The 0-based index of a suffix, the inverse of suffixAt; -1 for none. */
export function suffixIndex(suffix: string | null | undefined): number {
  if (!suffix) return -1;
  let n = 0;
  for (const char of suffix) n = n * 26 + (char.charCodeAt(0) - 96);
  return n - 1;
}

/** Negative when a comes before b in the runbook's order. */
export function compareSteps(a: StepNumber, b: StepNumber): number {
  if (a.position !== b.position) return a.position - b.position;
  return suffixIndex(a.suffix) - suffixIndex(b.suffix);
}

/** Whether a comes before b in the runbook's order. */
export function isBefore(a: StepNumber, b: StepNumber): boolean {
  return compareSteps(a, b) < 0;
}

/** A step reference as an author writes it: 3, "3" or "3a". Null if not one. */
export function parseStepRef(
  ref: unknown,
): { position: number; suffix: string | null } | null {
  if (typeof ref === "number") {
    return Number.isInteger(ref) && ref >= 1
      ? { position: ref, suffix: null }
      : null;
  }
  if (typeof ref !== "string") return null;
  const match = /^([1-9][0-9]{0,5})([a-z]{1,3})?$/.exec(ref);
  if (!match) return null;
  return { position: Number(match[1]), suffix: match[2] ?? null };
}
