import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canBePrompt,
  endAllCaptures,
  endCapture,
  endCapturesOf,
  hasCapture,
  looksFinished,
  looksLikePrompt,
  MAX_CAPTURES,
  QUIET_MS,
  RAW_MIN_MS,
  readCapture,
  readerFor,
  screenOutput,
  startCapture,
  type BufferLine,
} from "../../src/frontend/running/terminal-capture";
import { MAX_PASTED_CHARS } from "../../src/shared/limits";

/**
 * A terminal handle as SSH Terminal puts it on a tab: the screen as lines
 * (one row each), the raw output listeners, and the password prompt flag.
 * The real terminal library is in terminal-capture-xterm.test.ts.
 */
function fakeTerminal(screen: string[] = [], subscribe = true) {
  const listeners = new Set<(data: string) => void>();
  const terminal = {
    lines: [...screen],
    password: false,
    handle: {
      readBufferLines: vi.fn((): BufferLine[] =>
        terminal.lines.map((text, index) => ({
          text,
          firstRow: index,
          lastRow: index,
        })),
      ),
      ...(subscribe
        ? {
            subscribeOutput: vi.fn((listener: (data: string) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            }),
          }
        : {}),
      isAtPasswordPrompt: vi.fn(() => terminal.password),
    },
    listeners,
    /** The host prints: raw to the listeners, plain lines to the screen. */
    print(raw: string, ...shown: string[]) {
      for (const listener of [...listeners]) listener(raw);
      terminal.lines.push(...shown);
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

const PROMPT = "wyatt@homepi:~$ ";
const COMMAND = "systemctl is-active nginx";

/** The step's command typed and run: echo, Enter, output. */
function run(terminal: Terminal, command: string, output: string) {
  terminal.print(command);
  terminal.print(`\r\n${output}`);
}

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
  it("reads the output after the command, and stops when the prompt is back", () => {
    const terminal = fakeTerminal(["Last login: today", PROMPT]);
    expect(start(terminal, COMMAND)).toBe(true);
    expect(hasCapture(21)).toBe(true);
    // Typed, before Enter: nothing yet.
    terminal.print(COMMAND);
    expect(readCapture(21)).toMatchObject({
      text: "",
      finished: false,
      startSure: true,
      from: "stream",
    });

    terminal.print("\r\nactive\r\n");
    expect(readCapture(21)).toMatchObject({ text: "active", finished: false });

    terminal.print(PROMPT);
    const read = readCapture(21)!;
    expect(read).toEqual({
      text: "active",
      finished: true,
      startSure: true,
      drawn: false,
      passwordPrompt: false,
      from: "stream",
      truncated: false,
      final: true,
    });
    expect(looksFinished(read)).toBe(true);
    // The copy stopped: what the person runs after is never read.
    expect(terminal.listeners.size).toBe(0);
  });

  it("never reads a command typed after the prompt", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    run(terminal, COMMAND, `active\r\n${PROMPT}`);
    terminal.print("cat /etc/shadow\r\ncat: Permission denied\r\n" + PROMPT);
    expect(readCapture(21)).toMatchObject({ text: "active", finished: true });
  });

  it("ends at the noted prompt with a command typed ahead", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    run(terminal, COMMAND, `active\r\n${PROMPT}ls\r\nfile\r\n`);
    expect(readCapture(21)).toMatchObject({ text: "active", finished: true });
  });

  it("finds the prompt when it arrives in two pieces", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    run(terminal, COMMAND, "active\r\nwyatt@homepi:");
    expect(readCapture(21)).toMatchObject({ finished: false });
    terminal.print("~$ ");
    expect(readCapture(21)).toMatchObject({ text: "active", finished: true });
  });

  it("says when the terminal waits at a password prompt", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "sudo systemctl restart nginx");
    run(
      terminal,
      "sudo systemctl restart nginx",
      "[sudo] password for wyatt: ",
    );
    terminal.password = true;
    expect(readCapture(21)).toMatchObject({
      text: "[sudo] password for wyatt:",
      passwordPrompt: true,
      finished: false,
    });
    // The password is not echoed: the next lines are the command's own.
    terminal.password = false;
    terminal.print(`\r\n${PROMPT}`);
    expect(readCapture(21)).toMatchObject({
      text: "[sudo] password for wyatt:",
      passwordPrompt: false,
      finished: true,
    });
  });

  it("skips each line of a command of several lines", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "for host in a b; do\n  echo $host\ndone");
    terminal.print("for host in a b; do\r\n>   echo $host\r\n> done");
    expect(readCapture(21)).toMatchObject({ text: "", finished: false });
    terminal.print(`\r\na\r\nb\r\n${PROMPT}`);
    expect(readCapture(21)).toMatchObject({ text: "a\nb", finished: true });
  });

  it("reads a progress line and a redrawn command as the terminal shows them", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "apt-get -y upgrade");
    // Readline draws the line again on Enter; the progress line uses CR.
    terminal.print(
      `apt-get -y upgrade\r${PROMPT}apt-get -y upgrade\r\n` +
        "Progress: [ 10%]\rProgress: [ 60%]\rProgress: [100%]\r\n" +
        `\u001b[1mDone\u001b[0m\r\n${PROMPT}`,
    );
    expect(readCapture(21)).toMatchObject({
      text: "Progress: [100%]\nDone",
      finished: true,
    });
  });

  it("warns when the command's line is not the command (the person changed it)", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "systemctl restart <unit>");
    run(terminal, "systemctl restart nginx", `done\r\n${PROMPT}`);
    const read = readCapture(21)!;
    expect(read).toMatchObject({
      text: "done",
      finished: true,
      startSure: false,
    });
    expect(looksFinished(read)).toBe(false);
  });
});

