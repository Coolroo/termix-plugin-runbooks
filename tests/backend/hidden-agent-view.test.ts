/**
 * BUG-011: hide output from agents holds in everything an agent reads. Each
 * test builds one runbook twice, with two different hidden values, and
 * compares all that an agent can read: REST and MCP reads of the runbook,
 * its values, the events and the list, and the webhook bodies. The two
 * copies must be the same (the third review of 1.4.6, G1 to G11).
 */
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSIONS,
  execResult,
  runStep,
  setupRunbook,
  shownRun,
  view,
  waitForRun,
  useTestServer,
  type FakeChannel,
  type TestServer,
} from "./helpers";

useTestServer();

const VOLATILE = new Set([
  "id",
  "runbookId",
  "stepId",
  "runId",
  "nextStepId",
  "amendsStepId",
  "openPath",
  "startedAt",
  "finishedAt",
  "endedAt",
  "createdAt",
  "updatedAt",
  "deliveredAt",
  "lastOutputAt",
  "at",
  "next",
  "expiresAt",
  "waitUntil",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stable(value: any): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE.has(key))
      .map(([key, inner]) => [key, stable(inner)]),
  );
}

/** Paths where two values differ. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function diff(a: any, b: any, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return [
      `${path}: ${JSON.stringify(a)?.slice(0, 160)}  !=  ${JSON.stringify(b)?.slice(0, 160)}`,
    ];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) => diff(a[key], b[key], `${path}.${key}`));
}

const ALL_EVENTS = [
  "agent-turn",
  "step-failed",
  "runbook-done",
  "sent",
  "step-done",
  "amended",
];
const URL_ = "https://agents.example.test/hook";

function receiver() {
  const sent: string[] = [];
  return {
    sent,
    fetch: async (_url: string, init?: unknown) => {
      sent.push((init as { body: string }).body);
      return new Response(null, { status: 204 });
    },
  };
}

/** A runbook on a server that delivers webhooks to a recorder. */
async function setup(
  steps: Array<Record<string, unknown>>,
  options: {
    values?: Record<string, string>;
    secrets?: boolean;
    haw?: boolean;
  } = {},
) {
  const hook = receiver();
  const made = await setupRunbook(steps, {
    values: options.values,
    extra: { notify: ALL_EVENTS },
    server: {
      permissions: ADMIN_PERMISSIONS,
      settings: { notifyEnabled: true, notifyUrl: URL_ },
      fetch: hook.fetch,
      secrets: options.secrets,
      haw: options.haw,
    },
  });
  const secret = await made.s.person("POST", "/admin/notify/secret");
  expect(secret.status).toBe(200);
  return { ...made, hook };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Everything the agent can read, plus what the webhook got. */
async function agentSees({ s, token, runbook, hook }: Setup) {
  await s.mock.runScheduled();
  await new Promise((r) => setTimeout(r, 30));
  await s.mock.runScheduled();
  const get = async (path: string) => {
    const reply = await s.agent("GET", path, token);
    return { status: reply.status, body: reply.body };
  };
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const reply = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = reply.body.result;
    return result.isError ? result.content : result.structuredContent;
  };
  return stable({
    runbook: await get(`/runbooks/${runbook.id}`),
    values: await get(`/runbooks/${runbook.id}/values`),
    events: await get(`/events`),
    list: await get(`/runbooks`),
    mcpRunbook: await mcp("get_runbook", { runbookId: runbook.id }),
    mcpEvents: await mcp("list_events", {}),
    mcpList: await mcp("list_runbooks", {}),
    mcpValues: await mcp("get_values", { runbookId: runbook.id }),
    webhooks: hook.sent.map((body) => JSON.parse(body)),
  });
}

/** The paths of the differences that diff found. */
function paths(found: string[]): string[] {
  return found.map((line) => line.slice(0, line.indexOf(": ")));
}

/** Runs `build` with each of two hidden values and compares. */
async function compare(
  label: string,
  build: (secret: string) => Promise<unknown>,
  secrets: [string, string],
) {
  const a = await build(secrets[0]);
  const b = await build(secrets[1]);
  const found = diff(a, b);
  return found;
}

const S17: [string, string] = ["hunter2-swordfish", "zebra-7-lanterns"];

