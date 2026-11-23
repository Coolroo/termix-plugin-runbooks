import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  endAllCaptures,
  readerFor,
  startCapture,
} from "../../src/frontend/running/terminal-capture";
import {
  CAPTURE_POLL_MS,
  CAPTURE_SLOW_AFTER,
  CAPTURE_SLOW_MS,
  useCapturedOutput,
} from "../../src/frontend/running/use-captured-output";

const PROMPT = "wyatt@homepi:~$ ";

/** A terminal on tab `web`, its raw output, and how often it was read. */
function terminalTab() {
  const listeners = new Set<(data: string) => void>();
  const handle = {
    readBufferLines: () => [{ text: PROMPT, firstRow: 0, lastRow: 0 }],
    subscribeOutput: (listener: (data: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isAtPasswordPrompt: vi.fn(() => false),
  };
  const shell = {
    tabs: { list: [{ id: "web", terminalRef: { current: handle } }] },
  };
  startCapture({
    runId: 21,
    sessionId: "web",
    command: "journalctl -f",
    reader: () => readerFor(shell, "web"),
  });
  return {
    reads: () => handle.isAtPasswordPrompt.mock.calls.length,
    print: (data: string) => {
      for (const listener of [...listeners]) listener(data);
    },
  };
}

afterEach(() => {
  endAllCaptures();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("the paste box's reading (BUG-019, finding 6)", () => {
  it("reads less often while the text stays the same, and again each second once it changes", () => {
    vi.useFakeTimers();
    const tab = terminalTab();
    tab.print("journalctl -f\r\nline 1\r\n");
    const { result } = renderHook(() => useCapturedOutput(21, true));
    expect(result.current.text).toBe("line 1");
    for (let index = 0; index < CAPTURE_SLOW_AFTER; index++) {
      wait(CAPTURE_POLL_MS);
    }
    const slow = tab.reads();
    wait(CAPTURE_POLL_MS);
    expect(tab.reads()).toBe(slow);
    wait(CAPTURE_SLOW_MS - CAPTURE_POLL_MS);
    expect(tab.reads()).toBe(slow + 1);

    tab.print("line 2\r\n");
    wait(CAPTURE_SLOW_MS);
    expect(result.current.text).toBe("line 1\nline 2");
    const fast = tab.reads();
    wait(CAPTURE_POLL_MS);
    expect(tab.reads()).toBe(fast + 1);
  });

  it("stops once the prompt is back", () => {
    vi.useFakeTimers();
    const tab = terminalTab();
    const { result } = renderHook(() => useCapturedOutput(21, true));
    tab.print(`journalctl -f\r\ndone\r\n${PROMPT}`);
    wait(CAPTURE_POLL_MS);
    expect(result.current.read).toMatchObject({ text: "done", final: true });
    const reads = tab.reads();
    wait(CAPTURE_SLOW_MS * 3);
    expect(tab.reads()).toBe(reads);
  });

  it("Mark failed keeps the text only once the box was opened or changed", () => {
    vi.useFakeTimers();
    const tab = terminalTab();
    tab.print(`journalctl -f\r\nfailed\r\n${PROMPT}`);
    const { result } = renderHook(() => useCapturedOutput(21, true));
    expect(result.current.failed).toEqual({ text: "", source: "pasted" });
    act(() => result.current.open());
    expect(result.current.failed).toEqual({
      text: "failed",
      source: "captured",
    });
  });
});
