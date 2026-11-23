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
import { HIDDEN } from "../../src/backend/agents/agent-mask";
import http from "node:http";
import net from "node:net";
import fixtures from "./fixtures/event-readers.json";

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
  // 1.4.10: when a running delay ends.
  "plannedEndAt",
  // 1.4.10, phase 2: when a wait's next attempt starts and its limit ends.
  "nextAttemptAt",
  "nextAt",
  "endsBy",
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

describe("1.4.10: sequence steps hide each item as a run is hidden", () => {
  /** Answers each command; a held one when `stop` names it. */
  const sequenceRun = async (
    secret: string,
    options: {
      hidden: boolean;
      failSecond?: boolean;
      continueAfter?: boolean;
    },
  ) => {
    const x = await setup([
      {
        title: "Token in a sequence",
        hostId: 1,
        hideOutputFromAgents: options.hidden,
        workdir: "/srv/app",
        sequence: [
          {
            type: "run",
            label: "Make",
            command: "make-token",
            captures: [{ name: "tok", pattern: "token=(\\S+)" }],
            checks: [
              { type: "value", name: "tok", matches: "^[a-z]" },
              { type: "contains", text: "token=" },
            ],
          },
          { type: "delay", seconds: 600, reason: "settle" },
          {
            type: "run",
            label: "Use",
            command: "use {{tok}}",
            checks: [{ type: "notContains", text: "error" }],
          },
          { type: "run", command: "report", onFail: "continue" },
        ],
      },
      { title: "Later", hostId: 1, command: "echo later={{tok}}" },
    ]);
    let fail = options.failSecond ?? false;
    x.s.setExec(async (_h, command) => {
      if (command.endsWith("make-token")) {
        return execResult(`token=${secret}\nsize ${secret.length}\n`);
      }
      if (command.includes("use ")) {
        return fail
          ? execResult(`error near ${secret}\n`, {
              stderr: `bad ${secret}`,
              code: 3,
            })
          : execResult(`used ${command.slice(-secret.length)}\n`);
      }
      if (command.endsWith("report")) {
        return execResult(`report ${secret}\n`, { code: 1 });
      }
      return execResult(`${command}\n`);
    });
    const shown = await view(x.s, x.runbook.id);
    const step = shown.steps[0];
    const started = await x.s.person("POST", `/steps/${step.id}/run`, {
      revision: step.revision,
      commandHash: step.commandHash,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await vi.waitFor(
      async () => {
        const run = await shownRun(x.s, x.runbook.id, started.body.id);
        if (run.items[1].status !== "running") throw new Error("not yet");
      },
      { timeout: 3000, interval: 5 },
    );
    // While the delay runs: what an agent sees of a running sequence.
    const during = await agentSees(x);
    await x.s.person("POST", `/steps/${step.id}/skip-delay`);
    await waitForRun(x.s, x.runbook.id, started.body.id);
    if (options.continueAfter) {
      fail = false;
      const again = await view(x.s, x.runbook.id);
      const went = await x.s.person("POST", `/steps/${step.id}/continue`, {
        revision: again.steps[0].revision,
        commandHash: again.steps[0].commandHash,
      });
      expect(went.status, JSON.stringify(went.body)).toBe(200);
      await waitForRun(x.s, x.runbook.id, went.body.id);
    }
    await runStep(x.s, x.runbook.id, x.runbook.steps[1].id, {
      outOfOrder: true,
      confirmRepeat: true,
    });
    return { during, after: await agentSees(x) };
  };

  it("G13 a hidden sequence: item output, captures, checks, commands, errors", async () => {
    const found = await compare(
      "G13 hidden sequence",
      (secret) => sequenceRun(secret, { hidden: true }),
      S17,
    );
    expect(found).toEqual([]);
  }, 20_000);

  it("G13b a hidden sequence that fails at a run item, then continues", async () => {
    const found = await compare(
      "G13b hidden sequence, failed then continued",
      (secret) =>
        sequenceRun(secret, {
          hidden: true,
          failSecond: true,
          continueAfter: true,
        }),
      S17,
    );
    expect(found).toEqual([]);
  }, 20_000);

  it("G13c a hidden sequence with values shorter than 4 characters", async () => {
    const found = await compare(
      "G13c short values",
      (secret) => sequenceRun(secret, { hidden: true, failSecond: true }),
      ["ab1", "zq9"],
    );
    expect(found).toEqual([]);
  }, 20_000);

  it("G14 a visible sequence whose items read a hidden step's value", async () => {
    const found = await compare(
      "G14 visible sequence reads a hidden value",
      async (secret) => {
        const x = await setup([
          makeToken,
          {
            title: "Use it",
            hostId: 1,
            sequence: [
              {
                type: "run",
                command: "show {{tok}}",
                captures: [{ name: "echoed", pattern: "shown=(\\S+)" }],
                checks: [{ type: "contains", text: "{{tok}}" }],
              },
              { type: "run", command: "again {{echoed}}" },
            ],
          },
        ]);
        x.s.setExec(async (_h, command) =>
          execResult(
            command === "make-token"
              ? `token=${secret}\n`
              : `shown=${command.split(" ")[1]}\n`,
          ),
        );
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        const two = await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
        expect(two.body.status, JSON.stringify(two.body)).toBe("done");
        return agentSees(x);
      },
      S17,
    );
    expect(found).toEqual([]);
  }, 20_000);

  it("G14b a hidden sequence item's output that passes the output limit", async () => {
    const found = await compare(
      "G14b truncated item",
      async (size) => {
        const x = await setup([
          {
            title: "Big",
            hostId: 1,
            hideOutputFromAgents: true,
            sequence: [
              { type: "run", command: "big" },
              { type: "run", command: "two" },
            ],
          },
        ]);
        x.s.setExec(async (_h, command) =>
          execResult(command === "big" ? "x".repeat(Number(size)) : "ok\n"),
        );
        await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
        return agentSees(x);
      },
      ["300000", "10"],
    );
    expect(found).toEqual([]);
  });
});

describe("1.4.10 phase 2: a wait's attempts are hidden as its item is", () => {
  /**
   * A hidden sequence: a wait whose attempts print the hidden value, with
   * a stopIf check and a capture from the attempt that passes; a run item
   * with retry whose failed attempts print it; a visible step after it
   * that reads the capture. Try now moves the wait on; an agent reads all
   * while the wait waits between two attempts, and after.
   */
  const waitRun = async (
    secret: string,
    options: { hidden: boolean; stopAt?: number; later?: boolean },
  ) => {
    const x = await setup([
      {
        title: "Wait for the token",
        hostId: 1,
        hideOutputFromAgents: options.hidden,
        sequence: [
          {
            type: "wait",
            label: "Ready",
            command: "status",
            checks: [{ type: "contains", text: "ready" }],
            stopIf: [{ type: "contains", text: "FAILED" }],
            captures: [{ name: "tok", pattern: "token=(\\S+)" }],
            within: 600,
            every: 300,
          },
          {
            type: "run",
            command: "use {{tok}}",
            retry: { attempts: 3, every: 300 },
          },
        ],
      },
      { title: "Later", hostId: 1, command: "echo later={{tok}}" },
    ]);
    let status = 0;
    let use = 0;
    x.s.setExec(async (_h, command) => {
      if (command === "status") {
        status += 1;
        if (status === options.stopAt) {
          return execResult(`FAILED near ${secret}\n`, { code: 4 });
        }
        return status < 3
          ? execResult(`pending ${secret}\n`, {
              stderr: `slow ${secret}`,
              code: status === 1 ? 1 : 0,
            })
          : execResult(`ready token=${secret}\n`);
      }
      if (command.startsWith("use ")) {
        use += 1;
        return use === 1
          ? execResult(`error near ${command.slice(4)}\n`, { code: 2 })
          : execResult(`used ${command.slice(4)}\n`);
      }
      return execResult(`${command}\n`);
    });
    const shown = await view(x.s, x.runbook.id);
    const step = shown.steps[0];
    const started = await x.s.person("POST", `/steps/${step.id}/run`, {
      revision: step.revision,
      commandHash: step.commandHash,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const waiting = async (position: number, count: number) =>
      vi.waitFor(
        async () => {
          const run = await shownRun(x.s, x.runbook.id, started.body.id);
          const item = run.items[position - 1];
          if (run.status !== "running") return run;
          if (!item.nextAttemptAt || item.attempts.length !== count) {
            throw new Error("not yet");
          }
          return run;
        },
        { timeout: 3000, interval: 5 },
      );
    await waiting(1, 1);
    // While the wait waits: what an agent sees of it.
    const during = await agentSees(x);
    const tryNow = () => x.s.person("POST", `/steps/${step.id}/try-now`);
    expect((await tryNow()).status).toBe(200);
    const second = await waiting(1, 2);
    if (second.status === "running") {
      expect((await tryNow()).status).toBe(200);
      await waiting(2, 1);
      expect((await tryNow()).status).toBe(200);
    }
    const ended = await waitForRun(x.s, x.runbook.id, started.body.id);
    if (!options.stopAt) {
      expect(ended.status, JSON.stringify(ended.items)).toBe("done");
      if (options.later !== false) {
        await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
      }
    } else {
      expect(ended.status).toBe("failed");
    }
    return { during, after: await agentSees(x) };
  };

  it("G15 a hidden wait and a retried run item: attempt output, errors, sizes, checks, captures", async () => {
    const found = await compare(
      "G15 hidden attempts",
      (secret) => waitRun(secret, { hidden: true }),
      S17,
    );
    expect(found).toEqual([]);
  }, 20_000);

  it("G15b a hidden wait that a stopIf check ends", async () => {
    const found = await compare(
      "G15b hidden stopIf",
      (secret) => waitRun(secret, { hidden: true, stopAt: 2 }),
      S17,
    );
    expect(found).toEqual([]);
  }, 20_000);

  it("G15c a hidden wait with values shorter than 4 characters", async () => {
    const found = await compare(
      "G15c short values",
      // The later step echoes the value: a visible step shows a value
      // shorter than 4 characters (G4), so it does not run here.
      (secret) => waitRun(secret, { hidden: true, later: false }),
      ["ab1", "zq9"],
    );
    expect(found, found.join("\n")).toEqual([]);
  }, 20_000);

  it("G15 control: the same visible sequence differs, so the test can see a leak", async () => {
    const found = await compare(
      "G15 control",
      (secret) => waitRun(secret, { hidden: false }),
      S17,
    );
    expect(paths(found)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/items\.0\.attempts\.0\.stdout$/),
        expect.stringMatching(/items\.0\.attempts\.1\.stderr$/),
        expect.stringMatching(/items\.1\.attempts\.0\.stdout$/),
      ]),
    );
  }, 20_000);

  it("G15 shows attempt counts, times, exit codes and why on a hidden step", async () => {
    const { after } = (await waitRun(S17[0], { hidden: true })) as {
      after: { runbook: { body: { steps: Array<{ runs: unknown[] }> } } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (after.runbook.body.steps[0].runs[0] as any).items;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = (item: any) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      item.attempts.map((a: any) => [
        a.attempt,
        a.exitCode,
        a.why,
        a.stdout,
        a.error,
      ]);
    expect(shape(items[0])).toEqual([
      [1, 1, "exit", HIDDEN, HIDDEN],
      [2, 0, "check", HIDDEN, HIDDEN],
      [3, 0, null, HIDDEN, null],
    ]);
    expect(shape(items[1])).toEqual([
      [1, 2, "exit", HIDDEN, HIDDEN],
      [2, 0, null, HIDDEN, null],
    ]);
    expect(items[0].captured).toEqual({ tok: HIDDEN });
    expect(items[0].maxAttempts).toBe(500);
  }, 20_000);
});

describe("1.4.10 phase 3: the wait events are hidden as their item is", () => {
  /**
   * A hidden sequence of events whose outputs hold the hidden value: a
   * container's health log, a log line, an HTTP body over the SSH channel,
   * a job's journal, and a container that exited with it in its error. Its
   * state words (result) are the same for both values: they are fixed
   * words, never text from the host.
   */
  const eventsRun = async (secret: string, options: { hidden: boolean }) => {
    const x = await setup([
      {
        title: "Deploy and wait",
        hostId: 1,
        hideOutputFromAgents: options.hidden,
        sequence: [
          { type: "container", name: "web", state: "healthy", within: 60 },
          { type: "log", container: "web", pattern: "ready", within: 60 },
          {
            type: "http",
            url: "http://127.0.0.1:8080/health",
            contains: "ok",
            within: 60,
          },
          { type: "job", command: "backup", within: 60 },
          {
            type: "container",
            name: "web2",
            state: "running",
            within: 60,
          },
        ],
      },
    ]);
    const healthy = fixtures.dockerInspect.healthy.stdout.replace(
      /"Output":""/,
      `"Output":"probe ${secret}"`,
    );
    const exited = fixtures.dockerInspect["exited-3"].stdout.replace(
      '"Error":""',
      `"Error":"${secret}"`,
    );
    const at = Math.floor(Date.now() / 1000) + 5;
    x.s.setExec(async (_h, command) => {
      if (
        command.includes("-- 'web'") &&
        command.startsWith("docker container")
      ) {
        return execResult(healthy);
      }
      if (command.startsWith("docker container")) return execResult(exited);
      if (command.startsWith("docker logs")) {
        return execResult(
          `2099-01-01T00:00:00.000000000Z ready token=${secret}\n`,
        );
      }
      if (command.startsWith("sudo -n systemd-run")) {
        return execResult("", {
          stderr: `Running as unit: x.service; ${secret}\n`,
        });
      }
      if (command.startsWith("systemctl show")) {
        return execResult(
          fixtures.systemctlShow["t038-ok"].stdout.replace(/@\d+/, `@${at}`),
        );
      }
      if (command.startsWith("sudo -n journalctl")) {
        return execResult(`{"MESSAGE":"done ${secret}","__CURSOR":"c1"}\n`, {
          stderr: `warn ${secret}`,
        });
      }
      return execResult("");
    });
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(`ok ${secret}\n`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as net.AddressInfo).port;
    x.s.setForward(() => net.connect(port, "127.0.0.1"));
    try {
      const shown = await view(x.s, x.runbook.id);
      const step = shown.steps[0];
      const started = await x.s.person("POST", `/steps/${step.id}/run`, {
        revision: step.revision,
        commandHash: step.commandHash,
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const ended = await waitForRun(x.s, x.runbook.id, started.body.id);
      expect(ended.status, JSON.stringify(ended.items)).toBe("failed");
      expect(
        ended.items.map((item: { status: string }) => item.status),
      ).toEqual(["passed", "passed", "passed", "passed", "failed"]);
      return { after: await agentSees(x) };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  it("G16 a hidden sequence of events: output, errors and the HTTP body; the words stay", async () => {
    const found = await compare(
      "G16 hidden events",
      (secret) => eventsRun(secret, { hidden: true }),
      S17,
    );
    expect(found, found.join("\n")).toEqual([]);
    const { after } = (await eventsRun(S17[0], { hidden: true })) as {
      after: { runbook: { body: { steps: Array<{ runs: unknown[] }> } } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (after.runbook.body.steps[0].runs[0] as any).items;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(items.map((item: any) => item.result)).toEqual([
      "healthy",
      "matched",
      "HTTP 200",
      "finished (success)",
      "exited (3)",
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(items.map((item: any) => item.stdout)).toEqual(
      Array(5).fill(HIDDEN),
    );
    expect(items[4].error).toBe(HIDDEN);
    // What each item checks stays visible: the fixed command.
    expect(items[0].command).toContain("docker container inspect");
  }, 20_000);

  it("G16 control: the same visible sequence differs, so the test can see a leak", async () => {
    const found = await compare(
      "G16 control",
      (secret) => eventsRun(secret, { hidden: false }),
      S17,
    );
    expect(paths(found)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/items\.0\.attempts\.0\.stdout$/),
        expect.stringMatching(/items\.1\.stdout$/),
        expect.stringMatching(/items\.2\.stdout$/),
        expect.stringMatching(/items\.3\.stdout$/),
        expect.stringMatching(/items\.3\.attempts\.0\.stderr$/),
        expect.stringMatching(/items\.4\.attempts\.0\.stdout$/),
      ]),
    );
  }, 20_000);
});

describe("BUG-019: a hidden Send to terminal step", () => {
  it("T1 Mark failed with read text or with none: outputSource", async () => {
    const found = await compare(
      "T1 failed paste on a hidden terminal step",
      async (pasted) => {
        const x = await setup([
          {
            title: "Look",
            hostId: 1,
            command: "look",
            hideOutputFromAgents: true,
          },
          { title: "Two", hostId: 1, command: "two" },
        ]);
        const sent = await runStep(
          x.s,
          x.runbook.id,
          x.runbook.steps[0].id,
          {},
          "terminal",
        );
        expect(sent.status).toBe(200);
        const failed = await x.s.person(
          "POST",
          `/runs/${sent.body.id}/complete`,
          {
            pastedOutput: pasted,
            outcome: "failed",
            outputSource: "captured",
          },
        );
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);
        return agentSees(x);
      },
      ["", "Permission denied"],
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

  it("G12b its state, and the steps that read it, in visible words (BUG-016)", async () => {
    const words = "the VM is running, paused or off";
    const found = await compare(
      "G12b hidden VM state",
      async (state) => {
        const x = await setup(
          [
            {
              title: "Read the VM",
              vm: { host: 1, name: "build-1", action: "show", value: "build" },
              hideOutputFromAgents: true,
            },
            { title: "Words", hostId: 1, command: "echo words" },
            {
              title: "Print the state",
              hostId: 1,
              command: "echo state={{build.state}}",
            },
            {
              title: "Read it back",
              hostId: 1,
              command: "cat",
              stdin: { from: "step", step: 3, stream: "stdout" },
              captures: [{ name: "s", pattern: "state=(\\w+)" }],
            },
            { title: "Use it", hostId: 1, command: "echo again {{s}}" },
            {
              title: "Check it",
              hostId: 1,
              command: "echo checked",
              checks: [{ type: "matches", pattern: "{{build.state}}|checked" }],
            },
            {
              title: "Agent",
              owner: "agent",
              when: { step: 1, status: "done" },
            },
          ],
          { haw: true },
        );
        x.s.haw!.seed(1, { name: "build-1", state, addresses: ["192.0.2.9"] });
        drive(x.s, {
          "echo words": `${words}\n`,
          [`echo state=${state}`]: `state=${state}\n`,
          [`echo again ${state}`]: `again ${state}\n`,
          "echo checked": "checked\n",
        });
        const shown = await view(x.s, x.runbook.id);
        const pressed = await x.s.person(
          "POST",
          `/steps/${x.runbook.steps[0].id}/vm`,
          { revision: shown.steps[0].revision },
        );
        expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
        const run = await waitForRun(x.s, x.runbook.id, pressed.body.run.id);
        expect(run.status, run.error).toBe("done");
        expect(run.captured["build.state"]).toBe(state);
        for (const step of x.runbook.steps.slice(1, 6)) {
          const ran = await runStep(x.s, x.runbook.id, step.id);
          expect(ran.body.status, JSON.stringify(ran.body)).toBe("done");
        }
        await x.s.agent(
          "POST",
          `/steps/${x.runbook.steps[6].id}/complete`,
          x.token,
          { outcome: "done", output: "fine" },
        );
        const seen = await x.s.agent(
          "GET",
          `/runbooks/${x.runbook.id}`,
          x.token,
        );
        // Visible words stay as they are: "running" is not masked.
        expect(seen.body.steps[1].runs[0].stdout).toBe(`${words}\n`);
        // Steps that read the state, or a value made from it, are hidden.
        for (const index of [2, 3, 4, 5]) {
          expect(seen.body.steps[index].runs[0].stdout).toBe(HIDDEN);
        }
        return agentSees(x);
      },
      ["running", "paused"],
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
