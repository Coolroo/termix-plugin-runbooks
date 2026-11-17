/**
 * Output from a command with a pty (an interactive step, 1.4.6) carries
 * what a terminal draws with: CR LF line ends, a lone CR for a progress
 * line, colour codes and title codes. They are taken out before the output
 * is kept anywhere, so the live output, the stored output and the checks
 * read plain lines.
 *
 * Output arrives in pieces, so a code or a CR LF can be split across two of
 * them. The streaming form holds back a code that is not complete yet and a
 * CR at the end of a piece until more arrives or the stream ends. The
 * whole-text form runs the same steps.
 */

const ESC = "\u001b";
const BEL = "\u0007";
/** A code that never ends is dropped once it is this long. */
const MAX_HELD = 512;

export interface TerminalCleaner {
  /** Takes the next piece; returns the plain text that is ready now. */
  push: (text: string) => string;
  /** The rest, at the end of the stream. */
  end: () => string;
}

/**
 * Where the escape sequence at `at` ends (the index after it), or -1 when
 * it is not complete yet. CSI: ESC [ params final (@ to ~). OSC, DCS and
 * the other string codes: ESC ] ... BEL or ESC \. Any other: ESC, then
 * intermediates (space to /), then one final byte.
 */
function escapeEnd(text: string, at: number): number {
  const kind = text[at + 1];
  if (kind === undefined) return -1;
  if (kind === "[") {
    for (let index = at + 2; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
      if (code < 0x20 || code > 0x3f) return index;
    }
    return -1;
  }
  if ("]PX^_".includes(kind)) {
    for (let index = at + 2; index < text.length; index++) {
      if (text[index] === BEL) return index + 1;
      if (text[index] === ESC) {
        if (index + 1 >= text.length) return -1;
        return text[index + 1] === "\\" ? index + 2 : index;
      }
    }
    return -1;
  }
  for (let index = at + 1; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) continue;
    return code >= 0x30 && code <= 0x7e ? index + 1 : index;
  }
  return -1;
}

/** A control character that is not a line end or a tab. */
function isControl(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a && code !== 0x09) ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f)
  );
}

export function createTerminalCleaner(): TerminalCleaner {
  let pending = "";

  function drain(final: boolean): string {
    let out = "";
    let index = 0;
    while (index < pending.length) {
      const char = pending[index];
      if (char === ESC) {
        const end = escapeEnd(pending, index);
        if (end === -1) {
          if (!final && pending.length - index < MAX_HELD) break;
          // Never complete: drop the ESC and read on.
          index++;
          continue;
        }
        index = end;
        continue;
      }
      if (char === "\r") {
        if (index + 1 >= pending.length && !final) break;
        out += "\n";
        index += pending[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (!isControl(pending.charCodeAt(index))) out += char;
      index++;
    }
    pending = pending.slice(index);
    return out;
  }

  return {
    push(text) {
      pending += text;
      return drain(false);
    },
    end() {
      const out = drain(true);
      pending = "";
      return out;
    },
  };
}

/** A whole text, made plain. */
export function cleanTerminalText(text: string): string {
  const cleaner = createTerminalCleaner();
  return cleaner.push(text) + cleaner.end();
}
