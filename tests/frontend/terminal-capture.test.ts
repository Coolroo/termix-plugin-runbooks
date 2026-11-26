import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atNotedPrompt,
  canBePrompt,
  endAllCaptures,
  endCapture,
  endCapturesOf,
  hasCapture,
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
  it("fills with the output after the command's echo, up to the prompt", () => {
    const terminal = fakeTerminal(["Last login: today", PROMPT]);
    expect(start(terminal, COMMAND)).toBe(true);
    expect(hasCapture(21)).toBe(true);
    // Typed, before Enter: nothing yet, the plain paste box.
    terminal.print(COMMAND);
    expect(readCapture(21)).toBeNull();
    terminal.print("\r\n");
    expect(readCapture(21)).toBeNull();

    terminal.print("active\r\n");
    expect(readCapture(21)).toEqual({
      text: "active",
      reading: true,
      passwordPrompt: false,
      drawn: false,
      truncated: false,
    });

    terminal.print(PROMPT);
    expect(readCapture(21)).toMatchObject({ text: "active", reading: false });
    // The copy stopped: what the person runs after is never read.
    expect(terminal.listeners.size).toBe(0);
  });

  it("never reads a command typed after the prompt", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    run(terminal, COMMAND, `active\r\n${PROMPT}`);
    terminal.print("cat /etc/shadow\r\ncat: Permission denied\r\n" + PROMPT);
    expect(readCapture(21)).toMatchObject({ text: "active", reading: false });
  });

  it("ends at the noted prompt with a command typed ahead", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    run(terminal, COMMAND, `active\r\n${PROMPT}ls\r\nfile\r\n`);
    expect(readCapture(21)).toMatchObject({ text: "active", reading: false });
  });

  it("ends at the shell's mark for its next prompt, though cd changed it", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "cd /etc && ls");
    run(
      terminal,
      "cd /etc && ls",
      "hosts\r\n\u001b[?2004hwyatt@homepi:/etc$ cat shadow\r\nroot:x\r\n",
    );
    expect(readCapture(21)).toMatchObject({ text: "hosts", reading: false });
  });

  it("finds the prompt when it arrives in two pieces", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, COMMAND);
    run(terminal, COMMAND, "active\r\nwyatt@homepi:");
    expect(readCapture(21)).toMatchObject({ reading: true });
    terminal.print("~$ ");
    expect(readCapture(21)).toMatchObject({ text: "active", reading: false });
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
      reading: true,
    });
    // The password is not echoed: the next lines are the command's own.
    terminal.password = false;
    terminal.print(`\r\n${PROMPT}`);
    expect(readCapture(21)).toMatchObject({
      text: "[sudo] password for wyatt:",
      passwordPrompt: false,
      reading: false,
    });
  });

  it("a command of several lines, run line by line after bash's '> '", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "for host in a b; do\n  echo $host\ndone");
    terminal.print("for host in a b; do\r\n>   echo $host\r\n> done");
    expect(readCapture(21)).toBeNull();
    terminal.print(`\r\na\r\nb\r\n${PROMPT}`);
    expect(readCapture(21)).toMatchObject({ text: "a\nb", reading: false });
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
      reading: false,
    });
  });

  it("the person changed the command: the paste box, and the capture ends", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "systemctl restart <unit>");
    run(terminal, "systemctl restart nginx", "done\r\nmore\r\n");
    expect(readCapture(21)).toBeNull();
    terminal.print(`more\r\n${PROMPT}`);
    expect(readCapture(21)).toBeNull();
    expect(hasCapture(21)).toBe(false);
    expect(terminal.listeners.size).toBe(0);
  });

  it("a cursor move to another row stops the reading, with a note", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "docker pull nginx");
    run(
      terminal,
      "docker pull nginx",
      "latest: Pulling from library/nginx\r\nabc: Waiting\r\n\u001b[1Aabc: Done\r\n",
    );
    expect(readCapture(21)).toMatchObject({
      text: "latest: Pulling from library/nginx\nabc: Waiting",
      reading: false,
      drawn: true,
    });
    expect(terminal.listeners.size).toBe(0);
  });
});