const makeToken = {
  title: "Make a token",
  hostId: 1,
  command: "make-token",
  captures: [{ name: "tok", pattern: "token=(\\S+)" }],
  hideOutputFromAgents: true,
};

/** Drives each command by hand: `cat`/`show` echo their stdin. */
function drive(s: TestServer, outputs: Record<string, string>) {
  s.setChannel((channel: FakeChannel, command: string) => {
    if (command in outputs) {
      setTimeout(() => {
        channel.out(outputs[command]);
        channel.exit(0);
      }, 1);
      return;
    }
    const wait = setInterval(() => {
      if (!channel.ended) return;
      clearInterval(wait);
      channel.out(command.startsWith("wc") ? "n\n" : channel.stdin);
      channel.exit(0);
    }, 2);
  });
}

describe("BUG-011: agents read nothing that depends on a hidden value", () => {
  /**
   * An agent step whose check uses {{tok}}, the value of a hidden step. It
   * is refused when written (400, the same in both runbooks). Written while
   * step 1 still shows its output, and hidden by a person later, it is
   * checked with the values the agent sees.
   */
  async function agentGuess(
    secret: string,
    check: Record<string, unknown>,
    output: string,
  ) {
    const steps = (hidden: boolean) => [
      { ...makeToken, hideOutputFromAgents: hidden },
      { title: "Agent guess", owner: "agent", checks: [check] },
    ];
    const x = await setup(steps(false));
    const refused = await x.s.agent("POST", "/runbooks", x.token, {
      title: "Refused",
      steps: steps(true),
    });
    expect(refused.status).toBe(400);
    const hid = await x.s.person(
      "POST",
      `/steps/${x.runbook.steps[0].id}/hide`,
      {
        hidden: true,
      },
    );
    expect(hid.status, JSON.stringify(hid.body)).toBe(200);
    x.s.setExec(async () => execResult(`token=${secret}\n`));
    await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
    const done = await x.s.agent(
      "POST",
      `/steps/${x.runbook.steps[1].id}/complete`,
      x.token,
      { outcome: "done", output },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return {
      refused: { status: refused.status, body: refused.body },
      sees: await agentSees(x),
    };
  }

  it("G1 agent step check filled with the real hidden value (no person approval)", async () => {
    const found = await compare(
      "G1 agent-step contains {{tok}}",
      (secret) =>
        agentGuess(
          secret,
          { type: "contains", text: "{{tok}}" },
          `my guess: ${S17[0]}`,
        ),
      S17,
    );
    expect(found).toEqual([]);
    // Two runbooks for each of 17 values: it once took 5082 ms of the 5000 ms default.
  }, 20_000);

  it("G1b agent step check, hidden value shorter than 4: label shows it", async () => {
    const found = await compare(
      "G1b short value in agent-step check label",
      (secret) =>
        agentGuess(secret, { type: "contains", text: "{{tok}}" }, "nothing"),
      ["ab1", "zq9"],
    );
    expect(found).toEqual([]);
  });

  it("G1c agent step check as a character-set oracle", async () => {
    const found = await compare(
      "G1c matches ^[{{tok}}]$ on output 'h'",
      (secret) =>
        agentGuess(secret, { type: "matches", pattern: "^[{{tok}}]$" }, "h"),
      S17,
    );
    expect(found).toEqual([]);
  });

  it("G2 agent step output and command with a literal guess are masked (no person approval)", async () => {
    const found = await compare(
      "G2 agent completion output/command literal",
      async (secret) => {
        const x = await setup([
          makeToken,
          { title: "Agent", owner: "agent", command: `echo ${S17[0]}` },
        ]);
        x.s.setExec(async () => execResult(`token=${secret}\n`));
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        await x.s.agent(
          "POST",
          `/steps/${x.runbook.steps[1].id}/complete`,
          x.token,
          {
            outcome: "done",
            output: `candidates:\n${S17[0]}\nfoo-bar-baz\n`,
          },
        );
        return agentSees(x);
      },
      S17,
    );
    expect(found).toEqual([]);
  });

  it("G3 visible step reading stdin from a hidden step's output", async () => {
    const found = await compare(
      "G3 stdin from hidden step",
      async (secret) => {
        const x = await setup([
          {
            title: "Read the key",
            hostId: 1,
            command: "make-key",
            hideOutputFromAgents: true,
          },
          {
            title: "Use it",
            hostId: 1,
            command: "cat",
            stdin: { from: "step", step: 1, stream: "stdout" },
          },
        ]);
        drive(x.s, { "make-key": `key=${secret}\n` });
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        const two = await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
        expect(two.body.status, JSON.stringify(two.body)).toBe("done");
        return agentSees(x);
      },
      S17,
    );
    expect(found).toEqual([]);
  });

  it("G3b visible step reading stdin from a hidden value: run.stdin.bytes", async () => {
    const found = await compare(
      "G3b stdin from hidden value (wc -c prints fixed text)",
      async (secret) => {
        const x = await setup([
          makeToken,
          {
            title: "Count",
            hostId: 1,
            command: "wc -c",
            stdin: { from: "value", name: "tok" },
          },
        ]);
        drive(x.s, { "make-token": `token=${secret}\n` });
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        const two = await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
        expect(two.body.status, JSON.stringify(two.body)).toBe("done");
        return agentSees(x);
      },
      ["hunter2-swordfish", "zebra-7-lantern"],
    );
    expect(found).toEqual([]);
  });

  it("G4 hidden value shorter than 4 characters in a visible command", async () => {
    const found = await compare(
      "G4 short value echoed by visible step",
      async (secret) => {
        const x = await setup([
          makeToken,
          { title: "Print", hostId: 1, command: "echo tok={{tok}}" },
        ]);
        x.s.setExec(async (_h, command) =>
          execResult(
            command === "make-token"
              ? `token=${secret}\n`
              : `${command.slice(5)}\n`,
          ),
        );
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
        return agentSees(x);
      },
      ["ab1", "zq9"],
    );
    // What stays (docs/security.md): a visible step that a person runs
    // prints a value shorter than 4 characters as it is, so only that
    // output differs. The command agents see is built with the value
    // hidden (BUG-011), and no route gives the value without a person.
    expect(paths(found)).toEqual([
      ".runbook.body.steps.1.runs.0.stdout",
      ".mcpRunbook.steps.1.runs.0.stdout",
    ]);
  });

  it("G5 decision whose option id equals a hidden value", async () => {
    const found = await compare(
      "G5 decision output masked",
      async (secret) => {
        const x = await setup([
          {
            ...makeToken,
            captures: [{ name: "env", pattern: "env=(\\S+)" }],
          },
          {
            title: "Where to",
            decision: {
              value: "pick",
              options: [
                { id: "prod-east", label: "East" },
                { id: "prod-west", label: "West" },
              ],
            },
          },
          { title: "Deploy", hostId: 1, command: "deploy {{pick}}" },
        ]);
        x.s.setExec(async () => execResult(`env=${secret}\n`));
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        const shown = await view(x.s, x.runbook.id);
        const chosen = await x.s.person(
          "POST",
          `/steps/${x.runbook.steps[1].id}/decide`,
          { revision: shown.steps[1].revision, chosen: ["prod-east"] },
        );
        expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
        return agentSees(x);
      },
      ["prod-east", "prod-west"],
    );
    expect(found).toEqual([]);
  });

  it("G6 made secret read on stdin, echoed, with a capture of part of it", async () => {
    // The two runs make different random secrets.
    const build = (capture: boolean) => async () => {
      const x = await setup(
        [
          { title: "Make", generate: { name: "db_password" } },
          {
            title: "Use",
            hostId: 1,
            command: "show-it",
            stdin: { from: "secret", name: "db_password" },
            ...(capture
              ? { captures: [{ name: "head", pattern: "^(.{6})" }] }
              : {}),
          },
        ],
        { secrets: true },
      );
      drive(x.s, {});
      const shown = await view(x.s, x.runbook.id);
      const made = await x.s.person(
        "POST",
        `/steps/${x.runbook.steps[0].id}/secret`,
        { revision: shown.steps[0].revision },
      );
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      const two = await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
      expect(two.body.status, JSON.stringify(two.body)).toBe("done");
      return agentSees(x);
    };
    const plain = await compare("G6a secret echoed, no capture", build(false), [
      "x",
      "y",
    ]);
    const parted = await compare(
      "G6b secret echoed, capture of 6 chars",
      build(true),
      ["x", "y"],
    );
    expect({ plain, parted }).toEqual({ plain: [], parted: [] });
  });

  async function typed(
    secret: string,
    options: { capture?: boolean; interactive?: boolean } = {},
  ) {
    const x = await setup([
      {
        title: "Ask",
        hostId: 1,
        command: "read-it",
        ...(options.interactive ? { interactive: true, runIn: "run" } : {}),
        ...(options.capture
          ? { captures: [{ name: "head", pattern: "got (\\S{3})" }] }
          : {}),
      },
    ]);
    let channel: FakeChannel | null = null;
    x.s.setChannel((opened) => (channel = opened));
    const started = await runStep(
      x.s,
      x.runbook.id,
      x.runbook.steps[0].id,
      {},
      "run",
      { wait: false },
    );
    await vi.waitFor(() => expect(channel).not.toBeNull());
    channel!.out("Password: ");
    const sent = await x.s.person("POST", `/runs/${started.body.id}/input`, {
      text: `${secret}\n`,
      hidden: true,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    channel!.out(`\ngot ${secret}\n`);
    channel!.exit(0);
    await waitForRun(x.s, x.runbook.id, started.body.id);
    await shownRun(x.s, x.runbook.id, started.body.id);
    return agentSees(x);
  }

  it("G7 hidden typed input (plain run, interactive, with capture, short)", async () => {
    const same = ["hunter2-sword", "zebra-7-lante"] as [string, string];
    const plain = await compare(
      "G7a typed hidden, echoed",
      (v) => typed(v),
      same,
    );
    const pty = await compare(
      "G7b typed hidden, interactive",
      (v) => typed(v, { interactive: true }),
      same,
    );
    const cap = await compare(
      "G7c typed hidden, capture of 3 chars",
      (v) => typed(v, { capture: true }),
      same,
    );
    const short = await compare(
      "G7d typed hidden shorter than 4",
      (v) => typed(v),
      ["ab1", "zq9"],
    );
    // Typed input shorter than 4 characters is not hidden in the output,
    // for the person either (1.4.6, docs/security.md): only that differs.
    expect({ plain, pty, cap, short: paths(short) }).toEqual({
      plain: [],
      pty: [],
      cap: [],
      short: [
        ".runbook.body.steps.0.runs.0.stdout",
        ".mcpRunbook.steps.0.runs.0.stdout",
      ],
    });
  });

  it("G8 authoring validation messages that name hidden steps and values", async () => {
    const found = await compare(
      "G8 authoring errors",
      async (secret) => {
        const x = await setup([
          makeToken,
          { title: "Two", hostId: 1, command: "two" },
          { title: "Agent", owner: "agent" },
        ]);
        x.s.setExec(async () => execResult(`token=${secret}\n`));
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        const [one, two, three] = x.runbook.steps;
        const calls: Array<[string, string, unknown]> = [
          [
            "PATCH",
            `/steps/${two.id}`,
            { when: { value: "tok", matches: "^h" } },
          ],
          [
            "PATCH",
            `/steps/${two.id}`,
            { when: { step: 1, output: { type: "contains", text: "h" } } },
          ],
          ["PATCH", `/steps/${two.id}`, { when: { step: 3, status: "done" } }],
          [
            "PATCH",
            `/steps/${two.id}`,
            { checks: [{ type: "contains", text: "{{tok}}" }] },
          ],
          [
            "PATCH",
            `/steps/${two.id}`,
            { stdin: { from: "value", name: "tok" } },
          ],
          ["PATCH", `/steps/${one.id}`, { hideOutputFromAgents: false }],
          ["PATCH", `/steps/${one.id}`, { command: "x" }],
          [
            "PATCH",
            `/steps/${three.id}`,
            { when: { value: "tok", equals: secret } },
          ],
          [
            "POST",
            `/runbooks/${x.runbook.id}/steps`,
            {
              steps: [
                { title: "n", hostId: 1, command: "n", when: { value: "tok" } },
              ],
            },
          ],
          [
            "POST",
            `/runbooks/${x.runbook.id}/steps`,
            { position: 1, steps: [{ title: "n", hostId: 1, command: "n" }] },
          ],
          [
            "POST",
            `/runbooks/${x.runbook.id}/steps`,
            {
              steps: [
                {
                  title: "n",
                  hostId: 1,
                  command: "n",
                  stdin: { from: "step", step: 1, stream: "stdout" },
                },
              ],
            },
          ],
          [
            "POST",
            `/steps/${one.id}/amend`,
            {
              kind: "replace",
              reason: "r",
              step: { title: "a", hostId: 1, command: "a" },
            },
          ],
          [
            "POST",
            `/steps/${one.id}/amend`,
            {
              kind: "substep",
              reason: "r",
              step: {
                title: "a",
                hostId: 1,
                command: "a",
                when: { step: 1, output: { type: "contains", text: "x" } },
              },
            },
          ],
          [
            "POST",
            `/steps/${two.id}/amend`,
            {
              kind: "replace",
              reason: "r",
              step: {
                title: "a",
                hostId: 1,
                command: "a",
                when: { value: "tok" },
              },
            },
          ],
          [
            "POST",
            `/runbooks/${x.runbook.id}/reorder`,
            { stepIds: [two.id, one.id, three.id] },
          ],
          ["POST", `/runbooks/${x.runbook.id}/reorder`, { stepIds: [one.id] }],
          ["DELETE", `/steps/${one.id}`, undefined],
          ["POST", `/steps/${three.id}/complete`, { outcome: "done" }],
          [
            "POST",
            `/runbooks`,
            {
              title: "t",
              steps: [
                makeToken,
                {
                  title: "b",
                  hostId: 1,
                  command: "b",
                  when: { value: "tok", matches: "^h" },
                },
              ],
            },
          ],
        ];
        const out: unknown[] = [];
        for (const [method, path, body] of calls) {
          const reply = await x.s.agent(method, path, x.token, body);
          out.push([
            method,
            path.replace(/\d+/g, "N"),
            reply.status,
            reply.status < 300 ? "ok" : stable(reply.body),
          ]);
        }
        // Rewrite the one call that names the secret itself.
        return JSON.parse(JSON.stringify(out).split(secret).join("<SECRET>"));
      },
      S17,
    );
    expect(found).toEqual([]);
  });

  it("G9 hidden output larger than the output limit: truncated", async () => {
    const found = await compare(
      "G9 truncated flag",
      async (size) => {
        const x = await setup([
          { ...makeToken, captures: [] },
          { title: "Two", hostId: 1, command: "two" },
        ]);
        x.s.setExec(async () => execResult("x".repeat(Number(size))));
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        return agentSees(x);
      },
      ["300000", "10"],
    );
    expect(found).toEqual([]);
  });

  it("G10 capture on a hidden step matched or not", async () => {
    const found = await compare(
      "G10 capture presence",
      async (secret) => {
        const x = await setup([
          {
            ...makeToken,
            captures: [{ name: "tok", pattern: "token=(h\\S*)" }],
          },
          { title: "Use", hostId: 1, command: "use {{tok}}" },
        ]);
        x.s.setExec(async () => execResult(`token=${secret}\n`));
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        return agentSees(x);
      },
      S17,
    );
    expect(found).toEqual([]);
  });

  it("G11 control: hidden step with checks and rules only (expected same)", async () => {
    const found = await compare(
      "G11 control",
      async (secret) => {
        const x = await setup([
          { ...makeToken, hideOutputFromAgents: false },
          {
            title: "Print",
            hostId: 1,
            command: "echo t={{tok}}",
            captures: [{ name: "e", pattern: "t=(\\S+)" }],
          },
          {
            title: "Agent",
            owner: "agent",
            when: { step: 2, output: { type: "contains", text: "{{tok}}" } },
          },
        ]);
        x.s.setExec(async (_h, command) =>
          execResult(
            command === "make-token"
              ? `token=${secret}\n`
              : `${command.slice(5)}\n`,
          ),
        );
        await x.s.person("POST", `/steps/${x.runbook.steps[0].id}/hide`, {
          hidden: true,
        });
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
        await x.s.agent(
          "POST",
          `/steps/${x.runbook.steps[2].id}/complete`,
          x.token,
          { outcome: "done", output: "fine" },
        );
        return agentSees(x);
      },
      S17,
    );
    expect(found).toEqual([]);
  });
});

describe("1.4.7: a VM step hidden from agents", () => {
  it("G12 its details, address, id and values, and a later step that uses them", async () => {
    const found = await compare(
      "G12 hidden VM step",
      async (secret) => {
        const x = await setup(
          [
            {
              title: "Start the VM",
              vm: {
                host: 1,
                name: "build-1",
                action: "start",
                waitFor: null,
                value: "build",
              },
              hideOutputFromAgents: true,
            },
            { title: "Use it", hostId: 1, command: "ssh {{build.ip}} true" },
            {
              title: "Agent",
              owner: "agent",
              when: { step: 1, status: "done" },
            },
          ],
          { haw: true },
        );
        x.s.haw!.seed(1, {
          name: "build-1",
          id: `vm-${secret}`,
          addresses: [secret],
        });
        x.s.setExec(async (_h, command) => execResult(`${command}\n`));
        const shown = await view(x.s, x.runbook.id);
        const pressed = await x.s.person(
          "POST",
          `/steps/${x.runbook.steps[0].id}/vm`,
          { revision: shown.steps[0].revision },
        );
        expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
        const run = await waitForRun(x.s, x.runbook.id, pressed.body.run.id);
        expect(run.status, run.error).toBe("done");
        expect(run.stdout).toContain(secret);
        const two = await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
        expect(two.body.stdout).toBe(`ssh ${secret} true\n`);
        await x.s.agent(
          "POST",
          `/steps/${x.runbook.steps[2].id}/complete`,
          x.token,
          { outcome: "done", output: "fine" },
        );
        return agentSees(x);
      },
      ["198.51.100.7", "203.0.113.199"],
    );
    expect(found).toEqual([]);
  });
});

/** Output on which `^(a+)+$` runs past the capture time limit. */
const SLOW = "a".repeat(40) + "!\n";

describe("BUG-014: a run's error depends on no hidden output", () => {
  it("P1 a capture pattern that did not finish on a hidden step's output", async () => {
    const found = await compare(
      "P1 slow capture on hidden output",
      async (output) => {
        const x = await setup([
          {
            ...makeToken,
            captures: [{ name: "tok", pattern: "^(a+)+$" }],
          },
          { title: "Two", hostId: 1, command: "two" },
        ]);
        x.s.setExec(async () => execResult(output));
        const one = await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        expect(one.body.status, JSON.stringify(one.body)).toBe("done");
        return agentSees(x);
      },
      [SLOW, "token=quick\n"],
    );
    expect(found).toEqual([]);
  });

  it("P2 which secret capture of a hidden step found no match", async () => {
    const found = await compare(
      "P2 secret capture no match on hidden output",
      async (output) => {
        const x = await setup(
          [
            {
              ...makeToken,
              captures: [],
              secretCaptures: [
                { name: "first", pattern: "a=(\\S+)" },
                { name: "second", pattern: "b=(\\S+)" },
              ],
            },
          ],
          { secrets: true },
        );
        x.s.setExec(async () => execResult(output));
        const one = await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        expect(one.body.status, JSON.stringify(one.body)).toBe("failed");
        return agentSees(x);
      },
      ["a=one-secret\n", "b=two-secret\n"],
    );
    expect(found).toEqual([]);
  });

  it("P3 capture and secret names that equal a hidden value are not masked", async () => {
    const found = await compare(
      "P3 names in a visible step's error",
      async (secret) => {
        const x = await setup(
          [
            makeToken,
            {
              title: "Slow",
              hostId: 1,
              command: "slow",
              captures: [{ name: "hunter2fish", pattern: "^(a+)+$" }],
            },
            {
              title: "No secret",
              hostId: 1,
              command: "none",
              secretCaptures: [{ name: "hunter2fish", pattern: "s=(\\S+)" }],
            },
          ],
          { secrets: true },
        );
        x.s.setExec(async (_host, command) =>
          execResult(command === "make-token" ? `token=${secret}\n` : SLOW),
        );
        for (const step of x.runbook.steps) {
          await runStep(x.s, x.runbook.id, step.id);
        }
        const seen = (await view(x.s, x.runbook.id)).steps;
        expect(seen[1].runs[0].error).toBe(
          'capture "hunter2fish" did not finish',
        );
        expect(seen[2].runs[0].error).toBe("secret hunter2fish: no match");
        return agentSees(x);
      },
      ["hunter2fish", "zebra7lamps"],
    );
    expect(found).toEqual([]);
  });
});
