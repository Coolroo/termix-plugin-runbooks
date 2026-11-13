/**
 * Replaces secret values in output with "[secret:<name>]" before the output
 * is kept anywhere: the live buffer, the run row, the API and MCP.
 *
 * Output arrives in pieces, so a value can be split across two of them. The
 * streaming form holds back the last (longest value - 1) characters of each
 * stream until more arrives or the stream ends: a value that is still
 * incomplete can start only there. The whole-text form runs the same steps,
 * so the live output and the stored output read the same.
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

export interface Redactor {
  /** Takes the next piece; returns the text that is safe to show now. */
  push: (text: string) => string;
  /** The rest, at the end of the stream. */
  end: () => string;
}

export function createRedactor(secrets: SecretText[]): Redactor {
  const list = prepare(secrets);
  const hold = list.length ? list[0].value.length - 1 : 0;
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
      const rest = pending.slice(at);
      if (
        !final &&
        list.some(
          (secret) =>
            secret.value.length > rest.length && secret.value.startsWith(rest),
        )
      ) {
        wait = at;
        break;
      }
      out += pending.slice(cursor, at) + marker(found.name);
      cursor = at + found.value.length;
    }
    const safe = final
      ? pending.length
      : Math.min(wait, Math.max(cursor, pending.length - hold));
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
