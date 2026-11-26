/**
 * 1.4.10, phase 3: the wait events built into the plugin, end to end: an
 * agent writes them (clear 400s), a person presses Run, and the server
 * checks on the wait engine's schedule as that person, each check an
 * attempt with the state it read in words. The SSH client is a fake with
 * ssh2's shape (helpers.ts): exec, forwardOut, sftp and the server's
 * version string; the readers' answers are the real ones in
 * fixtures/event-readers.json.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  attemptOutput,
  execResult,
  runStep,
  setupRunbook,
  shownRun,
  useTestServer,
  view,
  type TestServer,
} from "./helpers";
import { HTTP_CA_SETTING } from "../../src/backend/events/trust";
import { FORWARD_REFUSED } from "../../src/backend/events/readers";
import fixtures from "./fixtures/event-readers.json";

const testServer = useTestServer();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const seqStep = (
  sequence: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => ({ title: "Deploy", hostId: 1, sequence, ...extra });

const ev = (type: string, fields: Record<string, unknown>) => ({
  type,
  within: 600,
  ...fields,
});

const INSPECT =
  'docker container inspect --format \'{"State":{{json .State}},"RestartCount":{{.RestartCount}}}\' -- ';

/** Answers each command that starts with a key with its list, in turn. */
function answers(
  s: TestServer,
  script: Array<
    [string, Array<{ stdout: string; stderr: string; code: number | null }>]
  >,
) {
  const seen = new Map<string, number>();
  s.setExec(async (_host, command) => {
    const entry = script.find(([start]) => command.startsWith(start));
    if (!entry) return execResult("");
    const [key, list] = entry;
    const index = Math.min(seen.get(key) ?? 0, list.length - 1);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const answer = list[index];
    return execResult(answer.stdout, {
      stderr: answer.stderr,
      code: answer.code,
    });
  });
}

const fake = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

afterEach(() => {
  vi.useRealTimers();
});

