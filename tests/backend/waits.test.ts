/**
 * 1.4.10, phase 2: the wait item and retry on a run item. A wait runs its
 * command until its checks pass, on a schedule, each attempt a record in
 * its item; it fails when a stopIf check matches or the attempts or the
 * time run out. A run item with retry runs again on the failures its
 * retryOn names. The server runs the attempts after the answer, as the
 * person who pressed Run, with an access check before each attempt; Try
 * now ends the delay before the next attempt; Stop ends it all; a Termix
 * restart ends it, and the person continues. Timers are fake here, so the
 * schedule is tested to the millisecond.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  shownRun,
  useTestServer,
  view,
  type FakeChannel,
  type TestServer,
} from "./helpers";

const testServer = useTestServer();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const seqStep = (
  sequence: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => ({ title: "Deploy", hostId: 1, sequence, ...extra });

const run = (command: string, extra: Record<string, unknown> = {}) => ({
  type: "run",
  command,
  ...extra,
});

/** A wait for "healthy" in the output, every 5 s, within 10 min. */
const wait = (command: string, extra: Record<string, unknown> = {}) => ({
  type: "wait",
  command,
  checks: [{ type: "contains", text: "healthy" }],
  within: 600,
  ...extra,
});

/** Answers each command with the next answer in its list; the last stays. */
function answers(
  s: TestServer,
  script: Record<string, Array<[string, number]>>,
) {
  const seen: Record<string, number> = {};
  s.setExec(async (_host, command) => {
    const list = script[command];
    if (!list) return execResult(`${command}\n`);
    const index = Math.min(seen[command] ?? 0, list.length - 1);
    seen[command] = (seen[command] ?? 0) + 1;
    const [out, code] = list[index];
    return execResult(out, { code });
  });
}

const fake = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Reads until `ok`, moving the fake clock `stepMs` between reads; with
 * real timers, waiting 5 ms between reads.
 */
