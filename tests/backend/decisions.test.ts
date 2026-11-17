import { describe, expect, it } from "vitest";
import {
  auditText,
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type TestServer,
} from "./helpers";

const startServer = useTestServer();

const WHICH_WAY = {
  title: "Which way do we go?",
  body: "Step 1 failed. Choose how to go on.",
  decision: {
    options: [
      {
        id: "retry",
        label: "Fix it and try again",
        description: "The agent amends step 1.",
      },
      { id: "rollback", label: "Go back to the old release" },
      { id: "stop", label: "Stop here" },
    ],
    value: "path",
  },
};

const STEPS = [
  WHICH_WAY,
  {
    title: "Roll back",
    hostId: 1,
    command: "deploy --way {{path}}",
    when: { step: 1, chose: "rollback" },
  },
  {
    title: "Try again",
    when: {
      any: [
        { step: 1, chose: "retry" },
        { step: 1, status: "skipped" },
      ],
    },
  },
];

const decide = (
  s: TestServer,
  step: { id: number; revision: number },
  chosen: unknown,
  extra: Record<string, unknown> = {},
) =>
  s.person("POST", `/steps/${step.id}/decide`, {
    revision: step.revision,
    chosen,
    ...extra,
  });

/** Each step's condition state, or its status when it has no rule. */
async function states(s: TestServer, runbookId: number) {
  const shown = await view(s, runbookId);
  return shown.steps.map(
    (step: {
      status: string;
      condition: { state: string; notNeeded: boolean } | null;
    }) =>
      step.condition
        ? `${step.condition.state}${step.condition.notNeeded ? " (not needed)" : ""}`
        : step.status,
  );
}