async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  stepMs = 0,
): Promise<T> {
  for (let round = 0; round < 600; round++) {
    const value = await read();
    if (ok(value)) return value;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(stepMs);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("never got there");
}

async function start(s: TestServer, runbookId: number, stepId: number) {
  const reply = await runStep(s, runbookId, stepId, {}, "run", {
    wait: false,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body;
}

const read = (s: TestServer, runbookId: number, runId: number) => () =>
  shownRun(s, runbookId, runId);

const ended = (
  s: TestServer,
  runbookId: number,
  runId: number,
  stepMs = 1000,
) =>
  until(read(s, runbookId, runId), (r: Any) => r.status !== "running", stepMs);

const results = (item: Any) => item.attempts.map((a: Any) => a.result);
const whys = (item: Any) => item.attempts.map((a: Any) => a.why);

/** A run whose first item's attempts end as the list says. */
async function runOne(
  sequence: Array<Record<string, unknown>>,
  setup: (s: TestServer) => void,
  options: { fakeTimers?: boolean; server?: Record<string, unknown> } = {},
) {
  const { s, runbook, token } = await setupRunbook([seqStep(sequence)], {
    server: options.server,
  });
  setup(s);
  if (options.fakeTimers !== false) fake();
  const started = await start(s, runbook.id, runbook.steps[0].id);
  const done = await ended(
    s,
    runbook.id,
    started.id,
    options.fakeTimers === false ? 0 : 1000,
  );
  return { s, runbook, token, done };
}

describe("writing events", () => {
  it("stores each with its defaults and the wait engine's schedule", async () => {
    const { runbook, s } = await setupRunbook([
      seqStep([
        ev("container", { name: "enforcarr", state: "healthy", within: 180 }),
        ev("port", { port: 8443 }),
        ev("http", {
          url: "https://127.0.0.1:8443/health",
          servername: "termix.example.com",
        }),
        ev("file", { path: "/srv/app/ready" }),
        ev("unit", { name: "restic.service", state: "finished", every: 30 }),
        ev("log", { container: "enforcarr", pattern: "listening on" }),
        ev("job", {
          command: "sudo restic-nightly.sh",
          unit: "restic-nightly",
          within: 7200,
        }),
      ]),
    ]);
    const [container, port, httpItem, file, unit, log, job] =
      runbook.steps[0].sequence;
    expect(container).toEqual({
      type: "container",
      label: null,
      onFail: "stop",
      within: 180,
      attempts: null,
      timeoutMs: null,
      every: 5,
      backoff: "fixed",
      factor: 2,
      maxDelay: 300,
      jitter: "none",
      name: "enforcarr",
      state: "healthy",
    });
    expect(port).toMatchObject({
      port: 8443,
      state: "open",
      host: "127.0.0.1",
    });
    expect(httpItem).toMatchObject({
      status: 200,
      contains: null,
      servername: "termix.example.com",
    });
    expect(file).toMatchObject({ state: "exists", sudo: false });
    expect(unit).toMatchObject({ state: "finished", every: 30 });
    expect(log).toMatchObject({ unit: null, failPattern: null, sudo: false });
    expect(job).toMatchObject({ unit: "restic-nightly", within: 7200 });
    // What the person approves: each item's exact check and schedule.
    const shown = await view(s, runbook.id);
    const text = shown.steps[0].resolvedCommand;
    expect(text).toContain(
      "# 1: container, up to 500 attempts, every 5 s, at most 3 min\n" +
        `${INSPECT}'enforcarr'\n# until healthy`,
    );
    expect(text).toContain(
      "TCP 127.0.0.1:8443 on the host, through the SSH connection: until open",
    );
    expect(text).toContain(
      "GET https://127.0.0.1:8443/health on the host, through the SSH connection, certificate for termix.example.com: until HTTP 200",
    );
    expect(text).toContain(
      "sudo -n systemd-run --unit='restic-nightly.service' --description='Runbooks job' --property=RemainAfterExit=yes -- /bin/sh -c 'sudo restic-nightly.sh'",
    );
  });

  it.each([
    [
      ev("port", { port: 22, host: "10.0.0.5" }),
      "host must be the host's own loopback",
    ],
    // T-279: the key's permitopen="127.0.0.1:*" forwards to that address
    // as written; sshd refuses ::1 (and localhost, which is sent as
    // 127.0.0.1).
    [
      ev("port", { port: 5432, host: "::1" }),
      "::1 cannot be reached through SSH: write 127.0.0.1; Termix's SSH key allows forwarding to 127.0.0.1 only",
    ],
    [
      ev("port", { port: 5432, host: "[::1]" }),
      "write 127.0.0.1; Termix's SSH key allows forwarding to 127.0.0.1 only",
    ],
    [
      ev("http", { url: "http://[::1]:8080/health" }),
      "[::1] cannot be reached through SSH: write 127.0.0.1; Termix's SSH key allows forwarding to 127.0.0.1 only",
    ],
    [
      ev("http", { url: "https://[::1]:8443/", servername: "a.example.com" }),
      "write 127.0.0.1; Termix's SSH key allows forwarding to 127.0.0.1 only",
    ],
    [ev("port", { port: 70000 }), "port must be an integer from 1 to 65535"],
    [ev("port", {}), "port is required"],
    [
      ev("http", { url: "http://example.com/" }),
      "plain http:// is allowed only to the host's own loopback",
    ],
    [ev("http", { url: "ftp://127.0.0.1/" }), "must start with https://"],
    [
      ev("http", { url: "https://user:pw@127.0.0.1/" }),
      "must not hold a user name or password",
    ],
    [
      ev("http", { url: "https://example.com/", servername: "a.example.com" }),
      "servername is for a loopback URL only",
    ],
    [
      ev("http", { url: "https://127.0.0.1/", servername: "bad name!" }),
      "servername must be a host name",
    ],
    [
      ev("http", { url: "https://127.0.0.1/", status: 99 }),
      "status must be an integer from 100 to 599",
    ],
    [ev("file", { path: "relative/path" }), "path must be an absolute path"],
    [
      ev("file", { path: "/a", state: "big" }),
      'state must be "exists", "nonEmpty", "gone"',
    ],
    [ev("container", { name: "web" }), "state is required"],
    [
      ev("container", { name: "x; rm -rf /", state: "running" }),
      "name must be a container name",
    ],
    [
      ev("container", { name: "-v", state: "running" }),
      "name must be a container name",
    ],
    [ev("unit", { name: "nginx.service" }), "state is required"],
    [
      ev("unit", { name: "-H evil", state: "active" }),
      "must be a systemd unit name",
    ],
    [
      ev("unit", { name: "a$(id)", state: "active" }),
      "must be a systemd unit name",
    ],
    [ev("log", { pattern: "x" }), "needs either container or unit"],
    [
      ev("log", { container: "a", unit: "b", pattern: "x" }),
      "needs either container or unit",
    ],
    [
      ev("log", { container: "a", pattern: "(a+)+$" }),
      "repeated group that holds a repeat",
    ],
    [
      ev("log", { container: "a", pattern: "([" }),
      "is not a valid regular expression",
    ],
    [
      ev("log", { container: "a", pattern: "x".repeat(201) }),
      "longer than 200",
    ],
    [
      ev("log", { container: "a", pattern: "x", sudo: true }),
      "sudo is for a unit's journal only",
    ],
    [ev("job", { command: "" }), "command is required for a job item"],
    [ev("job", { command: "x", unit: "a.timer" }), "unit must be a service"],
    [
      ev("job", { command: "x", within: 7201 }),
      "within must be an integer from 1 to 7200",
    ],
    [{ type: "container", name: "a", state: "running" }, "within is required"],
    [
      ev("container", { name: "a", state: "running", checks: [] }),
      'unknown sequence[0] field "checks"',
    ],
  ])("refuses %j with a clear 400", async (item, message) => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [seqStep([item as Record<string, unknown>])],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(400);
    expect(made.body.error).toContain(message);
  });

  it("refuses sleep in a job's command", async () => {
    const s = await testServer();
    const token = await s.makeToken();
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Bad",
      steps: [seqStep([ev("job", { command: "backup && sleep 60" })])],
    });
    expect(made.status).toBe(400);
    expect(made.body.code).toBe("sleep");
  });

  it("is taken on add-steps, update-step, amend and MCP", async () => {
    const { s, token, runbook } = await setupRunbook([
      { title: "A", hostId: 1, command: "true" },
    ]);
    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [seqStep([ev("port", { port: 5432 })])],
      },
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const stepId = added.body.steps[1].id;
    const bad = await s.agent("PATCH", `/steps/${stepId}`, token, {
      sequence: [ev("port", { port: 5432, host: "db.internal" })],
    });
    expect(bad.status).toBe(400);
    const patched = await s.agent("PATCH", `/steps/${stepId}`, token, {
      sequence: [ev("file", { path: "/srv/ready", state: "gone" })],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_steps",
        arguments: {
          runbookId: runbook.id,
          steps: [seqStep([ev("unit", { name: "x.service", state: "up" })])],
        },
      },
    });
    expect(JSON.stringify(mcp.body)).toContain(
      'state must be \\"active\\", \\"finished\\"',
    );
  });
});

