import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import express, { type Router } from "express";
import { inject } from "light-my-request";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type {
  PluginHostSummary,
  PluginSshExecOptions,
  PluginSshExecResult,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { createFakeSecrets, type FakeSecretsService } from "./fake-secrets";
import { createFakeHaw, type FakeHawService } from "./fake-haw";

export const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
export const manifest = manifestJson as unknown as PluginManifest;

export const ALL_PERMISSIONS = ["runbooks.use", "runbooks.manage-tokens"];
/** ALL_PERMISSIONS and core's admin.plugins.manage. */
export const ADMIN_PERMISSIONS = [...ALL_PERMISSIONS, "admin.plugins.manage"];

export function host(id: number, userId = "alice"): PluginHostSummary {
  return {
    id,
    userId,
    name: `host-${id}`,
    ip: `10.0.0.${id}`,
    port: 22,
    username: "root",
    tags: "secret-tag",
    folder: "lab",
    authType: "password",
  };
}

/** Host 1 has a stored host key; host 2 does not. */
export function sshHost(id: number, fingerprint: string | null): PluginSshHost {
  return {
    id,
    ip: `10.0.0.${id}`,
    port: 22,
    username: "root",
    userId: "alice",
    hostKeyFingerprint: fingerprint,
  };
}

export type ExecFn = (
  host: number | PluginSshHost,
  command: string,
  options?: PluginSshExecOptions,
) => Promise<PluginSshExecResult>;

/**
 * A command's channel as ssh2 hands it over: "data" for stdout, stderr's
 * "data", "close" with the exit code. close() and signal() are recorded.
 */
export class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  closed = false;
  signals: string[] = [];
  /** What was written to the command's standard input. */
  input: Buffer[] = [];
  /** Standard input was ended. */
  ended = false;
  out(text: string | Buffer): void {
    this.emit("data", Buffer.isBuffer(text) ? text : Buffer.from(text));
  }
  err(text: string | Buffer): void {
    this.stderr.emit("data", Buffer.isBuffer(text) ? text : Buffer.from(text));
  }
  exit(code: number | null): void {
    this.emit("close", code ?? undefined);
  }
  close(): void {
    this.closed = true;
  }
  signal(name: string): void {
    this.signals.push(name);
  }
  write(data: Buffer): void {
    this.input.push(Buffer.from(data));
  }
  end(): void {
    this.ended = true;
  }
  /** Standard input as text. */
  get stdin(): string {
    return Buffer.concat(this.input).toString("utf8");
  }
}

/**
 * Phase 3: what a forwardOut to the host's loopback gives: a stream (the
 * port is open), or ssh2's error with its reason (1: administratively
 * prohibited, 2: connect failed).
 */
export type ForwardFn = (
  host: string,
  port: number,
) => Duplex | (Error & { reason?: number });

/** Phase 3: what an SFTP stat gives: the attributes, or ssh2's error. */
export type SftpFn = (
  path: string,
) =>
  { mode: number; size: number } | { error: { code: number; message: string } };

/** Drives a command by hand: called once the command's channel is open. */
export type ChannelFn = (channel: FakeChannel, command: string) => void;

export interface Reply {
  status: number;
  // Route bodies vary per test; asserting on them is the point.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
}

