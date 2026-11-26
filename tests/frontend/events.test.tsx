/**
 * 1.4.10, phase 3: the wait events on the step card. Each event item shows
 * its icon, what it checks exactly (the fixed command it reads, or "TCP
 * 127.0.0.1:8443 on home-server, through the SSH connection"), the attempt
 * dots of phase 2, and the state its last check read, in words. The Run
 * confirm shows what each checks too.
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
import { eventWhat, type EventItemSpec } from "../../src/shared/events";

useRenderedApp();

const SCHEDULE = {
  onFail: "stop" as const,
  attempts: null,
  timeoutMs: null,
  every: 5,
  backoff: "fixed" as const,
  factor: 2,
  maxDelay: 300,
  jitter: "none" as const,
};

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
  },
  {
    type: "container",
    label: "Enforcarr healthy",
    name: "enforcarr",
    state: "healthy",
    within: 180,
    ...SCHEDULE,
  },
  {
    type: "unit",
    label: null,
    name: "enforcarr-migrate.service",
    state: "finished",
    within: 600,
    ...SCHEDULE,
  },
  {
    type: "http",
    label: "Health answers",
    url: "https://127.0.0.1:8443/health",
    status: 200,
    contains: "ok",
    servername: "enforcarr.coolroo.dev",
    within: 60,
    ...SCHEDULE,
  },
  {
    type: "port",
    label: "Postgres listens",
    port: 5432,
    state: "open",
    host: "127.0.0.1",
    within: 60,
    ...SCHEDULE,
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
    runId: 31,
    position,
    type: spec.type,
    label: spec.label,
    command:
      spec.type === "run"
        ? spec.command
        : spec.type === "wait" || spec.type === "delay"
          ? null
          : eventWhat(spec as EventItemSpec, "home-server", 31, position),
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

/** A check that ended `at`, reading `result`. */
function check(
  n: number,
  at: number,
  result: string,
  overrides: Partial<RunAttempt> = {},
): RunAttempt {
  return {
    id: 600 + n,
    itemId: 102,
    attempt: n,
    status: "failed",
    startedAt: new Date(at - 300).toISOString(),
    finishedAt: new Date(at).toISOString(),
    exitCode: 0,
    stdout: null,
    stderr: null,
    truncated: false,
    timedOut: false,
    error: null,
    checks: null,
    stopIf: null,
    why: "not-yet",
    result,
    ...overrides,
  };
}

function seqStep(overrides: Partial<Step> = {}): Step {
  return makeStep({
    id: 3,
    position: 1,
    title: "Enforcarr on the farm image",
    hostName: "home-server",
    command: null,
    resolvedCommand: "# 1 Deploy\n...",
    commandHash: "e".repeat(64),
    sequence: SEQUENCE,
    resolvedSequence: RESOLVED,
    workdir: "/mnt/sdd/services/media-server",
    ...overrides,
  });
}

async function open(step: Step, post = vi.fn(async () => ({ data: {} }))) {
  const client = fakeApi({
    detail: () => makeRunbook([step], { title: "Enforcarr" }),
    post,
  });
  await openRunbook(client, {
    title: "Enforcarr",
    shows: () => screen.findAllByText(step.title),
  });
  return { client, el: card(step.id) };
}

const row = (el: Element, position: number) =>
  el.querySelector(`[data-item="${position}"]`)!;

const dots = (el: Element) =>
  [...el.querySelectorAll("[data-attempt-dot]")].map((dot) =>
    dot.getAttribute("data-dot"),
  );

/** The container waits (check 3 says "starting"); the rest not reached. */
function waitingForHealthy() {
  const now = Date.now();
  const started = now - 20_000;
  return seqStep({
    runs: [
      makeRun({
        id: 31,
        stepId: 3,
        status: "running",
        running: true,
        startedAt: new Date(now - 45_000).toISOString(),
        finishedAt: null,
        exitCode: null,
        elapsedMs: 45_000,
        items: [
          item(1, {
            status: "passed",
            startedAt: new Date(now - 45_000).toISOString(),
            finishedAt: new Date(started).toISOString(),
            exitCode: 0,
            stdout: "enforcarr: recreated\n",
          }),
          item(2, {
            status: "running",
            startedAt: new Date(started).toISOString(),
            endsBy: new Date(started + 180_000).toISOString(),
            maxAttempts: 500,
            nextAttemptAt: new Date(now + 4000).toISOString(),
            result: "starting",
            stdout:
              '{"State":{"Status":"running","Running":true,"Health":{"Status":"starting","FailingStreak":0,"Log":[]}},"RestartCount":0}\n',
            attempts: [
              check(1, started + 400, "not found"),
              check(2, started + 5400, "starting"),
              check(3, started + 10_400, "starting"),
            ],
          }),
          item(3),
          item(4),
          item(5),
        ],
      }),
    ],
  });
}

