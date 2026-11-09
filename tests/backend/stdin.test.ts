import { afterEach, describe, expect, it, vi } from "vitest";
import { commandHash } from "../../src/backend/values";
import { createRedactor, redact } from "../../src/backend/redact";
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

async function setup(
  steps: Array<Record<string, unknown>>,
  options: { values?: Record<string, string>; secrets?: boolean } = {},
) {
  server = await startServer({ secrets: options.secrets });
  const token = await server.makeToken();
  const runbook = await agentRunbook(server, token, {
    title: "Pipe",
    values: options.values ?? {},
    steps,
  });
  return { s: server, token, runbook };
}

const printOut =
  (stdout: string, stderr = "", code = 0) =>
  async () => ({
    stdout,
    stderr,
    code,
    truncated: false,
    timedOut: false,
  });

describe("standard input from an earlier step", () => {
  it("writes the earlier step's stdout to the command and ends it", async () => {
    const { s, runbook } = await setup([
      { title: "Make", hostId: 1, command: "make-config" },
      {
        title: "Apply",
        hostId: 1,
        command: "apply-config -",
        stdin: { from: "step", step: 1, stream: "stdout" },
      },
    ]);
    expect(runbook.steps[1].stdin).toEqual({
      from: "step",
      step: 1,
      stream: "stdout",
    });
    s.setExec(printOut("key: 1\n", "noise\n"));
    expect((await runStep(s, runbook.id, runbook.steps[0].id)).status).toBe(
      200,
    );

    const shown = await view(s, runbook.id);
    expect(shown.steps[1].stdin).toEqual({
      source: { from: "step", step: 1, stream: "stdout" },
      bytes: 7,
      preview: "key: 1\n",
      problem: null,
    });
    s.setExec(printOut("applied\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(ran.status).toBe(200);
    expect(ran.body.status).toBe("done");
    expect(ran.body.stdin).toEqual({
      from: "step",
      step: 1,
      stream: "stdout",
      bytes: 7,
    });
    expect(s.channels[1].stdin).toBe("key: 1\n");
    expect(s.channels[1].ended).toBe(true);
    // A step without stdin leaves standard input alone, as before.
    expect(s.channels[0].ended).toBe(false);
  });

  it("reads stderr, or the pasted output of a terminal run", async () => {
    const { s, runbook } = await setup([
      { title: "Ask", hostId: 1, command: "ask" },
      {
        title: "Use",
        hostId: 1,
        command: "use",
        stdin: { from: "step", step: 1, stream: "stderr" },
      },
    ]);
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    expect(sent.status).toBe(200);
    await s.person("POST", `/runs/${sent.body.id}/complete`, {
      pastedOutput: "pasted text\n",
      outcome: "done",
    });
    s.setExec(printOut(""));
    const ran = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(ran.body.status).toBe("done");
    expect(s.channels[0].stdin).toBe("pasted text\n");
  });

  it("refuses with stdin-missing before the earlier step ran or when it failed", async () => {
    const { s, runbook } = await setup([
      { title: "Make", hostId: 1, command: "make" },
      {
        title: "Use",
        hostId: 1,
        command: "use",
        stdin: { from: "step", step: 1, stream: "stdout" },
      },
      {
        title: "Use anyway",
        hostId: 1,
        command: "use --anyway",
        stdin: { from: "step", step: 1, stream: "stdout", allowFailed: true },
      },
    ]);
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].stdin.problem).toBe("step 1 has no finished run yet");
    let refused = await runStep(s, runbook.id, runbook.steps[1].id, {
      outOfOrder: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "stdin-missing",
      error: "step 1 has no finished run yet",
    });
    expect(s.channels).toHaveLength(0);

    s.setExec(printOut("half\n", "", 2));
    await runStep(s, runbook.id, runbook.steps[0].id);
    refused = await runStep(s, runbook.id, runbook.steps[1].id, {
      outOfOrder: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "stdin-missing",
      error: "the last run of step 1 failed",
    });

    s.setExec(printOut("ok\n"));
    const anyway = await runStep(s, runbook.id, runbook.steps[2].id, {
      outOfOrder: true,
    });
    expect(anyway.status).toBe(200);
    expect(s.channels.at(-1)!.stdin).toBe("half\n");
  });

  it("refuses Send to terminal on a step with stdin", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Use",
          hostId: 1,
          command: "use",
          stdin: { from: "value", name: "build_id" },
        },
      ],
      { values: { build_id: "42" } },
    );
    const sent = await runStep(
      s,
      runbook.id,
      runbook.steps[0].id,
      {},
      "terminal",
    );
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      code: "stdin-run-only",
      error: "This step gets input from value build_id: use Run",
    });
  });
});

