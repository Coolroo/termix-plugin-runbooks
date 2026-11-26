import { afterEach, describe, expect, it } from "vitest";
import {
  endAllCaptures,
  hasCapture,
  readCapture,
  readerFor,
  startCapture,
  type CaptureRead,
} from "../../src/frontend/running/terminal-capture";
import { BASH, PROMPT, type Recording } from "./bash-recordings";
import { xtermTab, type XtermTab } from "./xterm-tab";

// The capture on the real terminal library. The reviews of T-249 (BUG-019)
// and of its fix (BUG-021): the box must hold the step's own output, or
// stay the plain paste box, and never another command's text.

afterEach(() => endAllCaptures());

function start(tab: XtermTab, command: string, runId = 21) {
  return startCapture({
    runId,
    sessionId: "web",
    command,
    reader: () => readerFor(tab.shell, "web"),
  });
}

/** The person runs `command` by hand: echo, Enter, output, prompt. */
async function runByHand(tab: XtermTab, command: string, output: string[]) {
  await tab.host(command);
  await tab.host(`\r\n${output.map((line) => `${line}\r\n`).join("")}`);
  await tab.host(PROMPT);
}

function numbers(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(index + 1));
}

/** Send to terminal types the step's command; the person presses Enter. */
async function runStepCommand(
  tab: XtermTab,
  command: string,
  output: string[],
) {
  expect(start(tab, command)).toBe(true);
  await runByHand(tab, command, output);
}

/**
 * Plays a recording: what the terminal showed, the send, then each piece
 * of output, with a read after each, as the box reads each second.
 */
async function play(recording: Recording, command: string) {
  const tab = xtermTab({ cols: recording.cols, rows: 24 });
  for (const piece of recording.before) await tab.host(piece);
  expect(start(tab, command)).toBe(true);
  const reads: (CaptureRead | null)[] = [readCapture(21)];
  for (const piece of recording.after) {
    await tab.host(piece);
    reads.push(readCapture(21));
  }
  return { tab, reads, last: reads[reads.length - 1] };
}

const SITE = [
  "# nginx site",
  "# listen on 443 only",
  "server_name homepi;",
  "listen 443 ssl;",
];

