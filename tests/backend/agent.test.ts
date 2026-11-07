import { afterEach, describe, expect, it } from "vitest";
import {
  agentRunbook,
  runStep,
  startServer,
  view,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const twoSteps = {
  title: "Restart web",
  summary: "Restart **nginx** on host 1.",
  values: { svc: "nginx" },
  steps: [
    {
      title: "Check status",
      hostId: 1,
      command: "systemctl status {{svc}}",
      expect: "active",
    },
    {
      title: "Restart",
      hostId: 1,
      command: "systemctl restart {{svc}}",
    },
  ],
};

describe("token auth", () => {
  it("opens only the agent routes to requests without a login", async () => {
    server = await startServer();
    expect(server.mock.httpRouters).toEqual([
      expect.objectContaining({ public: ["/agent/*"] }),
    ]);
  });

  it("refuses a missing, wrong or revoked token", async () => {
    server = await startServer();
    const missing = await server.agent("GET", "/hosts", null);
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toMatch(/Bearer/);

    const wrong = await server.agent("GET", "/hosts", "rbk_" + "A".repeat(43));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatch(/not valid/);

    const garbage = await server.agent("GET", "/hosts", "tmx_whatever");
    expect(garbage.status).toBe(401);

    const token = await server.makeToken();
    expect(token).toMatch(/^rbk_[A-Za-z0-9_-]{43}$/);
    expect((await server.agent("GET", "/hosts", token)).status).toBe(200);

    const listed = await server.person("GET", "/tokens");
    const id = listed.body[0].id;
    expect(listed.body[0]).not.toHaveProperty("tokenHash");
    expect(listed.body[0]).not.toHaveProperty("token");
    expect(listed.body[0].prefix).toBe(token.slice(0, 8));
    expect(listed.body[0].lastUsedAt).toBeTruthy();

    expect((await server.person("POST", `/tokens/${id}/revoke`)).status).toBe(
      200,
    );
    const revoked = await server.agent("GET", "/hosts", token);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toMatch(/revoked/);
  });

  it("stores only the hash of a token", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const rows = server.db.sqlite
      .prepare("SELECT * FROM p_runbooks_tokens")
      .all() as Array<Record<string, unknown>>;
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a token whose creator lost runbooks.use", async () => {
    server = await startServer({ permissions: ["runbooks.manage-tokens"] });
    const token = await server.makeToken();
    const refused = await server.agent("GET", "/hosts", token);
    expect(refused.status).toBe(403);
  });

  it("rate limits each token", async () => {
    server = await startServer();
    const token = await server.makeToken();
    let last = 0;
    for (let i = 0; i < 121; i++) {
      last = (await server.agent("GET", "/runbooks", token)).status;
    }
    expect(last).toBe(429);
    // Another token has its own budget.
    const other = await server.makeToken("other");
    expect((await server.agent("GET", "/runbooks", other)).status).toBe(200);
  });

  it("only person routes can make tokens", async () => {
    server = await startServer();
    const token = await server.makeToken();
    expect((await server.agent("POST", "/tokens", token, {})).status).toBe(404);
    // A person without manage-tokens cannot either.
    await server.close();
    server = await startServer({ permissions: ["runbooks.use"] });
    expect((await server.person("POST", "/tokens", { name: "x" })).status).toBe(
      403,
    );
  });
});

