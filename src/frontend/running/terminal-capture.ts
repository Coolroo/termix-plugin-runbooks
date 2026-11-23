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
 * Before the command is typed, the capture notes the terminal's last line
 * (the prompt) and its row. A read finds that line again with the command
 * after it, and takes the lines after the command up to the prompt's next
 * line. Once that line has left the scrollback, or the tab is gone, it
 * reads the raw copy instead, cleaned as an interactive run's output is.
 * Captures live as long as the page: a reload, or another device, has none.
 */

import { createTerminalCleaner } from "../../shared/terminal-text";
import { MAX_PASTED_CHARS } from "../../shared/limits";

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
  /** The prompt came back after the output: the command looks finished. */
  finished: boolean;
  /** The terminal waits at a password prompt. */
  passwordPrompt: boolean;
  /** "screen": the terminal's lines; "raw": the copy, as it arrived. */
  from: "screen" | "raw";
  /** The text was longer than Mark done takes, and was cut. */
  truncated: boolean;
}

/** How long the raw copy follows the terminal at least, in milliseconds. */
export const RAW_MIN_MS = 60 * 60 * 1000;
/** Captures kept at once; the oldest ends first. */
export const MAX_CAPTURES = 20;
/** A prompt shorter than this ("$", "#", ">") counts only on its own line. */
const SHORT_PROMPT = 3;

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

/** Whether `text` is the prompt again: the prompt, maybe with a new command. */
export function isPromptLine(text: string, prompt: string): boolean {
  const mine = prompt.trimEnd();
  if (mine === "") return false;
  const line = text.trimEnd();
  if (line === mine) return true;
  return mine.length >= SHORT_PROMPT && line.startsWith(mine);
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
 * The output in `lines`, which start with the command's first line: the
 * lines after the command, up to the prompt's next line.
 */
export function cutOutput(
  lines: string[],
  prompt: string,
  command: string,
): { text: string; finished: boolean } {
  const typed = commandLines(command);
  let index = 1;
  // A command of several lines: the shell shows each, after a "> ".
  for (const part of typed.slice(1)) {
    if (index < lines.length && lines[index].includes(part)) index++;
  }
  const rest = lines.slice(index);
  const back = rest.findIndex((line) => isPromptLine(line, prompt));
  const output = back === -1 ? rest : rest.slice(0, back);
  return { text: trimLines(output).join("\n"), finished: back !== -1 };
}

/**
 * Where the command's line is now: the line at or before `startRow` (rows
 * only move up, as the scrollback drops its oldest lines) that starts with
 * the prompt and holds the command's first line. -1 when it is gone.
 */
export function findStart(
  lines: BufferLine[],
  startRow: number,
  prompt: string,
  command: string,
): number {
  const first = commandLines(command)[0] ?? "";
  const mine = prompt.trimEnd();
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line.firstRow > startRow) continue;
    if (line.text.startsWith(mine) && line.text.includes(first)) return index;
  }
  return -1;
}

/**
 * The raw copy's output: from the line after the command's echo (when it
 * shows in the first lines), up to the prompt's next line.
 */
export function cutRaw(
  raw: string,
  prompt: string,
  command: string,
): { text: string; finished: boolean } {
  const lines = raw.split("\n");
  const typed = commandLines(command);
  const last = typed[typed.length - 1] ?? "";
  // The echo comes first; Windows may draw a screen before it.
  const echo =
    last === "" ? -1 : lines.findIndex((line) => line.includes(last));
  const from = echo === -1 || echo > typed.length + 4 ? 0 : echo + 1;
  const rest = lines.slice(from);
  const back = rest.findIndex((line) => isPromptLine(line, prompt));
  const output = back === -1 ? rest : rest.slice(0, back);
  return { text: trimLines(output).join("\n"), finished: back !== -1 };
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
  /** Finds the terminal again at each read: a tab may close or reconnect. */
  reader: () => TerminalReader | null;
  /** The last line before the command was typed: the prompt. */
  prompt: string;
  startRow: number;
  /** The raw output since the start, cleaned, up to the limit. */
  raw: string;
  rawCut: boolean;
  stopRaw: () => void;
}

/** The captures, by run id; they live as long as the page. */
const captures = new Map<number, Capture>();

/** Stops a capture's raw copy; what it copied stays readable. */
function stopRawCopy(capture: Capture): void {
  const stop = capture.stopRaw;
  capture.stopRaw = () => {};
  stop();
}

/**
 * Starts a capture for a run, before its command is typed into the
 * session's terminal. False when the terminal cannot be read: the paste box
 * then works as before. A capture already on the session stops its raw copy
 * (it reads the screen still, up to the new command's prompt).
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
  for (const other of captures.values()) {
    if (other.sessionId === options.sessionId) stopRawCopy(other);
  }
  while (captures.size >= MAX_CAPTURES) {
    endCapture(captures.keys().next().value!);
  }
  const promptLine = [...lines].reverse().find((line) => line.text.trim());
  const capture: Capture = {
    runId: options.runId,
    sessionId: options.sessionId,
    command: options.command,
    reader: options.reader,
    prompt: promptLine?.text.trimEnd() ?? "",
    startRow: promptLine?.firstRow ?? lines[lines.length - 1]?.firstRow ?? 0,
    raw: "",
    rawCut: false,
    stopRaw: () => {},
  };
  if (reader.subscribe) {
    const cleaner = createTerminalCleaner();
    const unsubscribe = guarded(
      () =>
        reader.subscribe!((data) => {
          if (capture.rawCut || typeof data !== "string") return;
          capture.raw += cleaner.push(data);
          if (capture.raw.length > MAX_PASTED_CHARS) {
            capture.raw = capture.raw.slice(0, MAX_PASTED_CHARS);
            capture.rawCut = true;
          }
        }),
      () => {},
    );
    const timer = setTimeout(
      () => stopRawCopy(capture),
      Math.max(options.timeoutMs ?? 0, RAW_MIN_MS),
    );
    capture.stopRaw = () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }
  captures.set(options.runId, capture);
  return true;
}

/** Whether this page has a capture for the run. */
export function hasCapture(runId: number): boolean {
  return captures.has(runId);
}

/** What the run's command printed so far, or null with no capture. */
export function readCapture(runId: number): CaptureRead | null {
  const capture = captures.get(runId);
  if (!capture) return null;
  const reader = capture.reader();
  const lines = reader?.lines() ?? null;
  const passwordPrompt = reader?.atPasswordPrompt() ?? false;
  const start = lines
    ? findStart(lines, capture.startRow, capture.prompt, capture.command)
    : -1;
  if (lines && start !== -1) {
    const read = cutOutput(
      lines.slice(start).map((line) => line.text),
      capture.prompt,
      capture.command,
    );
    return { ...read, ...cut(read.text), passwordPrompt, from: "screen" };
  }
  const read = cutRaw(capture.raw, capture.prompt, capture.command);
  return {
    ...read,
    ...cut(read.text),
    truncated: capture.rawCut,
    passwordPrompt,
    from: "raw",
  };
}

/** Ends a run's capture: after Mark done or failed. */
export function endCapture(runId: number): void {
  const capture = captures.get(runId);
  if (!capture) return;
  stopRawCopy(capture);
  captures.delete(runId);
}

/** Ends every capture, as a reload does. */
export function endAllCaptures(): void {
  for (const runId of [...captures.keys()]) endCapture(runId);
}
