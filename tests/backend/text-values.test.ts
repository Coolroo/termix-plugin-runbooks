import { describe, expect, it } from "vitest";
import {
  execResult,
  runStep,
  setupRunbook,
  useTestServer,
  view,
} from "./helpers";

useTestServer();

const setup = (
  steps: Array<Record<string, unknown>>,
  values: Record<string, string> = {},
  options: { secrets?: boolean } = {},
) => setupRunbook(steps, { title: "Tailnet", values, server: options });

describe("values in body, expect and where (1.4.3)", () => {
  it("fills an author value in a click step's body and expect", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Approve the route",
          body: "In the admin console, find `{{ts_ip}}` and approve it.",
          expect: "{{ts_ip}} shows **Connected**.",
        },
      ],
      { ts_ip: "100.64.0.7" },
    );
    const shown = (await view(s, runbook.id)).steps[0];
    expect(shown).toMatchObject({
      body: "In the admin console, find `{{ts_ip}}` and approve it.",
      resolvedBody: "In the admin console, find `100.64.0.7` and approve it.",
      expect: "{{ts_ip}} shows **Connected**.",
      resolvedExpect: "100.64.0.7 shows **Connected**.",
      resolvedWhere: null,
      textMissing: [],
      resolvedCommand: null,
      missing: [],
    });
  });

  it("fills a captured value, escaped outside code and raw inside it", async () => {
    const nasty = "[x](https://e.example) # *b* <i>";
    const { s, runbook } = await setup([
      {
        title: "Banner",
        hostId: 1,
        command: "cat /etc/banner",
        captures: [{ name: "banner", pattern: "^banner: (.+)$" }],
      },
      {
        title: "Compare",
        body: "It said {{banner}}.\n\n```\n{{banner}}\n```",
        expect: "Inline: `{{banner}}`",
        command: "Get-Content banner",
        where: "browser, {{banner}}",
      },
    ]);
    const before = (await view(s, runbook.id)).steps[1];
    expect(before.textMissing).toEqual(["banner"]);
    expect(before.resolvedBody).toBe(before.body);
    // A value missing from the text is not a command value.
    expect(before.missing).toEqual([]);

    s.setExec(async () => execResult(`banner: ${nasty}\n`));
    expect(
      (await runStep(s, runbook.id, runbook.steps[0].id)).body.status,
    ).toBe("done");
    const after = (await view(s, runbook.id)).steps[1];
    expect(after.resolvedBody).toBe(
      "It said \\[x\\]\\(https:<!---->//e.example\\) \\# \\*b\\* \\<i\\>.\n\n```\n[x](https://e.example) # *b* <i>\n```",
    );
    expect(after.resolvedExpect).toBe(
      "Inline: `[x](https://e.example) # *b* <i>`",
    );
    expect(after.resolvedWhere).toBe(`browser, ${nasty}`);
    expect(after.textMissing).toEqual([]);
    // The command is filled as before.
    expect(after.resolvedCommand).toBe("Get-Content banner");
  });

  it("lists every missing name once, in order, and leaves it as written", async () => {
    const { s, runbook } = await setup([
      {
        title: "Check",
        body: "Find {{a}} and {{b}}.",
        expect: "{{b}} then {{c}}",
        hostId: 1,
        command: "echo {{d}}",
      },
    ]);
    const shown = (await view(s, runbook.id)).steps[0];
    expect(shown.textMissing).toEqual(["a", "b", "c"]);
    expect(shown.missing).toEqual(["d"]);
    expect(shown.resolvedBody).toBe("Find {{a}} and {{b}}.");
    expect(shown.resolvedExpect).toBe("{{b}} then {{c}}");
  });

  it("does not stop a click step: Done and Failed work with a value missing", async () => {
    const { s, runbook } = await setup([
      { title: "Approve", body: "Approve {{ts_ip}}." },
      { title: "Check", body: "Check {{ts_ip}}." },
    ]);
    const done = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/manual`,
      { outcome: "done" },
    );
    expect(done.status).toBe(200);
    expect(done.body.steps[0].status).toBe("done");
    expect(done.body.steps[0].textMissing).toEqual(["ts_ip"]);
    const failed = await s.person(
      "POST",
      `/steps/${runbook.steps[1].id}/manual`,
      { outcome: "failed" },
    );
    expect(failed.status).toBe(200);
    expect(failed.body.steps[1].status).toBe("failed");
  });

  it("runs a command whose text has a missing value", async () => {
    const { s, runbook } = await setup([
      { title: "Up", body: "For {{later}}.", hostId: 1, command: "uptime" },
    ]);
    s.setExec(async () => execResult("up\n"));
    const ran = await runStep(s, runbook.id, runbook.steps[0].id);
    expect(ran.status).toBe(200);
    expect(ran.body.status).toBe("done");
  });

  it("gives agents the written and the resolved text, hidden values hidden", async () => {
    const { s, token, runbook } = await setup(
      [
        {
          title: "Key",
          hostId: 1,
          command: "make-key",
          captures: [{ name: "key_id", pattern: "id: (\\S+)" }],
          hideOutputFromAgents: true,
        },
        {
          title: "Approve",
          body: "Approve {{ts_ip}} with key {{key_id}}.",
          where: "admin console on {{ts_ip}}",
          command: "approve",
        },
      ],
      { ts_ip: "100.64.0.7" },
    );
    s.setExec(async () => execResult("id: k-secretish-42\n"));
    await runStep(s, runbook.id, runbook.steps[0].id);
    const read = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    const step = read.body.steps[1];
    expect(step).toMatchObject({
      body: "Approve {{ts_ip}} with key {{key_id}}.",
      resolvedBody: "Approve 100.64.0.7 with key \\[hidden by owner\\].",
      where: "admin console on {{ts_ip}}",
      resolvedWhere: "admin console on 100.64.0.7",
      resolvedExpect: "",
      textMissing: [],
    });
    expect(JSON.stringify(read.body)).not.toContain("k-secretish-42");
    // The person sees the value.
    expect((await view(s, runbook.id)).steps[1].resolvedBody).toBe(
      "Approve 100.64.0.7 with key k-secretish-42.",
    );

    // MCP get_runbook returns the same fields.
    const mcp = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_runbook", arguments: { runbookId: runbook.id } },
    });
    const fromMcp = mcp.body.result.structuredContent.steps[1];
    expect(fromMcp.resolvedBody).toBe(step.resolvedBody);
    expect(fromMcp.resolvedWhere).toBe(step.resolvedWhere);
  });

  it("never fills a secret: a secret's name stays a missing value", async () => {
    const { s, runbook } = await setup(
      [
        {
          title: "Make a token",
          hostId: 1,
          command: "make-token",
          secretCaptures: [{ name: "api_token", pattern: "token: (\\S+)" }],
        },
        {
          title: "Use it",
          body: "The token is {{api_token}}.",
          expect: "`{{api_token}}`",
        },
      ],
      {},
      { secrets: true },
    );
    s.setExec(async () => execResult("token: tk-9f8e7d6c5b4a\n"));
    expect(
      (await runStep(s, runbook.id, runbook.steps[0].id)).body.status,
    ).toBe("done");
    const shown = await view(s, runbook.id);
    expect(shown.steps[1].resolvedBody).toBe("The token is {{api_token}}.");
    expect(shown.steps[1].textMissing).toEqual(["api_token"]);
    expect(JSON.stringify(shown)).not.toContain("tk-9f8e7d6c5b4a");
  });
});
