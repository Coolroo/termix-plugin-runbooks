import { afterEach, describe, expect, it } from "vitest";
import type { PluginSshHost } from "@termix-ssh/plugin-sdk/backend";
import { isSshHost } from "../../src/shared/hosts";
import {
  agentRunbook,
  host,
  runStep,
  sshHost,
  startServer,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** Host 4 is a remote desktop host: its SSH switch is off. */
function desktopHost(id: number): PluginSshHost {
  return {
    ...sshHost(id, "dd44"),
    port: 3389,
    connectionType: "rdp",
    enableSsh: false,
  };
}

async function start() {
  server = await startServer({
    hosts: [host(1), host(2), host(3), host(4)],
    sshHosts: [
      sshHost(1, "aa11"),
      sshHost(2, null),
      { ...sshHost(3, "cc33"), connectionType: "rdp", enableSsh: true },
      desktopHost(4),
    ],
  });
  return server;
}

/** A token as 1.0.0 stored it: host 4 in its list, no SSH flags. */
async function oldToken(s: TestServer) {
  const token = await s.makeToken("old", "alice", [1]);
  s.db.sqlite.prepare("UPDATE p_runbooks_tokens SET hosts = ?").run(
    JSON.stringify([
      { id: 1, name: "host-1", address: "10.0.0.1", folder: "lab" },
      { id: 4, name: "host-4", address: "10.0.0.4", folder: "lab" },
    ]),
  );
  return token;
}

const ids = (body: Array<{ id: number }>) => body.map((h) => h.id);

describe("isSshHost", () => {
  it("follows the SSH switch, then the connection type", () => {
    expect(isSshHost({ enableSsh: true, connectionType: "rdp" })).toBe(true);
    expect(isSshHost({ enableSsh: false, connectionType: "ssh" })).toBe(false);
    expect(isSshHost({ enableSsh: 1 })).toBe(true);
    expect(isSshHost({ enableSsh: 0 })).toBe(false);
    expect(isSshHost({ connectionType: "vnc" })).toBe(false);
    expect(isSshHost({ connectionType: "ssh" })).toBe(true);
    expect(isSshHost({})).toBe(true);
    expect(isSshHost(null)).toBe(false);
  });
});

describe("SSH hosts only", () => {
  it("refuses a remote desktop host for a new token or a token's hosts", async () => {
    const s = await start();
    for (const hostIds of [[4], [1, 4]]) {
      const made = await s.person("POST", "/tokens", { name: "x", hostIds });
      expect(made.status).toBe(400);
      expect(made.body.error).toBe("host 4 is not an SSH host");
    }
    expect((await s.person("GET", "/tokens")).body).toEqual([]);

    // A host with SSH switched on is an SSH host, whatever its main protocol.
    const token = await s.makeToken("lead", "alice", [1, 3]);
    const id = (await s.person("GET", "/tokens")).body[0].id;
    const changed = await s.person("POST", `/tokens/${id}/hosts`, {
      hostIds: [1, 4],
    });
    expect(changed.status).toBe(400);
    expect(changed.body.error).toBe("host 4 is not an SSH host");
    expect(ids((await s.agent("GET", "/hosts", token)).body)).toEqual([1, 3]);
  });

  it("drops a remote desktop host from a 1.0.0 token once it is checked", async () => {
    const s = await start();
    const token = await oldToken(s);
    // The agent side cannot look hosts up; the old list stands until then.
    expect(ids((await s.agent("GET", "/hosts", token)).body)).toEqual([1, 4]);

    const listed = await s.person("GET", "/tokens");
    expect(listed.body[0].hosts).toEqual([
      { id: 1, name: "host-1", address: "10.0.0.1", folder: "lab", ssh: true },
      { id: 4, name: "host-4", address: "10.0.0.4", folder: "lab", ssh: false },
    ]);

    const hosts = await s.agent("GET", "/hosts", token);
    expect(hosts.body).toEqual([
      { id: 1, name: "host-1", address: "10.0.0.1", folder: "lab" },
    ]);
    const refused = await s.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [{ title: "a", hostId: 4, command: "uptime" }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("host 4 is not an SSH host");

    const runbook = await agentRunbook(s, token, {
      title: "y",
      steps: [{ title: "a", hostId: 1, command: "uptime" }],
    });
    const moved = await s.agent(
      "PATCH",
      `/steps/${runbook.steps[0].id}`,
      token,
      { hostId: 4 },
    );
    expect(moved.status).toBe(400);
    expect(moved.body.error).toContain("host 4 is not an SSH host");

    // MCP lists the same hosts.
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_hosts", arguments: {} },
    });
    expect(mcp.status).toBe(200);
    expect(JSON.stringify(mcp.body)).toContain("host-1");
    expect(JSON.stringify(mcp.body)).not.toContain("host-4");
  });

  it("refuses to run or send a step on a remote desktop host", async () => {
    const s = await start();
    const token = await oldToken(s);
    const runbook = await agentRunbook(s, token, {
      title: "Desktop",
      steps: [{ title: "a", hostId: 4, command: "uptime" }],
    });
    const stepId = runbook.steps[0].id;
    for (const mode of ["run", "terminal"] as const) {
      const ran = await runStep(s, runbook.id, stepId, {}, mode);
      expect(ran.status).toBe(400);
      expect(ran.body).toMatchObject({
        code: "not-ssh",
        error:
          "host 4 is not an SSH host; Runbooks runs commands over SSH only",
      });
    }
    expect(s.execCalls).toEqual([]);
    const count = s.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_runbooks_runs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});
