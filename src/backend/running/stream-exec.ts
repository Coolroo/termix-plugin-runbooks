/**
 * Runs one command on an open ssh2 client and hands its output over as it
 * arrives, so a person can watch a long command and stop it.
 *
 * The same limits as ctx.ssh.exec: a time limit, and a cap on the bytes kept
 * of each of stdout and stderr (the rest is dropped and the result marked
 * truncated). stdout and stderr stay apart. Each stream has its own decoder,
 * so a character split across two chunks still reads as one.
 */

import { StringDecoder } from "node:string_decoder";
import {
  createTerminalCleaner,
  type TerminalCleaner,
} from "../../shared/terminal-text.js";

export type StreamName = "stdout" | "stderr";

/** The parts of an ssh2 ClientChannel this module uses. */
export interface ExecChannel {
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  stderr: { on: (event: string, listener: (chunk: Buffer) => void) => unknown };
  close: () => unknown;
  /** Sends a signal to the command. Many servers ignore it without a pty. */
  signal?: (name: string) => unknown;
  /** Writes to the command's standard input. */
  write?: (data: Buffer) => unknown;
  /** Ends the command's standard input (EOF). */
  end?: () => unknown;
}

/** A terminal for the command, in ssh2's shape (1.4.6). */
export interface PtyOptions {
  term: string;
  rows: number;
  cols: number;
}

/** The parts of an ssh2 Client this module uses. */
export interface ExecClient {
  exec: (
    command: string,
    options: { pty?: PtyOptions },
    callback: (error: Error | undefined, channel: ExecChannel) => void,
  ) => unknown;
}

/**
 * The terminal an interactive step's command gets: "dumb" asks programs
 * for no colour; what they send anyway is taken out (terminal-text.ts).
 */
export const INTERACTIVE_PTY: PtyOptions = {
  term: "dumb",
  rows: 40,
  cols: 200,
};

/** Ctrl-D: end of input for a program that reads a terminal. */
const END_OF_INPUT = Buffer.from([0x04]);

export interface StreamExecOptions {
  timeoutMs: number;
  /** Most bytes kept of each of stdout and stderr. */
  maxOutputBytes: number;
  /** Called with each piece of text kept, in the order it arrived. */
  onOutput?: (stream: StreamName, text: string) => void;
  /** Called once when output first goes past the cap. */
  onTruncate?: () => void;
  /**
   * Written to the command's standard input once it starts, which is then
   * ended. Without it, standard input is left open, as before 1.2.0.
   */
  stdin?: Buffer;
  /**
   * Opens a terminal for the command (1.4.6): stdout and stderr then come
   * as one stream, and its output is made plain before it is handed over.
   */
  pty?: PtyOptions;
}

export interface StreamExecResult {
  stdout: string;
  stderr: string;
  /** The exit code. Null when the command was stopped, timed out or killed. */
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
  /** stop() ended the command. */
  stopped: boolean;
}

export interface StreamExecHandle {
  result: Promise<StreamExecResult>;
  /**
   * Ends the command: a TERM signal where the server takes one, then the
   * channel is closed. The result settles at once with stopped set.
   */
  stop: () => void;
  /**
   * Writes to the command's standard input (1.4.6). False when it cannot
   * take input: not started yet, ended, its input was ended, or the run
   * gave it `stdin`.
   */
  write: (data: Buffer) => boolean;
  /** The command takes input now: write would not refuse. */
  inputOpen: () => boolean;
  /**
   * Ends the command's standard input: EOF without a pty, Ctrl-D with one
   * (twice when the last input did not end a line). False as for write.
   */
  endInput: () => boolean;
}

