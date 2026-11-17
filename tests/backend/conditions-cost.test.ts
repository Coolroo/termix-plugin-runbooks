import { describe, expect, it } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
} from "./helpers";
import { RULE_TIME_BUDGET_MS } from "../../src/backend/conditions/conditions";

useTestServer();

describe("the cost of when rules (BUG-008, finding 3)", () => {
  it("keeps a read within the time budget, however slow the patterns", async () => {
    // Each pattern backtracks for ever on this output: it stops only at
    // its own limit (250 ms). 3 steps x 19 different patterns.
    const slow = (step: number) => ({
      any: Array.from({ length: 19 }, (_, index) => ({
        step: 1,
        output: { type: "matches", pattern: `^(a+)+x${step}-${index}` },
      })),
    });
    const { s, token, runbook } = await setupRunbook([
      { title: "Print", hostId: 1, command: "print" },
      { title: "Two", hostId: 1, command: "two", when: slow(2) },
      { title: "Three", hostId: 1, command: "three", when: slow(3) },
      { title: "Four", hostId: 1, command: "four", when: slow(4) },
    ]);
    s.setExec(async () => execResult(`${"a".repeat(32)}!\n`));
    const started = Date.now();
    await runStep(s, runbook.id, runbook.steps[0].id);
    // runStep reads the runbook twice and the run once more.
    expect(Date.now() - started).toBeLessThan(6 * RULE_TIME_BUDGET_MS);

    for (const read of [
      () => s.person("GET", `/runbooks/${runbook.id}`),
      () => s.person("GET", "/runbooks"),
      () => s.agent("GET", `/runbooks/${runbook.id}`, token),
      () => s.agent("GET", "/runbooks", token),
    ]) {
      const at = Date.now();
      expect((await read()).status).toBe(200);
      expect(Date.now() - at).toBeLessThan(RULE_TIME_BUDGET_MS + 400);
    }
    // Patterns the budget stopped are not known yet: the rule waits, and a
    // later read goes on where this one stopped.
    const shown = await view(s, runbook.id);
    expect(shown.steps[3].condition).toMatchObject({
      state: "waiting",
      reason: "step 1: not worked out yet; read the runbook again",
      notNeeded: false,
    });
  }, 20_000);

  it("works an output rule out once per run and keeps the answer", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "Print", hostId: 1, command: "print" },
      {
        title: "Two",
        hostId: 1,
        command: "two",
        when: { step: 1, output: { type: "matches", pattern: "^(a+)+x" } },
      },
    ]);
    s.setExec(async () => execResult(`${"a".repeat(32)}!\n`));
    await runStep(s, runbook.id, runbook.steps[0].id);
    // The pattern ran out its 250 ms once; each read now takes no time.
    await view(s, runbook.id);
    const at = Date.now();
    for (let read = 0; read < 5; read++) await view(s, runbook.id);
    expect(Date.now() - at).toBeLessThan(250);
    expect((await view(s, runbook.id)).steps[1].condition.reason).toContain(
      "did not finish in time",
    );
  });
});
