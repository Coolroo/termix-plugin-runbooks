/**
 * 1.4.10, phase 2: a wait item and a run item with retry on the step card.
 * Before Run: the schedule ("Up to 120 attempts, every 30 s, at most 1 h")
 * and a wait's stopIf checks, also in the Run confirm. While it runs: a dot
 * per attempt (green passed, grey not yet, red failed, blue running),
 * "Attempt 7 of 120, 34 s of 1 h", a countdown to the next attempt with
 * Try now, and the last attempt's output; earlier attempts folded. An item
 * without a schedule looks as in phase 1.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  card,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type {
  ResolvedItem,
  RunAttempt,
  RunItem,
  SequenceItem,
  Step,
} from "../../src/frontend/api-types";

useRenderedApp();

const SEQUENCE: SequenceItem[] = [
  {
    type: "run",
    label: "Deploy",
    command: "sudo paseo-deploy up media enforcarr",
    checks: [],
    captures: [],
    timeoutMs: null,
    onFail: "stop",
    interactive: false,
    retry: {
      attempts: 4,
      within: null,
      retryOn: ["exit", "check", "timeout", "connect"],
      every: 2,
      backoff: "exponential",
      factor: 2,
      maxDelay: 300,
      jitter: "none",
    },
  },
  {
    type: "wait",
    label: "Mirror synced",
    command: "sudo setup-deptrack.sh status",
    checks: [{ type: "contains", text: "COMPLETED" }],
    stopIf: [{ type: "contains", text: "FAILED" }],
    captures: [],
    timeoutMs: 30_000,
    onFail: "stop",
    within: 3600,
    attempts: 120,
    every: 30,
    backoff: "fixed",
    factor: 2,
    maxDelay: 300,
    jitter: "none",
  },
  {
    type: "run",
    label: "Report",
    command: "sudo setup-deptrack.sh report",
    checks: [],
    captures: [],
    timeoutMs: null,
    onFail: "stop",
    interactive: false,
  },
];

const RESOLVED: ResolvedItem[] = SEQUENCE.map((spec, index) => ({
  ...spec,
  position: index + 1,
  later: [],
}));

function item(position: number, overrides: Partial<RunItem> = {}): RunItem {
  const spec = SEQUENCE[position - 1];
  return {
    id: 100 + position,
    runId: 21,
    position,
    type: spec.type,
    label: spec.label,
    command: spec.type === "run" || spec.type === "wait" ? spec.command : null,
    seconds: null,
    reason: null,
    onFail: "stop",
    status: "waiting",
    startedAt: null,
    finishedAt: null,
    plannedEndAt: null,
    exitCode: null,
    stdout: null,
    stderr: null,
    truncated: false,
    timedOut: false,
    error: null,
    checks: null,
    captured: {},
    skippedBy: null,
    fromRunId: null,
    maxAttempts: null,
    endsBy: null,
    nextAttemptAt: null,
    result: null,
    ...overrides,
  };
}

/** Attempt n, ended `ago` ms before now. */
function attempt(
  n: number,
  at: number,
  overrides: Partial<RunAttempt> = {},
): RunAttempt {
  return {
    id: 500 + n,
    itemId: 102,
    attempt: n,
    status: "failed",
    startedAt: new Date(at - 1000).toISOString(),
    finishedAt: new Date(at).toISOString(),
    exitCode: 0,
    stdout: `mirror osv: RUNNING (${n})\n`,
    stderr: null,
    truncated: false,
    timedOut: false,
    error: null,
    checks: [
      {
        label: "the output contains 'COMPLETED'",
        ok: false,
        detail: "not found",
      },
    ],
    stopIf: [
      { label: "the output contains 'FAILED'", ok: false, detail: "not found" },
    ],
    why: "check",
    result: null,
    ...overrides,
  };
}

function seqStep(overrides: Partial<Step> = {}): Step {
  return makeStep({
    id: 2,
    position: 1,
    title: "Wait for the OSV mirror",
    command: null,
    resolvedCommand: "# 1 Deploy\n...",
    commandHash: "c".repeat(64),
    sequence: SEQUENCE,
    resolvedSequence: RESOLVED,
    workdir: null,
    ...overrides,
  });
}

async function open(step: Step, post = vi.fn(async () => ({ data: {} }))) {
  const client = fakeApi({
    detail: () => makeRunbook([step], { title: "Mirror" }),
    post,
  });
  await openRunbook(client, {
    title: "Mirror",
    shows: () => screen.findAllByText(step.title),
  });
  return { client, el: card(step.id) };
}

const dots = (el: Element) =>
  [...el.querySelectorAll("[data-attempt-dot]")].map((dot) =>
    dot.getAttribute("data-dot"),
  );

