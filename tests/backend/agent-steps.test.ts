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

const OWNER = { task: "T-7", agent: "session:abc", label: "Lead agent" };

const setup = (
  steps: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => setupRunbook(steps, { title: "Mixed", owner: OWNER, extra });

const complete = (
  s: TestServer,
  token: string,
  stepId: number,
  body: Record<string, unknown>,
) => s.agent("POST", `/steps/${stepId}/complete`, token, body);

describe("who a runbook belongs to", () => {
  it("keeps the owner the agent sets, shows it to the person and lets the agent change it", async () => {
    const { s, token, runbook } = await setup([{ title: "Look" }]);
    expect(runbook.owner).toEqual(OWNER);
    const shown = await view(s, runbook.id);
    expect(shown.owner).toEqual(OWNER);
    expect(shown.agentLabel).toBe("Lead agent");

    const changed = await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      owner: { task: "T-8" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.owner).toEqual({ task: "T-8" });
    // Without a label the person sees the token's name.
    expect((await view(s, runbook.id)).agentLabel).toBe("lead");

    const cleared = await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      owner: null,
    });
    expect(cleared.body.owner).toBeNull();
  });

  it("refuses an owner with unknown fields, long fields or control characters", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const bad = [
      { owner: { who: "x" } },
      { owner: { task: "T".repeat(65) } },
      { owner: { agent: "a".repeat(201) } },
      { owner: { label: "l".repeat(81) } },
      { owner: { label: "two\nlines" } },
      { owner: "lead" },
    ];
    for (const extra of bad) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        ...extra,
      });
      expect(reply.status, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe("agent steps", () => {
  it("take a command without a host and refuse what only a run can use", async () => {
    const { s, token, runbook } = await setup([
      { title: "Read the dashboard", owner: "agent", command: "curl -s x" },
    ]);
    expect(runbook.steps[0]).toMatchObject({
      owner: "agent",
      command: "curl -s x",
      hostId: null,
    });
    const refused = [
      { captures: [{ name: "v", pattern: "(x)" }] },
      { secretCaptures: [{ name: "s", pattern: "(x)" }] },
      { stdin: { from: "value", name: "x" } },
      { waitAfterPreviousSeconds: 10 },
      { checks: [{ type: "exitCode", equals: 0 }] },
      { checks: [{ type: "value", name: "v" }] },
    ];
    for (const extra of refused) {
      const reply = await s.agent(
        "POST",
        `/runbooks/${runbook.id}/steps`,
        token,
        {
          steps: [{ title: "Agent", owner: "agent", command: "x", ...extra }],
        },
      );
      expect(reply.status, JSON.stringify(extra)).toBe(400);
    }
    // A person step that turns into an agent step is checked the same way.
    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [
          {
            title: "Person",
            hostId: 1,
            command: "uptime",
            captures: [{ name: "up", pattern: "up (\\d+)" }],
          },
        ],
      },
    );
    const personStep = added.body.steps[1];
    const turned = await s.agent("PATCH", `/steps/${personStep.id}`, token, {
      owner: "agent",
    });
    expect(turned.status).toBe(400);
    expect(turned.body.error).toContain("captures");
    const bad = await s.agent("PATCH", `/steps/${personStep.id}`, token, {
      owner: "robot",
    });
    expect(bad.status).toBe(400);
  });

  it("cannot be run, sent or marked by a person, but can be skipped and reopened", async () => {
    const { s, runbook } = await setup([
      { title: "Agent work", owner: "agent", hostId: 1, command: "uptime" },
      { title: "Agent note", owner: "agent" },
    ]);
    const [agentCmd, agentNote] = runbook.steps;
    const run = await runStep(s, runbook.id, agentCmd.id);
    expect(run.status).toBe(409);
    expect(run.body.code).toBe("agent-step");
    const send = await runStep(s, runbook.id, agentCmd.id, {}, "terminal");
    expect(send.status).toBe(409);
    expect(send.body.code).toBe("agent-step");
    const manual = await s.person("POST", `/steps/${agentNote.id}/manual`, {
      outcome: "done",
    });
    expect(manual.status).toBe(409);
    expect(manual.body.code).toBe("agent-step");
    expect(s.execCalls).toHaveLength(0);

    const shown = await view(s, runbook.id);
    expect(shown.steps[0]).toMatchObject({
      owner: "agent",
      resolvedCommand: "uptime",
      commandHash: null,
    });

    const skipped = await s.person("POST", `/steps/${agentCmd.id}/skip`, {
      reason: "done by hand",
    });
    expect(skipped.body.steps[0].status).toBe("skipped");
    const reopened = await s.person("POST", `/steps/${agentCmd.id}/reopen`);
    expect(reopened.body.steps[0].status).toBe("pending");
  });
});

