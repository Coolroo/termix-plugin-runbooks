import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import {
  endAllCaptures,
  type BufferLine,
} from "../../src/frontend/running/terminal-capture";
import type { Run, Runbook } from "../../src/frontend/api-types";
import {
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  useRenderedApp,
  type FakeApi,
} from "./helpers";

// The shell's tabs: the terminal tab carries SSH Terminal's handle.
const shell = vi.hoisted(() => ({
  tabs: {
    list: [] as Array<Record<string, unknown>>,
    setActive: (_id: string) => {},
  },
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>();
  return { ...actual, useShell: () => shell };
});

const COMMAND = "systemctl is-active nginx";
const PROMPT = "wyatt@web-1:~$ ";

const render = useRenderedApp();

/** A terminal screen with a prompt, and the handle SSH Terminal gives. */
function fakeTerminal() {
  const listeners = new Set<(data: string) => void>();
  const terminal = {
    lines: ["Welcome", PROMPT],
    listeners,
    handle: {
      readBufferLines: (): BufferLine[] =>
        terminal.lines.map((text, row) => ({
          text,
          firstRow: row,
          lastRow: row,
        })),
      subscribeOutput: (listener: (data: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isAtPasswordPrompt: vi.fn(() => false),
    },
    /** The host prints: raw to the listeners, plain lines to the screen. */
    print(raw: string, ...shown: string[]) {
      for (const listener of [...listeners]) listener(raw);
      terminal.lines.push(...shown);
    },
  };
  return terminal;
}

let terminal: ReturnType<typeof fakeTerminal>;

beforeEach(() => {
  terminal = fakeTerminal();
  shell.tabs.list = [{ id: "web", terminalRef: { current: terminal.handle } }];
  shell.tabs.setActive = vi.fn();
});

afterEach(() => {
  endAllCaptures();
  vi.restoreAllMocks();
});

const step = (runs: Run[] = []) =>
  makeStep({
    id: 2,
    position: 1,
    title: "Is nginx up",
    command: COMMAND,
    resolvedCommand: COMMAND,
    commandHash: "b".repeat(64),
    revision: 3,
    runs,
  });

const waiting = makeRun({
  id: 21,
  stepId: 2,
  mode: "terminal",
  status: "awaiting-output",
  command: COMMAND,
  exitCode: null,
  stdout: null,
  stderr: null,
  finishedAt: null,
});

const book = (runs: Run[] = []): Runbook =>
  makeRunbook([step(runs)], {
    title: "Check web",
    progress: { done: 0, failed: 0, total: 1, notNeeded: 0 },
    nextStepId: 2,
  });

/**
 * The runbook open, the terminal on web-1 open, and Send to terminal
 * pressed: the fake terminal shows the command typed after its prompt.
 */
async function sendIt(): Promise<FakeApi> {
  let sent = false;
  const client = fakeApi({
    detail: () => book(sent ? [waiting] : []),
    post: async (url) => {
      if (url === "/steps/2/terminal") {
        sent = true;
        return { data: waiting };
      }
      return { data: { ...waiting, status: "done" } };
    },
  });
  const rendered = await render(client, {
    hosts: [{ id: "1", name: "web-1", ip: "10.0.0.1", enableSsh: true }],
  });
  rendered.app.registerAction("terminal.listSessions", () => [
    { id: "web", hostId: 1, connected: true, visible: true },
  ]);
  rendered.app.registerAction("terminal.sendToSession", ((
    _id: string,
    text: string,
  ) => {
    terminal.lines[terminal.lines.length - 1] += text;
    for (const listener of [...terminal.listeners]) listener(text);
    return true;
  }) as never);
  rendered.renderTab("runbooks", { isVisible: true });
  fireEvent.click(await screen.findByText("Check web"));
  await screen.findByText(COMMAND);
  fireEvent.click(within(card()).getByText(locales.step.send));
  await vi.waitFor(() =>
    expect(card().querySelector("[data-paste-box]")).not.toBeNull(),
  );
  return client;
}

const card = () => document.querySelector('[data-step="2"]') as HTMLElement;
const box = () =>
  card().querySelector("[data-paste-box]") as HTMLTextAreaElement;

/** The person presses Enter: the host prints `lines`, then the prompt. */
function finish(...lines: string[]) {
  terminal.print(
    `\r\n${lines.map((line) => `${line}\r\n`).join("")}${PROMPT}`,
    ...lines,
    PROMPT,
  );
}

describe("Send to terminal leaves the paste box (1.4.12, BUG-024)", () => {
  it("says to paste, and never reads the terminal, which offers a handle", async () => {
    const success = vi.spyOn(toast, "success");
    await sendIt();
    expect(success).toHaveBeenCalledWith(
      "Typed into web-1. Press Enter there, then paste the output here.",
    );
    // No reading started: nothing follows the terminal's output.
    expect(terminal.listeners.size).toBe(0);

    finish("active");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(box().value).toBe("");
    expect(box().placeholder).toBe(locales.run.pastePlaceholder);
    expect(box().dataset.pasteBox).toBe("pasted");
    expect(card().querySelector("[data-capture]")).toBeNull();
  });

  it("sends what the person pasted, with outputSource pasted", async () => {
    const client = await sendIt();
    finish("active");
    fireEvent.change(box(), { target: { value: "active\n" } });
    fireEvent.click(within(card()).getByText(locales.run.markDone));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/complete", {
        pastedOutput: "active\n",
        outcome: "done",
        outputSource: "pasted",
      }),
    );
  });
});