async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  stepMs = 0,
): Promise<T> {
  for (let round = 0; round < 500; round++) {
    const value = await read();
    if (ok(value)) return value;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(stepMs);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("never got there");
}

/** Starts the step; returns the run as the Run answer gives it. */
async function start(s: TestServer, runbookId: number, stepId: number) {
  const reply = await runStep(s, runbookId, stepId, {}, "run", {
    wait: false,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body;
}

const read = (s: TestServer, runbookId: number, runId: number) => () =>
  shownRun(s, runbookId, runId);

/** The run once it ended, moving the clock 1 s at a time. */
const ended = (s: TestServer, runbookId: number, runId: number) =>
  until(read(s, runbookId, runId), (r: Any) => r.status !== "running", 1000);

/** The run once item `position` waits for its next attempt. */
const between = (
  s: TestServer,
  runbookId: number,
  runId: number,
  position: number,
  attempts: number,
) =>
  until(
    read(s, runbookId, runId),
    (r: Any) =>
      r.items[position - 1].nextAttemptAt !== null &&
      r.items[position - 1].attempts.length === attempts,
  );

const whys = (item: Any) => item.attempts.map((a: Any) => a.why);

describe("writing a wait item and a retry", () => {
  it("stores them with the schedule filled in, and shows the plan before Run", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([
        run("deploy", {
          retry: { attempts: 4, backoff: "exponential", every: 2 },
        }),
        wait("status", {
          label: "Healthy",
          stopIf: [{ type: "contains", text: "FAILED" }],
          every: 30,
          attempts: 120,
          within: 3600,
          timeoutMs: 30_000,
          captures: [{ name: "ver", pattern: "version=(\\S+)" }],
        }),
        run("echo {{ver}}"),
      ]),
    ]);
    expect(runbook.steps[0].sequence).toEqual([
      {
        type: "run",
        label: null,
        command: "deploy",
        checks: [],
        captures: [],
        timeoutMs: null,
        onFail: "stop",
        interactive: false,
        retry: {
          attempts: 4,
          within: null,
          retryOn: ["exit", "check", "timeout", "connect"],
          every: 2,
          backoff: "exponential",
          factor: 2,
          maxDelay: 300,
          jitter: "none",
        },
      },
      {
        type: "wait",
        label: "Healthy",
        command: "status",
        checks: [{ type: "contains", text: "healthy", stream: "any" }],
        stopIf: [{ type: "contains", text: "FAILED", stream: "any" }],
        captures: [{ name: "ver", pattern: "version=(\\S+)" }],
        timeoutMs: 30_000,
        onFail: "stop",
        within: 3600,
        attempts: 120,
        every: 30,
        backoff: "fixed",
        factor: 2,
        maxDelay: 300,
        jitter: "none",
      },
      expect.objectContaining({ type: "run", command: "echo {{ver}}" }),
    ]);
    expect(runbook.steps[0].schedules).toEqual([
      {
        item: 1,
        attempts: 4,
        maxSeconds: 494,
        text: "up to 4 attempts, 2 s apart, then ×2 each time up to 5 min, at most 8 min 14 s",
      },
      {
        item: 2,
        attempts: 120,
        maxSeconds: 3600,
        text: "up to 120 attempts, every 30 s, at most 1 h",
      },
    ]);
    // The person approves the schedule with the commands.
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].resolvedCommand).toContain(
      "# 2 Healthy: until its checks pass, up to 120 attempts, every 30 s, at most 1 h\nstatus",
    );
    expect(shown.steps[0].resolvedCommand).toContain(
      "# 1 (retry: up to 4 attempts",
    );
    expect(shown.steps[0].resolvedSequence[2].later).toEqual(["ver"]);
  });

  it.each([
    [wait("s", { checks: [] }), "checks needs at least one check"],
    [{ ...wait("s"), within: undefined }, "within is required"],
    [wait("s", { within: 7201 }), "within must be an integer from 1 to 7200"],
    [wait("s", { within: 0 }), "within must be an integer from 1 to 7200"],
    [wait("s", { attempts: 501 }), "attempts must be an integer from 1 to 500"],
    [wait("s", { every: 0 }), "every must be an integer from 1 to 3600"],
    [wait("s", { every: 1.5 }), "every must be an integer"],
    [
      wait("s", { maxDelay: 3601 }),
      "maxDelay must be an integer from 1 to 3600",
    ],
    [
      wait("s", { every: 60, maxDelay: 30 }),
      "maxDelay (30) must be at least every (60)",
    ],
    [
      wait("s", { backoff: "random" }),
      'backoff must be "fixed", "linear" or "exponential"',
    ],
    [wait("s", { factor: 3 }), 'factor is for backoff "exponential" only'],
    [
      wait("s", { backoff: "exponential", factor: 1 }),
      "factor must be a number from 1.1 to 10",
    ],
    [
      wait("s", { backoff: "exponential", factor: 11 }),
      "factor must be a number from 1.1 to 10",
    ],
    [wait("s", { jitter: "some" }), 'jitter must be "none", "full" or "equal"'],
    [
      wait("s", { stopIf: [{ type: "value", name: "x" }] }),
      "stopIf reads output only",
    ],
    [wait("s", { stopIf: "FAILED" }), "stopIf: checks must be an array"],
    [
      wait("s", { interactive: true }),
      'unknown sequence[0] field "interactive"',
    ],
    [
      wait("s", { retry: { attempts: 3 } }),
      'unknown sequence[0] field "retry"',
    ],
    [wait(""), "sequence[0].command is required for a wait item"],
    [run("r", { retry: { every: 5 } }), "retry.attempts is required"],
    [
      run("r", { retry: { attempts: 1 } }),
      "retry.attempts must be an integer from 2 to 500",
    ],
    [
      run("r", { retry: { attempts: 501 } }),
      "retry.attempts must be an integer from 2 to 500",
    ],
    [
      run("r", { retry: { attempts: 3, within: 9000 } }),
      "retry.within must be an integer from 1 to 7200",
    ],
    [
      run("r", { retry: { attempts: 3, retryOn: [] } }),
      "retryOn must be a list of one or more",
    ],
    [
      run("r", { retry: { attempts: 3, retryOn: ["sometimes"] } }),
      "retryOn must be a list of one or more",
    ],
    [
      run("r", { retry: { attempts: 3, stopIf: [] } }),
      'unknown sequence[0].retry field "stopIf"',
    ],
    [run("r", { retry: 3 }), "retry must be an object"],
    [
      run("r", { interactive: true, retry: { attempts: 3 } }),
      "an interactive item cannot have retry",
    ],
  ])("refuses %j with a clear 400", async (item, message) => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [seqStep([item as Record<string, unknown>])],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(400);
    expect(made.body.error).toContain(message);
  });

  it("refuses sleep in a wait item's command too", async () => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [seqStep([wait("until curl -s x; do sleep 5; done")])],
    });
    expect(made.status).toBe(400);
    expect(made.body.code).toBe("sleep");
    expect(made.body.error).toContain('"type":"wait"');
  });

  it("is taken on add-steps, update-step, amend and MCP; a bad value is a 400 there too", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "A", hostId: 1, command: "true" },
    ]);
    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [seqStep([wait("status")])],
      },
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const stepId = added.body.steps[1].id;
    const bad = await s.agent("PATCH", `/steps/${stepId}`, token, {
      sequence: [wait("status", { within: 9999 })],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain(
      "within must be an integer from 1 to 7200",
    );
    const patched = await s.agent("PATCH", `/steps/${stepId}`, token, {
      sequence: [run("go", { retry: { attempts: 3, jitter: "equal" } })],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_steps",
        arguments: {
          runbookId: runbook.id,
          steps: [seqStep([wait("status", { jitter: "full", every: 10 })])],
        },
      },
    });
    expect(mcp.body.result.isError, JSON.stringify(mcp.body)).toBeFalsy();
    s.setExec(async () => execResult("ok\n"));
    await runStep(s, runbook.id, runbook.steps[0].id);
    const amended = await s.agent(
      "POST",
      `/steps/${runbook.steps[0].id}/amend`,
      token,
      {
        kind: "replace",
        reason: "wait for it",
        step: seqStep([wait("status", { attempts: 0 })]),
      },
    );
    expect(amended.status).toBe(400);
    expect(amended.body.error).toContain(
      "attempts must be an integer from 1 to 500",
    );
  });
});

