/**
 * Step sequences (1.4.10, phase 1 of the sequences plan): a run step may be
 * a list of items that one Run press runs in order. A `run` item runs a
 * command on the step's host, a `delay` item waits a fixed time in the
 * plugin, with nothing on the host. A step with `command` is still one
 * command, exactly as before; it is never stored as a sequence.
 *
 * Each item of a run has its own record (RunItem): its command, output,
 * exit code, check results, captures, start and end.
 *
 * Phase 2 adds the `wait` item, which runs a command until its checks pass,
 * and `retry` on a run item, for a flaky command. Both make attempts on a
 * schedule (schedule.ts); each attempt is a record inside its item
 * (RunAttempt).
 *
 * Shared by the server and the UI. No React and no Node here.
 */

import type { Check, CheckResult } from "./checks.js";
import {
  planSchedule,
  scheduleWords,
  type RetryOn,
  type Schedule,
  type SchedulePlan,
} from "./schedule.js";
import { DEFAULT_TIMEOUT_MS } from "./limits.js";

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
  /**
   * Phase 2: run the command again on a schedule when it fails, for a
   * flaky command. Null or left out (steps from phase 1): one attempt.
   */
  retry?: RetrySpec | null;
}

/** A run item's retry, as stored: every field filled in. */
export interface RetrySpec extends Schedule {
  /** Most attempts, the first one included: 2 to 500. */
  attempts: number;
  /** Most seconds for all attempts and delays; null: the 2-hour limit. */
  within: number | null;
  /** Which failures get another attempt; the others fail the item. */
  retryOn: RetryOn[];
}

/**
 * Phase 2: run a command until its checks pass (the general poll), on a
 * schedule, as stored. A failed attempt means "not yet". It passes on the
 * first attempt that exits 0 with every check passing; it fails when a
 * stopIf check matches, or when the attempts or the time run out.
 */
export interface WaitItemSpec extends Schedule {
  type: "wait";
  label: string | null;
  command: string;
  /** At least one: what "ready" looks like. */
  checks: Check[];
  /** Checks that, when one matches, fail the item at once. */
  stopIf: Check[];
  /** Taken from the attempt that passed only. */
  captures: Array<{ name: string; pattern: string }>;
  /** Null: the default time limit, for each attempt. */
  timeoutMs: number | null;
  onFail: OnFail;
  /** Most seconds for all attempts and delays: 1 to 7200. */
  within: number;
  /** Most attempts; null: the top limit (500). */
  attempts: number | null;
}

/** A fixed wait in the plugin, as stored. Nothing runs on the host. */
export interface DelayItemSpec {
  type: "delay";
  label: string | null;
  seconds: number;
  reason: string | null;
}

export type SequenceItem = RunItemSpec | DelayItemSpec | WaitItemSpec;

/** An item that runs a command on the host: run or wait. */
export type CommandItemSpec = RunItemSpec | WaitItemSpec;

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
  /**
   * Phase 2, a wait item or a run item with retry: the most attempts it
   * may make. Null on any other item.
   */
  maxAttempts: number | null;
  /** When its time limit ends; null until it started, and on other items. */
  endsBy: string | null;
  /** When the next attempt starts, while it waits between two. */
  nextAttemptAt: string | null;
  /** Its attempts, oldest first; absent on an item with no schedule. */
  attempts?: RunAttempt[];
}

/**
 * Why an attempt did not pass: exit (a non-zero exit code), check (exit 0,
 * a check failed), timeout, connect (no connection, or an error before the
 * command ran), stop-if (a stopIf check matched), stopped (a person
 * stopped it), interrupted (Termix or Runbooks stopped).
 */
export type AttemptWhy =
  | "exit"
  | "check"
  | "timeout"
  | "connect"
  | "stop-if"
  | "stopped"
  | "interrupted";

/** One attempt of a wait item or of a run item with retry (phase 2). */
export interface RunAttempt {
  id: number;
  /** The run item it belongs to. */
  itemId: number;
  /** 1-based. */
  attempt: number;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  truncated: boolean;
  timedOut: boolean;
  /** Termix's words: a stop, an interruption, an exec error; or null. */
  error: string | null;
  /** One result per check of the item; null when they were not tested. */
  checks: CheckResult[] | null;
  /** One result per stopIf check of a wait item; ok: it matched. */
  stopIf: CheckResult[] | null;
  /** Why it did not pass; null while it runs and when it passed. */
  why: AttemptWhy | null;
}

/** Where the attempts of a running item are (agents read it on the step). */
export interface AttemptState {
  /** The item's number in the sequence. */
  item: number;
  /** The attempt that runs, or the last one while it waits. */
  attempt: number;
  of: number;
  /** When the next attempt starts; null while one runs. */
  nextAt: string | null;
  endsBy: string | null;
}

/** The schedule of an item that makes attempts; null for any other. */
export function itemSchedule(
  item: SequenceItem,
): (Schedule & { attempts: number | null; within: number | null }) | null {
  if (item.type === "wait") return item;
  if (item.type === "run" && item.retry) return item.retry;
  return null;
}

/** An item's planned attempts, before a run; null for one attempt. */
export function itemPlan(item: SequenceItem): SchedulePlan | null {
  const schedule = itemSchedule(item);
  if (!schedule || item.type === "delay") return null;
  return planSchedule(
    schedule,
    schedule.attempts,
    schedule.within,
    item.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

/** "up to 120 attempts, every 30 s, at most 1 h", or null. */
export function itemScheduleWords(item: SequenceItem): string | null {
  const schedule = itemSchedule(item);
  const plan = itemPlan(item);
  return schedule && plan ? scheduleWords(schedule, plan) : null;
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
      // Phase 2: the schedule is part of what the person approves.
      const words = itemScheduleWords(item);
      const schedule = words
        ? item.type === "wait"
          ? `: until its checks pass, ${words}`
          : ` (retry: ${words})`
        : "";
      lines.push(
        `${head}${schedule}${item.onFail === "continue" ? " (on failure: continue)" : ""}`,
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
    item.type !== "delay" ? item.captures.map((capture) => capture.name) : [],
  );
}

/** The items of a sequence that run a command: run and wait items. */
export function runItems(
  sequence: ReadonlyArray<SequenceItem> | null | undefined,
): CommandItemSpec[] {
  return (sequence ?? []).filter(
    (item): item is CommandItemSpec => item.type !== "delay",
  );
}

/** An item's checks with its stopIf checks: all that read its output. */
export function itemChecks(item: SequenceItem): Check[] {
  if (item.type === "delay") return [];
  return item.type === "wait" ? [...item.checks, ...item.stopIf] : item.checks;
}
