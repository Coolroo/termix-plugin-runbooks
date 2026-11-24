/**
 * 1.4.10: a step as a sequence of items. One Run runs the items in order
 * as the person who pressed it; a delay is a timer in the plugin; a failed
 * item stops the rest unless it says onFail "continue"; Stop, Skip and
 * Continue from item N; the access check between items.
 */
import { describe, expect, it, vi } from "vitest";
import {
  agentRunbook,
  everything,
  execResult,
  runStep,
  setupRunbook,
  shownRun,
  useTestServer,
  view,
  waitForRun,
  type FakeChannel,
  type TestServer,
} from "./helpers";

const testServer = useTestServer();

/** A step on host 1 with these items. */
const seqStep = (
  sequence: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => ({ title: "Deploy", hostId: 1, sequence, ...extra });

const run = (command: string, extra: Record<string, unknown> = {}) => ({
  type: "run",
  command,
  ...extra,
});

const delay = (seconds: number, reason?: string) => ({
  type: "delay",
  seconds,
  ...(reason ? { reason } : {}),
});

/** Answers each command from a map: [stdout, exit code]. */
function answer(s: TestServer, outputs: Record<string, [string, number]>) {
  s.setExec(async (_host, command) => {
    const found = outputs[command];
    return execResult(found?.[0] ?? "", { code: found?.[1] ?? 0 });
  });
}

/** Holds each command until the test ends it through its channel. */
function hold(s: TestServer) {
  const channels: Array<{ channel: FakeChannel; command: string }> = [];
  s.setChannel((channel, command) => {
    channels.push({ channel, command });
  });
  return channels;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const states = (r: Any) =>
  r.items.map((item: Any) => `${item.position}:${item.status}`);

/** Starts the step and returns the run as the Run answer gives it. */
async function start(s: TestServer, runbookId: number, stepId: number) {
  const reply = await runStep(s, runbookId, stepId, {}, "run", {
    wait: false,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body;
}

/** Waits until the run's item at `position` has `status`. */
async function itemIs(
  s: TestServer,
  runbookId: number,
  runId: number,
  position: number,
  status: string,
) {
  return vi.waitFor(
    async () => {
      const shown = await shownRun(s, runbookId, runId);
      const item = shown.items[position - 1];
      if (item.status !== status) {
        throw new Error(`item ${position} is ${item.status}`);
      }
      return shown;
    },
    { timeout: 3000, interval: 5 },
  );
}

describe("writing a sequence", () => {
  it("stores run and delay items and a workdir; a one-command step keeps its shape", async () => {
    const { runbook } = await setupRunbook([
      seqStep(
        [
          run("deploy", { label: "Deploy", onFail: "stop" }),
          delay(30, "let it start"),
          run("health", { onFail: "continue", timeoutMs: 5000 }),
        ],
        { workdir: "/srv/app" },
      ),
      { title: "Old", hostId: 1, command: "uptime" },
    ]);
    expect(runbook.steps[0]).toMatchObject({
      command: null,
      workdir: "/srv/app",
      sequence: [
        {
          type: "run",
          label: "Deploy",
          command: "deploy",
          checks: [],
          captures: [],
          timeoutMs: null,
          onFail: "stop",
          interactive: false,
        },
        { type: "delay", label: null, seconds: 30, reason: "let it start" },
        { type: "run", command: "health", onFail: "continue", timeoutMs: 5000 },
      ],
    });
    expect(runbook.steps[1]).toMatchObject({
      command: "uptime",
      sequence: null,
      workdir: null,
    });
  });

  it.each([
    [{ sequence: [] }, "at least one item"],
    [
      { sequence: Array.from({ length: 21 }, () => run("x")) },
      "at most 20 items",
    ],
    [{ sequence: [delay(0)] }, "seconds must be an integer from 1 to 3600"],
    [{ sequence: [delay(3601)] }, "seconds must be an integer from 1 to 3600"],
    [{ sequence: [delay(5)] }, "at least one item that is not a delay"],
    [{ sequence: [run("")] }, "sequence[0].command is required"],
    [
      { sequence: [run("a", { onFail: "maybe" })] },
      'onFail must be "stop" or "continue"',
    ],
    [
      { sequence: [run("a", { extra: 1 })] },
      'unknown sequence[0] field "extra"',
    ],
    // 1.4.10, phase 3: the events need within, as a wait does.
    [{ sequence: [{ type: "port", port: 22 }] }, "within is required"],
    [{ sequence: [{ type: "container", name: "x" }] }, "within is required"],
    [{ sequence: [{ type: "nope" }] }, 'type must be "run", "wait", "delay"'],
    [
      {
        sequence: [
          run("a", { captures: [{ name: "v", pattern: "(x)" }] }),
          run("b", { captures: [{ name: "v", pattern: "(y)" }] }),
        ],
      },
      'capture "v" is already captured',
    ],
    [
      { sequence: [run("a", { checks: [{ type: "value", name: "nope" }] })] },
      "is not a capture of this item",
    ],
    [
      {
        sequence: [
          run("a", {
            interactive: true,
            checks: [{ type: "contains", text: "x", stream: "stderr" }],
          }),
        ],
      },
      "one output stream",
    ],
    [{ sequence: [run("a")], command: "b" }, "cannot have command"],
    [
      { sequence: [run("a")], checks: [{ type: "exitCode", equals: 0 }] },
      "cannot have checks",
    ],
    [
      { sequence: [run("a")], captures: [{ name: "v", pattern: "(x)" }] },
      "cannot have captures",
    ],
    [{ sequence: [run("a")], timeoutMs: 5000 }, "cannot have timeoutMs"],
    [{ sequence: [run("a")], interactive: true }, "cannot have interactive"],
    [
      { sequence: [run("a")], stdin: { from: "value", name: "x" } },
      "cannot have stdin",
    ],
    [{ sequence: [run("a")], runIn: "terminal" }, 'runIn "terminal"'],
    [{ sequence: [run("a")], hostId: null }, "needs a hostId"],
    [{ sequence: [run("a")], owner: "agent", hostId: null }, "agent step"],
    [{ sequence: [run("a")], workdir: "srv" }, "absolute path"],
    [{ sequence: [run("a")], workdir: "~/srv" }, "absolute path"],
    [
      { command: null, hostId: null, workdir: "/srv" },
      "workdir needs a command",
    ],
  ])("refuses %j", async (fields, message) => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [{ title: "S", hostId: 1, ...fields }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(400);
    expect(made.body.error).toContain(message);
  });

  it("takes a workdir on a one-command step: the command runs in it and the person sees it", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "One", hostId: 1, command: "ls", workdir: "/srv/it's" },
    ]);
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].resolvedCommand).toBe(`cd -- '/srv/it'\\''s' && ls`);
    s.setExec(async () => execResult("a\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.command).toBe(`cd -- '/srv/it'\\''s' && ls`);
    expect(ran.body.items).toBeUndefined();
  });
});

