/**
 * The raw output of a Send to terminal step, read in two parts (1.4.9,
 * BUG-021): first the command's echo, then its output as lines.
 *
 * The echo: the shell draws the typed command, maybe draws it again on
 * Enter (bash 5.1+ redraws a pasted command; a long or multi-line one after
 * moving the cursor up), then ends the line. A small grid follows that
 * drawing. When the line ends, the rows drawn since the last move up must be
 * the noted prompt's end with the command, each line of a command of several
 * lines on its own row. Then the output starts. When they are not (the
 * person changed the command, or the drawing cannot be followed), or the
 * shell leaves line editing first (`ESC[?2004l`, or a new prompt), the
 * stream is lost: no text is ever read from it.
 *
 * The output: a model of the cursor's line. A CR goes back to the line's
 * start, a backspace and the cursor codes move along it, the erase codes
 * clear it, and a line feed starts the next line, so a progress bar reads as
 * the terminal shows it. The output ends where the shell turns line editing
 * on again for its next prompt (`ESC[?2004h`: bash 5.1+, zsh and fish do).
 * A code that moves the cursor to another row (`clear`, a progress display,
 * tmux, a full-screen program) also ends it: the lines after it cannot be
 * placed without the screen. Text on the alternate screen (less, vim) is not
 * kept. For shells that do not turn line editing on, the noted prompt ends
 * it too: a line that ends with it at its start, or the cursor's line once
 * a piece of output ends with it there.
 */

import { escapeEnd } from "../../shared/terminal-text";

const ESC = "\u001b";
/** A code that never ends is dropped once it is this long. */
const MAX_HELD = 512;
/** A cursor move or a blank run longer than this is cut to it. */
const MAX_MOVE = 1000;
const TAB = 8;

/** Where a stream is. */
export type StreamState =
  /** Before the command's line ends: no text yet. */
  | "echo"
  /** After it: the output is read. */
  | "output"
  /** The output ended: the next prompt, or a cursor move to another row. */
  | "ended"
  /** The echo was not the command: nothing is read. */
  | "lost";

export interface CommandStream {
  /** Takes the next piece of raw output. */
  push: (data: string) => void;
  state: () => StreamState;
  /** The output's lines that have ended, without spaces at their ends. */
  readonly complete: readonly string[];
  /** The cursor's line of the output, without spaces at its end. */
  current: () => string;
  /** The output ended at a cursor move to another row, not at a prompt. */
  drawn: () => boolean;
  /** The output's characters kept so far. */
  size: () => number;
}

/** A parsed escape code: its parameters and its final character. */
interface Code {
  /** Without the ESC; "[" first for a CSI. */
  raw: string;
  params: string;
  final: string;
}

function parseCode(raw: string): Code {
  return raw[0] === "["
    ? { raw, params: raw.slice(1, -1), final: raw[raw.length - 1] }
    : { raw, params: "", final: raw[0] };
}

/** A count parameter: 1 when missing, at most MAX_MOVE. */
function count(params: string, index = 0): number {
  const value = Number.parseInt(params.split(";")[index] ?? "", 10);
  return Math.min(Number.isNaN(value) || value < 1 ? 1 : value, MAX_MOVE);
}

/** A mode parameter (erase): 0 when missing. */
function mode(params: string): number {
  const value = Number.parseInt(params, 10);
  return Number.isNaN(value) ? 0 : value;
}

/** CSI finals that move the cursor to another row, or redraw rows. */
const ROW_MOVES = "ABEFHfdrSTLMsu";

/**
 * One row of cells and a cursor on it, as a terminal line: shared by the
 * echo's grid and the output's line.
 */
class Row {
  cells: (string | undefined)[] = [];
  column = 0;

  put(char: string) {
    this.cells[this.column] = char;
    this.column++;
  }

  /** Cursor and erase codes along the row; false for any other code. */
  edit(code: Code): boolean {
    const n = count(code.params);
    switch (code.final) {
      case "C":
        this.column += n;
        return true;
      case "D":
        this.column = Math.max(0, this.column - n);
        return true;
      case "G":
        this.column = n - 1;
        return true;
      case "K": {
        const how = mode(code.params);
        if (how === 0) {
          this.cells.length = Math.min(this.cells.length, this.column);
        } else if (how === 1) {
          for (let index = 0; index <= this.column; index++) {
            if (index < this.cells.length) this.cells[index] = " ";
          }
        } else this.cells = [];
        return true;
      }
      case "P":
        this.cells.splice(this.column, n);
        return true;
      case "@":
        if (this.column < this.cells.length) {
          this.cells.splice(this.column, 0, ...Array<string>(n).fill(" "));
        }
        return true;
      case "X":
        for (let index = this.column; index < this.column + n; index++) {
          if (index < this.cells.length) this.cells[index] = " ";
        }
        return true;
      default:
        return false;
    }
  }

