import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRunbook,
  auditText,
  everything,
  FakeChannel,
  runStep,
  shownRun,
  startServer,
  view,
  waitForRun,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const TOKEN = "tk-9f8e7d6c5b4a";

const makeToken = {
  title: "Make a token",
  hostId: 1,
  command: "make-token",
  secretCaptures: [{ name: "api_token", pattern: "token: (\\S+)" }],
};
const useToken = {
  title: "Log in",
  hostId: 1,
  command: "login --password-stdin",
  stdin: { from: "secret", name: "api_token" },
};

async function setup(
  steps: Array<Record<string, unknown>> = [makeToken, useToken],
  options: { secrets?: boolean } = { secrets: true },
) {
  server = await startServer({ secrets: options.secrets });
  const token = await server.makeToken();
  const runbook = await agentRunbook(server, token, { title: "Token", steps });
  return { s: server, token, runbook };
}

const prints =
  (stdout: string, stderr = "", code = 0) =>
  async () => ({
    stdout,
    stderr,
    code,
    truncated: false,
    timedOut: false,
  });

const DAY = 24 * 60 * 60 * 1000;

describe("secret captures", () => {
  it("stores the match in Runbooks' area for 7 days and hides it in the output", async () => {
    const { s, runbook } = await setup();
    s.setExec(prints(`created\ntoken: ${TOKEN}\n`, `debug ${TOKEN}\n`));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(ran.body.stdout).toBe("created\ntoken: [secret:api_token]\n");
    expect(ran.body.stderr).toBe("debug [secret:api_token]\n");

    const stored = s.secrets!.data.get(
      `plugin:runbooks|runbooks/${runbook.id}/api_token`,
    );
    expect(stored?.value).toBe(TOKEN);
    const expires = Date.parse(stored!.expiresAt!);
    expect(Math.abs(expires - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    expect(ran.body.secrets).toEqual({
      used: [],
      captured: [{ name: "api_token", expiresAt: stored!.expiresAt }],
    });
    // The area key came through the receiver, during Runbooks' own bind.
    expect(s.secrets!.calls[0]).toEqual({
      method: "bind",
      area: "runbooks",
      name: "",
    });
    const shown = await view(s, runbook.id);
    expect(shown.secrets).toEqual([
      {
        name: "api_token",
        step: 1,
        set: true,
        expiresAt: stored!.expiresAt,
      },
    ]);
    expect(
      s.mock.audits.find((a) => a.action === "runbooks_step_run")!.details,
    ).toContain("stored secret api_token");

    // The next step reads it as standard input.
    s.setExec(prints(`using ${TOKEN}\n`));
    const used = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(used.body.status).toBe("done");
    expect(s.channels[1].stdin).toBe(`${TOKEN}\n`);
    expect(used.body.stdout).toBe("using [secret:api_token]\n");
    expect(used.body.secrets).toEqual({ used: ["api_token"], captured: [] });

    // Nowhere in Runbooks' rows, the views, the agent API, MCP or the audit.
    const token = await s.makeToken("reader");
    const agentView = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_runbook", arguments: { runbookId: runbook.id } },
    });
    for (const text of [
      everything(s),
      JSON.stringify(await view(s, runbook.id)),
      JSON.stringify(agentView.body),
      JSON.stringify(mcp.body),
      auditText(s),
    ]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(agentView.body.secrets).toEqual([
      {
        name: "api_token",
        step: 1,
        set: true,
        expiresAt: stored!.expiresAt,
      },
    ]);
    expect(agentView.body.steps[0].secretCaptures).toEqual(
      makeToken.secretCaptures,
    );
  });

  it("fails the step when a pattern matches nothing, and stores nothing", async () => {
    const { s, runbook } = await setup();
    s.setExec(prints("no token here\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("failed");
    expect(ran.body.error).toBe("secret api_token: no match");
    expect(s.secrets!.data.size).toBe(0);
    expect((await view(s, runbook.id)).steps[0].status).toBe("failed");
    // The step that reads it is refused: the secret is not there.
    const next = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(next.status).toBe(409);
    expect(next.body.code).toBe("secret-missing");
  });

  it("hides the value also when the run fails, and in plain captures", async () => {
    const { s, runbook } = await setup([
      {
        ...makeToken,
        captures: [{ name: "line", pattern: "^(token: .*)$" }],
      },
    ]);
    s.setExec(prints(`token: ${TOKEN}\n`, "", 1));
    let ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("failed");
    expect(ran.body.stdout).toBe("token: [secret:api_token]\n");
    expect(s.secrets!.data.size).toBe(0);

    s.setExec(prints(`token: ${TOKEN}\n`));
    ran = await runStep(s, runbook.id, runbook.steps[0].id, {
      confirmRepeat: true,
    });
    expect(ran.body.status).toBe("done");
    expect(ran.body.captured).toEqual({ line: "token: [secret:api_token]" });
    expect(everything(s)).not.toContain(TOKEN);
  });

  it("holds the live output until the run ends", async () => {
    const { s, runbook } = await setup();
    let channel: FakeChannel | null = null;
    s.setChannel((opened) => (channel = opened));
    const started = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "run",
      {
        wait: false,
      },
    );
    await vi.waitFor(() => expect(channel).not.toBeNull());
    channel!.out(`token: ${TOKEN.slice(0, 5)}`);
    channel!.out(`${TOKEN.slice(5)}\n`);
    const live = await shownRun(s, runbook.id, started.body.id);
    expect(live).toMatchObject({ running: true, outputHeld: true, stdout: "" });
    expect(live.lastOutputAt).toEqual(expect.any(String));
    expect(everything(s)).not.toContain(TOKEN.slice(0, 5));
    channel!.exit(0);
    const run = await waitForRun(s, runbook.id, started.body.id);
    expect(run.stdout).toBe("token: [secret:api_token]\n");
  });

  it("stores a secret from the output pasted for a terminal run", async () => {
    const { s, runbook } = await setup();
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    expect(sent.status).toBe(200);
    const done = await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: `token: ${TOKEN}\n`,
      outcome: "done",
    });
    expect(done.body.status).toBe("done");
    expect(done.body.pastedOutput).toBe("token: [secret:api_token]\n");
    expect(
      s.secrets!.data.get(`plugin:runbooks|runbooks/${runbook.id}/api_token`)
        ?.value,
    ).toBe(TOKEN);
    expect(everything(s)).not.toContain(TOKEN);
  });

  it("refuses to run without the service", async () => {
    const { s, runbook } = await setup([makeToken], { secrets: false });
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].secretsProblem).toBe(
      "Install and connect the OpenBao Secrets plugin to use secrets",
    );
    for (const mode of ["run", "terminal"] as const) {
      const ran = await runStep(s, runbook.id, runbook.steps[0].id, {}, mode);
      expect(ran.status).toBe(409);
      expect(ran.body).toEqual({
        code: "no-secrets",
        error: "Install and connect the OpenBao Secrets plugin to use secrets",
      });
    }
    expect(s.channels).toHaveLength(0);
  });

  it("takes an area key only during its own bind", async () => {
    const { s } = await setup();
    const receiver = s.mock.ctx.registry.consume<(key: string) => void>(
      "runbooks.secretsStoreKey",
    )!;
    expect(() => receiver("a".repeat(64))).toThrow(/not binding/);
  });
});