describe("the wait events on the step card", () => {
  it("shows each event's icon and exactly what it checks before Run, with the host's name", async () => {
    const { el } = await open(seqStep());
    expect(row(el, 1).querySelector("[data-item-icon]")).toBeNull();
    for (const position of [2, 3, 4, 5]) {
      expect(
        row(el, position).querySelector("[data-item-icon]"),
      ).not.toBeNull();
    }
    const what = (position: number) =>
      row(el, position).querySelector("[data-item-command]")!.textContent;
    expect(what(2)).toBe(
      "docker container inspect --format '{\"State\":{{json .State}},\"RestartCount\":{{.RestartCount}}}' -- 'enforcarr'\n# until healthy",
    );
    expect(what(4)).toBe(
      'GET https://127.0.0.1:8443/health on home-server, through the SSH connection, certificate for enforcarr.coolroo.dev: until HTTP 200 with "ok"',
    );
    expect(what(5)).toBe(
      "TCP 127.0.0.1:5432 on home-server, through the SSH connection: until open",
    );
    expect(row(el, 5).textContent).toContain(locales.item.what.port);
    expect(row(el, 3).querySelector("[data-item-label]")!.textContent).toBe(
      locales.item.type.unit,
    );
    // The schedule, as for a wait.
    expect(row(el, 2).querySelector("[data-item-schedule]")!.textContent).toBe(
      "Up to 500 attempts, every 5 s, at most 3 min",
    );
  });

  it("shows grey dots, the countdown with Try now and the last state while it waits", async () => {
    const { el } = await open(waitingForHealthy());
    const container = row(el, 2);
    expect(dots(container)).toEqual(["not-yet", "not-yet", "not-yet"]);
    expect(container.querySelector("[data-item-result]")!.textContent).toBe(
      "Last check: starting",
    );
    expect(container.querySelector("[data-try-now]")).not.toBeNull();
    expect(
      container.querySelector("[data-attempt-counter]")!.textContent,
    ).toContain("Attempt 3 of 500");
    // A dot's title says the state its check read.
    expect(
      container.querySelector('[data-attempt-dot="1"]')!.getAttribute("title"),
    ).toBe("Attempt 1 · not found");
  });

  it("shows a pass in words, a state that failed at once as a red dot, and the reason", async () => {
    const now = Date.now();
    const base = now - 120_000;
    const step = seqStep({
      status: "failed",
      runs: [
        makeRun({
          id: 31,
          stepId: 3,
          status: "failed",
          running: false,
          startedAt: new Date(base).toISOString(),
          finishedAt: new Date(now).toISOString(),
          items: [
            item(1, {
              status: "passed",
              startedAt: new Date(base).toISOString(),
              finishedAt: new Date(base + 5000).toISOString(),
              exitCode: 0,
            }),
            item(2, {
              status: "passed",
              startedAt: new Date(base + 5000).toISOString(),
              finishedAt: new Date(base + 20_000).toISOString(),
              maxAttempts: 500,
              result: "healthy",
              attempts: [
                check(1, base + 6000, "starting"),
                check(2, base + 20_000, "healthy", {
                  status: "passed",
                  why: null,
                }),
              ],
            }),
            item(3, {
              status: "failed",
              startedAt: new Date(base + 20_000).toISOString(),
              finishedAt: new Date(base + 26_000).toISOString(),
              maxAttempts: 500,
              result: "failed (exit-code, status 3)",
              error: "the unit failed: Result=exit-code, exit status 3",
              attempts: [
                check(1, base + 21_000, "activating (start)"),
                check(2, base + 26_000, "failed (exit-code, status 3)", {
                  why: "fail-state",
                  error: "the unit failed: Result=exit-code, exit status 3",
                }),
              ],
            }),
            item(4),
            item(5),
          ],
        }),
      ],
    });
    const { el } = await open(step);
    expect(row(el, 2).querySelector("[data-item-result]")!.textContent).toBe(
      "Passed: healthy",
    );
    expect(dots(row(el, 2))).toEqual(["not-yet", "passed"]);
    expect(dots(row(el, 3))).toEqual(["not-yet", "failed"]);
    expect(row(el, 3).querySelector("[data-item-error]")!.textContent).toBe(
      "the unit failed: Result=exit-code, exit status 3",
    );
  });

  it("shows what each event checks in the Run confirm", async () => {
    const { el } = await open(seqStep());
    fireEvent.click(within(el).getByRole("button", { name: locales.step.run }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "TCP 127.0.0.1:5432 on home-server, through the SSH connection: until open",
    );
    expect(dialog.textContent).toContain("docker container inspect");
  });
});