export interface TestServer {
  db: TestDb;
  mock: MockPluginContext;
  /**
   * Every command started: the host, the command, the connect options and
   * the exec options (1.4.6: a pty for an interactive step).
   */
  execCalls: Array<{
    host: unknown;
    command: string;
    options?: unknown;
    execOptions?: { pty?: unknown };
  }>;
  /** Commands answer with this whole result: stdout, stderr, then the exit. */
  setExec: (fn: ExecFn) => void;
  /** Commands are driven by hand through their channel instead. */
  setChannel: (fn: ChannelFn | null) => void;
  /** Every command's channel, in order: what it got on standard input. */
  channels: FakeChannel[];
  /** The fake OpenBao Secrets service, when the server has one. */
  secrets: FakeSecretsService | null;
  /** The fake HAW VM service (1.4.7), when the server has one. */
  haw: FakeHawService | null;
  /** Connections opened and how many were disposed. */
  connections: { opened: number; disposed: number };
  /**
   * Phase 3: TCP channels to the host's loopback answer with this. The
   * default refuses them as Termix's key does today (reason 1).
   */
  setForward: (fn: ForwardFn) => void;
  /** Every forwardOut: the host and port it opened to. */
  forwardCalls: Array<{ host: string; port: number }>;
  /** Phase 3: SFTP stats answer with this (default: no such file). */
  setSftp: (fn: SftpFn) => void;
  /** Phase 3: the SSH server's version string the client keeps. */
  setRemoteVer: (version: string | undefined) => void;
  /** As a signed-in person (default alice). */
  person: (
    method: string,
    path: string,
    body?: unknown,
    options?: { user?: string; apiKey?: boolean },
  ) => Promise<Reply>;
  /** As an agent: no login, a bearer token or none. */
  agent: (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ) => Promise<Reply>;
  /** Any request, with exactly these headers. */
  raw: (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => Promise<Reply>;
  /** Makes a Runbooks token (default: alice, hosts 1-3) and returns the secret. */
  makeToken: (
    name?: string,
    user?: string,
    hostIds?: number[],
  ) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * The plugin activated against a real in-memory database, its router served
 * the way core serves it: JSON parsed, the acting user set from a login, and
 * no login at all for the agent routes. Requests are injected in process, so
 * no socket is opened.
 */
export async function startServer(
  options: {
    permissions?: string[];
    hosts?: PluginHostSummary[];
    sshHosts?: PluginSshHost[];
    /** Rows written before the plugin activates, as a stopped Termix left them. */
    seed?: (db: TestDb) => void;
    /** Provide a fake OpenBao Secrets service (default: none). */
    secrets?: boolean;
    /** Provide a fake HAW VM service, haw.vms (default: none). */
    haw?: boolean;
    /** The plugin's admin settings before it activates. */
    settings?: Record<string, unknown>;
    /** Answers ctx.fetch (default: every fetch rejects). */
    fetch?: (url: string, init?: unknown) => Promise<Response>;
  } = {},
): Promise<TestServer> {
  const db = await createTestDb(pluginDir);
  for (const user of ["alice", "bob"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }

  options.seed?.(db);

  let router: Router | null = null;
  let mockRef: MockPluginContext | null = null;
  const secrets = options.secrets ? createFakeSecrets(() => mockRef!) : null;
  const haw = options.haw ? createFakeHaw(() => mockRef!) : null;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ALL_PERMISSIONS,
    hosts: options.hosts ?? [host(1), host(2), host(3)],
    sshHosts: options.sshHosts ?? [
      sshHost(1, "aa11"),
      sshHost(2, null),
      sshHost(3, "cc33"),
    ],
    services: {
      ...(secrets ? { "openbao-secrets.store": secrets } : {}),
      ...(haw ? { "haw.vms": haw } : {}),
    },
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.fetch ? { fetch: options.fetch as never } : {}),
  });
  mockRef = mock;
  const channels: FakeChannel[] = [];