describe("the end of the output (finding 4, BUG-021)", () => {
  it.each([
    ["cd: a new directory", "wyatt@homepi:/etc$ "],
    ["su: root", "root@homepi:~# "],
    ["a virtual environment", "(venv) wyatt@homepi:~$ "],
    ["sh", "$ "],
    ["zsh", "homepi% "],
  ])(
    "a prompt that changed (%s), without the shell's mark: the reading goes on",
    (_name, prompt) => {
      const terminal = fakeTerminal([PROMPT]);
      start(terminal, "do-it");
      run(terminal, "do-it", `line 1\r\nline 2\r\n${prompt}`);
      expect(readCapture(21)).toMatchObject({
        text: `line 1\nline 2\n${prompt.trimEnd()}`,
        reading: true,
      });
    },
  );

  it("output that pauses on a line like a prompt goes on", () => {
    const terminal = fakeTerminal(["root@homepi:~# "]);
    start(terminal, "cat nginx.conf");
    run(terminal, "cat nginx.conf", "# ");
    expect(readCapture(21)).toMatchObject({ text: "#", reading: true });
    terminal.print("worker_processes auto;\r\n");
    terminal.print("root@homepi:~# ");
    expect(readCapture(21)).toMatchObject({
      text: "# worker_processes auto;",
      reading: false,
    });
  });

  it("a short noted prompt never ends the reading", () => {
    const terminal = fakeTerminal(["$ "]);
    start(terminal, "cat notes");
    run(terminal, "cat notes", "$ is a dollar\r\n$ ");
    expect(readCapture(21)).toMatchObject({ reading: true });
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
      reading: false,
    });
  });

  it("starship on two lines: its top line comes after the shell's mark", () => {
    const terminal = fakeTerminal(["", "~/src on  main", "❯ "]);
    start(terminal, "make test");
    run(
      terminal,
      "make test",
      "ok 12 tests\r\n\u001b[?2004h\r\n~/src on  main took 2s\r\n❯ ",
    );
    expect(readCapture(21)).toMatchObject({
      text: "ok 12 tests",
      reading: false,
    });
  });

  it("no prompt yet: the reading goes on", () => {
    const terminal = fakeTerminal([PROMPT]);
    start(terminal, "journalctl -f");
    run(terminal, "journalctl -f", "Nov 23 nginx[1]: started\r\n");
    expect(readCapture(21)).toMatchObject({
      text: "Nov 23 nginx[1]: started",
      reading: true,
    });
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
    expect(atNotedPrompt("wyatt@homepi:~$ ls", "wyatt@homepi:~$")).toBe(true);
    expect(atNotedPrompt("$ ls", "$")).toBe(false);
    expect(atNotedPrompt("root@homepi:~# ", "wyatt@homepi:~$")).toBe(false);
  });
});

describe("without raw output, the screen is never read", () => {
  it("starts no capture", () => {
    const terminal = fakeTerminal([PROMPT], false);
    expect(start(terminal, COMMAND)).toBe(false);
    terminal.lines[0] = PROMPT + COMMAND;
    terminal.lines.push("active", PROMPT);
    expect(readCapture(21)).toBeNull();
  });
});

describe("a capture on Windows (cmd.exe, ConPTY)", () => {
  const CMD = "C:\\Users\\Wyatt>";
  // Runbook 66 steps 10 and 7b, and runbook 82 step 11's Read-Host.
  const WINDOWS_COMMAND =
    "powershell -NoProfile -Command \"$s = Read-Host 'Throwaway word' -AsSecureString; 'length=' + $s.Length\"";

  it("output as lines: the text, up to the noted prompt", () => {
    const terminal = fakeTerminal(["", CMD]);
    start(terminal, WINDOWS_COMMAND);
    terminal.print(
      `${WINDOWS_COMMAND}\r\n\u001b[?25lThrowaway word: \u001b[K********\r\nlength=8\r\n\u001b[K\u001b[?25h\r\n${CMD}`,
    );
    expect(readCapture(21)).toMatchObject({
      text: "Throwaway word: ********\nlength=8",
      reading: false,
    });
  });

  it("ConPTY repaints at absolute places: the paste box", () => {
    const terminal = fakeTerminal(["", CMD]);
    start(terminal, WINDOWS_COMMAND);
    terminal.print(
      `${WINDOWS_COMMAND}\r\n\u001b[?25l\u001b[2J\u001b[m\u001b[H` +
        "\u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007\u001b[?25h" +
        `Throwaway word: \u001b[K********\r\nlength=8\r\n\r\n${CMD}`,
    );
    expect(readCapture(21)).toBeNull();
    expect(hasCapture(21)).toBe(false);
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
    expect(read.reading).toBe(false);
    expect(read.text).not.toContain("z");
    expect(read.text.length).toBeLessThanOrEqual(MAX_PASTED_CHARS);
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
      reading: false,
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
    expect(readCapture(21)).toMatchObject({ text: "active", reading: false });
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
    expect(readCapture(21)).toMatchObject({ text: "active", reading: false });
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
