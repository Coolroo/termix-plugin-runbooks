/**
 * The rules of attempts (1.4.10, phase 2), apart from the runner so they
 * are tested alone: why an attempt did not pass, whether another follows,
 * when, and the words of an item that ran out of attempts or time.
 *
 * A wait item polls: an attempt that does not pass means "not yet", and
 * the next follows on the schedule, whatever the reason, unless a stopIf
 * check matched. A run item with retry retries only the failures its
 * `retryOn` names. A person's Stop and a Termix or Runbooks stop end the
 * item at once in both.
 */

import {
  backoffDelay,
  secondsWords,
  type RetryOn,
  type Schedule,
} from "../../shared/schedule.js";
import type { AttemptWhy, CommandItemSpec } from "../../shared/sequence.js";

/** How one attempt ended, as its record and the schedule read it. */
export interface AttemptFacts {
  /** A person stopped the run. */
  stopped: boolean;
  /** Termix or Runbooks stopped. */
  interrupted: boolean;
  /** No connection, or an error before the command ran to an end. */
  connectFailed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  /** Every check of the item passed (true when it has none). */
  checksPassed: boolean;
  /** A stopIf check of a wait item matched. */
  stopMatched: boolean;
}

/**
 * Why an attempt did not pass, or null when it passed. A stop comes first,
 * then a stopIf match (it wins over checks that pass: the job failed),
 * then the attempt's own end.
 */
export function attemptWhy(facts: AttemptFacts): AttemptWhy | null {
  if (facts.interrupted) return "interrupted";
  if (facts.stopped) return "stopped";
  if (facts.connectFailed) return "connect";
  if (facts.stopMatched) return "stop-if";
  if (facts.timedOut) return "timeout";
  if (facts.exitCode !== 0) return "exit";
  if (!facts.checksPassed) return "check";
  return null;
}

/** Whether a failed attempt may have another after it. */
export function mayRetry(item: CommandItemSpec, why: AttemptWhy): boolean {
  if (why === "stopped" || why === "interrupted" || why === "stop-if") {
    return false;
  }
  if (item.type === "wait") return true;
  return (item.retry?.retryOn ?? []).includes(why as RetryOn);
}

/** Milliseconds to wait after attempt `n`, jitter applied. */
export function delayAfter(
  schedule: Schedule,
  n: number,
  random: () => number = Math.random,
): number {
  return Math.round(backoffDelay(schedule, n, random) * 1000);
}

/**
 * The time limit of one attempt: its own, or the time left of the item's
 * limit when that is shorter, so a slow attempt cannot take the item past
 * it (the owner's 2 hours). At least one second.
 */
export function attemptTimeout(
  timeoutMs: number,
  endsAt: number,
  at: number,
): number {
  return Math.max(1000, Math.min(timeoutMs, endsAt - at));
}

/** The words of an item that made its last attempt without a pass. */
export function exhaustedText(
  kind: CommandItemSpec["type"],
  attempts: number,
  reason: "attempts" | "time",
  withinSeconds: number,
): string {
  const made = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  const what = kind === "wait" ? "the checks did not pass" : "it did not pass";
  return reason === "attempts"
    ? `${what} in ${made}, the most this item makes`
    : `${what} within ${secondsWords(withinSeconds)} (${made})`;
}

/** Why an item stopped at once on a stopIf match. */
export function stopIfText(label: string): string {
  return `a stopIf check matched: ${label}`;
}
