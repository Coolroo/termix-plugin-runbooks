import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSIONS,
  agentRunbook,
  auditText,
  execResult,
  FakeChannel,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  waitForRun,
  type TestServer,
} from "./helpers";

const startServer = useTestServer();

const OWNER = { task: "T-42", agent: "session:abc", label: "Lead agent" };

const setup = (steps: Array<Record<string, unknown>>) =>
  setupRunbook(steps, { title: "Fix things", owner: OWNER });

const amend = (
  s: TestServer,
  token: string,
  stepId: number,
  body: Record<string, unknown>,
) => s.agent("POST", `/steps/${stepId}/amend`, token, body);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const labels = (runbook: any) => runbook.steps.map((s: any) => s.label);

const FIX = {
  title: "Restart, fixed",
  hostId: 1,
  command: "systemctl restart app.service",
};

describe("amend a step with a fixed version (replace)", () => {
  it("replaces a failed step: 1a after step 1, step 1 replaced with its runs, later steps keep their numbers", async () => {
    const { s, token, runbook } = await setup([
      { title: "Restart", hostId: 1, command: "systemctl restart app" },
      { title: "Check", hostId: 1, command: "systemctl is-active app" },
    ]);
    s.setExec(async () => execResult("", { code: 1 }));
    await runStep(s, runbook.id, runbook.steps[0].id);

    const reply = await amend(s, token, runbook.steps[0].id, {
      kind: "replace",
      reason: "the unit is app.service",
      step: FIX,
    });
    expect(reply.status).toBe(200);
    expect(labels(reply.body)).toEqual(["1", "1a", "2"]);
    const [old, fixed, check] = reply.body.steps;
    expect(old).toMatchObject({
      status: "replaced",
      replacedBy: { id: fixed.id, label: "1a" },
    });
    expect(old.runs).toHaveLength(1);
    expect(fixed).toMatchObject({
      position: 1,
      suffix: "a",
      status: "pending",
      command: FIX.command,
      amendment: {
        kind: "replace",
        reason: "the unit is app.service",
        by: "lead",
        stepId: old.id,
        stepLabel: "1",
        oldCommand: "systemctl restart app",
      },
    });
    expect(check).toMatchObject({ id: runbook.steps[1].id, position: 2 });
    expect(reply.body.nextStepId).toBe(fixed.id);

    // The person sees the same, and the list says "amended" until it ran.
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].amendment.oldCommand).toBe("systemctl restart app");
    let list = await s.person("GET", "/runbooks");
    expect(list.body[0].amendedPending).toBe(1);
    s.setExec(async () => execResult());
    expect((await runStep(s, runbook.id, fixed.id)).body.status).toBe("done");
    list = await s.person("GET", "/runbooks");
    expect(list.body[0].amendedPending).toBe(0);
    expect(auditText(s)).toContain("runbooks_step_amend");
  });

  it("replaces a pending step; the order guard counts the replaced step as ended and refuses to run it", async () => {
    const { s, token, runbook } = await setup([
      { title: "Restart", hostId: 1, command: "restart-app" },
      { title: "Check", hostId: 1, command: "check-app" },
    ]);
    const reply = await amend(s, token, runbook.steps[0].id, {
      kind: "replace",
      reason: "wrong command",
      step: FIX,
    });
    expect(reply.status).toBe(200);
    const fixed = reply.body.steps[1];
    expect(reply.body.steps[0].status).toBe("replaced");

    // Step 2 waits for 1a, not for the replaced step 1.
    const early = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("order");
    expect(early.body.blocking).toEqual([
      { id: fixed.id, position: 1, label: "1a", title: FIX.title },
    ]);
    // The replaced step does not run, nor take a mark or a skip.
    const old = await runStep(s, runbook.id, runbook.steps[0].id, {
      confirmRepeat: true,
      outOfOrder: true,
    });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe("replaced");
    expect(old.body.replacedBy).toEqual({ id: fixed.id, label: "1a" });
    const skip = await s.person("POST", `/steps/${runbook.steps[0].id}/skip`, {
      reason: "x",
    });
    expect(skip.status).toBe(409);

    s.setExec(async () => execResult());
    await runStep(s, runbook.id, fixed.id);
    const check = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(check.status).toBe(200);
    expect(check.body.status).toBe("done");
    const shown = await view(s, runbook.id);
    expect(shown.progress).toEqual({ done: 3, failed: 0, total: 3 });
  });

  it("keeps a hidden step's output hidden in its fixed version", async () => {
    const { s, token, runbook } = await setup([
      {
        title: "Secret",
        hostId: 1,
        command: "show",
        hideOutputFromAgents: true,
      },
    ]);
    const reply = await amend(s, token, runbook.steps[0].id, {
      kind: "replace",
      reason: "typo",
      step: { title: "Secret 2", hostId: 1, command: "show --all" },
    });
    expect(reply.body.steps[1].hideOutputFromAgents).toBe(true);
  });

  it("chains 3 > 3a > 3b, and a sub-step of 3 then gets 3c", async () => {
    const { s, token, runbook } = await setup([
      { title: "One", hostId: 1, command: "one" },
      { title: "Two", hostId: 1, command: "two" },
      { title: "Three", hostId: 1, command: "three" },
      { title: "Four", hostId: 1, command: "four" },
    ]);
    const three = runbook.steps[2].id;
    s.setExec(async () => execResult("", { code: 1 }));
    await runStep(s, runbook.id, three, { outOfOrder: true });
    const first = await amend(s, token, three, {
      kind: "replace",
      reason: "try again",
      step: { title: "Three a", hostId: 1, command: "three --a" },
    });
    const threeA = first.body.steps[3].id;
    await runStep(s, runbook.id, threeA, { outOfOrder: true });
    const second = await amend(s, token, threeA, {
      kind: "replace",
      reason: "and again",
      step: { title: "Three b", hostId: 1, command: "three --b" },
    });
    expect(second.status).toBe(200);
    expect(labels(second.body)).toEqual(["1", "2", "3", "3a", "3b", "4"]);
    const steps = second.body.steps;
    expect(steps[2].replacedBy.label).toBe("3a");
    expect(steps[3].replacedBy.label).toBe("3b");
    expect(steps[4].amendment).toMatchObject({
      stepLabel: "3a",
      oldCommand: "three --a",
    });
    expect(steps[5].position).toBe(4);

    // Step 3 was replaced already: amend its replacement instead.
    const again = await amend(s, token, three, {
      kind: "replace",
      reason: "no",
      step: { title: "X", hostId: 1, command: "x" },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("replaced");
    expect(again.body.error).toContain("3a");

    const sub = await amend(s, token, three, {
      kind: "substep",
      reason: "one more check",
      step: { title: "Three c", hostId: 1, command: "three --c" },
    });
    expect(labels(sub.body)).toEqual(["1", "2", "3", "3a", "3b", "3c", "4"]);
  });
});