describe("deleting a runbook's secrets", () => {
  async function captured() {
    const ctx = await setup();
    ctx.s.setExec(prints(`token: ${TOKEN}\n`));
    await runStep(ctx.s, ctx.runbook.id, ctx.runbook.steps[0].id);
    expect(ctx.s.secrets!.data.size).toBe(1);
    return ctx;
  }

  for (const status of ["done", "abandoned"]) {
    it(`removes the prefix when the person marks it ${status}`, async () => {
      const { s, runbook } = await captured();
      const closed = await s.person("POST", `/runbooks/${runbook.id}/status`, {
        status,
      });
      expect(closed.status).toBe(200);
      expect(s.secrets!.calls).toContainEqual({
        method: "removePrefix",
        area: "plugin:runbooks",
        name: `runbooks/${runbook.id}/`,
      });
      expect(s.secrets!.data.size).toBe(0);
      expect(closed.body.secrets).toEqual([
        { name: "api_token", step: 1, set: false, expiresAt: null },
      ]);
      expect(
        s.mock.audits.find((a) => a.action === "runbooks_secrets_remove"),
      ).toMatchObject({ success: true });
    });
  }

  it("removes them on the next read by a person when an agent closed it", async () => {
    const { s, runbook, token } = await captured();
    const patched = await s.agent("PATCH", `/runbooks/${runbook.id}`, token, {
      status: "done",
    });
    expect(patched.status).toBe(200);
    // An agent has no person to act as, so nothing was deleted yet.
    expect(s.secrets!.data.size).toBe(1);
    await s.person("GET", "/runbooks");
    expect(s.secrets!.data.size).toBe(0);
    const removes = () =>
      s.secrets!.calls.filter((call) => call.method === "removePrefix");
    expect(removes()).toHaveLength(1);
    // Once done, later reads leave the service alone.
    await s.person("GET", "/runbooks");
    await view(s, runbook.id);
    expect(removes()).toHaveLength(1);
  });

  it("keeps trying later when the person may not use secrets", async () => {
    const { s, runbook } = await captured();
    s.secrets!.allowed.delete("alice");
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    expect(s.secrets!.data.size).toBe(1);
    expect(
      s.mock.audits.find((a) => a.action === "runbooks_secrets_remove"),
    ).toMatchObject({ success: false });
    await s.person("GET", "/runbooks", undefined, { user: "bob" });
    // Within the retry wait, nothing is tried again.
    expect(s.secrets!.data.size).toBe(1);
  });
});

