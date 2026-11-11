import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
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
  title: "Announce",
  status: "open",
  createdBy: "lead",
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  revision: 4,
  progress: { done: 1, failed: 0, total: 3 },
};

function step(overrides: Record<string, unknown>) {
  return {
    runbookId: 7,
    body: "",
    hostId: 1,
    hostName: "web-1",
    command: "true",
    resolvedCommand: "true",
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
    ...overrides,
  };
}

const terminalRun = {
  id: 31,
  stepId: 2,
  runbookId: 7,
  mode: "terminal",
  status: "awaiting-output",
  hostId: 1,
  command: "uptime",
  commandHash: "a".repeat(64),
  userId: "alice",
  startedAt: "2026-11-07T10:01:00.000Z",
  finishedAt: null,
  exitCode: null,
  stdout: null,
  stderr: null,
  truncated: false,
  timedOut: false,
  pastedOutput: null,
  error: null,
  captured: {},
  running: false,
};

const runbook = {
  ...summary,
  summary: "",
  values: {},
  effectiveValues: [],
  nextStepId: 1,
  steps: [
    step({
      id: 1,
      position: 1,
      title: "Tell the team",
      hostId: null,
      hostName: null,
      command: null,
      resolvedCommand: null,
      commandHash: null,
      ownerNote: "posted",
    }),
    step({
      id: 2,
      position: 2,
      title: "Uptime",
      command: "uptime",
      resolvedCommand: "uptime",
      runs: [terminalRun],
    }),
    step({
      id: 3,
      position: 3,
      title: "Told",
      hostId: null,
      hostName: null,
      command: null,
      resolvedCommand: null,
      commandHash: null,
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
};

function api() {
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : runbook,
    })),
    post: vi.fn(async () => ({ data: runbook })),
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
  fireEvent.click(await screen.findByText("Announce"));
  await screen.findByText("Tell the team");
}

const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;

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
