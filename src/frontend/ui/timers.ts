/**
 * Clocks of the page: a re-render every second, and the moment a value
 * came from the server, so counts it sent move on with this clock.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { StepWait } from "../api-types";

/** Re-renders every `ms` while mounted and `active`. */
export function useTick(active = true, ms = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
}

/**
 * When `value` arrived: Date.now() at the first render that saw it. The
 * server's counts were true then; time moves on from there on this
 * clock, so a clock that is off does not matter.
 */
export function useFetchedAt(value: unknown): number {
  return useMemo(() => Date.now(), [value]);
}

/**
 * Milliseconds left of a step's wait, counted down on this clock from what
 * the server said when the step was fetched. Ticks every second while the
 * wait runs.
 */
export function useWaitRemaining(wait: StepWait | null | undefined): number {
  const fetchedAt = useFetchedAt(wait);
  useTick(Boolean(wait && wait.remainingMs > 0));
  return wait ? Math.max(0, wait.remainingMs - (Date.now() - fetchedAt)) : 0;
}

/**
 * Calls `load` now and every `intervalMs` while `active`. A tick is left out
 * while `skip()` answers true (the page is busy with an action of its own).
 */
export function usePolling(
  load: () => unknown,
  {
    active,
    intervalMs,
    skip,
  }: { active: boolean; intervalMs: number; skip?: () => boolean },
): void {
  const skipRef = useRef(skip);
  skipRef.current = skip;
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => {
      if (!skipRef.current?.()) void load();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, load, intervalMs]);
}
