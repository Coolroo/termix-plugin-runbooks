/**
 * BUG-022: the security review of 1.4.10 (sequences, waits and wait
 * events), as acceptance tests. R1 to R8 are the reviewer's tests, each
 * written to fail while its finding held; they assert the safe behaviour.
 * Two changed with the fix, as the report says: R6 (the owner chose "must
 * match a pattern", 2026-11-23, so the reviewer's runbook is refused when
 * written, and the run-time half is tested with the pattern in place) and
 * R7 (the rule lets a person with connect access to the host press Try
 * now, so bob's access is taken away for the refusal). The rest test each
 * fix further.
 *
 * The harness is that of hidden-agent-view.test.ts: build one runbook
 * twice, with two hidden values, and compare all that an agent can read.
 */
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSIONS,
  attemptOutput,
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
import fixtures from "./fixtures/event-readers.json";
import { logPatternProblem } from "../../src/backend/runbooks/event-parse";
import {
  LOG_MATCH_TIME_LIMIT_MS,
  matchLog,
} from "../../src/backend/events/readers";
import { newMemory, probe } from "../../src/backend/events/probes";
import { OUTPUT_LIMITS } from "../../src/backend/running/output-limits";

const testServer = useTestServer();

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
  "plannedEndAt",
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
    fetch: async (url: string, init?: unknown) => {
      // An http item from Termix goes through the same fetch: not a webhook.
      // It answers with the URL it got, as a server that echoes it would.
      if (url !== URL_) return new Response(url, { status: 200 });
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
  const read = await get(`/runbooks/${runbook.id}`);
  // M2: each attempt's output, read on its own, by REST and MCP.
  const attemptReads: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (value: any): any[] => (Array.isArray(value) ? value : []);
  for (const [si, step] of list(read.body.steps).entries()) {
    for (const [ri, run] of list(step.runs).entries()) {
      for (const [ii, item] of list(run.items).entries()) {
        for (const [ai, attempt] of list(item.attempts).entries()) {
          const at = `steps.${si}.runs.${ri}.items.${ii}.attempts.${ai}`;
          attemptReads[`rest.${at}`] = await get(
            `/runbooks/${runbook.id}/runs/${run.id}/items/${item.position}/attempts/${attempt.attempt}`,
          );
          attemptReads[`mcp.${at}`] = await mcp("get_attempt", {
            runbookId: runbook.id,
            runId: run.id,
            item: item.position,
            attempt: attempt.attempt,
          });
        }
      }
    }
  }
  return stable({
    runbook: read,
    attemptReads,
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

/** Runs `build` with each of two hidden values and compares. */
async function compare(
  build: (secret: string) => Promise<unknown>,
  secrets: [string, string],
) {
  const a = await build(secrets[0]);
  const b = await build(secrets[1]);
  return diff(a, b);
}

/** The fields every event item has, for probe(). */
const base = {
  label: null,
  onFail: "stop" as const,
  within: 60,
  attempts: null,
  timeoutMs: null,
  every: 5,
  backoff: "fixed" as const,
  factor: 2,
  maxDelay: 300,
  jitter: "none" as const,
};

/** One http check from Termix with a recording fetch. */
async function httpProbe(
  url: string,
  lookup?: (host: string) => Promise<Array<{ address: string }>>,
) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const outcome = await probe({
    client: { exec: () => undefined },
    item: {
      type: "http",
      url,
      status: 200,
      contains: null,
      servername: null,
      ...base,
    },
    workdir: null,
    since: 0,
    runId: 1,
    position: 1,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    memory: newMemory(),
    cas: async () => [],
    fetch: async (u, init) => {
      calls.push({ url: u, init });
      return new Response(null, { status: 200 });
    },
    ...(lookup ? { lookup } : {}),
  });
  return { outcome, calls };
}

/** A job's checks: started, ended with success at `at`. */
function jobAnswers(at: number, journal = "") {
  return async (_h: unknown, command: string) => {
    if (command.startsWith("sudo -n systemd-run")) return execResult("");
    if (command.startsWith("systemctl show")) {
      return execResult(
        fixtures.systemctlShow["t038-ok"].stdout.replace(/@\d+/, `@${at}`),
      );
    }
    if (command.startsWith("sudo -n journalctl")) {
      return execResult(journal);
    }
    return execResult("");
  };
}

// --- H1 ---------------------------------------------------------------------

describe("R1 log pattern ReDoS guard", () => {
  it("refuses ((a+))+$, or a match stays fast", () => {
    const pattern = "((a+))+$";
    const problem = logPatternProblem(pattern, "pattern");
    const re = new RegExp(pattern);
    const t0 = Date.now();
    matchLog(["a".repeat(23) + "!"], re, null, 0);
    const ms23 = Date.now() - t0;
    const t1 = Date.now();
    matchLog(["a".repeat(25) + "!"], re, null, 0);
    const ms25 = Date.now() - t1;
    console.log(
      `R1: guard=${problem}; 24 chars ${ms23} ms; 26 chars ${ms25} ms`,
    );
    // Safe: the guard refuses it, or the match is bounded.
    expect(problem !== null || ms25 < 200).toBe(true);
  }, 60_000);

  it("refuses (a|a)+$ (alternation, no inner repeat)", () => {
    expect(logPatternProblem("(a|a)+$", "pattern")).not.toBeNull();
  });

  it("stops a pattern that backtracks on a long line within its time limit: the item fails, Termix goes on", () => {
    for (const pattern of ["((a+))+$", "(a|a)+$", "(a|aa)+$", "(\\w+\\s?)+$"]) {
      const line = "a".repeat(4000) + "!";
      const t0 = Date.now();
      const reading = matchLog([line], new RegExp(pattern), null, 0);
      const ms = Date.now() - t0;
      expect(ms, pattern).toBeLessThan(1000);
      expect(reading).toMatchObject({
        verdict: "fail",
        result: "pattern too slow",
      });
      expect(reading.error).toContain(`${LOG_MATCH_TIME_LIMIT_MS} ms`);
      // A failPattern that backtracks stops the same way.
      const failing = matchLog([line], /ready/, new RegExp(pattern), 0);
      expect(failing.result).toBe("pattern too slow");
    }
    // Ordinary patterns still read lines in order.
    expect(matchLog(["x", "ready now"], /ready/, /error/, 0)).toEqual({
      verdict: "pass",
      result: "matched",
    });
    expect(matchLog(["error!", "ready"], /ready/, /error/, 0).result).toBe(
      "failPattern matched",
    );
  });

  it("refuses nested repeats and repeated alternatives when written", async () => {
    for (const pattern of ["((a+))+$", "(a|a)+$", "(?:x|xy)*z", "((ab)*)+"]) {
      expect(logPatternProblem(pattern, "pattern"), pattern).not.toBeNull();
    }
    for (const pattern of [
      "listening on",
      "ready in \\d+ ms",
      "(GET|POST) /health",
    ]) {
      expect(logPatternProblem(pattern, "pattern"), pattern).toBeNull();
    }
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Log",
      steps: [
        {
          title: "Wait",
          hostId: 1,
          sequence: [
            {
              type: "log",
              unit: "app.service",
              pattern: "(a|a)+$",
              within: 60,
            },
          ],
        },
      ],
    });
    expect(made.status).toBe(400);
    expect(made.body.error).toContain("alternatives");
  });
});

