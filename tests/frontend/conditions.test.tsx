import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  card,
  clickStep,
  fakeApi,
  locales,
  makeRunbook,
  makeStep,
  makeSummary,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { Runbook, StepCondition } from "../../src/frontend/api-types";

useRenderedApp();

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const NOT_NEEDED: StepCondition = {
  state: "not-met",
  rule: "step 1 failed or step 2 failed",
  reason: "step 1 is done and step 2 is done",
  notNeeded: true,
};

const WAITING: StepCondition = {
  state: "waiting",
  rule: "step 1 failed",
  reason: "waiting for step 1",
  notNeeded: false,
};

/** Steps 1 and 2 done, 3 not needed, 4 next, 5 waits on a rule. */
function runbook(): Runbook {
  return makeRunbook(
    [
      clickStep({ id: 1, title: "Deploy", status: "done" }),
      clickStep({ id: 2, title: "Health check", status: "done" }),
      makeStep({
        id: 3,
        title: "Way back",
        commandHash: "c".repeat(64),
        when: { any: [{ step: 1, status: "failed" }] },
        condition: NOT_NEEDED,
      }),
      clickStep({ id: 4, title: "Tell the team" }),
      clickStep({
        id: 5,
        title: "Undo the DNS change",
        when: { step: 1, status: "failed" },
        condition: WAITING,
      }),
    ],
    {
      title: "Release",
      nextStepId: 4,
      progress: { done: 2, failed: 0, total: 5, notNeeded: 1 },
    },
  );
}

const summary = makeSummary({ title: "Release" });

/** A 409 answer as the server sends it. */
const conflict = (data: Record<string, unknown>) => ({
  response: { status: 409, data: { error: "refused", ...data } },
});

async function open(post?: (url: string, body?: unknown) => Promise<unknown>) {
  const client = fakeApi({ list: [summary], detail: runbook, post });
  await openRunbook(client, { title: "Release", shows: "Tell the team" });
  return client;
}

/** Clicks the button in the open confirm whose text starts with `label`. */
async function pick(label: string) {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(label))!,
  );
}

describe("conditional steps on the page (T-024)", () => {
  it("shows a step that is not needed as one grey line, and opens it on a click", async () => {
    await open();
    const line = card(3);
    expect(line.hasAttribute("data-not-needed")).toBe(true);
    expect(line.getAttribute("data-state")).toBe("grey");
    expect(line.textContent).toBe(
      "3·Way back— not needed: step 1 is done and step 2 is done",
    );
    expect(within(line).queryByText(locales.step.run)).toBeNull();

    fireEvent.click(line.querySelector("[data-not-needed-toggle]")!);
    const opened = card(3);
    expect(opened.hasAttribute("data-collapsed")).toBe(false);
    expect(within(opened).getByText(locales.notNeeded.badge)).toBeTruthy();
    expect(
      opened.querySelector("[data-not-needed-reason]")?.textContent,
    ).toContain(
      "not needed: step 1 is done and step 2 is done · Only if step 1 failed or step 2 failed",
    );
    expect(within(opened).getByText(locales.step.run)).toBeTruthy();
  });

  it("says when a waiting step is needed, and counts the steps not needed", async () => {
    await open();
    expect(card(5).querySelector("[data-only-if]")?.textContent).toBe(
      "Only if step 1 failed",
    );
    expect(card(4).querySelector("[data-only-if]")).toBeNull();
    expect(screen.getByText(/2\/5 done · 1 not needed · by lead/)).toBeTruthy();
  });

  it("warns on a rule that reads hidden output, and only there (BUG-010)", async () => {
    const detail = () => {
      const shown = runbook();
      shown.steps[4] = {
        ...shown.steps[4],
        condition: { ...WAITING, readsHidden: true },
      };
      return shown;
    };
    const client = fakeApi({ list: [summary], detail });
    await openRunbook(client, { title: "Release", shows: "Tell the team" });
    expect(card(5).querySelector("[data-rule-reads-hidden]")?.textContent).toBe(
      locales.notNeeded.readsHidden,
    );
    expect(card(4).querySelector("[data-rule-reads-hidden]")).toBeNull();
    // A step without the flag: no warning, also when it is opened.
    fireEvent.click(card(3).querySelector("[data-not-needed-toggle]")!);
    expect(card(3).querySelector("[data-rule-reads-hidden]")).toBeNull();
  });

  it("hides the steps not needed on request, and remembers it", async () => {
    await open();
    const toggle = document.querySelector(
      "[data-hide-not-needed] input",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(card(3)).toBeNull();
    expect(card(4)).not.toBeNull();
    expect(window.localStorage.getItem("termix-runbooks.hideNotNeeded")).toBe(
      "1",
    );
    fireEvent.click(toggle);
    expect(card(3)).not.toBeNull();
    expect(window.localStorage.getItem("termix-runbooks.hideNotNeeded")).toBe(
      "0",
    );
  });

  it("asks Run anyway? when the server says the step is not needed (D3)", async () => {
    let calls = 0;
    const client = await open(async () => {
      calls += 1;
      if (calls === 1) {
        throw conflict({
          code: "not-needed",
          rule: NOT_NEEDED.rule,
          reason: NOT_NEEDED.reason,
        });
      }
      return { data: { id: 40, status: "done", running: false } };
    });
    fireEvent.click(card(3).querySelector("[data-not-needed-toggle]")!);
    fireEvent.click(within(card(3)).getByText(locales.step.run));
    await pick(locales.run.confirm);
    await screen.findByText(locales.notNeeded.title);
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "This step is not needed: step 1 is done and step 2 is done. Its rule: only if step 1 failed or step 2 failed.",
    );
    await pick(locales.notNeeded.anyway);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/steps/3/run", {
        revision: 1,
        commandHash: "c".repeat(64),
        conditionAnyway: true,
      }),
    );
  });
});
