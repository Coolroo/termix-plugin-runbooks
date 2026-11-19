/**
 * VM steps (1.4.7, T-029): a person presses one button and HAW VM Manager
 * (a fake of its service haw.vms) acts on a VM as that person. The step's
 * shape, the card's read, every action, the wait, the refusals, the gates,
 * force, the values, the console and the agent's read-only route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRunbook,
  auditText,
  useTestServer,
  view,
  waitForRun,
  type TestServer,
} from "./helpers";
import { vmTiming } from "../../src/backend/vms/vm-run";

const testServer = useTestServer();

const saved = { ...vmTiming };
beforeAll(() => {
  vmTiming.pollMs = 5;
  vmTiming.secondMs = 40;
});
afterAll(() => Object.assign(vmTiming, saved));

const startBuild = {
  title: "Start the build VM",
  vm: { host: 1, name: "build-1", action: "start", value: "build" },
};

/** A server with HAW, a token, and a runbook the agent made with `steps`. */
async function setup(
  steps: Array<Record<string, unknown>>,
  options: { haw?: boolean; values?: Record<string, string> } = {},
) {
  const s = await testServer({ haw: options.haw ?? true });
  s.haw?.seed(1, { name: "build-1" });
  s.haw?.seed(1, {
    name: "web-1",
    state: "running",
    addresses: ["192.0.2.20"],
    protected: true,
  });
  s.haw?.seed(1, { name: "Odd Name", allowed: false });
  const token = await s.makeToken();
  const runbook = await agentRunbook(s, token, {
    title: "VMs",
    steps,
    ...(options.values ? { values: options.values } : {}),
  });
  return { s, token, runbook };
}