// --- M4 ---------------------------------------------------------------------

describe("R2 http from Termix: IPv4-mapped loopback", () => {
  for (const url of [
    "https://[::ffff:127.0.0.1]:8443/",
    "https://[::ffff:169.254.169.254]/",
    "https://[0:0:0:0:0:ffff:7f00:1]/",
  ]) {
    it(`refuses ${url}`, async () => {
      const { outcome, calls } = await httpProbe(url);
      console.log(`R2 ${url}: result=${outcome.result}`);
      expect(calls).toEqual([]);
    });
  }

  it("refuses every spelling of loopback, link-local, unspecified and NAT64 forms of them", async () => {
    for (const url of [
      "https://[::ffff:7f00:1]/",
      "https://[::FFFF:127.0.0.1]/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://[64:ff9b::7f00:1]/",
      "https://[64:ff9b::127.0.0.1]/",
      "https://[::127.0.0.1]/",
      "https://[::ffff:0:7f00:1]/",
      "https://[fe80::1]/",
      "https://[::]/",
      "https://0.0.0.0/",
      "https://0x0/",
      "https://169.254.169.254/",
      "https://2852039166/",
    ]) {
      const { outcome, calls } = await httpProbe(url);
      expect(calls, url).toEqual([]);
      expect(outcome, url).toMatchObject({
        verdict: "fail",
        result: "address refused",
      });
    }
    // 127.0.0.1 in decimal, octal or hex is the host's own loopback, as
    // 127.0.0.1 is: the check goes through the SSH connection, never from
    // Termix (this fake connection has no channels, so it waits).
    for (const url of [
      "https://2130706433/",
      "https://0177.0.0.1/",
      "https://0x7f.1/",
      "https://127.1/",
    ]) {
      const { outcome, calls } = await httpProbe(url);
      expect(calls, url).toEqual([]);
      expect(outcome.verdict, url).toBe("wait");
    }
  });

  it("refuses a name that resolves to any of them, and Termix's own address", async () => {
    const own = Object.values(os.networkInterfaces())
      .flat()
      .find((each) => each && !each.internal)?.address;
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
      "0.0.0.0",
      "::",
      "fe80::1",
      ...(own ? [own] : []),
    ]) {
      const { outcome, calls } = await httpProbe(
        "https://looks-public.example/",
        async () => [{ address: "192.0.2.20" }, { address }],
      );
      expect(calls, address).toEqual([]);
      expect(outcome.result, address).toBe("address refused");
    }
  });

  it("gives allowPrivateHosts only to a private address that is not loopback", async () => {
    const privateOne = await httpProbe("https://10.255.0.10/");
    expect(privateOne.calls[0].init.allowPrivateHosts).toEqual(["10.255.0.10"]);
    const tailnet = await httpProbe("https://svc.example/", async () => [
      { address: "100.64.70.10" },
    ]);
    expect(tailnet.calls[0].init.allowPrivateHosts).toEqual(["svc.example"]);
    const publicOne = await httpProbe("https://svc.example/", async () => [
      { address: "192.0.2.20" },
    ]);
    expect(publicOne.calls[0].init.allowPrivateHosts).toBeUndefined();
  });

  it("refuses such an address in a URL when the step is written", async () => {
    const s = await testServer();
    const token = await s.makeToken();
    for (const url of [
      "https://[::ffff:127.0.0.1]:8443/",
      "https://0.0.0.0/",
      "https://169.254.169.254/latest",
    ]) {
      const made = await s.agent("POST", "/runbooks", token, {
        title: "Http",
        steps: [
          {
            title: "Wait",
            hostId: 1,
            sequence: [{ type: "http", url, within: 60 }],
          },
        ],
      });
      expect(made.status, url).toBe(400);
      expect(made.body.error).toContain("write 127.0.0.1 or localhost");
    }
  });
});

