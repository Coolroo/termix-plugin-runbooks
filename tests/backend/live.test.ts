import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamExec,
  type ExecChannel,
  type ExecClient,
} from "../../src/backend/stream-exec";
import {
  createLiveRuns,
  INTERRUPTED,
  PLUGIN_STOPPED,
} from "../../src/backend/live";
import type { Store } from "../../src/backend/store";
import {
  agentRunbook,
  FakeChannel,
  runStep,
  shownRun,
  startServer,
  view,
  waitForRun,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

/** A client whose one command is driven by hand. */
function fakeClient() {
  const channel = new FakeChannel();
  const client: ExecClient = {
    exec: (_command, callback) =>
      callback(undefined, channel as unknown as ExecChannel),
  };
  return { client, channel };
}

describe("streamExec", () => {
  it("hands chunks over in order and keeps the streams apart", async () => {
    const { client, channel } = fakeClient();
    const seen: string[] = [];
    const handle = streamExec(client, "build", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      onOutput: (stream, text) => seen.push(`${stream}:${text}`),
    });
    channel.out("one\n");
    channel.err("warn\n");
    channel.out("two\n");
    // A character split across two chunks still reads as one.
    const euro = Buffer.from("€\n");
    channel.out(euro.subarray(0, 1));
    channel.out(euro.subarray(1));
    channel.exit(0);
    const result = await handle.result;
    expect(result).toMatchObject({
      stdout: "one\ntwo\n€\n",
      stderr: "warn\n",
      code: 0,
      truncated: false,
      timedOut: false,
      stopped: false,
    });
    expect(seen).toEqual([
      "stdout:one\n",
      "stderr:warn\n",
      "stdout:two\n",
      "stdout:€\n",
    ]);
  });

  it("keeps at most the cap of each stream and marks the run truncated", async () => {
    const { client, channel } = fakeClient();
    let truncatedCalls = 0;
    const handle = streamExec(client, "yes", {
      timeoutMs: 5000,
      maxOutputBytes: 8,
      onTruncate: () => truncatedCalls++,
    });
    channel.out("12345");
    channel.out("67890");
    channel.out("more");
    channel.err("abc");
    channel.exit(0);
    const result = await handle.result;
    expect(result.stdout).toBe("12345678");
    expect(result.stderr).toBe("abc");
    expect(result.truncated).toBe(true);
    expect(truncatedCalls).toBe(1);
  });

  it("stops the command at the time limit", async () => {
    vi.useFakeTimers();
    const { client, channel } = fakeClient();
    const handle = streamExec(client, "sleep 100", {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    channel.out("started\n");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await handle.result;
    expect(result).toMatchObject({
      stdout: "started\n",
      code: null,
      timedOut: true,
    });
    expect(channel.signals).toEqual(["TERM"]);
    expect(channel.closed).toBe(true);
  });

  it("stop sends TERM, closes the channel and settles at once", async () => {
    const { client, channel } = fakeClient();
    const handle = streamExec(client, "tail -f log", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    channel.out("line\n");
    handle.stop();
    const result = await handle.result;
    expect(result).toMatchObject({
      stdout: "line\n",
      stopped: true,
      code: null,
    });
    expect(channel.signals).toEqual(["TERM"]);
    expect(channel.closed).toBe(true);
    // Output after the stop is not kept.
    channel.out("late\n");
    expect((await handle.result).stdout).toBe("line\n");
  });
});

describe("the live buffer", () => {
  it("writes the output so far at most every 2 seconds", async () => {
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    const store = {
      updateRun: async (_id: number, patch: Record<string, unknown>) => {
        writes.push(patch);
      },
      persist: async () => {},
    } as unknown as Store;
    const live = createLiveRuns(store);
    live.start({
      runId: 1,
      stepId: 1,
      runbookId: 1,
      startedAt: new Date().toISOString(),
    });
    live.output(1, "stdout", "a");
    live.output(1, "stdout", "b");
    live.output(1, "stderr", "x");
    await vi.advanceTimersByTimeAsync(1999);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ stdout: "ab", stderr: "x", truncated: false }]);
    live.output(1, "stdout", "c");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes[1]).toMatchObject({ stdout: "abc" });
    // Settling cancels a pending write: the run's final write comes last.
    live.output(1, "stdout", "d");
    await live.settle(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toHaveLength(2);
  });
});