describe("complete_step", () => {
  it("records a run in mode agent with the note and output", async () => {
    const { s, token, runbook } = await setup([
      { title: "Agent work", owner: "agent", command: "make check" },
      { title: "Person", hostId: 1, command: "uptime" },
    ]);
    const stepId = runbook.steps[0].id;
    const done = await complete(s, token, stepId, {
      outcome: "done",
      note: "all green",
      output: "42 passed\n",
    });
    expect(done.status).toBe(200);
    expect(done.body.steps[0].status).toBe("done");
    expect(done.body.steps[0].runs[0]).toMatchObject({
      mode: "agent",
      status: "done",
      userId: "lead",
      hostId: null,
      note: "all green",
      stdout: "42 passed\n",
      exitCode: null,
      checks: null,
    });
    expect(done.body.nextStepId).toBe(runbook.steps[1].id);
    expect(auditText(s)).toContain("runbooks_step_agent_complete");

    // The person sees the run too.
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].runs[0]).toMatchObject({
      mode: "agent",
      note: "all green",
    });

    // Once ended, it stays ended for the agent.
    const again = await complete(s, token, stepId, { outcome: "failed" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ended");

    // A person reopens it; then it is the agent's turn again.
    await s.person("POST", `/steps/${stepId}/reopen`);
    const failed = await complete(s, token, stepId, {
      outcome: "failed",
      note: "flaky",
    });
    expect(failed.status).toBe(200);
    expect(failed.body.steps[0].status).toBe("failed");
    expect(failed.body.steps[0].runs).toHaveLength(2);
  });

  it("is refused for a person's step, before its turn, and on a closed runbook", async () => {
    const { s, token, runbook } = await setup([
      { title: "Person", hostId: 1, command: "uptime" },
      { title: "Agent", owner: "agent" },
    ]);
    const [personStep, agentStep] = runbook.steps;
    const person = await complete(s, token, personStep.id, { outcome: "done" });
    expect(person.status).toBe(403);
    expect(person.body.code).toBe("person-step");

    const early = await complete(s, token, agentStep.id, { outcome: "done" });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("order");
    expect(early.body.blocking).toEqual([
      { id: personStep.id, position: 1, label: "1", title: "Person" },
    ]);

    // A failed earlier step has ended: it is the agent's turn.
    s.setExec(async () => execResult("", { stderr: "boom", code: 1 }));
    const ran = await runStep(s, runbook.id, personStep.id);
    expect(ran.body.status).toBe("failed");
    const now = await complete(s, token, agentStep.id, { outcome: "done" });
    expect(now.status).toBe(200);

    await s.person("POST", `/steps/${agentStep.id}/reopen`);
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      status: "done",
    });
    const closed = await complete(s, token, agentStep.id, { outcome: "done" });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe("closed");

    // Another person's token sees no such step.
    const other = await s.makeToken("other", "bob");
    const hidden = await complete(s, other, agentStep.id, { outcome: "done" });
    expect(hidden.status).toBe(404);
  });

  it("tests the step's checks on the output", async () => {
    const { s, token, runbook } = await setup([
      {
        title: "Agent",
        owner: "agent",
        checks: [
          { type: "contains", text: "healthy", label: "is healthy" },
          { type: "notMatches", pattern: "^ERROR" },
        ],
      },
      {
        title: "Agent again",
        owner: "agent",
        checks: [{ type: "contains", text: "ok" }],
      },
    ]);
    const failed = await complete(s, token, runbook.steps[0].id, {
      outcome: "done",
      output: "ERROR: disk\n",
    });
    expect(failed.body.steps[0].status).toBe("failed");
    expect(failed.body.steps[0].runs[0].checks).toEqual([
      { label: "is healthy", ok: false, detail: expect.any(String) },
      { label: expect.any(String), ok: false, detail: expect.any(String) },
    ]);
    const passed = await complete(s, token, runbook.steps[1].id, {
      outcome: "done",
      output: "ok\n",
    });
    expect(passed.body.steps[1].status).toBe("done");
    expect(passed.body.steps[1].runs[0].checks[0].ok).toBe(true);
  });

  it("refuses a bad body", async () => {
    const { s, token, runbook } = await setup([
      { title: "Agent", owner: "agent" },
    ]);
    const id = runbook.steps[0].id;
    const bad = [
      {},
      { outcome: "skipped" },
      { outcome: "done", note: "n".repeat(2001) },
      { outcome: "done", output: "o".repeat(65_537) },
      { outcome: "done", output: 5 },
      { outcome: "done", extra: true },
    ];
    for (const body of bad) {
      const reply = await complete(s, token, id, body);
      expect(reply.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const ok = await complete(s, token, id, {
      outcome: "done",
      output: "o".repeat(65_536),
    });
    expect(ok.status).toBe(200);
  });

  it("works over MCP", async () => {
    const { s, token, runbook } = await setup([
      { title: "Agent", owner: "agent" },
    ]);
    const tools = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = tools.body.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toContain("complete_step");
    const call = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "complete_step",
        arguments: {
          stepId: runbook.steps[0].id,
          outcome: "done",
          note: "did it",
        },
      },
    });
    expect(call.body.result.isError).toBe(false);
    expect(call.body.result.structuredContent.steps[0].status).toBe("done");
    const refused = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "complete_step",
        arguments: { stepId: runbook.steps[0].id, outcome: "done" },
      },
    });
    expect(refused.body.result.isError).toBe(true);
    expect(refused.body.result.content[0].text).toContain("409");
  });
});
