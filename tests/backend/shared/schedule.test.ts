/**
 * 1.4.10, phase 2: the attempt schedule. The backoff calculator is a pure
 * function: the delay after attempt n for each backoff, the cap, the
 * jitter after the cap, and the plan the page and agents read before Run.
 * The rules of attempts (attempts.ts) are tested here too.
 */
import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  baseDelay,
  planSchedule,
  scheduleWords,
  secondsWords,
  type Schedule,
} from "../../../src/shared/schedule";
import {
  attemptTimeout,
  attemptWhy,
  delayAfter,
  exhaustedText,
  mayRetry,
} from "../../../src/backend/running/attempts";
import type { CommandItemSpec } from "../../../src/shared/sequence";

const schedule = (extra: Partial<Schedule> = {}): Schedule => ({
  every: 10,
  backoff: "fixed",
  factor: 2,
  maxDelay: 300,
  jitter: "none",
  ...extra,
});

const delays = (s: Schedule, count: number) =>
  Array.from({ length: count }, (_, index) => baseDelay(s, index + 1));

describe("the delay after attempt n", () => {
  it("fixed: every, each time", () => {
    expect(delays(schedule(), 5)).toEqual([10, 10, 10, 10, 10]);
  });

  it("linear: every × n", () => {
    expect(delays(schedule({ backoff: "linear" }), 5)).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });

  it("exponential: every × factor^(n−1)", () => {
    expect(delays(schedule({ backoff: "exponential" }), 5)).toEqual([
      10, 20, 40, 80, 160,
    ]);
    expect(
      delays(schedule({ backoff: "exponential", every: 2, factor: 1.5 }), 4),
    ).toEqual([2, 3, 4.5, 6.75]);
  });

  it("is capped at maxDelay in every mode", () => {
    expect(
      delays(schedule({ backoff: "exponential", maxDelay: 60 }), 6),
    ).toEqual([10, 20, 40, 60, 60, 60]);
    expect(delays(schedule({ backoff: "linear", maxDelay: 25 }), 4)).toEqual([
      10, 20, 25, 25,
    ]);
    expect(delays(schedule({ every: 30, maxDelay: 30 }), 2)).toEqual([30, 30]);
  });

  it("takes attempt 1 for anything below it", () => {
    expect(baseDelay(schedule({ backoff: "linear" }), 0)).toBe(10);
    expect(baseDelay(schedule({ backoff: "exponential" }), -3)).toBe(10);
  });
});

describe("jitter, after the cap", () => {
  const capped = schedule({
    backoff: "exponential",
    maxDelay: 30,
  });

  it("none: the delay as it is", () => {
    expect(backoffDelay(capped, 3, () => 0.5)).toBe(30);
  });

  it("full: a random time from 0 to the delay", () => {
    const full = { ...capped, jitter: "full" as const };
    expect(backoffDelay(full, 3, () => 0)).toBe(0);
    expect(backoffDelay(full, 3, () => 0.5)).toBe(15);
    expect(backoffDelay(full, 3, () => 0.999)).toBeCloseTo(29.97);
    // Attempt 1: 10 s before the cap, so at most 10.
    expect(backoffDelay(full, 1, () => 0.5)).toBe(5);
  });

  it("equal: half the delay plus a random time up to the other half", () => {
    const equal = { ...capped, jitter: "equal" as const };
    expect(backoffDelay(equal, 3, () => 0)).toBe(15);
    expect(backoffDelay(equal, 3, () => 0.5)).toBe(22.5);
    expect(backoffDelay(equal, 3, () => 1)).toBe(30);
  });

  it("never makes a delay longer than the cap", () => {
    for (const jitter of ["none", "full", "equal"] as const) {
      for (let n = 1; n < 30; n++) {
        const d = backoffDelay({ ...capped, jitter }, n, () => 0.9999);
        expect(d).toBeLessThanOrEqual(30);
      }
    }
  });

  it("is in milliseconds for the runner, rounded", () => {
    expect(delayAfter(schedule({ every: 3 }), 1)).toBe(3000);
    expect(
      delayAfter(schedule({ every: 3, jitter: "full" }), 1, () => 0.3333),
    ).toBe(1000);
  });
});