describe("decision steps (T-025)", () => {
  it("records the choice as a decision run, sets the value and drives the rules", async () => {
    const { s, token, runbook } = await setupRunbook(STEPS);
    const [which] = runbook.steps;
    expect(which.decision).toEqual({
      options: [
        {
          id: "retry",
          label: "Fix it and try again",
          description: "The agent amends step 1.",
        },
        {
          id: "rollback",
          label: "Go back to the old release",
          description: null,
        },
        { id: "stop", label: "Stop here", description: null },
      ],
      multiple: false,
      min: 1,
      max: 1,
      value: "path",
    });
    expect(runbook.steps[1].condition.rule).toBe(
      "step 1: you chose 'Go back to the old release'",
    );
    expect(await states(s, runbook.id)).toEqual([
      "pending",
      "waiting",
      "waiting",
    ]);

    const bad: Array<[unknown, string]> = [
      [[], "choose exactly one option"],
      [["retry", "stop"], "choose exactly one option"],
      [["nope"], '"nope" is not an option'],
      ["rollback", "chosen must be a list of option ids"],
    ];
    for (const [chosen, error] of bad) {
      const reply = await decide(s, which, chosen);
      expect(reply.status, JSON.stringify(chosen)).toBe(400);
      expect(reply.body.error).toBe(error);
    }
    const stale = await decide(s, { ...which, revision: 9 }, ["rollback"]);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale");

    const chosen = await decide(s, which, ["rollback"]);
    expect(chosen.status).toBe(200);
    const shown = chosen.body.steps[0];
    expect(shown).toMatchObject({
      status: "done",
      choice: { chosen: ["rollback"], by: "alice" },
    });
    expect(shown.runs[0]).toMatchObject({
      mode: "decision",
      status: "done",
      hostId: null,
      stdout: "rollback\n",
      captured: { path: "rollback" },
    });
    expect(await states(s, runbook.id)).toEqual([
      "done",
      "met",
      "not-met (not needed)",
    ]);
    // The value fills a later command.
    const after = await view(s, runbook.id);
    expect(after.steps[1].resolvedCommand).toBe("deploy --way rollback");
    expect(after.nextStepId).toBe(runbook.steps[1].id);
    expect(auditText(s)).toContain("step 1: chose rollback");

    // The agent sees the options and the choice.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[0]).toMatchObject({
      decision: { value: "path" },
      choice: { chosen: ["rollback"] },
    });

    // Confirm again only after Reopen; Done by hand is not for a decision.
    const again = await decide(s, which, ["stop"]);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ended");
    const manual = await s.person("POST", `/steps/${which.id}/manual`, {
      outcome: "done",
    });
    expect(manual.status).toBe(400);
    expect(manual.body.code).toBe("decision");
  });

  it("takes several options in the author's order within min and max", async () => {
    const { s, runbook } = await setupRunbook([
      {
        title: "What changed?",
        decision: {
          options: [
            { id: "dns", label: "DNS" },
            { id: "tls", label: "TLS" },
            { id: "app", label: "The app" },
          ],
          multiple: true,
          min: 1,
          max: 2,
          value: "changed",
        },
      },
      {
        title: "Both",
        when: {
          all: [
            { step: 1, chose: "dns" },
            { step: 1, chose: "tls" },
          ],
        },
      },
    ]);
    const [what] = runbook.steps;
    const tooMany = await decide(s, what, ["dns", "tls", "app"]);
    expect(tooMany.body.error).toBe("choose 1 to 2 options");
    const ok = await decide(s, what, ["tls", "dns"]);
    expect(ok.body.steps[0].runs[0]).toMatchObject({
      stdout: "dns\ntls\n",
      captured: { changed: "dns,tls" },
    });
    expect(await states(s, runbook.id)).toEqual(["done", "met"]);
  });

  it("Reopen lets the person choose again and names the steps that ran on the old choice (D8)", async () => {
    const { s, runbook } = await setupRunbook(STEPS);
    const [which, back] = runbook.steps;
    await decide(s, which, ["rollback"]);
    s.setExec(async () => execResult("rolled back\n"));
    await runStep(s, runbook.id, back.id);
    let shown = await view(s, runbook.id);
    expect(shown.steps[0].decisionRan).toEqual([
      { id: back.id, position: 2, label: "2", title: "Roll back" },
    ]);

    const reopened = await s.person("POST", `/steps/${which.id}/reopen`);
    expect(reopened.body.steps[0]).toMatchObject({
      status: "pending",
      choice: null,
    });
    const revision = reopened.body.steps[0].revision;
    await decide(s, { id: which.id, revision }, ["retry"]);
    shown = await view(s, runbook.id);
    // The step that ran stays as it was; the other one follows the choice.
    expect(shown.steps[1].status).toBe("done");
    expect(shown.steps[1].condition).toMatchObject({
      state: "not-met",
      notNeeded: false,
    });
    expect(shown.steps[2].condition).toMatchObject({
      state: "met",
      reason: "step 1: you chose 'Fix it and try again'",
    });
  });

  it("a skipped decision matches no chose rule", async () => {
    const { s, runbook } = await setupRunbook(STEPS);
    await s.person("POST", `/steps/${runbook.steps[0].id}/skip`, {
      reason: "not now",
    });
    expect(await states(s, runbook.id)).toEqual([
      "skipped",
      "not-met (not needed)",
      "met",
    ]);
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].condition.reason).toBe("step 1 has no choice");
  });

  it("refuses a decision that is not well formed, and chose rules that do not fit", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const options = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ decision: { options: [options[0]] } }, "a list of 2 to 10 options"],
      [{ decision: { options: [options[0], options[0]] } }, 'the id "a" twice'],
      [
        { decision: { options: [{ id: "A b", label: "x" }, options[1]] } },
        "id must be 1 to 40 of a-z, 0-9 and -",
      ],
      [
        {
          decision: { options: [{ id: "a", label: "two\nlines" }, options[1]] },
        },
        "label must be one line",
      ],
      [{ decision: { options, min: 1 } }, "need multiple: true"],
      [
        { decision: { options, multiple: true, min: 2, max: 1 } },
        "min is more than decision.max",
      ],
      [
        { decision: { options, multiple: true, max: 3 } },
        "more than the 2 options",
      ],
      [
        { decision: { options, value: "bad name" } },
        "decision.value must match",
      ],
      [{ decision: { options, extra: 1 } }, 'unknown field "extra"'],
      [
        { decision: { options }, hostId: 1, command: "x" },
        "a decision step cannot have command",
      ],
      [
        { decision: { options }, waitAfterPreviousSeconds: 5 },
        "cannot have a wait timer",
      ],
      [
        { decision: { options }, owner: "agent" },
        "a decision step is for a person",
      ],
    ];
    for (const [step, error] of bad) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        steps: [{ title: "Choose", ...step }],
      });
      expect(reply.status, JSON.stringify(step)).toBe(400);
      expect(reply.body.error, JSON.stringify(step)).toContain(error);
    }
    const rules: Array<[unknown, string]> = [
      [{ step: 1, chose: "c" }, '"c" is not an option of step 1'],
      [{ step: 2, chose: "a" }, "step 2 is not a decision step"],
      [{ step: 1, chose: "A" }, "chose must be an option id"],
    ];
    for (const [when, error] of rules) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad rule",
        steps: [
          { title: "Choose", decision: { options } },
          { title: "Look", hostId: 1, command: "look" },
          { title: "Then", when },
        ],
      });
      expect(reply.status, JSON.stringify(when)).toBe(400);
      expect(reply.body.error, JSON.stringify(when)).toContain(error);
    }
  });

  it("step-done carries the choice when the agent asks for it", async () => {
    const { s, token, runbook } = await setupRunbook([WHICH_WAY], {
      owner: { task: "T-25", agent: "session", label: "Lead" },
      extra: { notify: ["step-done"] },
    });
    await decide(s, runbook.steps[0], ["stop"]);
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(
      (read.body.events as Array<{ type: string; note: string }>).find(
        (event) => event.type === "step-done",
      ),
    ).toMatchObject({ note: "chose stop" });
  });
});
