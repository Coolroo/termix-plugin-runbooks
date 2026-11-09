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
  title: "Deploy",
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
    hostId: null,
    hostName: null,
    command: null,
    resolvedCommand: null,
    commandHash: null,
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
    ...overrides,
  };
}

const agentRun = {
  id: 40,
  stepId: 1,
  runbookId: 7,
  mode: "agent",
  status: "done",
  hostId: null,
  command: "make check",
  commandHash: "",
  userId: "lead",
  startedAt: "2026-11-07T10:01:00.000Z",
  finishedAt: "2026-11-07T10:01:00.000Z",
  exitCode: null,
  stdout: "42 passed\n",
  stderr: null,
  truncated: false,
  timedOut: false,
  pastedOutput: null,
  error: null,
  captured: {},
  note: "all green",
  running: false,
};

function runbook(owner: Record<string, string> | null) {
  return {
    ...summary,
    summary: "",
    values: {},
    effectiveValues: [],
    nextStepId: 2,
    owner,
    agentLabel: owner?.label ?? "lead",
    steps: [
      step({
        id: 1,
        position: 1,
        title: "Run the tests",
        owner: "agent",
        command: "make check",
        resolvedCommand: "make check",
        status: "done",
        runs: [agentRun],
      }),
      step({
        id: 2,
        position: 2,
        title: "Read the dashboard",
        owner: "agent",
        command: "curl -s https://grafana/api",
        resolvedCommand: "curl -s https://grafana/api",
      }),
      step({
        id: 3,
        position: 3,
        title: "Restart",
        hostId: 1,
        hostName: "web-1",
        command: "systemctl restart app",
        resolvedCommand: "systemctl restart app",
        commandHash: "a".repeat(64),
      }),
    ],
  };
}

function api(owner: Record<string, string> | null) {
  const data = runbook(owner);
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : data,
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
  fireEvent.click(await screen.findByText("Deploy"));
  await screen.findByText("Read the dashboard");
}

const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;
const buttons = (id: number) =>
  [...card(id).querySelectorAll("button")].map((button) => button.textContent);

describe("agent steps", () => {
  it("wait for the agent: no Run, Send or Done, only Skip", async () => {
    await open(api({ task: "T-7", label: "Lead agent" }));
    const waiting = card(2).querySelector("[data-agent-waiting]")!;
    expect(waiting.textContent).toBe("Waiting for the agent (Lead agent)");
    expect(card(2).querySelector("[data-agent-step]")).not.toBeNull();
    expect(buttons(2)).toContain(locales.step.skip);
    for (const hidden of [
      locales.step.run,
      locales.step.send,
      locales.step.done,
      locales.step.failed,
    ]) {
      expect(buttons(2)).not.toContain(hidden);
    }
    const command = card(2).querySelector("[data-agent-command]")!;
    expect(command.textContent).toContain(locales.step.agentCommand);
    expect(command.textContent).toContain("curl -s https://grafana/api");
    // A person step keeps its buttons.
    expect(buttons(3)).toContain(locales.step.run);
  });

  it("show who the runbook belongs to under its title", async () => {
    await open(api({ task: "T-7", label: "Lead agent" }));
    expect(document.querySelector("[data-runbook-owner]")!.textContent).toBe(
      "Agent: Lead agent · task T-7",
    );
  });

  it("use the token name when the owner has no label, and no line without an owner", async () => {
    await open(api({ task: "T-9" }));
    expect(document.querySelector("[data-runbook-owner]")!.textContent).toBe(
      "Agent: lead · task T-9",
    );
    expect(card(2).querySelector("[data-agent-waiting]")!.textContent).toBe(
      "Waiting for the agent (lead)",
    );
    await rendered?.deactivate();
    rendered = null;
    await open(api(null));
    expect(document.querySelector("[data-runbook-owner]")).toBeNull();
  });

  it("show the agent's run with its note and output, without a command line", async () => {
    await open(api({ label: "Lead agent" }));
    const run = card(1).querySelector('[data-run="40"]')!;
    expect(run.textContent).toContain("Done by the agent lead");
    expect(run.querySelector("[data-run-note]")!.textContent).toBe(
      "Note: all green",
    );
    expect(run.textContent).toContain("42 passed");
    expect(run.textContent).not.toContain("$ make check");
    expect(buttons(1)).toContain(locales.step.reopen);
  });
});
