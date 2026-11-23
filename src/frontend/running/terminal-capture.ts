/**
 * Reading what a Send to terminal step printed (1.4.9, T-249), so the
 * person checks it in the paste box instead of copying it from the
 * terminal (which a phone cannot do).
 *
 * The SSH Terminal plugin keeps a handle on each terminal tab, at
 * `useShell().tabs.list[i].terminalRef.current`, with `readBufferLines`
 * (the screen and scrollback as plain lines, wrapped rows joined),
 * `subscribeOutput` (the raw text the host sends) and `isAtPasswordPrompt`.
 * None of it is in the SDK's types, and plugin API 2 runs plugins in a frame
 * where it is out of reach: every access is tested and caught, and without
 * it a capture never starts and the paste box works as before.
 *
 * The capture is anchored in time, not in screen rows (BUG-019): rows move
 * when the terminal reflows, its scrollback is full, `clear` runs or tmux
 * draws. Before the command is typed, it notes the terminal's last line,
 * which must look like a prompt, and from then on it follows the raw output
 * (terminal-lines.ts). The first line is the command's; the output ends at
 * the first line that looks like a prompt, and the copy stops there, so
 * what the person runs after is never read. The screen is read only when
 * the raw output cannot place the command's line, and only when exactly one
 * line on it is the prompt with the command. When the start or the end is
 * not certain, the read says so, and the page shows a warning, never "looks
 * finished". Captures live as long as the page: a reload, or another
 * device, has none.
 */

import { MAX_PASTED_CHARS } from "../../shared/limits";
import { createLineModel, type LineModel } from "./terminal-lines";

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
}

/** What a read gives the paste box. */
export interface CaptureRead {
  text: string;
  /** A prompt came after the output: the end is found. */
  finished: boolean;
  /** The command's line was found for sure: the text starts after it. */
  startSure: boolean;
  /**
   * The terminal moved its cursor to other rows (tmux, a full-screen
   * program, some prompts), and the screen could not be read instead: the
   * lines may be out of order.
   */
  drawn: boolean;
  /** The terminal waits at a password prompt. */
  passwordPrompt: boolean;
  /** "stream": the output since the send; "screen": the terminal's lines. */
  from: "stream" | "screen";
  /** The text was longer than Mark done takes, and was cut. */
  truncated: boolean;
  /** The reading stopped: the text no longer changes. */
  final: boolean;
}

/** Whether a read may say "The command looks finished". */
export function looksFinished(read: CaptureRead): boolean {
  return read.finished && read.startSure && !read.drawn;
}

/** How long the raw copy follows the terminal at least, in milliseconds. */
export const RAW_MIN_MS = 60 * 60 * 1000;
/** Captures kept at once; the oldest ends first. */
export const MAX_CAPTURES = 20;
/**
 * A line that looks like a prompt ends the output only once the terminal
 * stays quiet this long after it: output that pauses on "# " goes on.
 */
export const QUIET_MS = 400;
/** A prompt shorter than this ("$", "#", ">") counts only on its own line. */
const SHORT_PROMPT = 3;
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
    };
  }, null);
}

