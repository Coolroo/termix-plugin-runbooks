/**
 * The raw output of a Send to terminal step, as lines (1.4.9, BUG-019).
 *
 * A small model of the terminal's current line: a CR goes back to the
 * line's start, a backspace and the cursor codes move along it, the erase
 * codes clear it, and a line feed starts the next line. So a prompt that
 * the shell draws again, a progress bar, an edited command or a right-hand
 * prompt reads as the terminal shows it, and the text before the cursor is
 * what the shell printed last.
 *
 * Codes that move the cursor to another row (up or down, an absolute
 * place, a scroll region, a saved cursor: tmux, full-screen programs, some
 * prompts) cannot be followed without the screen. The model notes them
 * (`drawn`), and the capture then reads the screen, or warns. Text on the
 * alternate screen (less, vim) is not kept.
 */

import { escapeEnd } from "../../shared/terminal-text";

const ESC = "\u001b";
/** A code that never ends is dropped once it is this long. */
const MAX_HELD = 512;
/** A cursor move or a blank run longer than this is cut to it. */
const MAX_MOVE = 1000;
const TAB = 8;

export interface LineModel {
  /** Takes the next piece of raw output. */
  push: (data: string) => void;
  /** The lines that have ended, without spaces at their ends. */
  readonly complete: readonly string[];
  /** The cursor's line, without spaces at its end. */
  current: () => string;
  /** The cursor's line up to the cursor, as printed. */
  beforeCursor: () => string;
  /** Whether a code moved the cursor off its line (see above). */
  drawn: () => boolean;
  /** The characters kept so far. */
  size: () => number;
}

export function createLineModel(): LineModel {
  const complete: string[] = [];
  let completeSize = 0;
  let cells: string[] = [];
  let column = 0;
  let pending = "";
  let drawn = false;
  let alternate = false;

  const put = (char: string) => {
    while (cells.length < column) cells.push(" ");
    cells[column] = char;
    column++;
  };

  const lineFeed = () => {
    const text = cells.join("").trimEnd();
    complete.push(text);
    completeSize += text.length + 1;
    cells = [];
    column = 0;
  };

  const csi = (code: string) => {
    const final = code[code.length - 1];
    const params = code.slice(1, -1);
    if (params.startsWith("?")) {
      if (
        /^\?(1049|1047|47)$/.test(params) &&
        (final === "h" || final === "l")
      ) {
        alternate = final === "h";
      }
      return;
    }
    if (alternate) return;
    const value = Number.parseInt(params, 10);
    const count = Math.min(
      Number.isNaN(value) || value < 1 ? 1 : value,
      MAX_MOVE,
    );
    const mode = Number.isNaN(value) ? 0 : value;
    switch (final) {
      case "C":
        column += count;
        break;
      case "D":
        column = Math.max(0, column - count);
        break;
      case "G":
        column = count - 1;
        break;
      case "K":
        if (mode === 0) cells.length = Math.min(cells.length, column);
        else if (mode === 1) {
          for (
            let index = 0;
            index <= column && index < cells.length;
            index++
          ) {
            cells[index] = " ";
          }
        } else cells = [];
        break;
      case "J":
        // Below the cursor: on its line, the rest of the line. The whole
        // screen (2, 3) has no meaning for lines that already ended.
        if (mode === 0) cells.length = Math.min(cells.length, column);
        break;
      case "P":
        cells.splice(column, count);
        break;
      case "@":
        if (column < cells.length) {
          cells.splice(column, 0, ...Array<string>(count).fill(" "));
        }
        break;
      case "X":
        for (let index = column; index < column + count; index++) {
          if (index < cells.length) cells[index] = " ";
        }
        break;
      case "A":
      case "B":
      case "E":
      case "F":
      case "H":
      case "f":
      case "d":
      case "r":
      case "S":
      case "T":
      case "L":
      case "M":
      case "s":
      case "u":
        drawn = true;
        break;
      default:
        // Colours and the rest change nothing on the line.
        break;
    }
  };

  const escape = (code: string) => {
    if (code[0] === "[") return csi(code);
    if (alternate) return;
    // ESC 7 and 8 save and restore the cursor; M moves it up; c resets.
    if ("78Mc".includes(code[0])) drawn = true;
    // ESC D and E: the next line.
    else if (code[0] === "D" || code[0] === "E") lineFeed();
  };

  return {
    push(data) {
      pending += data;
      let index = 0;
      while (index < pending.length) {
        const char = pending[index];
        if (char === ESC) {
          const end = escapeEnd(pending, index);
          if (end === -1) {
            if (pending.length - index < MAX_HELD) break;
            index++;
            continue;
          }
          escape(pending.slice(index + 1, end));
          index = end;
          continue;
        }
        const code = pending.codePointAt(index)!;
        const width = code > 0xffff ? 2 : 1;
        index += width;
        if (alternate) continue;
        if (char === "\r") column = 0;
        else if (char === "\n") lineFeed();
        else if (char === "\b") column = Math.max(0, column - 1);
        else if (char === "\t") column += TAB - (column % TAB);
        else if (
          code >= 0x20 &&
          code !== 0x7f &&
          (code < 0x80 || code > 0x9f)
        ) {
          put(String.fromCodePoint(code));
        }
      }
      pending = pending.slice(index);
    },
    complete,
    current: () => cells.join("").trimEnd(),
    beforeCursor: () =>
      cells.slice(0, column).join("") +
      " ".repeat(Math.max(0, column - cells.length)),
    drawn: () => drawn,
    size: () => completeSize + cells.length,
  };
}
