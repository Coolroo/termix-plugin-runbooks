/**
 * The Mark done paste box of a terminal run (1.4.9): filled with what the
 * command printed when this page sent it, and kept up with the terminal
 * until the person changes it. Read again puts the terminal's text back.
 * With no capture (no terminal handle, a reload, another device) it is the
 * empty paste box it was before.
 */

import { useCallback, useEffect, useState } from "react";
import type { OutputSource } from "../../shared/api";
import { hasCapture, readCapture, type CaptureRead } from "./terminal-capture";

/** How often the box reads the terminal while the person has not changed it. */
export const CAPTURE_POLL_MS = 1000;

export function useCapturedOutput(runId: number, active: boolean) {
  const [text, setText] = useState("");
  /** The terminal's text as last read; null without a capture. */
  const [read, setRead] = useState<CaptureRead | null>(null);
  const [edited, setEdited] = useState(false);

  const pull = useCallback(() => {
    const next = readCapture(runId);
    if (!next) return;
    setRead(next);
    setText(next.text);
  }, [runId]);

  useEffect(() => {
    if (!active || edited || !hasCapture(runId)) return;
    pull();
    const timer = setInterval(pull, CAPTURE_POLL_MS);
    return () => clearInterval(timer);
  }, [active, edited, runId, pull]);

  const change = (value: string) => {
    setText(value);
    if (read) setEdited(value !== read.text);
  };

  const readAgain = () => {
    setEdited(false);
    pull();
  };

  const source: OutputSource =
    !read || read.text === ""
      ? "pasted"
      : text === read.text
        ? "captured"
        : "captured-edited";

  return { text, change, read, edited, readAgain, source };
}