describe("amend a step with a sub-step", () => {
  it("adds 1a after a done step; step 1 stays done and 1a is next", async () => {
    const { s, token, runbook } = await setup([
      { title: "Build", hostId: 1, command: "make" },
      { title: "Ship", hostId: 1, command: "ship" },
    ]);
    s.setExec(async () => execResult());
    await runStep(s, runbook.id, runbook.steps[0].id);
    const reply = await amend(s, token, runbook.steps[0].id, {
      kind: "substep",
      reason: "also clear the cache",
      step: { title: "Clear cache", hostId: 1, command: "rm -rf cache" },
    });
    expect(reply.status).toBe(200);
    expect(labels(reply.body)).toEqual(["1", "1a", "2"]);
    expect(reply.body.steps[0].status).toBe("done");
    expect(reply.body.steps[0].replacedBy).toBeNull();
    expect(reply.body.steps[1].amendment).toMatchObject({
      kind: "substep",
      oldCommand: null,
    });
    expect(reply.body.nextStepId).toBe(reply.body.steps[1].id);
  });

  it("is named as '1a' in a later step's stdin, and numbers keep working", async () => {
    const { s, token, runbook } = await setup([
      { title: "Make", hostId: 1, command: "make-config" },
    ]);
    const sub = await amend(s, token, runbook.steps[0].id, {
      kind: "substep",
      reason: "print the version",
      step: { title: "Version", hostId: 1, command: "print-version" },
    });
    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [
          {
            title: "Use",
            hostId: 1,
            command: "use-version -",
            stdin: { from: "step", step: "1a", stream: "stdout" },
          },
          {
            title: "Use too",
            hostId: 1,
            command: "use-config -",
            stdin: { from: "step", step: "1", stream: "stdout" },
          },
        ],
      },
    );
    expect(added.status).toBe(201);
    expect(added.body.steps[2].stdin).toEqual({
      from: "step",
      step: "1a",
      stream: "stdout",
    });
    // "1" is the same step as 1, and is shown as a number.
    expect(added.body.steps[3].stdin.step).toBe(1);

    s.setExec(async (_host, command) =>
      execResult(command === "print-version" ? "v1.4.0\n" : "cfg\n"),
    );
    await runStep(s, runbook.id, runbook.steps[0].id);
    await runStep(s, runbook.id, sub.body.steps[1].id);
    const used = await runStep(s, runbook.id, added.body.steps[2].id);
    expect(used.body.status).toBe("done");
    expect(used.body.stdin).toMatchObject({ from: "step", step: "1a" });
    expect(s.channels.at(-1)!.stdin).toBe("v1.4.0\n");

    // A step cannot read a later amendment, nor a step that is not there.
    for (const step of ["1b", "9a", 1.5]) {
      const bad = await s.agent(
        "POST",
        `/runbooks/${runbook.id}/steps`,
        token,
        {
          steps: [
            {
              title: "Bad",
              hostId: 1,
              command: "x",
              stdin: { from: "step", step, stream: "stdout" },
            },
          ],
        },
      );
      expect(bad.status, String(step)).toBe(400);
    }
  });

  it("moves with its step when steps are inserted or reordered", async () => {
    const { s, token, runbook } = await setup([
      { title: "A", hostId: 1, command: "a" },
      { title: "B", hostId: 1, command: "b" },
    ]);
    const sub = await amend(s, token, runbook.steps[1].id, {
      kind: "substep",
      reason: "extra",
      step: { title: "B extra", hostId: 1, command: "b2" },
    });
    expect(labels(sub.body)).toEqual(["1", "2", "2a"]);
    const inserted = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      { position: 1, steps: [{ title: "Zero", hostId: 1, command: "z" }] },
    );
    expect(inserted.status).toBe(201);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(inserted.body.steps.map((x: any) => [x.label, x.title])).toEqual([
      ["1", "Zero"],
      ["2", "A"],
      ["3", "B"],
      ["3a", "B extra"],
    ]);
    const ids = inserted.body.steps.map((x: { id: number }) => x.id);
    const listed = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/reorder`,
      token,
      { stepIds: ids },
    );
    expect(listed.status).toBe(400);
    expect(listed.body.error).toContain("amendments");
    const reordered = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/reorder`,
      token,
      { stepIds: [ids[2], ids[0], ids[1]] },
    );
    expect(reordered.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(reordered.body.steps.map((x: any) => [x.label, x.title])).toEqual([
      ["1", "B"],
      ["1a", "B extra"],
      ["2", "Zero"],
      ["3", "A"],
    ]);
    // A step with an amendment stays; the sub-step itself can go.
    expect((await s.agent("DELETE", `/steps/${ids[2]}`, token)).body.code).toBe(
      "amended",
    );
    const removed = await s.agent("DELETE", `/steps/${ids[3]}`, token);
    expect(removed.status).toBe(200);
    expect(labels(removed.body)).toEqual(["1", "2", "3"]);
  });
});

