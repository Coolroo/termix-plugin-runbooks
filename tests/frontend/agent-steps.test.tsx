import { describe, expect, it } from "vitest";
import {
  buttons,
  card,
  clickStep,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { Step } from "../../src/frontend/api-types";

useRenderedApp();

const step = (overrides: Partial<Step> & { id: number }) =>
  clickStep({ owner: "person", ...overrides });

const agentRun = makeRun({
  id: 40,
  mode: "agent",
  hostId: null,
  command: "make check",
  commandHash: "",
  userId: "lead",
  finishedAt: "2026-11-07T10:01:00.000Z",
  exitCode: null,
  stdout: "42 passed\n",
  stderr: null,
  note: "all green",
  running: false,
});

function runbook(owner: Record<string, string> | null) {
  return makeRunbook(
    [
      step({
        id: 1,
        title: "Run the tests",
        owner: "agent",
        command: "make check",
        resolvedCommand: "make check",
        status: "done",
        runs: [agentRun],
      }),
      step({
        id: 2,
        title: "Read the dashboard",
        owner: "agent",
        command: "curl -s https://grafana/api",
        resolvedCommand: "curl -s https://grafana/api",
      }),
      makeStep({
        id: 3,
        title: "Restart",
        owner: "person",
        command: "systemctl restart app",
        resolvedCommand: "systemctl restart app",
      }),
    ],
    {
      title: "Deploy",
      nextStepId: 2,
      owner,
      agentLabel: owner?.label ?? "lead",
    },
  );
}

const api = (owner: Record<string, string> | null) =>
  fakeApi({ detail: runbook(owner) });

const open = (client: ReturnType<typeof api>) =>
  openRunbook(client, { title: "Deploy", shows: "Read the dashboard" });

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
    const first = await open(api({ task: "T-9" }));
    expect(document.querySelector("[data-runbook-owner]")!.textContent).toBe(
      "Agent: lead · task T-9",
    );
    expect(card(2).querySelector("[data-agent-waiting]")!.textContent).toBe(
      "Waiting for the agent (lead)",
    );
    await first.deactivate();
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
