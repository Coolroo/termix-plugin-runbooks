import { afterEach, describe, expect, it } from "vitest";
import {
  checkHidden,
  checksProblem,
  evaluateChecks,
  type Check,
  type CheckedRun,
} from "../../src/backend/checks";
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

const exec = (overrides: Partial<CheckedRun> = {}): CheckedRun => ({
  mode: "exec",
  exitCode: 0,
  stdout: "nginx.service: active (running)\nversion 1.2.3\n",
  stderr: "warning: deprecated option\n",
  pastedOutput: null,
  ...overrides,
});

const one = (check: Check, run = exec(), captured = {}) =>
  evaluateChecks([check], run, captured)[0];

describe("check types", () => {
  it("exitCode passes on the code and fails with what it was", () => {
    expect(one({ type: "exitCode", equals: 0 })).toEqual({
      label: "exit code is 0",
      ok: true,
      detail: "exit code 0",
    });
    expect(one({ type: "exitCode", equals: 0 }, exec({ exitCode: 3 }))).toEqual(
      { label: "exit code is 0", ok: false, detail: "exit code 3, expected 0" },
    );
    // A terminal run without an entered exit code has none.
    expect(
      one(
        { type: "exitCode", equals: 0 },
        exec({ mode: "terminal", exitCode: null, pastedOutput: "ok" }),
      ),
    ).toMatchObject({ ok: false, detail: "no exit code" });
  });

  it("contains and notContains", () => {
    expect(
      one({ type: "contains", text: "active (running)", label: "Service up" }),
    ).toEqual({
      label: "Service up",
      ok: true,
      detail: "the output contains 'active (running)'",
    });
    expect(one({ type: "contains", text: "inactive" })).toMatchObject({
      ok: false,
      detail: "expected the output to contain 'inactive'",
    });
    expect(one({ type: "notContains", text: "error" })).toMatchObject({
      ok: true,
    });
    expect(one({ type: "notContains", text: "warning" })).toMatchObject({
      ok: false,
      detail: "expected the output not to contain 'warning'",
    });
  });

  it("matches and notMatches, multiline", () => {
    expect(
      one({ type: "matches", pattern: "^version \\d+\\.\\d+" }),
    ).toMatchObject({ ok: true });
    expect(one({ type: "matches", pattern: "^failed$" })).toMatchObject({
      ok: false,
      detail: "expected the output to match /^failed$/",
    });
    expect(one({ type: "notMatches", pattern: "^error" })).toMatchObject({
      ok: true,
    });
    expect(one({ type: "notMatches", pattern: "^warning:" })).toMatchObject({
      ok: false,
    });
  });

  it("value checks a capture of the step", () => {
    const captured = { version: "1.2.3" };
    expect(
      one(
        { type: "value", name: "version", equals: "1.2.3" },
        exec(),
        captured,
      ),
    ).toMatchObject({ ok: true });
    expect(
      one({ type: "value", name: "version", equals: "2.0" }, exec(), captured),
    ).toMatchObject({
      ok: false,
      detail: "expected value version to be '2.0'",
    });
    expect(
      one(
        { type: "value", name: "version", matches: "^1\\.2\\." },
        exec(),
        captured,
      ),
    ).toMatchObject({ ok: true });
    expect(
      one({ type: "value", name: "version", matches: "^2" }, exec(), captured),
    ).toMatchObject({ ok: false });
    expect(one({ type: "value", name: "version" }, exec(), {})).toMatchObject({
      ok: false,
      detail: "value version was not captured",
    });
  });
});

describe("stream selection", () => {
  it("reads stdout, stderr or both; a terminal run only its pasted output", () => {
    const run = exec({ stdout: "out-text\n", stderr: "err-text\n" });
    const has = (text: string, stream: "stdout" | "stderr" | "any") =>
      one({ type: "contains", text, stream }, run).ok;
    expect(has("out-text", "stdout")).toBe(true);
    expect(has("err-text", "stdout")).toBe(false);
    expect(has("err-text", "stderr")).toBe(true);
    expect(has("out-text", "stderr")).toBe(false);
    expect(has("out-text", "any")).toBe(true);
    expect(has("err-text", "any")).toBe(true);
    // Not in stderr: notContains on stderr passes even though stdout has it.
    expect(
      one({ type: "notContains", text: "out-text", stream: "stderr" }, run).ok,
    ).toBe(true);

    const terminal = exec({
      mode: "terminal",
      stdout: null,
      stderr: null,
      pastedOutput: "pasted-text\n",
    });
    expect(
      one(
        { type: "contains", text: "pasted-text", stream: "stderr" },
        terminal,
      ),
    ).toMatchObject({
      ok: true,
      detail: "the pasted output contains 'pasted-text'",
    });
  });
});

