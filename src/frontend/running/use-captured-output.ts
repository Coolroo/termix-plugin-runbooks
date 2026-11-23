/**
 * The Mark done paste box of a terminal run (1.4.9): filled with what the
 * command printed when this page sent it, and kept up with the terminal
 * until the person changes it or the reading stops. Read again puts the
 * terminal's text back. With no capture (no terminal handle, a reload,
 * another device) it is the empty paste box it was before.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OutputSource } from "../../shared/api";
import { hasCapture, readCapture, type CaptureRead } from "./terminal-capture";

/** How often the box reads the terminal while the person has not changed it. */
export const CAPTURE_POLL_MS = 1000;
/** After this many reads with the same text, it reads less often... */
export const CAPTURE_SLOW_AFTER = 5;
/** ...this often. */
export const CAPTURE_SLOW_MS = 5000;

export function useCapturedOutput(runId: number, active: boolean) {
  const [text, setText] = useState("");
  /** The terminal's text as last read; null without a capture. */
  const [read, setRead] = useState<CaptureRead | null>(null);
  const [edited, setEdited] = useState(false);
  /**
   * The person opened the box, changed it or read again: Mark failed then
   * keeps its text (BUG-019, owner 2026-11-23). Text they never looked at
   * is not saved with a failure.
   */
  const [touched, setTouched] = useState(false);
  /** Reads in a row that gave the same text. */
  const same = useRef(0);
  const lastText = useRef<string | null>(null);

  const pull = useCallback(() => {
    const next = readCapture(runId);
    if (!next) return null;
    same.current = next.text === lastText.current ? same.current + 1 : 0;
    lastText.current = next.text;
    setRead(next);
    setText(next.text);
    return next;
  }, [runId]);

  useEffect(() => {
    if (!active || edited || !hasCapture(runId)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const next = pull();
      // The reading stopped (prompt back, tab closed) or the capture ended.
      if (next?.final || !hasCapture(runId)) return;
      timer = setTimeout(
        tick,
        same.current >= CAPTURE_SLOW_AFTER ? CAPTURE_SLOW_MS : CAPTURE_POLL_MS,
      );
    };
    tick();
    return () => clearTimeout(timer);
  }, [active, edited, runId, pull]);

  const change = (value: string) => {
    setText(value);
    setTouched(true);
    if (read) setEdited(value !== read.text);
  };

  /** The person opened the box (focus): they see what Mark failed keeps. */
  const open = () => setTouched(true);

  const readAgain = () => {
    setTouched(true);
    setEdited(false);
    same.current = 0;
    pull();
  };

  const source: OutputSource =
    !read || read.text === ""
      ? "pasted"
      : text === read.text
        ? "captured"
        : "captured-edited";

  /** What Mark failed sends: the read text only once the person saw it. */
  const failed: { text: string; source: OutputSource } =
    !read || touched ? { text, source } : { text: "", source: "pasted" };

  return { text, change, open, read, edited, readAgain, source, failed };
}