/** A run whose wait (item 2) is at attempt `count`, waiting `left` ms. */
function waiting(count: number, left: number, extra: Partial<RunItem> = {}) {
  const now = Date.now();
  const started = now - 34_000;
  return seqStep({
    runs: [
      makeRun({
        id: 21,
        stepId: 2,
        status: "running",
        running: true,
        startedAt: new Date(now - 40_000).toISOString(),
        finishedAt: null,
        exitCode: null,
        elapsedMs: 40_000,
        items: [
          item(1, {
            status: "passed",
            startedAt: new Date(now - 40_000).toISOString(),
            finishedAt: new Date(started).toISOString(),
            exitCode: 0,
            maxAttempts: 4,
            attempts: [
              attempt(1, now - 38_000, {
                exitCode: 7,
                why: "exit",
                checks: null,
                stopIf: null,
              }),
              attempt(2, started, {
                status: "passed",
                why: null,
                checks: null,
                stopIf: null,
              }),
            ],
          }),
          item(2, {
            status: "running",
            startedAt: new Date(started).toISOString(),
            endsBy: new Date(started + 3_600_000).toISOString(),
            maxAttempts: 120,
            nextAttemptAt: left ? new Date(now + left).toISOString() : null,
            stdout: `mirror osv: RUNNING (${count})\n`,
            checks: [
              {
                label: "the output contains 'COMPLETED'",
                ok: false,
                detail: "not found",
              },
            ],
            attempts: Array.from({ length: count }, (_, index) =>
              attempt(index + 1, started + (index + 1) * 4000),
            ),
            ...extra,
          }),
          item(3),
        ],
      }),
    ],
  });
}

