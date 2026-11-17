import { describe, expect, it } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type TestServer,
} from "./helpers";

const startServer = useTestServer();

const SECRET = "hunter2-swordfish";

/** Step 1 prints a password and captures it; the person hides it. */
async function hiddenPassword(
  more: Array<Record<string, unknown>> = [
    { title: "Two", hostId: 1, command: "two" },
    { title: "Three", hostId: 1, command: "three" },
  ],
) {
  const setup = await setupRunbook([
    {
      title: "Make a password",
      hostId: 1,
      command: "make-password",
      captures: [{ name: "pw", pattern: "password=(\\S+)" }],
    },
    ...more,
  ]);
  const { s, runbook } = setup;
  const hidden = await s.person("POST", `/steps/${runbook.steps[0].id}/hide`, {
    hidden: true,
  });
  expect(hidden.status).toBe(200);
  return setup;
}

/** An agent's patch of a step's when rule. */
const patchWhen = (
  s: TestServer,
  token: string,
  stepId: number,
  when: unknown,
) => s.agent("PATCH", `/steps/${stepId}`, token, { when });

describe("when rules and steps hidden from agents (BUG-008)", () => {
  it("masks values from hidden steps in a rule's words for agents (finding 1)", async () => {
    // The rule was written before the person hid step 1.
    const { s, token, runbook } = await hiddenPassword([
      { title: "Print", hostId: 1, command: "print" },
      {
        title: "Only if it printed the password",
        hostId: 1,
        command: "three",
        when: { step: 2, output: { type: "contains", text: "{{pw}}" } },
      },
    ]);
    s.setExec(async (_host, command) =>
      execResult(
        command === "make-password" ? `password=${SECRET}\n` : "nothing\n",
      ),
    );
    await runStep(s, runbook.id, runbook.steps[0].id);
    await runStep(s, runbook.id, runbook.steps[1].id);

    // The rule reads what agents see (BUG-010), and the person sees that,
    // with a warning.
    const person = await view(s, runbook.id);
    expect(person.steps[2].condition.rule).toBe(
      "step 2: the output contains '[hidden by owner]'",
    );
    expect(person.steps[2].condition.readsHidden).toBe(true);

    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.status).toBe(200);
    expect(read.body.steps[2].condition.rule).toBe(
      "step 2: the output contains '[hidden by owner]'",
    );
    expect(read.body.steps[2].condition.reason).not.toContain(SECRET);
    expect(JSON.stringify(read.body)).not.toContain(SECRET);
  });

  it("refuses, on every agent route, a rule that reads a hidden step's output or values (finding 2)", async () => {
    const { s, token, runbook } = await hiddenPassword();
    s.setExec(async () => execResult(`password=${SECRET}\n`));
    await runStep(s, runbook.id, runbook.steps[0].id);
    const [, two, three] = runbook.steps;

    // The read the review made: one bit of the password per patch.
    const bit = await patchWhen(s, token, two.id, {
      step: 1,
      output: { type: "matches", pattern: "^password=h" },
    });
    expect(bit.status).toBe(400);
    expect(bit.body.error).toContain(
      "step 1 hides its output from agents, so a rule cannot read it",
    );
    const after = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(after.body.steps[1].condition).toBeNull();
    expect(after.body.steps[1].when).toBeNull();

    // Nested, or under not: still refused.
    const nested = await patchWhen(s, token, two.id, {
      any: [
        { step: 1, status: "done" },
        { not: { step: 1, output: { type: "contains", text: "=h" } } },
      ],
    });
    expect(nested.status).toBe(400);

    // A value the hidden step captures.
    const value = await patchWhen(s, token, three.id, {
      value: "pw",
      matches: "^h",
    });
    expect(value.status).toBe(400);
    expect(value.body.error).toContain(
      "value pw is captured by a step that hides its output from agents",
    );

    // {{pw}} in an output rule on a step that is not hidden.
    const filled = await patchWhen(s, token, three.id, {
      step: 2,
      output: { type: "matches", pattern: "^{{pw}}" },
    });
    expect(filled.status).toBe(400);
    expect(filled.body.error).toContain("{{pw}} is captured by a step");

    // Add steps.
    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [
          {
            title: "Four",
            hostId: 1,
            command: "four",
            when: { value: "pw", equals: SECRET },
          },
        ],
      },
    );
    expect(added.status).toBe(400);

    // Amend.
    const amended = await s.agent("POST", `/steps/${two.id}/amend`, token, {
      kind: "substep",
      reason: "one more",
      step: {
        title: "Two and a bit",
        hostId: 1,
        command: "more",
        when: { step: 1, output: { type: "exitCode", equals: 0 } },
      },
    });
    expect(amended.status).toBe(400);

    // The MCP tool.
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "update_step",
        arguments: {
          stepId: two.id,
          when: { step: 1, output: { type: "contains", text: "x" } },
        },
      },
    });
    expect(mcp.body.result.isError).toBe(true);
    expect(mcp.body.result.content[0].text).toContain(
      "hides its output from agents",
    );

    // A status rule on the hidden step is fine: it says nothing of output.
    const status = await patchWhen(s, token, two.id, {
      step: 1,
      status: "done",
    });
    expect(status.status).toBe(200);
  });

  it("refuses the rule on create when the agent hides the step itself", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const reply = await server.agent("POST", "/runbooks", token, {
      title: "Hidden",
      steps: [
        {
          title: "One",
          hostId: 1,
          command: "one",
          hideOutputFromAgents: true,
          captures: [{ name: "pw", pattern: "(\\S+)" }],
        },
        {
          title: "Two",
          hostId: 1,
          command: "two",
          when: { value: "pw", matches: "^a" },
        },
      ],
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toContain("steps[1]: when: value pw is captured");
  });

  it("refuses a capture on a hidden step that an existing value rule reads", async () => {
    const { s, token, runbook } = await hiddenPassword([
      {
        title: "Two",
        hostId: 1,
        command: "two",
        when: { value: "mode", equals: "fast" },
      },
    ]);
    const changed = await s.agent(
      "PATCH",
      `/steps/${runbook.steps[0].id}`,
      token,
      { captures: [{ name: "mode", pattern: "mode=(\\S+)" }] },
    );
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("when");
    expect(changed.body.error).toContain("step 2 has a when rule");
  });
});

