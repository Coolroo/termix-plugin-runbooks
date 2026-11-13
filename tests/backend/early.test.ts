import { describe, expect, it } from "vitest";
import { runStep, setupRunbook, useTestServer } from "./helpers";

useTestServer();

describe("a start before the wait is over", () => {
  it("keeps startedEarlySeconds on the run, for agents too", async () => {
    const { s, token, runbook } = await setupRunbook(
      [
        { title: "Restart", hostId: 1, command: "restart" },
        {
          title: "Check",
          hostId: 1,
          command: "check",
          waitAfterPreviousSeconds: 120,
        },
        { title: "Report", hostId: 1, command: "report" },
      ],
      { title: "Restart" },
    );
    await runStep(s, runbook.id, runbook.steps[0].id);
    const early = await runStep(s, runbook.id, runbook.steps[1].id, {
      waitAnyway: true,
    });
    expect(early.body.status).toBe("done");
    expect(early.body.startedEarlySeconds).toBeGreaterThanOrEqual(119);
    expect(early.body.startedEarlySeconds).toBeLessThanOrEqual(120);
    const onTime = await runStep(s, runbook.id, runbook.steps[2].id);
    expect(onTime.body.startedEarlySeconds).toBeNull();
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[1].runs[0].startedEarlySeconds).toBe(
      early.body.startedEarlySeconds,
    );
    expect(read.body.steps[2].runs[0].startedEarlySeconds).toBeNull();

    // Send to terminal keeps it too.
    const again = await runStep(s, runbook.id, runbook.steps[0].id, {
      confirmRepeat: true,
    });
    expect(again.body.status).toBe("done");
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[1].id,
      { waitAnyway: true, confirmRepeat: true },
      "terminal",
    );
    expect(sent.body.startedEarlySeconds).toBeGreaterThanOrEqual(119);
  });
});
