import { describe, expect, it } from "vitest";
import { createLineModel } from "../../src/frontend/running/terminal-lines";

/** The model after `pieces`, each pushed on its own. */
function model(...pieces: string[]) {
  const lines = createLineModel();
  for (const piece of pieces) lines.push(piece);
  return lines;
}

describe("the raw output as lines (BUG-019)", () => {
  it("splits on line feeds and keeps the cursor's line apart", () => {
    const lines = model("one\r\ntwo\r\nwyatt@homepi:~$ ");
    expect(lines.complete).toEqual(["one", "two"]);
    expect(lines.current()).toBe("wyatt@homepi:~$");
    expect(lines.beforeCursor()).toBe("wyatt@homepi:~$ ");
    expect(lines.drawn()).toBe(false);
  });

  it("a CR goes back to the line's start: a progress bar shows its last state", () => {
    expect(model("10%\r 60%\r100%\r\n").complete).toEqual(["100%"]);
  });

  it("a backspace and the cursor codes move along the line", () => {
    expect(model("ab\bc\r\n").complete).toEqual(["ac"]);
    expect(model("abcd\u001b[2Dx\r\n").complete).toEqual(["abxd"]);
    expect(model("a\u001b[3Cb\r\n").complete).toEqual(["a   b"]);
    expect(model("abcdef\u001b[3G\u001b[K\r\n").complete).toEqual(["ab"]);
  });

  it("erases and deletes as readline does", () => {
    expect(model("abcdef\r\u001b[2C\u001b[2P\r\n").complete).toEqual(["abef"]);
    expect(model("abef\r\u001b[2C\u001b[2@cd\r\n").complete).toEqual([
      "abcdef",
    ]);
    expect(model("abcdef\r\u001b[1X\r\n").complete).toEqual([
      "bcdef".padStart(6),
    ]);
    expect(model("abcdef\u001b[2K\r\n").complete).toEqual([""]);
  });

  it("a prompt drawn again on its line, and a right-hand prompt", () => {
    const lines = model(
      "ls\r",
      "wyatt@homepi ~ % ls",
      "\r\nfile\r\nwyatt@homepi ~ % \u001b[20C10:42:05\r\u001b[17C",
    );
    expect(lines.complete).toEqual(["wyatt@homepi ~ % ls", "file"]);
    expect(lines.beforeCursor()).toBe("wyatt@homepi ~ % ");
    expect(lines.current()).toBe(`wyatt@homepi ~ % ${" ".repeat(20)}10:42:05`);
  });

  it("holds a code split across two pieces", () => {
    const lines = model("a\u001b[", "31mb\u001b", "[0m\r\n");
    expect(lines.complete).toEqual(["ab"]);
  });

  it("keeps no text of the alternate screen (less, vim)", () => {
    const lines = model(
      "before\r\n\u001b[?1049h\u001b[Hscreen text\r\nmore\u001b[?1049l",
      "after\r\n",
    );
    expect(lines.complete).toEqual(["before", "after"]);
  });

  it.each([
    ["cursor up", "\u001b[A"],
    ["an absolute place", "\u001b[5;1H"],
    ["a scroll region", "\u001b[1;23r"],
    ["a saved cursor", "\u001b7"],
  ])("notes %s: the screen knows better", (_name, code) => {
    expect(model(`a${code}b`).drawn()).toBe(true);
  });

  it("counts what it keeps", () => {
    expect(model("abc\r\nde").size()).toBe(6);
  });
});
