import { describe, expect, it } from "vitest";
import {
  auditText,
  runStep,
  setupRunbook,
  useTestServer,
  view,
} from "./helpers";

useTestServer();

describe("audits and the command hash (BUG-008)", () => {
  it("audits Make it on a secret step that is not needed (finding 8)", async () => {
    const { s, runbook } = await setupRunbook(
      [
        { title: "Deploy", hostId: 1, command: "deploy" },
        {
          title: "Make a password",
          generate: { name: "db_password" },
          when: { step: 1, status: "failed" },
        },
      ],
      { server: { secrets: true } },
    );
    const [deploy, make] = runbook.steps;
    await runStep(s, runbook.id, deploy.id);
    const shown = await view(s, runbook.id);
    const reply = await s.person("POST", `/steps/${make.id}/secret`, {
      revision: shown.steps[1].revision,
      conditionAnyway: true,
    });
    expect(reply.status).toBe(200);
    expect(auditText(s)).toContain("runbooks_step_not_needed_started");
    expect(auditText(s)).toContain(
      "step 2 started although it is not needed (step 1 is done)",
    );
  });

  it("audits Done anyway only when the step really ends (finding 9)", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "Deploy", hostId: 1, command: "deploy" },
      {
        title: "On your laptop",
        where: "your laptop",
        command: "fix",
        when: { step: 1, status: "failed" },
      },
    ]);
    const [deploy, outside] = runbook.steps;
    await runStep(s, runbook.id, deploy.id);
    const stale = await s.person("POST", `/steps/${outside.id}/manual`, {
      outcome: "done",
      conditionAnyway: true,
      revision: outside.revision + 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale");
    expect(auditText(s)).not.toContain("runbooks_step_not_needed_started");

    const done = await s.person("POST", `/steps/${outside.id}/manual`, {
      outcome: "done",
      conditionAnyway: true,
      revision: outside.revision,
    });
    expect(done.status).toBe(200);
    expect(auditText(s)).toContain("runbooks_step_not_needed_started");
  });

  it("the command hash covers the checks with their values (finding 11)", async () => {
    const { s, token, runbook } = await setupRunbook(
      [
        {
          title: "Deploy",
          hostId: 1,
          command: "deploy",
          checks: [{ type: "contains", text: "version {{ver}}" }],
        },
      ],
      { values: { ver: "1.0" } },
    );
    const before = await view(s, runbook.id);
    const changed = await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      values: { ver: "2.0" },
    });
    expect(changed.status).toBe(200);
    const after = await view(s, runbook.id);
    expect(after.steps[0].commandHash).not.toBe(before.steps[0].commandHash);
    // The confirm box showed the old check: the run is refused.
    const run = await s.person("POST", `/steps/${runbook.steps[0].id}/run`, {
      revision: before.steps[0].revision,
      commandHash: before.steps[0].commandHash,
    });
    expect(run.status).toBe(409);
    expect(run.body.code).toBe("stale");
    expect((await runStep(s, runbook.id, runbook.steps[0].id)).status).toBe(
      200,
    );

    // A repeat is still the same command on the same host, whatever the
    // checks: the run keeps the command's own hash.
    const other = await s.agent("POST", "/runbooks", token, {
      title: "Again",
      steps: [{ title: "Deploy", hostId: 1, command: "deploy" }],
    });
    const again = await runStep(s, other.body.id, other.body.steps[0].id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("repeat");
  });
});