describe("the end of the output (finding 4)", () => {
  /** Runs the command, then the given prompt comes back. */
  function endsWith(prompt: string, noted = PROMPT, screen: string[] = []) {
    vi.useFakeTimers();
    const terminal = fakeTerminal([...screen, noted]);
    expect(start(terminal, "do-it")).toBe(true);
    run(terminal, "do-it", `line 1\r\nline 2\r\n${prompt}`);
    return terminal;
  }

  it.each([
    ["cd: a new directory", "wyatt@homepi:/etc$ "],
    ["su: root", "root@homepi:~# "],
    ["a virtual environment", "(venv) wyatt@homepi:~$ "],
    ["sh", "$ "],
    ["PowerShell", "PS C:\\Users\\Wyatt> "],
    ["zsh", "homepi% "],
  ])("a prompt that changed (%s) ends it once quiet", (_name, prompt) => {
    const terminal = endsWith(prompt);
    expect(readCapture(21)).toMatchObject({ finished: false });
    vi.advanceTimersByTime(QUIET_MS);
    expect(readCapture(21)).toMatchObject({
      text: "line 1\nline 2",
      finished: true,
      final: true,
    });
    expect(terminal.listeners.size).toBe(0);
  });

  it("output that pauses on a line like a prompt goes on", () => {
    vi.useFakeTimers();
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "cat nginx.conf");
    run(terminal, "cat nginx.conf", "# ");
    vi.advanceTimersByTime(QUIET_MS / 2);
    terminal.print("worker_processes auto;\r\n");
    vi.advanceTimersByTime(QUIET_MS);
    expect(readCapture(21)).toMatchObject({ finished: false });
    terminal.print(PROMPT);
    expect(readCapture(21)).toMatchObject({
      text: "# worker_processes auto;",
      finished: true,
    });
  });

  it("zsh's right-hand prompt: the noted prompt, with another time", () => {
    const noted = `wyatt@homepi ~ % ${" ".repeat(40)}10:42:01`;
    const terminal = fakeTerminal([noted]);
    start(terminal, "uptime");
    // zsh prints the prompt, moves right for RPROMPT, then comes back.
    run(
      terminal,
      "uptime",
      " 10:42:05 up 3 days\r\nwyatt@homepi ~ % \u001b[40C10:42:05\r\u001b[17C",
    );
    expect(readCapture(21)).toMatchObject({
      text: " 10:42:05 up 3 days",
      finished: true,
      startSure: true,
    });
  });

  it("starship on two lines: its top line is not output", () => {
    const terminal = fakeTerminal(["", "~/src on  main", "❯ "]);
    start(terminal, "make test");
    run(
      terminal,
      "make test",
      "ok 12 tests\r\n\r\n~/src on  main took 2s\r\n❯ ",
    );
    const read = readCapture(21)!;
    expect(read).toMatchObject({ text: "ok 12 tests", finished: true });
    expect(looksFinished(read)).toBe(true);
  });

  it("powerlevel10k on two lines, with a right-hand prompt", () => {
    const terminal = fakeTerminal([
      `╭─ ~/src  main ${" ".repeat(30)}✔ 10:42`,
      "╰─❯ ",
    ]);
    start(terminal, "make test");
    run(
      terminal,
      "make test",
      `ok\r\n╭─ ~/src  main \u001b[30C✔ 10:43\r\n╰─❯ `,
    );
    expect(readCapture(21)).toMatchObject({ text: "ok", finished: true });
  });

  it("no prompt yet: not finished, and the reading goes on", () => {
    vi.useFakeTimers();
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "journalctl -f");
    run(terminal, "journalctl -f", "Nov 23 nginx[1]: started\r\n");
    vi.advanceTimersByTime(QUIET_MS * 10);
    const read = readCapture(21)!;
    expect(read).toMatchObject({
      text: "Nov 23 nginx[1]: started",
      finished: false,
      final: false,
    });
    expect(looksFinished(read)).toBe(false);
    expect(terminal.listeners.size).toBe(1);
  });

  it.each([
    [
      "a tmux status line",
      '[0] 0:bash*                "homepi" 10:42 23-Nov-26',
    ],
    ["a MOTD still printing", "  System load:  0.08"],
    ["a program waiting", "Continue? [Y/n]"],
    ["nothing", ""],
  ])("starts no capture when the last line is %s", (_name, line) => {
    const terminal = fakeTerminal([PROMPT, line]);
    expect(start(terminal, COMMAND)).toBe(line === "");
    if (line !== "") expect(hasCapture(21)).toBe(false);
  });

  it("knows a prompt from other lines", () => {
    expect(canBePrompt("wyatt@homepi:~$ ")).toBe(true);
    expect(canBePrompt("C:\\Users\\Wyatt>")).toBe(true);
    expect(canBePrompt("❯")).toBe(true);
    expect(canBePrompt(`me ~ % ${" ".repeat(20)}10:42`)).toBe(true);
    expect(canBePrompt("Welcome to Ubuntu")).toBe(false);
    expect(looksLikePrompt("root@homepi:~# ")).toBe(true);
    // Printed without the space after the symbol: output, not a prompt.
    expect(looksLikePrompt("Progress: 100%")).toBe(false);
    expect(looksLikePrompt("<html>")).toBe(false);
    expect(looksLikePrompt("total  ")).toBe(false);
  });
});

