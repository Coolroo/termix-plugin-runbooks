import { afterEach, describe, expect, it } from "vitest";
import {
  agentRunbook,
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

const restartThenCheck = [
  { title: "Restart", hostId: 1, command: "systemctl restart app" },
  {
    title: "Health check",
    hostId: 1,
    command: "curl -fsS https://localhost/health",
    waitAfterPreviousSeconds: 120,
    waitReason: "let the service restart",
  },
];

async function setup(steps: Array<Record<string, unknown>> = restartThenCheck) {
  server = await startServer();
  const token = await server.makeToken();
  const runbook = await agentRunbook(server, token, { title: "Wait", steps });
  return { s: server, token, runbook };
}

describe("wait timers", () => {
  it("has no timer until the previous step ended", async () => {
    const { s, token, runbook } = await setup();
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].wait).toBeNull();
    expect(shown.steps[1].wait).toMatchObject({
      previous: { id: runbook.steps[0].id, position: 1 },
      seconds: 120,
      reason: "let the service restart",
      previousEnded: false,
      until: null,
      remainingMs: 0,
    });
    const agent = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(agent.body.steps[1]).toMatchObject({
      waitAfterPreviousSeconds: 120,
      waitReason: "let the service restart",
      waitUntil: null,
    });
    // Out of order, before the previous step ended: no wait to refuse on.
    const early = await runStep(s, runbook.id, runbook.steps[1].id, {
      outOfOrder: true,
    });
    expect(early.status).toBe(200);
  });

  it("counts down from the previous step's end and refuses an early start", async () => {
    const { s, token, runbook } = await setup();
    const first = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(first.body.status).toBe("done");
    const ended = Date.parse(first.body.finishedAt);

    const shown = await view(s, runbook.id);
    const wait = shown.steps[1].wait;
    expect(wait.previousEnded).toBe(true);
    expect(Date.parse(wait.until)).toBe(ended + 120_000);
    expect(wait.remainingMs).toBeGreaterThan(110_000);
    expect(wait.remainingMs).toBeLessThanOrEqual(120_000);
    const agent = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(agent.body.steps[1].waitUntil).toBe(wait.until);

    const refused = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "wait",
      reason: "let the service restart",
      waitUntil: wait.until,
    });
    expect(refused.body.remainingSeconds).toBeGreaterThan(110);
    expect(refused.body.remainingSeconds).toBeLessThanOrEqual(120);
    expect(refused.body.error).toMatch(
      /wait \d+ s more after step 1 \(let the service restart\)/,
    );
    // Sending to a terminal waits too.
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[1].id,
      {},
      "terminal",
    );
    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe("wait");
    expect(s.execCalls).toHaveLength(1);
  });

  it("starts anyway with waitAnyway, and audits it", async () => {
    const { s, runbook } = await setup();
    await runStep(s, runbook.id, runbook.steps[0].id);
    const started = await runStep(s, runbook.id, runbook.steps[1].id, {
      waitAnyway: true,
    });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe("done");
    const skipped = s.mock.audits.find(
      (a) => a.action === "runbooks_step_wait_skipped",
    );
    expect(skipped).toMatchObject({
      success: true,
      resourceId: String(runbook.steps[1].id),
    });
    expect(skipped!.details).toMatch(/started \d+ s before its wait was over/);
  });

  it("starts the timer when the previous step is skipped, and lets a step run once it is over", async () => {
    const { s, token, runbook } = await setup();
    await s.person("POST", `/steps/${runbook.steps[0].id}/skip`, {
      reason: "already restarted",
    });
    let shown = await view(s, runbook.id);
    expect(shown.steps[1].wait.previousEnded).toBe(true);
    expect(shown.steps[1].wait.remainingMs).toBeGreaterThan(110_000);

    // Two minutes later.
    s.db.sqlite
      .prepare("UPDATE p_runbooks_steps SET ended_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 121_000).toISOString(), runbook.steps[0].id);
    shown = await view(s, runbook.id);
    expect(shown.steps[1].wait.remainingMs).toBe(0);
    const agent = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(agent.body.steps[1].waitUntil).toBeNull();
    const ran = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(ran.status).toBe(200);
    expect(
      s.mock.audits.some((a) => a.action === "runbooks_step_wait_skipped"),
    ).toBe(false);

    // Reopened, the previous step has not ended again.
    await s.person("POST", `/steps/${runbook.steps[0].id}/reopen`);
    shown = await view(s, runbook.id);
    expect(shown.steps[1].wait.previousEnded).toBe(false);
  });

  it("checks the range and the reason", async () => {
    server = await startServer();
    const token = await server.makeToken();
    for (const bad of [0, 86_401, 1.5, "60"]) {
      const refused = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        steps: [{ title: "A" }, { title: "B", waitAfterPreviousSeconds: bad }],
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(
        "steps[1]: waitAfterPreviousSeconds must be an integer from 1 to 86400",
      );
    }
    const reasonOnly = await server.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [{ title: "A", waitReason: "why" }],
    });
    expect(reasonOnly.status).toBe(400);
    expect(reasonOnly.body.error).toMatch(/waitReason needs/);
    const ok = await server.agent("POST", "/runbooks", token, {
      title: "Ok",
      steps: [{ title: "A" }, { title: "B", waitAfterPreviousSeconds: 86_400 }],
    });
    expect(ok.status).toBe(201);
    // An agent changes it like any field of a step that has not run.
    const changed = await server.agent(
      "PATCH",
      `/steps/${ok.body.steps[1].id}`,
      token,
      { waitAfterPreviousSeconds: 30, waitReason: "settle" },
    );
    expect(changed.body.steps[1]).toMatchObject({
      waitAfterPreviousSeconds: 30,
      waitReason: "settle",
    });
  });
});