describe("without a capture, the paste box is as before", () => {
  it("has no terminal handle (a future Termix, or plugin API 2)", async () => {
    shell.tabs.list = [{ id: "web" }];
    const success = vi.spyOn(toast, "success");
    const client = await sendIt();
    expect(success).toHaveBeenCalledWith(
      "Typed into web-1. Press Enter there, then paste the output here.",
    );
    expect(box().value).toBe("");
    expect(box().placeholder).toBe(locales.run.pastePlaceholder);
    expect(box().dataset.pasteBox).toBe("pasted");
    expect(card().querySelector("[data-capture]")).toBeNull();

    fireEvent.change(box(), { target: { value: "active\n" } });
    fireEvent.click(within(card()).getByText(locales.run.markDone));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/complete", {
        pastedOutput: "active\n",
        outcome: "done",
        outputSource: "pasted",
      }),
    );
  });

  it("after a reload: the run waits, the page has no capture", async () => {
    const client = fakeApi({ detail: book([waiting]) });
    const rendered = await render(client);
    rendered.renderTab("runbooks", { isVisible: true });
    fireEvent.click(await screen.findByText("Check web"));
    await screen.findByText(COMMAND);
    await vi.waitFor(() => expect(box()).not.toBeNull());
    expect(box().value).toBe("");
    expect(box().placeholder).toBe(locales.run.pastePlaceholder);
    expect(card().querySelector("[data-capture]")).toBeNull();
  });
});

describe("a run's kept output says where it came from", () => {
  it.each([
    ["captured", locales.run.source.captured],
    ["captured-edited", locales.run.source.capturedEdited],
    ["pasted", locales.run.pasted],
    [null, locales.run.pasted],
  ] as const)("outputSource %s", async (source, label) => {
    const done = makeRun({
      id: 21,
      stepId: 2,
      mode: "terminal",
      command: COMMAND,
      exitCode: null,
      stdout: null,
      stderr: null,
      pastedOutput: "active",
      outputSource: source,
    });
    const rendered = await render(fakeApi({ detail: book([done]) }));
    rendered.renderTab("runbooks", { isVisible: true });
    fireEvent.click(await screen.findByText("Check web"));
    await screen.findByText(COMMAND);
    expect(await within(card()).findByText(label)).toBeTruthy();
  });
});
