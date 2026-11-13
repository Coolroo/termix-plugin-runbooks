import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import {
  OPEN_POLL_MS,
  OPEN_TIMEOUT_MS,
  pickNewSession,
  pickSession,
  PROMPT_SETTLE_MS,
} from "../../src/frontend/running/terminal";
import type { TerminalSession } from "../../src/frontend/api-types";
import {
  fakeApi,
  locales,
  makeRunbook,
  makeStep,
  useRenderedApp,
  type FakeApi,
} from "./helpers";

// The shell's tabs, for bringing the terminal to the front.
const shell = vi.hoisted(() => ({
  tabs: {
    list: [] as Array<{ id: string; parentSplitTabId?: string }>,
    setActive: (_id: string) => {},
  },
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>();
  return { ...actual, useShell: () => shell };
});

const COMMAND = "systemctl restart nginx";

const render = useRenderedApp();

beforeEach(() => {
  shell.tabs.list = [];
  shell.tabs.setActive = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const runbook = makeRunbook(
  [
    makeStep({
      id: 2,
      position: 1,
      title: "Restart",
      command: COMMAND,
      resolvedCommand: COMMAND,
      commandHash: "b".repeat(64),
      revision: 3,
    }),
  ],
  {
    title: "Restart web",
    progress: { done: 0, failed: 0, total: 1 },
    nextStepId: 2,
  },
);

const terminalRun = {
  id: 21,
  stepId: 2,
  runbookId: 7,
  mode: "terminal",
  status: "awaiting-output",
  hostId: 1,
  command: COMMAND,
};

const shown = { revision: 3, commandHash: "b".repeat(64) };

interface Fakes {
  client: FakeApi;
  sessions: TerminalSession[];
  open: ReturnType<typeof vi.fn>;
  sendToSession: ReturnType<typeof vi.fn>;
}

/**
 * The plugin with the SSH Terminal plugin's actions faked, open on the
 * runbook. Hosts come from the shell with string ids, as core gives them.
 */
async function setup(
  options: {
    sessions?: TerminalSession[];
    hosts?: Array<Record<string, unknown>>;
    post?: (url: string, body: unknown) => Promise<unknown>;
  } = {},
): Promise<Fakes> {
  const fakes: Fakes = {
    client: fakeApi({
      detail: runbook,
      post: options.post ?? (async () => ({ data: terminalRun })),
    }),
    sessions: options.sessions ?? [],
    open: vi.fn(),
    sendToSession: vi.fn(() => true),
  };
  const rendered = await render(fakes.client, {
    hosts: options.hosts ?? [
      { id: "1", name: "web-1", ip: "10.0.0.1", enableSsh: true },
    ],
  });
  const { app } = rendered;
  app.registerAction("terminal.listSessions", () =>
    fakes.sessions.map((session) => ({ ...session })),
  );
  app.registerAction("terminal.open", fakes.open as never);
  app.registerAction("terminal.sendToSession", fakes.sendToSession as never);
  rendered.renderTab("runbooks", { isVisible: true });
  fireEvent.click(await screen.findByText("Restart web"));
  await screen.findByText(COMMAND);
  return fakes;
}

function clickSend() {
  const card = document.querySelector('[data-step="2"]') as HTMLElement;
  fireEvent.click(within(card).getByText(locales.step.send));
}

describe("picking a session", () => {
  it("compares host ids as numbers and prefers a visible session", () => {
    const sessions: TerminalSession[] = [
      { id: "a", hostId: "1", connected: true, visible: true },
      { id: "b", hostId: 1, connected: true },
      { id: "c", hostId: 1, connected: false, visible: true },
      { id: "d", hostId: 2, connected: true, visible: true },
    ];
    expect(pickSession(sessions, 1)?.id).toBe("a");
    expect(pickSession(sessions.slice(1), "1")?.id).toBe("b");
    expect(pickSession(sessions, 3)).toBeNull();
  });

  it("takes the one new session when no new one names the host", () => {
    const before = new Set(["a"]);
    const old = { id: "a", hostId: 1, connected: true };
    expect(
      pickNewSession(
        [old, { id: "n", hostId: null, connected: true }],
        before,
        1,
      )?.id,
    ).toBe("n");
    expect(
      pickNewSession(
        [
          old,
          { id: "n", hostId: 5, connected: true },
          { id: "m", hostId: 6, connected: true },
        ],
        before,
        1,
      ),
    ).toBeNull();
    expect(
      pickNewSession(
        [old, { id: "n", hostId: 1, connected: false }],
        before,
        1,
      ),
    ).toBeNull();
  });
});

describe("send to terminal", () => {
  it("types into an open terminal with one click", async () => {
    const success = vi.spyOn(toast, "success");
    const fakes = await setup({
      sessions: [
        { id: "other", hostId: 2, connected: true, visible: true },
        { id: "web", hostId: 1, connected: true },
      ],
    });
    shell.tabs.list = [{ id: "web", parentSplitTabId: "split-1" }];
    clickSend();

    await vi.waitFor(() =>
      expect(fakes.sendToSession).toHaveBeenCalledWith("web", COMMAND, {
        run: false,
      }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fakes.open).not.toHaveBeenCalled();
    expect(fakes.client.post).toHaveBeenCalledTimes(1);
    expect(fakes.client.post).toHaveBeenCalledWith("/steps/2/terminal", shown);
    expect(shell.tabs.setActive).toHaveBeenCalledWith("split-1");
    expect(success).toHaveBeenCalledWith(
      "Typed into web-1. Press Enter there, then paste the output here.",
    );
  });

  it("opens a terminal, waits for it to connect, then types", async () => {
    const fakes = await setup({
      sessions: [{ id: "elsewhere", hostId: 2, connected: true }],
    });
    vi.useFakeTimers();
    const loading = vi.spyOn(toast, "loading");
    clickSend();
    await vi.advanceTimersByTimeAsync(0);

    expect(fakes.open).toHaveBeenCalledTimes(1);
    expect(fakes.open.mock.calls[0][0]).toMatchObject({ id: "1" });
    expect(loading).toHaveBeenCalledWith("Opening a terminal to web-1…");

    // The tab appears, then connects; nothing is recorded before that.
    fakes.sessions.push({ id: "new", hostId: 1, connected: false });
    await vi.advanceTimersByTimeAsync(OPEN_POLL_MS * 4);
    expect(fakes.client.post).not.toHaveBeenCalled();
    fakes.sessions[1].connected = true;
    await vi.advanceTimersByTimeAsync(OPEN_POLL_MS);
    // Connected: the prompt gets a moment to come up.
    expect(fakes.client.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROMPT_SETTLE_MS);

    expect(fakes.client.post).toHaveBeenCalledWith("/steps/2/terminal", shown);
    expect(fakes.sendToSession).toHaveBeenCalledWith("new", COMMAND, {
      run: false,
    });
  });

  it("gives up after the timeout without recording a run", async () => {
    const error = vi.spyOn(toast, "error");
    const fakes = await setup();
    vi.useFakeTimers();
    clickSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.open).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS + OPEN_POLL_MS * 2);
    expect(error).toHaveBeenCalledWith(
      "The terminal to web-1 did not connect in time. Copy the command instead.",
      expect.objectContaining({ id: expect.anything() }),
    );
    expect(fakes.client.post).not.toHaveBeenCalled();
    expect(fakes.sendToSession).not.toHaveBeenCalled();
  });

  it("asks about a repeat, then sends with the confirmation", async () => {
    let calls = 0;
    const fakes = await setup({
      sessions: [{ id: "web", hostId: 1, connected: true }],
      post: async () => {
        calls += 1;
        if (calls === 1) {
          throw {
            response: {
              status: 409,
              data: {
                error: "this step already ran",
                code: "repeat",
                repeat: {
                  userId: "bob",
                  startedAt: "2026-11-07T09:00:00.000Z",
                  exitCode: 0,
                  sameStep: true,
                  runbookId: 7,
                },
              },
            },
          };
        }
        return { data: terminalRun };
      },
    });
    clickSend();

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(locales.repeat.titleStep)).toBeTruthy();
    expect(fakes.sendToSession).not.toHaveBeenCalled();
    const again = within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(locales.repeat.again))!;
    fireEvent.click(again);

    await vi.waitFor(() =>
      expect(fakes.sendToSession).toHaveBeenCalledWith("web", COMMAND, {
        run: false,
      }),
    );
    expect(fakes.client.post).toHaveBeenLastCalledWith("/steps/2/terminal", {
      ...shown,
      confirmRepeat: true,
    });
  });

  it("says so when the terminal does not take the text", async () => {
    const error = vi.spyOn(toast, "error");
    const fakes = await setup({
      sessions: [{ id: "web", hostId: 1, connected: true }],
    });
    fakes.sendToSession.mockReturnValue(false);
    clickSend();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(locales.terminal.sendFailed),
    );
    expect(shell.tabs.setActive).not.toHaveBeenCalled();
  });

  it("does not open a terminal to a remote desktop host", async () => {
    const error = vi.spyOn(toast, "error");
    const fakes = await setup({
      hosts: [
        {
          id: "1",
          name: "web-1",
          ip: "10.0.0.1",
          connectionType: "rdp",
          enableSsh: false,
        },
      ],
    });
    clickSend();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "web-1 is not an SSH host, so it has no terminal to send to.",
      ),
    );
    expect(fakes.open).not.toHaveBeenCalled();
    expect(fakes.client.post).not.toHaveBeenCalled();
  });
});
