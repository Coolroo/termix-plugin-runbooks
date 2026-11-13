/**
 * Values in a step's text (1.4.3): `{{name}}` in `body`, `expect` and
 * `where`, filled with the same values as the command. Shared by the server
 * (resolvedBody, resolvedExpect, resolvedWhere) and the UI (the same text,
 * with a marker where a value is not set yet).
 *
 * `body` and `expect` are Markdown, and a value can be command output, so a
 * value never adds Markdown of its own:
 *
 * - Outside code, every character Markdown reads (`\ ` * _ ~ [ ] ( ) < > !
 *   # | & { } @ " '`, and a list mark or heading underline at the start) is
 *   escaped with a backslash, line breaks become spaces, and leading spaces
 *   go. A bare address (`://`, `www.`, `@`) gets an empty HTML comment in it,
 *   which the page drops, so GFM does not make it a link. The value shows as
 *   the same characters, as text: no link, image, heading, emphasis or HTML.
 * - In a link's destination (`[text]({{url}})`), the value is escaped and
 *   its spaces are percent-encoded, so the author's link goes there. In an
 *   autolink (`<https://{{host}}/>`), where Markdown reads no escapes, it goes in as
 *   it is, with spaces, `<` and `>` percent-encoded.
 * - Inside a code span or a code block, Markdown is not read, so the value
 *   goes in as it is. A value with backticks gets a longer code span; a value
 *   with a line that would end a fenced block gets a longer fence. In a code
 *   span, line breaks become spaces (a code span shows them as spaces), and
 *   in a code block each new line keeps the block's indent.
 *
 * `where` is plain text: values go in as they are.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { PLACEHOLDER } from "./names.js";

export type TextValues = Record<string, string>;

export interface FilledText {
  /** The text with every known {{name}} replaced. */
  text: string;
  /** Names the text uses that have no value, in order of first use. */
  missing: string[];
}

/**
 * What goes where a value is not set: text (the UI's marker, put in like a
 * value), or nothing to keep `{{name}}` as written (the server, as
 * resolvedCommand does).
 */
export type MissingMark = ((name: string) => string) | null;

function has(values: TextValues, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, name);
}

/** Markdown's own characters, escaped with a backslash. */
function backslashes(value: string): string {
  return value.replace(/[\\`*_~[\]()<>!#|&{}@"']/g, "\\$&");
}

/**
 * An empty HTML comment: the page drops HTML, so it shows nothing, but it
 * splits the text, so GFM's autolink literals (which read the text after
 * escapes) find no bare address in a value.
 */
export const LINK_BREAK = "<!---->";

/** Escapes a value for Markdown text outside code. */
export function escapeMarkdown(value: string): string {
  let out = backslashes(
    value.replace(/\r\n|\r|\n/g, " ").replace(/^[ \t]+/, ""),
  );
  // A list item, a heading underline or a thematic break at a line start.
  if (/^[-+](?=[ \t]|$)/.test(out) || /^(=+|-+)[ \t]*$/.test(out)) {
    out = `\\${out}`;
  }
  out = out.replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2");
  // After digits the author wrote ("1{{x}}"), a value ". x" is a list too.
  out = out.replace(/^([.)])/, "\\$1");
  // Bare addresses: a protocol's "://", a "www." domain, an e-mail "@".
  out = out
    .replace(/:\/\//g, `:${LINK_BREAK}//`)
    .replace(/(www)\./gi, `$1${LINK_BREAK}.`)
    .replace(/\\@/g, `${LINK_BREAK}\\@`);
  return out;
}

/** Spaces and line breaks in a URL, percent-encoded. */
function encodeSpaces(value: string, extra = ""): string {
  return value.replace(new RegExp(`[\\s${extra}]`, "g"), (char) =>
    encodeURIComponent(char),
  );
}

/** A value in a link's destination or title: escaped, spaces encoded. */
function escapeDestination(value: string): string {
  return encodeSpaces(backslashes(value));
}

/** A value in an autolink, where Markdown reads no escapes. */
function escapeAutolink(value: string): string {
  return encodeSpaces(value, "<>");
}

/** A value in a fenced block's info string: escaped, on one line. */
function escapeInfo(value: string): string {
  return backslashes(value.replace(/\r\n|\r|\n/g, " "));
}

interface Region {
  start: number;
  end: number;
  kind: "inline" | "fenced" | "indented" | "destination" | "autolink";
  /** Inline code in a GFM table cell: a pipe needs a backslash there. */
  inTable: boolean;
  /** The block's column (1-based): what comes before it is its container. */
  column: number;
}

interface Node {
  type: string;
  children?: Node[];
  position?: {
    start: { offset?: number; column: number };
    end: { offset?: number };
  };
}

/**
 * The parts of a Markdown text where a value needs other rules than text:
 * code spans and code blocks, link destinations and autolinks, in order.
 */
function codeRegions(text: string): Region[] {
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as Node;
  const regions: Region[] = [];
  const walk = (node: Node, inTable: boolean) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (node.type === "code" || node.type === "inlineCode") &&
      start !== undefined &&
      end !== undefined
    ) {
      const fenced =
        node.type === "code" &&
        (text.startsWith("```", start) || text.startsWith("~~~", start));
      regions.push({
        start,
        end,
        kind:
          node.type === "inlineCode"
            ? "inline"
            : fenced
              ? "fenced"
              : "indented",
        inTable,
        column: node.position!.start.column,
      });
      return;
    }
    if (
      (node.type === "link" ||
        node.type === "image" ||
        node.type === "definition") &&
      start !== undefined &&
      end !== undefined
    ) {
      const region = (from: number, kind: Region["kind"]) =>
        regions.push({
          start: from,
          end,
          kind,
          inTable,
          column: node.position!.start.column,
        });
      if (text.startsWith("<", start)) {
        region(start, "autolink");
        return;
      }
      if (node.type !== "link") {
        region(start, "destination");
        return;
      }
      // A link: its text is Markdown; what follows it is its destination.
      const last = node.children?.[node.children.length - 1];
      const after = last?.position?.end.offset ?? start + 1;
      // A GFM bare address is a link with no destination of its own.
      if (after < end) region(after, "destination");
    }
    for (const child of node.children ?? []) {
      walk(child, inTable || node.type === "tableCell");
    }
  };
  walk(tree, false);
  return regions.sort((a, b) => a.start - b.start);
}

