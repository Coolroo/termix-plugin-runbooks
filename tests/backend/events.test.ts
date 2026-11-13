import { describe, expect, it, vi } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type ServerOptions,
  type FakeChannel,
  type TestServer,
} from "./helpers";

const startServer = useTestServer();

const setup = (
  steps: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
  server: ServerOptions = {},
) =>
  setupRunbook(steps, {
    title: "Events",
    owner: { task: "T-1", agent: "session-1", label: "Lead" },
    extra,
    server,
  });

/** The runbook's events as an agent reads them, oldest first. */
async function eventsOf(s: TestServer, token: string, runbookId: number) {
  const read = await s.agent("GET", `/runbooks/${runbookId}`, token);
  expect(read.status).toBe(200);
  return [...read.body.events].reverse() as Array<Record<string, unknown>>;
}

const brief = (events: Array<Record<string, unknown>>) =>
  events.map((event) => [event.type, event.stepPosition, event.reason]);

const failing = async () => execResult("", { stderr: "boom", code: 1 });

describe("agent-turn", () => {
  it("is recorded when an agent step becomes the next step, once", async () => {
    const { s, token, runbook } = await setup([
      { title: "Person 1", hostId: 1, command: "uptime" },
      { title: "Agent 2", owner: "agent" },
      { title: "Person 3", hostId: 1, command: "df" },
      { title: "Agent 4", owner: "agent" },
    ]);
    const [p1, a2, p3] = runbook.steps;
    // Creating the runbook is not an event.
    expect(await eventsOf(s, token, runbook.id)).toEqual([]);

    const ran = await runStep(s, runbook.id, p1.id);
    expect(ran.body.status).toBe("done");
    let events = await eventsOf(s, token, runbook.id);
    expect(brief(events)).toEqual([["agent-turn", 2, null]]);
    expect(events[0]).toMatchObject({
      stepId: a2.id,
      createdBy: "alice",
      note: null,
    });

    // The agent's own step ending done makes a person step next: nothing.
    await s.agent("POST", `/steps/${a2.id}/complete`, token, {
      outcome: "done",
    });
    expect(await eventsOf(s, token, runbook.id)).toHaveLength(1);

    // Skipping step 3 makes agent step 4 next.
    await s.person("POST", `/steps/${p3.id}/skip`, { reason: "not needed" });
    events = await eventsOf(s, token, runbook.id);
    expect(brief(events).at(-1)).toEqual(["agent-turn", 4, null]);

    // Reopening the agent's step 2 makes it the agent's turn again.
    await s.person("POST", `/steps/${a2.id}/reopen`);
    events = await eventsOf(s, token, runbook.id);
    expect(brief(events).at(-1)).toEqual(["agent-turn", 2, null]);
    expect(events).toHaveLength(3);
  });

  it("is recorded when a runbook with an agent step next is reopened", async () => {
    const { s, token, runbook } = await setup([
      { title: "Agent 1", owner: "agent" },
    ]);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "abandoned",
    });
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "open",
    });
    expect(brief(await eventsOf(s, token, runbook.id))).toEqual([
      ["runbook-done", null, "abandoned"],
      ["agent-turn", 1, null],
    ]);
  });
});