describe("the ban on sleep", () => {
  const refused = [
    "sleep 5",
    "systemctl restart x && sleep 10 && systemctl status x",
    "/usr/bin/sleep 0.5",
    'sleep "$DELAY"',
    "sleep ${D}",
    "sleep infinity",
    "SLEEP 3",
    "bash -c 'sleep 5; echo done'",
    "python3 -c 'import time; time.sleep(5)'",
    "for i in 1 2 3; do curl -s x && break; sleep 2; done",
    "Start-Sleep -Seconds 5",
    "start-sleep 5",
    "timeout /t 10",
    "timeout.exe /T 10 /nobreak",
    "ping -n 6 127.0.0.1 >nul",
    "ping -n 3 localhost",
    "ping 1.2.3.4 -n 5 > $null",
    // BUG-022 L6: the gaps the 1.4.10 review found.
    "sleep${IFS}5",
    "sleep -- 5",
    "s''leep 5",
    "s\\leep 5",
    '"sl"eep 5',
    "read -t 5 x < /dev/zero",
    "read -rt 5",
    "timeout 5 tail -f /dev/null",
    "timeout -s KILL 5 tail -f /dev/null",
    "timeout 5s cat",
    "timeout 10 journalctl -fu app.service",
    "timeout 5 ping 1.1.1.1",
    "ping -c 5 127.0.0.1",
    "node -e 'await sleep(100)'",
  ];
  const allowed = [
    "docker compose up -d --wait",
    'echo "sleeping beauty"',
    'echo "time to sleep now"',
    "systemctl status sleep.target",
    "usleep-helper --no-sleep 5",
    "timeout 30 curl -s https://example.test",
    "ping -n 4 8.8.8.8",
    "ping -c 3 192.168.1.1",
    "grep -r sleepy /var/log",
    "my-sleep-tool status",
    // BUG-022 L6: not waits.
    "systemctl status systemd-suspend sleep.target",
    "timeout 5 ping -c 2 1.1.1.1",
    "timeout 60 cat /etc/hosts",
    "timeout 30 docker compose logs app",
    "git log --format='%s' | cat",
    "docker run --read-only -t app",
  ];

  it.each(refused)(
    "refuses %j on create, in a command and in a run item",
    async (command) => {
      const s = await testServer();
      const token = await s.makeToken();
      for (const step of [
        { title: "S", hostId: 1, command },
        seqStep([run("prepare"), run(command)]),
      ]) {
        const made = await s.agent("POST", "/runbooks", token, {
          title: "Bad",
          steps: [step],
        });
        expect(made.status, command).toBe(400);
        expect(made.body.code).toBe("sleep");
        expect(made.body.error).toContain('"type":"delay"');
      }
    },
  );

  it.each(allowed)("takes %j", async (command) => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Fine",
      steps: [{ title: "S", hostId: 1, command }, seqStep([run(command)])],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  });

  it("refuses it on add-steps, update-step, amend and through MCP", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "A", hostId: 1, command: "true" },
    ]);
    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [{ title: "B", hostId: 1, command: "sleep 3" }],
      },
    );
    expect(added.status).toBe(400);
    expect(added.body.error).toContain("steps[0]: command waits");
    const patched = await s.agent(
      "PATCH",
      `/steps/${runbook.steps[0].id}`,
      token,
      { sequence: [run("x"), run("sleep 9")], command: null },
    );
    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain("sequence[1].command waits");
    const amended = await s.agent(
      "POST",
      `/steps/${runbook.steps[0].id}/amend`,
      token,
      {
        kind: "substep",
        reason: "wait",
        step: { title: "W", hostId: 1, command: "Start-Sleep 5" },
      },
    );
    expect(amended.status).toBe(400);
    expect(amended.body.error).toContain("Start-Sleep");
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_steps",
        arguments: {
          runbookId: runbook.id,
          steps: [{ title: "B", hostId: 1, command: "sleep 3" }],
        },
      },
    });
    expect(mcp.body.result.isError).toBe(true);
    expect(JSON.stringify(mcp.body.result.content)).toContain("delay");
  });

  it("is off when the admin turns it off, and steps stored before keep running", async () => {
    const s = await testServer({ settings: { banSleep: false } });
    const token = await s.makeToken();
    const made = await agentRunbook(s, token, {
      title: "Old ways",
      steps: [{ title: "S", hostId: 1, command: "sleep 1 && echo ok" }],
    });
    // The ban is back on: the stored step still runs.
    await s.mock.ctx.settings.set("banSleep", true);
    const refused = await s.agent("POST", "/runbooks", token, {
      title: "New",
      steps: [{ title: "S", hostId: 1, command: "sleep 1" }],
    });
    expect(refused.status).toBe(400);
    s.setExec(async () => execResult("ok\n"));
    const ran = await runStep(s, made.id, made.steps[0].id);
    expect(ran.body.status).toBe("done");
  });
});

