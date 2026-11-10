import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const summary = {
  id: 7,
  title: "Look",
  status: "open",
  createdBy: "lead",
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  revision: 4,
  progress: { done: 0, failed: 0, total: 2 },
};

function step(overrides: Record<string, unknown>) {
  return {
    runbookId: 7,
    body: "",
    hostId: 1,
    hostName: "web-1",
    command: "uptime",
    resolvedCommand: "uptime",
    commandHash: "a".repeat(64),
    missing: [],
    expect: "",
    captures: [],
    checks: [],
    hideOutputFromAgents: false,
    status: "pending",
    skipReason: null,
    ownerNote: "",
    timeoutMs: null,
    revision: 1,
    runs: [],
    wait: null,
    stdin: null,
    owner: "person",
    sent: [],
    ...overrides,
  };
}

function runbook(canSendToAgent: boolean, status = "open") {
  return {
    ...summary,
    status,
    summary: "",
    values: {},
    effectiveValues: [],
    nextStepId: 1,
    owner: { task: "T-3", label: "Lead" },
    agentLabel: "Lead",
    notifyEnabled: canSendToAgent,
    canSendToAgent,
    steps: [
      step({ id: 1, position: 1, title: "Graph" }),
      step({
        id: 2,
        position: 2,
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
  };
}

function api(canSend: boolean, status = "open") {
  const data = runbook(canSend, status);
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [{ ...summary, status }] : data,
    })),
    post: vi.fn(async () => ({ data })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

async function open(client: ReturnType<typeof api>) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: client as never,
  });
  rendered.renderTab("runbooks", { isVisible: true });
  fireEvent.click(await screen.findByText("Look"));
  await screen.findByText("Logs");
}

const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;

describe("Send to agent", () => {
  it("shows on every step only when the runbook can send", async () => {
    await open(api(true));
    expect(card(1).querySelector("[data-send-to-agent]")).not.toBeNull();
    expect(card(2).querySelector("[data-send-to-agent]")).not.toBeNull();
    await rendered?.deactivate();
    rendered = null;
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