/** Presses a VM step's button with what the view showed. */
async function press(
  s: TestServer,
  runbookId: number,
  stepId: number,
  extra: Record<string, unknown> = {},
  options: { user?: string } = {},
) {
  const shown = await view(s, runbookId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step = shown.steps.find((x: any) => x.id === stepId);
  return s.person(
    "POST",
    `/steps/${stepId}/vm`,
    { revision: step.revision, ...extra },
    options,
  );
}

/** Presses and waits for the run to end. */
async function pressAndWait(
  s: TestServer,
  runbookId: number,
  stepId: number,
  extra: Record<string, unknown> = {},
) {
  const reply = await press(s, runbookId, stepId, extra);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return waitForRun(s, runbookId, reply.body.run.id);
}

const stepOf = async (s: TestServer, runbookId: number, index: number) =>
  (await view(s, runbookId)).steps[index];

describe("VM steps: what an author writes", () => {
  it("stores vm with its defaults and shows it to people and agents", async () => {
    const { s, token, runbook } = await setup([
      startBuild,
      { title: "Look", vm: { host: 1, name: "build-1", action: "show" } },
      {
        title: "Stop",
        vm: {
          host: 1,
          name: "build-1",
          action: "stop",
          force: true,
          waitSeconds: 60,
        },
      },
    ]);
    const [start, show, stop] = (await view(s, runbook.id)).steps;
    expect(start.vm).toEqual({
      host: 1,
      name: "build-1",
      action: "start",
      force: false,
      waitFor: "running",
      waitSeconds: 300,
      value: "build",
    });
    expect(show.vm.waitFor).toBeNull();
    expect(stop.vm).toMatchObject({
      force: true,
      waitFor: "off",
      waitSeconds: 60,
    });
    expect(start.vmHostName).toBe("host-1");
    expect(start.vmProblem).toBeNull();
    expect(start.command).toBeNull();
    const agent = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(agent.body.steps[0].vm).toEqual(start.vm);
  });

  it.each([
    [{ owner: "agent" }, "for a person"],
    [{ command: "echo hi", hostId: 1 }, "cannot have command"],
    [{ hostId: 1 }, "cannot have hostId"],
    [{ captures: [{ name: "x", pattern: "(.*)" }] }, "use vm.value"],
    [{ interactive: true }, "interactive"],
    [{ timeoutMs: 5000 }, "vm.waitSeconds"],
    [{ checks: [{ type: "exitCode", equals: 0 }] }, "no exit code"],
    [{ vm: { ...startBuild.vm, force: true } }, "stop and restart only"],
    [{ vm: { ...startBuild.vm, action: "console" } }, "not for console"],
    [{ vm: { ...startBuild.vm, waitFor: "flying" } }, "vm.waitFor must be"],
    [{ vm: { ...startBuild.vm, waitSeconds: 601 } }, "1 to 600"],
    [{ vm: { ...startBuild.vm, name: "web-*" } }, "vm.name"],
    [{ vm: { ...startBuild.vm, extra: 1 } }, 'unknown field "extra"'],
    [{ vm: { ...startBuild.vm, host: 9 } }, "not a host this token may use"],
    [{ vm: { ...startBuild.vm, host: 2 } }, "not a VM host in HAW"],
    [
      {
        vm: { host: 1, name: "build-1", action: "console" },
        checks: [{ type: "contains", text: "x" }],
      },
      "no output to check",
    ],
  ])("refuses %j", async (change, words) => {
    const s = await testServer({ haw: true });
    const token = await s.makeToken();
    const reply = await s.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [{ ...startBuild, ...change }],
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(400);
    expect(reply.body.error).toContain(words);
  });

  it("takes a host HAW cannot check when HAW is not there; the card says why", async () => {
    const { s, runbook } = await setup([startBuild], { haw: false });
    const step = await stepOf(s, runbook.id, 0);
    expect(step.vmProblem).toMatch(/Install HAW VM Manager/);
    const read = await s.person("GET", `/steps/${step.id}/vm`);
    expect(read.body).toMatchObject({ ready: false, code: "no-haw" });
    const pressed = await press(s, runbook.id, step.id);
    expect(pressed.status).toBe(409);
    expect(pressed.body.code).toBe("no-haw");
  });

  it("works through update_step, amend_step and MCP", async () => {
    const { s, token, runbook } = await setup([{ title: "Later" }]);
    const stepId = runbook.steps[0].id;
    const changed = await s.agent("PATCH", `/steps/${stepId}`, token, {
      vm: { host: 1, name: "build-1", action: "restart" },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await stepOf(s, runbook.id, 0)).vm.action).toBe("restart");
    const bad = await s.agent("PATCH", `/steps/${stepId}`, token, {
      command: "reboot",
    });
    expect(bad.status).toBe(400);
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_steps",
        arguments: {
          runbookId: runbook.id,
          steps: [
            { title: "Show", vm: { host: 1, name: "web-1", action: "show" } },
          ],
        },
      },
    });
    expect(mcp.body.result.isError, JSON.stringify(mcp.body)).toBeFalsy();
    const amended = await s.agent("POST", `/steps/${stepId}/amend`, token, {
      kind: "substep",
      reason: "look first",
      step: { title: "Look", vm: { host: 1, name: "build-1", action: "show" } },
    });
    expect(amended.status, JSON.stringify(amended.body)).toBe(200);
    const steps = (await view(s, runbook.id)).steps;
    expect(
      steps.map((step: { vm: { action: string } | null }) => step.vm?.action),
    ).toEqual(["restart", "show", "show"]);
  });
});