describe("container", () => {
  it("checks until healthy: one fixed docker inspect a check, the state in words", async () => {
    const { s, done } = await runOne(
      [ev("container", { name: "enforcarr", state: "healthy", within: 180 })],
      (s) =>
        answers(s, [
          [
            INSPECT,
            [
              fixtures.dockerInspect.missing,
              fixtures.dockerInspect.starting,
              fixtures.dockerInspect.healthy,
            ],
          ],
        ]),
    );
    expect(done.status).toBe("done");
    const item = done.items[0];
    expect(item).toMatchObject({ status: "passed", result: "healthy" });
    expect(results(item)).toEqual(["not found", "starting", "healthy"]);
    expect(whys(item)).toEqual(["not-yet", "not-yet", null]);
    expect(item.command).toBe(`${INSPECT}'enforcarr'\n# until healthy`);
    expect(s.execCalls.map((c) => c.command)).toEqual([
      `${INSPECT}'enforcarr'`,
      `${INSPECT}'enforcarr'`,
      `${INSPECT}'enforcarr'`,
    ]);
    // Each check on a connection of its own, every one closed.
    expect(s.connections).toEqual({ opened: 3, disposed: 3 });
    expect(item.stdout).toContain('"Status":"healthy"');
  });

  it("fails at once when the container exits while it waits, and stops the sequence", async () => {
    const { done, s } = await runOne(
      [
        ev("container", { name: "web", state: "healthy" }),
        { type: "run", command: "never" },
      ],
      (s) =>
        answers(s, [
          [
            INSPECT,
            [
              fixtures.dockerInspect.starting,
              fixtures.dockerInspect["exited-3"],
            ],
          ],
        ]),
    );
    expect(done.status).toBe("failed");
    expect(done.items[0]).toMatchObject({
      status: "failed",
      result: "exited (3)",
    });
    expect(done.items[0].error).toContain("exited with code 3");
    expect(whys(done.items[0])).toEqual(["not-yet", "fail-state"]);
    expect(done.items[1].status).toBe("waiting");
    expect(s.execCalls).toHaveLength(2);
  });

  it("fails with the last state when the time runs out", async () => {
    const { done } = await runOne(
      [ev("container", { name: "web", state: "healthy", within: 12 })],
      (s) => answers(s, [[INSPECT, [fixtures.dockerInspect.unhealthy]]]),
    );
    expect(done.items[0].status).toBe("failed");
    expect(done.items[0].error).toContain(
      "the state it waits for did not come within 12 s (3 checks); the last check read: unhealthy",
    );
  });
});

