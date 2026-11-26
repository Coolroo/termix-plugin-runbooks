import { describe, expect, it } from "vitest";
import {
  agentRunbook,
  auditText,
  runStep,
  useTestServer,
  view,
  type TestServer,
} from "./helpers";

const startServer = useTestServer();

/** A server, alice's token and three runbooks in two folders and none. */
async function filed() {
  const s = await startServer();
  const token = await s.makeToken("lead");
  const loader = await agentRunbook(s, token, {
    title: "Try loader 0.48.1 on wyatt-pc",
    folder: "gbtvg-coop",
    steps: [{ title: "Start the game", hostId: 1, command: "echo start" }],
  });
  const mirror = await agentRunbook(s, token, {
    title: "Images through the mirror",
    folder: "  home-server ",
    steps: [{ title: "Pull", hostId: 1, command: "echo pull" }],
  });
  const loose = await agentRunbook(s, token, {
    title: "Pi-hole over IPv6",
    steps: [{ title: "Check", hostId: 1, command: "echo check" }],
  });
  return { s, token, loader, mirror, loose };
}

async function listed(s: TestServer) {
  return (await s.person("GET", "/runbooks")).body as Array<{
    id: number;
    folder: string | null;
    revision: number;
    updatedAt: string;
    status: string;
  }>;
}

