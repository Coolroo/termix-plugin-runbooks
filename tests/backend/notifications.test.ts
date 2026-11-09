import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSIONS,
  agentRunbook,
  auditText,
  runStep,
  startServer,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

const URL_ = "https://agents.example.test/hook?key=abc123";
const ON = { notifyEnabled: true, notifyUrl: URL_ };

interface Sent {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    redirect: string;
    allowPrivateHosts: string[];
    tls?: { ca?: string; rejectUnauthorized?: boolean };
  };
}

/** A receiver that records each POST and answers `status` (or throws). */
function receiver() {
  const sent: Sent[] = [];
  let answer: number | Error = 204;
  return {
    sent,
    answer: (next: number | Error) => {
      answer = next;
    },
    fetch: async (url: string, init?: unknown) => {
      sent.push({ url, init: init as Sent["init"] });
      if (answer instanceof Error) throw answer;
      return new Response(null, { status: answer });
    },
  };
}

async function setup(
  settings: Record<string, unknown> = ON,
  options: { secret?: boolean } = {},
) {
  const hook = receiver();
  server = await startServer({
    permissions: ADMIN_PERMISSIONS,
    settings,
    fetch: hook.fetch,
  });
  let secret: string | null = null;
  if (options.secret !== false) {
    const made = await server.person("POST", "/admin/notify/secret");
    expect(made.status).toBe(200);
    secret = made.body.secret;
  }
  const token = await server.makeToken("lead");
  return { s: server, hook, secret, token };
}

const failing = async () => ({
  stdout: "secret-output-text",
  stderr: "boom",
  code: 1,
  truncated: false,
  timedOut: false,
});

