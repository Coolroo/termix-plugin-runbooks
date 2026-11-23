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
import { judgeOutput } from "../checks/checks.js";
import type { FailReason } from "../agents/events.js";
import { stepLabel } from "../../shared/steps.js";
import { MIN_HIDDEN_CHARS } from "../../shared/limits.js";
import {
  withWorkdir,
  type DelayItemSpec,
  type ResolvedItem,
  type RunItemSpec,
} from "../../shared/sequence.js";
import type { RunItem } from "../../shared/sequence.js";
import { INTERACTIVE_PTY, streamExec, type ExecClient } from "./stream-exec.js";
import { createRedactor, redact, type SecretText } from "./redact.js";
import { cleanedCopies, LINE_END, MAX_OUTPUT_BYTES } from "./runner.js";
import { errorText, hasError, noErrorParts } from "./run-error.js";

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
    const itemIds: number[] = [];
    for (const [index, item] of sequence.entries()) {
      const carried: RunItem | undefined =
        index < from ? previous?.run.items?.[index] : undefined;
      if (carried) {
        // It passed in the run before: its record comes along, unchanged.
        const {
          id: _id,
          runId: _runId,
          lastOutputAt: _last,
          ...kept
        } = carried;
        itemIds.push(
          await store.insertRunItem({
            ...kept,
            runId,
            stepId: step.id,
            runbookId: step.runbookId,
            fromRunId: carried.fromRunId ?? previous!.run.id,
          }),
        );
        if (carried.status === "passed")
          Object.assign(values, carried.captured);
        continue;
      }
      const approved = target.items[index];
      itemIds.push(
        await store.insertRunItem({
          runId,
          stepId: step.id,
          runbookId: step.runbookId,
          position: index + 1,
          type: item.type,
          label: item.label,
          command:
            approved?.type === "run"
              ? approved.command
              : item.type === "run"
                ? item.command
                : null,
          seconds: item.type === "delay" ? item.seconds : null,
          reason: item.type === "delay" ? item.reason : null,
          onFail: item.type === "run" ? item.onFail : "stop",
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
    // the answer is sent: every item, delay and access check.
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
        if (index > state.from) {
          const access = await ctx.hosts
            .checkAccess(target.hostId, "connect")
            .catch(() => ({ hasAccess: false }));
          if (!access.hasAccess) {
            const at = now();
            await store.updateRunItem(itemId, {
              status: "failed",
              startedAt: at,
              finishedAt: at,
              error: NO_ACCESS,
            });
            await audit(
              req,
              "runbooks_step_run",
              step,
              `${where(step, target, position)}: not started, ${target.by} can no longer connect to the host`,
              false,
            );
            failure = {
              position,
              end: {
                passed: false,
                reason: "exit",
                error: NO_ACCESS,
                slow: [],
              },
            };
            break;
          }
        }
        const end =
          item.type === "delay"
            ? await runDelay(req, runId, step, target, item, itemId, position)
            : await runCommand(req, runId, step, target, item, itemId, {
                position,
                values: state.values,
                hidden: state.hidden,
                typed,
              });
        slow.push(...end.slow);
        if (end.passed) continue;
        if (
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
   * A run item: its command with the values so far (captures of earlier
   * items too), in the step's workdir, over a connection of its own. Its
   * checks and captures read its own output, secrets hidden.
   */
  async function runCommand(
    req: Request,
    runId: number,
    step: StepRow,
    target: SequenceTarget,
    item: RunItemSpec,
    itemId: number,
    context: {
      position: number;
      values: Values;
      hidden: SecretText[];
      typed: SecretText[];
    },
  ): Promise<ItemEnd> {
    const record = live.get(runId)!;
    const { position, values, typed } = context;
    const resolved = resolveItem(item, position, values, new Set());
    if (resolved.type !== "run") throw new Error("not a run item");
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
    // A pty's output is cleaned, so a value with control characters shows
    // there cleaned: that copy is hidden too (BUG-010).
    const copies = (list: SecretText[]) =>
      item.interactive ? cleanedCopies(list) : [];
    const known = [...context.hidden, ...typed];
    const redactors = {
      stdout: createRedactor([...known, ...copies(known)]),
      stderr: createRedactor([...known, ...copies(known)]),
    };
    const hiddenAll = () => {
      const all = [...context.hidden, ...typed];
      return [...all, ...copies(all)];
    };
    const line = where(step, target, position);
    let connection: { client: ExecClient; dispose: () => void } | null = null;
    let result: Awaited<ReturnType<typeof streamExec>["result"]>;
    try {
      connection = await ctx.ssh.connect<ExecClient>(target.hostId, {
        purpose: "runbooks",
      });
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
          withWorkdir(resolved.command, step.workdir),
          {
            timeoutMs: item.timeoutMs ?? LIMITS.timeoutDefault,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            onOutput: (stream, text) =>
              live.output(runId, stream, redactors[stream].push(text)),
            onTruncate: () => live.truncated(runId),
            pty: item.interactive ? INTERACTIVE_PTY : undefined,
          },
        );
        record.stop = handle.stop;
        record.input = {
          open: handle.inputOpen,
          send: (sent, hiddenText) => {
            const value = sent.replace(LINE_END, "");
            // Enter is CR in a terminal (BUG-010).
            const text =
              item.interactive && value !== sent ? `${value}\r` : sent;
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await live.settle(runId);
      const partial = live.get(runId)!;
      const why = record.stoppedBy
        ? `stopped by ${record.stoppedBy}`
        : (record.interrupted ?? message);
      await store.updateRunItem(itemId, {
        status: "failed",
        finishedAt: now(),
        stdout: redact(partial.stdout, hiddenAll()),
        stderr: redact(partial.stderr, hiddenAll()),
        truncated: partial.truncated,
        error: redact(why, hiddenAll()),
      });
      live.endItem(runId);
      connection?.dispose();
      await audit(req, "runbooks_step_run", step, line, false, message);
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
    connection.dispose();
    await live.settle(runId);
    live.endItem(runId);
    const stopped = result.stopped || Boolean(record.stoppedBy);
    const exited =
      result.code === 0 && !result.timedOut && !stopped && !record.interrupted;
    // Secrets are found first, so the checks and captures see the output
    // with them hidden, as the person does (1.4.1).
    const judged = judgeOutput(
      { checks: resolved.checks, captures: item.captures, secretCaptures: [] },
      exited ? "done" : "failed",
      {
        mode: "exec",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        pastedOutput: null,
      },
      result.stdout,
      hiddenAll(),
    );
    const passed = judged.final === "done";
    // Termix stopping ends the item as interrupted, not as a person's stop.
    const error =
      record.interrupted ??
      (stopped ? `stopped by ${record.stoppedBy ?? "a person"}` : null);
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
      reason: record.interrupted
        ? "interrupted"
        : stopped
          ? "stopped"
          : exited
            ? "check"
            : "exit",
      error,
      slow: passed ? judged.slowCaptures : [],
    };
  }

  /**
   * Ends the run: done when every item passed (or failed with onFail
   * continue), failed at the item that stopped it otherwise. The run keeps
   * the items' output joined, so a later step's stdin or when rule reads
   * the step's output as before, and the captures of the items that passed.
   * One step-done or step-failed event, as for any run.
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
      (item) => item.type === "run" && item.status !== "waiting",
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
            (stopping?.type === "run" ? stopping : last)?.exitCode ?? null,
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