describe("the screen, only as a fallback", () => {
  it("reads the screen when the terminal gives no raw output", () => {
    const terminal = fakeTerminal([PROMPT], false);
    start(terminal, COMMAND);
    terminal.lines[0] = PROMPT + COMMAND;
    terminal.lines.push("active");
    expect(readCapture(21)).toMatchObject({
      text: "active",
      finished: false,
      from: "screen",
    });
    terminal.lines.push(PROMPT);
    expect(readCapture(21)).toMatchObject({
      text: "active",
      finished: true,
      final: true,
    });
  });

  it("needs exactly one line with the command", () => {
    const lines = [
      PROMPT + COMMAND,
      "inactive",
      PROMPT + COMMAND,
      "active",
      PROMPT,
    ];
    expect(screenOutput(lines, PROMPT, COMMAND)).toBeNull();
    expect(screenOutput(lines.slice(2), PROMPT, COMMAND)).toEqual({
      text: "active",
      finished: true,
    });
    // A longer command that starts the same is another command.
    expect(
      screenOutput([`${PROMPT}${COMMAND} --quiet`, "x"], PROMPT, COMMAND),
    ).toBeNull();
  });

  it("keeps the last read when the screen's line is gone or not alone", () => {
    const terminal = fakeTerminal([PROMPT], false);
    start(terminal, COMMAND);
    terminal.lines[0] = PROMPT + COMMAND;
    terminal.lines.push("act");
    expect(readCapture(21)).toMatchObject({ text: "act", finished: false });
    terminal.lines.splice(0, 2);
    expect(readCapture(21)).toMatchObject({ text: "act", finished: false });
  });
});

describe("a capture on Windows (cmd.exe, ConPTY)", () => {
  const CMD = "C:\\Users\\Wyatt>";
  // Runbook 66 steps 10 and 7b, and runbook 82 step 11's Read-Host.
  const WINDOWS_COMMAND =
    "powershell -NoProfile -Command \"$s = Read-Host 'Throwaway word' -AsSecureString; 'length=' + $s.Length\"";
  /** ConPTY repaints: clear, home, the title, then the text. */
  const CONPTY =
    "\r\n\u001b[?25l\u001b[2J\u001b[m\u001b[H" +
    "\u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007\u001b[?25h" +
    "Throwaway word: \u001b[K********\r\nlength=8\r\n\u001b[K" +
    `\r\n${CMD}`;

  it("ConPTY moves the cursor, so the screen's one line is read", () => {
    const terminal = fakeTerminal([
      "Microsoft Windows [Version 10.0.26100.2605]",
      "",
      CMD,
      "",
    ]);
    start(terminal, WINDOWS_COMMAND);
    terminal.print(WINDOWS_COMMAND + CONPTY);
    terminal.lines.splice(
      2,
      2,
      CMD + WINDOWS_COMMAND,
      "Throwaway word: ********",
      "length=8",
      "",
      CMD,
    );
    const read = readCapture(21)!;
    expect(read).toMatchObject({
      text: "Throwaway word: ********\nlength=8",
      finished: true,
      from: "screen",
    });
    expect(looksFinished(read)).toBe(true);
  });

  it("without the screen's line, the output as it arrived, with a warning", () => {
    const terminal = fakeTerminal([CMD]);
    start(terminal, WINDOWS_COMMAND);
    terminal.print(WINDOWS_COMMAND + CONPTY);
    terminal.lines = ["Throwaway word: ********", "length=8", CMD];
    const read = readCapture(21)!;
    expect(read).toMatchObject({
      text: "Throwaway word: ********\nlength=8",
      drawn: true,
      from: "stream",
    });
    expect(looksFinished(read)).toBe(false);
  });
});

