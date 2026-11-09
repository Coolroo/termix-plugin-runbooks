import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { formatWait } from "../../src/frontend/StepCard";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await rendered?.deactivate();
  rendered = null;
});

const summary = {
  id: 7,
  title: "Restart app",
  status: "open",
  createdBy: "lead",
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  revision: 4,
  progress: { done: 1, failed: 0, total: 3 },
};

function step(overrides: Record<string, unknown>) {
  return {
    runbookId: 7,
    body: "",
    hostId: 1,
    hostName: "web-1",
    command: "true",
    resolvedCommand: "true",
    commandHash: "a".repeat(64),
    missing: [],
    expect: "",
    captures: [],
    checks: [],
    hideOutputFromAgents: false,
    status: "pending",
    skipReason: null,
    ownerNote: "",
    timeoutMs: null,
    revision: 1,
    runs: [],
    wait: null,
    ...overrides,
  };
}

/** The server counts the wait down on the (fake) clock. */
function server(waitMs: number) {
  const until = Date.now() + waitMs;
  const runbook = () => ({
    ...summary,
    summary: "",
    values: {},
    effectiveValues: [],
    nextStepId: 2,
    steps: [
      step({ id: 1, position: 1, title: "Restart", status: "done" }),
      step({
        id: 2,
        position: 2,
        title: "Health check",
        commandHash: "b".repeat(64),
        wait: {
          previous: { id: 1, position: 1, title: "Restart" },
          seconds: 120,
          reason: "let the service restart",
          previousEnded: true,
          until: new Date(until).toISOString(),
          remainingMs: Math.max(0, until - Date.now()),
        },
      }),
      step({
        id: 3,
        position: 3,
        title: "Report",
        commandHash: "c".repeat(64),
        wait: {
          previous: { id: 2, position: 2, title: "Health check" },
          seconds: 300,
          reason: null,
          previousEnded: false,
          until: null,
          remainingMs: 0,
        },
      }),
    ],
  });
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : runbook(),
    })),
    post: vi.fn(async (): Promise<{ data: unknown }> => ({ data: {} })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
/** Lets time pass a second at a time, as a browser would render it. */
async function seconds(count: number) {
  for (let i = 0; i < count; i++) await flush(1000);
}
const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;

async function open(client: ReturnType<typeof server>, fake: boolean) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: client as never,
  });
  rendered.renderTab("runbooks", { isVisible: true });
  if (fake) {
    await flush();
    fireEvent.click(screen.getByText("Restart app"));
    await flush();
  } else {
    fireEvent.click(await screen.findByText("Restart app"));
    await screen.findByText("Health check");
  }
}

