/**
 * Running a sequence step (1.4.10): one Run press runs the step's items in
 * order, as the person who pressed it. The work starts inside the Run
 * request, so every item, delay and timer after the answer still acts as
 * that person (core keeps the acting user for timers and promises).
 *
 * Each run item opens a connection of its own, as a plain run does. Before
 * each item after the first, the person must still be able to connect to
 * the host: core checks no session after the request, so this check is the
 * one that stops a sequence for a person who lost access. A delay item is a
 * timer here; nothing runs on the host, and the person may skip it.
 *
 * Phase 2: a wait item, and a run item with retry, make attempts on a
 * schedule (attempts.ts, src/shared/schedule.ts). Each attempt is a record
 * of its own (run_attempts) with its own connection; the same access check
 * comes before each attempt after the first. The delay between two
 * attempts is a timer, as a delay item is: the server goes on with the
 * page closed, and Try now ends that delay. One Run press is the person's
 * consent for every attempt of it, so attempts never ask the repeat
 * question.
 *
 * Phase 3: an event item (port, http, file, container, unit, log, job)
 * makes attempts on the same schedule; each attempt is one check, done by
 * the plugin (src/backend/events/probes.ts) on a connection of its own,
 * with the state it read in words. A job's first check starts its unit.
 *
 * An item that fails stops the sequence and fails the step, unless it says
 * onFail "continue". Stop ends the item that runs and the rest. Continue
 * (run-routes.ts) makes a new run that carries the items that passed and
 * starts at the first one that did not.
 */

import type { Request } from "express";
import type { RunRow, StepRow } from "../runbooks/store/types.js";
import { now } from "../runbooks/store/store.js";
import type { PersonKit } from "../runbooks/person-kit.js";
import { LIMITS } from "../runbooks/parse.js";
import type { RunbookBundle } from "../runbooks/view.js";
import { resolveItem, valuesObject } from "../values/effective.js";
import type { Values } from "../values/values.js";
import { judgeOutput, type Check, type Judgement } from "../checks/checks.js";
import type { FailReason } from "../agents/events.js";
import { stepLabel } from "../../shared/steps.js";
import { MIN_HIDDEN_CHARS } from "../../shared/limits.js";
import { SCHEDULE_LIMITS, secondsWords } from "../../shared/schedule.js";
import {
  isEventItem,
  itemSchedule,
  withWorkdir,
  type AttemptWhy,
  type CommandItemSpec,
  type DelayItemSpec,
  type ResolvedItem,
  type SequenceItem,
} from "../../shared/sequence.js";
import type { RunItem } from "../../shared/sequence.js";
import {
  EVENT_LIMITS,
  eventWhat,
  type EventItemSpec,
} from "../../shared/events.js";
import {
  newMemory,
  probe,
  stopJob,
  Stopped,
  type EventMemory,
  type ProbeClient,
  type ProbeOutcome,
} from "../events/probes.js";
import { readPlatform } from "../events/readers.js";
import { HTTP_CA_SETTING, trustedCas } from "../events/trust.js";
import { filledEventProblem } from "../runbooks/event-parse.js";
import {
  INTERACTIVE_PTY,
  streamExec,
  type ExecClient,
  type StreamExecResult,
} from "./stream-exec.js";
import { createRedactor, redact, type SecretText } from "./redact.js";
import { cleanedCopies, LINE_END, MAX_OUTPUT_BYTES } from "./runner.js";
import { errorText, hasError, noErrorParts } from "./run-error.js";
import {
  attemptTimeout,
  attemptWhy,
  delayAfter,
  exhaustedText,
  mayRetry,
  stopIfText,
} from "./attempts.js";

/** Why an item did not start: the person lost access to the host. */
export const NO_ACCESS = "stopped: you can no longer connect to this host";

/** Why a run item did not start: a value an earlier item captures is not there. */
export const NOT_CAPTURED =
  "a value this item reads was not captured: the item that captures it did not pass";

/** How an item ended, as the sequence goes on from it. */
interface ItemEnd {
  passed: boolean;
  reason: FailReason;
  /** Termix's words for the item's failure; null for an exit code. */
  error: string | null;
  /** Captures whose pattern did not finish in time. */
  slow: string[];
  /**
   * The sequence stops here whatever the item's onFail says: the person
   * lost access to the host between two attempts.
   */
  final?: boolean;
}

/** What a run of a sequence starts with. */
export interface SequenceTarget {
  /** The person who pressed Run or Continue. */
  by: string;
  hostId: number;
  /** The whole sequence as one text, and its hash (the run's identity). */
  command: string;
  hash: string;
  /** The items as the person approved them. */
  items: ResolvedItem[];
  /** Seconds of the step's wait timer the person skipped, if any. */
  skippedWait: number | null;
}

/** What a run item reads and keeps while the sequence runs. */
interface ItemContext {
  position: number;
  values: Values;
  hidden: SecretText[];
  typed: SecretText[];
}

/** How one command ended: run to its end, or not run (no connection). */
type Executed =
  | { ran: true; result: StreamExecResult; hiddenAll: SecretText[] }
  | {
      ran: false;
      message: string;
      stdout: string;
      stderr: string;
      truncated: boolean;
      hiddenAll: SecretText[];
    };

/** An ended command's checks and captures, and how it ended. */
interface Judged {
  judged: Judgement;
  passed: boolean;
  exited: boolean;
  stopped: boolean;
  /** Termix's words: a stop or an interruption; or null. */
  error: string | null;
  reason: FailReason;
}

/** The text cut to the output limit, as a run keeps it. */
function capped(text: string): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return { text, cut: false };
  return {
    text: bytes
      .subarray(0, MAX_OUTPUT_BYTES)
      .toString("utf8")
      .replace(/�+$/, ""),
    cut: true,
  };
}