describe("limits and ends", () => {
  it("stops at what Mark done takes, and keeps its start", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "cat big");
    run(terminal, "cat big", "y".repeat(MAX_PASTED_CHARS));
    terminal.print("z".repeat(100));
    const read = readCapture(21)!;
    expect(read.truncated).toBe(true);
    expect(read.final).toBe(true);
    expect(read.text).not.toContain("z");
    expect(terminal.listeners.size).toBe(0);
  });

  it("stops reading after an hour, or the step's longer time limit", () => {
    vi.useFakeTimers();
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND, { timeoutMs: 1000 });
    run(terminal, COMMAND, "still going\r\n");
    vi.advanceTimersByTime(RAW_MIN_MS);
    expect(terminal.listeners.size).toBe(0);
    expect(readCapture(21)).toMatchObject({
      text: "still going",
      finished: false,
      final: true,
    });

    start(terminal, COMMAND, { runId: 22, timeoutMs: RAW_MIN_MS * 2 });
    vi.advanceTimersByTime(RAW_MIN_MS);
    expect(terminal.listeners.size).toBe(1);
    vi.advanceTimersByTime(RAW_MIN_MS);
    expect(terminal.listeners.size).toBe(0);
    // Nothing read: the capture ends, and the paste box is as before.
    expect(hasCapture(22)).toBe(false);
  });

  it("a new send on the terminal stops the older capture where it is", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND, { runId: 21 });
    run(terminal, COMMAND, "active\r\n");
    start(terminal, "uptime", { runId: 22 });
    terminal.print("uptime\r\nup 3 days\r\n");
    expect(terminal.listeners.size).toBe(1);
    expect(readCapture(21)).toMatchObject({
      text: "active",
      finished: false,
      final: true,
    });
    expect(readCapture(22)).toMatchObject({ text: "up 3 days" });
  });

  it("a new send ends an older capture that read nothing", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND, { runId: 21 });
    start(terminal, COMMAND, { runId: 22 });
    expect(hasCapture(21)).toBe(false);
    expect(hasCapture(22)).toBe(true);
  });

  it("the tab closed: what it read stays, and it reads no more", () => {
    const terminal = fakeTerminal([PROMPT]);
    let shell = shellWith(terminal);
    startCapture({
      runId: 21,
      sessionId: "web",
      command: COMMAND,
      reader: () => readerFor(shell, "web"),
    });
    run(terminal, COMMAND, "active\r\n");
    shell = { tabs: { list: [{ id: "home" }] } };
    expect(readCapture(21)).toMatchObject({
      text: "active",
      finished: false,
      final: true,
    });
    expect(terminal.listeners.size).toBe(0);
  });

  it("ends the captures of runs done elsewhere or reopened", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND, { runId: 21 });
    start(fakeTerminal([PROMPT]), COMMAND, { runId: 22, sessionId: "b" });
    endCapturesOf([
      { id: 21, status: "done" },
      { id: 22, status: "awaiting-output" },
    ]);
    expect(hasCapture(21)).toBe(false);
    expect(terminal.listeners.size).toBe(0);
    expect(hasCapture(22)).toBe(true);
  });

  it(`keeps ${MAX_CAPTURES} captures, ending the oldest`, () => {
    for (let index = 0; index <= MAX_CAPTURES; index++) {
      start(fakeTerminal([PROMPT]), COMMAND, {
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
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    endAllCaptures();
    expect(readCapture(21)).toBeNull();
    expect(terminal.listeners.size).toBe(0);
  });

  it("ends after Mark done", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    endCapture(21);
    expect(hasCapture(21)).toBe(false);
    expect(terminal.listeners.size).toBe(0);
  });
});