describe("step-failed", () => {
  it("says why: exit, check, manual and a failed agent step", async () => {
    const { s, token, runbook } = await setup([
      { title: "Exit", hostId: 1, command: "false" },
      {
        title: "Check",
        hostId: 1,
        command: "echo nope",
        checks: [{ type: "contains", text: "yes" }],
      },
      { title: "Terminal", hostId: 1, command: "uptime" },
      { title: "By hand" },
      { title: "Agent", owner: "agent" },
      {
        title: "Agent check",
        owner: "agent",
        checks: [{ type: "contains", text: "ok" }],
      },
    ]);
    const [exit, check, terminal, byHand, agent, agentCheck] = runbook.steps;
    s.setExec(failing);
    await runStep(s, runbook.id, exit.id);
    s.setExec(async () => execResult("nope\n"));
    await runStep(s, runbook.id, check.id);
    const sent = await runStep(s, runbook.id, terminal.id, {}, "terminal");
    await s.person("POST", `/runs/${sent.body.id}/complete`, {
      outcome: "failed",
      pastedOutput: "",
    });
    await s.person("POST", `/steps/${byHand.id}/manual`, {
      outcome: "failed",
    });
    await s.agent("POST", `/steps/${agent.id}/complete`, token, {
      outcome: "failed",
      note: "could not",
    });
    await s.agent("POST", `/steps/${agentCheck.id}/complete`, token, {
      outcome: "done",
      output: "bad",
    });
    const events = await eventsOf(s, token, runbook.id);
    expect(brief(events)).toEqual([
      ["step-failed", 1, "exit"],
      ["step-failed", 2, "check"],
      ["step-failed", 3, "manual"],
      ["step-failed", 4, "manual"],
      ["agent-turn", 5, null],
      ["step-failed", 5, "manual"],
      ["agent-turn", 6, null],
      ["step-failed", 6, "check"],
    ]);
    expect(events[5].createdBy).toBe("lead");
  });

  it("says stopped when a person stops the run", async () => {
    const { s, token, runbook } = await setup([
      { title: "Tail", hostId: 1, command: "tail -f log" },
    ]);
    let channel: FakeChannel | null = null;
    s.setChannel((opened) => (channel = opened));
    const stepId = runbook.steps[0].id;
    await runStep(s, runbook.id, stepId, {}, "run", { wait: false });
    await vi.waitFor(() => expect(channel).not.toBeNull());
    await s.person("POST", `/steps/${stepId}/stop`);
    expect(brief(await eventsOf(s, token, runbook.id))).toEqual([
      ["step-failed", 1, "stopped"],
    ]);
  });

  it("says secret when a secret capture finds nothing", async () => {
    const { s, token, runbook } = await setup(
      [
        {
          title: "Token",
          hostId: 1,
          command: "make-token",
          secretCaptures: [{ name: "api", pattern: "^token: (\\S+)$" }],
        },
      ],
      {},
      { secrets: true },
    );
    s.setExec(async () => execResult("no token here\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("failed");
    expect(brief(await eventsOf(s, token, runbook.id))).toEqual([
      ["step-failed", 1, "secret"],
    ]);
  });

  it("says interrupted for a run a restart left running", async () => {
    const at = new Date().toISOString();
    const server = await startServer({
      seed: (db) => {
        db.sqlite
          .prepare(
            `INSERT INTO p_runbooks_runbooks (id, title, summary, status, "values", created_by, created_by_user_id, created_at, updated_at, revision)
             VALUES (1, 'Old', '', 'open', '{}', 'lead', 'alice', ?, ?, 1)`,
          )
          .run(at, at);
        db.sqlite
          .prepare(
            `INSERT INTO p_runbooks_steps (id, runbook_id, position, title, body, host_id, command, expect, captures, hide_output_from_agents, status, owner_note, revision, created_at, updated_at)
             VALUES (1, 1, 1, 'Long', '', 1, 'make', '', '[]', 0, 'pending', '', 1, ?, ?)`,
          )
          .run(at, at);
        db.sqlite
          .prepare(
            `INSERT INTO p_runbooks_steps (id, runbook_id, position, title, body, host_id, command, expect, captures, hide_output_from_agents, status, owner_note, revision, created_at, updated_at, owner)
             VALUES (2, 1, 2, 'Agent', '', NULL, NULL, '', '[]', 0, 'pending', '', 1, ?, ?, 'agent')`,
          )
          .run(at, at);
        db.sqlite
          .prepare(
            `INSERT INTO p_runbooks_runs (id, step_id, runbook_id, mode, status, host_id, command, command_hash, user_id, started_at, stdout, stderr, truncated, timed_out)
             VALUES (1, 1, 1, 'exec', 'running', 1, 'make', 'h', 'alice', ?, '', '', 0, 0)`,
          )
          .run(at);
      },
    });
    const token = await server.makeToken("lead");
    expect(brief(await eventsOf(server, token, 1))).toEqual([
      ["step-failed", 1, "interrupted"],
      ["agent-turn", 2, null],
    ]);
    const events = await eventsOf(server, token, 1);
    expect(events[0].createdBy).toBe("termix");
  });
});

describe("runbook-done and step-done", () => {
  it("records runbook-done with its reason, from a person or the agent", async () => {
    const { s, token, runbook } = await setup([{ title: "One" }]);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    // The same status again changes nothing.
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      status: "open",
    });
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      status: "abandoned",
    });
    const events = await eventsOf(s, token, runbook.id);
    expect(brief(events)).toEqual([
      ["runbook-done", null, "done"],
      ["runbook-done", null, "abandoned"],
    ]);
    expect(events.map((event) => event.createdBy)).toEqual(["alice", "lead"]);
  });

  it("records step-done only when notify lists it", async () => {
    const { s, token, runbook } = await setup([
      { title: "One" },
      { title: "Two" },
    ]);
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.notify).toEqual([
      "agent-turn",
      "step-failed",
      "runbook-done",
      "sent",
    ]);
    await s.person("POST", `/steps/${runbook.steps[0].id}/manual`, {
      outcome: "done",
    });
    expect(await eventsOf(s, token, runbook.id)).toEqual([]);
    const changed = await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      notify: ["step-done", "step-failed", "step-done"],
    });
    expect(changed.body.notify).toEqual(["step-done", "step-failed"]);
    await s.person("POST", `/steps/${runbook.steps[1].id}/manual`, {
      outcome: "done",
    });
    expect(brief(await eventsOf(s, token, runbook.id))).toEqual([
      ["step-done", 2, null],
    ]);
    // null puts the default back.
    const reset = await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      notify: null,
    });
    expect(reset.body.notify).toContain("agent-turn");
  });

  it("refuses an unknown notify type", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    for (const notify of [["everything"], "step-done", [1]]) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        notify,
      });
      expect(reply.status, JSON.stringify(notify)).toBe(400);
    }
  });
});

