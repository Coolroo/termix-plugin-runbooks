import { describe, expect, it } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type TestServer,
} from "./helpers";

useTestServer();

/** Two hidden values: rules that read them raw answer differently. */
const SECRETS = ["hunter2-swordfish", "zebra-7-lantern"];

/** The keys that differ between two runbooks made the same way. */
const VOLATILE = new Set([
  "id",
  "runbookId",
  "stepId",
  "runId",
  "nextStepId",
  "amendsStepId",
  "openPath",
  "startedAt",
  "finishedAt",
  "endedAt",
  "createdAt",
  "updatedAt",
  "deliveredAt",
  "lastOutputAt",
  "at",
]);

/** A reply with the ids and times taken out, steps by number instead. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stable(value: any): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE.has(key))
      .map(([key, inner]) => [key, stable(inner)]),
  );
}

/** What an agent reads of a runbook: every field, the next step by number. */
async function agentRead(s: TestServer, token: string, runbookId: number) {
  const read = await s.agent("GET", `/runbooks/${runbookId}`, token);
  expect(read.status).toBe(200);
  const next = read.body.steps.find(
    (step: { id: number }) => step.id === read.body.nextStepId,
  );
  return { ...(stable(read.body) as object), next: next?.label ?? null };
}

/**
 * The runbook of the review's probes: step 1 makes a password and hides
 * it; step 2, which is not hidden, prints it again and captures it; the
 * rules after them read the password in every way a rule can. The rules
 * were written before the person hid step 1, so no agent route refused
 * them: only what rules read keeps the password from agents (BUG-010).
 */
async function probeRunbook(secret: string) {
  const { s, token, runbook } = await setupRunbook([
    {
      title: "Make a password",
      hostId: 1,
      command: "make-password",
      captures: [{ name: "pw", pattern: "password=(\\S+)" }],
      // BUG-022 M3: a captured value goes into a command with a pattern.
      checks: [{ type: "value", name: "pw", matches: "^\\S+$" }],
    },
    {
      title: "Print it",
      hostId: 1,
      command: "echo password={{pw}}",
      captures: [{ name: "echoed", pattern: "password=(\\S+)" }],
    },
    {
      title: "Agent: the hidden output starts with h",
      owner: "agent",
      when: { step: 1, output: { type: "matches", pattern: "password=h" } },
    },
    {
      title: "The printed copy starts with h",
      hostId: 1,
      command: "three",
      when: { step: 2, output: { type: "matches", pattern: "^password=h" } },
    },
    {
      title: "The value starts with h",
      hostId: 1,
      command: "four",
      when: { value: "pw", matches: "^h" },
    },
    {
      title: "The printed capture starts with h",
      hostId: 1,
      command: "five",
      when: { value: "echoed", equals: SECRETS[0] },
    },
    {
      title: "Agent: step 2 printed the password",
      owner: "agent",
      when: {
        all: [
          { step: 2, output: { type: "contains", text: "{{pw}}" } },
          { step: 1, output: { type: "exitCode", equals: 0 } },
        ],
      },
    },
    {
      title: "The capture of step 1",
      hostId: 1,
      command: "seven",
      when: {
        not: { step: 1, output: { type: "value", name: "pw", equals: "x" } },
      },
    },
  ]);
  const [one, two] = runbook.steps;
  const hidden = await s.person("POST", `/steps/${one.id}/hide`, {
    hidden: true,
  });
  expect(hidden.status).toBe(200);
  s.setExec(async (_host, command) =>
    execResult(
      command === "make-password"
        ? `password=${secret}\nok\n`
        : command.startsWith("echo ")
          ? `${command.slice(5)}\n`
          : "",
    ),
  );
  expect((await runStep(s, runbook.id, one.id)).body.status).toBe("done");
  expect((await runStep(s, runbook.id, two.id)).body.status).toBe("done");
  return { s, token, runbook };
}