  control(char: string): boolean {
    if (char === "\r") this.column = 0;
    else if (char === "\b") this.column = Math.max(0, this.column - 1);
    else if (char === "\t") this.column += TAB - (this.column % TAB);
    else return false;
    return true;
  }

  /** The row's text; cells never written are spaces. */
  text(): string {
    return Array.from(this.cells, (cell) => cell ?? " ")
      .join("")
      .trimEnd();
  }

  /** The text from the first cell written: a row redrawn from its middle. */
  written(): string {
    const first = this.cells.findIndex((cell) => cell !== undefined);
    return first === -1 ? "" : this.text().slice(first);
  }
}

/**
 * Whether the rows drawn are the command: the first ends with its first
 * line, after nothing or after the end of the prompt and a space; each next
 * row is its next line, maybe after bash's "> " (a shell without bracketed
 * paste runs a command of several lines line by line).
 */
export function isEcho(
  rows: readonly string[],
  command: readonly string[],
  promptHead: string,
): boolean {
  if (command.length === 0 || rows.length !== command.length) return false;
  const first = command[0].trim();
  if (first === "" || !rows[0].endsWith(first)) return false;
  const before = rows[0].slice(0, rows[0].length - first.length);
  if (
    before !== "" &&
    !(/\s$/.test(before) && promptHead.endsWith(before.trimEnd()))
  ) {
    return false;
  }
  return command.slice(1).every((line, index) => {
    const row = rows[index + 1];
    const text = line.trimEnd();
    return row === text || row === `> ${text}`.trimEnd();
  });
}

/** The command as the lines the shell draws. */
export function commandLines(command: string): string[] {
  return command.trimEnd().split(/\r?\n/);
}