  const execCalls: TestServer["execCalls"] = [];
  let exec: ExecFn = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    truncated: false,
    timedOut: false,
  });
  let channelFn: ChannelFn | null = null;
  const connections = { opened: 0, disposed: 0 };
  // Phase 3: TCP channels and SFTP, as ssh2's client gives them.
  const forwardCalls: TestServer["forwardCalls"] = [];
  let forward: ForwardFn = () =>
    Object.assign(new Error("(SSH) Channel open failure: open failed"), {
      reason: 1,
    });
  let sftpStat: SftpFn = () => ({
    error: { code: 2, message: "No such file" },
  });
  let remoteVer: string | undefined = "OpenSSH_10.0p2";
  // Runbooks runs commands on a connection of its own from ctx.ssh.connect
  // and reads the channel as it streams; this client stands in for ssh2's.
  (mock.ctx.ssh as unknown as { connect: unknown }).connect = async (
    h: number | PluginSshHost,
    connectOptions?: unknown,
  ) => {
    connections.opened++;
    const client = {
      _remoteVer: remoteVer,
      forwardOut: (
        _srcIP: string,
        _srcPort: number,
        dstIP: string,
        dstPort: number,
        callback: (error: Error | undefined, stream?: Duplex) => void,
      ) => {
        forwardCalls.push({ host: dstIP, port: dstPort });
        const answer = forward(dstIP, dstPort);
        setImmediate(() =>
          answer instanceof Error
            ? callback(answer)
            : callback(undefined, answer),
        );
      },
      sftp: (
        callback: (
          error: Error | undefined,
          session: { stat: unknown; end: () => void },
        ) => void,
      ) => {
        callback(undefined, {
          stat: (
            path: string,
            done: (
              error: unknown,
              stats?: { mode: number; size: number },
            ) => void,
          ) => {
            const answer = sftpStat(path);
            setImmediate(() =>
              "error" in answer ? done(answer.error) : done(undefined, answer),
            );
          },
          end: () => {},
        });
      },
      exec: (
        command: string,
        execOptions: { pty?: unknown },
        callback: (error: Error | undefined, channel: FakeChannel) => void,
      ) => {
        execCalls.push({
          host: h,
          command,
          options: connectOptions,
          execOptions,
        });
        const channel = new FakeChannel();
        channels.push(channel);
        if (channelFn) {
          const drive = channelFn;
          callback(undefined, channel);
          drive(channel, command);
          return;
        }
        void exec(h, command).then(
          (result) => {
            callback(undefined, channel);
            if (result.stdout) channel.out(result.stdout);
            if (result.stderr) channel.err(result.stderr);
            channel.exit(result.code);
          },
          (error: Error) => callback(error, channel),
        );
      },
    };
    return {
      client,
      jumpClient: null,
      host: { id: typeof h === "number" ? h : h.id, ip: "", port: 22 },
      dispose: () => {
        connections.disposed++;
      },
    };
  };

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.header("x-test-user");
    if (req.header("x-test-api-key")) {
      (req as unknown as { apiKeyId: string }).apiKeyId = "key-1";
    }
    mock.setActor(user || undefined);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));

  async function call(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<Reply> {
    const response = await inject(app, {
      method: method as "GET",
      url: path,
      headers: {
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = response.payload;
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return {
      status: response.statusCode,
      body: parsed,
      headers: response.headers,
    };
  }

  const server: TestServer = {
    db,
    mock,
    execCalls,
    setExec: (fn) => {
      exec = fn;
    },
    setChannel: (fn) => {
      channelFn = fn;
    },
    connections,
    setForward: (fn) => {
      forward = fn;
    },
    forwardCalls,
    setSftp: (fn) => {
      sftpStat = fn;
    },
    setRemoteVer: (version) => {
      remoteVer = version;
    },
    channels,
    secrets,
    haw,
    person: (method, path, body, opts = {}) =>
      call(
        method,
        path,
        {
          "x-test-user": opts.user ?? "alice",
          ...(opts.apiKey ? { "x-test-api-key": "1" } : {}),
        },
        body,
      ),
    agent: (method, path, token, body) =>
      call(
        method,
        `/agent${path}`,
        token ? { authorization: `Bearer ${token}` } : {},
        body,
      ),
    raw: (method, path, headers, body) => call(method, path, headers, body),
    makeToken: async (name = "lead", user = "alice", hostIds = [1, 2, 3]) => {
      const made = await server.person(
        "POST",
        "/tokens",
        { name, hostIds },
        { user },
      );
      if (made.status !== 201) throw new Error(JSON.stringify(made.body));
      return made.body.token as string;
    },
    close: async () => {
      for (const dispose of [...mock.disposals].reverse()) {
        await Promise.resolve(dispose()).catch(() => {});
      }
      db.close();
    },
  };
  return server;
}

export type ServerOptions = Parameters<typeof startServer>[0];

/** Servers started through useTestServer, closed after each test. */
const started: TestServer[] = [];
let closesServers = false;

/** Starts a server that is closed after the test. See useTestServer. */
async function testServer(options?: ServerOptions): Promise<TestServer> {
  if (!closesServers) {
    throw new Error("call useTestServer() at the top of the test file");
  }
  const server = await startServer(options);
  started.push(server);
  // A test that closes its server itself takes it off the list.
  const close = server.close;
  server.close = async () => {
    const index = started.indexOf(server);
    if (index >= 0) started.splice(index, 1);
    await close();
  };
  return server;
}

/**
 * Call once at the top of a test file: every server started through the
 * function it returns, or through setupRunbook, is closed after the test.
 */
export function useTestServer(): typeof testServer {
  closesServers = true;
  afterEach(async () => {
    for (const server of started.splice(0)) await server.close();
  });
  return testServer;
}

/**
 * A server, a token and a runbook the agent made with `steps`: what most
 * tests start from. `extra` adds fields to the runbook; `server` are the
 * server's options. Needs useTestServer.
 */
export async function setupRunbook(
  steps: Array<Record<string, unknown>>,
  options: {
    title?: string;
    values?: Record<string, string>;
    owner?: Record<string, string>;
    extra?: Record<string, unknown>;
    server?: ServerOptions;
    tokenName?: string;
  } = {},
) {
  const s = await testServer(options.server);
  const token = await s.makeToken(options.tokenName);
  const runbook = await agentRunbook(s, token, {
    title: options.title ?? "Test",
    ...(options.values ? { values: options.values } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
    steps,
    ...options.extra,
  });
  return { s, token, runbook };
}

/** What a command answers: exit code 0 and no stderr unless given. */
export function execResult(
  stdout = "",
  options: { stderr?: string; code?: number | null } = {},
): PluginSshExecResult {
  return {
    stdout,
    stderr: options.stderr ?? "",
    code: options.code === undefined ? 0 : options.code,
    truncated: false,
    timedOut: false,
  };
}

/** A runbook from the agent side, returning its view. */
export async function agentRunbook(
  server: TestServer,
  token: string,
  body: Record<string, unknown>,
) {
  const created = await server.agent("POST", "/runbooks", token, body);
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  return created.body;
}

/** The person's view of a runbook. */
export async function view(server: TestServer, id: number) {
  const shown = await server.person("GET", `/runbooks/${id}`);
  if (shown.status !== 200) throw new Error(JSON.stringify(shown.body));
  return shown.body;
}

/** A run as the person view shows it now. */
export async function shownRun(
  server: TestServer,
  runbookId: number,
  runId: number,
) {
  const shown = await view(server, runbookId);
  for (const step of shown.steps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = step.runs.find((r: any) => r.id === runId);
    if (run) return run;
  }
  throw new Error(`run ${runId} not found`);
}

/** Waits until a run is no longer running and returns it. */
export async function waitForRun(
  server: TestServer,
  runbookId: number,
  runId: number,
) {
  return vi.waitFor(
    async () => {
      const run = await shownRun(server, runbookId, runId);
      if (run.status === "running") throw new Error("still running");
      return run;
    },
    { timeout: 3000, interval: 5 },
  );
}

/**
 * Runs a step the way the UI does: with what the view showed. A Run answers
 * at once with the run still running; unless `wait` is false this waits for
 * it to finish and puts the finished run in `body` (`started` holds the
 * first answer).
 */
export async function runStep(
  server: TestServer,
  runbookId: number,
  stepId: number,
  extra: Record<string, unknown> = {},
  mode: "run" | "terminal" = "run",
  options: { wait?: boolean } = {},
): Promise<Reply & { started?: Reply["body"] }> {
  const shown = await view(server, runbookId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step = shown.steps.find((s: any) => s.id === stepId);
  const reply = await server.person("POST", `/steps/${stepId}/${mode}`, {
    revision: step.revision,
    commandHash: step.commandHash,
    ...extra,
  });
  if (
    mode === "run" &&
    options.wait !== false &&
    reply.status === 200 &&
    reply.body?.status === "running"
  ) {
    const finished = await waitForRun(server, runbookId, reply.body.id);
    return { ...reply, started: reply.body, body: finished };
  }
  return reply;
}

/** Every row Runbooks keeps, as one text. */
export function everything(s: TestServer): string {
  return ["runbooks", "steps", "runs", "tokens", "events", "state"]
    .map((table) =>
      JSON.stringify(
        s.db.sqlite.prepare(`SELECT * FROM p_runbooks_${table}`).all(),
      ),
    )
    .join("\n");
}

/** The audit lines without the request object. */
export function auditText(s: TestServer): string {
  return JSON.stringify(
    s.mock.audits.map(({ request: _request, ...rest }) => rest),
  );
}

/**
 * One attempt with its output, as the page reads it when the person opens
 * it (BUG-022 M2): the views list attempts without output.
 */
export async function attemptOutput(
  server: TestServer,
  attempt: { id: number; itemId: number },
  runId: number,
) {
  const reply = await server.person(
    "GET",
    `/runs/${runId}/attempts/${attempt.id}`,
  );
  if (reply.status !== 200) throw new Error(JSON.stringify(reply.body));
  return reply.body as { stdout: string | null; stderr: string | null };
}