async function setup(steps: Array<Record<string, unknown>>) {
  server = await startServer();
  const token = await server.makeToken();
  const runbook = await agentRunbook(server, token, { title: "Live", steps });
  return { s: server, token, runbook };
}

/** Starts a Run whose command is driven by hand; returns its channel. */
async function startHeld(s: TestServer, runbookId: number, stepId: number) {
  let channel: FakeChannel | null = null;
  s.setChannel((opened) => (channel = opened));
  const started = await runStep(s, runbookId, stepId, {}, "run", {
    wait: false,
  });
  expect(started.status).toBe(200);
  await vi.waitFor(() => expect(channel).not.toBeNull());
  return { started: started.body, channel: channel! };
}

describe("running a step live", () => {
  it("answers while the command still runs and shows its output as it grows", async () => {
    const { s, runbook } = await setup([
      { title: "Build", hostId: 1, command: "make" },
    ]);
    const stepId = runbook.steps[0].id;
    const { started, channel } = await startHeld(s, runbook.id, stepId);
    expect(started).toMatchObject({ status: "running", running: true });

    channel.out("compiling a\n");
    channel.err("warning: b\n");
    let run = await shownRun(s, runbook.id, started.id);
    expect(run).toMatchObject({
      status: "running",
      running: true,
      stdout: "compiling a\n",
      stderr: "warning: b\n",
    });
    expect(run.lastOutputAt).toEqual(expect.any(String));
    expect(run.elapsedMs).toEqual(expect.any(Number));
    expect(run.silentMs).toEqual(expect.any(Number));
    expect((await view(s, runbook.id)).steps[0].status).toBe("pending");

    // The claim holds until the command ends.
    const second = await runStep(s, runbook.id, stepId, {
      confirmRepeat: true,
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("running");

    channel.out("linking\n");
    channel.exit(0);
    run = await waitForRun(s, runbook.id, started.id);
    expect(run).toMatchObject({
      status: "done",
      running: false,
      exitCode: 0,
      stdout: "compiling a\nlinking\n",
      stderr: "warning: b\n",
    });
    expect((await view(s, runbook.id)).steps[0].status).toBe("done");
    expect(s.connections).toEqual({ opened: 1, disposed: 1 });
  });

  it("writes partial output to the run row while it runs", async () => {
    const { s, runbook } = await setup([
      { title: "Build", hostId: 1, command: "make" },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    channel.out("half way\n");
    const read = () =>
      s.db.sqlite
        .prepare("SELECT stdout FROM p_runbooks_runs WHERE id = ?")
        .get(started.id) as { stdout: string };
    await vi.waitFor(() => expect(read().stdout).toBe("half way\n"), {
      timeout: 3000,
      interval: 50,
    });
    channel.exit(0);
    await waitForRun(s, runbook.id, started.id);
  });

  it("fails a run that runs past its time limit", async () => {
    const { s, runbook } = await setup([
      { title: "Hang", hostId: 1, command: "sleep 600", timeoutMs: 1000 },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    channel.out("waiting\n");
    const run = await waitForRun(s, runbook.id, started.id);
    expect(run).toMatchObject({
      status: "failed",
      timedOut: true,
      exitCode: null,
      stdout: "waiting\n",
    });
    expect(channel.closed).toBe(true);
  });

  it("keeps 256 KB of each stream and marks the run truncated", async () => {
    const { s, runbook } = await setup([
      { title: "Noisy", hostId: 1, command: "yes" },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    channel.out("x".repeat(200_000));
    channel.out("y".repeat(100_000));
    channel.err("e".repeat(10));
    channel.exit(0);
    const run = await waitForRun(s, runbook.id, started.id);
    expect(run.stdout).toHaveLength(262_144);
    expect(run.stderr).toBe("e".repeat(10));
    expect(run.truncated).toBe(true);
  });
});

describe("stopping a run", () => {
  it("stops the command; the run fails as stopped by the person and is audited", async () => {
    const { s, runbook } = await setup([
      { title: "Tail", hostId: 1, command: "tail -f /var/log/syslog" },
    ]);
    const stepId = runbook.steps[0].id;
    const { started, channel } = await startHeld(s, runbook.id, stepId);
    channel.out("line 1\n");
    const stopped = await s.person("POST", `/steps/${stepId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      id: started.id,
      status: "failed",
      error: "stopped by alice",
      stdout: "line 1\n",
      exitCode: null,
    });
    expect(channel.signals).toEqual(["TERM"]);
    expect(channel.closed).toBe(true);
    expect((await view(s, runbook.id)).steps[0].status).toBe("failed");
    expect(
      s.mock.audits.find((a) => a.action === "runbooks_step_stop"),
    ).toMatchObject({ success: true, resourceId: String(stepId) });
    expect(s.connections.disposed).toBe(1);
    // Nothing runs now.
    const again = await s.person("POST", `/steps/${stepId}/stop`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("not-running");
  });

  it("is refused for an agent token and a Termix API key", async () => {
    const { s, token, runbook } = await setup([
      { title: "Tail", hostId: 1, command: "tail -f log" },
    ]);
    const stepId = runbook.steps[0].id;
    const { started, channel } = await startHeld(s, runbook.id, stepId);
    // The agent side has no stop at all.
    const agent = await s.agent("POST", `/steps/${stepId}/stop`, token);
    expect(agent.status).toBe(404);
    const apiKey = await s.person("POST", `/steps/${stepId}/stop`, undefined, {
      apiKey: true,
    });
    expect(apiKey.status).toBe(403);
    const signedOut = await s.raw("POST", `/steps/${stepId}/stop`, {});
    expect(signedOut.status).toBe(401);
    expect(channel.closed).toBe(false);
    channel.exit(0);
    expect((await waitForRun(s, runbook.id, started.id)).status).toBe("done");
  });
});

describe("a Termix restart", () => {
  it("marks runs left running as interrupted and keeps their partial output", async () => {
    const at = new Date().toISOString();
    server = await startServer({
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
            `INSERT INTO p_runbooks_runs (id, step_id, runbook_id, mode, status, host_id, command, command_hash, user_id, started_at, stdout, stderr, truncated, timed_out)
             VALUES (1, 1, 1, 'exec', 'running', 1, 'make', 'h', 'alice', ?, 'partial out', '', 0, 0)`,
          )
          .run(at);
      },
    });
    const shown = await view(server, 1);
    expect(shown.steps[0].status).toBe("failed");
    expect(shown.steps[0].runs[0]).toMatchObject({
      status: "failed",
      running: false,
      error: INTERRUPTED,
      stdout: "partial out",
    });
    expect(shown.steps[0].runs[0].finishedAt).toEqual(expect.any(String));
  });
});

describe("the plugin stopping", () => {
  it("says why on a run its connection was closed under", async () => {
    const { s, runbook } = await setup([
      { title: "Build", hostId: 1, command: "make" },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    channel.out("part\n");
    const { deactivate } = await import("../../src/backend/index");
    await deactivate();
    // Core then closes the plugin's SSH connections.
    channel.exit(null);
    const run = await waitForRun(s, runbook.id, started.id);
    expect(run).toMatchObject({
      status: "failed",
      error: PLUGIN_STOPPED,
      stdout: "part\n",
    });
  });
});

describe("agents and live output", () => {
  it("see a running run's output so far, unless the owner hid the step", async () => {
    const { s, token, runbook } = await setup([
      { title: "Build", hostId: 1, command: "make" },
    ]);
    const stepId = runbook.steps[0].id;
    const { started, channel } = await startHeld(s, runbook.id, stepId);
    channel.out("step 1 of 3\n");

    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[0].runs[0]).toMatchObject({
      id: started.id,
      status: "running",
      running: true,
      stdout: "step 1 of 3\n",
    });
    expect(read.body.steps[0].runs[0].lastOutputAt).toEqual(expect.any(String));

    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_runbook", arguments: { runbookId: runbook.id } },
    });
    expect(mcp.body.result.structuredContent.steps[0].runs[0]).toMatchObject({
      running: true,
      stdout: "step 1 of 3\n",
    });

    await s.person("POST", `/steps/${stepId}/hide`, { hidden: true });
    const hidden = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(hidden.body.steps[0].runs[0]).toMatchObject({
      running: true,
      stdout: "[hidden by owner]",
      stderr: "[hidden by owner]",
    });
    // The person still sees it.
    expect((await shownRun(s, runbook.id, started.id)).stdout).toBe(
      "step 1 of 3\n",
    );
    channel.exit(0);
    await waitForRun(s, runbook.id, started.id);
  });
});
