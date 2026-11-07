import { fileURLToPath } from "node:url";
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

export const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
export const manifest = manifestJson as unknown as PluginManifest;

export const ALL_PERMISSIONS = ["runbooks.use", "runbooks.manage-tokens"];

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
  execCalls: Array<{ host: unknown; command: string; options?: unknown }>;
  setExec: (fn: ExecFn) => void;
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
  /** Makes a Runbooks token as alice and returns the secret. */
  makeToken: (name?: string, user?: string) => Promise<string>;
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
  } = {},
): Promise<TestServer> {
  const db = await createTestDb(pluginDir);
  for (const user of ["alice", "bob"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }

  let router: Router | null = null;
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
  });

  const execCalls: TestServer["execCalls"] = [];
  let exec: ExecFn = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    truncated: false,
    timedOut: false,
  });
  (mock.ctx.ssh as { exec: ExecFn }).exec = async (h, command, opts) => {
    execCalls.push({ host: h, command, options: opts });
    return exec(h, command, opts);
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
    makeToken: async (name = "lead", user = "alice") => {
      const made = await server.person("POST", "/tokens", { name }, { user });
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

/** Runs a step the way the UI does: with what the view showed. */
export async function runStep(
  server: TestServer,
  runbookId: number,
  stepId: number,
  extra: Record<string, unknown> = {},
  mode: "run" | "terminal" = "run",
) {
  const shown = await view(server, runbookId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step = shown.steps.find((s: any) => s.id === stepId);
  return server.person("POST", `/steps/${stepId}/${mode}`, {
    revision: step.revision,
    commandHash: step.commandHash,
    ...extra,
  });
}