async function rpc(s: TestServer, token: string, name: string, args: unknown) {
  const reply = await s.agent("POST", "/mcp", token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return reply.body.result;
}

describe("folders (1.4.10): the data", () => {
  it("keep a trimmed folder from create, and show it in every read", async () => {
    const { s, token, loader, mirror, loose } = await filed();
    expect(loader.folder).toBe("gbtvg-coop");
    expect(mirror.folder).toBe("home-server");
    expect(loose.folder).toBeNull();
    const rows = await listed(s);
    expect(rows.find((row) => row.id === mirror.id)?.folder).toBe(
      "home-server",
    );
    expect((await view(s, loader.id)).folder).toBe("gbtvg-coop");
    const agentList = await s.agent("GET", "/runbooks", token);
    expect(
      agentList.body.find((row: { id: number }) => row.id === loader.id).folder,
    ).toBe("gbtvg-coop");
    expect(
      (await s.agent("GET", `/runbooks/${loose.id}`, token)).body.folder,
    ).toBeNull();
  });

  it("refuse an empty name, one over 60 characters, a / and a control character", async () => {
    const s = await startServer();
    const token = await s.makeToken();
    for (const folder of [
      "",
      "   ",
      "x".repeat(61),
      "home-server/registry",
      "a\nb",
      7,
      ["termix"],
    ]) {
      const made = await s.agent("POST", "/runbooks", token, {
        title: "Bad folder",
        folder,
      });
      expect(made.status, JSON.stringify(folder)).toBe(400);
      expect(made.body.error).toMatch(/folder/);
    }
    // Exactly 60 is fine.
    const long = await agentRunbook(s, token, {
      title: "Long",
      folder: "x".repeat(60),
    });
    expect(long.folder).toHaveLength(60);
    // Nothing was made by the refused ones.
    expect((await s.agent("GET", "/runbooks", token)).body).toHaveLength(1);
  });

  it("reuse the spelling of a folder that exists, whatever the letters", async () => {
    const { s, token } = await filed();
    const again = await agentRunbook(s, token, {
      title: "Registry digests",
      folder: "HOME-SERVER",
    });
    expect(again.folder).toBe("home-server");
    // Another person's folders are not a token's to learn.
    const bobs = await s.makeToken("bob-agent", "bob");
    const bob = await agentRunbook(s, bobs, {
      title: "Bob's",
      folder: "HOME-SERVER",
    });
    expect(bob.folder).toBe("HOME-SERVER");
    // The list shows them as one folder, in the first spelling.
    expect((await s.person("GET", "/folders")).body).toEqual([
      "gbtvg-coop",
      "home-server",
    ]);
  });

  it("list the folders in use, A to Z, each spelling once", async () => {
    const { s } = await filed();
    const folders = await s.person("GET", "/folders");
    expect(folders.status).toBe(200);
    expect(folders.body).toEqual(["gbtvg-coop", "home-server"]);
  });
});

describe("folders (1.4.10): a person moves a runbook", () => {
  it("moves it, changes nothing else, and writes it in the audit log", async () => {
    const { s, mirror } = await filed();
    const before = (await listed(s)).find((row) => row.id === mirror.id)!;
    const moved = await s.person("POST", `/runbooks/${mirror.id}/folder`, {
      folder: "Registry",
    });
    expect(moved.status).toBe(200);
    expect(moved.body.folder).toBe("Registry");
    const after = (await listed(s)).find((row) => row.id === mirror.id)!;
    expect(after.folder).toBe("Registry");
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(auditText(s)).toContain("runbooks_runbook_folder");
    expect(auditText(s)).toContain(
      `runbook ${mirror.id} moved from \\"home-server\\" to \\"Registry\\"`,
    );
    // To no folder.
    const none = await s.person("POST", `/runbooks/${mirror.id}/folder`, {
      folder: null,
    });
    expect(none.body.folder).toBeNull();
    expect(auditText(s)).toContain("to no folder");
  });

  it("moves a done or an abandoned runbook without reopening it", async () => {
    const { s, loader, mirror } = await filed();
    await runStep(s, loader.id, loader.steps[0].id);
    await s.person("POST", `/runbooks/${loader.id}/status`, { status: "done" });
    await s.person("POST", `/runbooks/${mirror.id}/status`, {
      status: "abandoned",
    });
    for (const id of [loader.id, mirror.id]) {
      const before = await view(s, id);
      const moved = await s.person("POST", `/runbooks/${id}/folder`, {
        folder: "Archive",
      });
      expect(moved.status).toBe(200);
      const after = await view(s, id);
      expect(after.folder).toBe("Archive");
      expect(after.status).toBe(before.status);
      expect(after.revision).toBe(before.revision);
      expect(
        after.steps.map((step: { status: string }) => step.status),
      ).toEqual(before.steps.map((step: { status: string }) => step.status));
    }
  });

  it("joins an existing folder in its spelling, and audits nothing when nothing moves", async () => {
    const { s, loose } = await filed();
    const moved = await s.person("POST", `/runbooks/${loose.id}/folder`, {
      folder: "Home-Server",
    });
    expect(moved.body.folder).toBe("home-server");
    const lines = s.mock.audits.length;
    await s.person("POST", `/runbooks/${loose.id}/folder`, {
      folder: "home-server",
    });
    expect(s.mock.audits.length).toBe(lines);
  });

  it("refuses a bad name, a missing folder, an unknown runbook, an API key and no permission", async () => {
    const { s, loose } = await filed();
    const path = `/runbooks/${loose.id}/folder`;
    expect((await s.person("POST", path, { folder: "a/b" })).status).toBe(400);
    expect((await s.person("POST", path, {})).status).toBe(400);
    expect(
      (await s.person("POST", "/runbooks/999/folder", { folder: "x" })).status,
    ).toBe(404);
    expect(
      (await s.person("POST", path, { folder: "x" }, { apiKey: true })).status,
    ).toBe(403);
    const none = await startServer({ permissions: [] });
    expect((await none.person("POST", path, { folder: "x" })).status).toBe(403);
    expect((await none.person("GET", "/folders")).status).toBe(403);
    expect((await view(s, loose.id)).folder).toBeNull();
  });
});

describe("folders (1.4.10): a person renames a folder", () => {
  it("moves every runbook in it, any status, and writes one audit line", async () => {
    const { s, token, loader } = await filed();
    const second = await agentRunbook(s, token, {
      title: "Free disk space on test VM 2",
      folder: "GBTVG-coop",
    });
    await s.person("POST", `/runbooks/${second.id}/status`, {
      status: "abandoned",
    });
    const renamed = await s.person("POST", "/folders/rename", {
      from: "gbtvg-coop",
      to: " Ghostbusters mod ",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ folder: "Ghostbusters mod", moved: 2 });
    for (const id of [loader.id, second.id]) {
      expect((await view(s, id)).folder).toBe("Ghostbusters mod");
    }
    expect((await view(s, second.id)).status).toBe("abandoned");
    expect(await s.person("GET", "/folders")).toMatchObject({
      body: ["Ghostbusters mod", "home-server"],
    });
    const lines = s.mock.audits.filter(
      (line) => line.action === "runbooks_folder_rename",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].details).toContain(
      `folder "gbtvg-coop" renamed to "Ghostbusters mod"`,
    );
  });

  it("joins another folder in its spelling, and may change only the letters", async () => {
    const { s, loader, mirror } = await filed();
    const joined = await s.person("POST", "/folders/rename", {
      from: "gbtvg-coop",
      to: "HOME-SERVER",
    });
    expect(joined.body).toEqual({ folder: "home-server", moved: 1 });
    expect((await view(s, loader.id)).folder).toBe("home-server");
    const letters = await s.person("POST", "/folders/rename", {
      from: "home-server",
      to: "Home-Server",
    });
    expect(letters.body).toEqual({ folder: "Home-Server", moved: 2 });
    expect((await view(s, mirror.id)).folder).toBe("Home-Server");
  });

  it("refuses a folder nobody is in, bad names, an API key and no permission", async () => {
    const { s } = await filed();
    const missing = await s.person("POST", "/folders/rename", {
      from: "nope",
      to: "x",
    });
    expect(missing.status).toBe(404);
    for (const body of [
      { from: "termix" },
      { to: "x" },
      { from: "gbtvg-coop", to: null },
      { from: "gbtvg-coop", to: "a/b" },
      { from: "gbtvg-coop", to: "y".repeat(61) },
    ]) {
      expect(
        (await s.person("POST", "/folders/rename", body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      (
        await s.person(
          "POST",
          "/folders/rename",
          { from: "gbtvg-coop", to: "x" },
          { apiKey: true },
        )
      ).status,
    ).toBe(403);
    const none = await startServer({ permissions: [] });
    expect(
      (await none.person("POST", "/folders/rename", { from: "a", to: "b" }))
        .status,
    ).toBe(403);
    expect((await s.person("GET", "/folders")).body).toEqual([
      "gbtvg-coop",
      "home-server",
    ]);
  });
});

describe("folders (1.4.10): agents", () => {
  it("move a runbook with PATCH on any status, with nothing else changed, audited, and no event", async () => {
    const { s, token, loader } = await filed();
    await s.agent("PATCH", `/runbooks/${loader.id}`, token, {
      status: "done",
    });
    const before = (await s.agent("GET", `/runbooks/${loader.id}`, token)).body;
    const events = (await s.agent("GET", "/events", token)).body.events.length;
    const moved = await s.agent("PATCH", `/runbooks/${loader.id}`, token, {
      folder: "Ghostbusters mod",
    });
    expect(moved.status).toBe(200);
    expect(moved.body.folder).toBe("Ghostbusters mod");
    expect(moved.body.status).toBe("done");
    expect(moved.body.revision).toBe(before.revision);
    expect(moved.body.updatedAt).toBe(before.updatedAt);
    expect((await s.agent("GET", "/events", token)).body.events).toHaveLength(
      events,
    );
    expect(auditText(s)).toContain(
      `moved from \\"gbtvg-coop\\" to \\"Ghostbusters mod\\" by agent token \\"lead\\"`,
    );
    // null takes it out of every folder.
    const out = await s.agent("PATCH", `/runbooks/${loader.id}`, token, {
      folder: null,
    });
    expect(out.body.folder).toBeNull();
    // With other fields, those change as before.
    const both = await s.agent("PATCH", `/runbooks/${loader.id}`, token, {
      folder: "termix",
      title: "Try loader 0.48.2 on wyatt-pc",
    });
    expect(both.body.folder).toBe("termix");
    expect(both.body.title).toBe("Try loader 0.48.2 on wyatt-pc");
    expect(both.body.revision).toBe(before.revision + 1);
  });

  it("refuse a bad folder on PATCH and change nothing", async () => {
    const { s, token, mirror } = await filed();
    const bad = await s.agent("PATCH", `/runbooks/${mirror.id}`, token, {
      folder: "home-server/registry",
      title: "Changed",
    });
    expect(bad.status).toBe(400);
    const now = (await s.agent("GET", `/runbooks/${mirror.id}`, token)).body;
    expect(now.folder).toBe("home-server");
    expect(now.title).toBe("Images through the mirror");
  });

  it("list one folder, any spelling, or the runbooks in none (MCP null)", async () => {
    const { s, token, loader, mirror, loose } = await filed();
    const one = await s.agent("GET", "/runbooks?folder=GBTVG-COOP", token);
    expect(one.body.map((row: { id: number }) => row.id)).toEqual([loader.id]);
    const all = await s.agent("GET", "/runbooks?folder=", token);
    expect(all.body).toHaveLength(3);
    const bad = await s.agent("GET", "/runbooks?folder=a%2Fb", token);
    expect(bad.status).toBe(400);
    const mcp = await rpc(s, token, "list_runbooks", { folder: "home-server" });
    expect(
      JSON.parse(mcp.content[0].text).map((row: { id: number }) => row.id),
    ).toEqual([mirror.id]);
    const none = await rpc(s, token, "list_runbooks", { folder: null });
    expect(
      JSON.parse(none.content[0].text).map((row: { id: number }) => row.id),
    ).toEqual([loose.id]);
  });

  it("set and change the folder over MCP, as REST does", async () => {
    const s = await startServer();
    const token = await s.makeToken("lead");
    const made = await rpc(s, token, "create_runbook", {
      title: "OCI Hub phase 1",
      folder: "oci-hub",
    });
    expect(made.isError).toBe(false);
    const runbook = JSON.parse(made.content[0].text);
    expect(runbook.folder).toBe("oci-hub");
    const changed = await rpc(s, token, "update_runbook", {
      runbookId: runbook.id,
      folder: "OCI hub",
    });
    expect(JSON.parse(changed.content[0].text).folder).toBe("OCI hub");
    const refused = await rpc(s, token, "update_runbook", {
      runbookId: runbook.id,
      folder: "a/b",
    });
    expect(refused.isError).toBe(true);
  });
});

describe("the list state (1.4.10)", () => {
  it("is empty at first, keeps a person's choices, and is each person's own", async () => {
    const s = await startServer();
    expect((await s.person("GET", "/list-state")).body).toEqual({});
    const state = {
      "section:done": false,
      "section:open": true,
      "folder:open:termix": true,
      "folder:done:": true,
    };
    const put = await s.person("PUT", "/list-state", state);
    expect(put.status).toBe(200);
    expect(put.body).toEqual(state);
    expect((await s.person("GET", "/list-state")).body).toEqual(state);
    expect(
      (await s.person("GET", "/list-state", undefined, { user: "bob" })).body,
    ).toEqual({});
    expect(await s.mock.ctx.settings.getUser("alice", "listCollapsed")).toEqual(
      state,
    );
  });

  it("refuses what is not a list state, and drops a bad stored one", async () => {
    const s = await startServer();
    for (const bad of [
      [],
      "x",
      { "section:done": "yes" },
      { other: true },
      { [`folder:open:${"x".repeat(200)}`]: true },
      Object.fromEntries(
        Array.from({ length: 501 }, (_, i) => [`folder:open:${i}`, true]),
      ),
    ]) {
      expect((await s.person("PUT", "/list-state", bad)).status).toBe(400);
    }
    expect(
      await s.mock.validateSettings("user", { listCollapsed: { x: 1 } }),
    ).toEqual({ listCollapsed: expect.any(String) });
    expect(
      await s.mock.validateSettings("user", {
        listCollapsed: { "section:open": true },
      }),
    ).toEqual({});
    await s.mock.ctx.settings.setUser("alice", "listCollapsed", {
      "section:done": false,
      nope: true,
      "folder:open:a": "x",
    });
    expect((await s.person("GET", "/list-state")).body).toEqual({
      "section:done": false,
    });
  });

  it("needs Use Runbooks, and a person to change it", async () => {
    const none = await startServer({ permissions: [] });
    expect((await none.person("GET", "/list-state")).status).toBe(403);
    const s = await startServer();
    expect(
      (
        await s.person(
          "PUT",
          "/list-state",
          { "section:open": true },
          { apiKey: true },
        )
      ).status,
    ).toBe(403);
  });
});