describe("no event", () => {
  it("for notes, hiding, agent edits, a start, or a person step next", async () => {
    const { s, token, runbook } = await setup([
      { title: "One", hostId: 1, command: "uptime" },
      { title: "Two", hostId: 1, command: "df" },
    ]);
    const [one, two] = runbook.steps;
    await s.person("POST", `/steps/${one.id}/note`, { ownerNote: "hi" });
    await s.person("POST", `/steps/${one.id}/hide`, { hidden: true });
    await s.agent("PATCH", `/steps/${two.id}`, token, { title: "Two!" });
    await s.agent("POST", `/runbooks/${runbook.id}/steps`, token, {
      steps: [{ title: "Three" }],
    });
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      summary: "new",
    });
    await runStep(s, runbook.id, one.id);
    await s.person("POST", `/steps/${two.id}/skip`, {});
    await s.person("POST", `/steps/${two.id}/reopen`);
    expect(await eventsOf(s, token, runbook.id)).toEqual([]);
  });
});

describe("GET /agent/events", () => {
  it("lists the token's events after an id, oldest first, a page at a time", async () => {
    const { s, token, runbook } = await setup([
      { title: "Fail", hostId: 1, command: "false" },
      { title: "Agent", owner: "agent" },
    ]);
    s.setExec(failing);
    await runStep(s, runbook.id, runbook.steps[0].id);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });

    const all = await s.agent("GET", "/events", token);
    expect(all.status).toBe(200);
    expect(all.body.events.map((e: { type: string }) => e.type)).toEqual([
      "step-failed",
      "agent-turn",
      "runbook-done",
    ]);
    expect(all.body.events[0]).toMatchObject({
      runbookId: runbook.id,
      stepId: runbook.steps[0].id,
      stepPosition: 1,
      reason: "exit",
      openPath: `/?view=runbook&id=${runbook.id}`,
    });
    expect(all.body.next).toBe(all.body.events[2].id);

    const page = await s.agent("GET", "/events?limit=1", token);
    expect(page.body.events).toHaveLength(1);
    const rest = await s.agent(
      "GET",
      `/events?since=${page.body.next}&limit=50`,
      token,
    );
    expect(rest.body.events).toHaveLength(2);
    const none = await s.agent("GET", `/events?since=${all.body.next}`, token);
    expect(none.body).toEqual({ events: [], next: all.body.next });
    expect((await s.agent("GET", "/events?since=-1", token)).status).toBe(400);

    // Another person's token sees none of them.
    const bob = await s.makeToken("bob-agent", "bob");
    expect((await s.agent("GET", "/events", bob)).body.events).toEqual([]);

    // MCP list_events answers the same.
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_events", arguments: { since: 0, limit: 2 } },
    });
    expect(mcp.body.result.isError).toBe(false);
    expect(mcp.body.result.structuredContent.events).toHaveLength(2);

    // A runbook's read lists its events newest first.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.events.map((e: { type: string }) => e.type)).toEqual([
      "runbook-done",
      "agent-turn",
      "step-failed",
    ]);
    // The person's view is unchanged by events.
    expect((await view(s, runbook.id)).steps).toHaveLength(2);
  });
});
