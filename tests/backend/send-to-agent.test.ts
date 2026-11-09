import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSIONS,
  agentRunbook,
  auditText,
  startServer,
  view,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const ON = {
  notifyEnabled: true,
  notifyUrl: "https://agents.example.test/hook",
};

async function setup(
  settings: Record<string, unknown> = ON,
  extra: Record<string, unknown> = {
    owner: { task: "T-3", agent: "session-3", label: "Lead" },
  },
) {
  const sent: Array<{ body: string }> = [];
  server = await startServer({
    permissions: ADMIN_PERMISSIONS,
    settings,
    fetch: async (_url, init) => {
      sent.push({ body: (init as { body: string }).body });
      return new Response(null, { status: 202 });
    },
  });
  await server.person("POST", "/admin/notify/secret");
  const token = await server.makeToken("lead");
  const runbook = await agentRunbook(server, token, {
    title: "Look",
    // Even a runbook that wants nothing else gets "sent".
    notify: ["runbook-done"],
    steps: [{ title: "Graph", hostId: 1, command: "uptime" }],
    ...extra,
  });
  return { s: server, token, runbook, sent };
}

const send = (s: TestServer, stepId: number, body: unknown, apiKey = false) =>
  s.person("POST", `/steps/${stepId}/send-to-agent`, body, { apiKey });

describe("Send to agent", () => {
  it("records a sent event with the note and delivers it without the note", async () => {
    const { s, token, runbook, sent } = await setup();
    const shown = await view(s, runbook.id);
    expect(shown.canSendToAgent).toBe(true);
    const note = "The graph looks odd after 10:05, private-note-text";
    const reply = await send(s, runbook.steps[0].id, { note });
    expect(reply.status).toBe(200);
    expect(reply.body.steps[0].sent).toEqual([
      {
        id: expect.any(Number),
        createdBy: "alice",
        createdAt: expect.any(String),
        note,
      },
    ]);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const body = JSON.parse(sent[0].body);
    expect(body).toMatchObject({
      type: "sent",
      stepId: runbook.steps[0].id,
      stepPosition: 1,
      hasNote: true,
      owner: { task: "T-3", agent: "session-3", label: "Lead" },
    });
    expect(sent[0].body).not.toContain("private-note-text");

    // The agent reads the note through the API.
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(read.body.events[0]).toMatchObject({
      type: "sent",
      note,
      createdBy: "alice",
    });
    expect(auditText(s)).toContain("runbooks_step_sent");
    expect(auditText(s)).not.toContain("private-note-text");

    // Without a note: no hasNote.
    await send(s, runbook.steps[0].id, {});
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(JSON.parse(sent[1].body).hasNote).toBeUndefined();
    expect((await view(s, runbook.id)).steps[0].sent[0].note).toBeNull();
  });

  it("takes a note of up to 500 characters", async () => {
    const { s, runbook } = await setup();
    const id = runbook.steps[0].id;
    expect((await send(s, id, { note: "n".repeat(501) })).status).toBe(400);
    expect((await send(s, id, { note: 5 })).status).toBe(400);
    expect((await send(s, id, { note: "n".repeat(500) })).status).toBe(200);
  });

  it("needs notifications on and a runbook with an owner", async () => {
    const off = await setup({ notifyUrl: ON.notifyUrl });
    expect((await view(off.s, off.runbook.id)).canSendToAgent).toBe(false);
    const refused = await send(off.s, off.runbook.steps[0].id, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("notify-off");
    await off.s.close();

    const ownerless = await setup(ON, {});
    expect((await view(ownerless.s, ownerless.runbook.id)).canSendToAgent).toBe(
      false,
    );
    const none = await send(ownerless.s, ownerless.runbook.steps[0].id, {});
    expect(none.status).toBe(409);
    expect(none.body.code).toBe("no-owner");
  });

  it("is a person's action: refused for an API key and absent for agents", async () => {
    const { s, token, runbook } = await setup();
    const key = await send(s, runbook.steps[0].id, {}, true);
    expect(key.status).toBe(403);
    const agent = await s.agent(
      "POST",
      `/steps/${runbook.steps[0].id}/send-to-agent`,
      token,
      {},
    );
    expect(agent.status).toBe(404);
  });
});