describe("running a sequence", () => {
  it("runs each run item on its own connection, in the workdir, and keeps a record of each", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep(
        [
          run("deploy app", { label: "Deploy" }),
          run("show version", {
            captures: [{ name: "ver", pattern: "version=(\\S+)" }],
            // BUG-022 M3: a captured value goes into a command with a pattern.
            checks: [
              { type: "contains", text: "version=" },
              { type: "value", name: "ver", matches: "^[0-9.]+$" },
            ],
          }),
          run("echo got {{ver}}"),
        ],
        { workdir: "/srv/my app" },
      ),
      { title: "Later", hostId: 1, command: "use {{ver}}" },
    ]);
    answer(s, {
      "cd -- '/srv/my app' && deploy app": ["deployed\n", 0],
      "cd -- '/srv/my app' && show version": ["version=1.2.3\n", 0],
      "cd -- '/srv/my app' && echo got 1.2.3": ["got 1.2.3\n", 0],
    });
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].resolvedSequence[2]).toMatchObject({
      command: "echo got {{ver}}",
      later: ["ver"],
    });
    expect(shown.steps[0].missing).toEqual([]);
    expect(shown.steps[0].commandHash).toMatch(/^[0-9a-f]{64}$/);
    // The step after it cannot run before the value is there.
    expect(shown.steps[1].missing).toEqual(["ver"]);
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body).toMatchObject({
      status: "done",
      mode: "exec",
      stdout: "deployed\nversion=1.2.3\ngot 1.2.3\n",
      captured: { ver: "1.2.3" },
      exitCode: 0,
      userId: "alice",
    });
    expect(states(ran.body)).toEqual(["1:passed", "2:passed", "3:passed"]);
    expect(ran.body.items[0]).toMatchObject({ label: "Deploy", type: "run" });
    expect(ran.body.items[2]).toMatchObject({
      command: "echo got 1.2.3",
      stdout: "got 1.2.3\n",
      exitCode: 0,
    });
    expect(ran.body.items[1].checks).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(s.execCalls.map((call) => call.command)).toEqual([
      "cd -- '/srv/my app' && deploy app",
      "cd -- '/srv/my app' && show version",
      "cd -- '/srv/my app' && echo got 1.2.3",
    ]);
    expect(s.connections).toEqual({ opened: 3, disposed: 3 });
    const after = await view(s, runbook.id);
    expect(after.steps[0].status).toBe("done");
    expect(after.steps[1].resolvedCommand).toBe("use 1.2.3");
    // One run item line in the audit for each item.
    expect(
      s.mock.audits.filter((a) => a.action === "runbooks_step_run"),
    ).toHaveLength(3);
  });

  it("stops at a failed item; onFail continue goes on; the step fails at the stopping item", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([
        run("report", { onFail: "continue" }),
        run("build"),
        run("deploy"),
      ]),
    ]);
    answer(s, { report: ["warn\n", 3], build: ["", 2] });
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(states(ran.body)).toEqual(["1:failed", "2:failed", "3:waiting"]);
    expect(ran.body).toMatchObject({
      status: "failed",
      exitCode: 2,
      error: "item 2 failed",
      captured: {},
    });
    expect(s.execCalls.map((call) => call.command)).toEqual([
      "report",
      "build",
    ]);
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].status).toBe("failed");
  });

  it("ends done when only an onFail continue item failed", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("work"), run("report", { onFail: "continue" })]),
    ]);
    answer(s, { report: ["", 1] });
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(states(ran.body)).toEqual(["1:passed", "2:failed"]);
  });

  it("fails an item whose checks fail even on exit 0, and keeps no captures from it", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([
        run("status", {
          checks: [{ type: "contains", text: "active" }],
          captures: [{ name: "st", pattern: "(\\w+)" }],
        }),
        run("next"),
      ]),
    ]);
    answer(s, { status: ["stopped\n", 0] });
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("failed");
    expect(ran.body.items[0]).toMatchObject({
      status: "failed",
      exitCode: 0,
      captured: {},
    });
    expect(ran.body.items[0].checks[0].ok).toBe(false);
    expect(states(ran.body)).toEqual(["1:failed", "2:waiting"]);
    expect(s.execCalls).toHaveLength(1);
  });

  it("waits a delay on the server, shows its planned end, and Skip goes on", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("one"), delay(600, "let it settle"), run("two")]),
    ]);
    answer(s, {});
    const started = await start(s, runbook.id, runbook.steps[0].id);
    const during = await itemIs(s, runbook.id, started.id, 2, "running");
    expect(during.running).toBe(true);
    const planned = Date.parse(during.items[1].plannedEndAt);
    expect(planned - Date.parse(during.items[1].startedAt)).toBe(600_000);
    expect(s.execCalls).toHaveLength(1);
    const skipped = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/skip-delay`,
    );
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    expect(skipped.body.items[1]).toMatchObject({
      status: "skipped",
      skippedBy: "alice",
    });
    const done = await waitForRun(s, runbook.id, started.id);
    expect(done.status).toBe("done");
    expect(states(done)).toEqual(["1:passed", "2:skipped", "3:passed"]);
    expect(s.execCalls.map((call) => call.command)).toEqual(["one", "two"]);
    expect(
      s.mock.audits.some((a) => a.action === "runbooks_step_delay_skipped"),
    ).toBe(true);
    const again = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/skip-delay`,
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("no-delay");
  });

  it("ends a short delay by itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { s, runbook } = await setupRunbook([
        seqStep([delay(2), run("after")]),
      ]);
      answer(s, {});
      const started = await start(s, runbook.id, runbook.steps[0].id);
      await vi.waitFor(async () => {
        const shown = await shownRun(s, runbook.id, started.id);
        if (shown.items[0].status !== "running") throw new Error("not yet");
      });
      await vi.advanceTimersByTimeAsync(2000);
      vi.useRealTimers();
      const done = await waitForRun(s, runbook.id, started.id);
      expect(states(done)).toEqual(["1:passed", "2:passed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Stop during a delay stops the rest; Stop during a command too", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([delay(600), run("never")]),
      seqStep([run("long"), run("never")]),
    ]);
    const channels = hold(s);
    const first = await start(s, runbook.id, runbook.steps[0].id);
    await itemIs(s, runbook.id, first.id, 1, "running");
    const stopped = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/stop`,
    );
    expect(stopped.status).toBe(200);
    const one = await waitForRun(s, runbook.id, first.id);
    expect(one).toMatchObject({ status: "failed", error: "stopped by alice" });
    expect(states(one)).toEqual(["1:failed", "2:waiting"]);
    expect(one.items[0].error).toBe("stopped by alice");

    const second = await runStep(
      s,
      runbook.id,
      runbook.steps[1].id,
      { outOfOrder: true },
      "run",
      { wait: false },
    );
    await itemIs(s, runbook.id, second.body.id, 1, "running");
    await vi.waitFor(() => expect(channels).toHaveLength(1));
    channels[0].channel.out("working\n");
    await s.person("POST", `/steps/${runbook.steps[1].id}/stop`);
    const two = await waitForRun(s, runbook.id, second.body.id);
    expect(states(two)).toEqual(["1:failed", "2:waiting"]);
    expect(two.items[0].stdout).toBe("working\n");
    expect(channels).toHaveLength(1);
  });

  it("streams the running item's output live, then keeps it on the item", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("first"), run("second")]),
    ]);
    const channels = hold(s);
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await vi.waitFor(() => expect(channels).toHaveLength(1));
    channels[0].channel.out("part one\n");
    await vi.waitFor(async () => {
      const shown = await shownRun(s, runbook.id, started.id);
      expect(shown.items[0].stdout).toBe("part one\n");
      expect(shown.items[1].stdout).toBeNull();
      expect(shown.stdout).toBe("");
    });
    channels[0].channel.exit(0);
    await vi.waitFor(() => expect(channels).toHaveLength(2));
    channels[1].channel.out("part two\n");
    channels[1].channel.exit(0);
    const done = await waitForRun(s, runbook.id, started.id);
    expect(done.items.map((item: Any) => item.stdout)).toEqual([
      "part one\n",
      "part two\n",
    ]);
    expect(done.stdout).toBe("part one\npart two\n");
  });

  it("checks before each item after the first that the person may still connect", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("one"), run("two")]),
    ]);
    const channels = hold(s);
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await vi.waitFor(() => expect(channels).toHaveLength(1));
    const check = vi
      .spyOn(s.mock.ctx.hosts, "checkAccess")
      .mockResolvedValue({ hasAccess: false } as Any);
    channels[0].channel.exit(0);
    const done = await waitForRun(s, runbook.id, started.id);
    expect(check).toHaveBeenCalledWith(1, "connect");
    expect(states(done)).toEqual(["1:passed", "2:failed"]);
    expect(done.items[1].error).toContain("can no longer connect");
    expect(done.status).toBe("failed");
    expect(channels).toHaveLength(1);
  });

  it("acts as the person who pressed Run for every item, after the answer", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("one"), delay(600), run("two")]),
    ]);
    answer(s, {});
    const actors: Array<string | undefined> = [];
    const connect = s.mock.ctx.ssh.connect;
    (s.mock.ctx.ssh as Any).connect = (...args: Any[]) => {
      actors.push(s.mock.ctx.currentActor());
      return (connect as Any)(...args);
    };
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await itemIs(s, runbook.id, started.id, 2, "running");
    // Another person's request comes in meanwhile.
    await s.person("GET", `/runbooks/${runbook.id}`, undefined, {
      user: "bob",
    });
    await s.person("POST", `/steps/${runbook.steps[0].id}/skip-delay`);
    await waitForRun(s, runbook.id, started.id);
    expect(actors).toEqual(["alice", "alice"]);
  });

  it("refuses Send to terminal for a sequence", async () => {
    const { s, runbook } = await setupRunbook([seqStep([run("a")])]);
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe("sequence");
  });

  it("asks before running a sequence again from item 1", async () => {
    const { s, runbook } = await setupRunbook([seqStep([run("a")])]);
    answer(s, {});
    await runStep(s, runbook.id, runbook.steps[0].id);
    const again = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("repeat");
    const confirmed = await runStep(s, runbook.id, runbook.steps[0].id, {
      confirmRepeat: true,
    });
    expect(confirmed.body.status).toBe("done");
  });
});

describe("Continue from item N", () => {
  it("after a failure: the items that passed are carried, the rest run; values flow on", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([
        // BUG-022 M3: a captured value goes into a command with a pattern.
        run("make", {
          captures: [{ name: "id", pattern: "id=(\\d+)" }],
          checks: [{ type: "value", name: "id", matches: "^\\d+$" }],
        }),
        run("use {{id}}"),
        run("last"),
      ]),
    ]);
    let fail = true;
    s.setExec(async (_h, command) =>
      command === "make"
        ? execResult("id=42\n")
        : command === "use 42" && fail
          ? execResult("", { code: 1 })
          : execResult(`${command}\n`),
    );
    const first = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(states(first.body)).toEqual(["1:passed", "2:failed", "3:waiting"]);
    fail = false;
    const shown = await view(s, runbook.id);
    const step = shown.steps[0];
    const wrong = await s.person("POST", `/steps/${step.id}/continue`, {
      revision: step.revision,
      commandHash: step.commandHash,
      fromItem: 3,
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("changed");
    const went = await s.person("POST", `/steps/${step.id}/continue`, {
      revision: step.revision,
      commandHash: step.commandHash,
      fromItem: 2,
    });
    expect(went.status, JSON.stringify(went.body)).toBe(200);
    const done = await waitForRun(s, runbook.id, went.body.id);
    expect(done.status).toBe("done");
    expect(states(done)).toEqual(["1:passed", "2:passed", "3:passed"]);
    expect(done.items[0].fromRunId).toBe(first.body.id);
    expect(done.items[1].fromRunId).toBeNull();
    expect(done.captured).toEqual({ id: "42" });
    expect(done.stdout).toBe("id=42\nuse 42\nlast\n");
    // "make" ran once in all.
    expect(s.execCalls.map((call) => call.command)).toEqual([
      "make",
      "use 42",
      "use 42",
      "last",
    ]);
    expect(
      s.mock.audits.some((a) => a.action === "runbooks_step_continue"),
    ).toBe(true);
    const after = await view(s, runbook.id);
    expect(after.steps[0].status).toBe("done");
    // A done step has nothing to continue.
    const nothing = await s.person("POST", `/steps/${step.id}/continue`, {
      revision: after.steps[0].revision,
      commandHash: after.steps[0].commandHash,
    });
    expect(nothing.status).toBe(409);
    expect(nothing.body.code).toBe("nothing-to-continue");
  });

  it("after a stop during a delay: the delay runs again, the item before it does not", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("one"), delay(600), run("two")]),
    ]);
    answer(s, {});
    const first = await start(s, runbook.id, runbook.steps[0].id);
    await itemIs(s, runbook.id, first.id, 2, "running");
    await s.person("POST", `/steps/${runbook.steps[0].id}/stop`);
    await waitForRun(s, runbook.id, first.id);
    const shown = await view(s, runbook.id);
    const went = await s.person(
      "POST",
      `/steps/${shown.steps[0].id}/continue`,
      {
        revision: shown.steps[0].revision,
        commandHash: shown.steps[0].commandHash,
      },
    );
    expect(went.status).toBe(200);
    await itemIs(s, runbook.id, went.body.id, 2, "running");
    await s.person("POST", `/steps/${runbook.steps[0].id}/skip-delay`);
    const done = await waitForRun(s, runbook.id, went.body.id);
    expect(states(done)).toEqual(["1:passed", "2:skipped", "3:passed"]);
    expect(s.execCalls.map((call) => call.command)).toEqual(["one", "two"]);
  });

  it("after a Termix restart mid-sequence: the cut-off item fails, the rest wait, and Continue starts there", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("one"), run("two"), run("three")]),
    ]);
    answer(s, { two: ["", 1] });
    const first = await runStep(s, runbook.id, runbook.steps[0].id);
    // What a Termix that stopped while item 2 ran leaves behind.
    const db = s.db.sqlite;
    db.prepare(
      "UPDATE p_runbooks_runs SET status = 'running', finished_at = NULL WHERE id = ?",
    ).run(first.body.id);
    db.prepare(
      "UPDATE p_runbooks_run_items SET status = 'running', finished_at = NULL WHERE run_id = ? AND position = 2",
    ).run(first.body.id);
    db.prepare(
      "UPDATE p_runbooks_steps SET status = 'pending' WHERE id = ?",
    ).run(runbook.steps[0].id);
    // Termix starts again: the sweep fails what was left running.
    const { activate } = await import("../../src/backend/index.js");
    await activate(s.mock.ctx);
    const swept = await shownRun(s, runbook.id, first.body.id);
    expect(swept.status).toBe("failed");
    expect(swept.error).toContain("interrupted");
    expect(states(swept)).toEqual(["1:passed", "2:failed", "3:waiting"]);
    expect(swept.items[1].error).toContain("interrupted");
    answer(s, {});
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].status).toBe("failed");
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
    const done = await waitForRun(s, runbook.id, went.body.id);
    expect(states(done)).toEqual(["1:passed", "2:passed", "3:passed"]);
    expect(s.execCalls.map((call) => call.command)).toEqual([
      "one",
      "two",
      "two",
      "three",
    ]);
  });

  it("after Runbooks stops mid-sequence: the item ends interrupted, not stopped by a person", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([run("one"), delay(600), run("two")]),
    ]);
    answer(s, {});
    const first = await start(s, runbook.id, runbook.steps[0].id);
    await itemIs(s, runbook.id, first.id, 2, "running");
    const { deactivate } = await import("../../src/backend/index.js");
    await deactivate();
    const done = await waitForRun(s, runbook.id, first.id);
    expect(done.status).toBe("failed");
    expect(done.items[1].error).toContain("Runbooks was stopped");
    expect(states(done)).toEqual(["1:passed", "2:failed", "3:waiting"]);
  });

  it("is refused when the sequence changed since that run", async () => {
    const { s, token, runbook } = await setupRunbook([
      seqStep([run("one"), run("two")]),
    ]);
    answer(s, { two: ["", 1] });
    await runStep(s, runbook.id, runbook.steps[0].id);
    // The author changes a value the sequence uses.
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      values: { x: "1" },
    });
    const shown = await view(s, runbook.id);
    const went = await s.person(
      "POST",
      `/steps/${shown.steps[0].id}/continue`,
      {
        revision: shown.steps[0].revision,
        commandHash: shown.steps[0].commandHash,
      },
    );
    // Values the sequence does not use change nothing: it continues.
    expect(went.status).toBe(200);
    await waitForRun(s, runbook.id, went.body.id);
  });

  it("is refused for a step that is not a sequence", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "One", hostId: 1, command: "x" },
    ]);
    const shown = await view(s, runbook.id);
    const went = await s.person(
      "POST",
      `/steps/${shown.steps[0].id}/continue`,
      {
        revision: shown.steps[0].revision,
        commandHash: shown.steps[0].commandHash,
      },
    );
    expect(went.status).toBe(400);
    expect(went.body.code).toBe("not-sequence");
  });
});

describe("old one-command steps", () => {
  it("run as before: no items, no run_items rows", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "One", hostId: 1, command: "uptime" },
    ]);
    s.setExec(async () => execResult("up\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.items).toBeUndefined();
    expect(ran.body.command).toBe("uptime");
    expect(everything(s)).not.toContain('"run_id"');
    const shown = await view(s, runbook.id);
    expect(shown.steps[0]).toMatchObject({
      sequence: null,
      resolvedSequence: null,
      workdir: null,
      resolvedCommand: "uptime",
    });
  });
});