describe("standard input from a value", () => {
  it("writes the effective value and one newline", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Tag",
          hostId: 1,
          command: "tag --from-stdin",
          stdin: { from: "value", name: "build_id" },
        },
      ],
      { values: { build_id: "b-77" } },
    );
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].stdin).toMatchObject({
      bytes: 5,
      preview: "b-77\n",
      problem: null,
    });
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(s.channels[0].stdin).toBe("b-77\n");
  });

  it("refuses a value that has no value yet", async () => {
    const { s, runbook } = await setup([
      {
        title: "Tag",
        hostId: 1,
        command: "tag",
        stdin: { from: "value", name: "nope" },
      },
    ]);
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.status).toBe(409);
    expect(ran.body).toMatchObject({
      code: "stdin-missing",
      error: "value nope has no value yet",
    });
  });
});

describe("the approved hash covers the input's source", () => {
  it("differs from the hash without stdin, and an old hash is stale", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Tag",
          hostId: 1,
          command: "tag",
          stdin: { from: "value", name: "build_id" },
        },
      ],
      { values: { build_id: "1" } },
    );
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].commandHash).toBe(
      commandHash(1, "tag", "value:build_id"),
    );
    expect(shown.steps[0].commandHash).not.toBe(commandHash(1, "tag"));
    const stale = await s.person("POST", `/steps/${runbook.steps[0].id}/run`, {
      revision: shown.steps[0].revision,
      commandHash: commandHash(1, "tag"),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale");
  });

  it("does not change for steps without stdin", async () => {
    const { s, runbook } = await setup([
      { title: "Plain", hostId: 1, command: "uptime" },
    ]);
    expect((await view(s, runbook.id)).steps[0].commandHash).toBe(
      commandHash(1, "uptime"),
    );
  });
});

describe("standard input from a library secret", () => {
  const steps = [
    {
      title: "Log in",
      hostId: 1,
      command: "docker login -u me --password-stdin",
      stdin: { from: "secret", library: "shared/registry/password" },
    },
  ];

  it("reads it as the person, writes it, and replaces it in the output", async () => {
    const { s, runbook } = await setup(steps, { secrets: true });
    s.secrets!.seed("shared", "registry/password", "hunter2-xyz");
    const shown = await view(s, runbook.id);
    expect(shown.secretsAvailable).toBe(true);
    expect(shown.steps[0].stdin).toEqual({
      source: { from: "secret", library: "shared/registry/password" },
      bytes: null,
      preview: null,
      problem: null,
    });
    s.setExec(printOut("password hunter2-xyz ok\n", "echo hunter2-xyz\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(s.channels[0].stdin).toBe("hunter2-xyz\n");
    expect(ran.body.stdout).toBe(
      "password [secret:shared/registry/password] ok\n",
    );
    expect(ran.body.stderr).toBe("echo [secret:shared/registry/password]\n");
    expect(ran.body.secrets).toEqual({
      used: ["shared/registry/password"],
      captured: [],
    });
    expect(s.secrets!.calls).toContainEqual({
      method: "get",
      area: "shared",
      name: "registry/password",
    });
    expect(everything(s)).not.toContain("hunter2");
    expect(auditText(s)).not.toContain("hunter2");
    expect(auditText(s)).toContain("read secret shared/registry/password");
    expect(JSON.stringify(await view(s, runbook.id))).not.toContain("hunter2");
  });

  it("reads mine/ secrets from the person's own area", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Use",
          hostId: 1,
          command: "use",
          stdin: { from: "secret", library: "mine/api" },
        },
      ],
      { secrets: true },
    );
    s.secrets!.seed("user:alice", "api", "alice-key");
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.body.status).toBe("done");
    expect(s.channels[0].stdin).toBe("alice-key\n");
  });

  it("refuses a missing secret, a missing service and a person without Use secrets", async () => {
    let { s, runbook } = await setup(steps, { secrets: true });
    let ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.status).toBe(409);
    expect(ran.body.code).toBe("secret-missing");
    expect(s.channels).toHaveLength(0);

    s.secrets!.seed("shared", "registry/password", "x");
    s.secrets!.allowed.delete("alice");
    ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.status).toBe(403);
    expect(ran.body.code).toBe("secrets-permission");

    s.secrets!.allowed.add("alice");
    s.secrets!.connected = false;
    ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.status).toBe(409);
    expect(ran.body).toEqual({
      code: "no-secrets",
      error: "Install and connect the OpenBao Secrets plugin to use secrets",
    });

    await s.close();
    ({ s, runbook } = await setup(steps));
    const shown = await view(s, runbook.id);
    expect(shown.secretsAvailable).toBe(false);
    expect(shown.steps[0].stdin.problem).toBe(
      "Install and connect the OpenBao Secrets plugin to use secrets",
    );
    ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.status).toBe(409);
    expect(ran.body.code).toBe("no-secrets");
  });

  it("replaces a value split across two pieces of live output", async () => {
    const { s, runbook } = await setup(steps, { secrets: true });
    s.secrets!.seed("shared", "registry/password", "s3cr3t-value");
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
    channel!.out("abc s3cr");
    let run = await shownRun(s, runbook.id, started.body.id);
    // What may be the start of a value is held back until more arrives.
    expect(run.stdout).toBe("");
    channel!.out("3t-value def\n");
    run = await shownRun(s, runbook.id, started.body.id);
    expect(run.stdout).toBe("abc [secret:shared/registry/password]");
    expect(JSON.stringify(run)).not.toContain("s3cr");
    channel!.exit(0);
    run = await waitForRun(s, runbook.id, started.body.id);
    expect(run.stdout).toBe("abc [secret:shared/registry/password] def\n");
    expect(everything(s)).not.toContain("s3cr");
  });
});

