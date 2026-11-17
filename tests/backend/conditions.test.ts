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

const OWNER = { task: "T-24", agent: "session:abc", label: "Lead" };

const failing = async () => execResult("", { stderr: "boom", code: 1 });

/** Each step's condition state and whether it is needed, in order. */
async function states(s: TestServer, runbookId: number) {
  const shown = await view(s, runbookId);
  return shown.steps.map(
    (step: { condition: { state: string; notNeeded: boolean } | null }) =>
      step.condition
        ? `${step.condition.state}${step.condition.notNeeded ? " (not needed)" : ""}`
        : null,
  );
}

/** A deploy, its health check, and the way back when either failed. */
const WAY_BACK = [
  { title: "Deploy", hostId: 1, command: "deploy" },
  { title: "Health check", hostId: 1, command: "check" },
  {
    title: "Way back",
    hostId: 1,
    command: "rollback",
    when: {
      any: [
        { step: 1, status: "failed" },
        { step: 2, status: "failed" },
      ],
    },
  },
  { title: "Tell the team", hostId: 1, command: "notify" },
];

describe("when rules (T-024)", () => {
  it("keeps the rule by step number, and works its state out on each read", async () => {
    const { s, token, runbook } = await setupRunbook(WAY_BACK);
    const [deploy, check, back, tell] = runbook.steps;
    expect(runbook.steps[2].when).toEqual(WAY_BACK[2].when);
    expect(runbook.steps[2].condition).toMatchObject({
      state: "waiting",
      rule: "step 1 failed or step 2 failed",
      reason: "waiting for step 1",
      notNeeded: false,
    });

    await runStep(s, runbook.id, deploy.id);
    await runStep(s, runbook.id, check.id);
    let shown = await view(s, runbook.id);
    expect(shown.steps[2].condition).toEqual({
      state: "not-met",
      rule: "step 1 failed or step 2 failed",
      reason: "step 1 is done and step 2 is done",
      notNeeded: true,
    });
    // Not needed: the next step is after it, and the progress says so.
    expect(shown.nextStepId).toBe(tell.id);
    expect(shown.progress).toEqual({
      done: 2,
      failed: 0,
      total: 4,
      notNeeded: 1,
    });
    // It does not hold up the step after it.
    const told = await runStep(s, runbook.id, tell.id);
    expect(told.status).toBe(200);

    // The agent sees the same, with the rule by step number.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[2]).toMatchObject({
      when: WAY_BACK[2].when,
      condition: { state: "not-met", notNeeded: true },
    });
    expect(read.body.progress.notNeeded).toBe(1);

    // The list shows it too.
    const list = await s.person("GET", "/runbooks");
    expect(list.body[0].progress.notNeeded).toBe(1);

    // Reopen the health check and fail it: the way back is needed now.
    await s.person("POST", `/steps/${check.id}/reopen`);
    s.setExec(failing);
    await runStep(s, runbook.id, check.id, { confirmRepeat: true });
    shown = await view(s, runbook.id);
    expect(shown.steps[2].condition).toMatchObject({
      state: "met",
      reason: "step 2 failed",
      notNeeded: false,
    });
    expect(shown.nextStepId).toBe(back.id);
  });

  it("reads output with the check code, values filled in, and a value", async () => {
    const { s, runbook } = await setupRunbook(
      [
        {
          title: "Status",
          hostId: 1,
          command: "status",
          captures: [{ name: "mode", pattern: "mode: (\\S+)" }],
        },
        {
          title: "Turn on HTTPS",
          hostId: 1,
          command: "https on",
          when: {
            step: 1,
            output: { type: "contains", text: "{{feature}}: OFF" },
          },
        },
        {
          title: "Fast path",
          hostId: 1,
          command: "fast",
          when: { value: "mode", equals: "fast" },
        },
        {
          title: "Slow path",
          hostId: 1,
          command: "slow",
          when: {
            all: [
              { step: 1, output: { type: "value", name: "mode" } },
              { not: { value: "mode", matches: "^fast$" } },
            ],
          },
        },
      ],
      { values: { feature: "HTTPS certificates" } },
    );
    expect(await states(s, runbook.id)).toEqual([
      null,
      "waiting",
      "waiting",
      "waiting",
    ]);
    s.setExec(async () => execResult("HTTPS certificates: OFF\nmode: fast\n"));
    await runStep(s, runbook.id, runbook.steps[0].id);
    expect(await states(s, runbook.id)).toEqual([
      null,
      "met",
      "met",
      "not-met (not needed)",
    ]);
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].condition).toMatchObject({
      rule: "step 1: the output contains 'HTTPS certificates: OFF'",
      reason: "step 1: the output contains 'HTTPS certificates: OFF'",
    });
    expect(shown.steps[3].condition.reason).toBe("value mode matches /^fast$/");
  });

  it("refuses rules that name this step, a later step, or are too big", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const deep = {
      not: { not: { not: { not: { step: 1, status: "done" } } } },
    };
    const many = {
      any: Array.from({ length: 20 }, () => ({ step: 1, status: "done" })),
    };
    const bad: Array<[unknown, string]> = [
      [{ step: 2, status: "done" }, "is not before this step"],
      [{ step: 3, status: "done" }, "is not before this step"],
      [{ step: "1a", status: "done" }, "step 1a is not a step"],
      [{ step: 0, status: "done" }, "step must be a step number"],
      [{ step: 1, status: "finished" }, "status must be one of"],
      [{ step: 1, status: "done", extra: 1 }, 'unknown field "extra"'],
      [{ step: 1 }, "a rule must have all, any, not"],
      [{ any: [] }, "any must be a list of at least one rule"],
      [{ all: [{ step: 1, status: "done" }], not: {} }, "only field"],
      [deep, "at most 4 levels deep"],
      [many, "at most 20 rules"],
      [
        { step: 1, output: { type: "value", name: "nope" } },
        '"nope" is not a capture of step 1',
      ],
      [{ step: 1, output: { type: "matches", pattern: "(" } }, "output: "],
      [{ value: "bad name" }, "value must match"],
      ["step 1 failed", "a rule must be an object"],
    ];
    for (const [when, error] of bad) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        steps: [
          { title: "One", hostId: 1, command: "one" },
          { title: "Two", hostId: 1, command: "two", when },
          { title: "Three", hostId: 1, command: "three" },
        ],
      });
      expect(reply.status, JSON.stringify(when)).toBe(400);
      expect(reply.body.error, JSON.stringify(when)).toContain(error);
    }
  });

  it("asks before a person starts a step that is not needed, and logs a start anyway (D3)", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "Deploy", hostId: 1, command: "deploy" },
      { ...WAY_BACK[2], when: { step: 1, status: "failed" } },
      {
        title: "Check by hand",
        when: { step: 1, status: "failed" },
      },
    ]);
    const [deploy, back, byHand] = runbook.steps;
    await runStep(s, runbook.id, deploy.id);
    for (const mode of ["run", "terminal"] as const) {
      const refused = await runStep(s, runbook.id, back.id, {}, mode);
      expect(refused.status, mode).toBe(409);
      expect(refused.body).toMatchObject({
        code: "not-needed",
        rule: "step 1 failed",
        reason: "step 1 is done",
      });
    }
    const manual = await s.person("POST", `/steps/${byHand.id}/manual`, {
      outcome: "done",
    });
    expect(manual.status).toBe(409);
    expect(manual.body.code).toBe("not-needed");
    const anyway = await s.person("POST", `/steps/${byHand.id}/manual`, {
      outcome: "done",
      conditionAnyway: true,
    });
    expect(anyway.status).toBe(200);

    const ran = await runStep(s, runbook.id, back.id, {
      conditionAnyway: true,
    });
    expect(ran.status).toBe(200);
    expect(ran.body.status).toBe("done");
    expect(auditText(s)).toContain("runbooks_step_not_needed_started");
    expect(auditText(s)).toContain(
      "started although it is not needed (step 1 is done)",
    );
    // A step that ran is history: its rule no longer makes it not needed.
    expect(await states(s, runbook.id)).toEqual([null, "not-met", "not-met"]);
  });

  it("follows a replaced step to its replacement (D1)", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Health check", hostId: 1, command: "check" },
      { ...WAY_BACK[2], when: { step: 1, status: "failed" } },
    ]);
    const [check] = runbook.steps;
    s.setExec(failing);
    await runStep(s, runbook.id, check.id);
    expect(await states(s, runbook.id)).toEqual([null, "met"]);
    // The agent fixes the check; the fixed version passes.
    const amended = await s.agent("POST", `/steps/${check.id}/amend`, token, {
      kind: "replace",
      reason: "wrong port",
      step: { title: "Health check", hostId: 1, command: "check --port 8443" },
    });
    expect(amended.status).toBe(200);
    const fixed = amended.body.steps.find(
      (step: { label: string }) => step.label === "1a",
    );
    expect(await states(s, runbook.id)).toEqual([null, null, "waiting"]);
    s.setExec(async () => execResult("ok\n"));
    await runStep(s, runbook.id, fixed.id);
    const shown = await view(s, runbook.id);
    expect(shown.steps[2].condition).toMatchObject({
      state: "not-met",
      rule: "step 1a failed",
      reason: "step 1a is done",
      notNeeded: true,
    });
  });

  it("keeps a step a rule reads from being removed or moved after the rule", async () => {
    const { s, token, runbook } = await setupRunbook(WAY_BACK);
    const [deploy, check, back, tell] = runbook.steps;
    const removed = await s.agent("DELETE", `/steps/${check.id}`, token);
    expect(removed.status).toBe(409);
    expect(removed.body).toMatchObject({ code: "when" });
    expect(removed.body.error).toContain("step 3 has a when rule");
    const moved = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/reorder`,
      token,
      { stepIds: [deploy.id, back.id, check.id, tell.id] },
    );
    expect(moved.status).toBe(400);
    expect(moved.body.error).toContain("when rule");
    // A rule changes with update_step, checked against the steps there.
    const patched = await s.agent("PATCH", `/steps/${tell.id}`, token, {
      when: { step: 3, status: "not-needed" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.steps[3].when).toEqual({
      step: 3,
      status: "not-needed",
    });
    const later = await s.agent("PATCH", `/steps/${check.id}`, token, {
      when: { step: 4, status: "done" },
    });
    expect(later.status).toBe(400);
    const cleared = await s.agent("PATCH", `/steps/${tell.id}`, token, {
      when: null,
    });
    expect(cleared.body.steps[3]).toMatchObject({
      when: null,
      condition: null,
    });
  });

  it("an agent step that is not needed gets no agent-turn and cannot be completed", async () => {
    const { s, token, runbook } = await setupRunbook(
      [
        { title: "Deploy", hostId: 1, command: "deploy" },
        {
          title: "Find out why",
          owner: "agent",
          when: { step: 1, status: "failed" },
        },
        { title: "Write it up", owner: "agent" },
      ],
      { owner: OWNER },
    );
    const [deploy, why, writeUp] = runbook.steps;
    await runStep(s, runbook.id, deploy.id);
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    const turns = (read.body.events as Array<{ type: string; stepId: number }>)
      .filter((event) => event.type === "agent-turn")
      .map((event) => event.stepId);
    expect(turns).toEqual([writeUp.id]);
    expect(read.body.nextStepId).toBe(writeUp.id);
    const tried = await s.agent("POST", `/steps/${why.id}/complete`, token, {
      outcome: "done",
    });
    expect(tried.status).toBe(409);
    expect(tried.body.code).toBe("not-needed");
    const done = await s.agent("POST", `/steps/${writeUp.id}/complete`, token, {
      outcome: "done",
    });
    expect(done.status).toBe(200);
  });

  it("MCP tools take when", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const created = await server.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_runbook",
        arguments: { title: "MCP", steps: WAY_BACK },
      },
    });
    expect(created.body.result.isError).toBe(false);
    const runbook = JSON.parse(created.body.result.content[0].text);
    expect(runbook.steps[2]).toMatchObject({
      when: WAY_BACK[2].when,
      condition: { state: "waiting" },
    });
  });
});
