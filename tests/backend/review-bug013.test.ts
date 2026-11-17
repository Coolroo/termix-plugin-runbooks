/**
 * BUG-013: an agent's create or add-steps that is refused stores nothing.
 * Every step is checked before the first is stored, so a bad check, when
 * rule or stdin in a later step leaves no runbook and no earlier step
 * behind, through REST and MCP.
 */
import { describe, expect, it } from "vitest";
import { setupRunbook, useTestServer, type TestServer } from "./helpers";

useTestServer();

const makeToken = {
  title: "Make a token",
  hostId: 1,
  command: "make-token",
  captures: [{ name: "tok", pattern: "token=(\\S+)" }],
  hideOutputFromAgents: true,
};

const good = { title: "One", hostId: 1, command: "one" };

/** A step that each refusal puts after a good step, and what it says. */
const BAD: Array<{ kind: string; step: Record<string, unknown> }> = [
  {
    kind: "a when rule on a later step",
    step: {
      title: "Two",
      hostId: 1,
      command: "two",
      when: { step: 9, status: "done" },
    },
  },
  {
    kind: "a chose rule on a step that is not a decision",
    step: {
      title: "Two",
      hostId: 1,
      command: "two",
      when: { step: 1, chose: "rotate" },
    },
  },
  {
    kind: "a when rule on a hidden value",
    step: {
      title: "Two",
      hostId: 1,
      command: "two",
      when: { value: "tok", equals: "x" },
    },
  },
  {
    kind: "stdin from a later step",
    step: {
      title: "Two",
      hostId: 1,
      command: "cat",
      stdin: { from: "step", step: 9, stream: "stdout" },
    },
  },
  {
    kind: "an agent check on a hidden value",
    step: {
      title: "Two",
      owner: "agent",
      checks: [{ type: "contains", text: "{{tok}}" }],
    },
  },
];

/** The agent's create or add-steps, through REST or MCP: its status. */
async function call(
  s: TestServer,
  token: string,
  via: "rest" | "mcp",
  what: "create" | "add",
  runbookId: number,
  steps: Array<Record<string, unknown>>,
): Promise<{ status: number; error: string }> {
  if (via === "rest") {
    const reply =
      what === "create"
        ? await s.agent("POST", "/runbooks", token, { title: "Bad", steps })
        : await s.agent("POST", `/runbooks/${runbookId}/steps`, token, {
            steps,
          });
    return { status: reply.status, error: reply.body.error ?? "" };
  }
  const reply = await s.agent("POST", "/mcp", token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params:
      what === "create"
        ? { name: "create_runbook", arguments: { title: "Bad", steps } }
        : { name: "add_steps", arguments: { runbookId, steps } },
  });
  const result = reply.body.result;
  return {
    status: result.isError ? 400 : 200,
    error: result.isError ? result.content[0].text : "",
  };
}

describe("BUG-013: a refused create or add-steps stores nothing", () => {
  for (const via of ["rest", "mcp"] as const) {
    for (const { kind, step } of BAD) {
      it(`${via}: ${kind}`, async () => {
        const { s, token, runbook } = await setupRunbook([makeToken]);
        const list = await s.agent("GET", "/runbooks", token);
        const shown = await s.agent("GET", `/runbooks/${runbook.id}`, token);
        expect(list.body).toHaveLength(1);

        // A good step first, so a store before the check would keep it.
        const created = await call(s, token, via, "create", runbook.id, [
          makeToken,
          good,
          step,
        ]);
        expect(created.status, created.error).toBe(400);
        expect(created.error).toContain("steps[2]: ");

        const added = await call(s, token, via, "add", runbook.id, [
          good,
          step,
        ]);
        expect(added.status, added.error).toBe(400);
        expect(added.error).toContain("steps[1]: ");

        // No runbook "Bad", and the runbook is as it was.
        const after = await s.agent("GET", "/runbooks", token);
        expect(after.body).toEqual(list.body);
        const again = await s.agent("GET", `/runbooks/${runbook.id}`, token);
        expect(again.body).toEqual(shown.body);
      });
    }
  }

  it("still stores a create and an add whose steps are all good", async () => {
    const { s, token, runbook } = await setupRunbook([makeToken]);
    const created = await call(s, token, "rest", "create", runbook.id, [
      good,
      { ...good, title: "Two", when: { step: 1, status: "done" } },
      {
        ...good,
        title: "Three",
        command: "cat",
        stdin: { from: "step", step: 2, stream: "stdout" },
      },
    ]);
    expect(created.status, created.error).toBe(201);
    const added = await call(s, token, "mcp", "add", runbook.id, [
      good,
      { ...good, title: "Two", when: { step: 2, status: "failed" } },
    ]);
    expect(added.status, added.error).toBe(200);
    const shown = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(
      shown.body.steps.map((step: { title: string }) => step.title),
    ).toEqual(["Make a token", "One", "Two"]);
    expect(shown.body.steps[2].when).toEqual({ step: 2, status: "failed" });
  });
});