describe("a wait item and a retry on the step card", () => {
  it("shows each schedule and a wait's stopIf checks before Run; a plain item looks as before", async () => {
    const { el } = await open(seqStep());
    const schedules = [...el.querySelectorAll("[data-item-schedule]")].map(
      (line) => [
        line.closest("[data-item]")!.getAttribute("data-item"),
        line.textContent,
      ],
    );
    expect(schedules).toEqual([
      [
        "1",
        "Up to 4 attempts, 2 s apart, then ×2 each time up to 5 min, at most 8 min 14 s",
      ],
      ["2", "Up to 120 attempts, every 30 s, at most 1 h"],
    ]);
    const wait = el.querySelector('[data-item="2"]')!;
    expect(wait.getAttribute("data-item-type")).toBe("wait");
    expect(wait.textContent).toContain(locales.item.type.wait);
    expect(wait.textContent).toContain(locales.attempts.stopIfTitle);
    expect(wait.textContent).toContain("contains 'FAILED'");
    const plain = el.querySelector('[data-item="3"]')!;
    expect(plain.querySelector("[data-item-schedule]")).toBeNull();
    expect(plain.querySelector("[data-attempts]")).toBeNull();
    expect(el.querySelector("[data-attempt-dot]")).toBeNull();
  });

  it("shows the schedule in the Run confirm", async () => {
    const { el } = await open(seqStep());
    fireEvent.click(within(el).getByRole("button", { name: locales.step.run }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      dialog.querySelector('[data-confirm-schedule="2"]')!.textContent,
    ).toBe("Up to 120 attempts, every 30 s, at most 1 h");
    expect(dialog.querySelector('[data-confirm-schedule="3"]')).toBeNull();
  });

  it("while it waits: grey dots, the counter, a countdown, Try now, the last output", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    const { el } = await open(waiting(6, 12_000), post);
    const wait = el.querySelector('[data-item="2"]')!;
    expect(dots(wait)).toEqual(Array(6).fill("not-yet"));
    expect(wait.querySelector("[data-attempt-counter]")!.textContent).toBe(
      "Attempt 6 of 120, 34 s of 1 h",
    );
    expect(wait.querySelector("[data-attempt-countdown]")!.textContent).toMatch(
      /Next attempt in 0:1[12]/,
    );
    expect(wait.querySelector("[data-attempt-output]")!.textContent).toBe(
      "Output of attempt 6, the last one",
    );
    expect(wait.querySelector("[data-item-live]")!.textContent).toContain(
      "mirror osv: RUNNING (6)",
    );
    // The last attempt's check results show between two attempts.
    const itemChecks = [...wait.querySelectorAll("[data-checks]")].find(
      (list) => !list.closest("[data-stop-if], [data-attempts-earlier]"),
    )!;
    expect(
      itemChecks
        .querySelector("[data-check-state]")!
        .getAttribute("data-check-state"),
    ).toBe("failed");
    // The retried run item that passed: a red failed attempt, then green.
    expect(dots(el.querySelector('[data-item="1"]')!)).toEqual([
      "failed",
      "passed",
    ]);
    fireEvent.click(wait.querySelector("[data-try-now]")!);
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/steps/2/try-now"),
    );
  });

  it("folds earlier attempts; each opens to its output and checks", async () => {
    const { el } = await open(waiting(3, 5000));
    const wait = el.querySelector('[data-item="2"]')!;
    const folded = wait.querySelector("[data-attempts-earlier]")!;
    expect(folded.hasAttribute("open")).toBe(false);
    expect(folded.querySelector("summary")!.textContent).toBe(
      "Earlier attempts (2)",
    );
    const listed = [...folded.querySelectorAll("[data-attempt]")].map((li) =>
      li.getAttribute("data-attempt"),
    );
    expect(listed).toEqual(["2", "1"]);
    const first = folded.querySelector('[data-attempt="1"]')!;
    expect(first.textContent).toContain("Attempt 1");
    expect(first.textContent).toContain(locales.attempts.why.check);
    expect(first.textContent).toContain("mirror osv: RUNNING (1)");
    expect(
      first
        .querySelector("[data-check-state]")!
        .getAttribute("data-check-state"),
    ).toBe("failed");
  });

  it("shows a running attempt as a blue dot, with no countdown", async () => {
    const now = Date.now();
    const { el } = await open(
      waiting(7, 0, {
        stdout: "mirror osv: RUN",
        attempts: [
          ...Array.from({ length: 6 }, (_, index) =>
            attempt(index + 1, now - 30_000 + index * 4000),
          ),
          attempt(7, now, {
            status: "running",
            finishedAt: null,
            why: null,
            stdout: null,
            checks: null,
            stopIf: null,
          }),
        ],
      }),
    );
    const wait = el.querySelector('[data-item="2"]')!;
    expect(dots(wait)).toEqual([...Array(6).fill("not-yet"), "running"]);
    expect(wait.querySelector("[data-attempt-countdown]")).toBeNull();
    expect(wait.querySelector("[data-attempt-output]")!.textContent).toBe(
      "Attempt 7 runs",
    );
  });

  it("after a stopIf match: a red last dot and why, in the earlier attempts too", async () => {
    const now = Date.now();
    const step = seqStep({
      runs: [
        makeRun({
          id: 21,
          stepId: 2,
          status: "failed",
          running: false,
          error:
            "item 2 failed: a stopIf check matched: the output contains 'FAILED'",
          items: [
            item(1, {
              status: "passed",
              startedAt: new Date(now - 60_000).toISOString(),
              finishedAt: new Date(now - 50_000).toISOString(),
              exitCode: 0,
              maxAttempts: 4,
              attempts: [
                attempt(1, now - 50_000, { status: "passed", why: null }),
              ],
            }),
            item(2, {
              status: "failed",
              startedAt: new Date(now - 50_000).toISOString(),
              finishedAt: new Date(now - 10_000).toISOString(),
              endsBy: new Date(now + 3_550_000).toISOString(),
              maxAttempts: 120,
              exitCode: 0,
              stdout: "mirror osv: FAILED\n",
              error: "a stopIf check matched: the output contains 'FAILED'",
              attempts: [
                attempt(1, now - 45_000),
                attempt(2, now - 30_000),
                attempt(3, now - 10_000, {
                  why: "stop-if",
                  stdout: "mirror osv: FAILED\n",
                  stopIf: [
                    {
                      label: "the output contains 'FAILED'",
                      ok: true,
                      detail: "found",
                    },
                  ],
                }),
              ],
            }),
            item(3),
          ],
        }),
      ],
    });
    const { el } = await open(step);
    const wait = el.querySelector('[data-item="2"]')!;
    expect(wait.getAttribute("data-item-status")).toBe("failed");
    expect(dots(wait)).toEqual(["not-yet", "not-yet", "failed"]);
    expect(wait.querySelector("[data-attempt-counter]")!.textContent).toBe(
      "Attempt 3 of 120, 40 s of 1 h",
    );
    expect(wait.querySelector("[data-attempt-countdown]")).toBeNull();
    expect(wait.querySelector("[data-try-now]")).toBeNull();
    expect(wait.querySelector("[data-item-error]")!.textContent).toContain(
      "a stopIf check matched",
    );
    expect(
      wait.querySelector("[data-attempts-earlier] summary")!.textContent,
    ).toBe("Earlier attempts (2)");
  });

  it("an earlier run's summary counts each item's attempts", async () => {
    const now = Date.now();
    const old = makeRun({
      id: 20,
      stepId: 2,
      status: "failed",
      running: false,
      items: [
        item(1, {
          status: "passed",
          exitCode: 0,
          maxAttempts: 4,
          attempts: [attempt(1, now, { status: "passed", why: null })],
        }),
        item(2, {
          status: "failed",
          exitCode: 0,
          maxAttempts: 120,
          attempts: [attempt(1, now), attempt(2, now)],
        }),
        item(3),
      ],
    });
    const latest = makeRun({
      id: 21,
      stepId: 2,
      status: "running",
      running: true,
      finishedAt: null,
      items: [item(1), item(2), item(3)],
    });
    const { el } = await open(seqStep({ runs: [latest, old] }));
    fireEvent.click(
      within(el).getByRole("button", { name: "Earlier runs (1)" }),
    );
    const counts = [
      ...el.querySelectorAll("[data-item-summary] [data-item-attempts]"),
    ].map((span) => span.textContent);
    expect(counts).toEqual(["· 1 attempt", "· 2 attempts"]);
  });
});