describe("the plan before Run", () => {
  it("up to 120 attempts every 30 s within an hour: the hour ends first", () => {
    const plan = planSchedule(schedule({ every: 30 }), 120, 3600, 30_000);
    expect(plan).toMatchObject({ attempts: 120, maxSeconds: 3600 });
    expect(scheduleWords(schedule({ every: 30 }), plan)).toBe(
      "up to 120 attempts, every 30 s, at most 1 h",
    );
  });

  it("few attempts end before the time limit: attempts, delays and time limits added up", () => {
    // 3 attempts of at most 10 s, with delays of 5 and 10 s between them.
    const plan = planSchedule(
      schedule({ every: 5, backoff: "linear" }),
      3,
      600,
      10_000,
    );
    expect(plan).toMatchObject({ attempts: 3, maxSeconds: 45 });
  });

  it("leaves out: 500 attempts and 2 hours, the owner's top limits", () => {
    const plan = planSchedule(schedule({ every: 1 }), null, null, 1000);
    expect(plan.attempts).toBe(500);
    expect(plan.maxSeconds).toBe(999);
    const long = planSchedule(schedule({ every: 60 }), null, null, 120_000);
    expect(long).toMatchObject({ attempts: 500, maxSeconds: 7200 });
    expect(planSchedule(schedule(), 9000, 99_999, 1000)).toMatchObject({
      attempts: 500,
    });
  });

  it("says backoff and jitter in words", () => {
    const exp = schedule({ backoff: "exponential", every: 2, jitter: "full" });
    expect(scheduleWords(exp, planSchedule(exp, 5, 600, 60_000))).toBe(
      "up to 5 attempts, 2 s apart, then ×2 each time up to 5 min (full jitter), at most 5 min 30 s",
    );
    const lin = schedule({ backoff: "linear", every: 10, maxDelay: 60 });
    expect(scheduleWords(lin, planSchedule(lin, 3, 120, 5000))).toBe(
      "up to 3 attempts, 10 s apart, then 10 s longer each time up to 1 min, at most 45 s",
    );
  });

  it("writes times in words", () => {
    expect([0, 45, 60, 90, 3600, 3900, 7200].map(secondsWords)).toEqual([
      "0 s",
      "45 s",
      "1 min",
      "1 min 30 s",
      "1 h",
      "1 h 5 min",
      "2 h",
    ]);
  });
});

describe("the rules of attempts", () => {
  const facts = {
    stopped: false,
    interrupted: false,
    connectFailed: false,
    timedOut: false,
    exitCode: 0,
    checksPassed: true,
    stopMatched: false,
  };

  it("says why an attempt did not pass, a stop first and a stopIf before the checks", () => {
    expect(attemptWhy(facts)).toBeNull();
    expect(attemptWhy({ ...facts, checksPassed: false })).toBe("check");
    expect(attemptWhy({ ...facts, exitCode: 3 })).toBe("exit");
    expect(attemptWhy({ ...facts, exitCode: null })).toBe("exit");
    expect(attemptWhy({ ...facts, timedOut: true, exitCode: null })).toBe(
      "timeout",
    );
    expect(attemptWhy({ ...facts, connectFailed: true })).toBe("connect");
    expect(attemptWhy({ ...facts, stopMatched: true })).toBe("stop-if");
    expect(attemptWhy({ ...facts, stopped: true, stopMatched: true })).toBe(
      "stopped",
    );
    expect(attemptWhy({ ...facts, interrupted: true, stopped: true })).toBe(
      "interrupted",
    );
  });

  const wait = { type: "wait" } as CommandItemSpec;
  const retry = (retryOn: string[]) =>
    ({ type: "run", retry: { retryOn } }) as unknown as CommandItemSpec;

  it("a wait polls on every failure; a stop or a stopIf match ends it", () => {
    for (const why of ["exit", "check", "timeout", "connect"] as const) {
      expect(mayRetry(wait, why)).toBe(true);
    }
    for (const why of ["stop-if", "stopped", "interrupted"] as const) {
      expect(mayRetry(wait, why)).toBe(false);
    }
  });

  it("a retry tries again only on the failures retryOn names", () => {
    expect(mayRetry(retry(["exit", "timeout"]), "exit")).toBe(true);
    expect(mayRetry(retry(["exit", "timeout"]), "check")).toBe(false);
    expect(mayRetry(retry(["connect"]), "connect")).toBe(true);
    expect(mayRetry(retry(["exit"]), "stopped")).toBe(false);
  });

  it("cuts an attempt's time limit to the item's time left, at least 1 s", () => {
    expect(attemptTimeout(60_000, 100_000, 10_000)).toBe(60_000);
    expect(attemptTimeout(60_000, 100_000, 70_000)).toBe(30_000);
    expect(attemptTimeout(60_000, 100_000, 99_900)).toBe(1000);
  });

  it("says why an item ran out", () => {
    expect(exhaustedText("wait", 3, "attempts", 600)).toBe(
      "the checks did not pass in 3 attempts, the most this item makes",
    );
    expect(exhaustedText("run", 1, "time", 90)).toBe(
      "it did not pass within 1 min 30 s (1 attempt)",
    );
  });
});