/** Event rows as stored. */
function eventRows(s: TestServer) {
  return s.db.sqlite
    .prepare("SELECT * FROM p_runbooks_events ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

function verify(secret: string, sent: Sent): boolean {
  const header = sent.init.headers["X-Runbooks-Signature"];
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${match[1]}.${sent.init.body}`)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(match[2], "hex"),
  );
}

describe("agent notifications", () => {
  it("send nothing while the flag is off", async () => {
    const { s, hook, token } = await setup({ notifyUrl: URL_ });
    s.setExec(failing);
    const runbook = await agentRunbook(s, token, {
      title: "Off",
      steps: [{ title: "Fail", hostId: 1, command: "false" }],
    });
    await runStep(s, runbook.id, runbook.steps[0].id);
    await s.mock.runScheduled();
    expect(hook.sent).toHaveLength(0);
    const rows = eventRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].next_attempt_at).toBeNull();
  });

  it("POST each wanted event once, signed, with ids and labels only", async () => {
    const { s, hook, secret, token } = await setup();
    s.setExec(failing);
    const runbook = await agentRunbook(s, token, {
      title: "Deploy",
      owner: { task: "T-9", agent: "session-9", label: "Lead" },
      steps: [
        { title: "Fail", hostId: 1, command: "echo secret-command-text" },
        { title: "Agent", owner: "agent", command: "agent-command-text" },
      ],
    });
    await runStep(s, runbook.id, runbook.steps[0].id);
    await vi.waitFor(() => expect(hook.sent).toHaveLength(2));
    const [failed, turn] = hook.sent;

    expect(failed.url).toBe(URL_);
    expect(failed.init).toMatchObject({
      method: "POST",
      timeoutMs: 10_000,
      redirect: "error",
      allowPrivateHosts: ["agents.example.test"],
    });
    expect(failed.init.tls).toBeUndefined();
    expect(failed.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(failed.init.body);
    expect(failed.init.headers["X-Runbooks-Event"]).toBe(String(body.id));
    expect(verify(secret!, failed)).toBe(true);
    expect(verify("wrong", failed)).toBe(false);
    const t = Number(
      /t=(\d+)/.exec(failed.init.headers["X-Runbooks-Signature"])![1],
    );
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5);
    expect(body).toEqual({
      id: body.id,
      type: "step-failed",
      reason: "exit",
      runbookId: runbook.id,
      stepId: runbook.steps[0].id,
      stepPosition: 1,
      owner: { task: "T-9", agent: "session-9", label: "Lead" },
      openPath: `/?view=runbook&id=${runbook.id}`,
      at: expect.any(String),
    });
    expect(JSON.parse(turn.init.body)).toMatchObject({
      type: "agent-turn",
      stepPosition: 2,
    });
    for (const sent of hook.sent) {
      expect(sent.init.body).not.toContain("secret-output-text");
      expect(sent.init.body).not.toContain("secret-command-text");
      expect(sent.init.body).not.toContain("agent-command-text");
      expect(sent.init.body).not.toContain("boom");
    }

    // Delivered once: a later tick sends nothing again.
    await vi.waitFor(() =>
      expect(eventRows(s).every((row) => row.delivered_at)).toBe(true),
    );
    await s.mock.runScheduled();
    expect(hook.sent).toHaveLength(2);
    expect(eventRows(s)[0]).toMatchObject({
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
    });
    // The agent sees that it was delivered.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.events[0].deliveredAt).toEqual(expect.any(String));
  });

  it("deliver only the types the runbook's notify lists", async () => {
    const { s, hook, token } = await setup();
    s.setExec(failing);
    const runbook = await agentRunbook(s, token, {
      title: "Quiet",
      notify: ["runbook-done"],
      steps: [{ title: "Fail", hostId: 1, command: "false" }],
    });
    await runStep(s, runbook.id, runbook.steps[0].id);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    await vi.waitFor(() => expect(hook.sent).toHaveLength(1));
    await s.mock.runScheduled();
    expect(hook.sent).toHaveLength(1);
    expect(JSON.parse(hook.sent[0].init.body)).toMatchObject({
      type: "runbook-done",
      reason: "done",
      stepId: null,
    });
    // The step-failed event is there for the agent API, just not sent.
    expect(eventRows(s).map((row) => row.type)).toEqual([
      "step-failed",
      "runbook-done",
    ]);
  });

  it("retry after 1, 5, 30 and 120 minutes, then give up and keep the error", async () => {
    const { s, hook, token } = await setup();
    hook.answer(500);
    const runbook = await agentRunbook(s, token, {
      title: "Retry",
      steps: [{ title: "One" }],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start);
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "abandoned",
    });
    await vi.waitFor(() => expect(eventRows(s)[0].attempts).toBe(1));
    const waits = [1, 5, 30, 120];
    let at = start;
    for (const [index, minutes] of waits.entries()) {
      const row = eventRows(s)[0];
      expect(row.last_error).toBe("the receiver answered HTTP 500");
      expect(Date.parse(row.next_attempt_at as string) - at).toBe(
        minutes * 60_000,
      );
      // Not yet due: a tick sends nothing.
      await s.mock.runScheduled();
      expect(hook.sent).toHaveLength(index + 1);
      at += minutes * 60_000;
      vi.setSystemTime(at);
      await s.mock.runScheduled();
      expect(hook.sent).toHaveLength(index + 2);
    }
    const last = eventRows(s)[0];
    expect(last).toMatchObject({
      attempts: 5,
      next_attempt_at: null,
      delivered_at: null,
      last_error: "the receiver answered HTTP 500",
    });
    vi.setSystemTime(at + 24 * 60 * 60_000);
    await s.mock.runScheduled();
    expect(hook.sent).toHaveLength(5);
    // Every attempt carries the same event id, so a receiver can de-duplicate.
    expect(
      new Set(hook.sent.map((sent) => sent.init.headers["X-Runbooks-Event"]))
        .size,
    ).toBe(1);
  });

  it("keep a network error short and without the address's query", async () => {
    const { s, hook, token } = await setup();
    hook.answer(new Error(`connect ECONNREFUSED for ${URL_}`));
    const runbook = await agentRunbook(s, token, {
      title: "Down",
      steps: [{ title: "One" }],
    });
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    await vi.waitFor(() => expect(eventRows(s)[0].attempts).toBe(1));
    const error = eventRows(s)[0].last_error as string;
    expect(error).toContain("could not reach the receiver");
    expect(error).toContain("https://agents.example.test/hook");
    expect(error).not.toContain("abc123");
    expect(error.length).toBeLessThanOrEqual(200);
  });

  it("use the admin's CA, and never turn certificate checks off", async () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const { s, hook } = await setup({ ...ON, notifyCaPem: ca });
    const test = await s.person("POST", "/admin/notify/test");
    expect(test.body).toEqual({ ok: true, status: 204, error: null });
    expect(hook.sent[0].init.tls).toEqual({ ca });
  });

  it("refuse an http address when saved, and do not send to one", async () => {
    const { s, hook, token } = await setup({
      notifyEnabled: true,
      notifyUrl: "http://agents.example.test/hook",
    });
    const errors = await s.mock.validateSettings("admin", {
      notifyEnabled: true,
      notifyUrl: "http://agents.example.test/hook",
    });
    expect(errors.notifyUrl).toBe("The address must start with https://");
    expect(
      await s.mock.validateSettings("admin", {
        notifyEnabled: true,
        notifyUrl: "",
      }),
    ).toHaveProperty("notifyUrl");
    expect(
      await s.mock.validateSettings("admin", { notifyCaPem: "not a pem" }),
    ).toHaveProperty("notifyCaPem");
    expect(await s.mock.validateSettings("admin", ON)).toEqual({});

    const runbook = await agentRunbook(s, token, {
      title: "Plain",
      steps: [{ title: "One" }],
    });
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    await vi.waitFor(() => expect(eventRows(s)[0].attempts).toBe(1));
    expect(hook.sent).toHaveLength(0);
    expect(eventRows(s)[0].last_error).toContain("https://");
    const status = await s.person("GET", "/admin/notify");
    expect(status.body.problem).toContain("https://");
  });

  it("send nothing without a signing secret", async () => {
    const { s, hook, token } = await setup(ON, { secret: false });
    const runbook = await agentRunbook(s, token, {
      title: "No secret",
      steps: [{ title: "One" }],
    });
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    await vi.waitFor(() => expect(eventRows(s)[0].attempts).toBe(1));
    expect(hook.sent).toHaveLength(0);
    expect(eventRows(s)[0].last_error).toContain("no signing secret");
    const test = await s.person("POST", "/admin/notify/test");
    expect(test.body.ok).toBe(false);
    expect(test.body.error).toContain("no signing secret");
  });

  it("look for due deliveries on a timer", async () => {
    const { s } = await setup();
    expect(
      s.mock.scheduled.some((job) => job.kind === "every" && job.ms === 30_000),
    ).toBe(true);
  });
});

describe("the signing secret and the Test button", () => {
  it("show the secret once and keep it sealed", async () => {
    const { s, secret } = await setup();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const status = await s.person("GET", "/admin/notify");
    expect(status.body).toMatchObject({
      enabled: true,
      url: URL_,
      problem: null,
      secret: { set: true, madeBy: "alice", madeAt: expect.any(String) },
    });
    expect(JSON.stringify(status.body)).not.toContain(secret!);
    const stored = s.db.sqlite
      .prepare("SELECT * FROM p_runbooks_state")
      .all() as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(secret!);
    expect(auditText(s)).toContain("runbooks_notify_secret");
    expect(auditText(s)).not.toContain(secret!);

    // A new one replaces it; the old one no longer signs.
    const again = await s.person("POST", "/admin/notify/secret");
    expect(again.body.secret).not.toBe(secret);
    await s.person("POST", "/admin/notify/test");
  });

  it("Test sends a signed test event and says the status", async () => {
    const { s, hook, secret } = await setup({ notifyUrl: URL_ });
    // Test works while notifications are still off.
    const ok = await s.person("POST", "/admin/notify/test");
    expect(ok.body).toEqual({ ok: true, status: 204, error: null });
    const body = JSON.parse(hook.sent[0].init.body);
    expect(body).toMatchObject({
      id: 0,
      type: "test",
      runbookId: null,
      stepId: null,
      openPath: "/",
    });
    expect(hook.sent[0].init.headers["X-Runbooks-Event"]).toBe("0");
    expect(verify(secret!, hook.sent[0])).toBe(true);

    hook.answer(403);
    const refused = await s.person("POST", "/admin/notify/test");
    expect(refused.body).toEqual({ ok: false, status: 403, error: null });
    hook.answer(new Error("timeout"));
    const down = await s.person("POST", "/admin/notify/test");
    expect(down.body).toMatchObject({ ok: false, status: null });
    expect(down.body.error).toContain("timeout");
    expect(auditText(s)).toContain("runbooks_notify_test");
  });

  it("are for admins in the app only", async () => {
    server = await startServer({ settings: ON });
    for (const [method, path] of [
      ["GET", "/admin/notify"],
      ["POST", "/admin/notify/secret"],
      ["POST", "/admin/notify/test"],
    ]) {
      expect((await server.person(method, path)).status).toBe(403);
    }
    await server.close();
    server = await startServer({
      permissions: ADMIN_PERMISSIONS,
      settings: ON,
    });
    const key = await server.person("POST", "/admin/notify/secret", undefined, {
      apiKey: true,
    });
    expect(key.status).toBe(403);
    const anonymous = await server.raw("POST", "/admin/notify/secret", {});
    expect(anonymous.status).toBe(401);
    const token = await server.makeToken();
    const agent = await server.agent("POST", "/admin/notify/secret", token);
    expect(agent.status).toBe(404);
  });
});
