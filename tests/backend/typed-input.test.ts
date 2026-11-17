import { describe, expect, it, vi } from "vitest";
import {
  streamExec,
  type ExecChannel,
  type ExecClient,
} from "../../src/backend/running/stream-exec";
import {
  cleanTerminalText,
  createTerminalCleaner,
} from "../../src/backend/running/terminal-text";
import { createRedactor } from "../../src/backend/running/redact";
import {
  auditText,
  everything,
  FakeChannel,
  runStep,
  setupRunbook,
  shownRun,
  useTestServer,
  view,
  waitForRun,
  type TestServer,
} from "./helpers";

const startServer = useTestServer();

/** A client whose one command is driven by hand; it records the options. */
function fakeClient() {
  const channel = new FakeChannel();
  const calls: Array<{ pty?: unknown }> = [];
  const client: ExecClient = {
    exec: (_command, options, callback) => {
      calls.push(options);
      callback(undefined, channel as unknown as ExecChannel);
    },
  };
  return { client, channel, calls };
}

const PTY = { term: "dumb", rows: 40, cols: 200 };

describe("terminal text (T-023)", () => {
  it("makes CR LF, a lone CR, colour, title and two-byte codes plain", () => {
    expect(
      cleanTerminalText(
        "\u001b[31mred\u001b[0m line\r\n" +
          "\u001b]0;title\u0007progress 1\rprogress 2\r\n" +
          "\u001b(Bplain\u001b=\ttab\u0008\r\n",
      ),
    ).toBe("red line\nprogress 1\nprogress 2\nplain\ttab\n");
    expect(cleanTerminalText("\u001b]2;t\u001b\\after")).toBe("after");
  });

  it("holds back a code or a CR split across two pieces", () => {
    const cleaner = createTerminalCleaner();
    expect(cleaner.push("one\r")).toBe("one");
    expect(cleaner.push("\ntwo \u001b[3")).toBe("\ntwo ");
    expect(cleaner.push("2mgreen\u001b]0;ti")).toBe("green");
    expect(cleaner.push("tle\u0007 end\r")).toBe(" end");
    expect(cleaner.end()).toBe("\n");
  });

  it("drops a code that never ends", () => {
    expect(cleanTerminalText("a\u001b[12")).toBe("a[12");
    const cleaner = createTerminalCleaner();
    expect(cleaner.push(`x\u001b]${"y".repeat(600)}`)).toBe(
      `x]${"y".repeat(600)}`,
    );
  });
});

describe("Redactor.add (T-023)", () => {
  it("hides a value added in the middle of a stream, split across pieces", () => {
    const redactor = createRedactor([{ name: "token", value: "s3cr3t-1" }]);
    expect(redactor.push("before hunter")).toBe("before hunter");
    redactor.add({ name: "typed", value: "hunter22" });
    let out = redactor.push("22 and hun");
    // Only an end that a value starts with is held back.
    expect(out).toBe("22 and ");
    out += redactor.push("ter22, s3cr3t-1");
    out += redactor.end();
    // "hunter" had already gone out; the next whole value is hidden.
    expect(out).toBe("22 and [secret:typed], [secret:token]");
  });

  it("shows a prompt at once, holding back only what may start a value", () => {
    const redactor = createRedactor([{ name: "pw", value: "Zq9!secret" }]);
    expect(redactor.push("[sudo] password for alice: ")).toBe(
      "[sudo] password for alice: ",
    );
    expect(redactor.push("Zq9")).toBe("");
    expect(redactor.push("!sec")).toBe("");
    expect(redactor.push("ret\nZq")).toBe("[secret:pw]\n");
    expect(redactor.push("x")).toBe("Zqx");
    expect(redactor.push("Z")).toBe("");
    expect(redactor.end()).toBe("Z");
  });

  it("works on a redactor that hid nothing before", () => {
    const redactor = createRedactor([]);
    expect(redactor.push("a ")).toBe("a ");
    redactor.add({ name: "typed", value: "pass-word" });
    expect(
      redactor.push("pass-") + redactor.push("word!") + redactor.end(),
    ).toBe("[secret:typed]!");
  });
});