describe("amend refusals", () => {
  it("refuses replace of a done step, a running step, a closed runbook and another token's runbook", async () => {
    const { s, token, runbook } = await setup([
      { title: "Done", hostId: 1, command: "ok" },
      { title: "Long", hostId: 1, command: "sleep 100" },
    ]);
    const fixed = { kind: "replace", reason: "fix", step: FIX };
    s.setExec(async () => execResult());
    await runStep(s, runbook.id, runbook.steps[0].id);
    const done = await amend(s, token, runbook.steps[0].id, fixed);
    expect(done.status).toBe(409);
    expect(done.body.code).toBe("done");

    let channel: FakeChannel | null = null;
    s.setChannel((opened) => (channel = opened));
    const started = await runStep(
      s,
      runbook.id,
      runbook.steps[1].id,
      {},
      "run",
      { wait: false },
    );
    expect(started.body.status).toBe("running");
    for (const kind of ["replace", "substep"]) {
      const running = await amend(s, token, runbook.steps[1].id, {
        ...fixed,
        kind,
      });
      expect(running.status, kind).toBe(409);
      expect(running.body.code).toBe("running");
    }
    await vi.waitFor(() => expect(channel).not.toBeNull());
    channel!.exit(1);
    await waitForRun(s, runbook.id, started.body.id);

    const other = await s.makeToken("other", "bob");
    const notYours = await amend(s, other, runbook.steps[1].id, fixed);
    expect(notYours.status).toBe(404);
    const missing = await amend(s, token, 99999, fixed);
    expect(missing.status).toBe(404);

    const bad = [
      { ...fixed, kind: "insert" },
      { ...fixed, reason: "" },
      { ...fixed, reason: "x".repeat(501) },
      { ...fixed, reason: "two\nlines" },
      { ...fixed, step: { title: "No host", command: "x" } },
      { ...fixed, step: { title: "Bad host", hostId: 7, command: "x" } },
      { ...fixed, extra: true },
      { kind: "replace", reason: "fix" },
    ];
    for (const body of bad) {
      const reply = await amend(s, token, runbook.steps[1].id, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }

    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      status: "done",
    });
    const closed = await amend(s, token, runbook.steps[1].id, fixed);
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe("closed");
  });
});

