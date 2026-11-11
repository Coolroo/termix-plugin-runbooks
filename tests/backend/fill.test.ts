import { describe, expect, it } from "vitest";
import {
  escapeMarkdown,
  LINK_BREAK,
  fillMarkdown,
  fillPlain,
  uniqueNames,
} from "../../src/shared/fill";

const mark = (name: string) => `(value ${name}: not set yet)`;

describe("values in Markdown text (1.4.3)", () => {
  it("fills a value as text, and a plain address keeps its dots", () => {
    expect(
      fillMarkdown("Find {{ts_ip}} in the console.", { ts_ip: "100.64.0.7" }),
    ).toEqual({ text: "Find 100.64.0.7 in the console.", missing: [] });
    // An address after https:// still makes a link the author wrote.
    expect(
      fillMarkdown("Open https://{{ip}}:8443/", { ip: "10.0.0.1" }).text,
    ).toBe("Open https://10.0.0.1:8443/");
  });

  it("escapes links, images, headings, emphasis and HTML outside code", () => {
    const evil =
      "[x](https://e.example) ![i](a.png) *em* _u_ ~~s~~ <b>hi</b> &amp; `c`";
    const { text } = fillMarkdown("Got: {{v}}", { v: evil });
    expect(text).toBe(
      "Got: \\[x\\]\\(https:<!---->//e.example\\) \\!\\[i\\]\\(a.png\\) \\*em\\* \\_u\\_ \\~\\~s\\~\\~ \\<b\\>hi\\</b\\> \\&amp; \\`c\\`",
    );
    // At a line start: a heading, a list, a quote, a thematic break.
    expect(fillMarkdown("{{v}}", { v: "# Title" }).text).toBe("\\# Title");
    expect(fillMarkdown("{{v}}", { v: "- item" }).text).toBe("\\- item");
    expect(fillMarkdown("{{v}}", { v: "1. item" }).text).toBe("1\\. item");
    expect(fillMarkdown("{{v}}", { v: "> q" }).text).toBe("\\> q");
    expect(fillMarkdown("a\n{{v}}", { v: "===" }).text).toBe("a\n\\===");
    expect(fillMarkdown("{{v}}", { v: "---" }).text).toBe("\\---");
    // Autolink literals and e-mail addresses.
    // They read the text after escapes, so an empty comment splits it.
    expect(escapeMarkdown("see https://e.example and www.e.example")).toBe(
      `see https:${LINK_BREAK}//e.example and www${LINK_BREAK}.e.example`,
    );
    expect(escapeMarkdown("a@b.example")).toBe(`a${LINK_BREAK}\\@b.example`);
  });

  it("puts a value in the author's link destination, and in an autolink", () => {
    expect(
      fillMarkdown('[Open]({{url}} "{{t}}")', {
        url: "https://e.example/a b_(c)",
        t: 'say "hi"',
      }).text,
    ).toBe('[Open](https://e.example/a%20b\\_\\(c\\) "say%20\\"hi\\"")');
    expect(
      fillMarkdown("<https://{{host}}/x>", { host: "my_host a<b>" }).text,
    ).toBe("<https://my_host%20a%3Cb%3E/x>");
    // The link text is Markdown text, as anywhere.
    expect(fillMarkdown("[{{v}}](https://e.example)", { v: "*b*" }).text).toBe(
      "[\\*b\\*](https://e.example)",
    );
  });

  it("puts line breaks of a value outside code on one line", () => {
    expect(fillMarkdown("x {{v}}", { v: "one\n# two\r\nthree" }).text).toBe(
      "x one \\# two three",
    );
    // Leading spaces could start a code block; they go.
    expect(fillMarkdown("{{v}}", { v: "    code" }).text).toBe("code");
  });

  it("puts a value raw inside a code span and a fenced block", () => {
    const values = { v: "*a* [b](c) <i>" };
    expect(fillMarkdown("Run `x {{v}}`", values).text).toBe(
      "Run `x *a* [b](c) <i>`",
    );
    expect(
      fillMarkdown("```sh\necho {{v}}\n```\nthen {{v}}", values).text,
    ).toBe(
      "```sh\necho *a* [b](c) <i>\n```\nthen \\*a\\* \\[b\\]\\(c\\) \\<i\\>",
    );
    // An indented code block too.
    expect(fillMarkdown("Text\n\n    echo {{v}}\n", values).text).toBe(
      "Text\n\n    echo *a* [b](c) <i>\n",
    );
  });

  it("gives a code span with a backtick value a longer delimiter", () => {
    expect(fillMarkdown("`{{v}}`", { v: "a`b" }).text).toBe("``a`b``");
    expect(fillMarkdown("`{{v}}`", { v: "a``b`c" }).text).toBe("```a``b`c```");
    // A value at the span's edge gets a space, which the span drops.
    expect(fillMarkdown("`{{v}}`", { v: "`x`" }).text).toBe("`` `x` ``");
    expect(fillMarkdown("``{{v}}``", { v: "`x" }).text).toBe("`` `x ``");
    // Line breaks in a code span become spaces (a span shows them so).
    expect(fillMarkdown("`{{v}}`", { v: "a\n# b" }).text).toBe("`a # b`");
  });

  it("gives a fenced block a longer fence when a value line would end it", () => {
    expect(
      fillMarkdown("```\n{{v}}\n```\nafter", { v: "x\n```\ny" }).text,
    ).toBe("````\nx\n```\ny\n````\nafter");
    expect(fillMarkdown("~~~\n{{v}}\n~~~", { v: "~~~~~" }).text).toBe(
      "~~~~~~\n~~~~~\n~~~~~~",
    );
    // Backticks do not end a tilde fence.
    expect(fillMarkdown("~~~\n{{v}}\n~~~", { v: "```" }).text).toBe(
      "~~~\n```\n~~~",
    );
  });

  it("keeps a multi-line value inside its container", () => {
    expect(fillMarkdown("> ```\n> {{v}}\n> ```", { v: "a\nb" }).text).toBe(
      "> ```\n> a\n> b\n> ```",
    );
    expect(
      fillMarkdown("- item\n\n  ```\n  {{v}}\n  ```", { v: "a\nb" }).text,
    ).toBe("- item\n\n  ```\n  a\n  b\n  ```");
    expect(fillMarkdown("Text\n\n    {{v}}", { v: "a\nb" }).text).toBe(
      "Text\n\n    a\n    b",
    );
  });

  it("escapes a pipe in a table cell's code span", () => {
    expect(
      fillMarkdown("| a |\n|---|\n| `{{v}}` {{v}} |", { v: "x|y" }).text,
    ).toBe("| a |\n|---|\n| `x\\|y` x\\|y |");
  });

  it("keeps a value that is not set as written, or shows a marker", () => {
    const text = "Find {{ts_ip}} and `{{ts_ip}}`, then {{other}}.";
    expect(fillMarkdown(text, {})).toEqual({
      text,
      missing: ["ts_ip", "other"],
    });
    expect(fillMarkdown(text, { other: "o" }, mark).text).toBe(
      "Find \\(value ts\\_ip: not set yet\\) and `(value ts_ip: not set yet)`, then o.",
    );
  });

  it("fills a value once: a value with {{name}} in it is not filled again", () => {
    expect(fillMarkdown("`{{a}}` {{a}}", { a: "{{b}}", b: "no" }).text).toBe(
      "`{{b}}` \\{\\{b\\}\\}",
    );
  });

  it("leaves text with no placeholders as it is", () => {
    const text = "**bold** `code` [link](https://e.example)";
    expect(fillMarkdown(text, { a: "1" })).toEqual({ text, missing: [] });
    expect(fillMarkdown("", {})).toEqual({ text: "", missing: [] });
  });

  it("fills plain text (where) raw", () => {
    expect(
      fillPlain("Browser on {{host}} *admin*", { host: "[a](b) <c>" }),
    ).toEqual({ text: "Browser on [a](b) <c> *admin*", missing: [] });
    expect(fillPlain("on {{h}}", {}, mark)).toEqual({
      text: "on (value h: not set yet)",
      missing: ["h"],
    });
    expect(uniqueNames(["a", "b"], ["b", "c"], [])).toEqual(["a", "b", "c"]);
  });
});