describe("streamExec input (T-023)", () => {
  it("writes after start and ends with EOF without a pty", async () => {
    const { client, channel, calls } = fakeClient();
    const handle = streamExec(client, "cat", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(calls).toEqual([{}]);
    expect(handle.inputOpen()).toBe(true);
    expect(handle.write(Buffer.from("hello\n"))).toBe(true);
    expect(handle.endInput()).toBe(true);
    expect(channel.stdin).toBe("hello\n");
    expect(channel.ended).toBe(true);
    // Input ended: nothing more goes in.
    expect(handle.inputOpen()).toBe(false);
    expect(handle.write(Buffer.from("more"))).toBe(false);
    expect(handle.endInput()).toBe(false);
    channel.exit(0);
    await handle.result;
  });

  it("opens a pty, ends input in mid-line with Ctrl-D twice, and cleans the output", async () => {
    const { client, channel, calls } = fakeClient();
    const seen: string[] = [];
    const handle = streamExec(client, "sudo true", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      pty: PTY,
      onOutput: (stream, text) => seen.push(`${stream}:${text}`),
    });
    expect(calls).toEqual([{ pty: PTY }]);
    channel.out("\u001b[1m[sudo] password for t023: \u001b[0m");
    expect(handle.write(Buffer.from("half"))).toBe(true);
    expect(handle.endInput()).toBe(true);
    // A pty sees no EOF from end(). In mid-line (BUG-010): Ctrl-D hands
    // "half" over as typed, without a line end, and a second is the EOF.
    expect(channel.stdin).toBe("half\u0004\u0004");
    expect(channel.ended).toBe(false);
    channel.out("\r\ndone\r\n");
    channel.exit(0);
    const result = await handle.result;
    expect(result.stdout).toBe("[sudo] password for t023: \ndone\n");
    expect(seen.join("")).toBe(
      "stdout:[sudo] password for t023: stdout:\ndone\n",
    );
  });

  it("sends only Ctrl-D at the start of a line", async () => {
    const { client, channel } = fakeClient();
    const handle = streamExec(client, "cat", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      pty: PTY,
    });
    handle.write(Buffer.from("line\n"));
    handle.endInput();
    expect(channel.stdin).toBe("line\n\u0004");
    channel.exit(0);
    await handle.result;
  });

  it("refuses input once the command ended, and for a run given stdin", async () => {
    const { client, channel } = fakeClient();
    const handle = streamExec(client, "true", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    channel.exit(0);
    await handle.result;
    expect(handle.write(Buffer.from("late"))).toBe(false);
    expect(channel.input).toEqual([]);

    const piped = fakeClient();
    const withStdin = streamExec(piped.client, "cat", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      stdin: Buffer.from("given\n"),
    });
    expect(withStdin.inputOpen()).toBe(false);
    expect(withStdin.write(Buffer.from("typed"))).toBe(false);
    expect(piped.channel.stdin).toBe("given\n");
    piped.channel.exit(0);
    await withStdin.result;
  });
});

