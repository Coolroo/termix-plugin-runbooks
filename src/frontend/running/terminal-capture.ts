/**
 * Reading what a Send to terminal step printed (1.4.10, T-249), to fill the
 * paste box, so the person checks it there instead of copying it from the
 * terminal (which a phone cannot do).
 *
 * Off since 1.4.12 (the owner, 2026-11-26): it did not fill the box on the
 * owner's phone, for a cause not yet found, and Send to terminal starts no
 * capture. The code and its tests stay for a later fix (BUG-024).
 *
 * The SSH Terminal plugin keeps a handle on each terminal tab, at
 * `useShell().tabs.list[i].terminalRef.current`, with `readBufferLines`
 * (the screen and scrollback as plain lines, wrapped rows joined),
 * `subscribeOutput` (the raw text the host sends), `getInputModes` (whether
 * a paste is bracketed) and `isAtPasswordPrompt`.
 * None of it is in the SDK's types, and plugin API 2 runs plugins in a frame
 * where it is out of reach: every access is tested and caught, and without
 * it a capture never starts and the paste box works as before.
 *
 * The read only fills the box: it never says the command finished
 * (BUG-021, owner 2026-11-23). The screen is read once, before the command
 * is typed, to note the prompt; the text comes only from the raw output
 * after that, and only once the command's echo is found in it
 * (terminal-lines.ts). Without the echo (no raw output, a changed command,
 * a drawing that cannot be followed) nothing is read, and the paste box is
 * as before. The reading stops at the next prompt (the shell's own mark, or
 * the noted prompt on the cursor's line), a cursor move to another row,
 * Mark done, Mark done's size limit or the time limit. Captures live as
 * long as the page: a reload, or another device, has none.
 */

import { MAX_PASTED_CHARS } from "../../shared/limits";
import { createCommandStream, type CommandStream } from "./terminal-lines";

/** One line of the terminal: its text and the rows it covers. */
export interface BufferLine {
  text: string;
  firstRow: number;
  lastRow: number;
}

/** What a capture reads from a terminal; each part tested before use. */
export interface TerminalReader {
  /** The screen and scrollback, or null when the terminal cannot say. */
  lines: () => BufferLine[] | null;
  /** Follows the raw output; null when the terminal does not offer it. */
  subscribe: ((listener: (data: string) => void) => () => void) | null;
  /** True while the terminal thinks a password prompt waits. */
  atPasswordPrompt: () => boolean;
  /** True when the terminal pastes in bracketed paste mode. */
  bracketedPaste: () => boolean;
}

/** What a read gives the paste box: never whether the command finished. */
export interface CaptureRead {
  text: string;
  /** The reading goes on: the text may still grow. */
  reading: boolean;
  /** The terminal waits at a password prompt. */
  passwordPrompt: boolean;
  /**
   * The reading stopped where the terminal moved its cursor to another row
   * (`clear`, a progress display, tmux): the end may be missing.
   */
  drawn: boolean;
  /** The text was longer than Mark done takes, and was cut. */
  truncated: boolean;
}

/** How long the raw copy follows the terminal at least, in milliseconds. */
export const RAW_MIN_MS = 60 * 60 * 1000;
/** Captures kept at once; the oldest ends first. */
export const MAX_CAPTURES = 20;
/** A noted prompt shorter than this ("$", "#", "❯") never ends the reading. */
export const SHORT_PROMPT = 3;
/** A prompt longer than this is not one. */
const MAX_PROMPT = 300;
/** What a prompt ends with: `$`, `#`, `%`, `>` and the common symbols. */
const PROMPT_SYMBOL = /[$#%>❯➜»λ]$/u;

/** Calls `read`, or answers `fallback` when it throws. */
function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function isLine(value: unknown): value is BufferLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return typeof line.text === "string" && typeof line.firstRow === "number";
}

/**
 * The terminal of the tab with this id (the session id is the tab id), or
 * null when there is none or it cannot be read.
 */