/** The command's lines, trimmed, without empty ones. */
function commandLines(command: string): string[] {
  return command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * A line without a right-hand prompt (zsh RPROMPT, p10k): the text up to a
 * gap of three spaces or more, with one space kept.
 */
function leftPart(text: string): string {
  const gap = text.search(/ {3,}\S/);
  return gap === -1 ? text : text.slice(0, gap + 1);
}

/** The prompt part of a line, a right-hand prompt and end spaces aside. */
export function promptHead(line: string): string {
  return leftPart(line).trimEnd();
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

/** Whether `text` is the noted prompt again, maybe with a new command. */
export function isNotedPrompt(text: string, head: string): boolean {
  if (head === "") return false;
  if (promptHead(text) === head) return true;
  return head.length >= SHORT_PROMPT && text.startsWith(head);
}

/**
 * Whether `text` looks like any prompt, as printed: a prompt symbol and one
 * space at its end (`$ `, `# `, `% `, `> `), a right-hand prompt aside. A
 * prompt that `cd`, `su` or a virtual environment changed still does.
 */
export function looksLikePrompt(text: string): boolean {
  const left = leftPart(text);
  return (
    left.length <= MAX_PROMPT &&
    left.endsWith(" ") &&
    !left.endsWith("  ") &&
    PROMPT_SYMBOL.test(left.slice(0, -1))
  );
}

/** Drops empty lines at both ends. */
function trimLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * The first line of the output in `lines`, whose line `start` is the
 * command's first: a command of several lines shows each after a "> ".
 */
function outputStart(
  lines: readonly string[],
  start: number,
  typed: string[],
): number {
  let index = start + 1;
  for (const part of typed.slice(1)) {
    if (index < lines.length && lines[index].includes(part)) index++;
  }
  return index;
}

/** Whether a screen line is the noted prompt with the command's first line. */
function isCommandLine(text: string, head: string, first: string): boolean {
  if (head === "" || first === "" || !text.startsWith(head)) return false;
  const rest = text.slice(head.length).trim();
  return rest === first || promptHead(rest) === first;
}

/**
 * The output on the screen: only when exactly one line is the noted prompt
 * with the command (rows are not trusted: a reflow, a full scrollback,
 * `clear` or tmux moves them), up to the first line that looks like a
 * prompt. Null when there is no such line, or more than one.
 */
export function screenOutput(
  lines: readonly string[],
  prompt: string,
  command: string,
  /** A two-line prompt's top line, as noted; null for one line. */
  top: string | null = null,
): { text: string; finished: boolean } | null {
  const typed = commandLines(command);
  const head = promptHead(prompt);
  const first = typed[0] ?? "";
  const found: number[] = [];
  lines.forEach((text, index) => {
    if (isCommandLine(text, head, first)) found.push(index);
  });
  if (found.length !== 1) return null;
  const from = outputStart(lines, found[0], typed);
  let end = -1;
  for (let index = from; index < lines.length; index++) {
    const text = lines[index];
    if (isNotedPrompt(text, head) || looksLikePrompt(text)) {
      end = index;
      break;
    }
  }
  const output = lines.slice(
    from,
    end === -1 ? lines.length : outputEnd(lines, from, end, top),
  );
  return { text: trimLines(output).join("\n"), finished: end !== -1 };
}

/**
 * The line a prompt on two lines (starship, p10k) prints above its symbol
 * line, as noted before the command: null for a prompt on one line. Only a
 * symbol line with no letters or digits and not plain ASCII counts ("❯",
 * "╰─❯"): above "$" or "#" is the last command's output.
 */
function twoLineTop(head: string, above: string | undefined): string | null {
  if (!above?.trim()) return null;
  if (!/[^\x00-\x7f]/.test(head) || /[\p{L}\p{N}]/u.test(head)) return null;
  return above;
}

function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}

/**
 * Where the output ends before the prompt at `end`: a two-line prompt's
 * top line, when the line before `end` starts as it did, is the prompt's.
 */
function outputEnd(
  lines: readonly string[],
  from: number,
  end: number,
  top: string | null,
): number {
  if (top === null || end <= from) return end;
  const line = lines[end - 1];
  return line.trim() !== "" && firstWord(line) === firstWord(top)
    ? end - 1
    : end;
}

function cut(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_PASTED_CHARS
    ? { text: text.slice(0, MAX_PASTED_CHARS), truncated: true }
    : { text, truncated: false };
}

interface Capture {
  runId: number;
  sessionId: string;
  command: string;
  /** Finds the terminal again at each read: a tab may close. */
  reader: () => TerminalReader | null;
  /** The last line before the command was typed: the prompt. */
  prompt: string;
  /** A two-line prompt's top line, as noted; null for one line. */
  promptTop: string | null;
  /** The raw output since the send; null when the terminal has none. */
  stream: LineModel | null;
  /** The stream reached Mark done's limit and stopped there. */
  streamCut: boolean;
  /** The index of the stream's line where a prompt came back. */
  streamEnd: number | null;
  /** Ended lines of the stream already looked at for a prompt. */
  checked: number;
  /** Waits for quiet after a line that looks like a prompt. */
  quiet: ReturnType<typeof setTimeout> | null;
  stopRaw: () => void;
  /** The last read, kept when the screen loses the command's line. */
  last: CaptureRead | null;
  /** Once set, the read no longer changes. */
  final: CaptureRead | null;
}

/** The captures, by run id; they live as long as the page. */
const captures = new Map<number, Capture>();

/** Stops a capture's raw copy and its quiet timer. */
function stopRawCopy(capture: Capture): void {
  if (capture.quiet) clearTimeout(capture.quiet);
  capture.quiet = null;
  const stop = capture.stopRaw;
  capture.stopRaw = () => {};
  stop();
}

/** The stream's lines: those that ended, and the cursor's. */
function streamLines(stream: LineModel): string[] {
  return [...stream.complete, stream.current()];
}

/**
 * Looks for the prompt's return after each piece of raw output. The noted
 * prompt ends the output at once; another line that looks like a prompt,
 * once the terminal stays quiet after it.
 */
function watchForPrompt(capture: Capture, stream: LineModel): void {
  if (capture.quiet) clearTimeout(capture.quiet);
  capture.quiet = null;
  const head = promptHead(capture.prompt);
  const complete = stream.complete;
  const typed = commandLines(capture.command);
  // The command's lines are the first few: no copy of a long output.
  const from = outputStart(
    complete.length >= typed.length ? complete : streamLines(stream),
    0,
    typed,
  );
  const first = Math.max(capture.checked, from);
  for (let index = first; index < complete.length; index++) {
    if (isNotedPrompt(complete[index], head)) {
      promptBack(capture, index);
      return;
    }
  }
  capture.checked = complete.length;
  const cursorLine = complete.length;
  if (cursorLine < from) return;
  const before = stream.beforeCursor();
  if (isNotedPrompt(before, head) || isNotedPrompt(stream.current(), head)) {
    promptBack(capture, cursorLine);
  } else if (looksLikePrompt(before)) {
    capture.quiet = setTimeout(() => promptBack(capture, cursorLine), QUIET_MS);
  }
}

/** The prompt is back: the copy stops, and a sure read no longer changes. */
function promptBack(capture: Capture, line: number): void {
  capture.streamEnd = line;
  stopRawCopy(capture);
  const read = streamRead(capture);
  if (read && read.startSure && !read.drawn) {
    capture.final = { ...read, final: true };
  }
}

/** The stream's output so far, or null without a stream. */
function streamRead(capture: Capture): CaptureRead | null {
  const stream = capture.stream;
  if (!stream) return null;
  const lines = streamLines(stream);
  const typed = commandLines(capture.command);
  // The first line is the command's, up to the person's Enter.
  const startSure = typed.length > 0 && lines[0].includes(typed[0]);
  const from = outputStart(lines, 0, typed);
  const end =
    capture.streamEnd === null
      ? lines.length
      : outputEnd(lines, from, capture.streamEnd, capture.promptTop);
  const text = trimLines(lines.slice(from, end)).join("\n");
  const kept = cut(text);
  return {
    text: kept.text,
    truncated: capture.streamCut || kept.truncated,
    finished: capture.streamEnd !== null,
    startSure,
    drawn: stream.drawn(),
    passwordPrompt: false,
    from: "stream",
    final: false,
  };
}

/**
 * Starts a capture for a run, before its command is typed into the
 * session's terminal. False when the terminal cannot be read, or its last
 * line does not look like a prompt: the paste box then works as before. A
 * capture already on the session stops reading, so the new command is not
 * in its text.
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
  if (!reader || !lines) return false;
  const promptLine = [...lines].reverse().find((line) => line.text.trim());
  if (!promptLine || !canBePrompt(promptLine.text)) return false;
  for (const other of [...captures.values()]) {
    if (other.sessionId === options.sessionId) stopReading(other);
  }
  while (captures.size >= MAX_CAPTURES) {
    endCapture(captures.keys().next().value!);
  }
  const capture: Capture = {
    runId: options.runId,
    sessionId: options.sessionId,
    command: options.command,
    reader: options.reader,
    prompt: promptLine.text,
    promptTop: twoLineTop(
      promptHead(promptLine.text),
      lines[lines.indexOf(promptLine) - 1]?.text,
    ),
    stream: null,
    streamCut: false,
    streamEnd: null,
    checked: 0,
    quiet: null,
    stopRaw: () => {},
    last: null,
    final: null,
  };
  if (reader.subscribe) {
    const stream = createLineModel();
    const unsubscribe = guarded<(() => void) | null>(
      () =>
        reader.subscribe!((data) => {
          if (capture.streamEnd !== null || typeof data !== "string") return;
          stream.push(data);
          if (stream.size() > MAX_PASTED_CHARS) {
            capture.streamCut = true;
            stopReading(capture);
            return;
          }
          watchForPrompt(capture, stream);
        }),
      null,
    );
    if (unsubscribe) {
      capture.stream = stream;
      const timer = setTimeout(
        () => stopReading(capture),
        Math.max(options.timeoutMs ?? 0, RAW_MIN_MS),
      );
      capture.stopRaw = () => {
        clearTimeout(timer);
        unsubscribe();
      };
    }
  }
  captures.set(options.runId, capture);
  return true;
}

/**
 * Stops a capture's reading where it is: the time limit, Mark done's limit,
 * a new command on its terminal, or its tab closed. What it read stays,
 * with its warnings; with nothing read, the capture ends.
 */
function stopReading(capture: Capture): void {
  stopRawCopy(capture);
  if (capture.final) return;
  const stream = streamRead(capture);
  const read =
    stream && stream.startSure && !stream.drawn
      ? stream
      : (capture.last ?? stream);
  if (read && read.text !== "") {
    capture.final = { ...read, passwordPrompt: false, final: true };
  } else endCapture(capture.runId);
}

/** Whether this page has a capture for the run. */
export function hasCapture(runId: number): boolean {
  return captures.has(runId);
}

/**
 * What the run's command printed so far, or null with no capture, or when
 * nothing can be read for sure yet.
 */
export function readCapture(runId: number): CaptureRead | null {
  const capture = captures.get(runId);
  if (!capture) return null;
  if (capture.final) return capture.final;
  const reader = capture.reader();
  if (!reader) {
    // The tab is closed: the capture reads no more.
    stopReading(capture);
    return captures.get(runId)?.final ?? null;
  }
  const passwordPrompt = reader.atPasswordPrompt();
  let read = streamRead(capture);
  if (!read || !read.startSure || read.drawn) {
    const lines = reader.lines();
    const screen = lines
      ? screenOutput(
          lines.map((line) => line.text),
          capture.prompt,
          capture.command,
          capture.promptTop,
        )
      : null;
    if (screen) {
      const kept = cut(screen.text);
      read = {
        ...kept,
        finished: screen.finished,
        startSure: true,
        drawn: false,
        passwordPrompt: false,
        from: "screen",
        final: false,
      };
      if (screen.finished) {
        stopRawCopy(capture);
        capture.final = { ...read, final: true };
        return capture.final;
      }
    } else if (!read) {
      // The screen alone, and its line is gone or not alone: the last read.
      return capture.last;
    }
  }
  capture.last = { ...read, passwordPrompt };
  return capture.last;
}

/** Ends a run's capture: after Mark done or failed. */
export function endCapture(runId: number): void {
  const capture = captures.get(runId);
  if (!capture) return;
  stopRawCopy(capture);
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