describe("rules read only what agents can see (BUG-010)", () => {
  it("gives agents the same runbook whatever the hidden values are: every field, events, progress and 409s", async () => {
    const a = await probeRunbook(SECRETS[0]);
    const b = await probeRunbook(SECRETS[1]);

    // The person's runbooks do differ: the hidden output is not the same.
    const personA = await view(a.s, a.runbook.id);
    const personB = await view(b.s, b.runbook.id);
    expect(personA.steps[0].runs[0].stdout).toContain(SECRETS[0]);
    expect(personB.steps[0].runs[0].stdout).toContain(SECRETS[1]);
    expect(personA.steps[1].runs[0].captured.echoed).toBe(SECRETS[0]);

    // Everything an agent reads is the same: conditions, nextStepId,
    // progress, runs, values and the agent-turn events.
    const readA = await agentRead(a.s, a.token, a.runbook.id);
    const readB = await agentRead(b.s, b.token, b.runbook.id);
    expect(readA).toEqual(readB);
    // The password shows only where the agent wrote it itself, in step 6's
    // rule (when, its words and its reason), as written in both runbooks:
    // nothing shows whether a guess equals the hidden value.
    expect(JSON.stringify(readA).split(SECRETS[0]).length - 1).toBe(3);
    expect(JSON.stringify(readB).split(SECRETS[1]).length - 1).toBe(0);

    // And what the rules say there: each reads the masked text.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const states = (readA as any).steps.map((step: any) => [
      step.label,
      step.condition?.state ?? null,
      step.condition?.notNeeded ?? null,
    ]);
    expect(states).toEqual([
      ["1", null, null],
      ["2", null, null],
      ["3", "not-met", true],
      ["4", "not-met", true],
      ["5", "not-met", true],
      ["6", "not-met", true],
      // "[hidden by owner]" in the output, as agents see it.
      ["7", "met", false],
      ["8", "met", false],
    ]);
    expect(readA).toMatchObject({ next: "7" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = (readA as any).events.map((event: any) => [
      event.type,
      event.stepLabel,
    ]);
    expect(events).toEqual([["agent-turn", "7"]]);

    // The agent's own routes answer the same: step 3 is not needed in both.
    const answers: unknown[][] = [];
    for (const { s, token, runbook } of [a, b]) {
      const three = await s.agent(
        "POST",
        `/steps/${runbook.steps[2].id}/complete`,
        token,
        { outcome: "done" },
      );
      const seven = await s.agent(
        "POST",
        `/steps/${runbook.steps[6].id}/complete`,
        token,
        { outcome: "done" },
      );
      answers.push([
        three.status,
        stable(three.body),
        seven.status,
        await agentRead(s, token, runbook.id),
      ]);
    }
    expect(answers[0][0]).toBe(409);
    expect(answers[0][1]).toMatchObject({ code: "not-needed" });
    expect(answers[0][2]).toBe(200);
    expect(answers[0]).toEqual(answers[1]);
  });

  it("warns the person on a rule that reads hidden output, never the agent", async () => {
    const { s, token, runbook } = await probeRunbook(SECRETS[0]);
    const person = await view(s, runbook.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warned = person.steps.map((step: any) =>
      Boolean(step.condition?.readsHidden),
    );
    expect(warned).toEqual([false, false, true, true, true, true, true, true]);
    // The person sees what the rule tests, with the value masked too.
    expect(person.steps[6].condition.rule).toBe(
      "step 2: the output contains '[hidden by owner]' and step 1: exit code is 0",
    );
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(JSON.stringify(read.body)).not.toContain("readsHidden");
  });

  it("masks a visible step's capture that holds a hidden value (item 2)", async () => {
    const { s, token, runbook } = await probeRunbook(SECRETS[0]);
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[1].runs[0].captured).toEqual({
      echoed: "[hidden by owner]",
    });
    expect(read.body.steps[1].runs[0].stdout).toBe(
      "password=[hidden by owner]\n",
    );
    const values = await s.agent(
      "GET",
      `/runbooks/${runbook.id}/values`,
      token,
    );
    expect(values.status).toBe(200);
    expect(JSON.stringify(values.body)).not.toContain(SECRETS[0]);
    expect(
      values.body.values.find((v: { name: string }) => v.name === "echoed")
        .value,
    ).toBe("[hidden by owner]");
  });
});

