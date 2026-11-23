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

const filled = (text: string) =>
  vi.waitFor(() => expect(box().value).toBe(text), { timeout: 3000 });

describe("Send to terminal fills the paste box", () => {
  it("says its output comes back here, and fills the box as it prints", async () => {
    const success = vi.spyOn(toast, "success");
    await sendIt();
    expect(success).toHaveBeenCalledWith(
      "Typed into web-1. Press Enter there; its output comes back here for you to check.",
    );
    expect(box().placeholder).toBe(locales.capture.placeholder);
    // Nothing yet: no prompt after the output, so "check the end".
    expect(card().querySelector("[data-capture-state]")?.textContent).toBe(
      locales.capture.check,
    );
    expect(
      card().querySelector("[data-capture-warning='endUnsure']")?.textContent,
    ).toBe(locales.capture.endUnsure);

    finish("active");
    await filled("active");
    await vi.waitFor(() =>
      expect(card().querySelector("[data-capture-state]")?.textContent).toBe(
        locales.capture.finished,
      ),
    );
    expect(box().dataset.pasteBox).toBe("captured");
    expect(within(card()).getByText(locales.capture.from)).toBeTruthy();
    expect(card().querySelector("[data-capture-warning]")).toBeNull();
  });

  it("sends the text as read with outputSource captured", async () => {
    const client = await sendIt();
    finish("active");
    await filled("active");
    fireEvent.click(within(card()).getByText(locales.run.markDone));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/complete", {
        pastedOutput: "active",
        outcome: "done",
        outputSource: "captured",
      }),
    );
  });

  it("keeps the person's change, stops following, and Read again puts the terminal's text back", async () => {
    const client = await sendIt();
    finish("active");
    await filled("active");

    fireEvent.change(box(), { target: { value: "active (checked)" } });
    expect(box().dataset.pasteBox).toBe("captured-edited");
    expect(within(card()).getByText(locales.capture.edited)).toBeTruthy();
    // More output does not overwrite the change.
    terminal.lines.push("later line");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(box().value).toBe("active (checked)");

    fireEvent.click(within(card()).getByText(locales.run.markFailed));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/complete", {
        pastedOutput: "active (checked)",
        outcome: "failed",
        outputSource: "captured-edited",
      }),
    );
  });

  it("Read again reads the terminal now", async () => {
    await sendIt();
    finish("active");
    await filled("active");
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.click(within(card()).getByText(locales.capture.readAgain));
    expect(box().value).toBe("active");
    expect(box().dataset.pasteBox).toBe("captured");
    expect(within(card()).queryByText(locales.capture.edited)).toBeNull();
  });
});

describe("Mark failed sends the read text only once the person saw it (BUG-019)", () => {
  it("sends no output when the person never opened the box", async () => {
    const client = await sendIt();
    finish("active");
    await filled("active");
    expect(
      card().querySelector("[data-capture-failed-hint]")?.textContent,
    ).toBe(locales.capture.failedEmpty);
    fireEvent.click(within(card()).getByText(locales.run.markFailed));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/complete", {
        pastedOutput: "",
        outcome: "failed",
        outputSource: "pasted",
      }),
    );
  });

  it("sends the read text once the person opened the box", async () => {
    const client = await sendIt();
    finish("active");
    await filled("active");
    fireEvent.focus(box());
    expect(card().querySelector("[data-capture-failed-hint]")).toBeNull();
    fireEvent.click(within(card()).getByText(locales.run.markFailed));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/complete", {
        pastedOutput: "active",
        outcome: "failed",
        outputSource: "captured",
      }),
    );
  });

  it("Mark done sends the read text as before, opened or not", async () => {
    const client = await sendIt();
    finish("active");
    await filled("active");
    fireEvent.click(within(card()).getByText(locales.run.markDone));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/complete", {
        pastedOutput: "active",
        outcome: "done",
        outputSource: "captured",
      }),
    );
  });
});

describe("the reading", () => {
  it("stops once the prompt is back", async () => {
    await sendIt();
    finish("active");
    await filled("active");
    await vi.waitFor(() =>
      expect(card().querySelector("[data-capture-state]")?.textContent).toBe(
        locales.capture.finished,
      ),
    );
    const reads = terminal.handle.isAtPasswordPrompt.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(terminal.handle.isAtPasswordPrompt.mock.calls.length).toBe(reads);
  });

  it("warns, and never says finished, when the order is not sure", async () => {
    await sendIt();
    // The host moved the cursor between rows, and the screen has the
    // command twice: neither can place the output for sure.
    terminal.print(
      `\r\nactive\r\n\u001b[5;1H${PROMPT}`,
      "active",
      PROMPT + COMMAND,
      PROMPT,
    );
    await filled("active");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(card().querySelector("[data-capture-state]")?.textContent).toBe(
      locales.capture.check,
    );
    expect(
      card().querySelector("[data-capture-warning='drawn']")?.textContent,
    ).toBe(locales.capture.drawn);
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