/** The lengths of every run of `char` in a text. */
function runs(text: string, char: string): number[] {
  const found = text.match(new RegExp(`\\${char}+`, "g")) ?? [];
  return found.map((run) => run.length);
}

class Filler {
  readonly missing: string[] = [];
  private readonly values: TextValues;
  private readonly mark: MissingMark;
  constructor(values: TextValues, mark: MissingMark) {
    this.values = values;
    this.mark = mark;
  }

  /** A placeholder's text, or null to keep it as written. */
  value(name: string): string | null {
    if (has(this.values, name)) return this.values[name];
    if (!this.missing.includes(name)) this.missing.push(name);
    return this.mark ? this.mark(name) : null;
  }

  replace(text: string, put: (value: string) => string): string {
    return text.replace(PLACEHOLDER, (whole, name: string) => {
      const value = this.value(name);
      return value === null ? whole : put(value);
    });
  }
}

/** A code span, filled raw, with a longer delimiter when it needs one. */
function fillInline(source: string, region: Region, fill: Filler): string {
  const tick = /^`+/.exec(source)![0].length;
  const inner = source.slice(tick, source.length - tick);
  const content = fill.replace(inner, (value) => {
    let raw = value.replace(/\r\n|\r|\n/g, " ");
    if (region.inTable) raw = raw.replace(/\|/g, "\\|");
    return raw;
  });
  if (content === inner) return source;
  const lengths = runs(content, "`");
  const clash = lengths.includes(tick);
  const edge = content.startsWith("`") || content.endsWith("`");
  if (!clash && !edge) return "`".repeat(tick) + content + "`".repeat(tick);
  const length = clash ? Math.max(...lengths) + 1 : tick;
  const pad = edge ? " " : "";
  const fence = "`".repeat(length);
  return `${fence}${pad}${content}${pad}${fence}`;
}

