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
  title: "Restart web",
  status: "open",
  createdBy: "lead",
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  revision: 4,
  progress: { done: 0, failed: 1, total: 2 },
};

const checks = [
  { type: "exitCode", equals: 0 },
  {
    type: "contains",
    text: "active (running)",
    stream: "stdout",
    label: "nginx runs",
  },
];

function step(overrides: Record<string, unknown>) {
  return {
    runbookId: 7,
    body: "",
    hostId: 1,
    hostName: "web-1",
    command: "systemctl status nginx",
    resolvedCommand: "systemctl status nginx",
    commandHash: "a".repeat(64),
    missing: [],
    expect: "nginx is up.",
    captures: [],
    checks,
    hideOutputFromAgents: false,
    status: "pending",
    skipReason: null,
    ownerNote: "",
    timeoutMs: null,
    revision: 1,
    runs: [],
    ...overrides,
  };
}

const runbook = {
  ...summary,
  summary: "",
  values: {},
  effectiveValues: [],
  nextStepId: 2,
  steps: [
    step({
      id: 1,
      position: 1,
      title: "Check status",
      status: "failed",
      runs: [
        {
          id: 11,
          stepId: 1,
          runbookId: 7,
          mode: "exec",
          status: "failed",
          hostId: 1,
          command: "systemctl status nginx",
          commandHash: "a".repeat(64),
          userId: "alice",
          startedAt: "2026-11-07T10:01:00.000Z",
          finishedAt: "2026-11-07T10:01:01.000Z",
          exitCode: 0,
          stdout: "inactive (dead)",
          stderr: "",
          truncated: false,
          timedOut: false,
          pastedOutput: null,
          error: null,
          captured: {},
          running: false,
          checks: [
            { label: "exit code is 0", ok: true, detail: "exit code 0" },
            {
              label: "nginx runs",
              ok: false,
              detail: "expected stdout to contain 'active (running)'",
            },
          ],
        },
      ],
    }),
    step({ id: 2, position: 2, title: "Check again" }),
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
  fireEvent.click(await screen.findByText("Restart web"));
  await screen.findByText("Check again");
}

const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;

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
              ...(runbook.steps[0].runs as Array<Record<string, unknown>>)[0],
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
