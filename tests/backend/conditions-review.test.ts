import { describe, expect, it } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type TestServer,
} from "./helpers";

useTestServer();

/** The agent's view of a runbook. */
async function agentRead(s: TestServer, token: string, runbookId: number) {
  const read = await s.agent("GET", `/runbooks/${runbookId}`, token);
  expect(read.status).toBe(200);
  return read.body;
}

/** A decision step, with the person's choice in `path`. */
const WHICH_WAY = {
  title: "Which way?",
  decision: {
    options: [
      { id: "retry", label: "Try again" },
      { id: "rollback", label: "Go back" },
    ],
    value: "path",
  },
};

const decide = (
  s: TestServer,
  step: { id: number; revision: number },
  chosen: string[],
) =>
  s.person("POST", `/steps/${step.id}/decide`, {
    revision: step.revision,
    chosen,
  });

describe("when rules after the review (BUG-008)", () => {
  it("starts a wait timer from the last step that ended, past a step that is not needed (finding 4)", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Deploy", hostId: 1, command: "deploy" },
      {
        title: "Way back",
        hostId: 1,
        command: "rollback",
        when: { step: 1, status: "failed" },
      },
      {
        title: "Health check",
        hostId: 1,
        command: "check",
        waitAfterPreviousSeconds: 600,
      },
    ]);
    const [deploy, , check] = runbook.steps;
    await runStep(s, runbook.id, deploy.id);
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].condition.notNeeded).toBe(true);
    expect(shown.steps[2].wait).toMatchObject({
      previous: { label: "1" },
      previousEnded: true,
    });
    expect(shown.steps[2].wait.remainingMs).toBeGreaterThan(590_000);
    const early = await runStep(s, runbook.id, check.id);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("wait");
    expect((await agentRead(s, token, runbook.id)).steps[2].waitUntil).toBe(
      shown.steps[2].wait.until,
    );
  });

  it("gives a rule only the author's values and captures of earlier steps (finding 5)", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Status",
        hostId: 1,
        command: "status",
        captures: [{ name: "mode", pattern: "mode=(\\S+)" }],
      },
      {
        title: "Fast path",
        hostId: 1,
        command: "fast",
        when: { value: "mode", equals: "fast" },
      },
      {
        title: "Same mode",
        hostId: 1,
        command: "same",
        when: { step: 1, output: { type: "contains", text: "mode={{mode}}" } },
      },
      {
        title: "Switch",
        hostId: 1,
        command: "switch",
        captures: [{ name: "mode", pattern: "mode=(\\S+)" }],
      },
      { title: "Report", hostId: 1, command: "report" },
    ]);
    const [status, , same, sw, report] = runbook.steps;
    s.setExec(async (_host, command) =>
      execResult(command === "switch" ? "mode=fast\n" : "mode=slow\n"),
    );
    await runStep(s, runbook.id, status.id);
    await runStep(s, runbook.id, same.id);
    await runStep(s, runbook.id, sw.id);

    // Step 4 set mode=fast, but steps 2 and 3 come before it.
    const read = await agentRead(s, token, runbook.id);
    expect(read.steps[1].condition).toMatchObject({
      state: "not-met",
      reason: "value mode is not 'fast'",
      notNeeded: true,
    });
    expect(read.steps[2].condition).toMatchObject({
      state: "met",
      rule: "step 1: the output contains 'mode=slow'",
    });
    expect(read.nextStepId).toBe(report.id);
    // The runbook's values are still the latest.
    expect(
      read.effectiveValues.find((v: { name: string }) => v.name === "mode")
        .value,
    ).toBe("fast");
  });

  it("an output rule on a decision step reads the chosen ids (finding 6)", async () => {
    const { s, runbook } = await setupRunbook([
      WHICH_WAY,
      {
        title: "Go back",
        hostId: 1,
        command: "rollback",
        when: { step: 1, output: { type: "contains", text: "rollback" } },
      },
    ]);
    expect((await decide(s, runbook.steps[0], ["rollback"])).status).toBe(200);
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].condition).toMatchObject({
      state: "met",
      notNeeded: false,
    });
  });

  it("drops a decision's value while the step is not done (finding 10)", async () => {
    const { s, runbook } = await setupRunbook([
      WHICH_WAY,
      {
        title: "Go back",
        hostId: 1,
        command: "rollback",
        when: { value: "path", equals: "rollback" },
      },
    ]);
    const [decision] = runbook.steps;
    expect((await decide(s, decision, ["rollback"])).status).toBe(200);
    let shown = await view(s, runbook.id);
    expect(shown.steps[1].condition.state).toBe("met");

    expect(
      (await s.person("POST", `/steps/${decision.id}/reopen`, {})).status,
    ).toBe(200);
    expect(
      (await s.person("POST", `/steps/${decision.id}/skip`, {})).status,
    ).toBe(200);
    shown = await view(s, runbook.id);
    expect(
      shown.effectiveValues.map((value: { name: string }) => value.name),
    ).not.toContain("path");
    expect(shown.steps[1].condition).toMatchObject({
      state: "not-met",
      reason: "value path is not set",
    });
  });
});