describe("unit", () => {
  it("passes finished on Result=success after the step started; fails at once on failed", async () => {
    const at = Math.floor(Date.now() / 1000) + 5;
    const stamp = (output: { stdout: string }) => ({
      ...output,
      stdout: output.stdout.replace(/@\d+/, `@${at}`),
      stderr: "",
      code: 0,
    });
    const ok = await runOne(
      [ev("unit", { name: "restic.service", state: "finished" })],
      (s) =>
        answers(s, [
          [
            "systemctl show",
            [
              stamp(fixtures.systemctlShow["t038-run"]),
              stamp(fixtures.systemctlShow["t038-ok"]),
            ],
          ],
        ]),
    );
    expect(ok.done.items[0]).toMatchObject({
      status: "passed",
      result: "finished (success)",
    });
    expect(ok.s.execCalls[0].command).toBe(
      "systemctl show --timestamp=unix -p LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,ExecMainExitTimestamp,NRestarts -- 'restic.service'",
    );
    const failed = await runOne(
      [ev("unit", { name: "restic.service", state: "finished" })],
      (s) =>
        answers(s, [
          ["systemctl show", [stamp(fixtures.systemctlShow["t038-fail"])]],
        ]),
    );
    expect(failed.done.items[0]).toMatchObject({
      status: "failed",
      result: "failed (exit-code, status 3)",
    });
    expect(whys(failed.done.items[0])).toEqual(["fail-state"]);
  });
});

describe("port", () => {
  it("fails at once when the host's key refuses forwarding: never read as closed", async () => {
    const { done, s } = await runOne(
      [ev("port", { port: 8443, state: "closed" })],
      () => {},
    );
    expect(done.items[0]).toMatchObject({
      status: "failed",
      result: "forwarding refused",
      error: FORWARD_REFUSED,
    });
    expect(done.items[0].command).toBe(
      "TCP 127.0.0.1:8443 on host-1, through the SSH connection: until closed",
    );
    expect(s.forwardCalls).toEqual([{ host: "127.0.0.1", port: 8443 }]);
  });

  it("waits while the port is closed, passes when it opens; localhost is 127.0.0.1", async () => {
    let tries = 0;
    const { done, s } = await runOne(
      [ev("port", { port: 5432, host: "localhost" })],
      (s) =>
        s.setForward(() => {
          tries++;
          if (tries < 3) {
            return Object.assign(
              new Error(fixtures.ssh2.forward.closed.error.message),
              { reason: 2 },
            );
          }
          const [a] = pair();
          return a;
        }),
    );
    expect(done.items[0].status).toBe("passed");
    expect(results(done.items[0])).toEqual([
      "port closed",
      "port closed",
      "port open",
    ]);
    expect(s.forwardCalls.every((c) => c.host === "127.0.0.1")).toBe(true);
    // No command runs on the host for a port.
    expect(s.execCalls).toHaveLength(0);
  });
});

/** Two connected streams, as a channel and the far side. */
function pair(): [net.Socket, net.Socket] {
  const a = new net.Socket();
  const b = new net.Socket();
  return [a, b];
}

describe("file", () => {
  it("reads SFTP stat as the SSH user: no command on the host", async () => {
    let tries = 0;
    const paths: string[] = [];
    const { done, s } = await runOne(
      [ev("file", { path: "/srv/app/ready", state: "nonEmpty" })],
      (s) =>
        s.setSftp((p) => {
          paths.push(p);
          tries++;
          if (tries === 1) return fixtures.ssh2.sftp.missing;
          if (tries === 2) return fixtures.ssh2.sftp.empty;
          return fixtures.ssh2.sftp.file;
        }),
    );
    expect(done.items[0].status).toBe("passed");
    expect(results(done.items[0])).toEqual([
      "not there",
      "file exists, empty",
      "file exists",
    ]);
    expect(paths).toEqual([
      "/srv/app/ready",
      "/srv/app/ready",
      "/srv/app/ready",
    ]);
    expect(s.execCalls).toHaveLength(0);
  });

  it("reads a root-only path with one fixed sudo stat, the path quoted", async () => {
    const { done, s } = await runOne(
      [ev("file", { path: "/root/it's here; rm -rf /", sudo: true })],
      (s) => answers(s, [["sudo -n stat", [fixtures.stat.file]]]),
    );
    expect(done.items[0].status).toBe("passed");
    expect(s.execCalls[0].command).toBe(
      "sudo -n stat -L -c '%s %F' -- '/root/it'\\''s here; rm -rf /'",
    );
  });
});

