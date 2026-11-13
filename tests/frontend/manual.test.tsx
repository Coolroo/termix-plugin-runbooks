import { describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import {
  card,
  clickStep,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
} from "./helpers";

useRenderedApp();

const terminalRun = makeRun({
  id: 31,
  stepId: 2,
  mode: "terminal",
  status: "awaiting-output",
  command: "uptime",
  finishedAt: null,
  exitCode: null,
  stdout: null,
  stderr: null,
  running: false,
});

const runbook = makeRunbook(
  [
    clickStep({ id: 1, title: "Tell the team", ownerNote: "posted" }),
    makeStep({
      id: 2,
      title: "Uptime",
      command: "uptime",
      resolvedCommand: "uptime",
      runs: [terminalRun],
    }),
    clickStep({
      id: 3,
      title: "Told",
      status: "done",
      runs: [
        {
          ...terminalRun,
          id: 32,
          stepId: 3,
          mode: "manual",
          status: "done",
          hostId: null,
          command: "",
          finishedAt: "2026-11-07T10:02:00.000Z",
          note: "all good",
        },
      ],
    }),
  ],
  { title: "Announce", nextStepId: 1 },
);

const api = () => fakeApi({ detail: runbook });

const open = (client: ReturnType<typeof api>) =>
  openRunbook(client, { title: "Announce", shows: "Tell the team" });

describe("steps with no command", () => {
  it("have Done and Failed buttons, and a separate Skip", async () => {
    const client = api();
    await open(client);
    const buttons = [...card(1).querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(buttons).toContain(locales.step.done);
    expect(buttons).toContain(locales.step.failed);
    expect(buttons).toContain(locales.step.skip);
    expect(buttons).not.toContain("Mark read");
    fireEvent.click(card(1).querySelector('[data-manual="done"]')!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/manual", {
        outcome: "done",
        note: "posted",
      }),
    );
  });

  it("show a manual run with who marked it and the note", async () => {
    await open(api());
    const run = card(3).querySelector('[data-run="32"]')!;
    expect(run.textContent).toContain("Marked done by alice");
    expect(run.querySelector("[data-run-note]")!.textContent).toBe(
      "Note: all good",
    );
    expect(run.textContent).not.toContain("$ ");
  });
});

describe("Mark done on a terminal run", () => {
  it("is disabled until a line of output is pasted", async () => {
    await open(api());
    const done = () =>
      within(card(2)).getByText(locales.run.markDone).closest("button")!;
    expect(done().disabled).toBe(true);
    expect(done().title).toBe(locales.run.pasteFirst);
    // Said in words too, for a phone, where a title never shows (1.4.1).
    expect(card(2).querySelector("[data-paste-first]")!.textContent).toBe(
      locales.run.pasteFirst,
    );
    const box = within(card(2)).getByPlaceholderText(
      locales.run.pastePlaceholder,
    );
    fireEvent.change(box, { target: { value: "   \n" } });
    expect(done().disabled).toBe(true);
    fireEvent.change(box, { target: { value: "up 3 days\n" } });
    expect(done().disabled).toBe(false);
    expect(card(2).querySelector("[data-paste-first]")).toBeNull();
    expect(
      within(card(2)).getByText(locales.run.markFailed).closest("button")!
        .disabled,
    ).toBe(false);
  });
});
