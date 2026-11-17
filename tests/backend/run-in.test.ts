import { describe, expect, it } from "vitest";
import { runStep, setupRunbook, useTestServer, view } from "./helpers";

const startServer = useTestServer();

const SIGN_IN = {
  title: "Sign in to OpenBao",
  hostId: 1,
  command: "bao login -method=oidc",
  runIn: "terminal",
  runInReason: "it opens your browser",
};

describe("runIn (T-022)", () => {
  it("keeps runIn and its reason, and shows them to the person and the agent", async () => {
    const { s, token, runbook } = await setupRunbook([
      SIGN_IN,
      { title: "Apply", hostId: 1, command: "apply", runIn: "run" },
      { title: "Status", hostId: 1, command: "status" },
    ]);
    expect(
      runbook.steps.map((step: { runIn: string; runInReason: string }) => [
        step.runIn,
        step.runInReason,
      ]),
    ).toEqual([
      ["terminal", "it opens your browser"],
      ["run", null],
      ["either", null],
    ]);
    const shown = await view(s, runbook.id);
    expect(shown.steps[0]).toMatchObject({
      runIn: "terminal",
      runInReason: "it opens your browser",
    });
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[1].runIn).toBe("run");
  });

  it("refuses Run on a terminal-only step and Send to terminal on a Run-only step", async () => {
    const { s, runbook } = await setupRunbook([
      SIGN_IN,
      { title: "Apply", hostId: 1, command: "apply", runIn: "run" },
    ]);
    const [signIn, apply] = runbook.steps;
    const run = await runStep(s, runbook.id, signIn.id);
    expect(run.status).toBe(409);
    expect(run.body).toMatchObject({
      code: "terminal-only",
      reason: "it opens your browser",
    });
    expect(run.body.error).toContain("it opens your browser");
    // Before the order question: no answer to it makes the step run.
    const early = await runStep(s, runbook.id, apply.id, {}, "terminal");
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "run-only", reason: null });

    const sent = await runStep(s, runbook.id, signIn.id, {}, "terminal");
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ mode: "terminal" });
    await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: "Success! You are now authenticated.\n",
      outcome: "done",
    });
    const ran = await runStep(s, runbook.id, apply.id);
    expect(ran.status).toBe(200);
    expect(ran.body.status).toBe("done");
    // The refused Run left no run behind.
    const runs = (await view(s, runbook.id)).steps[0].runs;
    expect(runs.map((r: { mode: string }) => r.mode)).toEqual(["terminal"]);
  });

  it("refuses runIn where it cannot apply", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ runIn: "both", hostId: 1, command: "x" }, "runIn must be one of"],
      [
        {
          hostId: 1,
          command: "x",
          runIn: "terminal",
          stdin: { from: "value", name: "v" },
        },
        "cannot have stdin",
      ],
      [{ owner: "agent", command: "x", runIn: "terminal" }, "needs a command"],
      [{ where: "Windows PC", command: "x", runIn: "run" }, "needs a command"],
      [{ runIn: "terminal" }, "needs a command"],
      [{ generate: { name: "pw" }, runIn: "terminal" }, "needs a command"],
      [
        { hostId: 1, command: "x", runInReason: "because" },
        "runInReason needs runIn",
      ],
      [
        {
          hostId: 1,
          command: "x",
          runIn: "terminal",
          runInReason: "two\nlines",
        },
        "one line",
      ],
      [
        { hostId: 1, command: "x", runIn: "run", runInReason: "r".repeat(201) },
        "longer than 200",
      ],
    ];
    for (const [step, error] of bad) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        values: { v: "1" },
        steps: [{ title: "S", ...step }],
      });
      expect(reply.status, JSON.stringify(step)).toBe(400);
      expect(reply.body.error, JSON.stringify(step)).toContain(error);
    }
  });

  it("changes with update_step, checked against the step as it will be", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Make", hostId: 1, command: "make" },
      { title: "Load", hostId: 1, command: "load" },
    ]);
    const [, load] = runbook.steps;
    const made = await s.agent("PATCH", `/steps/${load.id}`, token, {
      runIn: "terminal",
      runInReason: "it asks for a passphrase",
    });
    expect(made.status).toBe(200);
    expect(made.body.steps[1]).toMatchObject({
      runIn: "terminal",
      runInReason: "it asks for a passphrase",
      revision: 2,
    });
    const stdin = await s.agent("PATCH", `/steps/${load.id}`, token, {
      stdin: { from: "step", step: 1, stream: "stdout" },
    });
    expect(stdin.status).toBe(400);
    expect(stdin.body.error).toContain("cannot have stdin");
    const back = await s.agent("PATCH", `/steps/${load.id}`, token, {
      runIn: "either",
      runInReason: null,
    });
    expect(back.body.steps[1]).toMatchObject({
      runIn: "either",
      runInReason: null,
    });
  });

  it("an amendment can make the fixed version terminal-only", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Sign in", hostId: 1, command: "bao login" },
    ]);
    const reply = await s.agent(
      "POST",
      `/steps/${runbook.steps[0].id}/amend`,
      token,
      {
        kind: "replace",
        reason: "it opens a browser",
        step: { ...SIGN_IN },
      },
    );
    expect(reply.status).toBe(200);
    expect(reply.body.steps[1]).toMatchObject({
      label: "1a",
      runIn: "terminal",
    });
  });

  it("MCP tools take runIn", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const created = await server.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_runbook",
        arguments: { title: "MCP", steps: [SIGN_IN] },
      },
    });
    expect(created.body.result.isError).toBe(false);
    const runbook = JSON.parse(created.body.result.content[0].text);
    expect(runbook.steps[0]).toMatchObject({
      runIn: "terminal",
      runInReason: "it opens your browser",
    });
  });
});
