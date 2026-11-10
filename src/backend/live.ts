/**
 * Runs that are running now: their output so far, kept in memory while the
 * command runs and written to the run row at most every FLUSH_MS, so a
 * person (or an agent) can read it as it grows and a Termix restart keeps
 * what had arrived.
 */

import type { RunRow, Store } from "./store.js";
import { now } from "./store.js";
import type { StreamName } from "./stream-exec.js";
import { SYSTEM, type Events } from "./events.js";

export const FLUSH_MS = 2000;
export const INTERRUPTED = "interrupted: Termix restarted while it ran";
export const PLUGIN_STOPPED = "interrupted: Runbooks was stopped while it ran";

export interface LiveRun {
  runId: number;
  stepId: number;
  runbookId: number;
  stdout: string;
  stderr: string;
  /** Bytes of output received and kept, both streams. */
  bytes: number;
  truncated: boolean;
  startedAt: string;
  lastOutputAt: string | null;
  /** The person who pressed Stop, once someone did. */
  stoppedBy: string | null;
  /** Why the run ended early without a person, such as the plugin stopping. */
  interrupted: string | null;
  /**
   * The output is held until the run ends: the step captures a secret,
   * whose value is not known before the output is complete (1.2.0).
   */
  held: boolean;
  /** Ends the command; null until the command started. */
  stop: (() => void) | null;
  /** Settles when the run is finished and written. */
  done: Promise<void>;
}

interface Entry extends LiveRun {
  dirty: boolean;
  lastFlushAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void>;
}

/** A run as the views show it: running ones carry their live output. */
export type ShownRun = RunRow & {
  running: boolean;
  lastOutputAt: string | null;
  /** Milliseconds since the run started, as the server saw it. */
  elapsedMs: number | null;
  /** Milliseconds since the last output (or the start), as the server saw it. */
  silentMs: number | null;
  /** Output is not shown until the run ends: the step captures a secret. */
  outputHeld?: boolean;
};

export type LiveRuns = ReturnType<typeof createLiveRuns>;

export function createLiveRuns(store: Store, flushMs = FLUSH_MS) {
  const runs = new Map<number, Entry>();

  function flush(entry: Entry): Promise<void> {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty) return entry.flushing;
    entry.dirty = false;
    entry.lastFlushAt = Date.now();
    const patch = {
      stdout: entry.stdout,
      stderr: entry.stderr,
      truncated: entry.truncated,
    };
    entry.flushing = entry.flushing
      .then(async () => {
        await store.updateRun(entry.runId, patch);
        await store.persist(true);
      })
      .catch(() => {
        // The final write at the end of the run carries everything anyway.
      });
    return entry.flushing;
  }

  function schedule(entry: Entry): void {
    entry.dirty = true;
    if (entry.timer) return;
    const wait = Math.max(0, entry.lastFlushAt + flushMs - Date.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flush(entry);
    }, wait);
  }

  return {
    start(run: {
      runId: number;
      stepId: number;
      runbookId: number;
      startedAt: string;
    }): LiveRun {
      const entry: Entry = {
        ...run,
        stdout: "",
        stderr: "",
        bytes: 0,
        truncated: false,
        lastOutputAt: null,
        stoppedBy: null,
        interrupted: null,
        held: false,
        stop: null,
        done: Promise.resolve(),
        dirty: false,
        lastFlushAt: Date.now(),
        timer: null,
        flushing: Promise.resolve(),
      };
      runs.set(run.runId, entry);
      return entry;
    },

    output(runId: number, stream: StreamName, text: string): void {
      const entry = runs.get(runId);
      if (!entry || !text) return;
      entry[stream] += text;
      entry.bytes += Buffer.byteLength(text);
      entry.lastOutputAt = now();
      schedule(entry);
    },

    /** Output arrived but is held back: only the time is kept. */
    heard(runId: number): void {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.lastOutputAt = now();
    },

    truncated(runId: number): void {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.truncated = true;
      schedule(entry);
    },

    get: (runId: number): LiveRun | undefined => runs.get(runId),

    byStep(stepId: number): LiveRun | undefined {
      for (const entry of runs.values()) {
        if (entry.stepId === stepId) return entry;
      }
      return undefined;
    },

    all: (): LiveRun[] => [...runs.values()],

    /**
     * Stops the timer and waits for any write in progress, so the final
     * write of the run is the last one.
     */
    async settle(runId: number): Promise<void> {
      const entry = runs.get(runId);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.dirty = false;
      await entry.flushing;
    },

    /** Writes the output so far now (tests, and before a shutdown). */
    flushNow(runId: number): Promise<void> {
      const entry = runs.get(runId);
      if (!entry) return Promise.resolve();
      entry.dirty = true;
      return flush(entry);
    },

    remove(runId: number): void {
      const entry = runs.get(runId);
      if (entry?.timer) clearTimeout(entry.timer);
      runs.delete(runId);
    },

    /** The views' form of runs: live output in place of the stored part. */
    show(list: RunRow[]): ShownRun[] {
      const at = Date.now();
      return list.map((run) => {
        const entry = run.status === "running" ? runs.get(run.id) : undefined;
        if (!entry) {
          return {
            ...run,
            running: run.status === "running",
            lastOutputAt: null,
            elapsedMs: null,
            silentMs: null,
          };
        }
        const started = Date.parse(entry.startedAt);
        const last = entry.lastOutputAt
          ? Date.parse(entry.lastOutputAt)
          : started;
        return {
          ...run,
          stdout: entry.stdout,
          stderr: entry.stderr,
          truncated: entry.truncated,
          running: true,
          outputHeld: entry.held,
          lastOutputAt: entry.lastOutputAt,
          elapsedMs: Math.max(0, at - started),
          silentMs: Math.max(0, at - last),
        };
      });
    },
  };
}

/**
 * Runs left in `running` by a Termix that stopped: nothing will finish them,
 * so they fail, keeping the output that was written, and so do their steps
 * (a step-failed event each, reason "interrupted").
 */
export async function sweepInterrupted(
  store: Store,
  events?: Events,
): Promise<number> {
  const left = await store.listRuns({ status: "running" });
  if (left.length === 0) return 0;
  const touched = new Set<number>();
  for (const run of left) {
    await store.updateRun(run.id, {
      status: "failed",
      finishedAt: now(),
      error: INTERRUPTED,
    });
    const step = await store.getStep(run.stepId);
    if (step) {
      const fail = async () => {
        await store.updateStep(step.id, {
          status: "failed",
          skipReason: null,
          endedAt: now(),
        });
        await events?.stepEnded(step, "failed", "interrupted", SYSTEM);
      };
      if (events) await events.around(step.runbookId, SYSTEM, fail);
      else await fail();
      touched.add(step.runbookId);
    }
  }
  for (const runbookId of touched) await store.touchRunbook(runbookId);
  await store.persist();
  return left.length;
}