export function createCommandStream(
  command: string,
  {
    promptHead,
    bracketed = false,
    isPrompt = () => false,
  }: {
    /** The noted prompt, without a right-hand prompt or end spaces. */
    promptHead: string;
    /**
     * The terminal pastes in bracketed paste mode: the shell shows a pasted
     * command of several lines before Enter, and ends line editing
     * (`ESC[?2004l`) on Enter. The output then starts only there.
     */
    bracketed?: boolean;
    /** Whether a line of the output is the noted prompt. */
    isPrompt?: (line: string) => boolean;
  },
): CommandStream {
  const typed = commandLines(command);
  let state: StreamState = "echo";
  let pending = "";

  // The echo: rows drawn since the last move up, and the cursor's row.
  let grid: Row[] = [new Row()];
  let gridRow = 0;

  // The output.
  const complete: string[] = [];
  let completeSize = 0;
  let line = new Row();
  let drawn = false;
  let alternate = false;

  /** The grid starts again where the cursor is: the shell redraws. */
  const regrid = (column: number) => {
    grid = [new Row()];
    gridRow = 0;
    grid[0].column = Math.max(0, column);
  };

  /** Whether the rows drawn are the command; an empty last row aside. */
  const echoMatches = () => {
    const last =
      gridRow > 0 && grid[gridRow].text() === "" ? gridRow : gridRow + 1;
    return isEcho(
      grid
        .slice(0, last)
        .map((row, index) => (index === 0 ? row.written() : row.text())),
      typed,
      promptHead,
    );
  };

  /** The command's line ended: its output starts, or nothing is read. */
  const lineEnds = (): void => {
    if (!bracketed && echoMatches()) {
      state = "output";
      return;
    }
    const column = grid[gridRow].column;
    gridRow++;
    grid[gridRow] ??= new Row();
    grid[gridRow].column = column;
    // More rows than the command has: the echo will not match.
    if (gridRow > typed.length + 1) state = "lost";
  };

  const echoCode = (code: Code) => {
    const row = grid[gridRow];
    if (code.raw[0] !== "[") {
      // ESC 7/8 save and restore the cursor, M moves it up, c resets.
      if ("78Mc".includes(code.final)) regrid(row.column);
      else if (code.final === "D" || code.final === "E") lineEnds();
      return;
    }
    if (code.params.startsWith("?")) {
      // Line editing ends (Enter, Ctrl-C): the command's line must be in.
      if (code.params === "?2004" && code.final === "l") {
        state = echoMatches() ? "output" : "lost";
      } else if (code.params === "?2004" && code.final === "h") {
        state = "lost";
      }
      return;
    }
    if (row.edit(code)) return;
    switch (code.final) {
      case "B":
      case "E":
        for (let step = count(code.params); step > 0; step--) {
          gridRow++;
          grid[gridRow] ??= new Row();
        }
        grid[gridRow].column = code.final === "E" ? 0 : row.column;
        if (gridRow > typed.length + 1) state = "lost";
        return;
      case "H":
      case "f":
        regrid(count(code.params, 1) - 1);
        return;
      case "F":
        regrid(0);
        return;
      case "J":
        if (mode(code.params) === 0) {
          row.edit({ raw: "[K", params: "", final: "K" });
          grid.length = gridRow + 1;
        }
        return;
      default:
        if (ROW_MOVES.includes(code.final)) regrid(row.column);
    }
  };

  /** The output ended at the noted prompt: its line is not output. */
  const notedPrompt = () => {
    line = new Row();
    state = "ended";
  };

  const lineFeed = () => {
    const text = line.text();
    if (isPrompt(text)) return notedPrompt();
    complete.push(text);
    completeSize += text.length + 1;
    line = new Row();
  };

  /** The output ended at the next prompt: the cursor's line is output. */
  const promptBack = () => {
    if (line.text() !== "") lineFeed();
    state = "ended";
  };

  const outputCode = (code: Code) => {
    if (code.raw[0] === "[" && code.params.startsWith("?")) {
      if (/^\?(1049|1047|47)$/.test(code.params)) {
        alternate = code.final === "h";
      } else if (code.params === "?2004" && code.final === "h") {
        promptBack();
      }
      return;
    }
    if (alternate) return;
    if (code.raw[0] !== "[") {
      if ("78Mc".includes(code.final)) {
        drawn = true;
        state = "ended";
      } else if (code.final === "D" || code.final === "E") lineFeed();
      return;
    }
    if (line.edit(code)) return;
    if (code.final === "J") {
      // Below the cursor: on its line, the rest of the line. The whole
      // screen (2, 3) is a clear: a cursor move to another row follows.
      if (mode(code.params) === 0) {
        line.edit({ raw: "[K", params: "", final: "K" });
      }
      return;
    }
    if (ROW_MOVES.includes(code.final)) {
      drawn = true;
      state = "ended";
    }
  };

  const char = (value: string) => {
    if (state === "echo") {
      const row = grid[gridRow];
      if (value === "\n") lineEnds();
      else if (!row.control(value) && printable(value)) row.put(value);
      return;
    }
    if (alternate) return;
    if (value === "\n") lineFeed();
    else if (!line.control(value) && printable(value)) line.put(value);
  };

  const code = (raw: string) => {
    const parsed = parseCode(raw);
    if (state === "echo") echoCode(parsed);
    else outputCode(parsed);
  };

  return {
    push(data) {
      if (state === "ended" || state === "lost") return;
      pending += data;
      let index = 0;
      while (
        index < pending.length &&
        (state === "echo" || state === "output")
      ) {
        if (pending[index] === ESC) {
          const end = escapeEnd(pending, index);
          if (end === -1) {
            if (pending.length - index < MAX_HELD) break;
            index++;
            continue;
          }
          code(pending.slice(index + 1, end));
          index = end;
          continue;
        }
        const point = pending.codePointAt(index)!;
        const value = String.fromCodePoint(point);
        index += value.length;
        char(value);
      }
      pending =
        state === "echo" || state === "output" ? pending.slice(index) : "";
      if (state === "output" && isPrompt(line.text())) notedPrompt();
    },
    state: () => state,
    complete,
    current: () => line.text(),
    drawn: () => drawn,
    size: () => completeSize + line.cells.length,
  };
}

/** A character a terminal prints: not a control character. */
function printable(value: string): boolean {
  const point = value.codePointAt(0)!;
  return point >= 0x20 && point !== 0x7f && (point < 0x80 || point > 0x9f);
}
