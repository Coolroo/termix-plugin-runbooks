import { describe, expect, it } from "vitest";
import {
  buttons,
  card,
  fakeApi,
  locales,
  makeRunbook,
  makeStep,
  makeSummary,
  openRunbook,
  useRenderedApp,
} from "./helpers";

useRenderedApp();

const summary = makeSummary({ title: "Sign in and apply" });

const runbook = makeRunbook(
  [
    makeStep({
      id: 1,
      title: "Sign in to OpenBao",
      runIn: "terminal",
      runInReason: "it opens your browser",
    }),
    makeStep({ id: 2, title: "Apply", runIn: "run" }),
    makeStep({ id: 3, title: "Status" }),
    makeStep({ id: 4, title: "Log in again", runIn: "terminal" }),
  ],
  { title: "Sign in and apply" },
);

const open = () =>
  openRunbook(fakeApi({ list: [summary], detail: runbook }), {
    title: "Sign in and apply",
    shows: "Status",
  });

describe("runIn on the step card (T-022)", () => {
  it("shows only Send to terminal on a terminal-only step, with the reason, and says Terminal on its chip", async () => {
    await open();
    expect(buttons(1)).not.toContain(locales.step.run);
    expect(buttons(1)).toContain(locales.step.send);
    const line = card(1).querySelector("[data-run-in]")!;
    expect(line.getAttribute("data-run-in")).toBe("terminal");
    expect(line.textContent).toBe(
      "Send to terminal only: it opens your browser.",
    );
    expect(
      card(1).querySelector("[data-kind]:not([data-step])")?.textContent,
    ).toBe("Terminal on web-1");
    // Without a reason, a general line.
    expect(card(4).querySelector("[data-run-in]")?.textContent).toBe(
      locales.runIn.terminal,
    );
  });

  it("shows only Run on a Run-only step, and both on any other", async () => {
    await open();
    expect(buttons(2)).toContain(locales.step.run);
    expect(buttons(2)).not.toContain(locales.step.send);
    expect(card(2).querySelector("[data-run-in]")?.textContent).toBe(
      locales.runIn.run,
    );
    expect(
      card(2).querySelector("[data-kind]:not([data-step])")?.textContent,
    ).toBe("Run on web-1");
    expect(buttons(3)).toEqual(
      expect.arrayContaining([locales.step.run, locales.step.send]),
    );
    expect(card(3).querySelector("[data-run-in]")).toBeNull();
  });
});
