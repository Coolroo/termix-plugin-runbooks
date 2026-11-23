/**
 * The attempt schedule (1.4.10, phase 2 of the sequences plan): how long a
 * wait item, or a run item with retry, waits between two attempts. The
 * delay after attempt n (1-based) is, before the cap and the jitter:
 *
 * - fixed: every
 * - linear: every × n
 * - exponential: every × factor^(n−1)
 *
 * Each delay is capped at maxDelay. Jitter comes after the cap: "full" is a
 * random time from 0 to the delay, "equal" half the delay plus a random
 * time up to the other half (the AWS names). Jitter only makes a delay
 * shorter, so the plan without it is the longest the schedule can take.
 *
 * Top limits per item (the owner, 2026-11-23): 500 attempts and 2 hours in
 * all, attempts and delays together.
 *
 * Shared by the server and the UI. No React and no Node here.
 */

export type Backoff = "fixed" | "linear" | "exponential";
export type Jitter = "none" | "full" | "equal";

/**
 * Which failures of a run item get another attempt: a non-zero exit code,
 * a check that failed after exit 0, a timeout, or no connection to the
 * host (or an error before the command ran).
 */
export type RetryOn = "exit" | "check" | "timeout" | "connect";

export const BACKOFFS: readonly Backoff[] = ["fixed", "linear", "exponential"];
export const JITTERS: readonly Jitter[] = ["none", "full", "equal"];
export const RETRY_ON: readonly RetryOn[] = [
  "exit",
  "check",
  "timeout",
  "connect",
];

/** The limits and defaults of a schedule, in one place. */
export const SCHEDULE_LIMITS = {
  /** Most attempts of one item (the owner). */
  attempts: 500,
  /** Fewest attempts of a run item's retry: one try and one more. */
  retryAttemptsMin: 2,
  /** Most seconds one item may take, all attempts and delays (the owner). */
  within: 7200,
  everyMin: 1,
  everyMax: 3600,
  /** The first delay when the author gives none. */
  every: 5,
  factorMin: 1.1,
  factorMax: 10,
  factor: 2,
  /** The cap on one delay when the author gives none. */
  maxDelay: 300,
  maxDelayMax: 3600,
} as const;

/** How the delays between attempts grow. Every field filled in. */
export interface Schedule {
  /** Seconds: the first delay, and the step for linear. */
  every: number;
  backoff: Backoff;
  /** Exponential only: how much each delay grows. */
  factor: number;
  /** Seconds: the longest one delay may get. */
  maxDelay: number;
  jitter: Jitter;
}

/** Seconds to wait after attempt `n` (1-based), capped, before jitter. */
export function baseDelay(schedule: Schedule, n: number): number {
  const step = Math.max(1, Math.floor(n));
  const raw =
    schedule.backoff === "linear"
      ? schedule.every * step
      : schedule.backoff === "exponential"
        ? schedule.every * Math.pow(schedule.factor, step - 1)
        : schedule.every;
  return Math.min(raw, schedule.maxDelay);
}

/**
 * Seconds to wait after attempt `n` (1-based): the capped delay, then the
 * jitter. `random` gives a number from 0 up to 1 (Math.random), so a test
 * can fix it.
 */
export function backoffDelay(
  schedule: Schedule,
  n: number,
  random: () => number = Math.random,
): number {
  const delay = baseDelay(schedule, n);
  switch (schedule.jitter) {
    case "full":
      return delay * random();
    case "equal":
      return delay / 2 + (delay / 2) * random();
    default:
      return delay;
  }
}

/** What a schedule plans, before a run: the most attempts and time. */
export interface SchedulePlan {
  /** The most attempts: the author's, or the top limit. */
  attempts: number;
  /** The first delay, in seconds. */
  every: number;
  backoff: Backoff;
  jitter: Jitter;
  /**
   * The most seconds the item may take: its `within`, or less when the
   * attempts, their time limits and the delays (without jitter) end first.
   */
  maxSeconds: number;
}

/**
 * The plan of an item's attempts: at most `attempts` (500 when left out),
 * at most `within` seconds (2 hours when left out), each attempt at most
 * `timeoutMs`.
 */
export function planSchedule(
  schedule: Schedule,
  attempts: number | null,
  within: number | null,
  timeoutMs: number,
): SchedulePlan {
  const most = Math.min(
    attempts ?? SCHEDULE_LIMITS.attempts,
    SCHEDULE_LIMITS.attempts,
  );
  const limit = Math.min(
    within ?? SCHEDULE_LIMITS.within,
    SCHEDULE_LIMITS.within,
  );
  let total = (most * timeoutMs) / 1000;
  for (let n = 1; n < most && total < limit; n++) {
    total += baseDelay(schedule, n);
  }
  return {
    attempts: most,
    every: schedule.every,
    backoff: schedule.backoff,
    jitter: schedule.jitter,
    maxSeconds: Math.ceil(Math.min(total, limit)),
  };
}

/** "30 s", "2 min 5 s", "1 h 5 min": a time in words. */
export function secondsWords(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (rest || parts.length === 0) parts.push(`${rest} s`);
  return parts.join(" ");
}

/**
 * The plan in English, as the run's text and agents read it: "up to 120
 * attempts, every 30 s, at most 1 h". The page says it with its own
 * words (locales/en.json).
 */
export function scheduleWords(schedule: Schedule, plan: SchedulePlan): string {
  const first = secondsWords(schedule.every);
  const cap = secondsWords(schedule.maxDelay);
  const delays =
    schedule.backoff === "linear"
      ? `${first} apart, then ${first} longer each time up to ${cap}`
      : schedule.backoff === "exponential"
        ? `${first} apart, then ×${schedule.factor} each time up to ${cap}`
        : `every ${first}`;
  const jitter =
    schedule.jitter === "none" ? "" : ` (${schedule.jitter} jitter)`;
  return `up to ${plan.attempts} attempts, ${delays}${jitter}, at most ${secondsWords(plan.maxSeconds)}`;
}
