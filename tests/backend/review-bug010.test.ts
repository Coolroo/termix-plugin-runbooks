import { describe, expect, it, vi } from "vitest";
import { RuleCache } from "../../src/backend/conditions/conditions";
import { createRedactor, redact } from "../../src/backend/running/redact";
import { cleanedCopies } from "../../src/backend/running/runner";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type FakeChannel,
  type TestServer,
} from "./helpers";

const startServer = useTestServer();

const WHICH_WAY = {
  title: "Which way?",
  decision: {
    options: [
      { id: "retry", label: "Try again" },
      { id: "rollback", label: "Go back" },
    ],
  },
};

const decide = (
  s: TestServer,
  step: { id: number; revision: number },
  chosen: string[],
) =>
  s.person("POST", `/steps/${step.id}/decide`, {
    revision: step.revision,
    chosen,
  });

/** A Run that waits for its channel to be driven by hand. */
async function startHeld(s: TestServer, runbookId: number, stepId: number) {
  let channel: FakeChannel | null = null;
  s.setChannel((opened) => (channel = opened));
  const started = await runStep(s, runbookId, stepId, {}, "run", {
    wait: false,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await vi.waitFor(() => expect(channel).not.toBeNull());
  return { started: started.body, channel: channel! };
}

describe("the second review of dev-1.4.6 (BUG-010)", () => {
  it("re-checks, on amend, the rules that name the replaced step (item 4)", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Status",
        hostId: 1,
        command: "status",
        captures: [{ name: "mode", pattern: "mode=(\\S+)" }],
      },
      {
        title: "Only in fast mode",
        hostId: 1,
        command: "two",
        when: {
          all: [
            { step: 1, output: { type: "value", name: "mode" } },
            {
              step: 1,
              output: { type: "contains", text: "x", stream: "stderr" },
            },
          ],
        },
      },
    ]);
    const [status] = runbook.steps;
    const amend = (step: Record<string, unknown>) =>
      s.agent("POST", `/steps/${status.id}/amend`, token, {
        kind: "replace",
        reason: "a better command",
        step: { title: "Status", hostId: 1, command: "status -v", ...step },
      });

    const noCapture = await amend({});
    expect(noCapture.status).toBe(409);
    expect(noCapture.body.code).toBe("when");
    expect(noCapture.body.error).toContain('"mode" is not a capture of step 1');

    const interactive = await amend({
      captures: [{ name: "mode", pattern: "mode=(\\S+)" }],
      interactive: true,
    });
    expect(interactive.status).toBe(409);
    expect(interactive.body.error).toContain("step 1 is interactive");

    // Nothing was added by the refusals.
    expect((await view(s, runbook.id)).steps).toHaveLength(2);

    const fits = await amend({
      captures: [{ name: "mode", pattern: "mode=(\\S+)" }],
    });
    expect(fits.status, JSON.stringify(fits.body)).toBe(200);
  });

  it("keeps rule answers least recently used first, with a share per runbook (item 5)", () => {
    const cache = new RuleCache(2, 2);
    let works = 0;
    const answer = (runbook: number, key: string) =>
      cache.answer(runbook, key, () => {
        works += 1;
        return key;
      });
    answer(1, "a");
    answer(1, "b");
    answer(1, "a"); // used again: "b" is now the oldest
    answer(1, "c");
    expect(works).toBe(3);
    answer(1, "a");
    expect(works).toBe(3);
    answer(1, "b");
    expect(works).toBe(4);

    // Another runbook's answers do not push out runbook 1's.
    for (const key of ["x", "y", "z", "w"]) answer(2, key);
    const before = works;
    answer(1, "a");
    answer(1, "b");
    expect(works).toBe(before);

    // An answer not known yet is not kept.
    expect(cache.answer(1, "later", () => undefined)).toBeUndefined();
    expect(cache.answer(1, "later", () => "now")).toBe("now");
  });

  it("sends no agent-turn when the time limit cut a rule (item 5)", async () => {
    // Each pattern runs its own 250 ms limit out on this output, so the
    // 500 ms of one read cut the third: step 2 waits, not worked out.
    const slow = {
      any: Array.from({ length: 4 }, (_, index) => ({
        step: 1,
        output: { type: "matches", pattern: `^(a+)+x${index}` },
      })),
    };
    const { s, token, runbook } = await setupRunbook(
      [
        { title: "Print", hostId: 1, command: "print" },
        { title: "Agent: only on x", owner: "agent", when: slow },
        { title: "Three", hostId: 1, command: "three" },
      ],
      { owner: { task: "T-1", agent: "session-1", label: "Lead" } },
    );
    s.setExec(async () => execResult(`${"a".repeat(32)}!\n`));
    await runStep(s, runbook.id, runbook.steps[0].id);
    // Later reads go on where the cut stopped: the step is not needed.
    await vi.waitFor(
      async () => {
        const shown = await view(s, runbook.id);
        expect(shown.steps[1].condition.notNeeded).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    // Without the fix, the cut rule made step 2 the agent's turn.
    expect(read.body.events).toEqual([]);
    expect(read.body.nextStepId).toBe(runbook.steps[2].id);
  }, 15_000);

  it("gives an output rule no output on a decision that is not done (item 6)", async () => {
    const { s, runbook } = await setupRunbook([
      WHICH_WAY,
      {
        title: "Go back",
        hostId: 1,
        command: "rollback",
        when: { step: 1, output: { type: "contains", text: "rollback" } },
      },
    ]);
    const [decision] = runbook.steps;
    expect((await decide(s, decision, ["rollback"])).status).toBe(200);
    expect((await view(s, runbook.id)).steps[1].condition.state).toBe("met");
    await s.person("POST", `/steps/${decision.id}/reopen`, {});
    expect(
      (await s.person("POST", `/steps/${decision.id}/skip`, {})).status,
    ).toBe(200);
    expect((await view(s, runbook.id)).steps[1].condition).toMatchObject({
      state: "not-met",
      reason: "step 1 has no output",
      notNeeded: true,
    });
  });

  it("refuses hideOutputFromAgents on a decision step (item 7)", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const made = await server.agent("POST", "/runbooks", token, {
      title: "Hidden choice",
      steps: [{ ...WHICH_WAY, hideOutputFromAgents: true }],
    });
    expect(made.status).toBe(400);
    expect(made.body.error).toContain(
      "a decision step cannot have hideOutputFromAgents",
    );

    const { s, token: own, runbook } = await setupRunbook([WHICH_WAY]);
    const step = runbook.steps[0];
    const hide = await s.person("POST", `/steps/${step.id}/hide`, {
      hidden: true,
    });
    expect(hide.status).toBe(400);
    const patch = await s.agent("PATCH", `/steps/${step.id}`, own, {
      hideOutputFromAgents: true,
    });
    expect(patch.status).toBe(400);
    expect((await view(s, runbook.id)).steps[0].hideOutputFromAgents).toBe(
      false,
    );
  });

  it("holds live output back from where a longer value can still complete (item 8)", () => {
    const secrets = [
      { name: "inner", value: "inner" },
      { name: "outer", value: "outer-inner-end" },
    ];
    const redactor = createRedactor(secrets);
    // Before: "outer-[secret:inner]" went out at once, and then "-end".
    expect(redactor.push("say outer-inner")).toBe("say ");
    expect(redactor.push("-end!")).toBe("[secret:outer]!");
    expect(redactor.push(" and inner ")).toBe(" and [secret:inner] ");
    expect(redactor.push("outer-in")).toBe("");
    expect(redactor.end()).toBe("outer-in");
    // The stored output reads the same.
    expect(redact("say outer-inner-end! and inner outer-in", secrets)).toBe(
      "say [secret:outer]! and [secret:inner] outer-in",
    );
  });

  it("hides a cleaned copy of hidden input in a pty's output, and shows typed sizes only to the typist (item 9)", async () => {
    expect(
      cleanedCopies([
        { name: "typed", value: "pass\u0007word" },
        { name: "plain", value: "nothing-to-clean" },
        { name: "short", value: "ab\u0007c" },
      ]),
    ).toEqual([{ name: "typed", value: "password" }]);

    const { s, runbook } = await setupRunbook([
      {
        title: "Become",
        hostId: 1,
        command: "sudo true",
        interactive: true,
        runIn: "run",
      },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    channel.out("[sudo] password for alice: ");
    const sent = await s.person("POST", `/runs/${started.id}/input`, {
      text: "hunt\u0007er22\n",
      hidden: true,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    // The terminal echoes it; cleaning takes the bell out.
    channel.out("hunt\u0007er22\r\nok\r\n");
    channel.exit(0);
    await vi.waitFor(async () => {
      const shown = await view(s, runbook.id);
      expect(shown.steps[0].runs[0].status).toBe("done");
    });
    const alice = await view(s, runbook.id);
    expect(alice.steps[0].runs[0].stdout).toBe(
      "[sudo] password for alice: [secret:typed]\nok\n",
    );
    expect(alice.steps[0].runs[0].inputs[0].chars).toBe(9);

    // Bob has Use too, but how long the password is is not his to see.
    const bob = await s.person("GET", `/runbooks/${runbook.id}`, undefined, {
      user: "bob",
    });
    expect(bob.status).toBe(200);
    expect(bob.body.steps[0].runs[0].inputs).toEqual([
      expect.objectContaining({ chars: null, hidden: true }),
    ]);
    expect(JSON.stringify(bob.body)).not.toContain('"chars":9');
  });
});
