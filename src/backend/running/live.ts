/**
 * Runs that are running now: their output so far, kept in memory while the
 * command runs and written to the run row at most every FLUSH_MS, so a
 * person (or an agent) can read it as it grows and a Termix restart keeps
 * what had arrived.
 */

import type { RunRow } from "../runbooks/store/types.js";
import { now, type Store } from "../runbooks/store/store.js";
import type { StreamName } from "./stream-exec.js";
import { SYSTEM, type Events } from "../agents/events.js";
import type { Run, RunInput } from "../../shared/api.js";
import { noErrorParts } from "./run-error.js";

const FLUSH_MS = 2000;
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
  /**
   * Types into the command (1.4.6); null until the command started, and
   * for a run that got its standard input from `stdin`.
   */
  input: LiveInput | null;
  /** What was typed into it, by size only (1.4.6). */
  inputs: RunInput[];
  /** Settles when the run is finished and written. */
  done: Promise<void>;
  /**
   * 1.4.10: a sequence run. Its output streams into the item that runs
   * (itemId), and stdout and stderr above are that item's output.
   */
  sequence: boolean;
  /** The run item that runs now; null between items and for a plain run. */
  itemId: number | null;
  /** Skips the delay that runs now (1.4.10); null when none runs. */
  skipDelay: ((by: string) => Promise<void>) | null;
  /**
   * Starts the next attempt of the item that waits between two attempts
   * now (1.4.10, phase 2); null when none waits.
   */
  tryNow: ((by: string) => Promise<void>) | null;
}

/** A running command's standard input, as the input route uses it. */
export interface LiveInput {
  /** It takes input now: started, not ended, input not ended. */
  open: () => boolean;
  /**
   * Writes the text. A hidden text is hidden in the output first, so its
   * echo never shows. False when the command does not take input now.
   */
  send: (text: string, hidden: boolean) => boolean;
  /** Ends the command's input. False as for send. */
  end: () => boolean;
}

interface Entry extends LiveRun {
  dirty: boolean;
  lastFlushAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void>;
}

/**
 * A run as the views show it: running ones carry their live output. The
 * API's Run (src/shared/api.ts): a stored run, and what it printed so far.
 */
export type ShownRun = Run;

/** A run as stored, with nothing running live in this process for it. */
export function storedRun(run: RunRow): ShownRun {
  return {
    ...run,
    running: run.status === "running",
    lastOutputAt: null,
    elapsedMs: null,
    silentMs: null,
  };
}

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
    const output = {
      stdout: entry.stdout,
      stderr: entry.stderr,
      truncated: entry.truncated,
    };
    const inputs = entry.inputs.length ? { inputs: [...entry.inputs] } : {};
    // A sequence's output belongs to the item that printed it (1.4.10).
    const itemId = entry.sequence ? entry.itemId : null;
    entry.flushing = entry.flushing
      .then(async () => {
        if (itemId !== null) {
          await store.updateRunItem(itemId, output);
          if (entry.inputs.length) await store.updateRun(entry.runId, inputs);
        } else if (!entry.sequence) {
          await store.updateRun(entry.runId, { ...output, ...inputs });
        } else if (entry.inputs.length) {
          await store.updateRun(entry.runId, inputs);
        }
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
        input: null,
        inputs: [],
        done: Promise.resolve(),
        sequence: false,
        itemId: null,
        skipDelay: null,
        tryNow: null,
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

    /** A person typed into it, or ended its input: by size only. */
    typed(runId: number, input: RunInput): void {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.inputs.push(input);
      schedule(entry);
    },

    truncated(runId: number): void {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.truncated = true;
      schedule(entry);
    },

    get: (runId: number): LiveRun | undefined => runs.get(runId),

    /**
     * A sequence's next item starts (1.4.10): its output starts empty, and
     * Stop and typing act on it.
     */
    beginItem(runId: number, itemId: number): void {
      const entry = runs.get(runId);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.dirty = false;
      entry.itemId = itemId;
      entry.stdout = "";
      entry.stderr = "";
      entry.bytes = 0;
      entry.truncated = false;
      entry.lastOutputAt = null;
      entry.stop = null;
      entry.input = null;
      entry.skipDelay = null;
      entry.tryNow = null;
    },

    /** The item ended: nothing of it is live any more (1.4.10). */
    endItem(runId: number): void {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.itemId = null;
      entry.stop = null;
      entry.input = null;
      entry.skipDelay = null;
      entry.tryNow = null;
    },

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
        if (!entry) return storedRun(run);
        const started = Date.parse(entry.startedAt);
        const last = entry.lastOutputAt
          ? Date.parse(entry.lastOutputAt)
          : started;
        if (entry.sequence) {
          // 1.4.10: the run keeps its stored output; the item that runs
          // carries what it printed so far.
          return {
            ...run,
            items: run.items?.map((item) =>
              item.id === entry.itemId
                ? {
                    ...item,
                    stdout: entry.stdout,
                    stderr: entry.stderr,
                    truncated: entry.truncated,
                    lastOutputAt: entry.lastOutputAt,
                  }
                : item,
            ),
            inputs: [...entry.inputs],
            running: true,
            outputHeld: false,
            acceptsInput: entry.input?.open() ?? false,
            lastOutputAt: entry.lastOutputAt,
            elapsedMs: Math.max(0, at - started),
            silentMs: Math.max(0, at - last),
          };
        }
        return {
          ...run,
          stdout: entry.stdout,
          stderr: entry.stderr,
          truncated: entry.truncated,
          inputs: [...entry.inputs],
          running: true,
          outputHeld: entry.held,
          acceptsInput: entry.input?.open() ?? false,
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
  events: Events,
): Promise<number> {
  const left = await store.listRuns({ status: "running" });
  if (left.length === 0) return 0;
  const touched = new Set<number>();
  for (const run of left) {
    await store.updateRun(run.id, {
      status: "failed",
      finishedAt: now(),
      error: INTERRUPTED,
      errorParts: noErrorParts(INTERRUPTED),
    });
    // 1.4.10: a sequence's item that ran fails with it; items not reached
    // stay waiting, so Continue starts at the item that was cut off.
    for (const item of await store.listRunItems({ runId: run.id })) {
      if (item.status !== "running") continue;
      await store.updateRunItem(item.id, {
        status: "failed",
        finishedAt: now(),
        error: INTERRUPTED,
        nextAttemptAt: null,
      });
    }
    // Phase 2: a wait's attempt that ran fails as interrupted. The owner
    // (2026-11-23): the person continues from that item; it starts again
    // at attempt 1.
    for (const attempt of await store.listRunAttempts({
      runId: run.id,
      status: "running",
    })) {
      await store.updateRunAttempt(attempt.id, {
        status: "failed",
        finishedAt: now(),
        error: INTERRUPTED,
        why: "interrupted",
      });
    }
    const step = await store.getStep(run.stepId);
    if (step) {
      // Each runbook is touched once, after the sweep.
      await events.endStep(step, {
        status: "failed",
        reason: "interrupted",
        by: SYSTEM,
        at: now(),
        touch: false,
      });
      touched.add(step.runbookId);
    }
  }
  for (const runbookId of touched) await store.touchRunbook(runbookId);
  await store.persist();
  return left.length;
}