/** A code block, filled raw; a fenced one gets a longer fence if needed. */
function fillBlock(
  text: string,
  source: string,
  region: Region,
  fill: Filler,
): string {
  const lines = source.split("\n");
  const prefixLength = region.column - 1;
  const lineStart = text.lastIndexOf("\n", region.start - 1) + 1;
  // What the block's lines start with: its container (a quote, a list
  // item's indent), and for an indented block its four spaces.
  const container = (index: number) =>
    index === 0
      ? text.slice(lineStart, region.start).replace(/[^\s>]/g, " ")
      : lines[index].slice(0, prefixLength);
  const indent = region.kind === "indented" ? "    " : "";

  if (region.kind === "indented") {
    return lines
      .map((line, index) => {
        const lead = container(index) + indent;
        return fill.replace(line, (value) =>
          value.replace(/\r\n|\r|\n/g, `\n${lead}`),
        );
      })
      .join("\n");
  }

  const open = /^(`{3,}|~{3,})/.exec(lines[0])![0];
  const char = open[0];
  const closing = new RegExp(`^ {0,3}\\${char}{3,}[ \\t]*\\r?$`);
  const hasClose =
    lines.length > 1 &&
    closing.test(lines[lines.length - 1].slice(prefixLength)) &&
    lines[lines.length - 1].slice(prefixLength).trim().length >= open.length;
  const last = hasClose ? lines.length - 1 : lines.length;
  // The info string is Markdown text: escaped, as outside code.
  const first = fill.replace(lines[0], escapeInfo);
  const body: string[] = [];
  for (let index = 1; index < last; index += 1) {
    const lead = container(index);
    const line = lines[index];
    body.push(
      lead +
        fill.replace(line.slice(prefixLength), (value) =>
          value.replace(/\r\n|\r|\n/g, `\n${lead}`),
        ),
    );
  }
  // A content line that is a fence of the same character, at least as long,
  // would end the block early: make the fence longer than any run in it.
  const content = body.join("\n");
  const ends = content.split("\n").some((line) => {
    const rest = line.slice(prefixLength);
    return closing.test(rest) && rest.trim().length >= open.length;
  });
  let opening = first;
  let close = hasClose ? lines[lines.length - 1] : null;
  if (ends) {
    const longer = char.repeat(
      Math.max(open.length, ...runs(content, char)) + 1,
    );
    opening = longer + first.slice(open.length);
    if (close !== null) {
      close = close.replace(new RegExp(`\\${char}{3,}`), longer);
    }
  }
  return [opening, ...body, ...(close !== null ? [close] : [])].join("\n");
}

/**
 * Fills {{name}} in Markdown (`body`, `expect`): escaped outside code, raw
 * inside it. With `mark`, a value that is not set shows as that text.
 */
export function fillMarkdown(
  text: string,
  values: TextValues,
  mark: MissingMark = null,
): FilledText {
  if (!text || text.search(PLACEHOLDER) === -1) {
    return { text: text ?? "", missing: [] };
  }
  const fill = new Filler(values, mark);
  let out = "";
  let at = 0;
  for (const region of codeRegions(text)) {
    out += fill.replace(text.slice(at, region.start), escapeMarkdown);
    const source = text.slice(region.start, region.end);
    out +=
      region.kind === "inline"
        ? fillInline(source, region, fill)
        : region.kind === "destination"
          ? fill.replace(source, escapeDestination)
          : region.kind === "autolink"
            ? fill.replace(source, escapeAutolink)
            : fillBlock(text, source, region, fill);
    at = region.end;
  }
  out += fill.replace(text.slice(at), escapeMarkdown);
  return { text: out, missing: fill.missing };
}

/** Fills {{name}} in plain text (`where`): values go in as they are. */
export function fillPlain(
  text: string,
  values: TextValues,
  mark: MissingMark = null,
): FilledText {
  const fill = new Filler(values, mark);
  return {
    text: fill.replace(text ?? "", (value) => value),
    missing: fill.missing,
  };
}

/** The distinct names in a list of lists, in order of first use. */
export function uniqueNames(...lists: Array<readonly string[]>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const name of list) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** A step's text with its values filled in. */
export interface StepText {
  /** `body`: escaped outside code, raw inside it. */
  body: string;
  /** `expect`, as `body`. */
  expect: string;
  /** `where`, plain text, values as they are; null when it has none. */
  where: string | null;
  /** Names body, expect and where use that have no value. */
  missing: string[];
}

/**
 * Fills a step's body, expect and where with the values its command gets.
 * The server sends the result as resolvedBody, resolvedExpect,
 * resolvedWhere and textMissing, with no mark (a value not set stays
 * `{{name}}`); the page fills the same text with a marker for it.
 */
export function fillStepText(
  step: { body: string; expect: string; where?: string | null },
  values: TextValues,
  mark: MissingMark = null,
): StepText {
  const body = fillMarkdown(step.body, values, mark);
  const expect = fillMarkdown(step.expect, values, mark);
  const where =
    step.where === null || step.where === undefined
      ? null
      : fillPlain(step.where, values, mark);
  return {
    body: body.text,
    expect: expect.text,
    where: where ? where.text : null,
    missing: uniqueNames(body.missing, expect.missing, where?.missing ?? []),
  };
}
