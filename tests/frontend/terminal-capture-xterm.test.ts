import { afterEach, describe, expect, it } from "vitest";
import {
  endAllCaptures,
  readCapture,
  readerFor,
  startCapture,
} from "../../src/frontend/running/terminal-capture";
import { xtermTab, type XtermTab } from "./xterm-tab";

// The review of T-249 (BUG-019, findings 1 and 2), on the real terminal
// library: rows move when the terminal reflows, its scrollback is full,
// `clear` runs or tmux draws, and the capture must still read the step's
// own output, or say it cannot, never another command's.

const PROMPT = "wyatt@homepi:~$ ";
const STATUS = "systemctl status nginx";
/** A line longer than the narrow terminal: it wraps when it narrows. */
const LONG = `● nginx.service - A high performance web server and a reverse proxy server`;

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

describe("finding 1: the terminal narrows (reflow)", () => {
  const before = [LONG, "   Active: failed (Result: exit-code)"];
  const now = [LONG, "   Active: active (running) since Mon"];

  it("reads this run, not an earlier run of the same command", async () => {
    const tab = xtermTab({ cols: 80, rows: 10 });
    await tab.host(PROMPT);
    await runByHand(tab, STATUS, before);
    await runStepCommand(tab, STATUS, now);
    tab.term.resize(40, 10);
    const read = readCapture(21)!;
    expect(read.text).toBe(now.join("\n"));
    expect(read.finished).toBe(true);
  });

  it("with the screen alone, two lines with the command: no guess", async () => {
    const tab = xtermTab({ cols: 80, rows: 10, subscribe: false });
    await tab.host(PROMPT);
    await runByHand(tab, STATUS, before);
    await runStepCommand(tab, STATUS, now);
    tab.term.resize(40, 10);
    const read = readCapture(21);
    // The paste box stays empty for the person to paste.
    expect(read?.text ?? null).toBeNull();
  });

  it("with the screen alone and one line with the command, reads it", async () => {
    const tab = xtermTab({ cols: 80, rows: 10, subscribe: false });
    await tab.host(PROMPT);
    await runStepCommand(tab, STATUS, now);
    tab.term.resize(40, 10);
    expect(readCapture(21)).toMatchObject({
      text: now.join("\n"),
      finished: true,
    });
  });
});

describe("finding 2: rows move, a later command must not replace the output", () => {
  const hosts = ["127.0.0.1 localhost", "192.168.1.20 homepi"];
  const later = ["ALL: 192.168.1.0/24", "sshd: 100.64.0.0/10"];

  it("a full scrollback", async () => {
    const tab = xtermTab({ cols: 80, rows: 5, scrollback: 10 });
    await tab.host(PROMPT);
    await runByHand(tab, "seq 1 8", numbers(8));
    await runStepCommand(tab, "cat /etc/hosts", hosts);
    await runByHand(tab, "cat /etc/hosts.allow", later);
    await runByHand(tab, "seq 1 3", numbers(3));
    const read = readCapture(21)!;
    expect(read.text).toBe(hosts.join("\n"));
    expect(read.finished).toBe(true);
  });

  it("clear (ED3) after the step", async () => {
    const tab = xtermTab({ cols: 80, rows: 10, scrollback: 100 });
    await tab.host(PROMPT);
    await runStepCommand(tab, "cat /etc/hosts", hosts);
    // `clear`: home, erase the screen and the scrollback, then the prompt.
    await tab.host("clear\r\n\u001b[H\u001b[2J\u001b[3J");
    await tab.host(PROMPT);
    await runByHand(tab, "cat /etc/hosts.allow", later);
    const read = readCapture(21)!;
    expect(read.text).toBe(hosts.join("\n"));
    expect(read.finished).toBe(true);
  });

  it("tmux on the alternate screen, its status line off", async () => {
    const tab = xtermTab({ cols: 80, rows: 6, scrollback: 100 });
    // tmux (or autoTmux) has switched to the alternate screen, which has
    // no scrollback: lines leave it at the top.
    await tab.host("\u001b[?1049h\u001b[H\u001b[2J");
    await tab.host(PROMPT);
    await runByHand(tab, "seq 1 5", numbers(5));
    await runStepCommand(tab, "cat /etc/hosts", hosts);
    await runByHand(tab, "cat /etc/hosts.allow", later);
    const read = readCapture(21)!;
    expect(read.text).toBe(hosts.join("\n"));
    expect(read.finished).toBe(true);
  });

  it("tmux drawing with a scroll region: the order is not sure, no badge", async () => {
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
    await runByHand(tab, "cat /etc/hosts.allow", later);
    const read = readCapture(21)!;
    // Never another command's output, and never "looks finished".
    expect(read.text).not.toContain("ALL:");
    expect(read.finished && read.startSure && !read.drawn).toBe(false);
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