describe("wait timers in the UI", () => {
  it("counts down, then says the person can start", async () => {
    vi.useFakeTimers();
    const client = server(90_000);
    await open(client, true);

    const notice = () =>
      card(2).querySelector("[data-wait]") as HTMLElement | null;
    expect(notice()!.getAttribute("data-wait")).toBe("running");
    expect(notice()!.textContent).toBe(
      "Wait 1:30 before you start · let the service restart",
    );
    // Run and Send look not-yet but still work.
    const run = within(card(2)).getByText(locales.step.run).closest("button")!;
    expect(run.getAttribute("data-not-yet")).toBe("true");
    expect(run.disabled).toBe(false);

    await flush(1000);
    expect(notice()!.textContent).toBe(
      "Wait 1:29 before you start · let the service restart",
    );
    await seconds(60);
    expect(notice()!.textContent).toMatch(/^Wait 0:29 before you start/);
    await seconds(29);
    expect(notice()!.getAttribute("data-wait")).toBe("over");
    expect(notice()!.textContent).toBe("You can start now");
    expect(
      within(card(2))
        .getByText(locales.step.run)
        .closest("button")!
        .getAttribute("data-not-yet"),
    ).toBeNull();

    // A step whose previous step has not ended only says how long it waits.
    const later = card(3).querySelector("[data-wait]") as HTMLElement;
    expect(later.getAttribute("data-wait")).toBe("later");
    expect(later.textContent).toBe("Waits 5 min after step 2");
  });

  it("asks one question before an early Run, with Cancel first", async () => {
    const client = server(90_000);
    client.post.mockImplementation(async () => ({
      data: { id: 30, status: "running", running: true },
    }));
    await open(client, false);
    fireEvent.click(within(card(2)).getByText(locales.step.run));
    const dialog = await screen.findByRole("alertdialog");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(dialog.textContent).toContain(
      "The wait is not over: 1:30 left (let the service restart)",
    );
    // No separate "Run step 2?" first; the command is in this one.
    expect(dialog.textContent).not.toContain("Run step 2?");
    expect(within(dialog).getByText("true")).toBeTruthy();
    const cancel = dialog.querySelector("[data-early-cancel]") as HTMLElement;
    expect(document.activeElement).toBe(cancel);
    expect(
      (dialog.querySelector("[data-early-start]") as HTMLElement).className,
    ).toContain("text-warning");
    fireEvent.click(dialog.querySelector("[data-early-start]")!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/run", {
        revision: 1,
        commandHash: "b".repeat(64),
        waitAnyway: true,
      }),
    );
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Cancel or Esc", async () => {
    const client = server(90_000);
    await open(client, false);
    fireEvent.click(within(card(2)).getByText(locales.step.run));
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(dialog.querySelector("[data-early-cancel]")!);
    await vi.waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );
    const send = within(card(2))
      .getByText(locales.step.send)
      .closest("button")!;
    await vi.waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("asks the same question when the server says the wait is not over", async () => {
    const client = server(0);
    let calls = 0;
    client.post.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw {
          response: {
            status: 409,
            data: {
              error: "the runbook says to wait",
              code: "wait",
              remainingSeconds: 75,
              reason: "let the service restart",
            },
          },
        };
      }
      return { data: { id: 30, status: "running", running: true } };
    });
    await open(client, false);
    fireEvent.click(within(card(2)).getByText(locales.step.run));
    // Not waiting on this clock: the usual Run confirm first.
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog)
        .getAllByRole("button")
        .find((b) => b.textContent?.startsWith(locales.run.confirm))!,
    );
    await vi.waitFor(() => expect(client.post).toHaveBeenCalledTimes(1));
    await screen.findByText(
      "The wait is not over: 1:15 left (let the service restart)",
    );
    dialog = screen.getByRole("alertdialog");
    fireEvent.click(dialog.querySelector("[data-early-start]")!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/steps/2/run", {
        revision: 1,
        commandHash: "b".repeat(64),
        waitAnyway: true,
      }),
    );
  });
});

describe("formatWait", () => {
  it("writes hours, minutes and seconds", () => {
    expect(formatWait(45)).toBe("45 s");
    expect(formatWait(120)).toBe("2 min");
    expect(formatWait(90)).toBe("1 min 30 s");
    expect(formatWait(3900)).toBe("1 h 5 min");
  });
});

describe("a run started early", () => {
  it("says so in the step's run history", async () => {
    const client = server(0);
    const base = client.get.getMockImplementation()!;
    client.get.mockImplementation(async (url: string) => {
      const answer = await base(url);
      if (url === "/runbooks") return answer;
      const data = answer.data as { steps: Array<Record<string, unknown>> };
      data.steps[1].runs = [
        {
          id: 51,
          stepId: 2,
          runbookId: 7,
          mode: "exec",
          status: "done",
          hostId: 1,
          command: "true",
          commandHash: "b".repeat(64),
          userId: "alice",
          startedAt: "2026-11-07T10:01:00.000Z",
          finishedAt: "2026-11-07T10:01:01.000Z",
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
          pastedOutput: null,
          error: null,
          captured: {},
          running: false,
          startedEarlySeconds: 36,
        },
      ];
      return answer;
    });
    await open(client, false);
    await vi.waitFor(() =>
      expect(card(2).querySelector("[data-started-early]")?.textContent).toBe(
        "started 36 s early",
      ),
    );
  });
});