describe("agent API", () => {
  it("lists hosts without anything but id, name, address and folder", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const hosts = await server.agent("GET", "/hosts", token);
    expect(hosts.body[0]).toEqual({
      id: 1,
      name: "host-1",
      address: "10.0.0.1",
      folder: "lab",
    });
  });

  it("creates, reads and updates a runbook", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const created = await agentRunbook(server, token, twoSteps);
    expect(created).toMatchObject({
      title: "Restart web",
      status: "open",
      createdBy: "lead",
      progress: { done: 0, total: 2 },
    });
    expect(created.steps.map((s: { position: number }) => s.position)).toEqual([
      1, 2,
    ]);
    expect(created.steps[0].hostName).toBe("host-1");

    const updated = await server.agent(
      "PATCH",
      `/runbooks/${created.id}`,
      token,
      { values: { svc: "caddy" }, title: "Restart caddy" },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.revision).toBeGreaterThan(created.revision);
    const shown = await view(server, created.id);
    expect(shown.steps[0].resolvedCommand).toBe("systemctl status caddy");

    const listed = await server.agent("GET", "/runbooks?status=open", token);
    expect(listed.body).toHaveLength(1);
  });

  it("refuses a host the token's owner cannot use", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const refused = await server.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [{ title: "a", hostId: 99, command: "uptime" }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/host 99/);
  });

  it("refuses bad steps and bad captures", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const noHost = await server.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [{ title: "a", command: "uptime" }],
    });
    expect(noHost.status).toBe(400);
    const twoGroups = await server.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [
        {
          title: "a",
          hostId: 1,
          command: "uptime",
          captures: [{ name: "x", pattern: "(a)(b)" }],
        },
      ],
    });
    expect(twoGroups.status).toBe(400);
    expect(twoGroups.body.error).toMatch(/one capturing group/);
    const badName = await server.agent("POST", "/runbooks", token, {
      title: "x",
      values: { "1bad": "v" },
    });
    expect(badName.status).toBe(400);
  });

  it("keeps runbooks apart between token owners", async () => {
    server = await startServer();
    const alice = await server.makeToken("a", "alice");
    const bob = await server.makeToken("b", "bob");
    const created = await agentRunbook(server, alice, twoSteps);
    expect(
      (await server.agent("GET", `/runbooks/${created.id}`, bob)).status,
    ).toBe(404);
    expect((await server.agent("GET", "/runbooks", bob)).body).toEqual([]);
  });

  it("adds, edits, reorders and removes steps that have not run", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const created = await agentRunbook(server, token, twoSteps);
    const added = await server.agent(
      "POST",
      `/runbooks/${created.id}/steps`,
      token,
      { position: 1, steps: [{ title: "Read the docs" }] },
    );
    expect(added.status).toBe(201);
    expect(added.body.steps.map((s: { title: string }) => s.title)).toEqual([
      "Read the docs",
      "Check status",
      "Restart",
    ]);
    const [manual, check, restart] = added.body.steps;
    expect(manual.hostId).toBeNull();

    const edited = await server.agent("PATCH", `/steps/${check.id}`, token, {
      command: "systemctl is-active {{svc}}",
    });
    expect(edited.status).toBe(200);
    const shown = await view(server, created.id);
    expect(shown.steps[1].revision).toBe(2);

    const reordered = await server.agent(
      "POST",
      `/runbooks/${created.id}/reorder`,
      token,
      { stepIds: [check.id, manual.id, restart.id] },
    );
    expect(reordered.body.steps[0].id).toBe(check.id);

    const removed = await server.agent("DELETE", `/steps/${manual.id}`, token);
    expect(removed.status).toBe(200);
    expect(
      removed.body.steps.map((s: { position: number }) => s.position),
    ).toEqual([1, 2]);
  });

  it("cannot change, remove or insert before a step that ran", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const created = await agentRunbook(server, token, twoSteps);
    const first = created.steps[0].id;
    expect((await runStep(server, created.id, first)).status).toBe(200);

    const edit = await server.agent("PATCH", `/steps/${first}`, token, {
      command: "rm -rf /",
    });
    expect(edit.status).toBe(409);
    const remove = await server.agent("DELETE", `/steps/${first}`, token);
    expect(remove.status).toBe(409);
    const before = await server.agent(
      "POST",
      `/runbooks/${created.id}/steps`,
      token,
      { position: 1, steps: [{ title: "sneak in" }] },
    );
    expect(before.status).toBe(409);
    const reorder = await server.agent(
      "POST",
      `/runbooks/${created.id}/reorder`,
      token,
      { stepIds: [created.steps[1].id, first] },
    );
    expect(reorder.status).toBe(409);
    // The step that has not run can still change.
    const later = await server.agent(
      "PATCH",
      `/steps/${created.steps[1].id}`,
      token,
      { title: "Restart now" },
    );
    expect(later.status).toBe(200);
    expect(later.body.steps[0].editable).toBe(false);
  });

  it("can never run, complete, skip or note", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const created = await agentRunbook(server, token, twoSteps);
    const stepId = created.steps[0].id;
    const shown = await view(server, created.id);
    const body = {
      revision: shown.steps[0].revision,
      commandHash: shown.steps[0].commandHash,
    };

    // No agent route does any of this.
    for (const path of [
      `/steps/${stepId}/run`,
      `/steps/${stepId}/terminal`,
      `/steps/${stepId}/skip`,
      `/steps/${stepId}/note`,
      `/steps/${stepId}/reopen`,
      `/runs/1/complete`,
    ]) {
      expect((await server.agent("POST", path, token, body)).status).toBe(404);
    }

    // The person routes, called with only the agent's token and no login.
    const headers = { authorization: `Bearer ${token}` };
    for (const path of [
      `/steps/${stepId}/run`,
      `/steps/${stepId}/terminal`,
      `/steps/${stepId}/skip`,
      `/steps/${stepId}/note`,
      `/steps/${stepId}/reopen`,
      `/runs/1/complete`,
    ]) {
      const reply = await server.raw("POST", path, headers, body);
      expect(reply.status).toBe(401);
    }
    expect(server.execCalls).toHaveLength(0);
    // The agent cannot set the status of a step either.
    const sneaky = await server.agent("PATCH", `/steps/${stepId}`, token, {
      status: "done",
    });
    expect(sneaky.status).toBe(400);
  });

  it("hides output and captured values of hidden steps from agents", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const created = await agentRunbook(server, token, {
      title: "Secrets",
      steps: [
        {
          title: "Read key",
          hostId: 1,
          command: "cat /etc/key",
          captures: [{ name: "key", pattern: "key=(\\S+)" }],
        },
        { title: "Use key", hostId: 1, command: "use {{key}}" },
      ],
    });
    server.setExec(async () => ({
      stdout: "key=s3cr3t-value\n",
      stderr: "warn s3cr3t-value",
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const [read, use] = created.steps;
    // The person hides the first step.
    expect(
      (await server.person("POST", `/steps/${read.id}/hide`, { hidden: true }))
        .status,
    ).toBe(200);
    expect((await runStep(server, created.id, read.id)).status).toBe(200);
    expect((await runStep(server, created.id, use.id)).status).toBe(200);

    const seen = await server.agent("GET", `/runbooks/${created.id}`, token);
    const text = JSON.stringify(seen.body);
    expect(text).not.toContain("s3cr3t-value");
    expect(seen.body.steps[0].runs[0].stdout).toBe("[hidden by owner]");
    expect(seen.body.steps[0].runs[0].captured.key).toBe("[hidden by owner]");
    expect(seen.body.steps[1].runs[0].command).toBe("use [hidden by owner]");

    const values = await server.agent(
      "GET",
      `/runbooks/${created.id}/values`,
      token,
    );
    expect(values.body.values).toEqual([
      expect.objectContaining({ name: "key", value: "[hidden by owner]" }),
    ]);

    // The person sees it all.
    const shown = await view(server, created.id);
    expect(shown.steps[0].runs[0].stdout).toContain("s3cr3t-value");

    // The agent cannot lower the flag.
    const added = await server.agent(
      "POST",
      `/runbooks/${created.id}/steps`,
      token,
      { steps: [{ title: "Later", hideOutputFromAgents: true }] },
    );
    const lower = await server.agent(
      "PATCH",
      `/steps/${added.body.steps[2].id}`,
      token,
      { hideOutputFromAgents: false },
    );
    expect(lower.status).toBe(403);
  });
});