describe("the review's probes, with an agent token (BUG-010)", () => {
  /** The state of a rule an agent writes on pending step `stepId`. */
  async function stateOf(
    s: TestServer,
    token: string,
    runbookId: number,
    stepId: number,
    when: unknown,
  ) {
    const patched = await s.agent("PATCH", `/steps/${stepId}`, token, {
      when,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const step = patched.body.steps.find(
      (other: { id: number }) => other.id === stepId,
    );
    return [step.condition.state, patched.body.nextStepId];
  }

  it("probe A and the bit-by-bit read: a rule on a visible step that printed the password learns nothing", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Make a password",
        hostId: 1,
        command: "make-password",
        captures: [{ name: "pw", pattern: "password=(\\S+)" }],
        // BUG-022 M3: a captured value goes into a command with a pattern.
        checks: [{ type: "value", name: "pw", matches: "^\\S+$" }],
      },
      { title: "Print it", hostId: 1, command: "echo password={{pw}}" },
      { title: "Three", hostId: 1, command: "three" },
    ]);
    const [one, two, three] = runbook.steps;
    await s.person("POST", `/steps/${one.id}/hide`, { hidden: true });
    s.setExec(async (_host, command) =>
      execResult(
        command === "make-password"
          ? `password=${SECRETS[0]}\n`
          : `${command.slice(5)}\n`,
      ),
    );
    await runStep(s, runbook.id, one.id);
    await runStep(s, runbook.id, two.id);

    // The read the review made, one character at a time: every guess for
    // the first character gives the same answer.
    const answers = new Set<string>();
    for (const guess of "abcdefghijklmnopqrstuvwxyz0123456789") {
      const state = await stateOf(s, token, runbook.id, three.id, {
        step: 2,
        output: { type: "matches", pattern: `^password=${guess}` },
      });
      answers.add(JSON.stringify(state));
    }
    expect([...answers]).toEqual([JSON.stringify(["not-met", null])]);
    // The right first character, as the probe found it before the fix.
    expect(
      await stateOf(s, token, runbook.id, three.id, {
        step: 2,
        output: { type: "contains", text: "password=hunter2" },
      }),
    ).toEqual(["not-met", null]);
    // What the rule reads is what the agent reads.
    expect(
      await stateOf(s, token, runbook.id, three.id, {
        step: 2,
        output: { type: "contains", text: "password=[hidden by owner]" },
      }),
    ).toEqual(["met", three.id]);
  });

  /** Probes B and C, run with each secret: what the agent reads. */
  async function amendProbe(secret: string) {
    const { s, token, runbook } = await setupRunbook([
      { title: "Make a token", hostId: 1, command: "make-token" },
      {
        title: "Only for tokens that start with h",
        hostId: 1,
        command: "two",
        when: { value: "tok", matches: "^h" },
      },
    ]);
    const [one] = runbook.steps;
    await s.person("POST", `/steps/${one.id}/hide`, { hidden: true });
    s.setExec(async () => execResult(`token=${secret}\n`));
    // Probe B: a fixed version of the hidden step captures the token. The
    // rule now fits no more (BUG-010, item 4), so amend is refused...
    const replaced = await s.agent("POST", `/steps/${one.id}/amend`, token, {
      kind: "replace",
      reason: "capture it",
      step: {
        title: "Make a token",
        hostId: 1,
        command: "make-token",
        captures: [{ name: "tok", pattern: "token=(\\S+)" }],
      },
    });
    expect(replaced.status).toBe(409);
    expect(replaced.body.code).toBe("when");
    // ...but a sub-step the agent hides itself is not checked against the
    // rule: the mask still keeps the token from the rule.
    const substep = await s.agent("POST", `/steps/${one.id}/amend`, token, {
      kind: "substep",
      reason: "capture it",
      step: {
        title: "Make it again",
        hostId: 1,
        command: "make-token",
        hideOutputFromAgents: true,
        captures: [{ name: "tok", pattern: "token=(\\S+)" }],
      },
    });
    expect(substep.status, JSON.stringify(substep.body)).toBe(200);
    await runStep(s, runbook.id, one.id);
    const oneA = substep.body.steps.find(
      (step: { label: string }) => step.label === "1a",
    );
    await runStep(s, runbook.id, oneA.id);
    return agentRead(s, token, runbook.id);
  }

  it("probe B: an amendment that makes a value hidden after its rule tells the agent nothing", async () => {
    const readA = await amendProbe(SECRETS[0]);
    expect(readA).toEqual(await amendProbe(SECRETS[1]));
    expect(JSON.stringify(readA)).not.toContain(SECRETS[0]);
  });

  async function patchProbe(secret: string) {
    const { s, token, runbook } = await setupRunbook([
      { title: "Make a token", hostId: 1, command: "make-token" },
      {
        title: "Only for tokens that start with h",
        hostId: 1,
        command: "two",
        when: { value: "tok", matches: "^h" },
      },
    ]);
    const [one, two] = runbook.steps;
    await s.person("POST", `/steps/${one.id}/hide`, { hidden: true });
    s.setExec(async () => execResult(`token=${secret}\n`));
    // The rule's own step runs first, so a change no longer checks it.
    const ran = await runStep(s, runbook.id, two.id, { outOfOrder: true });
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    // Probe C: the hidden step captures the token after that.
    const patched = await s.agent("PATCH", `/steps/${one.id}`, token, {
      captures: [{ name: "tok", pattern: "token=(\\S+)" }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    await runStep(s, runbook.id, one.id);
    return agentRead(s, token, runbook.id);
  }

  it("probe C: a capture added to a hidden step after the rule's step ran tells the agent nothing", async () => {
    const readA = await patchProbe(SECRETS[0]);
    expect(readA).toEqual(await patchProbe(SECRETS[1]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((readA as any).steps[1].condition.state).toBe("not-met");
  });
});
