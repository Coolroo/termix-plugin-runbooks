/**
 * Replaces secret values in output with "[secret:<name>]" before the output
 * is kept anywhere: the live buffer, the run row, the API and MCP.
 *
 * Output arrives in pieces, so a value can be split across two of them. The
 * streaming form holds back the end of each stream that a value starts with
 * until more arrives or the stream ends: a value that is still incomplete
 * can start only there. Anything else shows at once (1.4.6), so a prompt
 * such as "Password: " is not held back. The whole-text form runs the same
 * steps, so the live output and the stored output read the same.
 */

export interface SecretText {
  name: string;
  value: string;
}

export const marker = (name: string) => `[secret:${name}]`;

/** Longest first, so a value that holds another is replaced whole. */
function prepare(secrets: SecretText[]): SecretText[] {
  const seen = new Set<string>();
  return secrets
    .filter((secret) => {
      if (!secret.value || seen.has(secret.value)) return false;
      seen.add(secret.value);
      return true;
    })
    .sort((a, b) => b.value.length - a.value.length);
}

/**
 * Where the longest end of `text` after `from` that is the start of a value
 * (and not the whole value) begins; text.length when there is none.
 */
function heldFrom(text: string, from: number, list: SecretText[]): number {
  let at = text.length;
  for (const secret of list) {
    const longest = Math.min(secret.value.length - 1, text.length - from);
    for (let size = longest; size > text.length - at; size--) {
      if (secret.value.startsWith(text.slice(text.length - size))) {
        at = text.length - size;
        break;
      }
    }
  }
  return at;
}

export interface Redactor {
  /** Takes the next piece; returns the text that is safe to show now. */
  push: (text: string) => string;
  /** The rest, at the end of the stream. */
  end: () => string;
  /**
   * Hides one more value from the next piece on (typed input, 1.4.6).
   * Text already handed out is not changed.
   */
  add: (secret: SecretText) => void;
}

export function createRedactor(secrets: SecretText[]): Redactor {
  const all = [...secrets];
  let list = prepare(all);
  let pending = "";

  /** Replaces every whole value; keeps back what may be a value's start. */
  function drain(final: boolean): string {
    let out = "";
    let cursor = 0;
    // Where a longer value may be starting but has not fully arrived.
    let wait = Infinity;
    for (;;) {
      let at = -1;
      let found: SecretText | null = null;
      for (const secret of list) {
        const index = pending.indexOf(secret.value, cursor);
        if (index !== -1 && (at === -1 || index < at)) {
          at = index;
          found = secret;
        }
      }
      if (!found) break;
      // A longer value that holds this one may start here or before and
      // still complete (BUG-010): hold back from the earliest such start,
      // or part of the longer value would show.
      const hold = final ? Infinity : heldFrom(pending, cursor, list);
      if (hold <= at) {
        wait = hold;
        break;
      }
      out += pending.slice(cursor, at) + marker(found.name);
      cursor = at + found.value.length;
    }
    const safe = final
      ? pending.length
      : Math.min(wait, heldFrom(pending, cursor, list));
    out += pending.slice(cursor, safe);
    pending = pending.slice(safe);
    return out;
  }

  return {
    push(text) {
      if (list.length === 0) return text;
      pending += text;
      return drain(false);
    },
    end() {
      if (list.length === 0) return "";
      return drain(true);
    },
    add(secret) {
      all.push(secret);
      list = prepare(all);
    },
  };
}

/** A whole text with every value replaced. */
export function redact(text: string, secrets: SecretText[]): string;
export function redact(
  text: string | null,
  secrets: SecretText[],
): string | null;
export function redact(
  text: string | null,
  secrets: SecretText[],
): string | null {
  if (text === null || secrets.length === 0) return text;
  const redactor = createRedactor(secrets);
  return redactor.push(text) + redactor.end();
}