describe("MCP", () => {
  async function rpc(
    s: TestServer,
    token: string,
    method: string,
    params?: unknown,
    id: number | null = 1,
  ) {
    return s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      ...(id === null ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  it("initializes and lists the tools", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const init = await rpc(server, token, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result.protocolVersion).toBe("2025-03-26");
    expect(init.body.result.capabilities.tools).toBeTruthy();
    expect(init.body.result.serverInfo.name).toBe("termix-runbooks");

    const note = await rpc(
      server,
      token,
      "notifications/initialized",
      undefined,
      null,
    );
    expect(note.status).toBe(202);

    const tools = await rpc(server, token, "tools/list");
    const names = tools.body.result.tools.map((t: { name: string }) => t.name);
    for (const name of [
      "list_hosts",
      "list_runbooks",
      "get_runbook",
      "create_runbook",
      "update_runbook",
      "add_steps",
      "update_step",
      "remove_step",
      "get_values",
    ]) {
      expect(names).toContain(name);
    }
    for (const tool of tools.body.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
    expect((await rpc(server, token, "ping")).body.result).toEqual({});
    expect((await rpc(server, token, "nope")).body.error.code).toBe(-32601);
  });

  it("creates a runbook and reads it back through tools/call", async () => {
    server = await startServer();
    const token = await server.makeToken();
    const created = await rpc(server, token, "tools/call", {
      name: "create_runbook",
      arguments: twoSteps,
    });
    expect(created.body.result.isError).toBe(false);
    const runbook = JSON.parse(created.body.result.content[0].text);
    expect(runbook.steps).toHaveLength(2);

    await runStep(server, runbook.id, runbook.steps[0].id);

    const read = await rpc(server, token, "tools/call", {
      name: "get_runbook",
      arguments: { runbookId: runbook.id },
    });
    const body = read.body.result.structuredContent;
    expect(body.steps[0].status).toBe("done");
    expect(body.steps[0].runs[0]).toMatchObject({
      command: "systemctl status nginx",
      exitCode: 0,
      userId: "alice",
    });

    const refused = await rpc(server, token, "tools/call", {
      name: "update_step",
      arguments: { stepId: runbook.steps[0].id, command: "reboot" },
    });
    expect(refused.body.result.isError).toBe(true);
    expect(refused.body.result.content[0].text).toMatch(/409/);

    const unknown = await rpc(server, token, "tools/call", {
      name: "run_step",
      arguments: {},
    });
    expect(unknown.body.error.code).toBe(-32602);
  });

  it("needs the token too", async () => {
    server = await startServer();
    const reply = await server.agent("POST", "/mcp", null, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(reply.status).toBe(401);
  });
});