describe("log", () => {
  it("reads lines written after the step started, each once, and matches in JavaScript", async () => {
    const since = Math.floor(Date.now() / 1000);
    const { done, s } = await runOne(
      [
        ev("log", {
          container: "web",
          pattern: "ready to serve",
          failPattern: "^FATAL",
        }),
      ],
      (s) =>
        answers(s, [
          [
            "docker logs",
            [
              {
                stdout: "2026-11-23T22:14:47.601241598Z first line\n",
                stderr: "",
                code: 0,
              },
              fixtures.dockerLogs.timestamps,
            ],
          ],
        ]),
    );
    expect(done.items[0].status).toBe("passed");
    expect(results(done.items[0])).toEqual([
      "no match yet (1 new line)",
      "matched",
    ]);
    const calls = s.execCalls.map((c) => c.command);
    expect(calls[0]).toMatch(
      new RegExp(
        `^docker logs --timestamps --since '(${since}|${since - 1}|${since + 1})' -- 'web'$`,
      ),
    );
    expect(calls[1]).toBe(
      "docker logs --timestamps --since '2026-11-23T22:14:47.601241598Z' -- 'web'",
    );
  });

  it("fails at once on a failPattern line; reads a unit's journal after its cursor", async () => {
    const { done, s } = await runOne(
      [
        ev("log", {
          unit: "t038-one.service",
          pattern: "oneshot ends",
          failPattern: "^Starting",
        }),
      ],
      (s) => answers(s, [["journalctl", [fixtures.journal["fields-cursor"]]]]),
    );
    expect(done.items[0]).toMatchObject({
      status: "failed",
      result: "failPattern matched",
    });
    expect(s.execCalls[0].command).toMatch(
      /^journalctl -u 't038-one\.service' --since '@\d+' -o json --output-fields=MESSAGE --no-pager$/,
    );
    const next = await runOne(
      [
        ev("log", {
          unit: "t038-one.service",
          pattern: "^oneshot ends$",
          sudo: true,
        }),
      ],
      (s) =>
        answers(s, [
          [
            "sudo -n journalctl",
            [
              fixtures.journal["fields-cursor"],
              fixtures.journal["after-cursor-new"],
            ],
          ],
        ]),
    );
    expect(next.done.items[0].status, JSON.stringify(next.done.items[0])).toBe(
      "passed",
    );
    expect(next.s.execCalls[1].command).toMatch(
      /^sudo -n journalctl -u 't038-one\.service' --after-cursor='s=0404.+' -o json/,
    );
    // The item shows the messages, not the JSON around them.
    expect(next.done.items[0].stdout).toBe(
      'oneshot ends\nFinished t038-one.service - [systemd-run] /usr/bin/sh -c "echo oneshot runs; sleep 4; echo oneshot ends".\n',
    );
  });
});

