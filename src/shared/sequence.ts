/**
 * Step sequences (1.4.10, phase 1 of the sequences plan): a run step may be
 * a list of items that one Run press runs in order. A `run` item runs a
 * command on the step's host, a `delay` item waits a fixed time in the
 * plugin, with nothing on the host. A step with `command` is still one
 * command, exactly as before; it is never stored as a sequence.
 *
 * Each item of a run has its own record (RunItem): its command, output,
 * exit code, check results, captures, start and end. A later phase adds
 * wait attempts inside an item; the item keeps its id for them.
 *
 * Shared by the server and the UI. No React and no Node here.
 */

import type { Check, CheckResult } from "./checks.js";

/** The limits of a sequence, in one place. */
export const SEQUENCE_LIMITS = {
  items: 20,
  delayMin: 1,
  delayMax: 3600,
  label: 120,
  reason: 500,
  workdir: 500,
} as const;

/** Item types a later phase adds: refused with a clear 400 until then. */
export const LATER_ITEM_TYPES = [
  "wait",
  "container",
  "unit",
  "log",
  "http",
  "port",
  "file",
  "job",
] as const;

export type OnFail = "stop" | "continue";

/** A command item, as stored. */
export interface RunItemSpec {
  type: "run";
  /** Shown to the person; null: the item's number and type only. */
  label: string | null;
  command: string;
  checks: Check[];
  captures: Array<{ name: string; pattern: string }>;
  /** Null: the default time limit. */
  timeoutMs: number | null;
  /** continue: a failure is recorded and the sequence goes on. */
  onFail: OnFail;
  /** Run opens a terminal (pty) for this item, for prompts like sudo's. */
  interactive: boolean;
}

/** A fixed wait in the plugin, as stored. Nothing runs on the host. */
export interface DelayItemSpec {
  type: "delay";
  label: string | null;
  seconds: number;
  reason: string | null;
}

export type SequenceItem = RunItemSpec | DelayItemSpec;

/** A sequence item as the page shows it before a run: values filled in. */
export type ResolvedItem = SequenceItem & {
  /** 1-based, as the page and the API number items. */
  position: number;
  /**
   * Names the item reads that an earlier item of this step captures: they
   * are filled when that item has run, so they do not stop a Run.
   */
  later: string[];
};

/**
 * waiting: not started (or never reached); running; passed; failed;
 * skipped: a delay a person skipped. A skipped delay counts as passed.
 */
export type ItemStatus =
  "waiting" | "running" | "passed" | "failed" | "skipped";

/** One item of one run, as stored and as every view shows it. */
export interface RunItem {
  id: number;
  runId: number;
  /** 1-based, the item's place in the step's sequence. */
  position: number;
  type: SequenceItem["type"];
  label: string | null;
  /** The command as it ran (values filled in, without the workdir). */
  command: string | null;
  /** A delay's seconds and reason. */
  seconds: number | null;
  reason: string | null;
  onFail: OnFail;
  status: ItemStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** When a running delay ends, unless a person skips it. */
  plannedEndAt: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  truncated: boolean;
  timedOut: boolean;
  /** Termix's words: a stop, an interruption, an exec error; or null. */
  error: string | null;
  /** One result per check of the item; null when they were not tested. */
  checks: CheckResult[] | null;
  /** Values the item captured; kept only when it passed. */
  captured: Record<string, string>;
  /** The person who skipped a delay. */
  skippedBy: string | null;
  /**
   * The run this item's record was carried from (Continue from item N):
   * it passed there and did not run again.
   */
  fromRunId: number | null;
  /** For a running item: when its command last printed anything. */
  lastOutputAt?: string | null;
}

/** An item that ended so that the sequence may go past it. */
export function itemSettled(item: Pick<RunItem, "status" | "onFail">): boolean {
  return (
    item.status === "passed" ||
    item.status === "skipped" ||
    (item.status === "failed" && item.onFail === "continue")
  );
}

/**
 * The 0-based index a Continue starts from: the first item that is not
 * settled (it failed and stopped the sequence, it was stopped or cut off
 * by a restart, or it never started). Null when every item settled.
 */
export function resumeIndex(
  items: ReadonlyArray<Pick<RunItem, "status" | "onFail" | "position">>,
): number | null {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex((item) => !itemSettled(item));
  return index === -1 ? null : index;
}

/**
 * Quotes text for a POSIX shell: in single quotes, each single quote
 * written as '\''. Nothing inside single quotes is special.
 */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command as it runs in the step's workdir: `cd -- '<dir>' && command`,
 * so a folder that is not there fails the item before the command starts.
 * POSIX shells only (Linux, macOS): on a Windows host, keep the cd in the
 * command.
 */
export function withWorkdir(command: string, workdir: string | null): string {
  return workdir ? `cd -- ${shellQuote(workdir)} && ${command}` : command;
}

/** "Wait 30 s" or "Wait 2 min 5 s", as a delay says it in text. */
export function delayWords(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${seconds} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * The whole sequence as one text: what a run keeps as its command, and what
 * the person approves (its hash). One block per item, numbered, with the
 * workdir first. Each run item's command is as it is, values filled in.
 */
export function sequenceText(
  items: ReadonlyArray<SequenceItem>,
  workdir: string | null,
): string {
  const lines: string[] = [];
  if (workdir) lines.push(`# in ${workdir}`);
  items.forEach((item, index) => {
    const head = `# ${index + 1}${item.label ? ` ${item.label}` : ""}`;
    if (item.type === "delay") {
      lines.push(
        `${head}: wait ${delayWords(item.seconds)}${item.reason ? `: ${item.reason}` : ""}`,
      );
    } else {
      lines.push(
        `${head}${item.onFail === "continue" ? " (on failure: continue)" : ""}`,
      );
      lines.push(item.command);
    }
  });
  return lines.join("\n");
}

/** The names of every value the items of a sequence capture. */
export function sequenceCaptureNames(
  sequence: ReadonlyArray<SequenceItem> | null | undefined,
): string[] {
  return (sequence ?? []).flatMap((item) =>
    item.type === "run" ? item.captures.map((capture) => capture.name) : [],
  );
}

/** The run items of a sequence. */
export function runItems(
  sequence: ReadonlyArray<SequenceItem> | null | undefined,
): RunItemSpec[] {
  return (sequence ?? []).filter(
    (item): item is RunItemSpec => item.type === "run",
  );
}
