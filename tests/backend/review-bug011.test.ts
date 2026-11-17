import { describe, expect, it, vi } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type FakeChannel,
  type TestServer,
} from "./helpers";

useTestServer();

const HIDDEN = "[hidden by owner]";

const makeToken = {
  title: "Make a token",
  hostId: 1,
  command: "make-token",
  captures: [{ name: "tok", pattern: "token=(\\S+)" }],
  hideOutputFromAgents: true,
};

/** The runbook as the agent reads it. */
async function agentView(s: TestServer, token: string, runbookId: number) {
  const shown = await s.agent("GET", `/runbooks/${runbookId}`, token);
  expect(shown.status, JSON.stringify(shown.body)).toBe(200);
  return shown.body;
}

/** Drives each command by hand: other commands echo their stdin. */
function drive(s: TestServer, outputs: Record<string, string>) {
  s.setChannel((channel: FakeChannel, command: string) => {
    if (command in outputs) {
      setTimeout(() => {
        channel.out(outputs[command]);
        channel.exit(0);
      }, 1);
      return;
    }
    const wait = setInterval(() => {
      if (!channel.ended) return;
      clearInterval(wait);
      channel.out(channel.stdin);
      channel.exit(0);
    }, 2);
  });
}

describe("the third review of dev-1.4.6 (BUG-011)", () => {
  it("refuses a hidden value in an agent step's check on patch, add and amend (item 1)", async () => {
    const { s, token, runbook } = await setupRunbook([
      makeToken,
      { title: "Agent", owner: "agent" },
      { title: "Person", hostId: 1, command: "two" },
    ]);
    const [, agentStep, person] = runbook.steps;
    const check = { type: "contains", text: "x{{tok}}" };
    const refused = "an agent step's check cannot use {{tok}}";

    const patched = await s.agent("PATCH", `/steps/${agentStep.id}`, token, {
      checks: [check],
    });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain(refused);

    // A person's step may test it: a person runs it and approves it.
    const personCheck = await s.agent("PATCH", `/steps/${person.id}`, token, {
      checks: [check],
    });
    expect(personCheck.status, JSON.stringify(personCheck.body)).toBe(200);
    const toAgent = await s.agent("PATCH", `/steps/${person.id}`, token, {
      owner: "agent",
      hostId: null,
      command: null,
    });
    expect(toAgent.status).toBe(400);
    expect(toAgent.body.error).toContain(refused);

    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [
          { title: "Fine", hostId: 1, command: "n" },
          { title: "Agent 2", owner: "agent", checks: [check] },
        ],
      },
    );
    expect(added.status).toBe(400);
    expect(added.body.error).toContain(`steps[1]: checks[0]: ${refused}`);
    // Nothing of the refused add is stored.
    expect((await view(s, runbook.id)).steps).toHaveLength(3);

    const amended = await s.agent(
      "POST",
      `/steps/${agentStep.id}/amend`,
      token,
      {
        kind: "substep",
        reason: "one more",
        step: { title: "Agent 2", owner: "agent", checks: [check] },
      },
    );
    expect(amended.status).toBe(400);
    expect(amended.body.error).toContain(refused);

    const created = await s.agent("POST", "/runbooks", token, {
      title: "Refused",
      steps: [makeToken, { title: "A", owner: "agent", checks: [check] }],
    });
    expect(created.status).toBe(400);
    // A refused create leaves no runbook behind.
    const list = await s.agent("GET", "/runbooks", token);
    expect(list.body).toHaveLength(1);
  });

  it("shows a run's command filled from the step with the values agents saw then (item 2)", async () => {
    const { s, token, runbook } = await setupRunbook([
      makeToken,
      {
        title: "Build",
        hostId: 1,
        command: "build",
        captures: [{ name: "build", pattern: "build=(\\S+)" }],
      },
      // An agent's literal guess stays as written: no mask shows whether
      // it equals the hidden value.
      {
        title: "Use",
        hostId: 1,
        command: "use {{tok}} hunter2-swordfish {{build}}",
      },
    ]);
    const [one, two, three] = runbook.steps;
    let build = "b-1";
    s.setExec(async (_host, command) =>
      execResult(
        command === "make-token"
          ? "token=hunter2-swordfish\n"
          : command === "build"
            ? `build=${build}\n`
            : "ok\n",
      ),
    );
    await runStep(s, runbook.id, one.id);
    await runStep(s, runbook.id, two.id);
    await runStep(s, runbook.id, three.id);
    // Step 2 runs again with a new build: step 3's run kept the old one.
    expect((await s.person("POST", `/steps/${two.id}/reopen`)).status).toBe(
      200,
    );
    build = "b-2";
    await runStep(s, runbook.id, two.id, { confirmRepeat: true });

    const person = await view(s, runbook.id);
    expect(person.steps[2].runs[0].command).toBe(
      "use hunter2-swordfish hunter2-swordfish b-1",
    );
    const agent = await agentView(s, token, runbook.id);
    expect(agent.steps[2].runs[0].command).toBe(
      `use ${HIDDEN} hunter2-swordfish b-1`,
    );
    expect(agent.effectiveValues).toContainEqual(
      expect.objectContaining({ name: "build", value: "b-2" }),
    );
  });

  it("builds check words for agents as the person reads them on a visible step (item 2)", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Version",
        hostId: 1,
        command: "version",
        captures: [
          { name: "v", pattern: "v=(\\d+)" },
          { name: "w", pattern: "w=(\\d+)" },
        ],
        checks: [
          { type: "exitCode", equals: 0 },
          { type: "contains", text: "ready" },
          { type: "notContains", text: "error", stream: "stderr" },
          { type: "matches", pattern: "^v=\\d+" },
          { type: "value", name: "v", equals: "9" },
          { type: "value", name: "w" },
          { type: "value", name: "v", matches: "^7$", label: "seven" },
        ],
      },
    ]);
    s.setExec(async () => execResult("v=7\n"));
    await runStep(s, runbook.id, runbook.steps[0].id);
    const person = (await view(s, runbook.id)).steps[0].runs[0].checks;
    const agent = (await agentView(s, token, runbook.id)).steps[0].runs[0]
      .checks;
    expect(agent).toEqual(person);
    expect(person.map((check: { detail: string }) => check.detail)).toEqual([
      "exit code 0",
      "expected the output to contain 'ready'",
      "stderr does not contain 'error'",
      "the output matches /^v=\\d+/",
      "expected value v to be '9'",
      "value w was not captured",
      "value v as expected",
    ]);
  });

  it("says only that a hidden step's check failed, and builds its words with the values agents see (item 2)", async () => {
    const { s, token, runbook } = await setupRunbook([
      makeToken,
      {
        title: "Probe",
        hostId: 1,
        command: "probe",
        hideOutputFromAgents: true,
        captures: [{ name: "w", pattern: "w=(\\d+)" }],
        checks: [{ type: "value", name: "w" }],
      },
      {
        title: "Use",
        hostId: 1,
        command: "use",
        checks: [{ type: "notContains", text: "{{tok}}" }],
      },
    ]);
    s.setExec(async (_host, command) =>
      execResult(command === "make-token" ? "token=hunter2-swordfish\n" : ""),
    );
    for (const step of runbook.steps) await runStep(s, runbook.id, step.id);
    const person = await view(s, runbook.id);
    expect(person.steps[1].runs[0].checks[0].detail).toBe(
      "value w was not captured",
    );
    const agent = await agentView(s, token, runbook.id);
    expect(agent.steps[1].runs[0].checks).toEqual([
      {
        label: "value w is captured",
        ok: false,
        detail: "value w not as expected",
      },
    ]);
    expect(agent.steps[2].runs[0].checks).toEqual([
      {
        label: `the output does not contain '${HIDDEN}'`,
        ok: true,
        detail: `the output does not contain '${HIDDEN}'`,
      },
    ]);
  });

  it("hides a step that reads hidden data on standard input, also through another step (item 3)", async () => {
    const { s, token, runbook } = await setupRunbook(
      [
        {
          title: "Read the key",
          hostId: 1,
          command: "make-key",
          hideOutputFromAgents: true,
        },
        {
          title: "Copy it",
          hostId: 1,
          command: "copy",
          stdin: { from: "step", step: 1, stream: "stdout" },
          captures: [{ name: "copied", pattern: "key=(\\S+)" }],
        },
        {
          title: "Use the copy",
          hostId: 1,
          command: "use",
          stdin: { from: "value", name: "copied" },
        },
        {
          title: "Visible input",
          hostId: 1,
          command: "tag",
          stdin: { from: "value", name: "build_id" },
        },
      ],
      { values: { build_id: "b-77" } },
    );
    drive(s, { "make-key": "key=hunter2-swordfish\n" });
    for (const step of runbook.steps) {
      const ran = await runStep(s, runbook.id, step.id);
      expect(ran.body.status, JSON.stringify(ran.body)).toBe("done");
    }
    const agent = await agentView(s, token, runbook.id);
    const runs = agent.steps.map(
      (step: { runs: Array<Record<string, unknown>> }) => step.runs[0],
    );
    for (const run of runs.slice(0, 3)) {
      expect(run.stdout).toBe(HIDDEN);
    }
    expect(runs[1].stdin).toEqual({ from: "step", step: 1, stream: "stdout" });
    expect(runs[2].stdin).toEqual({ from: "value", name: "copied" });
    expect(runs[1].captured).toEqual({ copied: HIDDEN });
    // A step that reads only visible data shows its input's size.
    expect(runs[3].stdout).toBe("b-77\n");
    expect(runs[3].stdin).toEqual({
      from: "value",
      name: "build_id",
      bytes: 5,
    });
    // The person sees it all.
    const person = await view(s, runbook.id);
    expect(person.steps[2].runs[0].stdout).toBe("hunter2-swordfish\n");
  });

  it("gives a hidden step's live run no output time (item 7)", async () => {
    const { s, token, runbook } = await setupRunbook([makeToken]);
    let channel: FakeChannel | null = null;
    s.setChannel((opened) => (channel = opened));
    const started = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "run",
      {
        wait: false,
      },
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await vi.waitFor(() => expect(channel).not.toBeNull());
    channel!.out("token=hunter2-swordfish\n");
    await vi.waitFor(async () => {
      const person = await view(s, runbook.id);
      expect(person.steps[0].runs[0].lastOutputAt).not.toBeNull();
    });
    const agent = await agentView(s, token, runbook.id);
    expect(agent.steps[0].runs[0]).toMatchObject({
      running: true,
      lastOutputAt: null,
      truncated: false,
      stdout: HIDDEN,
    });
    channel!.exit(0);
  });

  it("takes captures from the output with secrets hidden (item 5)", async () => {
    const { s, runbook } = await setupRunbook(
      [
        {
          title: "Log in",
          hostId: 1,
          command: "login",
          secretCaptures: [{ name: "pw", pattern: "pw=(\\S+)" }],
          captures: [{ name: "head", pattern: "pw=(.{3})" }],
        },
      ],
      { server: { secrets: true } },
    );
    s.setExec(async () => execResult("pw=hunter2-swordfish\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status, JSON.stringify(ran.body)).toBe("done");
    expect(ran.body.captured).toEqual({ head: "[se" });
  });
});