export function readerFor(
  shell: unknown,
  sessionId: string,
): TerminalReader | null {
  return guarded(() => {
    const list = (shell as { tabs?: { list?: unknown } } | null | undefined)
      ?.tabs?.list;
    if (!Array.isArray(list)) return null;
    const tab = list.find(
      (entry) => (entry as { id?: unknown } | null)?.id === sessionId,
    ) as { terminalRef?: { current?: unknown } } | undefined;
    const handle = tab?.terminalRef?.current as
      Record<string, unknown> | null | undefined;
    if (!handle || typeof handle.readBufferLines !== "function") return null;
    const readLines = handle.readBufferLines as () => unknown;
    const subscribeOutput = handle.subscribeOutput;
    const isAtPasswordPrompt = handle.isAtPasswordPrompt;
    const getInputModes = handle.getInputModes;
    return {
      lines: () =>
        guarded(() => {
          const lines = readLines.call(handle);
          if (!Array.isArray(lines)) return null;
          return lines.filter(isLine).map((line) => ({
            text: line.text,
            firstRow: line.firstRow,
            lastRow: typeof line.lastRow === "number" ? line.lastRow : -1,
          }));
        }, null),
      subscribe:
        typeof subscribeOutput === "function"
          ? (listener) => {
              const stop = subscribeOutput.call(handle, listener) as unknown;
              return typeof stop === "function"
                ? () => guarded(() => void stop(), undefined)
                : () => {};
            }
          : null,
      atPasswordPrompt: () =>
        typeof isAtPasswordPrompt === "function" &&
        guarded(() => isAtPasswordPrompt.call(handle) === true, false),
      bracketedPaste: () =>
        typeof getInputModes === "function" &&
        guarded(
          () =>
            (getInputModes.call(handle) as { bracketedPaste?: unknown } | null)
              ?.bracketedPaste === true,
          false,
        ),
    };
  }, null);
}

/** The prompt part of a line: up to a right-hand prompt, no end spaces. */
export function promptHead(line: string): string {
  const gap = line.search(/ {3,}\S/);
  return (gap === -1 ? line : line.slice(0, gap)).trimEnd();
}

/**
 * Whether the terminal's last line, before the command is typed, looks like
 * a prompt: it ends with a prompt symbol, a right-hand prompt aside. A line
 * that does not (a MOTD still printing, a program waiting, a tmux status
 * line) starts no capture.
 */
export function canBePrompt(line: string): boolean {
  const head = promptHead(line);
  return head.length <= MAX_PROMPT && PROMPT_SYMBOL.test(head);
}

/** Whether the cursor's line is the noted prompt again (3 characters or more). */
export function atNotedPrompt(line: string, head: string): boolean {
  return head.length >= SHORT_PROMPT && line.startsWith(head);
}

/** Drops empty lines at both ends. */
function trimLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

interface Capture {
  runId: number;
  sessionId: string;
  /** Finds the terminal again at each read: a tab may close. */
  reader: () => TerminalReader | null;
  /** The noted prompt, without a right-hand prompt or end spaces. */
  prompt: string;
  stream: CommandStream;
  /** The reading goes on. */
  reading: boolean;
  /** The stream reached Mark done's limit and stopped there. */
  cut: boolean;
  stopRaw: () => void;
}

/** The captures, by run id; they live as long as the page. */
const captures = new Map<number, Capture>();

/** The output read so far. */
function captureText(capture: Capture): string {
  const { stream } = capture;
  if (stream.state() === "echo" || stream.state() === "lost") return "";
  return trimLines([...stream.complete, stream.current()]).join("\n");
}

/** Stops a capture's raw copy. */
function stopRawCopy(capture: Capture): void {
  const stop = capture.stopRaw;
  capture.stopRaw = () => {};
  stop();
}

/**
 * Stops a capture's reading where it is. What it read stays; with nothing
 * read, the capture ends and the paste box is as before.
 */
function stopReading(capture: Capture): void {
  stopRawCopy(capture);
  capture.reading = false;
  if (captureText(capture) === "") endCapture(capture.runId);
}