describe("what agents may write", () => {
  it("checks secretCaptures and the secrets a step reads", async () => {
    server = await startServer();
    const s = server;
    const token = await s.makeToken();
    const error = async (steps: unknown[]) =>
      (await s.agent("POST", "/runbooks", token, { title: "x", steps })).body
        .error;
    expect(
      await error([
        { title: "A", secretCaptures: [{ name: "t", pattern: "(x)" }] },
      ]),
    ).toBe("steps[0]: secretCaptures need a command whose output they read");
    expect(
      await error([
        {
          title: "A",
          hostId: 1,
          command: "a",
          secretCaptures: [{ name: "t", pattern: "(x)(y)" }],
        },
      ]),
    ).toBe(
      'steps[0]: secretCaptures: secret "t" pattern must have exactly one capturing group',
    );
    expect(
      await error([
        {
          title: "A",
          hostId: 1,
          command: "a",
          secretCaptures: Array.from({ length: 11 }, (_, i) => ({
            name: `t${i}`,
            pattern: "(x)",
          })),
        },
      ]),
    ).toBe("steps[0]: a step may have at most 10 secretCaptures");
    expect(
      await error([
        makeToken,
        { ...useToken, stdin: { from: "secret", name: "other" } },
      ]),
    ).toBe(
      "step 2 reads secret other, which no earlier step captures (secretCaptures), makes (generate) or asks for (ask)",
    );
    expect(await error([useToken, makeToken])).toBe(
      "step 1 reads secret api_token, which no earlier step captures (secretCaptures), makes (generate) or asks for (ask)",
    );
    // The step that captures it cannot go while a later step reads it.
    const runbook = await agentRunbook(s, token, {
      title: "ok",
      steps: [makeToken, useToken],
    });
    const removed = await s.agent(
      "DELETE",
      `/steps/${runbook.steps[0].id}`,
      token,
    );
    expect(removed.status).toBe(409);
  });
});

