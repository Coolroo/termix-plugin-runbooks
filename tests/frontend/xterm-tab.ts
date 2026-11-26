/**
 * A terminal tab as SSH Terminal makes it, on the real terminal library
 * (@xterm/xterm, the version Termix ships), for the capture tests
 * (BUG-019). The handle's `readBufferLines` is SSH Terminal's own, and the
 * host's output goes to the output listeners first, then to the screen, in
 * that order (Plugin-SSH-Terminal, Terminal.tsx, a3d6405).
 */

import { Terminal } from "@xterm/xterm";
import type { BufferLine } from "../../src/frontend/running/terminal-capture";

/** The parts of an xterm buffer that readBufferLines reads. */
interface ReadableBuffer {
  length: number;
  getLine: (
    index: number,
  ) =>
    | { isWrapped: boolean; translateToString: (trimRight?: boolean) => string }
    | undefined;
}

/**
 * The buffer's text, with rows the terminal wrapped joined back into one
 * line. Copied from Plugin-SSH-Terminal, src/frontend/terminal-tools/
 * buffer-lines.ts (a3d6405).
 */
export function readBufferLines(buffer: ReadableBuffer): BufferLine[] {
  const lines: BufferLine[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const wrapsOn = buffer.getLine(row + 1)?.isWrapped === true;
    const text = line.translateToString(!wrapsOn);
    const last = lines[lines.length - 1];
    if (line.isWrapped && last) {
      last.text += text;
      last.lastRow = row;
    } else {
      lines.push({ text, firstRow: row, lastRow: row });
    }
  }
  return lines;
}

export function xtermTab(
  options: {
    cols?: number;
    rows?: number;
    scrollback?: number;
    /** False: a terminal that offers no raw output (the screen alone). */
    subscribe?: boolean;
  } = {},
) {
  const term = new Terminal({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 1000,
    allowProposedApi: true,
  });
  const listeners = new Set<(data: string) => void>();
  const handle: Record<string, unknown> = {
    readBufferLines: () => readBufferLines(term.buffer.active),
    isAtPasswordPrompt: () => false,
    getInputModes: () => ({
      applicationCursor: term.modes.applicationCursorKeysMode,
      bracketedPaste: term.modes.bracketedPasteMode,
      backspace: "normal",
    }),
  };
  if (options.subscribe !== false) {
    handle.subscribeOutput = (listener: (data: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
  }
  const tab = {
    term,
    listeners,
    shell: {
      tabs: { list: [{ id: "web", terminalRef: { current: handle } }] },
    },
    /** The host sends `data`: to the listeners, then to the screen. */
    async host(data: string) {
      for (const listener of [...listeners]) listener(data);
      await new Promise<void>((resolve) => term.write(data, resolve));
    },
    /** The screen's lines with text, as the person sees them. */
    screen(): string[] {
      return readBufferLines(term.buffer.active)
        .map((line) => line.text.trimEnd())
        .filter((text) => text !== "");
    },
  };
  return tab;
}

export type XtermTab = ReturnType<typeof xtermTab>;