describe("VM steps: the card", () => {
  it("reads the VM's state now, as the person, without HAW's record", async () => {
    const { s, runbook } = await setup([startBuild]);
    const step = await stepOf(s, runbook.id, 0);
    const read = await s.person("GET", `/steps/${step.id}/vm`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      ready: true,
      reason: null,
      role: "operator",
      hostName: "host-1",
      refused: null,
      vm: { name: "build-1", state: "off" },
    });
    const show = s.haw!.calls.find((call) => call.method === "show")!;
    expect(show).toMatchObject({
      user: "alice",
      ref: `runbook ${runbook.id} step 1`,
      agent: false,
    });
  });

  it("says the host refuses a protected VM's stop and one outside the pattern", async () => {
    const { s, runbook } = await setup([
      { title: "Stop web", vm: { host: 1, name: "web-1", action: "stop" } },
      {
        title: "Start odd",
        vm: { host: 1, name: "Odd Name", action: "start" },
      },
      { title: "Show odd", vm: { host: 1, name: "Odd Name", action: "show" } },
    ]);
    const steps = (await view(s, runbook.id)).steps;
    const read = async (i: number) =>
      (await s.person("GET", `/steps/${steps[i].id}/vm`)).body;
    expect((await read(0)).refused).toMatch(/protect list/);
    expect((await read(1)).refused).toMatch(/name pattern/);
    expect((await read(2)).refused).toBeNull();
  });

  it.each([
    [
      "plugin not allowed",
      (s: TestServer) => s.haw!.allowed.clear(),
      "plugin-not-allowed",
      /Plugins that may act for a person/,
    ],
    [
      "viewer role",
      (s: TestServer) => s.haw!.roles.set("alice", "viewer"),
      "role",
      /operator or owner/,
    ],
    [
      "no such VM",
      (s: TestServer) => s.haw!.vms.delete("1/build-1"),
      "not-found",
      /no VM named build-1/,
    ],
    [
      "verb not offered",
      (s: TestServer) =>
        (s.haw!.hostMap.get(1)!.verbs = ["info", "list", "show"]),
      "verb-not-offered",
      /does not offer start/,
    ],
    [
      "verbs not read yet (BUG-016)",
      (s: TestServer) => (s.haw!.hostMap.get(1)!.verbs = []),
      "verbs-unknown",
      /HAW has not read host-1's verbs yet/,
    ],
  ])("says why it cannot run: %s", async (_label, change, code, words) => {
    const { s, runbook } = await setup([startBuild]);
    change(s);
    const step = await stepOf(s, runbook.id, 0);
    const read = await s.person("GET", `/steps/${step.id}/vm`);
    expect(read.body.ready).toBe(false);
    expect(read.body.code).toBe(code);
    expect(read.body.reason).toMatch(words);
    const pressed = await press(s, runbook.id, step.id);
    if (code === "not-found") {
      // The host refuses the action itself: the run fails with its words.
      expect(pressed.status).toBe(200);
      const run = await waitForRun(s, runbook.id, pressed.body.run.id);
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(words);
      return;
    }
    // HAW refuses before the host: the button is refused, and nothing ran.
    expect(pressed.body.code).toBe(code);
    expect(pressed.status).toBeGreaterThanOrEqual(400);
    expect((await stepOf(s, runbook.id, 0)).runs).toEqual([]);
  });
});

