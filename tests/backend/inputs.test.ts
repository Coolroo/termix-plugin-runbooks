/**
 * The exact refusals of the person, agent and admin routes: status, error
 * text and code. Clients key on these, so they are pinned before the code
 * that makes them is shared between routes.
 */

import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSIONS,
  runStep,
  setupRunbook,
  useTestServer,
  view,
} from "./helpers";

const startServer = useTestServer();

const AGENT_STEP =
  "this step is for the agent: it completes it itself; you can Skip or Reopen it";

const mixed = [
  { title: "Look", body: "Read the page." },
  { title: "Agent work", owner: "agent" },
  { title: "Uptime", hostId: 1, command: "uptime" },
  { title: "Outside", where: "laptop", command: "echo {{missing}}" },
];

describe("person routes refuse bad input with their own words", () => {
  it("pins the refusals of manual, skip, note, send-to-agent and status", async () => {
    const { s, runbook } = await setupRunbook(mixed);
    const [look, agent, uptime, outside] = runbook.steps.map(
      (step: { id: number }) => step.id,
    );
    const manual = (id: number, body: unknown) =>
      s.person("POST", `/steps/${id}/manual`, body);

    expect((await manual(agent, { outcome: "done" })).body).toEqual({
      error: AGENT_STEP,
      code: "agent-step",
    });
    expect((await manual(uptime, { outcome: "done" })).body).toEqual({
      error: "this step has a command: use Run or Send to terminal",
    });
    const badOutcome = await manual(look, { outcome: "maybe" });
    expect(badOutcome.status).toBe(400);
    expect(badOutcome.body).toEqual({
      error: "outcome must be done or failed",
    });
    expect((await manual(look, { outcome: "done", note: 5 })).body).toEqual({
      error: "note must be text of at most 20000 characters",
    });

    // A step run outside Termix: the revision, the values, the output.
    const stale = await manual(outside, { outcome: "done", revision: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: "the step changed; reload",
      code: "stale",
    });
    const shown = await view(s, runbook.id);
    const revision = shown.steps[3].revision;
    const missing = await manual(outside, { outcome: "done", revision });
    expect(missing.status).toBe(409);
    expect(missing.body).toEqual({
      error: "values missing: missing",
      code: "missing-values",
      missing: ["missing"],
    });

    const skip = await s.person("POST", `/steps/${look}/skip`, { reason: 5 });
    expect(skip.status).toBe(400);
    expect(skip.body).toEqual({ error: "reason must be short text" });

    const note = await s.person("POST", `/steps/${look}/note`, {
      ownerNote: 5,
    });
    expect(note.body).toEqual({
      error: "ownerNote must be text of at most 20000 characters",
    });

    const sent = await s.person("POST", `/steps/${look}/send-to-agent`, {
      note: "n".repeat(501),
    });
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      error: "note must be text of at most 500 characters",
    });

    const status = await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "gone",
    });
    expect(status.body).toEqual({
      error: "status must be one of open, done, abandoned",
    });

    const badId = await s.person("GET", "/runbooks/abc");
    expect(badId.status).toBe(404);
    expect(badId.body).toEqual({ error: "not found" });
    expect((await s.person("GET", "/runbooks/999")).body).toEqual({
      error: "runbook not found",
    });
    expect(
      (await s.person("POST", "/steps/999/skip", { reason: "" })).body,
    ).toEqual({ error: "step not found" });
  });

  it("pins the output limit of a step run outside Termix", async () => {
    const { s, runbook } = await setupRunbook(
      [{ title: "Outside", where: "laptop", command: "hostname" }],
      {},
    );
    const step = (await view(s, runbook.id)).steps[0];
    // Text past 256 KB is past the JSON body limit of the test server too.
    for (const output of [5, ["x"]]) {
      const refused = await s.person("POST", `/steps/${step.id}/manual`, {
        outcome: "done",
        revision: step.revision,
        output,
      });
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({
        error: "output must be text of at most 256 KB",
      });
    }
  });

  it("pins run and terminal refusals for agent steps, no command and a closed runbook", async () => {
    const { s, runbook } = await setupRunbook(mixed);
    const [look, agent, uptime] = runbook.steps.map(
      (step: { id: number }) => step.id,
    );
    for (const mode of ["run", "terminal"]) {
      const refused = await s.person("POST", `/steps/${agent}/${mode}`, {});
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: AGENT_STEP, code: "agent-step" });
    }
    const noCommand = await s.person("POST", `/steps/${look}/run`, {});
    expect(noCommand.status).toBe(400);
    expect(noCommand.body).toEqual({
      error: "this step has no command to run",
    });
    const notSecret = await s.person("POST", `/steps/${look}/secret`, {});
    expect(notSecret.status).toBe(400);
    expect(notSecret.body).toEqual({
      error: "this step makes or asks for no secret",
      code: "not-secret-step",
    });

    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    for (const [id, mode] of [
      [uptime, "run"],
      [uptime, "terminal"],
      [look, "manual"],
    ] as const) {
      const closed = await s.person("POST", `/steps/${id}/${mode}`, {
        outcome: "done",
      });
      expect(closed.status, mode).toBe(409);
      expect(closed.body, mode).toEqual({ error: "this runbook is done" });
    }
    // An agent step in a closed runbook: the agent step answers first.
    expect(
      (await s.person("POST", `/steps/${agent}/manual`, {})).body.code,
    ).toBe("agent-step");
  });

  it("pins the refusals of a closed runbook's secret step", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "Make", generate: { name: "db_password" } },
    ]);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "abandoned",
    });
    const closed = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/secret`,
      {},
    );
    expect(closed.status).toBe(409);
    expect(closed.body).toEqual({ error: "this runbook is abandoned" });
  });

  it("pins the refusals of a terminal run's completion", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "Uptime", hostId: 1, command: "uptime" },
    ]);
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    const runId = sent.body.id;
    const complete = (body: unknown) =>
      s.person("POST", `/runs/${runId}/complete`, body);
    expect((await complete({ outcome: "x" })).body).toEqual({
      error: "outcome must be done or failed",
    });
    expect((await complete({ outcome: "done", pastedOutput: 5 })).body).toEqual(
      {
        error: "pastedOutput must be text of at most 262144 characters",
      },
    );
    expect(
      (await complete({ outcome: "done", pastedOutput: " " })).body,
    ).toEqual({
      error: "paste at least one line of the output to mark the run done",
    });
    expect((await complete({ outcome: "failed", exitCode: "1" })).body).toEqual(
      { error: "exitCode must be an integer or null" },
    );
    expect(
      (await s.person("POST", "/runs/999/complete", { outcome: "done" })).body,
    ).toEqual({ error: "run not found" });
    expect(
      (await s.person("POST", "/runs/x/complete", { outcome: "done" })).body,
    ).toEqual({ error: "not found" });
  });

  it("pins the sign-in and API key refusals", async () => {
    const s = await startServer();
    const anonymous = await s.raw("GET", "/runbooks", {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({
      error: "sign in to Termix to use Runbooks",
    });
    const key = await s.person("POST", "/steps/1/skip", {}, { apiKey: true });
    expect(key.status).toBe(403);
    expect(key.body).toEqual({
      error:
        "a Termix API key cannot run, approve or change steps; use the Runbooks tab",
    });
    const notAdmin = await s.person("GET", "/admin/notify");
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.body).toEqual({
      error: "only an admin can manage Runbooks notifications",
    });

    const admin = await startServer({ permissions: ADMIN_PERMISSIONS });
    const adminKey = await admin.person("GET", "/admin/notify", undefined, {
      apiKey: true,
    });
    expect(adminKey.status).toBe(403);
    expect(adminKey.body).toEqual({
      error: "a Termix API key cannot do this; use the Termix app",
    });
    const signedOut = await admin.raw("GET", "/admin/notify", {});
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toEqual({ error: "sign in to Termix first" });
  });
});

describe("agent routes refuse bad input with their own words", () => {
  it("pins the body, field and id refusals", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Look" },
      { title: "Agent work", owner: "agent" },
    ]);
    const [look, agent] = runbook.steps.map((step: { id: number }) => step.id);

    const badId = await s.agent("GET", "/runbooks/abc", token);
    expect(badId.status).toBe(404);
    expect(badId.body).toEqual({ error: "bad id" });

    for (const path of [`/steps/${look}/amend`, `/steps/${agent}/complete`]) {
      // complete asks about the turn first: let the person end step 1.
      if (path.endsWith("complete")) {
        await s.person("POST", `/steps/${look}/manual`, { outcome: "done" });
      }
      const refused = await s.agent("POST", path, token, ["x"]);
      expect(refused.status, path).toBe(400);
      expect(refused.body, path).toEqual({ error: "body must be an object" });
    }

    const unknown = [
      ["PATCH", `/runbooks/${runbook.id}`, { colour: "red" }, "colour"],
      [
        "POST",
        `/steps/${look}/amend`,
        { kind: "substep", reason: "r", step: { title: "x" }, extra: 1 },
        "extra",
      ],
      ["POST", `/steps/${agent}/complete`, { outcome: "done", x: 1 }, "x"],
    ] as const;
    for (const [method, path, body, key] of unknown) {
      const refused = await s.agent(method, path, token, body);
      expect(refused.status, path).toBe(400);
      expect(refused.body, path).toEqual({ error: `unknown field "${key}"` });
    }
  });

  it("pins the refusals of an agent step's completion", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Look" },
      { title: "Agent work", owner: "agent" },
    ]);
    const [look, agent] = runbook.steps.map((step: { id: number }) => step.id);
    const complete = (body: unknown) =>
      s.agent("POST", `/steps/${agent}/complete`, token, body);

    const early = await complete({ outcome: "done" });
    expect(early.status).toBe(409);
    expect(early.body).toEqual({
      error: "step 1 (Look) is still pending; it is not your turn yet",
      code: "order",
      blocking: [{ id: look, position: 1, label: "1", title: "Look" }],
    });

    await s.person("POST", `/steps/${look}/manual`, { outcome: "done" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ outcome: "maybe" }, 'outcome must be "done" or "failed"'],
      [{ outcome: "done", note: 5 }, "note must be a string"],
      [
        { outcome: "done", note: "n".repeat(2001) },
        "note is longer than 2000 characters",
      ],
      [{ outcome: "done", output: 5 }, "output must be a string"],
      [
        { outcome: "done", output: "o".repeat(65_537) },
        "output is larger than 64 KB",
      ],
    ];
    for (const [body, error] of cases) {
      const refused = await complete(body);
      expect(refused.status, error).toBe(400);
      expect(refused.body).toEqual({ error });
    }
    // Nothing above ended the step.
    expect((await view(s, runbook.id)).steps[1].status).toBe("pending");
  });

  it("pins the refusals of a step, an owner, stdin and a check that are not objects", async () => {
    const s = await startServer();
    const token = await s.makeToken();
    const create = (body: Record<string, unknown>) =>
      s.agent("POST", "/runbooks", token, { title: "x", ...body });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ steps: [5] }, "steps[0]: a step must be an object"],
      [
        { steps: [{ title: "a", colour: 1 }] },
        'steps[0]: unknown step field "colour"',
      ],
      [
        { owner: "lead" },
        "owner must be an object { task, agent, label } or null",
      ],
      [{ owner: { who: "x" } }, 'unknown owner field "who"'],
      [
        { steps: [{ title: "a", hostId: 1, command: "cat", stdin: 5 }] },
        'steps[0]: stdin must be an object with "from": step, value or secret',
      ],
      [
        {
          steps: [
            {
              title: "a",
              hostId: 1,
              command: "cat",
              stdin: { from: "value", name: "x", extra: 1 },
            },
          ],
        },
        'steps[0]: stdin has an unknown field "extra"',
      ],
      [
        { steps: [{ title: "a", hostId: 1, command: "ls", checks: [5] }] },
        "steps[0]: checks[0]: must be an object with a type",
      ],
      [{ steps: {} }, "steps must be an array"],
    ];
    for (const [body, error] of cases) {
      const refused = await create(body);
      expect(refused.status, error).toBe(400);
      expect(refused.body).toEqual({ error });
    }
  });

  it("holds a runbook to 200 steps on create, add and amend", async () => {
    const s = await startServer();
    const token = await s.makeToken();
    const steps = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ title: `Step ${i + 1}` }));
    const limit = { error: "a runbook may have at most 200 steps" };

    const tooMany = await s.agent("POST", "/runbooks", token, {
      title: "Big",
      steps: steps(201),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toEqual(limit);

    const full = await s.agent("POST", "/runbooks", token, {
      title: "Full",
      steps: steps(200),
    });
    expect(full.status).toBe(201);
    const added = await s.agent(
      "POST",
      `/runbooks/${full.body.id}/steps`,
      token,
      { steps: steps(1) },
    );
    expect(added.status).toBe(400);
    expect(added.body).toEqual(limit);
    const amended = await s.agent(
      "POST",
      `/steps/${full.body.steps[0].id}/amend`,
      token,
      { kind: "substep", reason: "one more", step: { title: "Extra" } },
    );
    expect(amended.status).toBe(400);
    expect(amended.body).toEqual(limit);
  });
});