describe("running a wait item", () => {
  it("passes on the first attempt whose checks pass; captures from that attempt only; one event", async () => {
    const { s, token, runbook } = await setupRunbook(
      [
        seqStep([
          wait("status", {
            every: 5,
            captures: [{ name: "ver", pattern: "version=(\\S+)" }],
          }),
          run("echo {{ver}}"),
        ]),
      ],
      { extra: { notify: ["step-done", "step-failed"] } },
    );
    answers(s, {
      status: [
        ["starting version=old\n", 0],
        ["unhealthy version=old\n", 1],
        ["healthy version=2.1\n", 0],
      ],
    });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const first = await between(s, runbook.id, started.id, 1, 1);
    const item = first.items[0];
    expect(item).toMatchObject({
      status: "running",
      maxAttempts: 500,
      stdout: "starting version=old\n",
    });
    expect(
      Date.parse(item.nextAttemptAt) - Date.parse(item.attempts[0].finishedAt),
    ).toBe(5000);
    expect(Date.parse(item.endsBy) - Date.parse(item.startedAt)).toBe(600_000);
    // Agents read where the attempts are.
    const agentView = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(agentView.body.steps[0].attempt).toEqual({
      item: 1,
      attempt: 1,
      of: 500,
      nextAt: item.nextAttemptAt,
      endsBy: item.endsBy,
    });
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("done");
    const wait1 = done.items[0];
    expect(wait1.attempts.map((a: Any) => a.status)).toEqual([
      "failed",
      "failed",
      "passed",
    ]);
    expect(whys(wait1)).toEqual(["check", "exit", null]);
    expect(wait1.attempts.map((a: Any) => a.exitCode)).toEqual([0, 1, 0]);
    expect(wait1.attempts[0].checks[0].ok).toBe(false);
    expect(wait1).toMatchObject({
      status: "passed",
      stdout: "healthy version=2.1\n",
      captured: { ver: "2.1" },
      nextAttemptAt: null,
    });
    expect(done.items[1].command).toBe("echo 2.1");
    expect(s.execCalls.map((c) => c.command)).toEqual([
      "status",
      "status",
      "status",
      "echo 2.1",
    ]);
    // Attempts 2 and 3 started 5 s after the one before ended.
    const starts = wait1.attempts.map((a: Any) => Date.parse(a.startedAt));
    expect(starts[1] - Date.parse(wait1.attempts[0].finishedAt)).toBe(5000);
    expect(starts[2] - Date.parse(wait1.attempts[1].finishedAt)).toBe(5000);
    vi.useRealTimers();
    const events = await s.agent("GET", "/events", token);
    const ends = events.body.events.filter(
      (e: Any) => e.type === "step-done" || e.type === "step-failed",
    );
    expect(ends).toHaveLength(1);
    const agentDone = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(agentDone.body.steps[0].attempt).toBeNull();
    expect(
      agentDone.body.steps[0].runs[0].items[0].attempts.map((a: Any) => [
        a.attempt,
        a.why,
        a.stdout,
      ]),
    ).toEqual([
      [1, "check", "starting version=old\n"],
      [2, "exit", "unhealthy version=old\n"],
      [3, null, "healthy version=2.1\n"],
    ]);
  });

  it("fails at once when a stopIf check matches, even when its checks pass", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([
        wait("status", {
          stopIf: [
            { type: "contains", text: "FAILED", label: "the sync failed" },
          ],
        }),
        run("never"),
      ]),
    ]);
    answers(s, {
      status: [
        ["syncing\n", 0],
        ["healthy but FAILED\n", 0],
      ],
    });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("failed");
    expect(whys(done.items[0])).toEqual(["check", "stop-if"]);
    expect(done.items[0].attempts[1].stopIf).toEqual([
      expect.objectContaining({ label: "the sync failed", ok: true }),
    ]);
    expect(done.items[0].attempts[0].stopIf[0].ok).toBe(false);
    expect(done.items[0]).toMatchObject({
      status: "failed",
      error: "a stopIf check matched: the sync failed",
      captured: {},
    });
    expect(done.error).toBe(
      "item 1 failed: a stopIf check matched: the sync failed",
    );
    expect(done.items[1].status).toBe("waiting");
    expect(s.execCalls).toHaveLength(2);
  });

  it("fails when the attempts run out", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { attempts: 3, every: 2 })]),
    ]);
    answers(s, { status: [["starting\n", 0]] });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("failed");
    expect(done.items[0].attempts).toHaveLength(3);
    expect(done.items[0].error).toBe(
      "the checks did not pass in 3 attempts, the most this item makes",
    );
    expect(done.items[0].nextAttemptAt).toBeNull();
  });

  it("fails when the time runs out: no attempt starts after the time limit", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { within: 12, every: 5 })]),
    ]);
    answers(s, { status: [["starting\n", 0]] });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    // Attempts at 0, 5 and 10 s; the next would start at 15 s.
    expect(done.items[0].attempts).toHaveLength(3);
    expect(done.items[0].error).toBe(
      "the checks did not pass within 12 s (3 attempts)",
    );
    const took =
      Date.parse(done.items[0].finishedAt) -
      Date.parse(done.items[0].startedAt);
    expect(took).toBeLessThanOrEqual(12_000);
  });

  it("ends a hung attempt at its time limit and goes on: a hang is a failed attempt", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { timeoutMs: 1000, every: 1 })]),
    ]);
    const channels: FakeChannel[] = [];
    s.setChannel((channel) => {
      channels.push(channel);
      // The first attempt hangs; the second answers.
      if (channels.length === 2) {
        setTimeout(() => {
          channel.out("healthy\n");
          channel.exit(0);
        }, 10);
      }
    });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("done");
    expect(whys(done.items[0])).toEqual(["timeout", null]);
    expect(done.items[0].attempts[0]).toMatchObject({
      timedOut: true,
      exitCode: null,
    });
    expect(
      Date.parse(done.items[0].attempts[0].finishedAt) -
        Date.parse(done.items[0].attempts[0].startedAt),
    ).toBe(1000);
  });

  it("cuts an attempt's time limit to the item's time left", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { within: 3, timeoutMs: 60_000 })]),
    ]);
    s.setChannel(() => {});
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(whys(done.items[0])).toEqual(["timeout"]);
    expect(
      Date.parse(done.items[0].finishedAt) -
        Date.parse(done.items[0].startedAt),
    ).toBe(3000);
  });

  it("Try now starts the next attempt at once; it is audited, and refused when nothing waits", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { every: 300 })]),
    ]);
    answers(s, {
      status: [
        ["starting\n", 0],
        ["healthy\n", 0],
      ],
    });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await between(s, runbook.id, started.id, 1, 1);
    const now = await s.person("POST", `/steps/${runbook.steps[0].id}/try-now`);
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    const done = await until(
      read(s, runbook.id, started.id),
      (r: Any) => r.status !== "running",
    );
    expect(done.status).toBe("done");
    expect(done.items[0].attempts).toHaveLength(2);
    expect(
      Date.parse(done.items[0].attempts[1].startedAt) -
        Date.parse(done.items[0].attempts[0].finishedAt),
    ).toBeLessThan(1000);
    expect(
      s.mock.audits.some((a) => a.action === "runbooks_step_try_now"),
    ).toBe(true);
    const again = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/try-now`,
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("no-wait");
    // An agent cannot press it.
    const agentTry = await s.raw(
      "POST",
      `/steps/${runbook.steps[0].id}/try-now`,
      { "x-test-user": "alice", "x-test-api-key": "1" },
    );
    expect(agentTry.status).not.toBe(200);
  });

  it("Stop during the delay between attempts ends the item and the rest", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { every: 300 }), run("never")]),
    ]);
    answers(s, { status: [["starting\n", 0]] });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await between(s, runbook.id, started.id, 1, 1);
    const stopping = s.person("POST", `/steps/${runbook.steps[0].id}/stop`);
    const done = await until(
      read(s, runbook.id, started.id),
      (r: Any) => r.status !== "running",
    );
    expect((await stopping).status).toBe(200);
    expect(done).toMatchObject({ status: "failed", error: "stopped by alice" });
    expect(done.items[0]).toMatchObject({
      status: "failed",
      error: "stopped by alice",
      nextAttemptAt: null,
    });
    expect(done.items[0].attempts).toHaveLength(1);
    expect(done.items[1].status).toBe("waiting");
    expect(s.execCalls).toHaveLength(1);
  });

  it("Stop during an attempt ends it as stopped, with no next attempt", async () => {
    const { s, runbook } = await setupRunbook([seqStep([wait("status")])]);
    const channels: FakeChannel[] = [];
    s.setChannel((channel) => channels.push(channel));
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await vi.waitFor(() => expect(channels).toHaveLength(1));
    channels[0].out("starting\n");
    await s.person("POST", `/steps/${runbook.steps[0].id}/stop`);
    const done = await until(
      read(s, runbook.id, started.id),
      (r: Any) => r.status !== "running",
    );
    expect(whys(done.items[0])).toEqual(["stopped"]);
    expect(done.items[0].attempts[0].stdout).toBe("starting\n");
    expect(channels).toHaveLength(1);
  });

  it("checks before each attempt after the first that the person may still connect; the sequence stops even with onFail continue", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { onFail: "continue" }), run("never")]),
    ]);
    answers(s, { status: [["starting\n", 0]] });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await between(s, runbook.id, started.id, 1, 1);
    const check = vi
      .spyOn(s.mock.ctx.hosts, "checkAccess")
      .mockResolvedValue({ hasAccess: false } as Any);
    const done = await ended(s, runbook.id, started.id);
    expect(check).toHaveBeenCalledWith(1, "connect");
    expect(done.status).toBe("failed");
    expect(done.items[0].error).toContain("can no longer connect");
    expect(done.items[0].attempts).toHaveLength(1);
    expect(done.items[1].status).toBe("waiting");
    expect(s.execCalls).toHaveLength(1);
  });

  it("acts as the person who pressed Run for every attempt, after the answer", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { every: 1 })]),
    ]);
    answers(s, {
      status: [
        ["starting\n", 0],
        ["starting\n", 0],
        ["healthy\n", 0],
      ],
    });
    const actors: Array<string | undefined> = [];
    const connect = s.mock.ctx.ssh.connect;
    (s.mock.ctx.ssh as Any).connect = (...args: Any[]) => {
      actors.push(s.mock.ctx.currentActor());
      return (connect as Any)(...args);
    };
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await s.person("GET", `/runbooks/${runbook.id}`, undefined, {
      user: "bob",
    });
    await ended(s, runbook.id, started.id);
    expect(actors).toEqual(["alice", "alice", "alice"]);
  });

  it("after a Termix restart mid-wait: the item and its attempt fail as interrupted, and Continue starts the wait again at attempt 1", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("one"), wait("status"), run("three")]),
    ]);
    answers(s, { status: [["starting\n", 0]] });
    const first = await runStep(s, runbook.id, runbook.steps[0].id, {}, "run", {
      wait: false,
    });
    const runId = first.body.id;
    await until(read(s, runbook.id, runId), (r: Any) =>
      Boolean(r.items[1].nextAttemptAt),
    );
    // What a Termix that stopped while attempt 2 ran leaves behind.
    const db = s.db.sqlite;
    const { deactivate, activate } = await import("../../src/backend/index.js");
    await deactivate();
    await until(read(s, runbook.id, runId), (r: Any) => r.status !== "running");
    db.prepare(
      "UPDATE p_runbooks_runs SET status = 'running', finished_at = NULL WHERE id = ?",
    ).run(runId);
    db.prepare(
      "UPDATE p_runbooks_run_items SET status = 'running', finished_at = NULL, next_attempt_at = '2026-01-01T00:00:00.000Z' WHERE run_id = ? AND position = 2",
    ).run(runId);
    db.prepare(
      "INSERT INTO p_runbooks_run_attempts (item_id, run_id, runbook_id, attempt, status, started_at, truncated, timed_out) SELECT id, run_id, runbook_id, 2, 'running', '2026-01-01T00:00:00.000Z', 0, 0 FROM p_runbooks_run_items WHERE run_id = ? AND position = 2",
    ).run(runId);
    db.prepare(
      "UPDATE p_runbooks_steps SET status = 'pending' WHERE id = ?",
    ).run(runbook.steps[0].id);
    // Termix starts again: the sweep fails what was left running.
    await activate(s.mock.ctx);
    const swept = await shownRun(s, runbook.id, runId);
    expect(swept.status).toBe("failed");
    expect(swept.items[1]).toMatchObject({
      status: "failed",
      nextAttemptAt: null,
    });
    expect(swept.items[1].error).toContain("interrupted");
    expect(swept.items[1].attempts.map((a: Any) => [a.status, a.why])).toEqual([
      ["failed", "check"],
      ["failed", "interrupted"],
    ]);
    answers(s, { status: [["healthy\n", 0]] });
    const shown = await view(s, runbook.id);
    const went = await s.person(
      "POST",
      `/steps/${shown.steps[0].id}/continue`,
      {
        revision: shown.steps[0].revision,
        commandHash: shown.steps[0].commandHash,
        fromItem: 2,
      },
    );
    expect(went.status, JSON.stringify(went.body)).toBe(200);
    const done = await until(
      read(s, runbook.id, went.body.id),
      (r: Any) => r.status !== "running",
    );
    expect(done.status).toBe("done");
    expect(done.items[1].attempts.map((a: Any) => a.attempt)).toEqual([1]);
    expect(done.items[0].fromRunId).toBe(runId);
  });

  it("Continue carries a wait that passed with its attempts", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { every: 1 }), run("last")]),
    ]);
    answers(s, {
      status: [
        ["starting\n", 0],
        ["healthy\n", 0],
      ],
      last: [
        ["", 1],
        ["fine\n", 0],
      ],
    });
    fake();
    const first = await start(s, runbook.id, runbook.steps[0].id);
    const failed = await ended(s, runbook.id, first.id);
    expect(failed.status).toBe("failed");
    vi.useRealTimers();
    const shown = await view(s, runbook.id);
    const went = await s.person(
      "POST",
      `/steps/${shown.steps[0].id}/continue`,
      {
        revision: shown.steps[0].revision,
        commandHash: shown.steps[0].commandHash,
      },
    );
    expect(went.status, JSON.stringify(went.body)).toBe(200);
    const done = await until(
      read(s, runbook.id, went.body.id),
      (r: Any) => r.status !== "running",
    );
    expect(done.status).toBe("done");
    expect(done.items[0].fromRunId).toBe(first.id);
    expect(whys(done.items[0])).toEqual(["check", null]);
    expect(done.items[0].attempts[0].id).not.toBe(
      failed.items[0].attempts[0].id,
    );
    expect(s.execCalls.map((c) => c.command)).toEqual([
      "status",
      "status",
      "last",
      "last",
    ]);
  });

  it("asks the repeat question only for a new Run press, never between attempts", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([wait("status", { every: 1 })]),
    ]);
    answers(s, {
      status: [
        ["no\n", 0],
        ["healthy\n", 0],
      ],
    });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("done");
    vi.useRealTimers();
    const again = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("repeat");
  });
});

describe("retry on a run item", () => {
  it("runs a flaky command again on the exponential schedule until it passes", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([
        run("fetch", {
          retry: { attempts: 5, backoff: "exponential", every: 2, factor: 3 },
        }),
      ]),
    ]);
    answers(s, {
      fetch: [
        ["", 7],
        ["", 7],
        ["got it\n", 0],
      ],
    });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("done");
    const item = done.items[0];
    expect(item).toMatchObject({
      status: "passed",
      maxAttempts: 5,
      exitCode: 0,
    });
    expect(whys(item)).toEqual(["exit", "exit", null]);
    const gaps = [1, 2].map(
      (n) =>
        Date.parse(item.attempts[n].startedAt) -
        Date.parse(item.attempts[n - 1].finishedAt),
    );
    expect(gaps).toEqual([2000, 6000]);
  });

  it("fails at once on a failure retryOn does not name", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([
        run("fetch", {
          checks: [{ type: "contains", text: "ok" }],
          retry: { attempts: 5, retryOn: ["timeout", "connect"] },
        }),
      ]),
    ]);
    answers(s, { fetch: [["nope\n", 0]] });
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("failed");
    expect(whys(done.items[0])).toEqual(["check"]);
    expect(done.items[0].checks[0].ok).toBe(false);
  });

  it("retries a connection that fails", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("fetch", { retry: { attempts: 3, every: 1 } })]),
    ]);
    const connect = s.mock.ctx.ssh.connect;
    let calls = 0;
    (s.mock.ctx.ssh as Any).connect = (...args: Any[]) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("host unreachable"));
      return (connect as Any)(...args);
    };
    s.setExec(async () => execResult("ok\n"));
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, started.id);
    expect(done.status).toBe("done");
    expect(whys(done.items[0])).toEqual(["connect", null]);
    expect(done.items[0].attempts[0].error).toBe("host unreachable");
  });

  it("a run item without retry keeps phase 1's record: no attempts", async () => {
    const { s, runbook } = await setupRunbook([seqStep([run("one")])]);
    s.setExec(async () => execResult("ok\n"));
    const done = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(done.body.items[0].attempts).toBeUndefined();
    expect(done.body.items[0].maxAttempts).toBeNull();
    const rows = s.db.sqlite
      .prepare("SELECT count(*) AS n FROM p_runbooks_run_attempts")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
