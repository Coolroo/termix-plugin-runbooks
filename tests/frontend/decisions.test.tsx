import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  card,
  clickStep,
  fakeApi,
  locales,
  makeRunbook,
  makeRun,
  makeSummary,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { Runbook, Step } from "../../src/frontend/api-types";

useRenderedApp();

afterEach(() => {
  vi.restoreAllMocks();
});

const OPTIONS = [
  {
    id: "retry",
    label: "Fix it and try again",
    description: "The agent amends step 1.",
  },
  { id: "rollback", label: "Go back to the old release", description: null },
  { id: "stop", label: "Stop here", description: null },
];

const decisionStep = (overrides: Partial<Step> & { id: number }) =>
  clickStep({
    title: "Which way do we go?",
    decision: {
      options: OPTIONS,
      multiple: false,
      min: 1,
      max: 1,
      value: "path",
    },
    ...overrides,
  });

function runbook(steps: Step[]): Runbook {
  return makeRunbook(steps, { title: "Release" });
}

const summary = makeSummary({ title: "Release" });

async function open(
  detail: Runbook,
  post?: (url: string, body?: unknown) => Promise<unknown>,
) {
  const client = fakeApi({ list: [summary], detail, post });
  await openRunbook(client, { title: "Release", shows: detail.steps[0].title });
  return client;
}

const confirmButton = (id: number) =>
  card(id).querySelector("[data-decide]") as HTMLButtonElement;

describe("decision steps on the page (T-025)", () => {
  it("shows the options as radio cards and confirms one", async () => {
    const client = await open(runbook([decisionStep({ id: 1 })]));
    const box = card(1);
    expect(box.getAttribute("data-kind")).toBe("decision");
    expect(within(box).getByText(locales.decision.pickOne)).toBeTruthy();
    expect(within(box).getByText("The agent amends step 1.")).toBeTruthy();
    const radios = within(box).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    // No Done or Failed: the choice ends the step.
    expect(within(box).queryByText(locales.step.done)).toBeNull();
    expect(confirmButton(1).disabled).toBe(true);
    fireEvent.click(radios[1]);
    expect(confirmButton(1).disabled).toBe(false);
    fireEvent.click(confirmButton(1));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/decide", {
        revision: 1,
        chosen: ["rollback"],
      }),
    );
  });

  it("takes check boxes within min and max, in the author's order", async () => {
    const client = await open(
      runbook([
        decisionStep({
          id: 1,
          decision: {
            options: OPTIONS,
            multiple: true,
            min: 2,
            max: 2,
            value: null,
          },
        }),
      ]),
    );
    const boxes = within(card(1)).getAllByRole("checkbox");
    expect(within(card(1)).getByText("Choose 2 options.")).toBeTruthy();
    fireEvent.click(boxes[2]);
    expect(confirmButton(1).disabled).toBe(true);
    fireEvent.click(boxes[0]);
    expect(confirmButton(1).disabled).toBe(false);
    fireEvent.click(confirmButton(1));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/decide", {
        revision: 1,
        chosen: ["retry", "stop"],
      }),
    );
  });

  it("shows what was chosen, and warns before choosing again (D8)", async () => {
    const client = await open(
      runbook([
        decisionStep({
          id: 1,
          status: "done",
          choice: {
            chosen: ["rollback"],
            by: "alice",
            at: "2026-11-07T10:01:02.000Z",
          },
          decisionRan: [{ id: 2, position: 2, label: "2", title: "Roll back" }],
          runs: [
            makeRun({
              id: 11,
              mode: "decision",
              command: "",
              exitCode: null,
              stdout: "rollback\n",
            }),
          ],
        }),
        clickStep({ id: 2, title: "Roll back", status: "done" }),
      ]),
    );
    const chose = card(1).querySelector("[data-choice]")!;
    expect(chose.getAttribute("data-choice")).toBe("rollback");
    expect(chose.textContent).toContain(
      "You chose: Go back to the old release",
    );
    expect(card(1).querySelector("[data-decide]")).toBeNull();
    expect(card(1).textContent).toContain("Chosen by alice at");
    expect(card(1).textContent).not.toContain("$ ");

    fireEvent.click(within(card(1)).getByText(locales.step.reopen));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(locales.decision.reopenTitle);
    expect(dialog.textContent).toContain("2. Roll back");
    fireEvent.click(within(dialog).getByText(locales.decision.reopen));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/reopen"),
    );
  });
});