// --- M1 ---------------------------------------------------------------------

describe("R3 BUG-016 through an event item: a job reads a hidden VM state", () => {
  const eventRun = async (state: string, kind: "job" | "run" | "http") => {
    const x = await setup(
      [
        {
          title: "Read the VM",
          vm: { host: 1, name: "build-1", action: "show", value: "build" },
          hideOutputFromAgents: true,
        },
        {
          title: "Report",
          hostId: 1,
          sequence:
            kind === "job"
              ? [
                  {
                    type: "job",
                    command: "echo state={{build.state}}",
                    within: 60,
                  },
                ]
              : kind === "http"
                ? [
                    {
                      type: "http",
                      url: "https://192.0.2.10/{{build.state}}",
                      status: 200,
                      within: 60,
                    },
                  ]
                : [{ type: "run", command: "echo state={{build.state}}" }],
        },
      ],
      { haw: true },
    );
    x.s.haw!.seed(1, { name: "build-1", state, addresses: ["192.0.2.9"] });
    const at = Math.floor(Date.now() / 1000) + 5;
    x.s.setExec(async (_h, command) => {
      if (command.startsWith("sudo -n systemd-run")) return execResult("");
      if (command.startsWith("systemctl show")) {
        return execResult(
          fixtures.systemctlShow["t038-ok"].stdout.replace(/@\d+/, `@${at}`),
        );
      }
      if (command.startsWith("sudo -n journalctl")) {
        return execResult(`{"MESSAGE":"state=${state}","__CURSOR":"c1"}\n`);
      }
      if (command.startsWith("echo state=")) {
        return execResult(`state=${state}\n`);
      }
      return execResult("");
    });
    const shown = await view(x.s, x.runbook.id);
    const pressed = await x.s.person(
      "POST",
      `/steps/${x.runbook.steps[0].id}/vm`,
      { revision: shown.steps[0].revision },
    );
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    await waitForRun(x.s, x.runbook.id, pressed.body.run.id);
    const two = await runStep(x.s, x.runbook.id, x.runbook.steps[1].id);
    expect(two.body.status, JSON.stringify(two.body)).toBe("done");
    return agentSees(x);
  };

  it("control: a run item that prints it is hidden (no difference)", async () => {
    const found = await compare(
      (s) => eventRun(s, "run"),
      ["running", "paused"],
    );
    expect(found).toEqual([]);
  }, 20_000);

  it("a job item that prints it is hidden too (no difference)", async () => {
    const found = await compare(
      (s) => eventRun(s, "job"),
      ["running", "paused"],
    );
    console.log("R3 job differences:\n" + found.slice(0, 6).join("\n"));
    expect(found).toEqual([]);
  }, 20_000);

  it("an http item whose URL holds it is hidden too (no difference)", async () => {
    const found = await compare(
      (s) => eventRun(s, "http"),
      ["running", "paused"],
    );
    expect(found).toEqual([]);
  }, 20_000);
});