/** Takes a piece of raw output, and stops the reading where it ends. */
function follow(capture: Capture, data: string): void {
  const { stream } = capture;
  stream.push(data);
  if (stream.state() === "lost") {
    endCapture(capture.runId);
  } else if (stream.size() > MAX_PASTED_CHARS) {
    capture.cut = true;
    stopReading(capture);
  } else if (stream.state() === "ended") {
    stopReading(capture);
  }
}

/**
 * Starts a capture for a run, before its command is typed into the
 * session's terminal. False when the terminal cannot be read or gives no
 * raw output, or its last line does not look like a prompt: the paste box
 * then works as before. A capture already on the session stops reading, so
 * the new command is not in its text.
 */
export function startCapture(options: {
  runId: number;
  sessionId: string;
  command: string;
  reader: () => TerminalReader | null;
  /** The step's time limit: the raw copy runs at least an hour. */
  timeoutMs?: number | null;
}): boolean {
  endCapture(options.runId);
  const reader = options.reader();
  const lines = reader?.lines();
  if (!reader?.subscribe || !lines || options.command.trim() === "") {
    return false;
  }
  const promptLine = [...lines].reverse().find((line) => line.text.trim());
  if (!promptLine || !canBePrompt(promptLine.text)) return false;
  for (const other of [...captures.values()]) {
    if (other.sessionId === options.sessionId && other.reading) {
      stopReading(other);
    }
  }
  while (captures.size >= MAX_CAPTURES) {
    endCapture(captures.keys().next().value!);
  }
  const prompt = promptHead(promptLine.text);
  const capture: Capture = {
    runId: options.runId,
    sessionId: options.sessionId,
    reader: options.reader,
    prompt,
    stream: createCommandStream(options.command, {
      promptHead: prompt,
      bracketed: reader.bracketedPaste(),
      isPrompt: (line) => atNotedPrompt(line, prompt),
    }),
    reading: true,
    cut: false,
    stopRaw: () => {},
  };
  const unsubscribe = guarded<(() => void) | null>(
    () =>
      reader.subscribe!((data) => {
        if (capture.reading && typeof data === "string") follow(capture, data);
      }),
    null,
  );
  if (!unsubscribe) return false;
  const timer = setTimeout(
    () => stopReading(capture),
    Math.max(options.timeoutMs ?? 0, RAW_MIN_MS),
  );
  capture.stopRaw = () => {
    clearTimeout(timer);
    unsubscribe();
  };
  captures.set(options.runId, capture);
  return true;
}

/** Whether this page has a capture for the run. */
export function hasCapture(runId: number): boolean {
  return captures.has(runId);
}

/**
 * What the run's command printed so far, or null with no capture, or before
 * the command's echo and its first output.
 */
export function readCapture(runId: number): CaptureRead | null {
  const capture = captures.get(runId);
  if (!capture) return null;
  let passwordPrompt = false;
  if (capture.reading) {
    const reader = capture.reader();
    if (!reader) {
      // The tab is closed: the capture reads no more.
      stopReading(capture);
      if (!captures.has(runId)) return null;
    } else passwordPrompt = reader.atPasswordPrompt();
  }
  const text = captureText(capture);
  if (text === "") return null;
  return {
    text:
      text.length > MAX_PASTED_CHARS ? text.slice(0, MAX_PASTED_CHARS) : text,
    reading: capture.reading,
    passwordPrompt: capture.reading && passwordPrompt,
    drawn: capture.stream.drawn(),
    truncated: capture.cut || text.length > MAX_PASTED_CHARS,
  };
}

/** Ends a run's capture: after Mark done or failed. */
export function endCapture(runId: number): void {
  const capture = captures.get(runId);
  if (!capture) return;
  stopRawCopy(capture);
  capture.reading = false;
  captures.delete(runId);
}

/**
 * Ends the captures of runs that no longer wait for output: done or failed
 * on another device, or reopened.
 */
export function endCapturesOf(
  runs: readonly { id: number; status: string }[],
): void {
  for (const run of runs) {
    if (run.status !== "awaiting-output" && captures.has(run.id)) {
      endCapture(run.id);
    }
  }
}

/** Ends every capture, as a reload does. */
export function endAllCaptures(): void {
  for (const runId of [...captures.keys()]) endCapture(runId);
}