/** Starts a Run whose channel the test drives. */
async function startHeld(s: TestServer, runbookId: number, stepId: number) {
  let channel: FakeChannel | null = null;
  s.setChannel((opened) => (channel = opened));
  const started = await runStep(s, runbookId, stepId, {}, "run", {
    wait: false,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await vi.waitFor(() => expect(channel).not.toBeNull());
  return { started: started.body, channel: channel! };
}

const typeInto = (
  s: TestServer,
  runId: number,
  body: Record<string, unknown>,
  options?: { user?: string; apiKey?: boolean },
) => s.person("POST", `/runs/${runId}/input`, body, options);

describe("POST /runs/{id}/input (T-023)", () => {
  it("types into a plain Run; a hidden input is [secret:typed] in the live output, the stored output and the checks", async () => {
    const { s, runbook } = await setupRunbook([
      {
        title: "Sudo",
        hostId: 1,
        command: "sudo -S true; echo ok",
        checks: [{ type: "notContains", text: "hunter22" }],
      },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    expect(started.acceptsInput).toBe(true);
    channel.err("[sudo] password for alice: ");
    const sent = await typeInto(s, started.id, {
      text: "hunter22\n",
      hidden: true,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.inputs).toEqual([
      expect.objectContaining({ chars: 8, hidden: true, ended: false }),
    ]);
    expect(channel.stdin).toBe("hunter22\n");
    // A program that echoes it back.
    channel.out("you typed hunter22\n");
    const live = await shownRun(s, runbook.id, started.id);
    expect(live.stdout).toBe("you typed [secret:typed]\n");
    channel.out("ok\n");
    channel.exit(0);
    const run = await waitForRun(s, runbook.id, started.id);
    expect(run.status).toBe("done");
    expect(run.stdout).toBe("you typed [secret:typed]\nok\n");
    expect(run.checks[0].ok).toBe(true);
    expect(run.inputs).toHaveLength(1);
    expect(run.acceptsInput).toBeUndefined();
  });

  it("never stores or logs the text: the log has the count and the flag", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Read", hostId: 1, command: "read -r x; echo got" },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    await typeInto(s, started.id, { text: "visible-words\n" });
    await typeInto(s, started.id, { text: "Zq9-hidden\n", hidden: true });
    const ended = await typeInto(s, started.id, { text: "", end: true });
    expect(ended.status).toBe(200);
    expect(ended.body.acceptsInput).toBe(false);
    expect(channel.ended).toBe(true);
    channel.exit(0);
    const run = await waitForRun(s, runbook.id, started.id);
    expect(
      run.inputs.map((i: Record<string, unknown>) => [
        i.chars,
        i.hidden,
        i.ended,
      ]),
    ).toEqual([
      [13, false, false],
      [10, true, false],
      [0, false, true],
    ]);
    for (const text of [everything(s), auditText(s)]) {
      expect(text).not.toContain("visible-words");
      expect(text).not.toContain("Zq9-hidden");
    }
    const audits = s.mock.audits.filter(
      (a) => a.action === "runbooks_step_input",
    );
    expect(audits.map((a) => a.details)).toEqual([
      expect.stringContaining("input sent: 13 characters"),
      expect.stringContaining("input sent: 10 characters, hidden"),
      expect.stringContaining("input ended"),
    ]);
    // Agents see a count, nothing else.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    const agentRun = read.body.steps[0].runs[0];
    expect(agentRun.inputCount).toBe(3);
    expect(agentRun.inputs).toBeUndefined();
  });

  it("does not hide a hidden input shorter than 4 characters", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "Confirm", hostId: 1, command: "confirm" },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    await typeInto(s, started.id, { text: "y\n", hidden: true });
    channel.out("answer y\n");
    channel.exit(0);
    const run = await waitForRun(s, runbook.id, started.id);
    expect(run.stdout).toBe("answer y\n");
  });

  it("is only for the person who started the run, never a Termix API key or an agent (D6)", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "Read", hostId: 1, command: "read -r x" },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    const bob = await typeInto(s, started.id, { text: "x\n" }, { user: "bob" });
    expect(bob.status).toBe(403);
    expect(bob.body.code).toBe("not-your-run");
    const apiKey = await typeInto(
      s,
      started.id,
      { text: "x\n" },
      { apiKey: true },
    );
    expect(apiKey.status).toBe(403);
    const agent = await s.agent("POST", `/runs/${started.id}/input`, token, {
      text: "x\n",
    });
    expect(agent.status).toBe(404);
    expect(channel.input).toEqual([]);
    channel.exit(0);
    await waitForRun(s, runbook.id, started.id);
  });

  it("refuses a run that is not running, one with stdin, too much text and no text", async () => {
    const { s, runbook } = await setupRunbook(
      [
        { title: "Read", hostId: 1, command: "read -r x" },
        {
          title: "Piped",
          hostId: 1,
          command: "cat",
          stdin: { from: "value", name: "v" },
        },
      ],
      { values: { v: "given" } },
    );
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    const big = await typeInto(s, started.id, { text: "x".repeat(4097) });
    expect(big.status).toBe(400);
    expect(big.body.code).toBe("too-long");
    const empty = await typeInto(s, started.id, { text: "" });
    expect(empty.status).toBe(400);
    const bad = await typeInto(s, started.id, { text: "x", hidden: "yes" });
    expect(bad.status).toBe(400);
    channel.exit(0);
    await waitForRun(s, runbook.id, started.id);
    const after = await typeInto(s, started.id, { text: "x\n" });
    expect(after.status).toBe(409);
    expect(after.body.code).toBe("not-running");
    expect((await typeInto(s, 9999, { text: "x" })).status).toBe(404);

    const piped = await startHeld(s, runbook.id, runbook.steps[1].id);
    expect(piped.started.acceptsInput).toBe(false);
    const refused = await typeInto(s, piped.started.id, { text: "x\n" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("stdin-source");
    piped.channel.exit(0);
    await waitForRun(s, runbook.id, piped.started.id);
  });

  it("refuses more input after End input", async () => {
    const { s, runbook } = await setupRunbook([
      { title: "Cat", hostId: 1, command: "cat" },
    ]);
    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    const sent = await typeInto(s, started.id, { text: "last\n", end: true });
    expect(sent.status).toBe(200);
    expect(sent.body.inputs[0]).toMatchObject({ chars: 4, ended: true });
    const more = await typeInto(s, started.id, { text: "more\n" });
    expect(more.status).toBe(409);
    expect(more.body.code).toBe("input-closed");
    expect(channel.stdin).toBe("last\n");
    channel.exit(0);
    await waitForRun(s, runbook.id, started.id);
  });
});

describe("interactive steps (T-023)", () => {
  it("open a pty, show plain output and end input with Ctrl-D", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Become",
        hostId: 1,
        command: "sudo apt-get update",
        interactive: true,
        runIn: "run",
        checks: [{ type: "contains", text: "Done", stream: "stdout" }],
      },
      { title: "Plain", hostId: 1, command: "true" },
    ]);
    expect(runbook.steps[0].interactive).toBe(true);
    expect(runbook.steps[1].interactive).toBe(false);
    expect((await view(s, runbook.id)).steps[0].interactive).toBe(true);
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.steps[0].interactive).toBe(true);

    const { started, channel } = await startHeld(
      s,
      runbook.id,
      runbook.steps[0].id,
    );
    expect(s.execCalls.at(-1)!.execOptions).toEqual({ pty: PTY });
    channel.out("\u001b[0m[sudo] password for alice: ");
    // Enter under a pty is CR (BUG-010): a line sent with LF gets CR,
    // which Linux reads as LF and PowerShell's Read-Host as Enter. The
    // page sends CR itself; the count and the mask leave the line end out.
    const sent = await typeInto(s, started.id, {
      text: "become-pw\n",
      hidden: true,
    });
    expect(sent.body.inputs[0].chars).toBe(9);
    await typeInto(s, started.id, { text: "again\r" });
    await typeInto(s, started.id, { text: "", end: true });
    expect(channel.stdin).toBe("become-pw\ragain\r\u0004");
    channel.out("\r\nbecome-pw\r\nDone\r\n");
    channel.exit(0);
    const run = await waitForRun(s, runbook.id, started.id);
    expect(run.status).toBe("done");
    expect(run.stdout).toBe(
      "[sudo] password for alice: \n[secret:typed]\nDone\n",
    );

    // A plain step gets no pty.
    s.setChannel(null);
    await runStep(s, runbook.id, runbook.steps[1].id);
    expect(s.execCalls.at(-1)!.execOptions).toEqual({});
  });

  it("refuses interactive where it cannot work", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ hostId: 1, command: "x", interactive: "yes" }, "true or false"],
      [
        {
          hostId: 1,
          command: "x",
          interactive: true,
          stdin: { from: "value", name: "v" },
        },
        "cannot have stdin",
      ],
      [
        {
          hostId: 1,
          command: "x",
          interactive: true,
          secretCaptures: [{ name: "tok", pattern: "t: (\\S+)" }],
        },
        "cannot have secretCaptures",
      ],
      [
        {
          hostId: 1,
          command: "x",
          interactive: true,
          checks: [{ type: "contains", text: "e", stream: "stderr" }],
        },
        'stream "stderr"',
      ],
      [
        { hostId: 1, command: "x", interactive: true, runIn: "terminal" },
        'runIn "terminal"',
      ],
      [{ interactive: true }, "needs a command"],
      [{ owner: "agent", command: "x", interactive: true }, "needs a command"],
      [{ where: "PC", command: "x", interactive: true }, "needs a command"],
    ];
    for (const [step, error] of bad) {
      const reply = await server.agent("POST", "/runbooks", token, {
        title: "Bad",
        values: { v: "1" },
        steps: [{ title: "S", ...step }],
      });
      expect(reply.status, JSON.stringify(step)).toBe(400);
      expect(reply.body.error, JSON.stringify(step)).toContain(error);
    }
  });

  it("changes with update_step, checked against the step as it will be", async () => {
    const { s, token, runbook } = await setupRunbook([
      {
        title: "Logs",
        hostId: 1,
        command: "x",
        checks: [{ type: "notContains", text: "e", stream: "stderr" }],
      },
    ]);
    const stepId = runbook.steps[0].id;
    const refused = await s.agent("PATCH", `/steps/${stepId}`, token, {
      interactive: true,
    });
    expect(refused.status).toBe(400);
    const changed = await s.agent("PATCH", `/steps/${stepId}`, token, {
      interactive: true,
      checks: [],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await view(s, runbook.id)).steps[0].interactive).toBe(true);
  });

  it("MCP tools take interactive", async () => {
    const server = await startServer();
    const token = await server.makeToken();
    const created = await server.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_runbook",
        arguments: {
          title: "MCP",
          steps: [
            {
              title: "Become",
              hostId: 1,
              command: "sudo x",
              interactive: true,
            },
          ],
        },
      },
    });
    expect(created.body.result.isError).toBe(false);
    const runbook = JSON.parse(created.body.result.content[0].text);
    expect(runbook.steps[0].interactive).toBe(true);
  });
});