// --- L1 ---------------------------------------------------------------------

describe("R4 file item on a hidden step: size in result", () => {
  const fileRun = async (secret: string) => {
    const x = await setup([
      {
        title: "Token file there",
        hostId: 1,
        hideOutputFromAgents: true,
        sequence: [
          { type: "file", path: "/etc/app/token", state: "exists", within: 60 },
        ],
      },
    ]);
    x.s.setSftp(() => ({ mode: 0o100600, size: secret.length }));
    const ran = await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
    expect(ran.body.status, JSON.stringify(ran.body)).toBe("done");
    return agentSees(x);
  };
  it("agents read the same for two token lengths", async () => {
    const found = await compare(fileRun, [
      "short-tok",
      "a-much-longer-token-value",
    ]);
    console.log("R4 differences:\n" + found.slice(0, 6).join("\n"));
    expect(found).toEqual([]);
  }, 20_000);
});

// --- H2 ---------------------------------------------------------------------

describe("R5 job journal while it runs: secrets not replaced", () => {
  it("the live item output and the stored row hide an earlier asked secret", async () => {
    const secret = "sk-live-0123456789abcdef";
    const x = await setup(
      [
        {
          title: "Paste the API token",
          ask: { name: "api_token", label: "API token" },
        },
        {
          title: "Long job",
          hostId: 1,
          sequence: [
            {
              type: "job",
              command: "deploy-with-token",
              within: 600,
              every: 60,
            },
          ],
        },
      ],
      { secrets: true },
    );
    const shown = await view(x.s, x.runbook.id);
    const saved = await x.s.person(
      "POST",
      `/steps/${x.runbook.steps[0].id}/secret`,
      { revision: shown.steps[0].revision, value: secret },
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    x.s.setExec(async (_h, command) => {
      if (command.startsWith("sudo -n systemd-run")) return execResult("");
      if (command.startsWith("systemctl show")) {
        return execResult(fixtures.systemctlShow["t038-run"].stdout);
      }
      if (command.startsWith("sudo -n journalctl")) {
        return execResult(
          `{"MESSAGE":"using token ${secret}","__CURSOR":"c1"}\n`,
        );
      }
      return execResult("");
    });
    const started = await runStep(
      x.s,
      x.runbook.id,
      x.runbook.steps[1].id,
      {},
      "run",
      { wait: false },
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    // Wait for the first check to have read the journal.
    const live = await vi.waitFor(
      async () => {
        const run = await shownRun(x.s, x.runbook.id, started.body.id);
        if (
          !run.items?.[0]?.attempts?.length ||
          run.items[0].attempts[0].status === "running"
        ) {
          throw new Error("not yet");
        }
        return run;
      },
      { timeout: 3000, interval: 10 },
    );
    const agent = await x.s.agent("GET", `/runbooks/${x.runbook.id}`, x.token);
    const agentItem = agent.body.steps[1].runs[0].items[0];
    // The live output is the redacted text, not nothing.
    expect(live.items[0].stdout).toBe("using token [secret:api_token]\n");
    // A flush in between writes the redacted text too.
    const { everything } = await import("./helpers");
    expect(everything(x.s)).not.toContain(secret);
    await x.s.person("POST", `/steps/${x.runbook.steps[1].id}/stop`);
    expect(JSON.stringify(agentItem)).not.toContain(secret);
    expect(JSON.stringify(live.items[0])).not.toContain(secret);
  }, 20_000);

  it("hides hidden input typed into an earlier item in a job's journal (L4)", async () => {
    const typed = "Zq9-typed-secret";
    const x = await setup([
      {
        title: "Ask then job",
        hostId: 1,
        sequence: [
          { type: "run", command: "read-it" },
          { type: "job", command: "show-it", within: 60 },
        ],
      },
    ]);
    const at = Math.floor(Date.now() / 1000) + 5;
    let first: FakeChannel | null = null;
    x.s.setChannel((channel: FakeChannel, command: string) => {
      if (command.includes("read-it")) {
        first = channel;
        return;
      }
      const reply = command.startsWith("systemctl show")
        ? fixtures.systemctlShow["t038-ok"].stdout.replace(/@\d+/, `@${at}`)
        : command.startsWith("sudo -n journalctl")
          ? `{"MESSAGE":"you typed ${typed}","__CURSOR":"c1"}\n`
          : "";
      setTimeout(() => {
        channel.out(reply);
        channel.exit(0);
      }, 1);
    });
    const started = await runStep(
      x.s,
      x.runbook.id,
      x.runbook.steps[0].id,
      {},
      "run",
      { wait: false },
    );
    await vi.waitFor(() => expect(first).not.toBeNull());
    const sent = await x.s.person("POST", `/runs/${started.body.id}/input`, {
      text: `${typed}\n`,
      hidden: true,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    first!.out("ok\n");
    first!.exit(0);
    const run = await waitForRun(x.s, x.runbook.id, started.body.id);
    expect(run.items[1].status).toBe("passed");
    expect(run.items[1].stdout).toContain("you typed [secret:typed]");
    const { everything } = await import("./helpers");
    expect(everything(x.s)).not.toContain(typed);
  }, 20_000);
});

// --- M3 ---------------------------------------------------------------------

describe("R6 a job's root command changed by an earlier item's output", () => {
  const sequence = (checks: unknown[], pattern = "version=(.*)") => [
    {
      type: "run",
      command: "print-version",
      captures: [{ name: "ver", pattern }],
      checks,
    },
    { type: "job", command: "deploy --version {{ver}}", within: 60 },
  ];

  /** Runs the step with print-version answering `output`. */
  async function runWith(checks: unknown[], output: string, pattern?: string) {
    const x = await setup([
      {
        title: "Build then job",
        hostId: 1,
        sequence: sequence(checks, pattern),
      },
    ]);
    const at = Math.floor(Date.now() / 1000) + 5;
    const job = jobAnswers(at);
    x.s.setExec(async (h, command) =>
      command === "print-version" ? execResult(output) : job(h, command),
    );
    const ran = await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
    const started = x.s.execCalls
      .map((c) => c.command)
      .find((c) => c.startsWith("sudo -n systemd-run"));
    return { ran, started };
  }

  it("the job runs only what the person approved: without a pattern, the runbook is refused when written (owner, 2026-11-23)", async () => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Build then job",
      steps: [{ title: "Build", hostId: 1, sequence: sequence([]) }],
    });
    expect(made.status).toBe(400);
    expect(made.body.code).toBe("captured-value");
    expect(made.body.error).toContain("{{ver}}");
    expect(made.body.error).toContain(
      '{"type":"value","name":"ver","matches":"^[0-9.]+$"}',
    );
    // MCP too.
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_runbook",
        arguments: {
          title: "Build then job",
          steps: [{ title: "Build", hostId: 1, sequence: sequence([]) }],
        },
      },
    });
    expect(mcp.body.result.isError).toBe(true);
    expect(JSON.stringify(mcp.body.result.content)).toContain("{{ver}}");
    // An equals check, or a value check with no pattern, is not a pattern.
    const equals = await s.agent("POST", "/runbooks", token, {
      title: "Build then job",
      steps: [
        {
          title: "Build",
          hostId: 1,
          sequence: sequence([{ type: "value", name: "ver" }]),
        },
      ],
    });
    expect(equals.status).toBe(400);
  });

  it("refuses it on add-steps, update-step and amend; and for a later step's command and an event's text", async () => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Capture",
      steps: [
        {
          title: "Read",
          hostId: 1,
          command: "print-version",
          captures: [{ name: "ver", pattern: "version=(\\S+)" }],
        },
      ],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id;
    const add = await s.agent("POST", `/runbooks/${id}/steps`, token, {
      steps: [{ title: "Use", hostId: 1, command: "deploy {{ver}}" }],
    });
    expect(add.status).toBe(400);
    expect(add.body.error).toContain("step 2 uses {{ver}} in its command");
    const event = await s.agent("POST", `/runbooks/${id}/steps`, token, {
      steps: [
        {
          title: "Wait",
          hostId: 1,
          sequence: [{ type: "container", name: "{{ver}}", state: "running" }],
        },
      ],
    });
    expect(event.status).toBe(400);
    const fine = await s.agent("POST", `/runbooks/${id}/steps`, token, {
      steps: [{ title: "Use", hostId: 1, command: "deploy 1.0" }],
    });
    expect(fine.status).toBe(201);
    const two = fine.body.steps[1].id;
    const patched = await s.agent("PATCH", `/steps/${two}`, token, {
      command: "deploy {{ver}}",
    });
    expect(patched.status).toBe(400);
    // With the pattern on the step that captures it, both are taken.
    const one = fine.body.steps[0].id;
    const checked = await s.agent("PATCH", `/steps/${one}`, token, {
      checks: [{ type: "value", name: "ver", matches: "^[0-9.]+$" }],
    });
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    const now = await s.agent("PATCH", `/steps/${two}`, token, {
      command: "deploy {{ver}}",
    });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    // Taking the pattern away again is refused.
    const back = await s.agent("PATCH", `/steps/${one}`, token, {
      checks: [],
    });
    expect(back.status).toBe(400);
    // Runbook values the agent set, and VM values, need no pattern.
    const values = await s.agent("POST", "/runbooks", token, {
      title: "Values",
      values: { ver: "1.2" },
      steps: [{ title: "Use", hostId: 1, command: "deploy {{ver}}" }],
    });
    expect(values.status).toBe(201);
  });

  it("a captured value that fails its pattern fails the capturing item: the job never starts", async () => {
    const { ran, started } = await runWith(
      [{ type: "value", name: "ver", matches: "^[0-9.]+$" }],
      "version=1.2; touch /root/pwned\n",
    );
    expect(ran.body.status).toBe("failed");
    expect(started).toBeUndefined();
  }, 20_000);

  it("a value that matches only part of an unanchored pattern, or only one line, never reaches the job", async () => {
    // The item's own check passes ([0-9.]+ is found in the text), but the
    // value goes into a command only when it matches as a whole.
    const loose = await runWith(
      [{ type: "value", name: "ver", matches: "[0-9.]+" }],
      "version=1.2; touch /root/pwned\n",
    );
    expect(loose.started).toBeUndefined();
    expect(loose.ran.body.status).toBe("failed");
    expect(loose.ran.body.items[1].error).toContain("as a whole");
    // A check reads its pattern per line: "1.2" and a second line.
    const lines = await runWith(
      [{ type: "value", name: "ver", matches: "^[0-9.]+$" }],
      "version=1.2\ntouch /root/pwned\n",
      "version=([\\s\\S]*)",
    );
    expect(lines.started).toBeUndefined();
    expect(lines.ran.body.items[1].error).toContain("as a whole");
  }, 20_000);

  it("a value that matches runs the job with it", async () => {
    const { ran, started } = await runWith(
      [{ type: "value", name: "ver", matches: "^[0-9.]+$" }],
      "version=1.2\n",
      "version=(\\S+)",
    );
    expect(ran.body.status, JSON.stringify(ran.body)).toBe("done");
    expect(started).toContain("/bin/sh -c 'deploy --version 1.2'");
  }, 20_000);
});

