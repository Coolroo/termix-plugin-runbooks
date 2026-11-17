import { describe, expect, it } from "vitest";
import { escapePattern, fillChecks, type Check } from "../../src/shared/checks";
import { testPattern } from "../../src/backend/values/values";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
  type TestServer,
} from "./helpers";

useTestServer();

const OWNER = { task: "T-7", agent: "session:abc", label: "Lead agent" };

describe("fillChecks (BUG-007)", () => {
  const values = { ver: "1.2.3", host: "web|1" };

  it("fills text as it is and patterns as escaped literal text", () => {
    const checks: Check[] = [
      { type: "exitCode", equals: 0 },
      { type: "contains", text: "app:{{ver}}@sha256:", stream: "stdout" },
      { type: "notContains", text: "{{host}} down" },
      { type: "matches", pattern: "^v{{ver}}$" },
      { type: "notMatches", pattern: "{{host}}: error" },
      { type: "value", name: "got", equals: "{{ver}}", label: "same" },
      { type: "value", name: "got", matches: "^{{ver}}(-\\w+)?$" },
    ];
    expect(fillChecks(checks, values)).toEqual({
      checks: [
        { type: "exitCode", equals: 0 },
        { type: "contains", text: "app:1.2.3@sha256:", stream: "stdout" },
        { type: "notContains", text: "web|1 down" },
        { type: "matches", pattern: "^v1\\.2\\.3$" },
        { type: "notMatches", pattern: "web\\|1: error" },
        { type: "value", name: "got", equals: "1.2.3", label: "same" },
        { type: "value", name: "got", matches: "^1\\.2\\.3(-\\w+)?$" },
      ],
      missing: [],
    });
  });

  it("an escaped value matches only itself", () => {
    const tricky = "a.b*c+(d)[e]{2}^$|\\f?";
    const pattern = `^${escapePattern(tricky)}$`;
    expect(testPattern(pattern, tricky)).toBe(true);
    expect(testPattern(pattern, "aXb*c+(d)[e]{2}^$|\\f?")).toBe(false);
  });

  it("keeps a name with no value as written and names it once", () => {
    const filled = fillChecks(
      [
        { type: "contains", text: "{{nope}} and {{ver}}" },
        { type: "matches", pattern: "{{nope}}|{{other}}" },
      ],
      values,
    );
    expect(filled.checks[0]).toEqual({
      type: "contains",
      text: "{{nope}} and 1.2.3",
    });
    expect(filled.missing).toEqual(["nope", "other"]);
  });
});

describe("checks with values when a run ends (BUG-007)", () => {
  it("tests the filled text: the author's values and earlier captures", async () => {
    const { s, runbook } = await setupRunbook(
      [
        {
          title: "Pull",
          hostId: 1,
          command: "pull",
          captures: [{ name: "ver", pattern: "pulled (\\S+)" }],
        },
        {
          title: "Deploy",
          hostId: 1,
          command: "deploy {{ver}}",
          checks: [
            { type: "contains", text: "{{registry}}/app:{{ver}}@sha256:" },
            { type: "matches", pattern: "^running {{ver}}$" },
          ],
        },
      ],
      { values: { registry: "registry:5443" } },
    );
    const [pull, deploy] = runbook.steps;
    s.setExec(async () => execResult("pulled 0.11.0\n"));
    await runStep(s, runbook.id, pull.id);

    // The page shows the checks filled in.
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].missing).toEqual([]);
    expect(shown.steps[1].resolvedChecks).toEqual([
      {
        type: "contains",
        text: "registry:5443/app:0.11.0@sha256:",
        stream: "any",
      },
      { type: "matches", pattern: "^running 0\\.11\\.0$", stream: "any" },
    ]);

    // A dot in the value is a dot, not any character.
    s.setExec(async () =>
      execResult("registry:5443/app:0.11.0@sha256:ab\nrunning 0x11x0\n"),
    );
    const wrong = await runStep(s, runbook.id, deploy.id);
    expect(wrong.body).toMatchObject({
      status: "failed",
      checks: [
        {
          ok: true,
          detail: "the output contains 'registry:5443/app:0.11.0@sha256:'",
        },
        {
          ok: false,
          detail: "expected the output to match /^running 0\\.11\\.0$/",
        },
      ],
    });

    s.setExec(async () =>
      execResult("registry:5443/app:0.11.0@sha256:ab\nrunning 0.11.0\n"),
    );
    const right = await runStep(s, runbook.id, deploy.id, {
      confirmRepeat: true,
    });
    expect(right.body).toMatchObject({
      status: "done",
      checks: [{ ok: true }, { ok: true }],
    });
  });

  it("a value check's equals and matches take values too", async () => {
    const { s, runbook } = await setupRunbook(
      [
        {
          title: "Version",
          hostId: 1,
          command: "app --version",
          captures: [{ name: "got", pattern: "version (\\S+)" }],
          checks: [
            { type: "value", name: "got", equals: "{{want}}" },
            { type: "value", name: "got", matches: "^{{want}}$" },
          ],
        },
      ],
      { values: { want: "2.0" } },
    );
    s.setExec(async () => execResult("version 2.0\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body).toMatchObject({
      status: "done",
      checks: [{ ok: true }, { ok: true }],
    });
  });

  it("a check whose value is not set stops the step, like its command", async () => {
    const { s, runbook } = await setupRunbook([
      {
        title: "Status",
        hostId: 1,
        command: "status",
        checks: [{ type: "contains", text: "version {{ver}}" }],
      },
    ]);
    const step = (await view(s, runbook.id)).steps[0];
    expect(step.missing).toEqual(["ver"]);
    expect(step.commandHash).toBeNull();
    expect(step.resolvedChecks[0].text).toBe("version {{ver}}");
    for (const mode of ["run", "terminal"] as const) {
      const reply = await runStep(s, runbook.id, step.id, {}, mode);
      expect(reply.status, mode).toBe(409);
      expect(reply.body).toMatchObject({
        code: "missing-values",
        missing: ["ver"],
      });
    }
  });

  it("Mark done of a terminal run tests the filled text, with the values it has then", async () => {
    const { s, runbook } = await setupRunbook(
      [
        {
          title: "Status",
          hostId: 1,
          command: "status",
          checks: [{ type: "contains", text: "on {{host}}" }],
        },
      ],
      { values: { host: "web-1" } },
    );
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    const done = await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: "up on web-1\n",
      outcome: "done",
    });
    expect(done.body).toMatchObject({
      status: "done",
      checks: [{ ok: true, label: "the output contains 'on web-1'" }],
    });
  });

  it("Done on a step run outside Termix tests the filled text", async () => {
    const { s, runbook } = await setupRunbook(
      [
        {
          title: "Version",
          command: "winver",
          where: "Windows PC",
          checks: [{ type: "contains", text: "Version {{want}}" }],
        },
        {
          title: "Later",
          command: "winver",
          where: "Windows PC",
          checks: [{ type: "contains", text: "{{nope}}" }],
        },
      ],
      { values: { want: "24H2" } },
    );
    const [first, second] = runbook.steps;
    const wrong = await s.person("POST", `/steps/${first.id}/manual`, {
      outcome: "done",
      output: "Version {{want}}\n",
      revision: first.revision,
    });
    expect(wrong.body.steps[0].status).toBe("failed");
    await s.person("POST", `/steps/${first.id}/reopen`, {});
    const right = await s.person("POST", `/steps/${first.id}/manual`, {
      outcome: "done",
      output: "Version 24H2\n",
      revision: (await view(s, runbook.id)).steps[0].revision,
    });
    expect(right.body.steps[0].status).toBe("done");

    const missing = await s.person("POST", `/steps/${second.id}/manual`, {
      outcome: "done",
      output: "x\n",
      revision: second.revision,
    });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("missing-values");
  });
});