describe("recorded bash 5.2 (the re-review's probes)", () => {
  it("P1: nothing before the echo, nor before the output", async () => {
    const { reads, last } = await play(BASH.plain, "cat site.conf");
    // Before the send, after the echo, after Enter: the plain paste box.
    expect(reads.slice(0, 3)).toEqual([null, null, null]);
    expect(last).toEqual({
      text: SITE.join("\n"),
      reading: false,
      passwordPrompt: false,
      drawn: false,
      truncated: false,
    });
  });

  it("P2: a changed command gives the paste box, and nothing is read", async () => {
    const { reads } = await play(BASH.edited, "cat site.conf");
    expect(reads.every((read) => read === null)).toBe(true);
    expect(hasCapture(21)).toBe(false);
  });

  it("P3: a step that clears the screen gives the paste box", async () => {
    const { reads } = await play(BASH.clear, "clear && echo ready");
    expect(reads.every((read) => read === null)).toBe(true);
    expect(hasCapture(21)).toBe(false);
  });

  it("P4: a root prompt and '# ' lines in a config file: all of it", async () => {
    const { reads, last } = await play(BASH.root, "cat site.conf");
    expect(last).toMatchObject({ text: SITE.join("\n"), reading: false });
    // The file's '# ' lines never stop the reading early.
    for (const read of reads) {
      if (read && !read.reading) expect(read.text).toBe(SITE.join("\n"));
    }
  });

  it("P5: a command of two lines", async () => {
    const { last } = await play(BASH.multi, "echo one\necho two");
    expect(last).toMatchObject({ text: "one\ntwo", reading: false });
  });

  it.each([
    ["the plain one", BASH.plain, "cat site.con"],
    ["the plain one", BASH.plain, "cat site.conf.bak"],
    ["two lines", BASH.multi, "echo one\necho three"],
    ["two lines", BASH.multi, "echo one"],
    ["the long one", BASH.long, "cat site.conf | grep -v '^#'"],
    [
      "the long one",
      BASH.long,
      "cat site.conf | grep -v '^#' | sed -e 's/443/8443/' && echo the config file was read",
    ],
    ["two prompt lines", BASH.twoline, "echo h"],
  ])(
    "another command than the echo (%s): the paste box",
    async (_name, recording, command) => {
      const { reads } = await play(recording, command);
      expect(reads.every((read) => read === null)).toBe(true);
    },
  );

  it("P6: a pause after '50% ' goes on, and a CR shows the last state", async () => {
    const command =
      "printf 'download 50%% '; sleep 0.6; printf '\\rdownload 100%%\\n'; echo saved";
    const { reads, last } = await play(BASH.progress, command);
    expect(reads).toContainEqual(
      expect.objectContaining({ text: "download 50%", reading: true }),
    );
    expect(last).toMatchObject({
      text: "download 100%\nsaved",
      reading: false,
    });
  });

  it("P7: a command typed ahead after cd: never its output", async () => {
    const { reads, last } = await play(
      BASH.ahead,
      "cd /etc && echo moved && sleep 0.6",
    );
    // The typed line itself is echoed while the step runs; the next
    // prompt ends the reading, though cd changed it.
    expect(last).toMatchObject({ text: "moved\ncat hostname", reading: false });
    for (const read of reads) expect(read?.text ?? "").not.toContain("home-");
  });

  it("P8: a long command bash draws again on Enter (40 columns)", async () => {
    const { tab, last } = await play(
      BASH.long,
      "cat site.conf | grep -v '^#' | sed -e 's/443/8443/' && echo the config file was read in full",
    );
    expect(last).toMatchObject({
      text: "server_name homepi;\nlisten 8443 ssl;\nthe config file was read in full",
      reading: false,
      drawn: false,
    });
    // The screen shows the same: the recording is real.
    expect(tab.screen()).toContain("listen 8443 ssl;");
  });

  it("P9: the same command run just before: only the step's run", async () => {
    const { reads, last } = await play(BASH.earlier, "cat site.conf");
    expect(reads.slice(0, 3)).toEqual([null, null, null]);
    expect(last).toMatchObject({ text: SITE.join("\n"), reading: false });
  });

  it("P10: a prompt of two lines: its top line is not output", async () => {
    const { last } = await play(BASH.twoline, "echo hi");
    expect(last).toMatchObject({ text: "hi", reading: false });
  });

  it("never says more than the text: no finished state", async () => {
    const { last } = await play(BASH.plain, "cat site.conf");
    expect(Object.keys(last!).sort()).toEqual([
      "drawn",
      "passwordPrompt",
      "reading",
      "text",
      "truncated",
    ]);
  });
});

describe("Windows ConPTY (runbook 82 step 11)", () => {
  // Runbook 82 kept only cleaned output for step 11 (it ran as a command,
  // not in a terminal), so these are ConPTY's usual codes around that
  // output: the cursor hidden and shown, colours, erase to the line end,
  // the title, and in the second case a repaint at absolute places.
  const PS = "PS C:\\Users\\wyatt> ";
  const COMMAND =
    "powershell -NoProfile -Command \"$s = Read-Host 'Throwaway word' -AsSecureString; 'length=' + $s.Length; exit 7\"";

  async function windows(output: string[]) {
    const tab = xtermTab({ cols: 160, rows: 30 });
    await tab.host(
      "\u001b[?25l\u001b[2J\u001b[m\u001b[HWindows PowerShell\u001b[K\r\n\u001b[K\r\n" +
        `${PS}\u001b]0;Windows PowerShell\u0007\u001b[?25h`,
    );
    expect(start(tab, COMMAND)).toBe(true);
    // PSReadLine colours the typed command; Enter is CR LF.
    await tab.host(
      `\u001b[?25l\u001b[93m${COMMAND.slice(0, 10)}\u001b[m${COMMAND.slice(10)}\u001b[?25h`,
    );
    await tab.host("\r\n");
    for (const piece of output) await tab.host(piece);
    return readCapture(21);
  }

  it("output as lines: the text, up to the noted prompt", async () => {
    const read = await windows([
      "Throwaway word: \u001b[K",
      "********\r\nlength=8\u001b[K\r\n",
      `\u001b[?25l\u001b[K\r\n${PS}\u001b[?25h`,
    ]);
    expect(read).toMatchObject({
      text: "Throwaway word: ********\nlength=8",
      reading: false,
    });
  });

  it("a repaint at absolute places: the paste box", async () => {
    const read = await windows([
      "\u001b[?25l\u001b[5;1HThrowaway word: \u001b[K\u001b[?25h",
      "\u001b[5;17H********\u001b[6;1Hlength=8\u001b[K\u001b[8;1H" + PS,
    ]);
    expect(read).toBeNull();
    expect(hasCapture(21)).toBe(false);
  });
});