// --- L2 ---------------------------------------------------------------------

describe("R7 another person presses Try now / Skip on a run", () => {
  it("bob cannot speed up alice's wait", async () => {
    const x = await setup([
      {
        title: "Wait",
        hostId: 1,
        sequence: [
          {
            type: "wait",
            command: "probe",
            checks: [{ type: "contains", text: "ready" }],
            within: 600,
            every: 300,
          },
        ],
      },
    ]);
    let n = 0;
    x.s.setExec(async () => execResult(++n >= 3 ? "ready\n" : "no\n"));
    const started = await runStep(
      x.s,
      x.runbook.id,
      x.runbook.steps[0].id,
      {},
      "run",
      { wait: false },
    );
    await vi.waitFor(
      async () => {
        const run = await shownRun(x.s, x.runbook.id, started.body.id);
        if (!run.items[0].nextAttemptAt) throw new Error("not waiting");
      },
      { timeout: 3000, interval: 10 },
    );
    // The fake host lets everyone connect: bob cannot here.
    const access = vi
      .spyOn(x.s.mock.ctx.hosts, "checkAccess")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ hasAccess: false } as any);
    const bob = await x.s.person(
      "POST",
      `/steps/${x.runbook.steps[0].id}/try-now`,
      undefined,
      { user: "bob" },
    );
    console.log("R7 bob try-now:", bob.status, bob.body?.error);
    expect(bob.status).not.toBe(200);
    expect(bob.status).toBe(403);
    expect(access).toHaveBeenCalledWith(1, "connect");
    const run = await shownRun(x.s, x.runbook.id, started.body.id);
    expect(run.items[0].attempts).toHaveLength(1);
    access.mockRestore();
    // A person who can connect to the host may press it.
    const carol = await x.s.person(
      "POST",
      `/steps/${x.runbook.steps[0].id}/try-now`,
      undefined,
      { user: "carol" },
    );
    expect(carol.status, JSON.stringify(carol.body)).toBe(200);
    await x.s.person("POST", `/steps/${x.runbook.steps[0].id}/stop`);
  }, 20_000);

  it("bob cannot skip alice's delay; alice can", async () => {
    const x = await setup([
      {
        title: "Delay",
        hostId: 1,
        sequence: [
          { type: "delay", seconds: 600, reason: "let it start" },
          { type: "run", command: "after" },
        ],
      },
    ]);
    x.s.setExec(async () => execResult("ok\n"));
    const started = await runStep(
      x.s,
      x.runbook.id,
      x.runbook.steps[0].id,
      {},
      "run",
      { wait: false },
    );
    await vi.waitFor(
      async () => {
        const run = await shownRun(x.s, x.runbook.id, started.body.id);
        if (run.items[0].status !== "running") throw new Error("not yet");
      },
      { timeout: 3000, interval: 10 },
    );
    const access = vi
      .spyOn(x.s.mock.ctx.hosts, "checkAccess")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ hasAccess: false } as any);
    const bob = await x.s.person(
      "POST",
      `/steps/${x.runbook.steps[0].id}/skip-delay`,
      undefined,
      { user: "bob" },
    );
    expect(bob.status).toBe(403);
    expect(bob.body.code).toBe("not-your-run");
    // The person who pressed Run needs no host check to skip it.
    const alice = await x.s.person(
      "POST",
      `/steps/${x.runbook.steps[0].id}/skip-delay`,
    );
    access.mockRestore();
    expect(alice.status, JSON.stringify(alice.body)).toBe(200);
    await waitForRun(x.s, x.runbook.id, started.body.id);
  }, 20_000);
});