/** An ISO time `ms` from now. */
function after(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function createSequenceRunner(kit: PersonKit) {
  const { ctx, store, live, events, audit } = kit;

  /**
   * Makes the run and its items, then runs the items from `from` on (0 for
   * Run; the first item that did not pass for Continue, whose earlier items
   * are carried from `previous`). Returns the run's id at once; the items
   * run after the answer. `release` lets the step go when it ends.
   */
  async function start(
    req: Request,
    step: StepRow,
    bundle: RunbookBundle,
    target: SequenceTarget,
    hidden: SecretText[],
    release: () => void,
    previous: { run: RunRow; index: number } | null = null,
  ): Promise<number> {
    const sequence = step.sequence!;
    const startedAt = now();
    const runId = await store.insertRun({
      stepId: step.id,
      runbookId: step.runbookId,
      mode: "exec",
      status: "running",
      hostId: target.hostId,
      command: target.command,
      commandHash: target.hash,
      userId: target.by,
      startedAt,
      stdout: "",
      stderr: "",
      startedEarlySeconds: target.skippedWait,
    });
    const from = previous?.index ?? 0;
    const values: Values = valuesObject(bundle.values);
    // Phase 3: an event's record names the host ("on home-server").
    const hostName = await nameOf(target.hostId);
    const itemIds: number[] = [];
    for (const [index, item] of sequence.entries()) {
      const carried: RunItem | undefined =
        index < from ? previous?.run.items?.[index] : undefined;
      if (carried) {
        // It passed in the run before: its record comes along, unchanged,
        // with its attempts (phase 2).
        const {
          id: _id,
          runId: _runId,
          lastOutputAt: _last,
          attempts,
          ...kept
        } = carried;
        const itemId = await store.insertRunItem({
          ...kept,
          runId,
          stepId: step.id,
          runbookId: step.runbookId,
          fromRunId: carried.fromRunId ?? previous!.run.id,
        });
        for (const attempt of attempts ?? []) {
          const { id: _attemptId, ...record } = attempt;
          await store.insertRunAttempt({
            ...record,
            itemId,
            runId,
            runbookId: step.runbookId,
          });
        }
        itemIds.push(itemId);
        if (carried.status === "passed")
          Object.assign(values, carried.captured);
        continue;
      }
      const approved = target.items[index];
      const schedule = itemSchedule(item);
      itemIds.push(
        await store.insertRunItem({
          runId,
          stepId: step.id,
          runbookId: step.runbookId,
          position: index + 1,
          type: item.type,
          label: item.label,
          command: itemCommand(approved ?? item, runId, index + 1, hostName),
          seconds: item.type === "delay" ? item.seconds : null,
          reason: item.type === "delay" ? item.reason : null,
          onFail: item.type !== "delay" ? item.onFail : "stop",
          status: "waiting",
          startedAt: null,
          finishedAt: null,
          plannedEndAt: null,
          exitCode: null,
          stdout: null,
          stderr: null,
          truncated: false,
          timedOut: false,
          error: null,
          checks: null,
          captured: {},
          skippedBy: null,
          fromRunId: null,
          maxAttempts: schedule ? maxAttempts(schedule.attempts) : null,
          endsBy: null,
          nextAttemptAt: null,
          result: null,
        }),
      );
    }
    await store.touchRunbook(step.runbookId);
    await store.persist();
    const record = live.start({
      runId,
      stepId: step.id,
      runbookId: step.runbookId,
      startedAt,
    });
    record.sequence = true;
    // Started inside the request, so it keeps acting as this person after
    // the answer is sent: every item, delay, attempt and access check.
    record.done = runItems(req, runId, step, target, {
      from,
      itemIds,
      values,
      hidden,
      release,
    });
    return runId;
  }

  async function runItems(
    req: Request,
    runId: number,
    step: StepRow,
    target: SequenceTarget,
    state: {
      from: number;
      itemIds: number[];
      values: Values;
      hidden: SecretText[];
      release: () => void;
    },
  ): Promise<void> {
    const record = live.get(runId)!;
    const sequence = step.sequence!;
    // Hidden input the person typed, kept in memory for this run only: it
    // is hidden in every later item's output too.
    const typed: SecretText[] = [];
    const slow: string[] = [];
    let failure: { position: number; end: ItemEnd } | null = null;
    try {
      for (let index = state.from; index < sequence.length; index++) {
        const item = sequence[index];
        const itemId = state.itemIds[index];
        const position = index + 1;
        if (record.stoppedBy || record.interrupted) {
          failure = {
            position,
            end: {
              passed: false,
              reason: record.stoppedBy ? "stopped" : "interrupted",
              error: record.stoppedBy
                ? `stopped by ${record.stoppedBy}`
                : record.interrupted,
              slow: [],
            },
          };
          break;
        }
        if (index > state.from && !(await stillAllowed(target))) {
          const at = now();
          await store.updateRunItem(itemId, {
            status: "failed",
            startedAt: at,
            finishedAt: at,
            error: NO_ACCESS,
          });
          await auditNoAccess(req, step, target, position, "not started");
          failure = { position, end: noAccessEnd() };
          break;
        }
        const context = {
          position,
          values: state.values,
          hidden: state.hidden,
          typed,
        };
        const end =
          item.type === "delay"
            ? await runDelay(req, runId, step, target, item, itemId, position)
            : isEventItem(item)
              ? await runEvent(req, runId, step, target, item, itemId, context)
              : itemSchedule(item)
                ? await runAttempts(
                    req,
                    runId,
                    step,
                    target,
                    item,
                    itemId,
                    context,
                  )
                : await runCommand(
                    req,
                    runId,
                    step,
                    target,
                    item,
                    itemId,
                    context,
                  );
        slow.push(...end.slow);
        if (end.passed) continue;
        if (
          end.final ||
          end.reason === "stopped" ||
          end.reason === "interrupted" ||
          item.type === "delay" ||
          item.onFail === "stop"
        ) {
          failure = { position, end };
          break;
        }
      }
      await finish(runId, step, target, failure, slow);
    } catch (error) {
      // Most likely the database went away because Termix is stopping; the
      // sweep on the next start finishes the run.
      ctx.log.error(
        `run ${runId} could not be finished`,
        error instanceof Error ? error : undefined,
      );
    } finally {
      live.remove(runId);
      state.release();
    }
  }

  /** "runbook 3 step 2 item 4 on host 1", for the audit log. */
  function where(step: StepRow, target: SequenceTarget, position: number) {
    return `runbook ${step.runbookId} step ${stepLabel(step)} item ${position} on host ${target.hostId}`;
  }

  /** The host's name in Termix, as the person sees it; null if unknown. */
  async function nameOf(hostId: number): Promise<string | null> {
    const host = await ctx.hosts.get(hostId).catch(() => null);
    return host?.name || host?.ip || null;
  }

  /** Whether the person who pressed Run may still connect to the host. */
  async function stillAllowed(target: SequenceTarget): Promise<boolean> {
    const access = await ctx.hosts
      .checkAccess(target.hostId, "connect")
      .catch(() => ({ hasAccess: false }));
    return access.hasAccess;
  }

  async function auditNoAccess(
    req: Request,
    step: StepRow,
    target: SequenceTarget,
    position: number,
    what: string,
  ): Promise<void> {
    await audit(
      req,
      "runbooks_step_run",
      step,
      `${where(step, target, position)}: ${what}, ${target.by} can no longer connect to the host`,
      false,
    );
  }

  function noAccessEnd(): ItemEnd {
    return {
      passed: false,
      reason: "exit",
      error: NO_ACCESS,
      slow: [],
      final: true,
    };
  }

  /**
   * A delay item: a timer in the plugin with the planned end on the item,
   * so the page counts down. Skip ends it as passed (skipped), Stop as
   * failed.
   */
  async function runDelay(
    req: Request,
    runId: number,
    step: StepRow,
    target: SequenceTarget,
    item: DelayItemSpec,
    itemId: number,
    position: number,
  ): Promise<ItemEnd> {
    const record = live.get(runId)!;
    const ms = item.seconds * 1000;
    const startedAt = now();
    await store.updateRunItem(itemId, {
      status: "running",
      startedAt,
      plannedEndAt: new Date(Date.parse(startedAt) + ms).toISOString(),
    });
    await store.persist(true);
    live.beginItem(runId, itemId);
    let skippedBy: string | null = null;
    let written: () => void = () => {};
    const isWritten = new Promise<void>((resolve) => (written = resolve));
    const how = await new Promise<"over" | "skipped" | "stopped">((resolve) => {
      if (record.stoppedBy || record.interrupted) {
        resolve("stopped");
        return;
      }
      const timer = setTimeout(() => resolve("over"), ms);
      const end = (value: "skipped" | "stopped") => {
        clearTimeout(timer);
        resolve(value);
      };
      record.stop = () => end("stopped");
      record.skipDelay = (by) => {
        skippedBy = by;
        end("skipped");
        return isWritten;
      };
    });
    live.endItem(runId);
    const error =
      how === "stopped"
        ? record.stoppedBy
          ? `stopped by ${record.stoppedBy}`
          : (record.interrupted ?? "stopped")
        : null;
    await store.updateRunItem(itemId, {
      status:
        how === "over" ? "passed" : how === "skipped" ? "skipped" : "failed",
      finishedAt: now(),
      skippedBy,
      error,
    });
    written();
    if (how === "skipped") {
      await audit(
        req,
        "runbooks_step_delay_skipped",
        step,
        `${where(step, target, position)}: delay of ${item.seconds} s skipped by ${skippedBy}`,
        true,
      );
    }
    return {
      passed: how !== "stopped",
      reason: record.stoppedBy ? "stopped" : "interrupted",
      error,
      slow: [],
    };
  }

  /**
   * Runs one command of a run or wait item on a connection of its own, its
   * output streaming into the item, secrets hidden. A Stop ends it. Never
   * throws: no connection, or an error before the command ended, comes
   * back as not run, with the output that came so far.
   */
  async function execOnce(
    runId: number,
    step: StepRow,
    item: CommandItemSpec,
    command: string,
    timeoutMs: number,
    context: ItemContext,
  ): Promise<Executed> {
    const record = live.get(runId)!;
    const { typed } = context;
    const interactive = item.type === "run" && item.interactive;
    // A pty's output is cleaned, so a value with control characters shows
    // there cleaned: that copy is hidden too (BUG-010).
    const copies = (list: SecretText[]) =>
      interactive ? cleanedCopies(list) : [];
    const known = [...context.hidden, ...typed];
    const redactors = {
      stdout: createRedactor([...known, ...copies(known)]),
      stderr: createRedactor([...known, ...copies(known)]),
    };
    const hiddenAll = () => {
      const all = [...context.hidden, ...typed];
      return [...all, ...copies(all)];
    };
    let connection: { client: ExecClient; dispose: () => void } | null = null;
    try {
      connection = await ctx.ssh.connect<ExecClient>(step.hostId!, {
        purpose: "runbooks",
      });
      let result: StreamExecResult;
      if (record.stoppedBy || record.interrupted) {
        result = {
          stdout: "",
          stderr: "",
          code: null,
          truncated: false,
          timedOut: false,
          stopped: true,
        };
      } else {
        const handle = streamExec(
          connection.client,
          withWorkdir(command, step.workdir),
          {
            timeoutMs,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            onOutput: (stream, text) =>
              live.output(runId, stream, redactors[stream].push(text)),
            onTruncate: () => live.truncated(runId),
            pty: interactive ? INTERACTIVE_PTY : undefined,
          },
        );
        record.stop = handle.stop;
        record.input = {
          open: handle.inputOpen,
          send: (sent, hiddenText) => {
            const value = sent.replace(LINE_END, "");
            // Enter is CR in a terminal (BUG-010).
            const text = interactive && value !== sent ? `${value}\r` : sent;
            if (hiddenText && [...value].length >= MIN_HIDDEN_CHARS) {
              // Before the write, so its echo can never show.
              const secret = { name: "typed", value };
              typed.push(secret);
              for (const each of [secret, ...copies([secret])]) {
                redactors.stdout.add(each);
                redactors.stderr.add(each);
              }
            }
            return handle.write(Buffer.from(text, "utf8"));
          },
          end: handle.endInput,
        };
        result = await handle.result;
      }
      connection.dispose();
      await live.settle(runId);
      return { ran: true, result, hiddenAll: hiddenAll() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await live.settle(runId);
      const partial = live.get(runId)!;
      connection?.dispose();
      return {
        ran: false,
        message,
        stdout: redact(partial.stdout, hiddenAll()),
        stderr: redact(partial.stderr, hiddenAll()),
        truncated: partial.truncated,
        hiddenAll: hiddenAll(),
      };
    }
  }

  /**
   * An ended command's checks and captures, read with secrets hidden, as
   * the person sees the output (1.4.1).
   */
  function judge(
    runId: number,
    item: CommandItemSpec,
    checks: Check[],
    result: StreamExecResult,
    hiddenAll: SecretText[],
  ): Judged {
    const record = live.get(runId)!;
    const stopped = result.stopped || Boolean(record.stoppedBy);
    const exited =
      result.code === 0 && !result.timedOut && !stopped && !record.interrupted;
    const judged = judgeOutput(
      { checks, captures: item.captures, secretCaptures: [] },
      exited ? "done" : "failed",
      {
        mode: "exec",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        pastedOutput: null,
      },
      result.stdout,
      hiddenAll,
    );
    const passed = judged.final === "done";
    // Termix stopping ends the item as interrupted, not as a person's stop.
    const error =
      record.interrupted ??
      (stopped ? `stopped by ${record.stoppedBy ?? "a person"}` : null);
    return {
      judged,
      passed,
      exited,
      stopped,
      error,
      reason: record.interrupted
        ? "interrupted"
        : stopped
          ? "stopped"
          : exited
            ? "check"
            : "exit",
    };
  }

  /**
   * A run item: its command with the values so far (captures of earlier
   * items too), in the step's workdir, over a connection of its own. Its
   * checks and captures read its own output, secrets hidden.
   */
  async function runCommand(
    req: Request,
    runId: number,
    step: StepRow,
    target: SequenceTarget,
    item: CommandItemSpec,
    itemId: number,
    context: ItemContext,
  ): Promise<ItemEnd> {
    const record = live.get(runId)!;
    const { position, values } = context;
    const resolved = resolveItem(item, position, values, new Set());
    if (resolved.type !== "run" && resolved.type !== "wait") {
      throw new Error("not a command item");
    }
    const startedAt = now();
    if (resolved.missing.length > 0) {
      await store.updateRunItem(itemId, {
        status: "failed",
        startedAt,
        finishedAt: startedAt,
        command: resolved.command,
        error: NOT_CAPTURED,
      });
      return { passed: false, reason: "exit", error: NOT_CAPTURED, slow: [] };
    }
    await store.updateRunItem(itemId, {
      status: "running",
      startedAt,
      command: resolved.command,
    });
    await store.persist(true);
    live.beginItem(runId, itemId);
    const line = where(step, target, position);
    const executed = await execOnce(
      runId,
      step,
      item,
      resolved.command,
      item.timeoutMs ?? LIMITS.timeoutDefault,
      context,
    );
    if (!executed.ran) {
      const why = record.stoppedBy
        ? `stopped by ${record.stoppedBy}`
        : (record.interrupted ?? executed.message);
      await store.updateRunItem(itemId, {
        status: "failed",
        finishedAt: now(),
        stdout: executed.stdout,
        stderr: executed.stderr,
        truncated: executed.truncated,
        error: redact(why, executed.hiddenAll),
      });
      live.endItem(runId);
      await audit(
        req,
        "runbooks_step_run",
        step,
        line,
        false,
        executed.message,
      );
      return {
        passed: false,
        reason: record.stoppedBy
          ? "stopped"
          : record.interrupted
            ? "interrupted"
            : "exit",
        error: why,
        slow: [],
      };
    }
    live.endItem(runId);
    const { result } = executed;
    const { judged, passed, exited, stopped, error, reason } = judge(
      runId,
      item,
      resolved.checks,
      result,
      executed.hiddenAll,
    );
    await store.updateRunItem(itemId, {
      status: passed ? "passed" : "failed",
      finishedAt: now(),
      exitCode: result.code,
      stdout: redact(result.stdout, judged.hide),
      stderr: redact(result.stderr, judged.hide),
      truncated: result.truncated,
      timedOut: result.timedOut,
      checks: judged.results,
      captured: passed ? judged.captured : {},
      error: error ? redact(error, judged.hide) : null,
    });
    await store.persist(true);
    if (passed) Object.assign(values, judged.captured);
    await audit(
      req,
      "runbooks_step_run",
      step,
      `${line}: ${
        stopped
          ? "stopped"
          : result.timedOut
            ? "timed out"
            : `exit ${result.code ?? "none"}${exited && !passed ? ", checks failed" : ""}`
      }`,
      passed,
    );
    return {
      passed,
      reason,
      error,
      slow: passed ? judged.slowCaptures : [],
    };
  }

  /**
   * A wait item, or a run item with retry (phase 2): attempts of its
   * command on its schedule until one passes, a stopIf check matches (a
   * wait), a failure its retryOn does not name comes (a retry), or the
   * attempts or the time run out. Each attempt is a record; the item keeps
   * the last attempt's output, exit code and checks, and the captures of
   * the attempt that passed only. Between two attempts the item waits on a
   * timer with the next attempt's time on it, so the page counts down;
   * Try now ends that wait, Stop ends the item.
   */
  async function runAttempts(
    req: Request,
    runId: number,
    step: StepRow,
    target: SequenceTarget,
    item: CommandItemSpec,
    itemId: number,
    context: ItemContext,
  ): Promise<ItemEnd> {
    const record = live.get(runId)!;
    const schedule = itemSchedule(item)!;
    const { position, values } = context;
    const resolved = resolveItem(item, position, values, new Set());
    if (resolved.type !== "run" && resolved.type !== "wait") {
      throw new Error("not a command item");
    }
    const startedAt = now();
    if (resolved.missing.length > 0) {
      await store.updateRunItem(itemId, {
        status: "failed",
        startedAt,
        finishedAt: startedAt,
        command: resolved.command,
        error: NOT_CAPTURED,
      });
      return { passed: false, reason: "exit", error: NOT_CAPTURED, slow: [] };
    }
    const most = maxAttempts(schedule.attempts);
    const within = Math.min(
      schedule.within ?? SCHEDULE_LIMITS.within,
      SCHEDULE_LIMITS.within,
    );
    const endsAt = Date.parse(startedAt) + within * 1000;
    await store.updateRunItem(itemId, {
      status: "running",
      startedAt,
      command: resolved.command,
      maxAttempts: most,
      endsBy: new Date(endsAt).toISOString(),
    });
    await store.persist(true);
    const line = where(step, target, position);
    const stopIf = resolved.type === "wait" ? resolved.stopIf : [];
    const timeoutMs = item.timeoutMs ?? LIMITS.timeoutDefault;
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1 && !(await stillAllowed(target))) {
        await store.updateRunItem(itemId, {
          status: "failed",
          finishedAt: now(),
          nextAttemptAt: null,
          error: NO_ACCESS,
        });
        await auditNoAccess(
          req,
          step,
          target,
          position,
          `attempt ${attempt} not started`,
        );
        live.endItem(runId);
        return noAccessEnd();
      }
      live.beginItem(runId, itemId);
      const attemptStart = now();
      await store.updateRunItem(itemId, { nextAttemptAt: null });
      const attemptId = await store.insertRunAttempt({
        itemId,
        runId,
        runbookId: step.runbookId,
        attempt,
        status: "running",
        startedAt: attemptStart,
        finishedAt: null,
        exitCode: null,
        stdout: null,
        stderr: null,
        truncated: false,
        timedOut: false,
        error: null,
        checks: null,
        stopIf: null,
        why: null,
        result: null,
      });
      await store.persist(true);
      const executed = await execOnce(
        runId,
        step,
        item,
        resolved.command,
        attemptTimeout(timeoutMs, endsAt, Date.now()),
        context,
      );
      const ended = await endAttempt(
        runId,
        item,
        { itemId, attemptId },
        executed,
        resolved.checks,
        stopIf,
      );
      if (ended.why === null) {
        Object.assign(values, ended.captured);
        await store.updateRunItem(itemId, {
          status: "passed",
          finishedAt: now(),
          captured: ended.captured,
        });
        await store.persist(true);
        live.endItem(runId);
        await audit(
          req,
          "runbooks_step_run",
          step,
          `${line}: attempt ${attempt} passed`,
          true,
        );
        return { passed: true, reason: "check", error: null, slow: ended.slow };
      }
      // What ends the item here, with its words; null: another attempt.
      let end: { error: string | null } | null = null;
      if (ended.why === "stopped" || ended.why === "interrupted") {
        end = { error: ended.error };
      } else if (ended.why === "stop-if") {
        end = { error: stopIfText(ended.stopLabel ?? "stopIf") };
      } else if (!mayRetry(item, ended.why)) {
        // A failure its retryOn does not name: as a run item fails.
        end = { error: ended.error };
      } else if (attempt >= most) {
        end = { error: exhaustedText(item.type, attempt, "attempts", within) };
      }
      const delay = delayAfter(schedule, attempt);
      if (end === null && Date.now() + delay >= endsAt) {
        end = { error: exhaustedText(item.type, attempt, "time", within) };
      }
      if (end === null) {
        const waited = await between(runId, itemId, delay);
        if (waited.how === "now") {
          await audit(
            req,
            "runbooks_step_try_now",
            step,
            `${line}: attempt ${attempt + 1} started early by ${waited.by}`,
            true,
          );
        }
        if (waited.how !== "stopped") continue;
        end = {
          error: record.stoppedBy
            ? `stopped by ${record.stoppedBy}`
            : (record.interrupted ?? "stopped"),
        };
      }
      const { error } = end;
      const reason: FailReason = record.interrupted
        ? "interrupted"
        : record.stoppedBy
          ? "stopped"
          : ended.why === "exit" ||
              ended.why === "timeout" ||
              ended.why === "connect"
            ? "exit"
            : "check";
      await store.updateRunItem(itemId, {
        status: "failed",
        finishedAt: now(),
        nextAttemptAt: null,
        error: error === null ? null : redact(error, ended.hide),
      });
      await store.persist(true);
      live.endItem(runId);
      await audit(
        req,
        "runbooks_step_run",
        step,
        `${line}: ${attempt} attempt${attempt === 1 ? "" : "s"}, ${reason === "stopped" || reason === "interrupted" ? reason : ended.why}`,
        false,
      );
      return { passed: false, reason, error, slow: [] };
    }
  }

  /**
   * Writes an ended attempt: its record, and the item's last output, exit
   * code and checks. Returns why it did not pass (null: it passed), with
   * the captures of a pass.
   */
  async function endAttempt(
    runId: number,
    item: CommandItemSpec,
    ids: { itemId: number; attemptId: number },
    executed: Executed,
    checks: Check[],
    stopIf: Check[],
  ): Promise<{
    why: AttemptWhy | null;
    error: string | null;
    stopLabel: string | null;
    captured: Record<string, string>;
    slow: string[];
    hide: SecretText[];
  }> {
    const record = live.get(runId)!;
    const at = now();
    if (!executed.ran) {
      const why: AttemptWhy = record.interrupted
        ? "interrupted"
        : record.stoppedBy
          ? "stopped"
          : "connect";
      const error =
        why === "stopped"
          ? `stopped by ${record.stoppedBy}`
          : (record.interrupted ?? executed.message);
      const output = {
        exitCode: null,
        stdout: executed.stdout,
        stderr: executed.stderr,
        truncated: executed.truncated,
        timedOut: false,
        checks: null,
      };
      await store.updateRunAttempt(ids.attemptId, {
        ...output,
        status: "failed",
        finishedAt: at,
        error: redact(error, executed.hiddenAll),
        why,
      });
      await store.updateRunItem(ids.itemId, output);
      return {
        why,
        error,
        stopLabel: null,
        captured: {},
        slow: [],
        hide: executed.hiddenAll,
      };
    }
    const { result } = executed;
    const { judged, exited, stopped, error } = judge(
      runId,
      item,
      checks,
      result,
      executed.hiddenAll,
    );
    // A stopIf check matches when it passes on this attempt's output.
    const stopJudged =
      stopIf.length > 0 && !stopped && !record.interrupted
        ? judgeOutput(
            { checks: stopIf, captures: [], secretCaptures: [] },
            "done",
            {
              mode: "exec",
              exitCode: result.code,
              stdout: result.stdout,
              stderr: result.stderr,
              pastedOutput: null,
            },
            result.stdout,
            executed.hiddenAll,
            { captures: false },
          ).results
        : null;
    const matched = (stopJudged ?? []).find((check) => check.ok) ?? null;
    const why = attemptWhy({
      stopped,
      interrupted: Boolean(record.interrupted),
      connectFailed: false,
      timedOut: result.timedOut,
      exitCode: result.code,
      checksPassed: exited && judged.final === "done",
      stopMatched: matched !== null,
    });
    const output = {
      exitCode: result.code,
      stdout: redact(result.stdout, judged.hide),
      stderr: redact(result.stderr, judged.hide),
      truncated: result.truncated,
      timedOut: result.timedOut,
      checks: judged.results,
    };
    await store.updateRunAttempt(ids.attemptId, {
      ...output,
      status: why === null ? "passed" : "failed",
      finishedAt: at,
      stopIf: stopJudged,
      error: error ? redact(error, judged.hide) : null,
      why,
    });
    await store.updateRunItem(ids.itemId, output);
    return {
      why,
      error,
      stopLabel: matched?.label ?? null,
      captured: why === null ? judged.captured : {},
      slow: why === null ? judged.slowCaptures : [],
      hide: judged.hide,
    };
  }

  /**
   * An event item (phase 3): checks on its schedule until its state holds,
   * a state that fails it at once comes (the container exited, the unit
   * failed, forwarding refused), or the attempts or the time run out. Each
   * check is an attempt with a connection of its own, as a wait's attempt
   * is, after the same access check. The item keeps the last check's
   * output and its state in words (`result`); a job keeps its journal so
   * far, streamed into the item as it comes, and its unit is stopped when
   * the item ends before the job did (Stop, or out of time).
   */
  async function runEvent(
    req: Request,
    runId: number,
    step: StepRow,
    target: SequenceTarget,
    item: EventItemSpec,
    itemId: number,
    context: ItemContext,
  ): Promise<ItemEnd> {
    const record = live.get(runId)!;
    const { position, values, hidden } = context;
    const { missing, ...filled } = resolveItem(
      item,
      position,
      values,
      new Set(),
    );
    const event = filled as EventItemSpec;
    const startedAt = now();
    const what = eventWhat(event, await nameOf(target.hostId), runId, position);
    const problem =
      missing.length > 0 ? NOT_CAPTURED : filledEventProblem(event);
    if (problem) {
      await store.updateRunItem(itemId, {
        status: "failed",
        startedAt,
        finishedAt: startedAt,
        command: what,
        error: problem,
      });
      return { passed: false, reason: "exit", error: problem, slow: [] };
    }
    const most = maxAttempts(event.attempts);
    const within = Math.min(event.within, SCHEDULE_LIMITS.within);
    const endsAt = Date.parse(startedAt) + within * 1000;
    await store.updateRunItem(itemId, {
      status: "running",
      startedAt,
      command: what,
      maxAttempts: most,
      endsBy: new Date(endsAt).toISOString(),
    });
    await store.persist(true);
    const since = await stepStart(runId, startedAt);
    const memory = newMemory();
    const line = where(step, target, position);
    const hide = (text: string) => redact(text, hidden);
    // A job streams its journal into the item across its checks.
    if (event.type === "job") live.beginItem(runId, itemId);
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1 && !(await stillAllowed(target))) {
        await stopUnfinishedJob(step, event, memory, runId, position);
        await store.updateRunItem(itemId, {
          status: "failed",
          finishedAt: now(),
          nextAttemptAt: null,
          error: NO_ACCESS,
        });
        await auditNoAccess(
          req,
          step,
          target,
          position,
          `check ${attempt} not started`,
        );
        live.endItem(runId);
        return noAccessEnd();
      }
      if (event.type !== "job") live.beginItem(runId, itemId);
      await store.updateRunItem(itemId, { nextAttemptAt: null });
      const attemptId = await store.insertRunAttempt({
        itemId,
        runId,
        runbookId: step.runbookId,
        attempt,
        status: "running",
        startedAt: now(),
        finishedAt: null,
        exitCode: null,
        stdout: null,
        stderr: null,
        truncated: false,
        timedOut: false,
        error: null,
        checks: null,
        stopIf: null,
        why: null,
        result: null,
      });
      await store.persist(true);
      const checked = await checkOnce(runId, step, event, {
        since,
        memory,
        position,
        timeoutMs: attemptTimeout(
          event.timeoutMs ?? EVENT_LIMITS.timeoutMs,
          endsAt,
          Date.now(),
        ),
      });
      const stopped = checked.kind === "stopped";
      const why: AttemptWhy | null = record.interrupted
        ? "interrupted"
        : stopped || record.stoppedBy
          ? "stopped"
          : checked.kind === "connect"
            ? "connect"
            : checked.outcome.verdict === "pass"
              ? null
              : checked.outcome.verdict === "fail"
                ? "fail-state"
                : checked.outcome.timedOut
                  ? "timeout"
                  : "not-yet";
      const got: ProbeOutcome | null =
        checked.kind === "checked" ? checked.outcome : null;
      const error =
        why === "stopped"
          ? `stopped by ${record.stoppedBy ?? "a person"}`
          : why === "interrupted"
            ? record.interrupted
            : checked.kind === "connect"
              ? checked.message
              : (got?.error ?? null);
      const output = {
        exitCode: got?.exitCode ?? null,
        stdout: got ? hide(got.stdout) : null,
        stderr: got ? hide(got.stderr) : null,
        truncated: got?.truncated ?? false,
        timedOut: got?.timedOut ?? false,
      };
      await store.updateRunAttempt(attemptId, {
        ...output,
        status: why === null ? "passed" : "failed",
        finishedAt: now(),
        error: error === null ? null : hide(error),
        why,
        result: got?.result ?? null,
      });
      if (event.type !== "job" && got) {
        if (output.stdout) live.output(runId, "stdout", output.stdout);
        if (output.stderr) live.output(runId, "stderr", output.stderr);
      }
      await live.settle(runId);
      await store.updateRunItem(itemId, {
        ...output,
        // A job's item keeps its whole journal; the attempt, the new lines.
        ...(event.type === "job"
          ? { stdout: hide(memory.journal), stderr: output.stderr }
          : {}),
        result: got?.result ?? null,
      });
      if (why === null) {
        await store.updateRunItem(itemId, {
          status: "passed",
          finishedAt: now(),
        });
        await store.persist(true);
        live.endItem(runId);
        await audit(
          req,
          "runbooks_step_run",
          step,
          `${line}: ${event.type} check ${attempt} passed: ${got?.result ?? ""}`,
          true,
        );
        return { passed: true, reason: "check", error: null, slow: [] };
      }
      // What ends the item here, with its words; null: another check.
      let end: { error: string | null } | null = null;
      if (why === "stopped" || why === "interrupted" || why === "fail-state") {
        end = { error };
      } else if (attempt >= most) {
        end = {
          error: eventExhausted(event, attempt, "attempts", within, got),
        };
      }
      const delay = delayAfter(event, attempt);
      if (end === null && Date.now() + delay >= endsAt) {
        end = { error: eventExhausted(event, attempt, "time", within, got) };
      }
      if (end === null) {
        const waited = await between(runId, itemId, delay);
        if (waited.how === "now") {
          await audit(
            req,
            "runbooks_step_try_now",
            step,
            `${line}: check ${attempt + 1} started early by ${waited.by}`,
            true,
          );
        }
        if (waited.how !== "stopped") continue;
        end = {
          error: record.stoppedBy
            ? `stopped by ${record.stoppedBy}`
            : (record.interrupted ?? "stopped"),
        };
      }
      // A job that did not end yet: its unit stops with the item.
      if (why !== "fail-state") {
        await stopUnfinishedJob(step, event, memory, runId, position);
      }
      const reason: FailReason = record.interrupted
        ? "interrupted"
        : record.stoppedBy
          ? "stopped"
          : why === "connect" || why === "timeout"
            ? "exit"
            : "check";
      await store.updateRunItem(itemId, {
        status: "failed",
        finishedAt: now(),
        nextAttemptAt: null,
        error: end.error === null ? null : hide(end.error),
      });
      await store.persist(true);
      live.endItem(runId);
      await audit(
        req,
        "runbooks_step_run",
        step,
        `${line}: ${event.type}, ${attempt} check${attempt === 1 ? "" : "s"}, ${reason === "stopped" || reason === "interrupted" ? reason : why}${got ? `: ${got.result}` : ""}`,
        false,
      );
      return { passed: false, reason, error: end.error, slow: [] };
    }
  }

  /**
   * One check of an event on a connection of its own. Stop (and Termix
   * stopping) ends it at once. No connection, or an error the readers do
   * not know, is "connect": the wait goes on, as a wait item's does.
   */
  async function checkOnce(
    runId: number,
    step: StepRow,
    event: EventItemSpec,
    input: {
      since: number;
      memory: EventMemory;
      position: number;
      timeoutMs: number;
    },
  ): Promise<
    | { kind: "checked"; outcome: ProbeOutcome }
    | { kind: "connect"; message: string }
    | { kind: "stopped" }
  > {
    const record = live.get(runId)!;
    const controller = new AbortController();
    record.stop = () => controller.abort();
    if (record.stoppedBy || record.interrupted) controller.abort();
    let connection: { client: ProbeClient; dispose: () => void } | null = null;
    try {
      connection = await ctx.ssh.connect<ProbeClient>(step.hostId!, {
        purpose: "runbooks",
      });
      // What the host's SSH server says it is: a Windows host is then
      // refused the Linux events when a step is written (platforms.ts).
      kit.platforms.note(
        step.hostId!,
        readPlatform(connection.client._remoteVer),
      );
      if (controller.signal.aborted) throw new Stopped();
      const outcome = await probe({
        client: connection.client,
        item: event,
        workdir: step.workdir,
        since: input.since,
        runId,
        position: input.position,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
        memory: input.memory,
        cas: async () => trustedCas(await ctx.settings.get(HTTP_CA_SETTING)),
        fetch: ctx.fetch as unknown as (
          url: string,
          init: Record<string, unknown>,
        ) => Promise<Response>,
        onOutput: (text) => live.output(runId, "stdout", text),
      });
      return { kind: "checked", outcome };
    } catch (error) {
      if (error instanceof Stopped || controller.signal.aborted) {
        return { kind: "stopped" };
      }
      return {
        kind: "connect",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      record.stop = null;
      connection?.dispose();
    }
  }

  /**
   * Stops and unloads a job's unit when the item ends before the job did.
   * Best effort: a host that cannot be reached keeps it running, and the
   * item's words say the job ended without it.
   */
  async function stopUnfinishedJob(
    step: StepRow,
    event: EventItemSpec,
    memory: EventMemory,
    runId: number,
    position: number,
  ): Promise<void> {
    if (event.type !== "job" || memory.jobStarted === null) return;
    let connection: { client: ProbeClient; dispose: () => void } | null = null;
    try {
      connection = await ctx.ssh.connect<ProbeClient>(step.hostId!, {
        purpose: "runbooks",
      });
      await stopJob(connection.client, event, runId, position);
    } catch (error) {
      ctx.log.warn(
        `run ${runId} item ${position}: the job's unit could not be stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      connection?.dispose();
    }
  }

  /**
   * When the step started, in Unix seconds: its first item's start, which
   * a Continue carries from the run before. Log lines and unit ends before
   * it belong to an earlier run.
   */
  async function stepStart(runId: number, fallback: string): Promise<number> {
    const times = (await store.listRunItems({ runId }))
      .map((each) => (each.startedAt ? Date.parse(each.startedAt) : NaN))
      .filter((time) => !Number.isNaN(time));
    const first = times.length ? Math.min(...times) : Date.parse(fallback);
    return Math.floor(first / 1000);
  }

  /**
   * The wait between two attempts: a timer, with the next attempt's time
   * on the item so the page counts down. Try now ends it early; Stop, or
   * Termix stopping, ends the item.
   */
  async function between(
    runId: number,
    itemId: number,
    ms: number,
  ): Promise<{ how: "over" | "now" | "stopped"; by: string | null }> {
    const record = live.get(runId)!;
    await store.updateRunItem(itemId, { nextAttemptAt: after(ms) });
    await store.persist(true);
    let by: string | null = null;
    let written: () => void = () => {};
    const isWritten = new Promise<void>((resolve) => (written = resolve));
    const how = await new Promise<"over" | "now" | "stopped">((resolve) => {
      if (record.stoppedBy || record.interrupted) {
        resolve("stopped");
        return;
      }
      const timer = setTimeout(() => resolve("over"), ms);
      const end = (value: "now" | "stopped") => {
        clearTimeout(timer);
        resolve(value);
      };
      record.stop = () => end("stopped");
      record.tryNow = (person) => {
        by = person;
        end("now");
        return isWritten;
      };
    });
    record.stop = null;
    record.tryNow = null;
    await store.updateRunItem(itemId, { nextAttemptAt: null });
    written();
    return { how, by };
  }

  /**
   * Ends the run: done when every item passed (or failed with onFail
   * continue), failed at the item that stopped it otherwise. The run keeps
   * the items' output joined, so a later step's stdin or when rule reads
   * the step's output as before, and the captures of the items that passed.
   * One step-done or step-failed event, as for any run, however many
   * attempts its items made.
   */
  async function finish(
    runId: number,
    step: StepRow,
    target: SequenceTarget,
    failure: { position: number; end: ItemEnd } | null,
    slow: string[],
  ): Promise<void> {
    const items = await store.listRunItems({ runId });
    const stdout = capped(items.map((item) => item.stdout ?? "").join(""));
    const stderr = capped(items.map((item) => item.stderr ?? "").join(""));
    const ran = items.filter(
      (item) => item.type !== "delay" && item.status !== "waiting",
    );
    const last = ran[ran.length - 1];
    const stopping = failure
      ? items.find((item) => item.position === failure.position)
      : undefined;
    const captured: Record<string, string> = {};
    for (const item of items) {
      if (item.status === "passed") Object.assign(captured, item.captured);
    }
    const message = failure
      ? failure.end.reason === "stopped" || failure.end.reason === "interrupted"
        ? failure.end.error
        : `item ${failure.position} failed${failure.end.error ? `: ${failure.end.error}` : ""}`
      : null;
    const parts = { ...noErrorParts(message), slowCaptures: slow };
    const status = failure ? "failed" : "done";
    const at = now();
    await events.endStep(step, {
      status,
      reason: failure ? failure.end.reason : null,
      by: target.by,
      at,
      run: () =>
        store.updateRun(runId, {
          status,
          finishedAt: at,
          exitCode:
            (stopping && stopping.type !== "delay" ? stopping : last)
              ?.exitCode ?? null,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated:
            stdout.cut || stderr.cut || items.some((item) => item.truncated),
          timedOut: Boolean(stopping?.timedOut),
          inputs: [...(live.get(runId)?.inputs ?? [])],
          captured: status === "done" ? captured : {},
          checks: null,
          error: errorText(parts),
          errorParts: hasError(parts) ? parts : null,
        }),
      // A step replaced while its run was being written keeps "replaced".
      keepReplaced: true,
    });
  }

  return { start };
}

/** The most attempts of an item: the author's, never past the top limit. */
function maxAttempts(attempts: number | null): number {
  return Math.min(
    attempts ?? SCHEDULE_LIMITS.attempts,
    SCHEDULE_LIMITS.attempts,
  );
}

/**
 * The command an item's record keeps: a run or wait item's command, an
 * event's words for what it checks (phase 3), nothing for a delay.
 */
function itemCommand(
  item: SequenceItem,
  runId: number,
  position: number,
  hostName: string | null,
): string | null {
  if (item.type === "delay") return null;
  if (isEventItem(item)) return eventWhat(item, hostName, runId, position);
  return item.command;
}

/** The words of an event that made its last check without a pass. */
function eventExhausted(
  event: EventItemSpec,
  checks: number,
  reason: "attempts" | "time",
  withinSeconds: number,
  last: ProbeOutcome | null,
): string {
  const made = `${checks} check${checks === 1 ? "" : "s"}`;
  const what =
    event.type === "job"
      ? "the job did not finish"
      : "the state it waits for did not come";
  const read = last ? `; the last check read: ${last.result}` : "";
  return reason === "attempts"
    ? `${what} in ${made}, the most this item makes${read}`
    : `${what} within ${secondsWords(withinSeconds)} (${made})${read}${event.type === "job" ? "; its unit was stopped" : ""}`;
}