describe("an agent's own step with check values (BUG-007)", () => {
  const complete = (
    s: TestServer,
    token: string,
    stepId: number,
    body: Record<string, unknown>,
  ) => s.agent("POST", `/steps/${stepId}/complete`, token, body);

  it("tests the filled text, and refuses done while a value is not set", async () => {
    const { s, token, runbook } = await setupRunbook(
      [
        {
          title: "Check the dashboard",
          owner: "agent",
          command: "curl -s dash",
          checks: [{ type: "contains", text: "build {{build}}" }],
        },
        {
          title: "Check again",
          owner: "agent",
          command: "curl -s dash",
          checks: [{ type: "contains", text: "build {{later}}" }],
        },
      ],
      { owner: OWNER, values: { build: "42" } },
    );
    const [first, second] = runbook.steps;
    const done = await complete(s, token, first.id, {
      outcome: "done",
      output: "build 42 is green",
    });
    expect(done.status).toBe(200);
    expect((await view(s, runbook.id)).steps[0]).toMatchObject({
      status: "done",
      runs: [{ checks: [{ ok: true }] }],
    });

    const missing = await complete(s, token, second.id, {
      outcome: "done",
      output: "build 43",
    });
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({
      code: "missing-values",
      missing: ["later"],
    });
    // Failed needs no checks, so no values.
    const failed = await complete(s, token, second.id, { outcome: "failed" });
    expect(failed.status).toBe(200);
  });

  it("hides a value from a step hidden from agents in check results", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Key",
        hostId: 1,
        command: "make-key",
        captures: [{ name: "key_id", pattern: "id: (\\S+)" }],
        hideOutputFromAgents: true,
      },
      {
        title: "Use",
        hostId: 1,
        command: "use",
        checks: [
          { type: "contains", text: "key {{key_id}}" },
          { type: "matches", pattern: "^ok {{key_id}}$" },
        ],
      },
    ]);
    s.setExec(async () => execResult("id: k.secretish.42\n"));
    await runStep(s, runbook.id, runbook.steps[0].id);
    s.setExec(async () =>
      execResult("key k.secretish.42\nok k.secretish.42\n"),
    );
    const ran = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(ran.body.status).toBe("done");
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    const text = JSON.stringify(read.body);
    expect(text).not.toContain("k.secretish.42");
    expect(text).not.toContain("k\\\\.secretish\\\\.42");
    expect(read.body.steps[1].runs[0].checks[0].label).toBe(
      "the output contains 'key [hidden by owner]'",
    );
  });
});
