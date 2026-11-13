import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  buttons,
  card,
  clickStep,
  fakeApi,
  locales,
  makeRunbook,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { Step } from "../../src/frontend/api-types";

useRenderedApp();

afterEach(() => {
  vi.restoreAllMocks();
});

const step = (overrides: Partial<Step> & { id: number }) =>
  clickStep({ revision: 3, owner: "person", where: null, ...overrides });

const data = makeRunbook(
  [
    step({
      id: 1,
      title: "Read the docs",
      body: "Open a shell and run:\n\n```\nwinget install Git.Git\n```\n\nThen `git --version` should work.",
      expect: "It prints:\n\n```text\ngit version 2.47.0\n```",
    }),
    step({
      id: 2,
      title: "Check Windows",
      where: "Windows PC, PowerShell as admin",
      command: "Get-ComputerInfo -Property {{field}}",
      resolvedCommand: "Get-ComputerInfo -Property OsVersion",
      checks: [{ type: "contains", text: "10.0" }],
    }),
    step({
      id: 3,
      title: "Needs a value",
      where: "Browser console",
      command: "fetch('{{url}}')",
      resolvedCommand: "fetch('{{url}}')",
      missing: ["url"],
    }),
  ],
  {
    title: "Laptop setup",
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-09T10:05:00.000Z",
    progress: { done: 0, failed: 0, total: 3 },
    nextStepId: 1,
    owner: null,
    agentLabel: "lead",
  },
);

const api = () => fakeApi({ detail: data });

async function open(client = api()) {
  await openRunbook(client, {
    title: "Laptop setup",
    shows: () => screen.findByText("Check Windows"),
  });
  return client;
}

describe("Copy on code blocks", () => {
  it("puts a Copy button on each fenced block in the body and the expect text, none on inline code", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await open();
    const blocks = card(1).querySelectorAll("[data-code-block]");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].querySelector("pre")!.textContent).toBe(
      "winget install Git.Git\n",
    );
    for (const block of blocks) {
      expect(block.querySelector("[data-copy]")!.textContent).toBe(
        locales.step.copy,
      );
    }
    // Inline code has no button: only the two blocks have one.
    expect(card(1).querySelectorAll("[data-copy]")).toHaveLength(2);
    fireEvent.click(blocks[0].querySelector("[data-copy]")!);
    expect(writeText).toHaveBeenCalledWith("winget install Git.Git");
    fireEvent.click(blocks[1].querySelector("[data-copy]")!);
    expect(writeText).toHaveBeenLastCalledWith("git version 2.47.0");
  });
});

describe("steps run outside Termix", () => {
  it("show where, the command and Copy, and no Run or Send", async () => {
    await open();
    const outside = card(2).querySelector("[data-outside]")!;
    expect(outside.querySelector("[data-outside-where]")!.textContent).toBe(
      "Run outside Termix: Windows PC, PowerShell as admin",
    );
    expect(outside.querySelector("pre")!.textContent).toBe(
      "Get-ComputerInfo -Property OsVersion",
    );
    const copy = outside.querySelector("[data-copy]") as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    expect(buttons(2)).not.toContain(locales.step.run);
    expect(buttons(2)).not.toContain(locales.step.send);
    expect(buttons(2)).toContain(locales.step.done);
    expect(buttons(2)).toContain(locales.step.failed);
  });

  it("send Done with the pasted output and the revision shown", async () => {
    const client = await open();
    const paste = card(2).querySelector(
      "[data-outside-paste] textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(paste, { target: { value: "OsVersion : 10.0.26100" } });
    fireEvent.click(card(2).querySelector('[data-outside-mark="done"]')!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/manual", {
        outcome: "done",
        note: "",
        output: "OsVersion : 10.0.26100",
        revision: 3,
      }),
    );
  });

  it("disable Copy, Done and Failed while a value is missing", async () => {
    await open();
    const outside = card(3).querySelector("[data-outside]")!;
    expect(
      (outside.querySelector("[data-copy]") as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const mark of ["done", "failed"]) {
      expect(
        (
          card(3).querySelector(
            `[data-outside-mark="${mark}"]`,
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    }
    expect(card(3).textContent).toContain("url");
  });

  it("disable Done on a step with checks until output is pasted; Failed stays (1.4.1)", async () => {
    const client = await open();
    const done = card(2).querySelector(
      '[data-outside-mark="done"]',
    ) as HTMLButtonElement;
    const failed = card(2).querySelector(
      '[data-outside-mark="failed"]',
    ) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(done.title).toBe(locales.run.pasteFirst);
    expect(card(2).querySelector("[data-paste-first]")!.textContent).toBe(
      locales.run.pasteFirst,
    );
    expect(failed.disabled).toBe(false);
    const paste = card(2).querySelector(
      "[data-outside-paste] textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(paste, { target: { value: "   " } });
    expect(done.disabled).toBe(true);
    fireEvent.change(paste, { target: { value: "OsVersion : 10.0" } });
    expect(done.disabled).toBe(false);
    expect(done.title).toBe("");
    expect(card(2).querySelector("[data-paste-first]")).toBeNull();
    fireEvent.change(paste, { target: { value: "" } });
    fireEvent.click(failed);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/manual", {
        outcome: "failed",
        note: "",
        output: "",
        revision: 3,
      }),
    );
  });

  it("let Done go without a paste on a step with no checks", async () => {
    await open();
    // Step 3 has no checks; only its missing value holds Done back.
    expect(card(3).querySelector("[data-paste-first]")).toBeNull();
    expect(
      (card(3).querySelector('[data-outside-mark="done"]') as HTMLButtonElement)
        .title,
    ).toBe("");
  });
});