describe("job", () => {
  const show = (key: keyof typeof fixtures.systemctlShow) => ({
    ...fixtures.systemctlShow[key],
    stderr: "",
    code: 0,
  });

  it("starts a transient unit, streams its journal into the item, passes on Result=success and unloads it", async () => {
    const { done, s } = await runOne(
      [
        ev("job", {
          command: "restic backup /srv",
          unit: "nightly",
          every: 30,
          within: 7200,
        }),
      ],
      (s) =>
        answers(s, [
          ["sudo -n systemd-run", [fixtures.systemdRun.ok]],
          ["systemctl show", [show("t038-run"), show("t038-ok")]],
          [
            "sudo -n journalctl",
            [
              fixtures.journal["fields-cursor"],
              fixtures.journal["after-cursor-new"],
            ],
          ],
          ["sudo -n systemctl stop", [{ stdout: "", stderr: "", code: 0 }]],
        ]),
      { server: { settings: {} } },
    );
    expect(done.status).toBe("done");
    const item = done.items[0];
    expect(item).toMatchObject({
      status: "passed",
      result: "finished (success)",
    });
    const calls = s.execCalls.map((c) => c.command);
    expect(calls[0]).toBe(
      "sudo -n systemd-run --unit='nightly.service' --description='Runbooks job' --property=RemainAfterExit=yes -- /bin/sh -c 'restic backup /srv'",
    );
    expect(calls).toContain(
      "sudo -n systemctl stop -- 'nightly.service'; sudo -n systemctl reset-failed -- 'nightly.service' 2>/dev/null; true",
    );
    // Once: the job is started by the first check only.
    expect(calls.filter((c) => c.includes("systemd-run"))).toHaveLength(1);
    // The item keeps the journal across checks; each attempt its new lines.
    expect(item.stdout).toContain("oneshot runs");
    expect(item.stdout).toContain("oneshot ends");
    // BUG-022 M2: an attempt's output is read on its own.
    const second = await attemptOutput(s, item.attempts[1], item.runId);
    expect(second.stdout).toContain("oneshot ends");
    expect(second.stdout).not.toContain("Starting t038-one");
  });

  it("fails at once when the job's unit failed; when a unit of that name is loaded", async () => {
    const failed = await runOne([ev("job", { command: "backup" })], (s) =>
      answers(s, [
        ["sudo -n systemd-run", [fixtures.systemdRun.fail]],
        ["systemctl show", [show("t038-fail")]],
        ["sudo -n journalctl", [fixtures.journal.fail]],
      ]),
    );
    expect(failed.done.items[0]).toMatchObject({
      status: "failed",
      result: "failed (exit-code, status 3)",
    });
    // The default unit name comes from the run and the item.
    expect(failed.s.execCalls[0].command).toContain(
      `--unit='runbooks-job-${failed.done.id}-1.service'`,
    );
    const exists = await runOne(
      [ev("job", { command: "backup", unit: "t038-run" })],
      (s) =>
        answers(s, [["sudo -n systemd-run", [fixtures.systemdRun.exists]]]),
    );
    expect(exists.done.items[0].error).toContain(
      "a unit named t038-run.service is loaded already",
    );
  });

  it("Stop stops the job's unit", async () => {
    const { s, runbook } = await setupRunbook([
      seqStep([ev("job", { command: "long-work", every: 300 })]),
    ]);
    answers(s, [
      ["sudo -n systemd-run", [fixtures.systemdRun.running]],
      ["systemctl show", [show("t038-run")]],
      ["sudo -n journalctl", [fixtures.journal.none]],
    ]);
    fake();
    const started = await start(s, runbook.id, runbook.steps[0].id);
    await until(
      read(s, runbook.id, started.id),
      (r: Any) => r.items[0].nextAttemptAt !== null,
    );
    await s.person("POST", `/steps/${runbook.steps[0].id}/stop`);
    const done = await ended(s, runbook.id, started.id, 0);
    expect(done.items[0].error).toBe("stopped by alice");
    expect(s.execCalls.at(-1)!.command).toContain(
      "sudo -n systemctl stop -- 'runbooks-job-",
    );
  });
});

