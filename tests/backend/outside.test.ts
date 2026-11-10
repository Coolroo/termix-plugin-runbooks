import { afterEach, describe, expect, it } from "vitest";
import {
  agentRunbook,
  auditText,
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

const WHERE = "Windows PC, PowerShell as admin";

async function setup(
  steps: Array<Record<string, unknown>>,
  values: Record<string, string> = {},
) {
  server = await startServer();
  const token = await server.makeToken("lead");
  const runbook = await agentRunbook(server, token, {
    title: "Outside",
    values,
    steps,
  });
  return { s: server, token, runbook };
}

const mark = (s: TestServer, stepId: number, body: Record<string, unknown>) =>
  s.person("POST", `/steps/${stepId}/manual`, body);

describe("steps run outside Termix", () => {
  it("keep where and show the resolved command, with no hash", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Check the version",
          command: "winver /v {{build}}",
          where: `  ${WHERE}  `,
        },
      ],
      { build: "26100" },
    );
    expect(runbook.steps[0]).toMatchObject({
      where: WHERE,
      hostId: null,
      command: "winver /v {{build}}",
    });
    const shown = await view(s, runbook.id);
    expect(shown.steps[0]).toMatchObject({
      where: WHERE,
      resolvedCommand: "winver /v 26100",
      commandHash: null,
      missing: [],
    });
  });

  it("refuse a step with no where, where with a host or without a command, stdin, secret captures, exit code checks, and an agent step with where", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const bad = [
      { command: "dir" },
      { where: WHERE },
      { where: WHERE, command: "dir", hostId: 1 },
      {
        where: WHERE,
        command: "dir",
        stdin: { from: "value", name: "x" },
      },
      {
        where: WHERE,
        command: "dir",
        secretCaptures: [{ name: "pw", pattern: "(x)" }],
      },
      {
        where: WHERE,
        command: "dir",
        checks: [{ type: "exitCode", equals: 0 }],
      },
      { where: "w".repeat(81), command: "dir" },
      { where: "two\nlines", command: "dir" },
      { where: WHERE, command: "dir", owner: "agent" },
    ];
    for (const step of bad) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        steps: [{ title: "Step", ...step }],
      });
      expect(reply.status, JSON.stringify(step)).toBe(400);
    }
    const noWhere = await server.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [{ title: "Step", command: "dir" }],
    });
    expect(noWhere.body.error).toContain("where");
  });

  it("have no Run and no Send to terminal", async () => {
    const { s, runbook } = await setup([
      { title: "Outside", command: "dir", where: WHERE },
    ]);
    for (const mode of ["run", "terminal"] as const) {
      const reply = await runStep(s, runbook.id, runbook.steps[0].id, {}, mode);
      expect(reply.status, mode).toBe(409);
      expect(reply.body.code).toBe("outside");
    }
  });

  it("end done with the pasted output: checks pass, captures are kept, the run records the command", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Version",
          command: "winver /v {{build}}",
          where: WHERE,
          captures: [{ name: "edition", pattern: "Edition: (\\S+)" }],
          checks: [{ type: "contains", text: "Version 24H2" }],
        },
      ],
      { build: "26100" },
    );
    const step = runbook.steps[0];
    const reply = await mark(s, step.id, {
      outcome: "done",
      note: "ran it",
      output: "Version 24H2\nEdition: Pro\n",
      revision: step.revision,
    });
    expect(reply.status).toBe(200);
    const shown = reply.body.steps[0];
    expect(shown.status).toBe("done");
    expect(shown.runs[0]).toMatchObject({
      mode: "outside",
      status: "done",
      hostId: null,
      command: "winver /v 26100",
      pastedOutput: "Version 24H2\nEdition: Pro\n",
      note: "ran it",
      captured: { edition: "Pro" },
    });
    expect(shown.runs[0].checks[0].ok).toBe(true);
    expect(reply.body.effectiveValues).toContainEqual(
      expect.objectContaining({ name: "edition", value: "Pro" }),
    );
    expect(auditText(s)).toContain("run outside Termix");
  });

  it("end failed when a check fails or the person marks it failed, with a step-failed event", async () => {
    const { s, token, runbook } = await setup([
      {
        title: "One",
        command: "Get-Service app",
        where: WHERE,
        checks: [{ type: "contains", text: "Running" }],
      },
      { title: "Two", command: "Restart-Service app", where: WHERE },
    ]);
    const [one, two] = runbook.steps;
    const checked = await mark(s, one.id, {
      outcome: "done",
      output: "Stopped",
      revision: one.revision,
    });
    expect(checked.body.steps[0].status).toBe("failed");
    expect(checked.body.steps[0].runs[0].checks[0].ok).toBe(false);
    expect(checked.body.steps[0].runs[0].captured).toEqual({});
    const marked = await mark(s, two.id, {
      outcome: "failed",
      revision: two.revision,
    });
    expect(marked.body.steps[1].status).toBe("failed");
    const events = await s.agent("GET", "/events", token);
    expect(
      events.body.events
        .filter((e: { type: string }) => e.type === "step-failed")
        .map((e: { reason: string }) => e.reason),
    ).toEqual(["check", "manual"]);
  });

  it("refuse Done for a stale revision or missing values", async () => {
    const { s, token, runbook } = await setup([
      { title: "Use", command: "deploy {{tag}}", where: WHERE },
    ]);
    const step = runbook.steps[0];
    const missing = await mark(s, step.id, {
      outcome: "done",
      revision: step.revision,
    });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("missing-values");
    await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      values: { tag: "v2" },
    });
    const changed = await s.agent("PATCH", `/steps/${step.id}`, token, {
      command: "deploy --force {{tag}}",
    });
    expect(changed.status).toBe(200);
    const stale = await mark(s, step.id, {
      outcome: "done",
      revision: step.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale");
    const ok = await mark(s, step.id, {
      outcome: "done",
      revision: step.revision + 1,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.steps[0].runs[0].command).toBe("deploy --force v2");
  });

  it("go through update_step, amendments and MCP", async () => {
    const { s, token, runbook } = await setup([
      { title: "On a host", hostId: 1, command: "uname -a" },
    ]);
    const step = runbook.steps[0];
    const moved = await s.agent("PATCH", `/steps/${step.id}`, token, {
      hostId: null,
      where: WHERE,
      command: "ver",
    });
    expect(moved.status).toBe(200);
    expect(moved.body.steps[0]).toMatchObject({ where: WHERE, hostId: null });
    const amended = await s.agent("POST", `/steps/${step.id}/amend`, token, {
      kind: "substep",
      reason: "also on the laptop",
      step: { title: "Laptop", command: "ver", where: "Laptop, cmd" },
    });
    expect(amended.status).toBe(200);
    expect(amended.body.steps[1]).toMatchObject({
      label: "1a",
      where: "Laptop, cmd",
    });
    const called = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_steps",
        arguments: {
          runbookId: runbook.id,
          steps: [
            {
              title: "Browser",
              command: "location.href",
              where: "Browser console",
            },
          ],
        },
      },
    });
    expect(called.body.result.isError).toBe(false);
    expect(called.body.result.structuredContent.steps[2].where).toBe(
      "Browser console",
    );
  });
});