export function streamExec(
  client: ExecClient,
  command: string,
  options: StreamExecOptions,
): StreamExecHandle {
  let settled = false;
  let timedOut = false;
  let stopped = false;
  let truncated = false;
  let channel: ExecChannel | null = null;
  let inputEnded = options.stdin !== undefined;
  /** The last input ended a line, or there was none: Ctrl-D works there. */
  let atLineStart = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const text: Record<StreamName, string> = { stdout: "", stderr: "" };
  const bytes: Record<StreamName, number> = { stdout: 0, stderr: 0 };
  const decoders: Record<StreamName, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  // Once a stream is full, its decoder may hold the start of a character
  // that was cut; it is never flushed, so no replacement character shows.
  const full: Record<StreamName, boolean> = { stdout: false, stderr: false };
  const cleaners: Record<StreamName, TerminalCleaner> | null = options.pty
    ? { stdout: createTerminalCleaner(), stderr: createTerminalCleaner() }
    : null;

  let resolveResult!: (result: StreamExecResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<StreamExecResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const emit = (stream: StreamName, decoded: string, last = false) => {
    const piece = cleaners
      ? cleaners[stream].push(decoded) + (last ? cleaners[stream].end() : "")
      : decoded;
    if (!piece) return;
    text[stream] += piece;
    try {
      options.onOutput?.(stream, piece);
    } catch {
      // A listener's problem never ends the command.
    }
  };

  const markTruncated = () => {
    if (truncated) return;
    truncated = true;
    try {
      options.onTruncate?.();
    } catch {
      // A listener's problem never ends the command.
    }
  };

  const append = (stream: StreamName, chunk: Buffer) => {
    if (settled) return;
    if (full[stream]) {
      if (chunk.length > 0) markTruncated();
      return;
    }
    const room = options.maxOutputBytes - bytes[stream];
    if (chunk.length > room) {
      markTruncated();
      full[stream] = true;
      const kept = chunk.subarray(0, Math.max(0, room));
      bytes[stream] += kept.length;
      emit(stream, decoders[stream].write(kept));
      return;
    }
    bytes[stream] += chunk.length;
    emit(stream, decoders[stream].write(chunk));
  };

  const closeChannel = (signal: boolean) => {
    if (!channel) return;
    if (signal) {
      try {
        channel.signal?.("TERM");
      } catch {
        // The server may not take signals.
      }
    }
    try {
      channel.close();
    } catch {
      // Already closed.
    }
  };

  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    for (const stream of ["stdout", "stderr"] as const) {
      emit(stream, full[stream] ? "" : decoders[stream].end(), true);
    }
    resolveResult({
      stdout: text.stdout,
      stderr: text.stderr,
      code,
      truncated,
      timedOut,
      stopped,
    });
  };

  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    rejectResult(error);
  };

  try {
    const execOptions = options.pty ? { pty: options.pty } : {};
    client.exec(command, execOptions, (error, opened) => {
      if (error) {
        fail(error);
        return;
      }
      channel = opened;
      if (settled) {
        // Stopped before the channel opened.
        closeChannel(true);
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        closeChannel(true);
        finish(null);
      }, options.timeoutMs);
      opened.on("data", ((chunk: Buffer) => append("stdout", chunk)) as never);
      opened.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      opened.on("close", ((code: number | null | undefined) =>
        finish(typeof code === "number" ? code : null)) as never);
      opened.on("error", ((streamError: Error) => fail(streamError)) as never);
      if (options.stdin !== undefined) {
        try {
          if (options.stdin.length > 0) opened.write?.(options.stdin);
          opened.end?.();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }

  const inputOpen = () => !settled && !inputEnded && Boolean(channel?.write);

  const send = (data: Buffer): boolean => {
    if (!inputOpen()) return false;
    try {
      channel!.write!(data);
    } catch {
      return false;
    }
    if (data.length > 0) {
      const last = data[data.length - 1];
      atLineStart = last === 0x0a || last === 0x0d;
    }
    return true;
  };

  return {
    result,
    stop: () => {
      if (settled) return;
      stopped = true;
      closeChannel(true);
      finish(null);
    },
    write: send,
    inputOpen,
    endInput: () => {
      if (!inputOpen()) return false;
      if (options.pty) {
        // A pty sees no EOF from end(): Ctrl-D at the start of a line is.
        // In mid-line, the first Ctrl-D hands the line to the command as
        // it is, without a line end it never typed (BUG-010), and the
        // second is the EOF.
        if (!atLineStart && !send(END_OF_INPUT)) return false;
        if (!send(END_OF_INPUT)) return false;
      } else {
        try {
          channel!.end?.();
        } catch {
          return false;
        }
      }
      inputEnded = true;
      return true;
    },
  };
}
