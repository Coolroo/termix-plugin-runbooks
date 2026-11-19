/**
 * BUG-016: the mask keeps values from a small fixed set (a VM's state, a
 * decision's option ids) out of text masks, and hides the steps that read
 * them instead. A decision hidden before BUG-010 (none can be hidden now)
 * holds one of the author's option ids, which agents read in the runbook.
 */
import { describe, expect, it } from "vitest";
import { agentMask, HIDDEN } from "../../src/backend/agents/agent-mask";

/** A step row with only the fields the mask reads. */
function step(id: number, fields: Record<string, unknown> = {}) {
  return {
    id,
    owner: "person",
    hideOutputFromAgents: false,
    stdin: null,
    command: null,
    checks: [],
    captures: [],
    decision: null,
    vm: null,
    ...fields,
  } as never;
}

describe("BUG-016: values from a fixed set are not masked in text", () => {
  const steps = [
    step(1, {
      hideOutputFromAgents: true,
      decision: { value: "pick", options: [] },
    }),
    step(2, { command: "echo prod-east and prod-west" }),
    step(3, { command: "deploy {{pick}}" }),
    step(4, {
      command: "true",
      checks: [{ type: "value", name: "pick", equals: "prod-east" }],
    }),
    step(5, { command: "cat", stdin: { from: "step", stepId: 3 } }),
    step(6, {
      hideOutputFromAgents: true,
      command: "make-token",
      captures: [{ name: "tok", pattern: "t=(\\S+)" }],
    }),
  ];

  for (const chosen of ["prod-east", "prod-west"]) {
    it(`a hidden decision that chose ${chosen}`, () => {
      const mask = agentMask(steps, [
        { stepId: 1, captured: { pick: chosen } },
        { stepId: 6, captured: { tok: "hunter2-swordfish" } },
      ] as never);
      // Option ids in visible text stay as written, whichever was chosen.
      expect(mask.text("prod-east and prod-west")).toBe(
        "prod-east and prod-west",
      );
      // A value from an open set is still masked.
      expect(mask.text("t=hunter2-swordfish")).toBe(`t=${HIDDEN}`);
      // The steps that read the decision, and those fed by them, are hidden.
      expect([...mask.hiddenSteps].sort()).toEqual([1, 3, 4, 5, 6]);
    });
  }

  it("a VM step's state: kept in text, its readers hidden; its address masked", () => {
    const vmSteps = [
      step(1, {
        hideOutputFromAgents: true,
        vm: { host: 1, name: "b", action: "show", value: "build" },
      }),
      step(2, { command: "echo running" }),
      step(3, { command: "ssh {{build.ip}} true" }),
      step(4, { command: "echo {{build.state}}" }),
    ];
    const mask = agentMask(vmSteps, [
      {
        stepId: 1,
        captured: { "build.state": "running", "build.ip": "192.0.2.9" },
      },
    ] as never);
    expect(mask.text("running at 192.0.2.9")).toBe(`running at ${HIDDEN}`);
    expect([...mask.hiddenSteps].sort()).toEqual([1, 4]);
  });

  it("a capture from a hidden VM step's output on stdin: kept, its readers hidden", () => {
    const vmSteps = [
      step(1, {
        hideOutputFromAgents: true,
        vm: { host: 1, name: "b", action: "show", value: null },
      }),
      step(2, {
        command: "cat",
        stdin: { from: "step", stepId: 1 },
        captures: [{ name: "s", pattern: '"state": "(\\w+)"' }],
      }),
      step(3, { command: "echo {{s}}" }),
      step(4, { command: "echo running" }),
    ];
    const mask = agentMask(vmSteps, [
      { stepId: 2, captured: { s: "running" } },
    ] as never);
    expect(mask.text("the VM is running")).toBe("the VM is running");
    expect([...mask.hiddenSteps].sort()).toEqual([1, 2, 3]);
  });
});