// --- M2 ---------------------------------------------------------------------

describe("R8 stored output per run: every attempt keeps its full output", () => {
  it("a wait's attempts together stay under a per-item cap (1 MB)", async () => {
    const x = await setup([
      {
        title: "Noisy wait",
        hostId: 1,
        sequence: [
          {
            type: "wait",
            command: "noisy",
            checks: [{ type: "contains", text: "never" }],
            within: 60,
            every: 1,
            attempts: 4,
          },
        ],
      },
    ]);
    const big = "x".repeat(250_000) + "\n";
    x.s.setExec(async () => execResult(big, { stderr: big }));
    const ran = await runStep(
      x.s,
      x.runbook.id,
      x.runbook.steps[0].id,
      {},
      "run",
      { wait: false },
    );
    const done = await vi.waitFor(
      async () => {
        const run = await shownRun(x.s, x.runbook.id, ran.body.id);
        if (run.status === "running") throw new Error("running");
        return run;
      },
      { timeout: 15000, interval: 50 },
    );
    // The views carry no attempt output: read each one as the page does.
    const attempts = done.items[0].attempts;
    const kept: Array<{ stdout: string | null; stderr: string | null }> = [];
    for (const attempt of attempts) {
      expect(attempt.stdout).toBeNull();
      kept.push(await attemptOutput(x.s, attempt, done.items[0].runId));
    }
    const bytes = kept.reduce(
      (n: number, a: { stdout: string | null; stderr: string | null }) =>
        n + (a.stdout?.length ?? 0) + (a.stderr?.length ?? 0),
      0,
    );
    const agent = await x.s.agent("GET", `/runbooks/${x.runbook.id}`, x.token);
    const answered = JSON.stringify(agent.body).length;
    console.log(
      `R8: ${attempts.length} attempts keep ${bytes} bytes; one agent GET answers ${answered} bytes`,
    );
    expect(bytes).toBeLessThan(1_000_000);
    // The last attempt keeps its whole output; the earlier ones, the end.
    expect(kept[3].stdout).toBe(big);
    for (const earlier of kept.slice(0, 3)) {
      expect(earlier.stdout!.length).toBeLessThanOrEqual(
        OUTPUT_LIMITS.earlierTail,
      );
      expect(big.endsWith(earlier.stdout!)).toBe(true);
    }
    expect(attempts[0].truncated).toBe(true);
    // One agent read carries the last output (the item's, and the event's
    // copy of it), not every attempt's: 4 attempts read 3 MB before.
    expect(answered).toBeLessThan(1_200_000);
  }, 30_000);

  it("a run keeps at most its output budget; past it, an attempt keeps the end", async () => {
    const { OutputBudget, tailOf } =
      await import("../../src/backend/running/output-limits");
    const budget = new OutputBudget(600_000);
    const big = "y".repeat(250_000);
    expect(budget.take(big, big)).toMatchObject({ cut: false });
    const cut = budget.take(big, big);
    expect(cut.cut).toBe(true);
    expect(cut.stdout!.length).toBe(OUTPUT_LIMITS.earlierTail);
    budget.giveBack(500_000);
    expect(budget.take(big, big).cut).toBe(false);
    expect(tailOf("héllo", 3)).toEqual({ text: "llo", cut: true });
    expect(OUTPUT_LIMITS).toEqual({
      earlierTail: 4096,
      itemEarlier: 262_144,
      run: 8_388_608,
    });
  });
});