describe("Windows hosts", () => {
  it("fails a Linux-only event at once on a host whose SSH server is Windows, then refuses it when written", async () => {
    const { done, s, token, runbook } = await runOne(
      [ev("container", { name: "web", state: "running" })],
      (s) => s.setRemoteVer("OpenSSH_for_Windows_9.5"),
    );
    expect(done.items[0]).toMatchObject({
      status: "failed",
      result: "Windows host",
    });
    expect(done.items[0].error).toContain("needs a Linux host");
    expect(s.execCalls).toHaveLength(0);
    // Runbooks now knows host 1 is a Windows host.
    const added = await s.agent(
      "POST",
      `/runbooks/${runbook.id}/steps`,
      token,
      {
        steps: [seqStep([ev("unit", { name: "x.service", state: "active" })])],
      },
    );
    expect(added.status).toBe(400);
    expect(added.body.code).toBe("linux-only");
    expect(added.body.error).toContain(
      "is a Windows host, and a unit item reads systemd",
    );
    // port, http and file work there; another host is not affected.
    const ok = await s.agent("POST", `/runbooks/${runbook.id}/steps`, token, {
      steps: [
        seqStep([ev("file", { path: "/C:/ready.txt" })]),
        seqStep([ev("unit", { name: "x.service", state: "active" })], {
          hostId: 2,
        }),
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("refuses Linux-only events for a host tagged windows in Termix", async () => {
    const s = await testServer({
      hosts: [
        {
          id: 1,
          userId: "alice",
          name: "wyatt-pc",
          ip: "10.0.0.1",
          port: 22,
          username: "u",
          tags: "desktop, Windows",
          folder: null,
          authType: "key",
        },
        {
          id: 2,
          userId: "alice",
          name: "host-2",
          ip: "10.0.0.2",
          port: 22,
          username: "u",
          tags: null,
          folder: null,
          authType: "key",
        },
      ],
    });
    const token = await s.makeToken("lead", "alice", [1, 2]);
    const hosts = await s.agent("GET", "/hosts", token);
    expect(hosts.body.hosts ?? hosts.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, windows: true }),
      ]),
    );
    const made = await s.agent("POST", "/runbooks", token, {
      title: "Win",
      steps: [seqStep([ev("file", { path: "/x", sudo: true })])],
    });
    expect(made.status).toBe(400);
    expect(made.body.error).toContain(
      "wyatt-pc is a Windows host, and a file item with sudo runs sudo stat",
    );
  });
});

describe("values in events", () => {
  it("fills {{name}} in names, and refuses a filled name that is not one at run time", async () => {
    const { s, runbook } = await setupRunbook(
      [
        seqStep([
          {
            type: "run",
            command: "echo app=web",
            captures: [{ name: "app", pattern: "app=(\\S+)" }],
            // BUG-022 M3: a captured value goes into a command with a pattern.
            checks: [{ type: "value", name: "app", matches: "^[a-z]+$" }],
          },
          ev("container", { name: "{{app}}", state: "running" }),
        ]),
        seqStep([ev("container", { name: "{{bad}}", state: "running" })]),
      ],
      { values: { bad: "web; reboot" } },
    );
    s.setExec(async (_h, command) =>
      command.startsWith("docker")
        ? execResult(fixtures.dockerInspect["running-no-health"].stdout)
        : execResult("app=web\n"),
    );
    fake();
    const first = await start(s, runbook.id, runbook.steps[0].id);
    const done = await ended(s, runbook.id, first.id);
    expect(done.status).toBe("done");
    expect(s.execCalls[1].command).toBe(`${INSPECT}'web'`);
    const second = await start(s, runbook.id, runbook.steps[1].id);
    const refused = await ended(s, runbook.id, second.id);
    expect(refused.items[0].status).toBe("failed");
    expect(refused.items[0].error).toContain("name must be a container name");
    expect(s.execCalls).toHaveLength(2);
  });
});

/** openssl makes a CA and a server certificate for 127.0.0.1 and svc.test. */
function makeCerts(): { ca: string; cert: string; key: string } | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-tls-"));
    const run = (args: string[]) =>
      execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
    run([
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "2",
      "-subj",
      "/CN=Runbooks test CA",
    ]);
    run([
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "svc.key",
      "-out",
      "svc.csr",
      "-subj",
      "/CN=svc.test",
    ]);
    fs.writeFileSync(
      path.join(dir, "ext.cnf"),
      "subjectAltName=DNS:svc.test,IP:127.0.0.1\n",
    );
    run([
      "x509",
      "-req",
      "-in",
      "svc.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "svc.pem",
      "-days",
      "2",
      "-extfile",
      "ext.cnf",
    ]);
    const read = (name: string) =>
      fs.readFileSync(path.join(dir, name), "utf8");
    const out = {
      ca: read("ca.pem"),
      cert: read("svc.pem"),
      key: read("svc.key"),
    };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  } catch {
    return null;
  }
}

const certs = makeCerts();

describe.skipIf(!certs)("http over the SSH connection, TLS checked", () => {
  let server: https.Server | null = null;
  afterEach(async () => {
    await new Promise((resolve) =>
      server ? server.close(resolve) : resolve(null),
    );
    server = null;
  });

  async function serve(statuses: number[]): Promise<number> {
    let n = 0;
    server = https.createServer(
      { cert: certs!.cert, key: certs!.key },
      (req, res) => {
        const status = statuses[Math.min(n++, statuses.length - 1)];
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(status === 200 ? `ok ${req.headers.host}\n` : "starting\n");
      },
    );
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    return (server!.address() as net.AddressInfo).port;
  }

  /** Each channel is a TCP connection to the local server, as the host's loopback. */
  const toLocal = (port: number) => (s: TestServer) =>
    s.setForward(() => net.connect(port, "127.0.0.1"));

  it("waits on 503, passes on 200 with contains, verified against servername with the extra CA", async () => {
    const port = await serve([503, 200]);
    const { done, s } = await runOne(
      [
        ev("http", {
          url: `https://127.0.0.1:${port}/health`,
          servername: "svc.test",
          contains: "ok",
          every: 1,
          within: 30,
        }),
      ],
      toLocal(port),
      {
        fakeTimers: false,
        server: { settings: { [HTTP_CA_SETTING]: certs!.ca } },
      },
    );
    expect(done.status, JSON.stringify(done.items[0])).toBe("done");
    expect(results(done.items[0])).toEqual(["HTTP 503", "HTTP 200"]);
    expect(done.items[0].stdout).toContain(`ok 127.0.0.1:${port}`);
    expect(s.forwardCalls[0]).toEqual({ host: "127.0.0.1", port });
  });

  it("opens a localhost URL to the literal 127.0.0.1, and keeps localhost for the Host header (T-279)", async () => {
    const port = await serve([200]);
    const { done, s } = await runOne(
      [
        ev("http", {
          url: `https://localhost:${port}/health`,
          servername: "svc.test",
          contains: "ok",
          every: 1,
          within: 30,
        }),
      ],
      toLocal(port),
      {
        fakeTimers: false,
        server: { settings: { [HTTP_CA_SETTING]: certs!.ca } },
      },
    );
    expect(done.status, JSON.stringify(done.items[0])).toBe("done");
    expect(done.items[0].stdout).toContain(`ok localhost:${port}`);
    expect(s.forwardCalls).toEqual([{ host: "127.0.0.1", port }]);
  });

  it("never skips the check: without the extra CA the certificate is not trusted", async () => {
    const port = await serve([200]);
    const { done, s } = await runOne(
      [
        ev("http", {
          url: `https://127.0.0.1:${port}/`,
          servername: "svc.test",
          every: 1,
          within: 2,
        }),
      ],
      toLocal(port),
      { fakeTimers: false },
    );
    expect(done.items[0].status).toBe("failed");
    expect(results(done.items[0])[0]).toBe("certificate not trusted");
    // BUG-022 M2: an attempt's output is read on its own.
    const first = await attemptOutput(
      s,
      done.items[0].attempts[0],
      done.items[0].runId,
    );
    expect(first.stderr).toMatch(/certificate/i);
  });

  it("checks the name: a servername the certificate does not hold fails", async () => {
    const port = await serve([200]);
    const { done } = await runOne(
      [
        ev("http", {
          url: `https://127.0.0.1:${port}/`,
          servername: "other.test",
          every: 1,
          within: 2,
        }),
      ],
      toLocal(port),
      {
        fakeTimers: false,
        server: { settings: { [HTTP_CA_SETTING]: certs!.ca } },
      },
    );
    expect(results(done.items[0])[0]).toBe("certificate name mismatch");
  });
});

