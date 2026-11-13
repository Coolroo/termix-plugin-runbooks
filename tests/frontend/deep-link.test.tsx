import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { toast } from "sonner";
import {
  navigation,
  parseRunbookId,
  createRunbookLink,
} from "../../src/frontend/runbooks/deep-link";
import { makeRunbook, useRenderedApp } from "./helpers";

const renderApp = useRenderedApp();
const PENDING_KEY = "termix-runbooks:open-runbook";

const realReplace = navigation.replace;

beforeEach(() => {
  sessionStorage.clear();
  navigation.replace = vi.fn();
});

afterEach(async () => {
  navigation.replace = realReplace;
  vi.restoreAllMocks();
});

const runbook = makeRunbook([], {
  id: 12,
  title: "Rotate logs",
  revision: 1,
  progress: { done: 0, failed: 0, total: 0 },
  summary: "Rotate the **logs**.",
});

function api(found = true) {
  return {
    get: vi.fn(async (url: string) => {
      if (url === "/runbooks") return { data: [runbook] };
      if (found && url === "/runbooks/12") return { data: runbook };
      throw { response: { status: 404, data: { error: "runbook not found" } } };
    }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

describe("runbook links", () => {
  it("takes only positive integer ids", () => {
    expect(parseRunbookId("12")).toBe(12);
    expect(parseRunbookId(12)).toBe(12);
    for (const bad of [
      "abc",
      "0",
      "-1",
      "1.5",
      "",
      "012",
      "1e3",
      " 1",
      "99999999999999999",
      null,
      undefined,
      0,
      2.5,
    ]) {
      expect(parseRunbookId(bad)).toBeNull();
    }
  });

  it("notes the id and goes on to the app", async () => {
    const rendered = await renderApp(undefined);
    const RunbookLink = createRunbookLink(rendered.app);
    render(
      <RunbookLink
        view="runbook"
        params={new URLSearchParams("view=runbook&id=12")}
      />,
    );
    expect(sessionStorage.getItem(PENDING_KEY)).toBe("12");
    expect(navigation.replace).toHaveBeenCalledWith("/");
  });

  it("ignores a bad id but still goes on to the app", async () => {
    const rendered = await renderApp(undefined);
    const RunbookLink = createRunbookLink(rendered.app);
    for (const id of ["abc", "-3", "0", "4.2"]) {
      render(
        <RunbookLink
          view="runbook"
          params={new URLSearchParams({ view: "runbook", id })}
        />,
      );
    }
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(navigation.replace).toHaveBeenCalledTimes(4);
  });

  it("opens the Runbooks tab on the noted runbook once the shell is ready", async () => {
    sessionStorage.setItem(PENDING_KEY, "12");
    const rendered = await renderApp(undefined, { ready: true });
    const opens = rendered.shellCalls.filter((c) => c.method === "openTab");
    expect(opens).toHaveLength(1);
    expect(opens[0].args[0]).toBeNull();
    expect(opens[0].args[1]).toBe("runbooks");
    expect(opens[0].args[2]).toMatchObject({
      data: { runbookId: 12, requestedAt: expect.any(Number) },
    });
    // Used once.
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("opens nothing for a bad noted id", async () => {
    sessionStorage.setItem(PENDING_KEY, "12; drop");
    const rendered = await renderApp(undefined, { ready: true });
    expect(rendered.shellCalls.some((c) => c.method === "openTab")).toBe(false);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("shows the linked runbook in the tab", async () => {
    const client = api();
    const rendered = await renderApp(client);
    rendered.renderTab("runbooks", {
      tab: {
        id: "runbooks",
        type: "runbooks",
        label: "Runbooks",
        data: { runbookId: 12, requestedAt: 1 },
      },
    });
    expect(
      await screen.findByText("logs", { selector: "strong" }),
    ).toBeTruthy();
    expect(client.get).toHaveBeenCalledWith("/runbooks/12");
  });

  it("falls back to the list when the runbook is not there", async () => {
    const error = vi.spyOn(toast, "error");
    const client = api(false);
    const rendered = await renderApp(client);
    rendered.renderTab("runbooks", {
      tab: {
        id: "runbooks",
        type: "runbooks",
        label: "Runbooks",
        data: { runbookId: 12, requestedAt: 2 },
      },
    });
    // The list shows instead, with the reason.
    expect(await screen.findByText("Rotate logs")).toBeTruthy();
    expect(error).toHaveBeenCalledWith(
      "Runbook 12 does not exist or is not available to you.",
    );
  });
});