// --- L5 ---------------------------------------------------------------------

describe("a job's unit when its item ends early (L5)", () => {
  it("Stop while systemd-run starts the unit still stops the unit", async () => {
    const x = await setup([
      {
        title: "Job",
        hostId: 1,
        sequence: [{ type: "job", command: "long-thing", within: 600 }],
      },
    ]);
    let starting: FakeChannel | null = null;
    const commands: string[] = [];
    x.s.setChannel((channel: FakeChannel, command: string) => {
      commands.push(command);
      if (command.startsWith("sudo -n systemd-run")) {
        starting = channel;
        return;
      }
      setTimeout(() => channel.exit(0), 1);
    });
    const started = await runStep(
      x.s,
      x.runbook.id,
      x.runbook.steps[0].id,
      {},
      "run",
      { wait: false },
    );
    await vi.waitFor(() => expect(starting).not.toBeNull());
    await x.s.person("POST", `/steps/${x.runbook.steps[0].id}/stop`);
    const run = await waitForRun(x.s, x.runbook.id, started.body.id);
    expect(run.items[0].status).toBe("failed");
    expect(
      commands.find((c) => c.startsWith("sudo -n systemctl stop")),
    ).toContain("runbooks-job-");
  }, 20_000);
});

// --- L6 ---------------------------------------------------------------------