describe("checks see the output with its secrets hidden (1.4.1)", () => {
  const withChecks = (checks: unknown[], extra: Record<string, unknown> = {}) =>
    setup([{ ...makeToken, checks, ...extra }, useToken]);

  it("passes a check for [secret:name] on a step that captures that secret", async () => {
    const { s, runbook } = await withChecks([
      { type: "contains", text: "token: [secret:api_token]" },
      { type: "matches", pattern: "^token: \\[secret:api_token\\]$" },
    ]);
    s.setExec(prints(`created\ntoken: ${TOKEN}\n`));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(ran.body.checks.map((check: { ok: boolean }) => check.ok)).toEqual([
      true,
      true,
    ]);
    expect(
      s.secrets!.data.get(`plugin:runbooks|runbooks/${runbook.id}/api_token`)
        ?.value,
    ).toBe(TOKEN);
    expect(everything(s)).not.toContain(TOKEN);
  });

  it("fails a check that names part of the real value, whatever the value", async () => {
    // The same checks on two values: one that holds the guessed text and
    // one that does not. The answer must not tell them apart.
    const outcomes: unknown[] = [];
    for (const value of ["tk-9f8e7d6c5b4a", "zz-0000000000"]) {
      const { s, runbook } = await withChecks([
        { type: "contains", text: "token: tk-9" },
        { type: "matches", pattern: "token: tk-[0-9a-f]+" },
        { type: "notContains", text: "tk-9f" },
      ]);
      s.setExec(prints(`token: ${value}\n`));
      const ran = await runStep(s, runbook.id, runbook.steps[0].id);
      outcomes.push({
        status: ran.body.status,
        checks: ran.body.checks,
      });
      expect(ran.body.status).toBe("failed");
      expect(ran.body.checks.map((check: { ok: boolean }) => check.ok)).toEqual(
        [false, false, true],
      );
      // A failed step keeps no secret.
      expect(s.secrets!.data.size).toBe(0);
      expect(everything(s)).not.toContain(value);
      await s.close();
      server = null;
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it("tests a check on a capture that holds a secret against the hidden form", async () => {
    const { s, runbook } = await withChecks(
      [
        { type: "value", name: "line", equals: "token: [secret:api_token]" },
        { type: "value", name: "line", matches: "^token: \\[secret:" },
      ],
      { captures: [{ name: "line", pattern: "^(token: .*)$" }] },
    );
    s.setExec(prints(`token: ${TOKEN}\n`));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(ran.body.captured).toEqual({ line: "token: [secret:api_token]" });
    expect(everything(s)).not.toContain(TOKEN);
  });

  it("refuses a value check that names the real value of a captured secret", async () => {
    const { s, runbook } = await withChecks(
      [{ type: "value", name: "line", equals: `token: ${TOKEN}` }],
      { captures: [{ name: "line", pattern: "^(token: .*)$" }] },
    );
    s.setExec(prints(`token: ${TOKEN}\n`));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("failed");
    expect(s.secrets!.data.size).toBe(0);
  });

  it("hides a secret the step reads before its checks", async () => {
    const { s, runbook } = await setup([
      makeToken,
      {
        ...useToken,
        checks: [
          { type: "contains", text: "using [secret:api_token]" },
          { type: "notContains", text: TOKEN.slice(0, 6) },
        ],
      },
    ]);
    s.setExec(prints(`token: ${TOKEN}\n`));
    await runStep(s, runbook.id, runbook.steps[0].id);
    s.setExec(prints(`using ${TOKEN}\n`));
    const used = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(used.body.status).toBe("done");
    expect(used.body.checks.every((check: { ok: boolean }) => check.ok)).toBe(
      true,
    );
  });

  it("checks the pasted output of a terminal run with its secrets hidden", async () => {
    const { s, runbook } = await withChecks([
      { type: "contains", text: "token: [secret:api_token]" },
    ]);
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    const done = await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: `token: ${TOKEN}\n`,
      outcome: "done",
    });
    expect(done.body.status).toBe("done");
    expect(done.body.checks[0].ok).toBe(true);
    expect(everything(s)).not.toContain(TOKEN);
  });

  it("leaves output with no secret as it is", async () => {
    const { s, runbook } = await setup([
      {
        title: "Plain",
        hostId: 1,
        command: "status",
        captures: [{ name: "state", pattern: "state: (\\S+)" }],
        checks: [
          { type: "contains", text: "state: up" },
          { type: "value", name: "state", equals: "up" },
          { type: "notContains", text: "[secret:" },
        ],
      },
    ]);
    s.setExec(prints("state: up\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(ran.body.stdout).toBe("state: up\n");
    expect(ran.body.captured).toEqual({ state: "up" });
  });
});