describe("the regex time limit", () => {
  it("fails a pattern that does not finish instead of holding the server", () => {
    const started = Date.now();
    const result = one(
      { type: "matches", pattern: "^(a+)+$" },
      exec({ stdout: "a".repeat(40) + "!", stderr: "" }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/did not finish in time/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("validation", () => {
  it("names the check that is wrong", () => {
    expect(checksProblem("x")).toBe("checks must be an array");
    expect(
      checksProblem([{ type: "exitCode", equals: 0 }, { type: "nope" }]),
    ).toMatch(/^checks\[1\]: type must be one of/);
    expect(checksProblem([{ type: "exitCode", equals: "0" }])).toBe(
      "checks[0]: equals must be an integer exit code",
    );
    expect(checksProblem([{ type: "contains", text: "" }])).toMatch(
      /^checks\[0\]: text must be/,
    );
    expect(
      checksProblem([{ type: "contains", text: "x", stream: "both" }]),
    ).toBe("checks[0]: stream must be one of stdout, stderr, any");
    expect(checksProblem([{ type: "matches", pattern: "(" }])).toBe(
      "checks[0]: pattern is not a valid regular expression",
    );
    expect(checksProblem([{ type: "contains", text: "x", pattern: "y" }])).toBe(
      'checks[0]: unknown field "pattern" for type contains',
    );
    expect(checksProblem([{ type: "value", name: "v" }], ["other"])).toBe(
      'checks[0]: "v" is not a capture of this step',
    );
    expect(
      checksProblem(
        Array.from({ length: 21 }, () => ({ type: "exitCode", equals: 0 })),
      ),
    ).toBe("a step may have at most 20 checks");
  });

  it("refuses a bad check through the agent API with 400", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const refused = await server.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [
        {
          title: "A",
          hostId: 1,
          command: "x",
          checks: [
            { type: "exitCode", equals: 0 },
            { type: "matches", pattern: "[" },
          ],
        },
      ],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(
      "steps[0]: checks[1]: pattern is not a valid regular expression",
    );
    const manual = await server.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [{ title: "Read", checks: [{ type: "exitCode", equals: 0 }] }],
    });
    expect(manual.status).toBe(400);
    expect(manual.body.error).toMatch(/checks need a command/);
  });
});

async function setup(steps: Array<Record<string, unknown>>) {
  server = await startServer();
  const token = await server.makeToken();
  const runbook = await agentRunbook(server, token, { title: "Checks", steps });
  return { s: server, token, runbook };
}

describe("checks when a run ends", () => {
  it("a failed check fails the step even on exit code 0", async () => {
    const { s, token, runbook } = await setup([
      {
        title: "Status",
        hostId: 1,
        command: "systemctl status nginx",
        captures: [{ name: "pid", pattern: "Main PID: (\\d+)" }],
        checks: [
          { type: "exitCode", equals: 0 },
          {
            type: "contains",
            text: "active (running)",
            stream: "stdout",
            label: "nginx runs",
          },
          { type: "value", name: "pid" },
        ],
      },
    ]);
    // The agent reads its checks back, normalized.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[0].checks[1]).toEqual({
      type: "contains",
      text: "active (running)",
      stream: "stdout",
      label: "nginx runs",
    });

    s.setExec(async () => ({
      stdout: "nginx.service: inactive (dead)\n",
      stderr: "",
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body).toMatchObject({
      status: "failed",
      exitCode: 0,
      stdout: "nginx.service: inactive (dead)\n",
      // Captures of a failed run are not kept.
      captured: {},
      checks: [
        { label: "exit code is 0", ok: true, detail: "exit code 0" },
        {
          label: "nginx runs",
          ok: false,
          detail: "expected stdout to contain 'active (running)'",
        },
        {
          label: "value pid is captured",
          ok: false,
          detail: "value pid was not captured",
        },
      ],
    });
    expect((await view(s, runbook.id)).steps[0].status).toBe("failed");
    const line = s.mock.audits.filter((a) => a.action === "runbooks_step_run");
    expect(line[0]).toMatchObject({ success: false });
    expect(line[0].details).toMatch(/exit 0, checks failed/);

    // The agent reads the results and cannot clear them.
    const after = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(after.body.steps[0].status).toBe("failed");
    expect(after.body.steps[0].runs[0].checks[1].ok).toBe(false);
    const edit = await s.agent(
      "PATCH",
      `/steps/${runbook.steps[0].id}`,
      token,
      { checks: [] },
    );
    expect(edit.status).toBe(409);
    for (const path of ["reopen", "complete", "run"]) {
      const tried = await s.agent(
        "POST",
        `/steps/${runbook.steps[0].id}/${path}`,
        token,
        {},
      );
      // complete exists for agent steps (1.4.0); a person's step is refused.
      expect(tried.status).toBe(path === "complete" ? 403 : 404);
    }
    expect((await view(s, runbook.id)).steps[0].status).toBe("failed");
  });

  it("passes when every check passes, and keeps the captures", async () => {
    const { s, runbook } = await setup([
      {
        title: "Version",
        hostId: 1,
        command: "app --version",
        captures: [{ name: "ver", pattern: "^version (\\S+)$" }],
        checks: [{ type: "value", name: "ver", matches: "^1\\." }],
      },
    ]);
    s.setExec(async () => ({
      stdout: "version 1.4.0\n",
      stderr: "",
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body).toMatchObject({
      status: "done",
      captured: { ver: "1.4.0" },
      checks: [{ ok: true }],
    });
  });

  it("a step without checks behaves as before", async () => {
    const { s, runbook } = await setup([
      { title: "A", hostId: 1, command: "true" },
    ]);
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body).toMatchObject({ status: "done", checks: null });
  });

  it("Mark done tests the pasted output of a terminal run", async () => {
    const { s, runbook } = await setup([
      {
        title: "Status",
        hostId: 1,
        command: "systemctl is-active nginx",
        checks: [
          { type: "contains", text: "active", stream: "stdout" },
          { type: "exitCode", equals: 0 },
        ],
      },
    ]);
    const stepId = runbook.steps[0].id;
    const sent = await runStep(s, runbook.id, stepId, {}, "terminal");
    const failed = await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: "failed\n",
      outcome: "done",
    });
    expect(failed.body).toMatchObject({
      status: "failed",
      checks: [
        {
          ok: false,
          detail: "expected the pasted output to contain 'active'",
        },
        { ok: false, detail: "no exit code" },
      ],
    });
    expect((await view(s, runbook.id)).steps[0].status).toBe("failed");

    const again = await runStep(
      s,
      runbook.id,
      stepId,
      { confirmRepeat: true },
      "terminal",
    );
    const passed = await s.person("POST", `/runs/${again.body.id}/complete`, {
      pastedOutput: "active\n",
      exitCode: 0,
      outcome: "done",
    });
    expect(passed.body).toMatchObject({
      status: "done",
      checks: [{ ok: true }, { ok: true }],
    });

    // Mark failed records the person's verdict without testing.
    const third = await runStep(
      s,
      runbook.id,
      stepId,
      { confirmRepeat: true },
      "terminal",
    );
    const marked = await s.person("POST", `/runs/${third.body.id}/complete`, {
      pastedOutput: "active\n",
      outcome: "failed",
    });
    expect(marked.body).toMatchObject({ status: "failed", checks: null });
  });
});

describe("checkHidden (1.4.1)", () => {
  const checks: Check[] = [
    { type: "contains", text: "id: [secret:key]" },
    { type: "contains", text: "id: abc" },
    { type: "value", name: "id", equals: "[secret:key]" },
  ];
  const run = exec({ stdout: "id: abc123\n", stderr: "" });

  it("tests the checks and captured values with the secrets hidden", () => {
    const results = checkHidden(checks, run, { id: "abc123" }, [
      { name: "key", value: "abc123" },
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
  });

  it("is evaluateChecks when there is nothing to hide", () => {
    expect(checkHidden(checks, run, { id: "abc123" }, [])).toEqual(
      evaluateChecks(checks, run, { id: "abc123" }),
    );
  });
});