describe("the sleep ban reads values once filled in (L6)", () => {
  it("refuses a Run whose value makes the command wait", async () => {
    const x = await setup([{ title: "Do", hostId: 1, command: "{{cmd}} 5" }], {
      values: { cmd: "sleep" },
    });
    const shown = await view(x.s, x.runbook.id);
    const ran = await x.s.person("POST", `/steps/${shown.steps[0].id}/run`, {
      revision: shown.steps[0].revision,
      commandHash: shown.steps[0].commandHash,
    });
    expect(ran.status).toBe(400);
    expect(ran.body.code).toBe("sleep");
    expect(x.s.execCalls).toHaveLength(0);
  });

  it("fails an item whose value, captured by an earlier item, makes it wait", async () => {
    const x = await setup([
      {
        title: "Do",
        hostId: 1,
        sequence: [
          {
            type: "run",
            command: "pick",
            captures: [{ name: "c", pattern: "c=(\\S+)" }],
            checks: [{ type: "value", name: "c", matches: "^[a-z]+$" }],
          },
          { type: "run", command: "{{c}} 5" },
        ],
      },
    ]);
    x.s.setExec(async () => execResult("c=sleep\n"));
    const ran = await runStep(x.s, x.runbook.id, x.runbook.steps[0].id);
    expect(ran.body.status).toBe("failed");
    expect(ran.body.items[1].error).toContain("delay item");
    expect(x.s.execCalls.map((c) => c.command)).toEqual(["pick"]);
  });
});
