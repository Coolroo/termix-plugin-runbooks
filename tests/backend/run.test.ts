import { describe, expect, it, vi } from "vitest";
import {
  agentRunbook,
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  waitForRun,
} from "./helpers";

const startServer = useTestServer();

const setup = (
  steps: Array<Record<string, unknown>>,
  values: Record<string, string> = {},
) => setupRunbook(steps, { values });

describe("running a step", () => {
  it("runs the resolved command over SSH and stores the run", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Uptime",
          hostId: 1,
          command: "uptime -p # {{tag}}",
          timeoutMs: 5000,
        },
      ],
      { tag: "a b" },
    );
    s.setExec(async () => execResult("up 3 days\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.status).toBe(200);
    // The route answers before the command ends.
    expect(ran.started).toMatchObject({ status: "running", running: true });
    expect(ran.body).toMatchObject({
      mode: "exec",
      status: "done",
      command: "uptime -p # a b",
      exitCode: 0,
      stdout: "up 3 days\n",
      userId: "alice",
    });
    expect(ran.body.commandHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.execCalls[0]).toMatchObject({
      host: 1,
      command: "uptime -p # a b",
      options: { purpose: "runbooks" },
    });
    expect(s.connections).toEqual({ opened: 1, disposed: 1 });
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].status).toBe("done");
    expect(shown.progress).toEqual({ done: 1, failed: 0, total: 1 });
    expect(s.mock.audits.some((a) => a.action === "runbooks_step_run")).toBe(
      true,
    );
  });

  it("marks the step failed on a non-zero exit or an error", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 1, command: "false" },
      { title: "B", hostId: 1, command: "true" },
    ]);
    s.setExec(async () => execResult("", { stderr: "boom", code: 1 }));
    const failed = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(failed.body).toMatchObject({ status: "failed", exitCode: 1 });
    expect((await view(s, runbook.id)).steps[0].status).toBe("failed");

    s.setExec(async () => {
      throw new Error("connection refused");
    });
    const errored = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(errored.body).toMatchObject({
      status: "failed",
      error: "connection refused",
    });
  });

  it("refuses a stale revision or a changed command", async () => {
    const { s, token, runbook } = await setup(
      [{ title: "A", hostId: 1, command: "echo {{x}}" }],
      { x: "1" },
    );
    const shown = await view(s, runbook.id);
    const step = shown.steps[0];

    // The agent edits the step after the person looked at it.
    await s.agent("PATCH", `/steps/${step.id}`, token, {
      command: "echo {{x}} more",
    });
    const stale = await s.person("POST", `/steps/${step.id}/run`, {
      revision: step.revision,
      commandHash: step.commandHash,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale");

    // A value changes: same revision, different command.
    const fresh = (await view(s, runbook.id)).steps[0];
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      values: { x: "2" },
    });
    const changed = await s.person("POST", `/steps/${step.id}/run`, {
      revision: fresh.revision,
      commandHash: fresh.commandHash,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("stale");
    expect(s.execCalls).toHaveLength(0);
  });

  it("refuses missing values and names them", async () => {
    const { s, token, runbook } = await setup([
      { title: "A", hostId: 1, command: "echo {{a}} {{ b }} {{a}}" },
    ]);
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].missing).toEqual(["a", "b"]);
    expect(shown.steps[0].commandHash).toBeNull();
    const refused = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "missing-values",
      missing: ["a", "b"],
    });
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      values: { a: "$(id)", b: "'q'" },
    });
    const filled = await view(s, runbook.id);
    // Substituted literally, no quoting.
    expect(filled.steps[0].resolvedCommand).toBe("echo $(id) 'q' $(id)");
    expect((await runStep(s, runbook.id, runbook.steps[0].id)).status).toBe(
      200,
    );
  });

  it("keeps the order unless the person says otherwise", async () => {
    const { s, runbook } = await setup([
      { title: "First", hostId: 1, command: "one" },
      { title: "Read this" },
      { title: "Third", hostId: 1, command: "three" },
    ]);
    const third = runbook.steps[2].id;
    const refused = await runStep(s, runbook.id, third);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("order");
    expect(
      refused.body.blocking.map((b: { title: string }) => b.title),
    ).toEqual(["First", "Read this"]);

    const forced = await runStep(s, runbook.id, third, { outOfOrder: true });
    expect(forced.status).toBe(200);

    // Done and skipped steps no longer block.
    await runStep(s, runbook.id, runbook.steps[0].id);
    await s.person("POST", `/steps/${runbook.steps[1].id}/skip`, {
      reason: "read it",
    });
    const shown = await view(s, runbook.id);
    expect(shown.steps[1]).toMatchObject({
      status: "skipped",
      skipReason: "read it",
    });
    expect(shown.nextStepId).toBeNull();
  });

  it("asks before running a step again", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 1, command: "date" },
    ]);
    const stepId = runbook.steps[0].id;
    expect((await runStep(s, runbook.id, stepId)).status).toBe(200);
    const again = await runStep(s, runbook.id, stepId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("repeat");
    expect(again.body.repeat).toMatchObject({
      sameStep: true,
      userId: "alice",
      exitCode: 0,
    });
    const confirmed = await runStep(s, runbook.id, stepId, {
      confirmRepeat: true,
    });
    expect(confirmed.status).toBe(200);
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].runs).toHaveLength(2);
    // Newest first.
    expect(shown.steps[0].runs[0].id).toBeGreaterThan(
      shown.steps[0].runs[1].id,
    );
  });

  it("asks before the same command on the same host from another runbook", async () => {
    const { s, token, runbook } = await setup([
      { title: "A", hostId: 1, command: "apt upgrade -y" },
    ]);
    await runStep(s, runbook.id, runbook.steps[0].id);
    const other = await agentRunbook(s, token, {
      title: "Other",
      steps: [
        { title: "Same", hostId: 1, command: "apt upgrade -y" },
        { title: "Other host", hostId: 3, command: "apt upgrade -y" },
      ],
    });
    const repeat = await runStep(s, other.id, other.steps[0].id);
    expect(repeat.status).toBe(409);
    expect(repeat.body.repeat).toMatchObject({
      sameStep: false,
      runbookId: runbook.id,
    });
    // Another host is another command.
    expect(
      (await runStep(s, other.id, other.steps[1].id, { outOfOrder: true }))
        .status,
    ).toBe(200);

    // Older than 24 hours no longer counts.
    s.db.sqlite
      .prepare("UPDATE p_runbooks_runs SET started_at = ?")
      .run(new Date(Date.now() - 25 * 3600 * 1000).toISOString());
    expect((await runStep(s, other.id, other.steps[0].id)).status).toBe(200);
  });

  it("refuses a host without a stored host key", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 2, command: "uptime" },
    ]);
    const refused = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("no-host-key");
    expect(refused.body.error).toMatch(/open a Terminal to this host once/);
    expect(s.execCalls).toHaveLength(0);
    // Sending to a terminal is fine: the terminal asks about the key.
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    expect(sent.status).toBe(200);
  });

  it("refuses a host the person cannot connect to", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 3, command: "uptime" },
    ]);
    // The host is gone, or was never shared with this person.
    s.db.sqlite.prepare("UPDATE p_runbooks_steps SET host_id = 99").run();
    const refused = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(refused.status).toBe(403);
    expect(s.execCalls).toHaveLength(0);
  });

  it("refuses a core API key on the routes that act", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 1, command: "uptime" },
    ]);
    const shown = await view(s, runbook.id);
    const refused = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/run`,
      {
        revision: shown.steps[0].revision,
        commandHash: shown.steps[0].commandHash,
      },
      { apiKey: true },
    );
    expect(refused.status).toBe(403);
    expect(
      (
        await s.person(
          "POST",
          `/steps/${runbook.steps[0].id}/skip`,
          {},
          { apiKey: true },
        )
      ).status,
    ).toBe(403);
    // Reading is fine.
    expect(
      (
        await s.person("GET", `/runbooks/${runbook.id}`, undefined, {
          apiKey: true,
        })
      ).status,
    ).toBe(200);
    expect(s.execCalls).toHaveLength(0);
  });

  it("refuses a step on a closed runbook", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 1, command: "uptime" },
    ]);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "abandoned",
    });
    const refused = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(refused.status).toBe(409);
  });

  it("runs once when the same step is run twice at the same time", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 1, command: "deploy" },
    ]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    s.setExec(async () => {
      await gate;
      return execResult("ok");
    });
    const shown = await view(s, runbook.id);
    const stepId = runbook.steps[0].id;
    const body = {
      revision: shown.steps[0].revision,
      commandHash: shown.steps[0].commandHash,
    };
    const first = s.person("POST", `/steps/${stepId}/run`, body);
    const second = s.person("POST", `/steps/${stepId}/run`, body);
    // Let the first reach SSH before releasing it.
    await vi.waitFor(() => expect(s.execCalls.length).toBeGreaterThan(0));
    release();
    const replies = await Promise.all([first, second]);
    const statuses = replies.map((reply) => reply.status).sort();
    expect(statuses).toEqual([200, 409]);
    // The second was turned away while the first was still running.
    expect(replies.find((reply) => reply.status === 409)!.body.code).toBe(
      "running",
    );
    expect(s.execCalls).toHaveLength(1);
    const runId = replies.find((reply) => reply.status === 200)!.body.id;
    expect((await waitForRun(s, runbook.id, runId)).status).toBe("done");
    expect((await view(s, runbook.id)).steps[0].runs).toHaveLength(1);
  });

  it("records one send when the same step is sent twice at the same time", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 1, command: "deploy" },
    ]);
    const shown = await view(s, runbook.id);
    const stepId = runbook.steps[0].id;
    const body = {
      revision: shown.steps[0].revision,
      commandHash: shown.steps[0].commandHash,
    };
    const replies = await Promise.all([
      s.person("POST", `/steps/${stepId}/terminal`, body),
      s.person("POST", `/steps/${stepId}/terminal`, body),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect((await view(s, runbook.id)).steps[0].runs).toHaveLength(1);
  });
});

describe("captures", () => {
  it("captures a value from output for later steps", async () => {
    const { s, runbook } = await setup([
      {
        title: "Version",
        hostId: 1,
        command: "app --version",
        captures: [{ name: "ver", pattern: "^version: (\\S+)$" }],
      },
      { title: "Fetch", hostId: 1, command: "fetch app-{{ver}}.tgz" },
    ]);
    const before = await view(s, runbook.id);
    expect(before.steps[1].missing).toEqual(["ver"]);

    s.setExec(async () => execResult("app\nversion: 1.2.3\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.captured).toEqual({ ver: "1.2.3" });

    const after = await view(s, runbook.id);
    expect(after.steps[1].resolvedCommand).toBe("fetch app-1.2.3.tgz");
    expect(after.effectiveValues).toEqual([
      expect.objectContaining({
        name: "ver",
        value: "1.2.3",
        source: "capture",
        stepId: runbook.steps[0].id,
      }),
    ]);
  });

  it("captures from pasted terminal output", async () => {
    const { s, runbook } = await setup([
      {
        title: "Pid",
        hostId: 1,
        command: "pgrep app",
        captures: [{ name: "pid", pattern: "(\\d+)" }],
      },
    ]);
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    expect(sent.body).toMatchObject({
      mode: "terminal",
      status: "awaiting-output",
      exitCode: null,
    });
    // Not finished yet: a second send asks first.
    const again = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    expect(again.body.code).toBe("repeat");

    const done = await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: "4242\n",
      exitCode: 0,
      outcome: "done",
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: "done",
      pastedOutput: "4242\n",
      captured: { pid: "4242" },
    });
    const twice = await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: "",
      outcome: "done",
    });
    expect(twice.status).toBe(409);
    expect((await view(s, runbook.id)).steps[0].status).toBe("done");
  });
});

describe("person step actions", () => {
  it("saves notes, skips and reopens, keeping runs", async () => {
    const { s, token, runbook } = await setup([
      { title: "A", hostId: 1, command: "uptime" },
    ]);
    const stepId = runbook.steps[0].id;
    await runStep(s, runbook.id, stepId);
    expect(
      (
        await s.person("POST", `/steps/${stepId}/note`, {
          ownerNote: "ok **fine**",
        })
      ).status,
    ).toBe(200);
    const reopened = await s.person("POST", `/steps/${stepId}/reopen`);
    expect(reopened.body.steps[0]).toMatchObject({
      status: "pending",
      ownerNote: "ok **fine**",
    });
    expect(reopened.body.steps[0].runs).toHaveLength(1);

    // The agent reads the note but cannot write it.
    const seen = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(seen.body.steps[0].ownerNote).toBe("ok **fine**");
    const write = await s.agent("PATCH", `/steps/${stepId}`, token, {
      ownerNote: "x",
    });
    // Refused: the step ran, and ownerNote is no step field an agent sets.
    expect(write.status).toBe(409);
    const fresh = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [{ title: "B" }],
      },
    );
    const unknown = await s.agent(
      "PATCH",
      `/steps/${fresh.body.steps[1].id}`,
      token,
      { ownerNote: "x" },
    );
    expect(unknown.status).toBe(400);
  });

  it("lists open runbooks first", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const a = await agentRunbook(server, token, { title: "A" });
    await agentRunbook(server, token, { title: "B" });
    await server.agent("PATCH", `/runbooks/${a.id}`, token, { status: "done" });
    const list = await server.person("GET", "/runbooks");
    expect(list.body.map((r: { title: string }) => r.title)).toEqual([
      "B",
      "A",
    ]);
  });
});
