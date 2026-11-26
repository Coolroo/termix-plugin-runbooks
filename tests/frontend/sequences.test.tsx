/**
 * 1.4.10: a sequence step's card lists its items: label, type, the exact
 * command or the wait, state and time taken. The item that runs streams
 * its output; a delay counts down with Skip; after a failure or a stop the
 * card offers Continue from item N. A one-command step looks as before.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  buttons,
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
  },
  { type: "delay", label: null, seconds: 30, reason: "let it start" },
  {
    type: "run",
    label: "Health",
    command: "curl -fsS https://127.0.0.1:8443/health",
    checks: [{ type: "contains", text: "ok" }],
    captures: [],
    timeoutMs: null,
    onFail: "stop",
    interactive: false,
  },
];

const RESOLVED: ResolvedItem[] = SEQUENCE.map((item, index) => ({
  ...item,
  position: index + 1,
  later: [],
}));

/** A run item record. */
function item(position: number, overrides: Partial<RunItem> = {}): RunItem {
  const spec = SEQUENCE[position - 1];
  return {
    id: 100 + position,
    runId: 21,
    position,
    type: spec.type,
    label: spec.label,
    command: spec.type === "run" ? spec.command : null,
    seconds: spec.type === "delay" ? spec.seconds : null,
    reason: spec.type === "delay" ? spec.reason : null,
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

function seqStep(overrides: Partial<Step> = {}): Step {
  return makeStep({
    id: 2,
    position: 1,
    title: "Enforcarr on the farm image",
    command: null,
    resolvedCommand: "# in /mnt/sdd/services/media-server\n# 1 Deploy\n...",
    commandHash: "c".repeat(64),
    sequence: SEQUENCE,
    resolvedSequence: RESOLVED,
    workdir: "/mnt/sdd/services/media-server",
    ...overrides,
  });
}

const items = (el: HTMLElement) =>
  [...el.querySelectorAll("[data-item]")].map(
    (row) =>
      `${row.getAttribute("data-item")}:${row.getAttribute("data-item-type")}:${row.getAttribute("data-item-status")}`,
  );

async function open(step: Step, post = vi.fn(async () => ({ data: {} }))) {
  const client = fakeApi({
    detail: () => makeRunbook([step], { title: "Deploy" }),
    post,
  });
  await openRunbook(client, {
    title: "Deploy",
    shows: () => screen.findAllByText(step.title),
  });
  return { client, el: card(step.id) };
}

describe("a sequence step's card", () => {
  it("lists the plan before a run: labels, types, exact commands and the wait", async () => {
    const { el } = await open(seqStep());
    expect(items(el)).toEqual([
      "1:run:waiting",
      "2:delay:waiting",
      "3:run:waiting",
    ]);
    const commands = [...el.querySelectorAll("[data-item-command]")].map(
      (pre) => pre.textContent,
    );
    expect(commands).toEqual([
      "sudo paseo-deploy up media enforcarr",
      "curl -fsS https://127.0.0.1:8443/health",
    ]);
    expect(el.querySelector("[data-item-delay]")!.textContent).toBe(
      "Wait 30 s: let it start",
    );
    expect(el.querySelector("[data-workdir]")!.textContent).toContain(
      "in /mnt/sdd/services/media-server",
    );
    // Run only: a terminal cannot run a sequence.
    expect(buttons(2)).toContain(locales.step.run);
    expect(buttons(2)).not.toContain(locales.step.send);
    // The step's one-command block is not there.
    expect(el.textContent).not.toContain("# 1 Deploy");
  });

  it("asks before Run with every item, then posts the run", async () => {
    const post = vi.fn(async () => ({
      data: makeRun({ id: 21, stepId: 2, status: "running", running: true }),
    }));
    const { el } = await open(seqStep(), post);
    fireEvent.click(within(el).getByRole("button", { name: locales.step.run }));
    const dialog = await screen.findByRole("alertdialog");
    const listed = [...dialog.querySelectorAll("[data-confirm-item]")].map(
      (row) => row.getAttribute("data-confirm-item"),
    );
    expect(listed).toEqual(["1", "2", "3"]);
    expect(dialog.textContent).toContain(
      "sudo paseo-deploy up media enforcarr",
    );
    expect(dialog.textContent).toContain("Wait 30 s: let it start");
    fireEvent.click(
      within(dialog)
        .getAllByRole("button")
        .find((b) => b.textContent?.startsWith(locales.run.confirm))!,
    );
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/steps/2/run", {
        revision: 1,
        commandHash: "c".repeat(64),
      }),
    );
  });

  it("shows each item's checks, stopIf, captures, onFail and interactive before Run (BUG-022 L3)", async () => {
    const sequence: SequenceItem[] = [
      {
        type: "run",
        label: "Version",
        command: "app --version",
        checks: [{ type: "value", name: "ver", matches: "^[0-9.]+$" }],
        captures: [{ name: "ver", pattern: "version=(\\S+)" }],
        timeoutMs: null,
        onFail: "continue",
        interactive: true,
      },
      {
        type: "wait",
        label: "Healthy",
        command: "status",
        checks: [{ type: "contains", text: "healthy" }],
        stopIf: [{ type: "contains", text: "FAILED" }],
        captures: [],
        timeoutMs: null,
        onFail: "stop",
        within: 600,
        attempts: null,
        every: 5,
        backoff: "fixed",
        factor: 2,
        maxDelay: 300,
        jitter: "none",
      },
    ];
    const step = seqStep({
      sequence,
      resolvedSequence: sequence.map((each, index) => ({
        ...each,
        position: index + 1,
        later: [],
      })),
    });
    const { el } = await open(step);
    // The card shows the capture's pattern.
    expect(
      el.querySelector('[data-item="1"] [data-confirm-captures]')!.textContent,
    ).toContain("version=(\\S+)");
    fireEvent.click(within(el).getByRole("button", { name: locales.step.run }));
    const dialog = await screen.findByRole("alertdialog");
    const first = dialog.querySelector('[data-confirm-item="1"]')!;
    expect(first.querySelector("[data-checks]")!.textContent).toContain(
      "^[0-9.]+$",
    );
    expect(
      first.querySelector("[data-confirm-captures]")!.textContent,
    ).toContain("version=(\\S+)");
    expect(first.querySelector("[data-confirm-on-fail]")!.textContent).toBe(
      locales.item.onFailContinue,
    );
    expect(first.querySelector("[data-confirm-interactive]")!.textContent).toBe(
      locales.kind.mark.interactive,
    );
    const second = dialog.querySelector('[data-confirm-item="2"]')!;
    expect(second.querySelector("[data-checks]")!.textContent).toContain(
      "healthy",
    );
    expect(
      second.querySelector("[data-confirm-stop-if]")!.textContent,
    ).toContain("FAILED");
    expect(second.querySelector("[data-confirm-on-fail]")).toBeNull();
  });

  it("streams the running item's output and counts a delay down with Skip", async () => {
    const now = Date.now();
    const running = seqStep({
      runs: [
        makeRun({
          id: 21,
          stepId: 2,
          status: "running",
          running: true,
          startedAt: new Date(now - 20_000).toISOString(),
          finishedAt: null,
          exitCode: null,
          elapsedMs: 20_000,
          items: [
            item(1, {
              status: "passed",
              startedAt: new Date(now - 20_000).toISOString(),
              finishedAt: new Date(now - 15_000).toISOString(),
              exitCode: 0,
              stdout: "deployed\n",
            }),
            item(2, {
              status: "running",
              startedAt: new Date(now - 15_000).toISOString(),
              plannedEndAt: new Date(now + 15_000).toISOString(),
            }),
            item(3),
          ],
        }),
      ],
    });
    const post = vi.fn(async () => ({ data: {} }));
    const { el } = await open(running, post);
    expect(items(el)).toEqual([
      "1:run:passed",
      "2:delay:running",
      "3:run:waiting",
    ]);
    const countdown = el.querySelector("[data-item-countdown]")!;
    expect(countdown.textContent).toMatch(/0:1[45] left/);
    expect(
      el.querySelector('[data-item="1"] [data-item-time]')!.textContent,
    ).toBe("0:05");
    fireEvent.click(el.querySelector("[data-skip-delay]")!);
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/steps/2/skip-delay"),
    );
    // Stop is there while it runs.
    expect(buttons(2)).toContain(locales.step.stop);
  });

  it("shows a run item's live output while it runs", async () => {
    const running = seqStep({
      runs: [
        makeRun({
          id: 21,
          stepId: 2,
          status: "running",
          running: true,
          finishedAt: null,
          items: [
            item(1, {
              status: "running",
              startedAt: new Date().toISOString(),
              stdout: "pulling image\n",
            }),
            item(2),
            item(3),
          ],
        }),
      ],
    });
    const { el } = await open(running);
    const live = el.querySelector('[data-item="1"] [data-item-live]')!;
    expect(live.textContent).toContain("pulling image");
  });

  it("after a failure: the failed item, items not run, and Continue from item N", async () => {
    const failed = seqStep({
      status: "failed",
      runs: [
        makeRun({
          id: 21,
          stepId: 2,
          status: "failed",
          exitCode: 22,
          error: "item 3 failed",
          items: [
            item(1, {
              status: "passed",
              startedAt: "2026-11-07T10:01:00.000Z",
              finishedAt: "2026-11-07T10:01:04.000Z",
              exitCode: 0,
            }),
            item(2, {
              status: "skipped",
              skippedBy: "alice",
              startedAt: "2026-11-07T10:01:04.000Z",
              finishedAt: "2026-11-07T10:01:09.000Z",
            }),
            item(3, {
              status: "failed",
              startedAt: "2026-11-07T10:01:09.000Z",
              finishedAt: "2026-11-07T10:01:10.000Z",
              exitCode: 22,
              stderr: "curl: (22) 503",
              checks: [
                {
                  label: "the output contains 'ok'",
                  ok: false,
                  detail: "not found",
                },
              ],
            }),
          ],
        }),
      ],
    });
    const post = vi.fn(async () => ({
      data: makeRun({ id: 22, stepId: 2, status: "running", running: true }),
    }));
    const { el } = await open(failed, post);
    expect(items(el)).toEqual([
      "1:run:passed",
      "2:delay:skipped",
      "3:run:failed",
    ]);
    expect(el.querySelector('[data-item="3"]')!.textContent).toContain(
      "curl: (22) 503",
    );
    expect(
      el.querySelector('[data-item="3"] [data-check-state="failed"]'),
    ).toBeTruthy();
    expect(buttons(2)).toContain("Continue from item 3");
    expect(buttons(2)).toContain(locales.step.runFromStart);
    fireEvent.click(within(el).getByText("Continue from item 3"));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      dialog.querySelector("[data-confirm-carried]")!.textContent,
    ).toContain("Items 1 to 2 passed");
    expect(
      [...dialog.querySelectorAll("[data-confirm-item]")].map((row) =>
        row.getAttribute("data-confirm-item"),
      ),
    ).toEqual(["3"]);
    fireEvent.click(
      within(dialog)
        .getAllByRole("button")
        .find((b) => b.textContent?.startsWith(locales.continue.confirm))!,
    );
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/steps/2/continue", {
        revision: 1,
        commandHash: "c".repeat(64),
        fromItem: 3,
      }),
    );
  });

  it("marks items that never ran in an ended run as not run, and carried items", async () => {
    const stopped = seqStep({
      status: "failed",
      runs: [
        makeRun({
          id: 23,
          stepId: 2,
          status: "failed",
          items: [
            item(1, {
              status: "passed",
              fromRunId: 21,
              startedAt: "2026-11-07T10:01:00.000Z",
              finishedAt: "2026-11-07T10:01:04.000Z",
            }),
            item(2, {
              status: "failed",
              error: "stopped by alice",
              startedAt: "2026-11-07T10:01:04.000Z",
              finishedAt: "2026-11-07T10:01:05.000Z",
            }),
            item(3),
          ],
        }),
      ],
    });
    const { el } = await open(stopped);
    expect(items(el)).toEqual([
      "1:run:passed",
      "2:delay:failed",
      "3:run:not-run",
    ]);
    expect(el.querySelector("[data-item-carried]")!.textContent).toContain(
      "run 21",
    );
    expect(buttons(2)).toContain("Continue from item 2");
  });
});

describe("a one-command step", () => {
  it("looks as before: one command block, Run and Send, no item list", async () => {
    const { el } = await open(
      makeStep({
        id: 2,
        position: 1,
        title: "Uptime",
        command: "uptime",
        resolvedCommand: "uptime",
      }),
    );
    expect(el.querySelector("[data-sequence]")).toBeNull();
    expect(el.querySelector("[data-sequence-step]")).toBeNull();
    expect(buttons(2)).toContain(locales.step.run);
    expect(buttons(2)).toContain(locales.step.send);
    expect(
      [...el.querySelectorAll("pre")].map((pre) => pre.textContent),
    ).toContain("uptime");
  });
});
