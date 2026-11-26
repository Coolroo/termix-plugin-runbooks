import { describe, expect, it } from "vitest";
import {
  everything,
  execResult,
  runStep,
  setupRunbook,
  shownRun,
  useTestServer,
  type TestServer,
} from "./helpers";

useTestServer();

// Text Send to terminal read from the terminal is Mark done's pasted output
// (1.4.10): kept with where it came from, and hidden, checked and captured
// as any paste.

const TOKEN = "tk-1a2b3c4d5e6f";

const send = (s: TestServer, runbookId: number, stepId: number) =>
  runStep(s, runbookId, stepId, {}, "terminal");

const complete = (
  s: TestServer,
  runId: number,
  body: Record<string, unknown>,
) => s.person("POST", `/runs/${runId}/complete`, body);

const status = {
  title: "Is nginx up",
  hostId: 1,
  command: "systemctl is-active nginx",
  captures: [{ name: "state", pattern: "^(\\w+)$" }],
  checks: [{ type: "contains", text: "active" }],
};
/** The same step for another unit: the repeat guard does not ask. */
const statusAgain = { ...status, command: "systemctl is-active php-fpm" };

describe("outputSource on Mark done", () => {
  it.each(["captured", "captured-edited", "pasted"] as const)(
    "keeps %s on the run",
    async (source) => {
      const { s, runbook } = await setupRunbook([status]);
      const sent = await send(s, runbook.id, runbook.steps[0].id);
      const done = await complete(s, sent.body.id, {
        pastedOutput: "active",
        outcome: "done",
        outputSource: source,
      });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({
        status: "done",
        pastedOutput: "active",
        outputSource: source,
      });
      expect(await shownRun(s, runbook.id, sent.body.id)).toMatchObject({
        outputSource: source,
      });
    },
  );

  it("is pasted when the page does not say (a page from before)", async () => {
    const { s, runbook } = await setupRunbook([status]);
    const sent = await send(s, runbook.id, runbook.steps[0].id);
    const done = await complete(s, sent.body.id, {
      pastedOutput: "active",
      outcome: "done",
    });
    expect(done.body.outputSource).toBe("pasted");
  });

  it("is null with no output, and before Mark done", async () => {
    const { s, runbook } = await setupRunbook([status]);
    const sent = await send(s, runbook.id, runbook.steps[0].id);
    expect(sent.body.outputSource).toBeNull();
    const failed = await complete(s, sent.body.id, {
      pastedOutput: "",
      outcome: "failed",
      outputSource: "captured",
    });
    expect(failed.body).toMatchObject({ status: "failed", outputSource: null });
  });

  it("refuses an unknown source with 400, and changes nothing", async () => {
    const { s, runbook } = await setupRunbook([status]);
    const sent = await send(s, runbook.id, runbook.steps[0].id);
    for (const outputSource of ["terminal", 3, true]) {
      const refused = await complete(s, sent.body.id, {
        pastedOutput: "active",
        outcome: "done",
        outputSource,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(
        "outputSource must be one of pasted, captured, captured-edited",
      );
    }
    expect(await shownRun(s, runbook.id, sent.body.id)).toMatchObject({
      status: "awaiting-output",
      outputSource: null,
    });
  });

  it("is not on runs that have no pasted output", async () => {
    const { s, runbook } = await setupRunbook([status]);
    s.setExec(async () => execResult("active\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body).toMatchObject({ mode: "exec", outputSource: null });
  });

  it("is pasted on a step run outside Termix with its output", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "On the laptop", command: "brew upgrade", where: "the laptop" },
    ]);
    const step = runbook.steps[0];
    const done = await s.person("POST", `/steps/${step.id}/manual`, {
      outcome: "done",
      output: "Already up-to-date.",
      revision: step.revision,
    });
    expect(done.status).toBe(200);
    expect(done.body.steps[0].runs[0]).toMatchObject({
      mode: "outside",
      pastedOutput: "Already up-to-date.",
      outputSource: "pasted",
    });
  });
});

describe("captured text goes through what a paste goes through", () => {
  it("runs the checks and captures on it", async () => {
    const { s, runbook } = await setupRunbook([status, statusAgain]);
    const sent = await send(s, runbook.id, runbook.steps[0].id);
    const done = await complete(s, sent.body.id, {
      pastedOutput: "inactive",
      outcome: "done",
      outputSource: "captured",
    });
    // "inactive" contains "active": the check passes; the capture reads it.
    expect(done.body.status).toBe("done");
    expect(done.body.captured).toEqual({ state: "inactive" });

    const again = await send(s, runbook.id, runbook.steps[1].id);
    const failed = await complete(s, again.body.id, {
      pastedOutput: "failed",
      outcome: "done",
      outputSource: "captured",
    });
    expect(failed.body.status).toBe("failed");
    expect(failed.body.checks[0].ok).toBe(false);
  });

  it("hides a secret the terminal showed, and stores it as a secret capture", async () => {
    const { s, runbook } = await setupRunbook(
      [
        {
          title: "Make a token",
          hostId: 1,
          command: "make-token",
          secretCaptures: [{ name: "api_token", pattern: "token: (\\S+)" }],
        },
      ],
      { server: { secrets: true } },
    );
    const sent = await send(s, runbook.id, runbook.steps[0].id);
    const done = await complete(s, sent.body.id, {
      pastedOutput: `Enter passphrase:\ntoken: ${TOKEN}`,
      outcome: "done",
      outputSource: "captured",
    });
    expect(done.body).toMatchObject({
      status: "done",
      pastedOutput: "Enter passphrase:\ntoken: [secret:api_token]",
      outputSource: "captured",
    });
    expect(
      s.secrets!.data.get(`plugin:runbooks|runbooks/${runbook.id}/api_token`)
        ?.value,
    ).toBe(TOKEN);
    expect(everything(s)).not.toContain(TOKEN);
  });
});

describe("agents", () => {
  it("see outputSource on the run, and null on a hidden step (BUG-019)", async () => {
    const { s, token, runbook } = await setupRunbook([status, statusAgain]);
    const [one, two] = runbook.steps;
    for (const step of [one, two]) {
      const sent = await send(s, runbook.id, step.id);
      expect(sent.status).toBe(200);
      // Step 2's own capture would be a hidden value, masked in step 1.
      await complete(s, sent.body.id, {
        pastedOutput: step === one ? "active" : "php-fpm is active",
        outcome: "done",
        outputSource: step === one ? "captured" : "captured-edited",
      });
    }
    const hidden = await s.person("POST", `/steps/${two.id}/hide`, {
      hidden: true,
    });
    expect(hidden.status).toBe(200);
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.status).toBe(200);
    const runs = read.body.steps.map(
      (step: { runs: Array<Record<string, unknown>> }) => step.runs[0],
    );
    expect(runs[0]).toMatchObject({
      pastedOutput: "active",
      outputSource: "captured",
    });
    // Whether a hidden step printed, and whether the person changed it,
    // is its output too.
    expect(runs[1]).toMatchObject({
      pastedOutput: "[hidden by owner]",
      outputSource: null,
    });
    // The person still sees it.
    expect(await shownRun(s, runbook.id, runs[1].id as number)).toMatchObject({
      outputSource: "captured-edited",
    });
  });
});