describe("VM steps: the button", () => {
  it("starts the VM as the person, waits for running and sets the values", async () => {
    const { s, runbook } = await setup([
      startBuild,
      { title: "Use it", hostId: 1, command: "ssh {{build.ip}} true" },
    ]);
    s.haw!.settleAfter = 2;
    const step = await stepOf(s, runbook.id, 0);
    const reply = await press(s, runbook.id, step.id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.run).toMatchObject({
      mode: "vm",
      status: "running",
      hostId: 1,
    });
    expect(reply.body.consoleHost).toBeNull();
    const run = await waitForRun(s, runbook.id, reply.body.run.id);
    expect(run.status).toBe("done");
    expect(run.command).toBe("start build-1");
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("build-1 is running, 192.0.2.10");
    expect(JSON.parse(lines.slice(0, -1).join("\n"))).toMatchObject({
      name: "build-1",
      state: "running",
    });
    expect(run.captured).toEqual({
      "build.state": "running",
      "build.id": "id-build-1",
      "build.ip": "192.0.2.10",
      "build.addresses": "fe80::1,192.0.2.10",
    });
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].status).toBe("done");
    expect(shown.steps[1].resolvedCommand).toBe("ssh 192.0.2.10 true");
    const calls = s.haw!.calls.filter((call) => call.method === "start");
    expect(calls).toEqual([
      expect.objectContaining({
        user: "alice",
        ref: `runbook ${runbook.id} step 1`,
        host: 1,
        name: "build-1",
      }),
    ]);
    // It polled show until running: starting, then running.
    expect(
      s.haw!.calls.filter((c) => c.method === "show").length,
    ).toBeGreaterThanOrEqual(2);
    expect(auditText(s)).toContain("runbooks_step_vm");
  });

  it("fails at the time limit and says the last state", async () => {
    const { s, runbook } = await setup([
      { ...startBuild, vm: { ...startBuild.vm, waitSeconds: 2 } },
    ]);
    s.haw!.stuck = true;
    const run = await pressAndWait(
      s,
      runbook.id,
      (await stepOf(s, runbook.id, 0)).id,
    );
    expect(run.status).toBe("failed");
    expect(run.error).toBe(
      "build-1 did not reach running in 2 s; its state is starting",
    );
    expect(run.captured).toEqual({});
    expect((await stepOf(s, runbook.id, 0)).status).toBe("failed");
  });

  it("goes on through a host that does not answer for a moment", async () => {
    const { s, runbook } = await setup([startBuild]);
    s.haw!.unreachableShows = 2;
    const run = await pressAndWait(
      s,
      runbook.id,
      (await stepOf(s, runbook.id, 0)).id,
    );
    expect(run.status, run.error).toBe("done");
  });

  /** Presses, and once the wait has read the VM, makes HAW go away. */
  async function pressThenHawAway(
    s: TestServer,
    runbookId: number,
    goneCalls: number,
  ) {
    const step = await stepOf(s, runbookId, 0);
    const reply = await press(s, runbookId, step.id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    await vi.waitFor(
      () => {
        if (!s.haw!.calls.some((call) => call.method === "show")) {
          throw new Error("no poll yet");
        }
      },
      { timeout: 2000, interval: 1 },
    );
    s.haw!.goneCalls = goneCalls;
    s.haw!.rotateKeys();
    return waitForRun(s, runbookId, reply.body.run.id);
  }

  it("goes on waiting while HAW restarts after the action (BUG-016)", async () => {
    const { s, runbook } = await setup([startBuild]);
    s.haw!.settleAfter = 3;
    // Gone for one poll, then back with new keys.
    const binds = s.haw!.binds;
    const run = await pressThenHawAway(s, runbook.id, 1);
    expect(run.status, run.error).toBe("done");
    expect(run.stdout.trimEnd().split("\n").at(-1)).toBe(
      "build-1 is running, 192.0.2.10",
    );
    expect(s.haw!.binds).toBeGreaterThan(binds);
    expect(s.haw!.calls.filter((c) => c.method === "start")).toHaveLength(1);
  });

  it("fails at the time limit, not at once, when HAW stays away (BUG-016)", async () => {
    const { s, runbook } = await setup([
      { ...startBuild, vm: { ...startBuild.vm, waitSeconds: 2 } },
    ]);
    s.haw!.settleAfter = 1000;
    const started = Date.now();
    const run = await pressThenHawAway(s, runbook.id, 1_000_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * vmTiming.secondMs);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(
      "build-1 did not reach running in 2 s; its state is starting (HAW VM Manager did not answer; it may be restarting)",
    );
    expect(run.error).not.toContain("Install HAW");
  });

  it("ends without waiting with waitFor null, and Show has no repeat guard", async () => {
    const { s, runbook } = await setup([
      {
        title: "Start",
        vm: { host: 1, name: "build-1", action: "start", waitFor: null },
      },
      { title: "Show", vm: { host: 1, name: "web-1", action: "show" } },
    ]);
    const steps = (await view(s, runbook.id)).steps;
    const started = await pressAndWait(s, runbook.id, steps[0].id);
    expect(started.status).toBe("done");
    expect(started.stdout).toContain("build-1 is starting");
    const shown = await pressAndWait(s, runbook.id, steps[1].id);
    expect(shown.status).toBe("done");
    expect(shown.stdout.trimEnd().split("\n").at(-1)).toBe(
      "web-1 is running, 192.0.2.20",
    );
    const again = await pressAndWait(s, runbook.id, steps[1].id);
    expect(again.status).toBe("done");
  });

  it("fails with HAW's words when the host refuses, and records nothing as done", async () => {
    const { s, runbook } = await setup([
      { title: "Stop web", vm: { host: 1, name: "web-1", action: "stop" } },
    ]);
    const run = await pressAndWait(
      s,
      runbook.id,
      (await stepOf(s, runbook.id, 0)).id,
    );
    expect(run.status).toBe("failed");
    expect(run.error).toBe("HAW: web-1 is on this host's protect list");
  });

  it("binds again once when HAW restarted and refuses the old key", async () => {
    const { s, runbook } = await setup([startBuild]);
    const step = await stepOf(s, runbook.id, 0);
    expect((await s.person("GET", `/steps/${step.id}/vm`)).body.ready).toBe(
      true,
    );
    const binds = s.haw!.binds;
    s.haw!.rotateKeys();
    const read = await s.person("GET", `/steps/${step.id}/vm`);
    expect(read.body.ready).toBe(true);
    expect(s.haw!.binds).toBe(binds + 1);
  });

  it("binds again on HAW's code bad-key only, not on words in a message (BUG-016)", async () => {
    const { s, runbook } = await setup([startBuild]);
    const step = await stepOf(s, runbook.id, 0);
    expect((await s.person("GET", `/steps/${step.id}/vm`)).body.ready).toBe(
      true,
    );
    const binds = s.haw!.binds;
    s.haw!.showError = "the key is not runbooks': call bindPlugin again";
    const read = await s.person("GET", `/steps/${step.id}/vm`);
    expect(read.body).toMatchObject({
      code: "backend",
      reason: "HAW: the key is not runbooks': call bindPlugin again",
    });
    expect(s.haw!.binds).toBe(binds);
  });

  it("binds again for several waits at once after HAW restarted (BUG-016)", async () => {
    const { s, token } = await setup([startBuild]);
    const names = ["vm-a", "vm-b", "vm-c", "vm-d"];
    s.haw!.settleAfter = 3;
    const failed: string[] = [];
    for (let round = 0; round < 10; round++) {
      for (const name of names) s.haw!.seed(1, { name });
      const runbook = await agentRunbook(s, token, {
        title: `Round ${round}`,
        steps: names.map((name) => ({
          title: `Start ${name}`,
          vm: { host: 1, name, action: "start" },
        })),
      });
      const steps = (await view(s, runbook.id)).steps;
      const runIds: number[] = [];
      for (const step of steps) {
        const reply = await press(s, runbook.id, step.id, {
          outOfOrder: true,
          confirmRepeat: true,
        });
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        runIds.push(reply.body.run.id);
      }
      // HAW restarts while all four wait: every poll's key is refused.
      s.haw!.rotateKeys();
      for (const runId of runIds) {
        const run = await waitForRun(s, runbook.id, runId);
        if (run.status !== "done") failed.push(`${round}: ${run.error}`);
      }
    }
    expect(failed).toEqual([]);
  }, 20_000);

  it("asks on its own before force, then turns the VM off", async () => {
    const { s, runbook } = await setup([
      {
        title: "Turn off",
        vm: { host: 1, name: "build-1", action: "stop", force: true },
      },
    ]);
    s.haw!.vms.get("1/build-1")!.state = "running";
    const step = await stepOf(s, runbook.id, 0);
    const asked = await press(s, runbook.id, step.id);
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({
      code: "force",
      action: "stop",
      name: "build-1",
    });
    // A repeat or order yes is not a force yes.
    const still = await press(s, runbook.id, step.id, {
      confirmRepeat: true,
      outOfOrder: true,
    });
    expect(still.body.code).toBe("force");
    const run = await pressAndWait(s, runbook.id, step.id, {
      confirmForce: true,
    });
    expect(run.status).toBe("done");
    expect(run.command).toBe("stop (force) build-1");
    expect(s.haw!.calls.find((c) => c.method === "stop")).toMatchObject({
      force: true,
    });
  });

  it("asks before the same action on the same VM within 24 hours", async () => {
    const { s, runbook } = await setup([
      startBuild,
      { title: "Stop", vm: { host: 1, name: "build-1", action: "stop" } },
      {
        title: "Start again",
        vm: { host: 1, name: "build-1", action: "start" },
      },
    ]);
    const steps = (await view(s, runbook.id)).steps;
    await pressAndWait(s, runbook.id, steps[0].id);
    const again = await press(s, runbook.id, steps[0].id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: "repeat",
      repeat: { sameStep: true },
    });
    await pressAndWait(s, runbook.id, steps[1].id);
    const other = await press(s, runbook.id, steps[2].id);
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({
      code: "repeat",
      repeat: { sameStep: false },
    });
    const run = await pressAndWait(s, runbook.id, steps[2].id, {
      confirmRepeat: true,
    });
    expect(run.status).toBe("done");
  });

  it("lets one of two steps with the same action on the same VM pressed at once pass (BUG-016)", async () => {
    // Both steps are not needed and pressed anyway: each writes an audit
    // line between the repeat guard and its run, slowed down here, so both
    // presses reach the guard before either run is written.
    const { s, runbook } = await setup(
      ["One", "Two"].map((title) => ({
        title,
        vm: { host: 1, name: "build-1", action: "start" },
        when: { value: "mode", equals: "fast" },
      })),
      { values: { mode: "slow" } },
    );
    const audit = s.mock.ctx.audit;
    const record = audit.record.bind(audit);
    audit.record = async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return record(entry);
    };
    const steps = (await view(s, runbook.id)).steps;
    const replies = await Promise.all(
      steps.map((step: { id: number }) =>
        press(s, runbook.id, step.id, {
          outOfOrder: true,
          conditionAnyway: true,
        }),
      ),
    );
    expect(
      replies.map((reply) => `${reply.status} ${reply.body.code ?? ""}`.trim()),
    ).toEqual(["200", "409 running"]);
    expect(replies[1].body.error ?? replies[1].body.message).toMatch(
      /start build-1 is being pressed on another step now/,
    );
    await waitForRun(s, runbook.id, replies[0].body.run.id);
    expect(s.haw!.calls.filter((c) => c.method === "start")).toHaveLength(1);
  });

  it("keeps the gates: revision, order, wait timer and when", async () => {
    const { s, runbook } = await setup([
      { title: "First" },
      { ...startBuild, waitAfterPreviousSeconds: 600 },
      {
        title: "Only if failed",
        vm: { host: 1, name: "web-1", action: "show" },
        when: { step: 2, status: "failed" },
      },
    ]);
    const steps = (await view(s, runbook.id)).steps;
    const stale = await s.person("POST", `/steps/${steps[1].id}/vm`, {
      revision: 99,
    });
    expect(stale.body.code).toBe("stale");
    expect((await press(s, runbook.id, steps[1].id)).body.code).toBe("order");
    await s.person("POST", `/steps/${steps[0].id}/manual`, { outcome: "done" });
    expect((await press(s, runbook.id, steps[1].id)).body.code).toBe("wait");
    const run = await pressAndWait(s, runbook.id, steps[1].id, {
      waitAnyway: true,
    });
    expect(run.startedEarlySeconds).toBeGreaterThan(0);
    const notNeeded = await press(s, runbook.id, steps[2].id);
    expect(notNeeded.body.code).toBe("not-needed");
    const anyway = await pressAndWait(s, runbook.id, steps[2].id, {
      conditionAnyway: true,
    });
    expect(anyway.status).toBe("done");
    expect(auditText(s)).toContain("runbooks_step_not_needed_started");
  });

  it("refuses a viewer's start, but lets a viewer show", async () => {
    const { s, runbook } = await setup([
      startBuild,
      { title: "Show", vm: { host: 1, name: "build-1", action: "show" } },
    ]);
    const steps = (await view(s, runbook.id)).steps;
    await s.person("POST", `/steps/${steps[0].id}/skip`, { reason: "later" });
    s.haw!.roles.set("alice", "viewer");
    const refused = await press(s, runbook.id, steps[0].id);
    expect(refused.body.code).toBe("role");
    const run = await pressAndWait(s, runbook.id, steps[1].id);
    expect(run.status).toBe("done");
  });

  it("stops waiting on Stop", async () => {
    const { s, runbook } = await setup([startBuild]);
    s.haw!.stuck = true;
    const step = await stepOf(s, runbook.id, 0);
    const reply = await press(s, runbook.id, step.id);
    const stopped = await s.person("POST", `/steps/${step.id}/stop`);
    expect(stopped.status).toBe(200);
    const run = await waitForRun(s, runbook.id, reply.body.run.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("stopped by alice while waiting for running");
  });

  it("tests checks on the VM's output", async () => {
    const { s, runbook } = await setup([
      {
        title: "Show",
        vm: { host: 1, name: "web-1", action: "show" },
        checks: [{ type: "contains", text: "is running" }],
      },
      {
        title: "Show again",
        vm: { host: 1, name: "web-1", action: "show" },
        checks: [{ type: "notMatches", pattern: "192\\.0\\.2\\.20" }],
      },
    ]);
    const steps = (await view(s, runbook.id)).steps;
    const ok = await pressAndWait(s, runbook.id, steps[0].id);
    expect(ok.status).toBe("done");
    expect(ok.checks).toEqual([expect.objectContaining({ ok: true })]);
    const bad = await pressAndWait(s, runbook.id, steps[1].id);
    expect(bad.status).toBe("failed");
  });

  it("lets a later when rule read the VM's state and output", async () => {
    const { s, runbook } = await setup([
      startBuild,
      {
        title: "If running",
        when: { value: "build.state", equals: "running" },
      },
      {
        title: "If it has an address",
        when: { step: 1, output: { type: "contains", text: "192.0.2.10" } },
      },
      { title: "If off", when: { value: "build.state", equals: "off" } },
    ]);
    await pressAndWait(s, runbook.id, runbook.steps[0].id);
    const steps = (await view(s, runbook.id)).steps;
    expect(steps[1].condition.state).toBe("met");
    expect(steps[2].condition.state).toBe("met");
    expect(steps[3].condition.notNeeded).toBe(true);
  });

  it("refuses Run, Send to terminal and Mark done on a VM step", async () => {
    const { s, runbook } = await setup([startBuild]);
    const step = await stepOf(s, runbook.id, 0);
    for (const path of ["run", "terminal"]) {
      const reply = await s.person("POST", `/steps/${step.id}/${path}`, {
        revision: step.revision,
        commandHash: null,
      });
      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe("vm");
    }
    const manual = await s.person("POST", `/steps/${step.id}/manual`, {
      outcome: "done",
    });
    expect(manual.body.code).toBe("vm");
    const apiKey = await s.person(
      "POST",
      `/steps/${step.id}/vm`,
      { revision: step.revision },
      { apiKey: true },
    );
    expect(apiKey.status).toBe(403);
  });
});