describe("Reopen of a replaced step", () => {
  it("is refused while the replacement is live, allowed once it was skipped without running", async () => {
    const { s, token, runbook } = await setup([
      { title: "Restart", hostId: 1, command: "restart-app" },
    ]);
    const old = runbook.steps[0].id;
    const reply = await amend(s, token, old, {
      kind: "replace",
      reason: "wrong",
      step: FIX,
    });
    const fixed = reply.body.steps[1].id;
    const refused = await s.person("POST", `/steps/${old}/reopen`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("replaced");

    await s.person("POST", `/steps/${fixed}/skip`, { reason: "not needed" });
    const reopened = await s.person("POST", `/steps/${old}/reopen`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.steps[0]).toMatchObject({
      status: "pending",
      replacedBy: null,
    });
    expect(reopened.body.nextStepId).toBe(old);
  });

  it("is refused once the replacement ran", async () => {
    const { s, token, runbook } = await setup([
      { title: "Restart", hostId: 1, command: "restart-app" },
    ]);
    const old = runbook.steps[0].id;
    const reply = await amend(s, token, old, {
      kind: "replace",
      reason: "wrong",
      step: FIX,
    });
    const fixed = reply.body.steps[1].id;
    s.setExec(async () => execResult("", { code: 1 }));
    await runStep(s, runbook.id, fixed);
    await s.person("POST", `/steps/${fixed}/skip`, { reason: "give up" });
    const refused = await s.person("POST", `/steps/${old}/reopen`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("already ran");
  });
});

describe("agent steps and amendments", () => {
  it("makes an agent-turn for an agent step that replaces the next step, and the replaced step counts as ended", async () => {
    const { s, token, runbook } = await setup([
      { title: "Read the dashboard", owner: "agent" },
      { title: "Then mine", owner: "agent" },
    ]);
    const reply = await amend(s, token, runbook.steps[0].id, {
      kind: "replace",
      reason: "read the other dashboard",
      step: { title: "Read the right dashboard", owner: "agent" },
    });
    const fixed = reply.body.steps[1];
    expect(fixed.owner).toBe("agent");
    const turns = reply.body.events.filter(
      (e: { type: string }) => e.type === "agent-turn",
    );
    expect(turns[0]).toMatchObject({ stepId: fixed.id, stepLabel: "1a" });

    const old = await s.agent(
      "POST",
      `/steps/${runbook.steps[0].id}/complete`,
      token,
      { outcome: "done" },
    );
    expect(old.status).toBe(409);
    expect(old.body.code).toBe("ended");
    const late = await s.agent(
      "POST",
      `/steps/${runbook.steps[1].id}/complete`,
      token,
      { outcome: "done" },
    );
    expect(late.body.code).toBe("order");
    expect(late.body.blocking[0].label).toBe("1a");
    await s.agent("POST", `/steps/${fixed.id}/complete`, token, {
      outcome: "done",
    });
    const mine = await s.agent(
      "POST",
      `/steps/${runbook.steps[1].id}/complete`,
      token,
      { outcome: "done" },
    );
    expect(mine.status).toBe(200);
  });

  it("works through MCP amend_step", async () => {
    const { s, token, runbook } = await setup([
      { title: "Restart", hostId: 1, command: "restart-app" },
    ]);
    const listed = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(
      listed.body.result.tools.some(
        (tool: { name: string }) => tool.name === "amend_step",
      ),
    ).toBe(true);
    const called = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "amend_step",
        arguments: {
          stepId: runbook.steps[0].id,
          kind: "substep",
          reason: "check it",
          step: { title: "Check", hostId: 1, command: "check" },
        },
      },
    });
    expect(called.body.result.isError).toBe(false);
    expect(labels(called.body.result.structuredContent)).toEqual(["1", "1a"]);
  });
});

