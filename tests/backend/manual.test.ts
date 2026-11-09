import { afterEach, describe, expect, it } from "vitest";
import {
  agentRunbook,
  runStep,
  startServer,
  view,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function setup(steps: Array<Record<string, unknown>>) {
  server = await startServer();
  const token = await server.makeToken();
  const runbook = await agentRunbook(server, token, { title: "Manual", steps });
  return { s: server, token, runbook };
}

describe("Done and Failed for a step with no command", () => {
  it("records a manual run with who, when, the outcome and the note", async () => {
    const { s, token, runbook } = await setup([
      { title: "Tell the team", body: "Post in the channel." },
      { title: "Check the page", body: "Open the status page." },
    ]);
    const done = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/manual`,
      {
        outcome: "done",
        note: "posted at 10:02",
      },
    );
    expect(done.status).toBe(200);
    expect(done.body.steps[0].status).toBe("done");
    expect(done.body.steps[0].runs[0]).toMatchObject({
      mode: "manual",
      status: "done",
      hostId: null,
      command: "",
      userId: "alice",
      note: "posted at 10:02",
      exitCode: null,
    });
    expect(done.body.steps[0].runs[0].finishedAt).toEqual(expect.any(String));
    expect(done.body.nextStepId).toBe(runbook.steps[1].id);

    const failed = await s.person(
      "POST",
      `/steps/${runbook.steps[1].id}/manual`,
      { outcome: "failed" },
    );
    expect(failed.body.steps[1].status).toBe("failed");
    expect(failed.body.steps[1].runs[0]).toMatchObject({
      mode: "manual",
      status: "failed",
      note: null,
    });
    expect(failed.body.progress).toEqual({ done: 1, failed: 1, total: 2 });
    expect(
      s.mock.audits.filter((a) => a.action === "runbooks_step_manual"),
    ).toHaveLength(2);

    // Agents see manual runs like any other.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[0].runs[0]).toMatchObject({
      mode: "manual",
      status: "done",
      hostId: null,
      note: "posted at 10:02",
    });
  });

  it("refuses a step with a command, a closed runbook, a bad outcome and an API key", async () => {
    const { s, runbook } = await setup([
      { title: "Run me", hostId: 1, command: "uptime" },
      { title: "Read me" },
    ]);
    const [withCommand, manual] = runbook.steps;
    let reply = await s.person("POST", `/steps/${withCommand.id}/manual`, {
      outcome: "done",
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe(
      "this step has a command: use Run or Send to terminal",
    );
    reply = await s.person("POST", `/steps/${manual.id}/manual`, {
      outcome: "maybe",
    });
    expect(reply.status).toBe(400);
    reply = await s.person(
      "POST",
      `/steps/${manual.id}/manual`,
      { outcome: "done" },
      { apiKey: true },
    );
    expect(reply.status).toBe(403);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    reply = await s.person("POST", `/steps/${manual.id}/manual`, {
      outcome: "done",
    });
    expect(reply.status).toBe(409);
  });

  it("still skips, and a later step's input cannot come from it", async () => {
    const { s, token, runbook } = await setup([
      { title: "Read me" },
      { title: "Also read me" },
    ]);
    const skipped = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/skip`,
      {
        reason: "not needed",
      },
    );
    expect(skipped.body.steps[0].status).toBe("skipped");
    // Checks need a command, so a step with none cannot have them.
    const bad = await s.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [{ title: "A", checks: [{ type: "contains", text: "ok" }] }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(
      "steps[0]: checks need a command whose output they read",
    );

    const piped = await agentRunbook(s, token, {
      title: "Pipe",
      steps: [
        { title: "A" },
        {
          title: "B",
          hostId: 1,
          command: "b",
          stdin: { from: "step", step: 1, stream: "stdout" },
        },
      ],
    });
    await s.person("POST", `/steps/${piped.steps[0].id}/manual`, {
      outcome: "done",
    });
    expect((await view(s, piped.id)).steps[1].stdin.problem).toBe(
      "step 1 has no command output",
    );
  });
});

describe("Mark done on a terminal run", () => {
  it("needs at least one line of pasted output; Mark failed does not", async () => {
    const { s, runbook } = await setup([
      { title: "Uptime", hostId: 1, command: "uptime" },
    ]);
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    for (const pastedOutput of ["", "  \n\t\n"]) {
      const refused = await s.person("POST", `/runs/${sent.body.id}/complete`, {
        pastedOutput,
        outcome: "done",
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(
        "paste at least one line of the output to mark the run done",
      );
    }
    const failed = await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: "",
      outcome: "failed",
    });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe("failed");
  });
});