describe("VM steps: the console", () => {
  it("opens the console host and ends when the person says Done", async () => {
    const { s, token, runbook } = await setup([
      { title: "Console", vm: { host: 1, name: "build-1", action: "console" } },
    ]);
    const step = await stepOf(s, runbook.id, 0);
    const opened = await press(s, runbook.id, step.id);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.consoleHost).toEqual({ id: 3, name: "host-3" });
    expect(opened.body.run).toMatchObject({
      mode: "vm",
      status: "awaiting-output",
    });
    expect(s.haw!.calls.find((c) => c.method === "consoleInfo")).toMatchObject({
      user: "alice",
      ref: `runbook ${runbook.id} step 1`,
    });
    // The run keeps only the summary line, not HAW's console details
    // (BUG-016): agents read this run.
    const line = "The console of build-1 opens in Remote Desktop on host-3\n";
    expect(opened.body.run.stdout).toBe(line);
    const seen = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(seen.body.steps[0].runs[0].stdout).toBe(line);
    expect(JSON.stringify(seen.body)).not.toContain("hv1.example.lan");
    // A second press opens it again, with no new run.
    const again = await press(s, runbook.id, step.id);
    expect(again.body.run.id).toBe(opened.body.run.id);
    const ended = await s.person("POST", `/steps/${step.id}/vm/end`, {
      outcome: "done",
      note: "logged in",
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.steps[0].status).toBe("done");
    expect(ended.body.steps[0].runs[0]).toMatchObject({
      status: "done",
      note: "logged in",
    });
    const none = await s.person("POST", `/steps/${step.id}/vm/end`, {
      outcome: "done",
    });
    expect(none.body.code).toBe("not-running");
  });
});