describe("a change to a step that rules read (BUG-008)", () => {
  it("re-checks every rule that names a step whose decision or captures change (finding 7)", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Which way?",
        decision: {
          options: [
            { id: "on", label: "On" },
            { id: "off", label: "Off" },
          ],
        },
      },
      {
        title: "Status",
        hostId: 1,
        command: "status",
        captures: [{ name: "mode", pattern: "mode=(\\S+)" }],
      },
      {
        title: "Turn it on",
        hostId: 1,
        command: "on",
        when: {
          all: [
            { step: 1, chose: "on" },
            { step: 2, output: { type: "value", name: "mode" } },
          ],
        },
      },
    ]);
    const [decision, status] = runbook.steps;

    const options = await s.agent("PATCH", `/steps/${decision.id}`, token, {
      decision: {
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    });
    expect(options.status).toBe(409);
    expect(options.body.code).toBe("when");
    expect(options.body.error).toContain('"on" is not an option of step 1');

    const captures = await s.agent("PATCH", `/steps/${status.id}`, token, {
      captures: [{ name: "speed", pattern: "speed=(\\S+)" }],
    });
    expect(captures.status).toBe(409);
    expect(captures.body.code).toBe("when");
    expect(captures.body.error).toContain('"mode" is not a capture of step 2');

    // A change the rule still fits is fine.
    const fits = await s.agent("PATCH", `/steps/${status.id}`, token, {
      captures: [
        { name: "mode", pattern: "mode=(\\S+)" },
        { name: "speed", pattern: "speed=(\\S+)" },
      ],
    });
    expect(fits.status).toBe(200);
  });

  it("refuses a stderr output rule on an interactive step (finding 12)", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const reply = await server.agent("POST", "/runbooks", token, {
      title: "Interactive",
      steps: [
        { title: "Log in", hostId: 1, command: "login", interactive: true },
        {
          title: "Two",
          hostId: 1,
          command: "two",
          when: {
            step: 1,
            output: { type: "contains", text: "denied", stream: "stderr" },
          },
        },
      ],
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toContain(
      "step 1 is interactive, so its stdout and stderr are one stream",
    );

    // A step made interactive later, under a rule that reads its stderr.
    const made = await server.agent("POST", "/runbooks", token, {
      title: "Later",
      steps: [
        { title: "Log in", hostId: 1, command: "login" },
        {
          title: "Two",
          hostId: 1,
          command: "two",
          when: {
            step: 1,
            output: { type: "contains", text: "denied", stream: "stderr" },
          },
        },
      ],
    });
    expect(made.status).toBe(201);
    const later = await server.agent(
      "PATCH",
      `/steps/${made.body.steps[0].id}`,
      token,
      { interactive: true },
    );
    expect(later.status).toBe(409);
    expect(later.body.code).toBe("when");
  });
});