describe("what agents may write", () => {
  it("checks the source, needs a command, and keeps the step it names", async () => {
    server = await startServer();
    const s = server;
    const token = await s.makeToken();
    const bad = async (step: Record<string, unknown>) =>
      (
        await s.agent("POST", "/runbooks", token, {
          title: "x",
          steps: [{ title: "A", hostId: 1, command: "a" }, step],
        })
      ).body.error;
    expect(
      await bad({
        title: "B",
        hostId: 1,
        command: "b",
        stdin: { from: "step", step: 2, stream: "stdout" },
      }),
    ).toBe("steps[1]: stdin.step 2 is not before this step (position 2)");
    expect(
      await bad({
        title: "B",
        stdin: { from: "value", name: "x" },
      }),
    ).toBe("steps[1]: stdin needs a command that reads it");
    expect(
      await bad({
        title: "B",
        hostId: 1,
        command: "b",
        stdin: { from: "step", step: 1, stream: "both" },
      }),
    ).toBe("steps[1]: stdin.stream must be stdout or stderr");
    expect(
      await bad({
        title: "B",
        hostId: 1,
        command: "b",
        stdin: { from: "secret", library: "other/x" },
      }),
    ).toBe('steps[1]: stdin.library must be "mine/<name>" or "shared/<name>"');

    const runbook = await agentRunbook(s, token, {
      title: "Order",
      steps: [
        { title: "A", hostId: 1, command: "a" },
        {
          title: "B",
          hostId: 1,
          command: "b",
          stdin: { from: "step", step: 1, stream: "stdout" },
        },
      ],
    });
    // A step inserted first moves A to position 2; B still reads A.
    const moved = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      { position: 1, steps: [{ title: "Zero", hostId: 1, command: "z" }] },
    );
    expect(moved.status).toBe(201);
    expect(moved.body.steps[2].stdin).toEqual({
      from: "step",
      step: 2,
      stream: "stdout",
    });
    // A cannot go while B reads it, nor move after B.
    const [zero, a, b] = moved.body.steps;
    const removed = await s.agent("DELETE", `/steps/${a.id}`, token);
    expect(removed.status).toBe(409);
    expect(removed.body.error).toBe(
      "step 3 reads this step's output; change or remove it first",
    );
    const reordered = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/reorder`,
      token,
      { stepIds: [zero.id, b.id, a.id] },
    );
    expect(reordered.status).toBe(400);
  });
});

describe("the redactor", () => {
  it("replaces whole values only, longest first, across any split", () => {
    const secrets = [
      { name: "short", value: "abc" },
      { name: "long", value: "abcdef" },
    ];
    expect(redact("x abcdef y abc z", secrets)).toBe(
      "x [secret:long] y [secret:short] z",
    );
    const text = "1 abcdef 2 abc 3";
    for (let cut = 0; cut <= text.length; cut++) {
      const redactor = createRedactor(secrets);
      const out =
        redactor.push(text.slice(0, cut)) +
        redactor.push(text.slice(cut)) +
        redactor.end();
      expect(out).toBe("1 [secret:long] 2 [secret:short] 3");
    }
    expect(redact("nothing", [])).toBe("nothing");
  });
});

describe("stdin over MCP", () => {
  it("takes stdin on a step and explains it in the tools", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const rpc = (method: string, params: unknown) =>
      server!.agent("POST", "/mcp", token, {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      });
    const tools = await rpc("tools/list", {});
    const create = tools.body.result.tools.find(
      (tool: { name: string }) => tool.name === "create_runbook",
    );
    expect(create.description).toContain("--password-stdin");
    expect(create.description).toContain("Secrets never appear in commands");
    expect(
      create.inputSchema.properties.steps.items.properties.stdin,
    ).toBeTruthy();
    const made = await rpc("tools/call", {
      name: "create_runbook",
      arguments: {
        title: "Pipe",
        steps: [
          { title: "A", hostId: 1, command: "a" },
          {
            title: "B",
            hostId: 1,
            command: "b",
            stdin: { from: "step", step: 1, stream: "stdout" },
          },
        ],
      },
    });
    expect(made.body.result.isError).toBe(false);
    expect(made.body.result.structuredContent.steps[1].stdin).toEqual({
      from: "step",
      step: 1,
      stream: "stdout",
    });
  });
});