describe("VM steps: agents", () => {
  it("lists the token's VM hosts and a host's VMs, read only, from the copy saved with the token", async () => {
    const { s, token } = await setup([startBuild]);
    // HAW was read when alice saved the token, as alice, for an agent.
    const listed = s.haw!.calls.filter((c) => c.method === "list");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      agent: true,
      user: "alice",
      ref: "token lead",
      host: 1,
    });
    const before = s.haw!.calls.length;
    const hosts = await s.agent("GET", "/vms", token);
    expect(hosts.status, JSON.stringify(hosts.body)).toBe(200);
    expect(hosts.body.hosts).toEqual([
      expect.objectContaining({
        hostId: 1,
        name: "host-1",
        verbs: expect.arrayContaining(["start"]),
        readAt: expect.any(String),
      }),
    ]);
    const vms = await s.agent("GET", "/vms?host=1", token);
    expect(vms.body.vms.map((vm: { name: string }) => vm.name).sort()).toEqual([
      "Odd Name",
      "build-1",
      "web-1",
    ]);
    // A copy: no live state.
    expect(vms.body.vms[0]).not.toHaveProperty("state");
    expect(vms.body.vms[0]).not.toHaveProperty("addresses");
    expect((await s.agent("GET", "/vms?host=2", token)).status).toBe(404);
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_vms", arguments: { host: 1 } },
    });
    expect(mcp.body.result.structuredContent.vms).toHaveLength(3);
    // An agent request has no acting user: it never reaches HAW.
    expect(s.haw!.calls.length).toBe(before);
    // Nothing that acts was asked for an agent.
    expect(
      s.haw!.calls.filter(
        (c) => c.agent && !["hosts", "list"].includes(c.method),
      ),
    ).toEqual([]);
  });

  it("has a VM made later only after a person saves the token's hosts again", async () => {
    const { s, token } = await setup([]);
    s.haw!.seed(1, { name: "new-1" });
    const names = async () =>
      (await s.agent("GET", "/vms?host=1", token)).body.vms.map(
        (vm: { name: string }) => vm.name,
      );
    expect(await names()).not.toContain("new-1");
    const [made] = (await s.person("GET", "/tokens")).body;
    const saved = await s.person("POST", `/tokens/${made.id}/hosts`, {
      hostIds: [1, 2, 3],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await names()).toContain("new-1");
  });

  it("says why when HAW did not let Runbooks read, and still saves the token", async () => {
    const s = await testServer({ haw: true });
    s.haw!.allowed.clear();
    const token = await s.makeToken();
    const reply = await s.agent("GET", "/vms", token);
    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatch(/Plugins that may act for a person/);
    // The copy cannot say, so a VM step's host is checked on the card.
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Later",
      steps: [{ ...startBuild, vm: { ...startBuild.vm, host: 2 } }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  });

  it("says why when HAW is not there", async () => {
    const s = await testServer({ haw: false });
    const token = await s.makeToken();
    const reply = await s.agent("GET", "/vms", token);
    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatch(/Install HAW VM Manager/);
  });

  it("shows the VM run to the agent, and hides a hidden step's VM output and values", async () => {
    const { s, token, runbook } = await setup([
      { ...startBuild, hideOutputFromAgents: true },
    ]);
    await pressAndWait(s, runbook.id, runbook.steps[0].id);
    const agent = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    const run = agent.body.steps[0].runs[0];
    expect(run).toMatchObject({
      mode: "vm",
      status: "done",
      stdout: "[hidden by owner]",
    });
    expect(run.captured).toEqual({
      "build.state": "[hidden by owner]",
      "build.ip": "[hidden by owner]",
      "build.addresses": "[hidden by owner]",
      "build.id": "[hidden by owner]",
    });
  });
});
