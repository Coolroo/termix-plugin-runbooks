import { describe, expect, it } from "vitest";
import {
  createCommandStream,
  isEcho,
} from "../../src/frontend/running/terminal-lines";

const HEAD = "wyatt@homepi:~$";

/** The stream after the command's echo and Enter, then `pieces`. */
function output(...pieces: string[]) {
  const stream = createCommandStream("do-it", {
    promptHead: HEAD,
    isPrompt: (line) => line.startsWith(HEAD),
  });
  stream.push("do-it\r\n");
  expect(stream.state()).toBe("output");
  for (const piece of pieces) stream.push(piece);
  return stream;
}

describe("the command's echo (BUG-021)", () => {
  it("starts the output once the line with the command ends", () => {
    const stream = createCommandStream("ls -l", { promptHead: HEAD });
    stream.push("ls -l");
    expect(stream.state()).toBe("echo");
    stream.push("\r\nfile\r\n");
    expect(stream.state()).toBe("output");
    expect(stream.complete).toEqual(["file"]);
  });

  it("is lost when the line ends with another command", () => {
    const stream = createCommandStream("ls -l", { promptHead: HEAD });
    stream.push("ls -la\r\nfile\r\n");
    expect(stream.state()).toBe("echo");
    stream.push("more\r\nlines\r\n");
    expect(stream.state()).toBe("lost");
    expect(stream.complete).toEqual([]);
  });

  it("follows bash's redraw on Enter: up, then the prompt's end and the command", () => {
    const stream = createCommandStream("echo one\necho two", {
      promptHead: HEAD,
      bracketed: true,
    });
    stream.push("\u001b[7mecho one\u001b[27m\r\n\r\u001b[7mecho two\u001b[27m");
    stream.push("\u001b[Amepi:~$ echo one\r\n\recho two\r\n");
    expect(stream.state()).toBe("echo");
    stream.push("\u001b[?2004l\rone\r\ntwo\r\n");
    expect(stream.state()).toBe("output");
    expect(stream.complete).toEqual(["one", "two"]);
  });

  it("in bracketed paste mode, waits for the shell's end of line editing", () => {
    const stream = createCommandStream("echo one", {
      promptHead: HEAD,
      bracketed: true,
    });
    // A paste of two lines shows its first line, then a line end.
    stream.push("echo one\r\n\recho two");
    expect(stream.state()).toBe("echo");
    stream.push("\r\n\u001b[?2004l\rone\r\n");
    expect(stream.state()).toBe("lost");
  });

  it("is lost when the shell prompts again first (Ctrl-C)", () => {
    const stream = createCommandStream("ls", {
      promptHead: HEAD,
      bracketed: true,
    });
    stream.push("ls^C\r\n\u001b[?2004l\r");
    expect(stream.state()).toBe("lost");
  });

  it("knows the echo from other rows", () => {
    expect(isEcho(["ls"], ["ls"], HEAD)).toBe(true);
    expect(isEcho(["wyatt@homepi:~$ ls"], ["ls"], HEAD)).toBe(true);
    expect(isEcho(["mepi:~$ ls"], ["ls"], HEAD)).toBe(true);
    // bash's "> " before each next line, when it runs them one by one.
    expect(
      isEcho(
        ["for a in b; do", ">   echo $a", "> done"],
        ["for a in b; do", "  echo $a", "done"],
        HEAD,
      ),
    ).toBe(true);
    expect(isEcho(["xls"], ["ls"], HEAD)).toBe(false);
    expect(isEcho(["s"], ["ls"], HEAD)).toBe(false);
    expect(isEcho(["$ls"], ["ls"], HEAD)).toBe(false);
    expect(isEcho(["root@homepi:~# ls"], ["ls"], HEAD)).toBe(false);
    expect(isEcho(["ls", "pwd"], ["ls"], HEAD)).toBe(false);
  });
});

describe("the output as lines", () => {
  it("splits on line feeds and keeps the cursor's line apart", () => {
    const stream = output("one\r\ntwo\r\nthr");
    expect(stream.complete).toEqual(["one", "two"]);
    expect(stream.current()).toBe("thr");
  });

  it("a CR goes back to the line's start: a progress bar shows its last state", () => {
    expect(output("10%\r 60%\r100%\r\n").complete).toEqual(["100%"]);
  });

  it("a backspace and the cursor codes move along the line", () => {
    expect(output("ab\bc\r\n").complete).toEqual(["ac"]);
    expect(output("abcd\u001b[2Dx\r\n").complete).toEqual(["abxd"]);
    expect(output("a\u001b[3Cb\r\n").complete).toEqual(["a   b"]);
    expect(output("abcdef\u001b[3G\u001b[K\r\n").complete).toEqual(["ab"]);
  });

  it("erases and deletes as readline does", () => {
    expect(output("abcdef\r\u001b[2C\u001b[2P\r\n").complete).toEqual(["abef"]);
    expect(output("abef\r\u001b[2C\u001b[2@cd\r\n").complete).toEqual([
      "abcdef",
    ]);
    expect(output("abcdef\r\u001b[1X\r\n").complete).toEqual([
      "bcdef".padStart(6),
    ]);
    expect(output("abcdef\u001b[2K\r\n").complete).toEqual([""]);
  });

  it("holds a code split across two pieces", () => {
    const stream = output("a\u001b[", "31mb\u001b", "[0m\r\n");
    expect(stream.complete).toEqual(["ab"]);
  });

  it("keeps no text of the alternate screen (less, vim)", () => {
    const stream = output(
      "before\r\n\u001b[?1049h\u001b[Hscreen text\r\nmore\u001b[?1049l",
      "after\r\n",
    );
    expect(stream.complete).toEqual(["before", "after"]);
    expect(stream.state()).toBe("output");
  });

  it("ends where the shell turns line editing on for its prompt", () => {
    const stream = output("no newline\u001b[?2004hwyatt@homepi:/etc$ ls\r\n");
    expect(stream.state()).toBe("ended");
    expect(stream.complete).toEqual(["no newline"]);
    expect(stream.current()).toBe("");
    expect(stream.drawn()).toBe(false);
  });

  it.each([
    ["cursor up", "\u001b[A"],
    ["an absolute place", "\u001b[5;1H"],
    ["a scroll region", "\u001b[1;23r"],
    ["a saved cursor", "\u001b7"],
  ])("ends at %s, keeping what came before", (_name, code) => {
    const stream = output(`a\r\nb${code}c\r\n`);
    expect(stream.state()).toBe("ended");
    expect(stream.drawn()).toBe(true);
    expect(stream.complete).toEqual(["a"]);
    expect(stream.current()).toBe("b");
  });

  it("ends at the noted prompt: on the cursor's line, or a line that ends", () => {
    const stream = output("a\r\nwyatt@homepi:~$ ");
    expect(stream.state()).toBe("ended");
    expect(stream.complete).toEqual(["a"]);
    expect(stream.current()).toBe("");
    const ahead = output("a\r\nwyatt@homepi:~$ ls\r\nfile\r\n");
    expect(ahead.state()).toBe("ended");
    expect(ahead.complete).toEqual(["a"]);
    // A line like it further in: not the prompt at its start.
    expect(output("say wyatt@homepi:~$\r\nb").state()).toBe("output");
  });

  it("counts what it keeps", () => {
    expect(output("abc\r\nde").size()).toBe(6);
  });
});