describe("the amended event", () => {
  it("is recorded with ids and its kind, read by agents, and not delivered by default", async () => {
    const { s, token, runbook } = await setup([
      { title: "Restart", hostId: 1, command: "restart-app" },
    ]);
    const reply = await amend(s, token, runbook.steps[0].id, {
      kind: "substep",
      reason: "check the logs too",
      step: { title: "Logs", hostId: 1, command: "journalctl -u app" },
    });
    const sub = reply.body.steps[1];
    const listed = await s.agent("GET", "/events", token);
    const amended = listed.body.events.find(
      (e: { type: string }) => e.type === "amended",
    );
    expect(amended).toMatchObject({
      type: "amended",
      reason: "substep",
      runbookId: runbook.id,
      stepId: sub.id,
      stepPosition: 1,
      stepLabel: "1a",
      note: null,
      createdBy: "lead",
    });
    const row = s.db.sqlite
      .prepare("SELECT * FROM p_runbooks_events WHERE type = 'amended'")
      .get() as Record<string, unknown>;
    expect(row.next_attempt_at).toBeNull();
    // notify validates it like the others.
    const set = await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      notify: ["amended", "sent"],
    });
    expect(set.body.notify).toEqual(["amended", "sent"]);
  });

  it("goes to the webhook with ids only when notify lists it", async () => {
    const sent: Array<{ body: string }> = [];
    const s = await startServer({
      permissions: ADMIN_PERMISSIONS,
      settings: {
        notifyEnabled: true,
        notifyUrl: "https://agents.example.test/hook",
      },
      fetch: async (_url, init) => {
        sent.push(init as { body: string });
        return new Response(null, { status: 204 });
      },
    });
    expect((await s.person("POST", "/admin/notify/secret")).status).toBe(200);
    const token = await s.makeToken("lead");
    const runbook = await agentRunbook(s, token, {
      title: "Hook",
      owner: OWNER,
      notify: ["amended"],
      steps: [{ title: "Restart", hostId: 1, command: "restart-app" }],
    });
    const reason = "the unit is named app.service, not app";
    const reply = await amend(s, token, runbook.steps[0].id, {
      kind: "replace",
      reason,
      step: FIX,
    });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const payload = JSON.parse(sent[0].body);
    expect(payload).toMatchObject({
      type: "amended",
      reason: "replace",
      runbookId: runbook.id,
      stepId: reply.body.steps[1].id,
      stepPosition: 1,
      stepLabel: "1a",
    });
    expect(sent[0].body).not.toContain(reason);
    expect(sent[0].body).not.toContain(FIX.command);
    expect(sent[0].body).not.toContain(FIX.title);
  });
});
