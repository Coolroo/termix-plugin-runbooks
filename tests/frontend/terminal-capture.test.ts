import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cutOutput,
  endAllCaptures,
  endCapture,
  hasCapture,
  isPromptLine,
  MAX_CAPTURES,
  RAW_MIN_MS,
  readCapture,
  readerFor,
  startCapture,
  type BufferLine,
} from "../../src/frontend/running/terminal-capture";
import { MAX_PASTED_CHARS } from "../../src/shared/limits";

/**
 * A terminal handle as SSH Terminal puts it on a tab: the screen as lines
 * (one row each unless `rows` says more), the raw output listeners, and
 * the password prompt flag.
 */
function fakeTerminal(screen: string[] = []) {
  const listeners = new Set<(data: string) => void>();
  const terminal = {
    lines: [...screen],
    /** Rows the scrollback dropped from the top so far. */
    dropped: 0,
    password: false,
    handle: {
      readBufferLines: vi.fn((): BufferLine[] =>
        terminal.lines.map((text, index) => ({
          text,
          firstRow: index,
          lastRow: index,
        })),
      ),
      subscribeOutput: vi.fn((listener: (data: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      isAtPasswordPrompt: vi.fn(() => terminal.password),
    },
    listeners,
    /** The host prints: raw to the listeners, plain lines to the screen. */
    print(raw: string, ...shown: string[]) {
      for (const listener of listeners) listener(raw);
      terminal.lines.push(...shown);
    },
    /** Text typed at the cursor, on the last line. */
    type(text: string) {
      terminal.lines[terminal.lines.length - 1] += text;
    },
    /** The scrollback drops its oldest `count` lines: rows move up. */
    scroll(count: number) {
      terminal.lines.splice(0, count);
      terminal.dropped += count;
    },
  };
  return terminal;
}

type Terminal = ReturnType<typeof fakeTerminal>;

/** The shell's tab list, with the terminal on tab `web`. */
function shellWith(terminal: Terminal | null, id = "web") {
  return {
    tabs: {
      list: [
        { id: "home" },
        { id, terminalRef: { current: terminal?.handle ?? null } },
      ],
    },
  };
}

function start(
  terminal: Terminal,
  command: string,
  options: { runId?: number; sessionId?: string; timeoutMs?: number } = {},
) {
  const shell = shellWith(terminal, options.sessionId ?? "web");
  return startCapture({
    runId: options.runId ?? 21,
    sessionId: options.sessionId ?? "web",
    command,
    reader: () => readerFor(shell, options.sessionId ?? "web"),
    timeoutMs: options.timeoutMs,
  });
}

afterEach(() => {
  endAllCaptures();
  vi.useRealTimers();
});

const LINUX_PROMPT = "wyatt@homepi:~$ ";
const COMMAND = "systemctl is-active nginx";

describe("finding the terminal", () => {
  it("reads the handle on the session's tab", () => {
    const terminal = fakeTerminal(["one", "two"]);
    const reader = readerFor(shellWith(terminal), "web");
    expect(reader?.lines()?.map((line) => line.text)).toEqual(["one", "two"]);
    expect(reader?.subscribe).toBeTypeOf("function");
    expect(reader?.atPasswordPrompt()).toBe(false);
  });

  it("has none without a shell, a tab, a handle or readBufferLines", () => {
    expect(readerFor(null, "web")).toBeNull();
    expect(readerFor({}, "web")).toBeNull();
    expect(readerFor({ tabs: { list: "no" } }, "web")).toBeNull();
    expect(readerFor(shellWith(fakeTerminal()), "other")).toBeNull();
    expect(readerFor(shellWith(null), "web")).toBeNull();
    // A future Termix whose handle reads no lines.
    const changed = {
      tabs: {
        list: [
          {
            id: "web",
            terminalRef: { current: { subscribeOutput: () => () => {} } },
          },
        ],
      },
    };
    expect(readerFor(changed, "web")).toBeNull();
  });

  it("never throws: a getter that throws, or a call that throws", () => {
    const hostile = {
      get tabs(): never {
        throw new Error("gone");
      },
    };
    expect(readerFor(hostile, "web")).toBeNull();
    const handle = {
      readBufferLines: () => {
        throw new Error("disposed");
      },
      isAtPasswordPrompt: () => {
        throw new Error("disposed");
      },
    };
    const reader = readerFor(
      { tabs: { list: [{ id: "web", terminalRef: { current: handle } }] } },
      "web",
    );
    expect(reader).not.toBeNull();
    expect(reader!.lines()).toBeNull();
    expect(reader!.atPasswordPrompt()).toBe(false);
    expect(reader!.subscribe).toBeNull();
  });

  it("drops lines of an unknown shape", () => {
    const handle = {
      readBufferLines: () => [
        { text: "ok", firstRow: 0, lastRow: 0 },
        { text: 5 },
        null,
        "text",
      ],
    };
    const reader = readerFor(
      { tabs: { list: [{ id: "web", terminalRef: { current: handle } }] } },
      "web",
    );
    expect(reader!.lines()).toEqual([{ text: "ok", firstRow: 0, lastRow: 0 }]);
  });
});

describe("a capture on Linux", () => {
  it("reads the output after the command, and sees the prompt come back", () => {
    const terminal = fakeTerminal([
      "Last login: today",
      LINUX_PROMPT.trimEnd(),
    ]);
    expect(start(terminal, COMMAND)).toBe(true);
    expect(hasCapture(21)).toBe(true);
    // Typed, before Enter: nothing yet.
    terminal.type(` ${COMMAND}`);
    expect(readCapture(21)).toMatchObject({
      text: "",
      finished: false,
      from: "screen",
    });

    terminal.print("\r\nactive\r\n", "active");
    expect(readCapture(21)).toMatchObject({ text: "active", finished: false });

    terminal.print(LINUX_PROMPT, LINUX_PROMPT.trimEnd());
    expect(readCapture(21)).toEqual({
      text: "active",
      finished: true,
      passwordPrompt: false,
      from: "screen",
      truncated: false,
    });
  });

  it("stops at the prompt: what the person ran after is not in it", () => {
    const terminal = fakeTerminal([LINUX_PROMPT.trimEnd()]);
    start(terminal, COMMAND);
    terminal.type(` ${COMMAND}`);
    terminal.lines.push(
      "active",
      `${LINUX_PROMPT}cat /etc/shadow`,
      "cat: /etc/shadow: Permission denied",
      LINUX_PROMPT.trimEnd(),
    );
    expect(readCapture(21)).toMatchObject({ text: "active", finished: true });
  });

  it("says when the terminal waits at a password prompt", () => {
    const terminal = fakeTerminal([LINUX_PROMPT.trimEnd()]);
    start(terminal, "sudo systemctl restart nginx");
    terminal.type(" sudo systemctl restart nginx");
    terminal.lines.push("[sudo] password for wyatt:");
    terminal.password = true;
    expect(readCapture(21)).toMatchObject({
      text: "[sudo] password for wyatt:",
      passwordPrompt: true,
      finished: false,
    });
    // The password is not echoed: the next lines are the command's own.
    terminal.password = false;
    terminal.lines.push(LINUX_PROMPT.trimEnd());
    expect(readCapture(21)).toMatchObject({
      text: "[sudo] password for wyatt:",
      passwordPrompt: false,
      finished: true,
    });
  });

  it("skips each line of a command of several lines", () => {
    const terminal = fakeTerminal([LINUX_PROMPT.trimEnd()]);
    start(terminal, "for host in a b; do\n  echo $host\ndone");
    terminal.type(" for host in a b; do");
    terminal.lines.push(">   echo $host", "> done", "a", "b", LINUX_PROMPT);
    expect(readCapture(21)).toMatchObject({ text: "a\nb", finished: true });
  });

  it("finds its line again after the scrollback dropped old lines", () => {
    const terminal = fakeTerminal(["old 1", "old 2", "old 3", LINUX_PROMPT]);
    start(terminal, COMMAND);
    terminal.type(COMMAND);
    terminal.lines.push("active");
    terminal.scroll(2);
    expect(readCapture(21)).toMatchObject({ text: "active", from: "screen" });
  });

  it("reads the raw copy once its line has left the scrollback", () => {
    const terminal = fakeTerminal([LINUX_PROMPT.trimEnd()]);
    start(terminal, "seq 1 3");
    terminal.type(" seq 1 3");
    // The host echoes the command, prints, and the prompt comes back.
    terminal.print(
      " seq 1 3\r\n\u001b[1m1\u001b[0m\r\n2\r\n3\r\n",
      "1",
      "2",
      "3",
    );
    terminal.print(LINUX_PROMPT, LINUX_PROMPT.trimEnd());
    terminal.scroll(3);
    expect(readCapture(21)).toEqual({
      text: "1\n2\n3",
      finished: true,
      passwordPrompt: false,
      from: "raw",
      truncated: false,
    });
  });

  it("reads the raw copy once the tab is closed", () => {
    const terminal = fakeTerminal([LINUX_PROMPT.trimEnd()]);
    let shell = shellWith(terminal);
    startCapture({
      runId: 21,
      sessionId: "web",
      command: COMMAND,
      reader: () => readerFor(shell, "web"),
    });
    terminal.print(` ${COMMAND}\r\nactive\r\n`);
    shell = { tabs: { list: [{ id: "home" }] } };
    expect(readCapture(21)).toMatchObject({ text: "active", from: "raw" });
  });
});

describe("a capture on Windows (cmd.exe, ConPTY)", () => {
  const PROMPT = "C:\\Users\\Wyatt>";
  // Runbook 66 steps 10 and 7b, and runbook 82 step 11's Read-Host.
  const WINDOWS_COMMAND =
    "powershell -NoProfile -Command \"$s = Read-Host 'Throwaway word' -AsSecureString; 'length=' + $s.Length\"";

  it("reads the screen lines: the password shows as stars only", () => {
    const terminal = fakeTerminal([
      "Microsoft Windows [Version 10.0.26100.2605]",
      "(c) Microsoft Corporation. All rights reserved.",
      "",
      PROMPT,
      "",
      "",
    ]);
    start(terminal, WINDOWS_COMMAND);
    // The prompt is the last line with text, not the empty rows below it.
    terminal.lines.splice(3, 1, PROMPT + WINDOWS_COMMAND);
    terminal.lines.splice(
      4,
      2,
      "Throwaway word: ********",
      "length=8",
      "",
      PROMPT,
      "",
    );
    expect(readCapture(21)).toMatchObject({
      text: "Throwaway word: ********\nlength=8",
      finished: true,
      from: "screen",
    });
  });

  it("cleans ConPTY's start codes in the raw copy", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, WINDOWS_COMMAND);
    // ConPTY repaints: clear, 39 empty rows, home, the title, then text.
    terminal.print(
      `${WINDOWS_COMMAND}\r\n` +
        "\u001b[?25l\u001b[2J\u001b[m\u001b[H" +
        "\r\n".repeat(39) +
        "\u001b[H\u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007\u001b[?25h" +
        "Throwaway word: \u001b[K********\r\nlength=8\r\n\u001b[K" +
        `\r\n${PROMPT}`,
    );
    terminal.scroll(1);
    expect(readCapture(21)).toMatchObject({
      text: "Throwaway word: ********\nlength=8",
      finished: true,
      from: "raw",
    });
  });
});

describe("limits", () => {
  it("cuts the screen text to what Mark done takes", () => {
    const terminal = fakeTerminal([LINUX_PROMPT]);
    start(terminal, "cat big");
    terminal.type("cat big");
    terminal.lines.push("x".repeat(MAX_PASTED_CHARS + 10));
    const read = readCapture(21)!;
    expect(read.text).toHaveLength(MAX_PASTED_CHARS);
    expect(read.truncated).toBe(true);
  });

  it("cuts the raw copy, and keeps its start", () => {
    const terminal = fakeTerminal([LINUX_PROMPT]);
    start(terminal, "cat big");
    terminal.print("cat big\r\n" + "y".repeat(MAX_PASTED_CHARS));
    terminal.print("z".repeat(100));
    terminal.scroll(1);
    const read = readCapture(21)!;
    expect(read.from).toBe("raw");
    expect(read.truncated).toBe(true);
    expect(read.text).not.toContain("z");
  });

  it("stops the raw copy after an hour, or the step's longer time limit", () => {
    vi.useFakeTimers();
    const terminal = fakeTerminal([LINUX_PROMPT]);
    start(terminal, COMMAND, { timeoutMs: 1000 });
    expect(terminal.listeners.size).toBe(1);
    vi.advanceTimersByTime(RAW_MIN_MS);
    expect(terminal.listeners.size).toBe(0);
    // The screen still reads.
    expect(hasCapture(21)).toBe(true);

    start(terminal, COMMAND, { runId: 22, timeoutMs: RAW_MIN_MS * 2 });
    vi.advanceTimersByTime(RAW_MIN_MS);
    expect(terminal.listeners.size).toBe(1);
    vi.advanceTimersByTime(RAW_MIN_MS);
    expect(terminal.listeners.size).toBe(0);
  });

  it("stops the older capture's raw copy when a new one starts on the session", () => {
    const terminal = fakeTerminal([LINUX_PROMPT]);
    start(terminal, COMMAND, { runId: 21 });
    start(terminal, COMMAND, { runId: 22 });
    expect(terminal.listeners.size).toBe(1);
    expect(hasCapture(21)).toBe(true);
    expect(hasCapture(22)).toBe(true);
  });

  it(`keeps ${MAX_CAPTURES} captures, ending the oldest`, () => {
    for (let index = 0; index <= MAX_CAPTURES; index++) {
      start(fakeTerminal([LINUX_PROMPT]), COMMAND, {
        runId: 100 + index,
        sessionId: `tab-${index}`,
      });
    }
    expect(hasCapture(100)).toBe(false);
    expect(hasCapture(101)).toBe(true);
    expect(hasCapture(100 + MAX_CAPTURES)).toBe(true);
  });
});

describe("no capture", () => {
  it("does not start without a terminal handle", () => {
    expect(
      startCapture({
        runId: 21,
        sessionId: "web",
        command: COMMAND,
        reader: () => readerFor(shellWith(null), "web"),
      }),
    ).toBe(false);
    expect(hasCapture(21)).toBe(false);
    expect(readCapture(21)).toBeNull();
  });

  it("has nothing after a reload (the page's captures are gone)", () => {
    const terminal = fakeTerminal([LINUX_PROMPT]);
    start(terminal, COMMAND);
    endAllCaptures();
    expect(readCapture(21)).toBeNull();
    expect(terminal.listeners.size).toBe(0);
  });

  it("ends after Mark done", () => {
    const terminal = fakeTerminal([LINUX_PROMPT]);
    start(terminal, COMMAND);
    endCapture(21);
    expect(hasCapture(21)).toBe(false);
    expect(terminal.listeners.size).toBe(0);
  });
});

describe("the cut", () => {
  it("counts a short prompt only on its own line", () => {
    expect(isPromptLine("$", "$")).toBe(true);
    expect(isPromptLine("$ 5 dollars", "$")).toBe(false);
    expect(isPromptLine("C:\\Users\\Wyatt>dir", "C:\\Users\\Wyatt>")).toBe(
      true,
    );
    expect(isPromptLine("anything", "")).toBe(false);
  });

  it("drops empty lines at both ends", () => {
    expect(cutOutput(["$ ls", "", "a", "", "b", "", ""], "$", "ls")).toEqual({
      text: "a\n\nb",
      finished: false,
    });
  });
});
