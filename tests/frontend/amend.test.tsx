import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  card,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  useRenderedApp,
} from "./helpers";
import type { Step } from "../../src/frontend/api-types";

const render = useRenderedApp();

const step = (overrides: Partial<Step> & { id: number }) =>
  makeStep({
    owner: "person",
    suffix: null,
    amendment: null,
    replacedBy: null,
    ...overrides,
  });

const failedRun = makeRun({
  id: 40,
  stepId: 3,
  status: "failed",
  command: "systemctl restart app",
  startedAt: "2026-11-09T10:01:00.000Z",
  finishedAt: "2026-11-09T10:01:02.000Z",
  exitCode: 5,
  stderr: "Unit app not found",
  note: null,
  running: false,
});

const data = makeRunbook(
  [
    step({
      id: 3,
      position: 3,
      label: "3",
      title: "Restart",
      command: "systemctl restart app",
      resolvedCommand: "systemctl restart app",
      status: "replaced",
      runs: [failedRun],
      replacedBy: { id: 4, label: "3a" },
    }),
    step({
      id: 4,
      position: 3,
      suffix: "a",
      label: "3a",
      title: "Restart, fixed",
      command: "systemctl restart app.service",
      resolvedCommand: "systemctl restart app.service",
      amendment: {
        kind: "replace",
        reason: "the unit is app.service",
        by: "lead",
        stepId: 3,
        stepLabel: "3",
        oldCommand: "systemctl restart app",
      },
    }),
    step({
      id: 5,
      position: 3,
      suffix: "b",
      label: "3b",
      title: "Check the logs",
      command: "journalctl -u app.service",
      resolvedCommand: "journalctl -u app.service",
      amendment: {
        kind: "substep",
        reason: "see why it failed",
        by: "lead",
        stepId: 4,
        stepLabel: "3a",
        oldCommand: null,
      },
    }),
    step({
      id: 6,
      position: 4,
      label: "4",
      title: "Check",
      command: "systemctl is-active app.service",
      resolvedCommand: "systemctl is-active app.service",
    }),
  ],
  {
    title: "Deploy",
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-09T10:05:00.000Z",
    progress: { done: 1, failed: 0, total: 4 },
    amendedPending: 1,
    nextStepId: 4,
    owner: { label: "Lead agent" },
    agentLabel: "Lead agent",
  },
);

async function open() {
  const rendered = await render(fakeApi({ detail: data }));
  rendered.renderTab("runbooks", { isVisible: true });
  const row = await screen.findByText("Deploy");
  // The list says "amended" while an amendment has not run.
  expect(document.querySelector("[data-amended-badge]")!.textContent).toBe(
    locales.list.amended,
  );
  fireEvent.click(row);
  await screen.findByRole("heading", { name: "Restart, fixed" });
}

describe("amended steps", () => {
  it("show the label, the reason and the struck old command on a fixed version", async () => {
    await open();
    const fixed = card(4);
    expect(fixed.querySelector("[data-label]")!.textContent).toBe("3a.");
    expect(fixed.querySelector("[data-amend-reason]")!.textContent).toBe(
      "Amended by lead: the unit is app.service",
    );
    expect(fixed.querySelector("[data-amendment]")!.textContent).toContain(
      "Fixed version of step 3",
    );
    const old = fixed.querySelector("[data-old-command] del")!;
    expect(old.textContent).toBe("systemctl restart app");
    expect(fixed.textContent).toContain("systemctl restart app.service");
    // Its guards are a normal step's: Run and Send to terminal.
    const buttons = [...fixed.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(buttons).toContain(locales.step.run);
    expect(buttons).toContain(locales.step.send);

    const sub = card(5);
    expect(sub.querySelector("[data-label]")!.textContent).toBe("3b.");
    expect(sub.querySelector("[data-amendment]")!.textContent).toContain(
      "Extra step after step 3a",
    );
    expect(sub.querySelector("[data-old-command]")).toBeNull();
    expect(card(6).querySelector("[data-label]")!.textContent).toBe("4.");
  });

  it("fold the replaced step to 'Replaced by 3a', and open it to see its runs", async () => {
    await open();
    const old = card(3);
    expect(old.hasAttribute("data-collapsed")).toBe(true);
    expect(old.querySelector("[data-replaced-by]")!.textContent).toContain(
      "Replaced by 3a",
    );
    expect(old.textContent).not.toContain("Unit app not found");
    expect(old.querySelector("button")!.textContent).toBe(locales.amend.show);

    fireEvent.click(old.querySelector("[data-replaced-toggle]")!);
    const opened = card(3);
    expect(opened.hasAttribute("data-collapsed")).toBe(false);
    expect(opened.textContent).toContain("Unit app not found");
    const buttons = [...opened.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    // A replaced step does not run again.
    expect(buttons).not.toContain(locales.step.run);
    expect(buttons).toContain(locales.step.reopen);
    fireEvent.click(opened.querySelector("[data-replaced-toggle]")!);
    expect(card(3).hasAttribute("data-collapsed")).toBe(true);
  });
});
