import { afterEach, describe, expect, it } from "vitest";
import { agentRunbook, startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("step colors (1.4.1)", () => {
  it("refuse anything but #rgb or #rrggbb of a kind id on save, for admins and people", async () => {
    server = await startServer();
    const s = server;
    for (const scope of ["admin", "user"] as const) {
      expect(
        await s.mock.validateSettings(scope, {
          stepColors: { run: "#22c55e", lead: "#ABC", outside: "" },
        }),
      ).toEqual({});
      expect(
        await s.mock.validateSettings(scope, { stepColors: null }),
      ).toEqual({});
      for (const bad of [
        { run: "green" },
        { lead: "#12345" },
        { outside: "#fff;background:url(x)" },
        { app: "var(--accent)" },
        { finish: 7 },
        { "Not An Id": "#fff" },
        "#fff",
        ["#fff"],
      ]) {
        const errors = await s.mock.validateSettings(scope, {
          stepColors: bad,
        });
        expect(Object.keys(errors)).toEqual(["stepColors"]);
      }
    }
    // The notification checks still run beside them.
    expect(
      await s.mock.validateSettings("admin", {
        notifyUrl: "http://x",
        stepColors: { run: "#fff" },
      }),
    ).toEqual({ notifyUrl: expect.any(String) });
  });

  it("answer no colors when none is set: every kind keeps its default", async () => {
    server = await startServer();
    const colors = await server.person("GET", "/colors");
    expect(colors.status).toBe(200);
    expect(colors.body).toEqual({});
  });

  it("answer the admin's colors, and a person's own over them", async () => {
    server = await startServer({
      settings: { stepColors: { run: "#22C55E", lead: "#00f", app: "" } },
    });
    const s = server;
    await s.mock.ctx.settings.setUser("bob", "stepColors", {
      lead: "#a78bfa",
      app: "#123456",
    });
    const alice = await s.person("GET", "/colors");
    expect(alice.body).toEqual({ run: "#22c55e", lead: "#00f" });
    const bob = await s.person("GET", "/colors", undefined, { user: "bob" });
    expect(bob.body).toEqual({
      run: "#22c55e",
      lead: "#a78bfa",
      app: "#123456",
    });
  });

  it("drop a stored value that is not a color or not a kind, whatever wrote it", async () => {
    server = await startServer({
      settings: {
        stepColors: {
          run: "red;background:url(x)",
          finish: "#fff",
          nope: "#000",
        },
      },
    });
    await server.mock.ctx.settings.setUser("alice", "stepColors", {
      finish: "nope",
    });
    const colors = await server.person("GET", "/colors");
    // alice's value is no color: the admin's shows.
    expect(colors.body).toEqual({ finish: "#fff" });
    await server.mock.ctx.settings.setUser("alice", "stepColors", "#fff");
    expect((await server.person("GET", "/colors")).body).toEqual({
      finish: "#fff",
    });
  });

  it("need Use Runbooks", async () => {
    server = await startServer({ permissions: [] });
    const colors = await server.person("GET", "/colors");
    expect(colors.status).toBe(403);
  });
});

describe("the runbook list (1.4.1)", () => {
  it("names the kind of each runbook's next step", async () => {
    server = await startServer();
    const s = server;
    const token = await s.makeToken();
    const runbook = await agentRunbook(s, token, {
      title: "Kinds",
      steps: [
        { title: "Read", owner: "agent" },
        { title: "Check", hostId: 1, command: "uptime" },
        { title: "Finish the runbook" },
      ],
    });
    const kind = async () =>
      (await s.person("GET", "/runbooks")).body.find(
        (row: { id: number }) => row.id === runbook.id,
      ).nextKind;
    expect(await kind()).toBe("lead");
    await s.person("POST", `/steps/${runbook.steps[0].id}/skip`, {
      reason: "",
    });
    expect(await kind()).toBe("run");
    await s.person("POST", `/steps/${runbook.steps[1].id}/skip`, {
      reason: "",
    });
    expect(await kind()).toBe("finish");
    await s.person("POST", `/steps/${runbook.steps[2].id}/skip`, {
      reason: "",
    });
    expect(await kind()).toBeNull();
  });
});