describe("http from Termix", () => {
  it("goes through ctx.fetch with the public roots and the extra CAs, no redirects", async () => {
    const calls: Array<{ url: string; init: Any }> = [];
    const { done } = await runOne(
      [ev("http", { url: "https://10.255.0.10/health", status: 204 })],
      () => {},
      {
        server: {
          fetch: async (url: string, init: Any) => {
            calls.push({ url, init });
            return new Response(null, { status: 204 });
          },
          settings: { [HTTP_CA_SETTING]: certs?.ca ?? "" },
        },
      },
    );
    expect(done.items[0]).toMatchObject({
      status: "passed",
      result: "HTTP 204",
    });
    expect(calls[0].url).toBe("https://10.255.0.10/health");
    // A private address that is not loopback: core may reach that one.
    expect(calls[0].init).toMatchObject({
      method: "GET",
      redirect: "manual",
      allowPrivateHosts: ["10.255.0.10"],
    });
    expect(calls[0].init.tls.rejectUnauthorized).toBeUndefined();
    if (certs) expect(calls[0].init.tls.ca).toContain(certs.ca.trim());
    expect(calls[0].init.tls.ca.length).toBeGreaterThan(100_000);
  });

  it("gives a public address no allowPrivateHosts: core refuses any private answer (BUG-022 M4)", async () => {
    const calls: Array<{ url: string; init: Any }> = [];
    const { done } = await runOne(
      [ev("http", { url: "https://192.0.2.10/health", status: 204 })],
      () => {},
      {
        server: {
          fetch: async (url: string, init: Any) => {
            calls.push({ url, init });
            return new Response(null, { status: 204 });
          },
        },
      },
    );
    expect(done.items[0]).toMatchObject({ status: "passed" });
    expect(calls[0].init.allowPrivateHosts).toBeUndefined();
  });
});

describe("http from Termix: addresses it does not reach", () => {
  it("refuses a name that leads to Termix's own loopback or a link-local address", async () => {
    const { newMemory, probe } =
      await import("../../src/backend/events/probes");
    let fetched = false;
    for (const address of ["127.0.0.1", "::1", "169.254.169.254"]) {
      const outcome = await probe({
        client: { exec: () => undefined },
        item: {
          type: "http",
          url: "https://looks-public.example/",
          status: 200,
          contains: null,
          servername: null,
          label: null,
          onFail: "stop",
          within: 60,
          attempts: null,
          timeoutMs: null,
          every: 5,
          backoff: "fixed",
          factor: 2,
          maxDelay: 300,
          jitter: "none",
        },
        workdir: null,
        since: 0,
        runId: 1,
        position: 1,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        memory: newMemory(),
        cas: async () => [],
        fetch: async () => {
          fetched = true;
          return new Response(null, { status: 200 });
        },
        lookup: async () => [{ address }],
      });
      expect(outcome).toMatchObject({
        verdict: "fail",
        result: "address refused",
      });
    }
    expect(fetched).toBe(false);
  });
});