describe("BUG-019 finding 1: the terminal narrows (reflow)", () => {
  const STATUS = "systemctl status nginx";
  const LONG = `● nginx.service - A high performance web server and a reverse proxy server`;
  const before = [LONG, "   Active: failed (Result: exit-code)"];
  const now = [LONG, "   Active: active (running) since Mon"];

  it("reads this run, not an earlier run of the same command", async () => {
    const tab = xtermTab({ cols: 80, rows: 10 });
    await tab.host(PROMPT);
    await runByHand(tab, STATUS, before);
    await runStepCommand(tab, STATUS, now);
    tab.term.resize(40, 10);
    expect(readCapture(21)).toMatchObject({ text: now.join("\n") });
  });

  it("without raw output (the screen alone): no capture", async () => {
    const tab = xtermTab({ cols: 80, rows: 10, subscribe: false });
    await tab.host(PROMPT);
    expect(start(tab, STATUS)).toBe(false);
  });
});

describe("BUG-019 finding 2: rows move, a later command must not replace the output", () => {
  const hosts = ["127.0.0.1 localhost", "192.168.1.20 homepi"];
  const later = ["ALL: 192.168.1.0/24", "sshd: 100.64.0.0/10"];

  it("a full scrollback", async () => {
    const tab = xtermTab({ cols: 80, rows: 5, scrollback: 10 });
    await tab.host(PROMPT);
    await runByHand(tab, "seq 1 8", numbers(8));
    await runStepCommand(tab, "cat /etc/hosts", hosts);
    await runByHand(tab, "cat /etc/hosts.allow", later);
    await runByHand(tab, "seq 1 3", numbers(3));
    expect(readCapture(21)).toMatchObject({
      text: hosts.join("\n"),
      reading: false,
    });
  });

  it("clear (ED3) after the step", async () => {
    const tab = xtermTab({ cols: 80, rows: 10, scrollback: 100 });
    await tab.host(PROMPT);
    await runStepCommand(tab, "cat /etc/hosts", hosts);
    // `clear`: home, erase the screen and the scrollback, then the prompt.
    await tab.host("clear\r\n\u001b[H\u001b[2J\u001b[3J");
    await tab.host(PROMPT);
    await runByHand(tab, "cat /etc/hosts.allow", later);
    expect(readCapture(21)).toMatchObject({ text: hosts.join("\n") });
  });

  it("tmux on the alternate screen, its status line off", async () => {
    const tab = xtermTab({ cols: 80, rows: 6, scrollback: 100 });
    await tab.host("\u001b[?1049h\u001b[H\u001b[2J");
    await tab.host(PROMPT);
    await runByHand(tab, "seq 1 5", numbers(5));
    await runStepCommand(tab, "cat /etc/hosts", hosts);
    await runByHand(tab, "cat /etc/hosts.allow", later);
    expect(readCapture(21)).toMatchObject({ text: hosts.join("\n") });
  });

  it("tmux drawing with a scroll region: stops at the move, never the next command", async () => {
    const tab = xtermTab({ cols: 80, rows: 6, scrollback: 100 });
    await tab.host("\u001b[?1049h\u001b[H\u001b[2J\u001b[1;5r");
    await tab.host(PROMPT);
    expect(start(tab, "cat /etc/hosts")).toBe(true);
    await tab.host("cat /etc/hosts");
    // tmux moves the cursor between rows to draw.
    await tab.host(
      "\r\n127.0.0.1 localhost\r\n\u001b[5;1H192.168.1.20 homepi\r\n",
    );
    await tab.host(PROMPT);
    await runByHand(tab, "cat /etc/hosts.allow", later);
    expect(readCapture(21)).toMatchObject({
      text: "127.0.0.1 localhost",
      reading: false,
      drawn: true,
    });
  });

  it("tmux's status line at the bottom: no capture, the paste box", async () => {
    const tab = xtermTab({ cols: 80, rows: 6 });
    await tab.host("\u001b[?1049h\u001b[H\u001b[2J");
    await tab.host(PROMPT);
    await tab.host(
      '\u001b[6;1H[0] 0:bash*                          "homepi" 10:42 23-Nov-26\u001b[1;17H',
    );
    expect(start(tab, "cat /etc/hosts")).toBe(false);
  });
});
