import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  card,
  fakeApi,
  locales,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { RunbookStatus, Step } from "../../src/frontend/api-types";

useRenderedApp();

const step = (overrides: Partial<Step> & { id: number }) =>
  makeStep({
    command: "uptime",
    resolvedCommand: "uptime",
    owner: "person",
    sent: [],
    ...overrides,
  });

function runbook(canSendToAgent: boolean, status: RunbookStatus = "open") {
  return makeRunbook(
    [
      step({ id: 1, title: "Graph" }),
      step({
        id: 2,
        title: "Logs",
        sent: [
          {
            id: 9,
            createdBy: "alice",
            createdAt: "2026-11-07T10:06:00.000Z",
            note: "look at 10:05",
          },
          {
            id: 8,
            createdBy: "bob",
            createdAt: "2026-11-07T10:04:00.000Z",
            note: null,
          },
        ],
      }),
    ],
    {
      title: "Look",
      progress: { done: 0, failed: 0, total: 2 },
      status,
      nextStepId: 1,
      owner: { task: "T-3", label: "Lead" },
      agentLabel: "Lead",
      notifyEnabled: canSendToAgent,
      canSendToAgent,
    },
  );
}

const api = (canSend: boolean, status: RunbookStatus = "open") =>
  fakeApi({ detail: runbook(canSend, status) });

const open = (client: ReturnType<typeof api>) =>
  openRunbook(client, {
    title: "Look",
    shows: () => screen.findByText("Logs"),
  });

describe("Send to agent", () => {
  it("shows on every step only when the runbook can send", async () => {
    const first = await open(api(true));
    expect(card(1).querySelector("[data-send-to-agent]")).not.toBeNull();
    expect(card(2).querySelector("[data-send-to-agent]")).not.toBeNull();
    await first.deactivate();
    await open(api(false));
    expect(document.querySelector("[data-send-to-agent]")).toBeNull();
  });

  it("is there on a closed runbook too", async () => {
    await open(api(true, "done"));
    expect(card(1).querySelector("[data-send-to-agent]")).not.toBeNull();
    expect(
      [...card(1).querySelectorAll("button")].map((b) => b.textContent),
    ).not.toContain(locales.step.run);
  });

  it("asks with an optional note of up to 500 characters, then sends", async () => {
    const client = api(true);
    await open(client);
    fireEvent.click(card(2).querySelector("[data-send-to-agent]")!);
    const prompt = await screen.findByRole("dialog");
    expect(prompt.textContent).toContain("Send step 2 to Lead?");
    const box = prompt.querySelector("textarea")!;
    expect(box.maxLength).toBe(500);
    expect(prompt.querySelector("[data-send-count]")!.textContent).toBe(
      "0/500",
    );
    fireEvent.change(box, { target: { value: "x".repeat(600) } });
    expect(box.value).toHaveLength(500);
    expect(prompt.querySelector("[data-send-count]")!.textContent).toBe(
      "500/500",
    );
    fireEvent.change(box, { target: { value: "check the spike" } });
    fireEvent.click(prompt.querySelector("[data-send-confirm]")!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/send-to-agent", {
        note: "check the spike",
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends nothing on Cancel", async () => {
    const client = api(true);
    await open(client);
    fireEvent.click(card(1).querySelector("[data-send-to-agent]")!);
    const prompt = await screen.findByRole("dialog");
    fireEvent.click(prompt.querySelector("[data-send-cancel]")!);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(client.post).not.toHaveBeenCalled();
  });

  it("shows each send in the step's history, with the note", async () => {
    await open(api(true));
    const lines = [...card(2).querySelectorAll("[data-sent]")];
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("Sent to the agent by alice at");
    expect(lines[0].textContent).toContain(", with a note:");
    expect(lines[0].textContent).toContain("look at 10:05");
    expect(lines[1].textContent).toContain("Sent to the agent by bob at");
    expect(lines[1].textContent).not.toContain("with a note");
  });
});
