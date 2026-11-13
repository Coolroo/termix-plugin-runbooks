import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  card,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  makeSummary,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { Check, Step } from "../../src/frontend/api-types";

useRenderedApp();

const summary = makeSummary({
  title: "Restart web",
  progress: { done: 0, failed: 1, total: 2 },
});

const checks: Check[] = [
  { type: "exitCode", equals: 0 },
  {
    type: "contains",
    text: "active (running)",
    stream: "stdout",
    label: "nginx runs",
  },
];

const step = (overrides: Partial<Step> & { id: number }) =>
  makeStep({
    command: "systemctl status nginx",
    resolvedCommand: "systemctl status nginx",
    expect: "nginx is up.",
    checks,
    ...overrides,
  });

const runbook = makeRunbook(
  [
    step({
      id: 1,
      title: "Check status",
      status: "failed",
      runs: [
        makeRun({
          id: 11,
          status: "failed",
          command: "systemctl status nginx",
          finishedAt: "2026-11-07T10:01:01.000Z",
          stdout: "inactive (dead)",
          running: false,
          checks: [
            { label: "exit code is 0", ok: true, detail: "exit code 0" },
            {
              label: "nginx runs",
              ok: false,
              detail: "expected stdout to contain 'active (running)'",
            },
          ],
        }),
      ],
    }),
    step({ id: 2, title: "Check again" }),
  ],
  { ...summary, nextStepId: 2 },
);

const api = () => fakeApi({ list: [summary], detail: runbook });

const open = (client: ReturnType<typeof api>) =>
  openRunbook(client, { title: "Restart web", shows: "Check again" });

const states = (element: HTMLElement) =>
  [...element.querySelectorAll("[data-check-state]")].map((li) => [
    li.getAttribute("data-check-state"),
    li.textContent,
  ]);

describe("checks in the UI", () => {
  it("lists checks as pending before a run, with ticks and crosses after", async () => {
    await open(api());
    expect(states(card(2))).toEqual([
      ["pending", "○exit code is 0"],
      ["pending", "○nginx runs"],
    ]);
    expect(states(card(1))).toEqual([
      ["ok", "✓exit code is 0 · exit code 0"],
      ["failed", "✗nginx runs · expected stdout to contain 'active (running)'"],
    ]);
    // The failed step says which check failed, and what to do.
    const warning = within(card(1)).getByRole("alert");
    expect(warning.textContent).toContain("1 of the checks failed");
    expect(warning.textContent).toContain(
      "nginx runs: expected stdout to contain 'active (running)'",
    );
    expect(within(card(1)).getByText(locales.step.reopen)).toBeTruthy();
    expect(within(card(2)).queryByRole("alert")).toBeNull();
  });

  it("shows the checks in the Run confirm", async () => {
    await open(api());
    fireEvent.click(within(card(2)).getByText(locales.step.run));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("systemctl status nginx")).toBeTruthy();
    expect(within(dialog).getByText("nginx runs")).toBeTruthy();
    expect(within(dialog).getByText("exit code is 0")).toBeTruthy();
  });

  it("sends an entered exit code with Mark done", async () => {
    const client = api();
    const waiting = {
      ...runbook,
      steps: [
        runbook.steps[0],
        step({
          id: 2,
          position: 2,
          title: "Check again",
          runs: [
            {
              ...runbook.steps[0].runs[0],
              id: 12,
              stepId: 2,
              mode: "terminal",
              status: "awaiting-output",
              exitCode: null,
              stdout: null,
              checks: null,
            },
          ],
        }),
      ],
    };
    client.get.mockImplementation(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : waiting,
    }));
    await open(client);
    const box = card(2);
    fireEvent.change(
      within(box).getByPlaceholderText(locales.run.pastePlaceholder),
      { target: { value: "active\n" } },
    );
    fireEvent.change(
      within(box).getByPlaceholderText(locales.run.exitPlaceholder),
      { target: { value: "0" } },
    );
    fireEvent.click(within(box).getByText(locales.run.markDone));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/12/complete", {
        pastedOutput: "active\n",
        outcome: "done",
        exitCode: 0,
      }),
    );
  });
});
