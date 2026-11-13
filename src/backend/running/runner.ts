/**
 * Running a step's command and ending its run: the input a Run writes, the
 * secrets its output hides, the run over SSH, and the checks, captures and
 * events at its end.
 */

import type { Request } from "express";
import { InputError } from "../core/errors.js";
import type { RunRow, StepRow } from "../runbooks/store/types.js";
import { now } from "../runbooks/store/store.js";
import type { PersonKit } from "../runbooks/person-kit.js";
import { LIMITS } from "../runbooks/parse.js";
import type { RunbookBundle } from "../runbooks/view.js";
import { secretSpec } from "../secrets/secret-view.js";
import { SECRET_TTL_MS } from "../secrets/secrets.js";
import { valuesObject } from "../values/effective.js";
import { judgeOutput, type CheckedRun } from "../checks/checks.js";
import { SYSTEM, type FailReason } from "../agents/events.js";
import { stepLabel } from "../../shared/steps.js";
import { streamExec, type ExecClient } from "./stream-exec.js";
import { createRedactor, redact, type SecretText } from "./redact.js";
import {
  secretLabel,
  stdinText,
  type RunStdin,
  type StdinSource,
} from "./stdin.js";

export const MAX_OUTPUT_BYTES = 262_144;

/** Holds nothing of its own: every run shares the kit's state. */
export function createRunner(kit: PersonKit) {
  const { ctx, store, live, secrets, events, audit, storedNote } = kit;

  /**
   * The bytes a Run writes to the command's standard input, read as the
   * person who runs it, with what the run keeps of them (the source and the
   * size) and the secret it read, if any. Refused with 409 when there is
   * nothing to give.
   */
  async function readStdin(
    step: StepRow,
    bundle: RunbookBundle,
    source: StdinSource,
  ): Promise<{ bytes: Buffer; record: RunStdin; secret: SecretText | null }> {
    const found = stdinText(
      source,
      step,
      bundle.steps,
      bundle.runsByStep,
      valuesObject(bundle.values),
    );
    if (found && "problem" in found) {
      throw new InputError(found.problem, 409, { code: "stdin-missing" });
    }
    let text: string;
    let secret: SecretText | null = null;
    if (found) {
      text = found.text;
    } else if (source.from === "secret") {
      const name = secretLabel(source)!;
      const value = await secrets.read(step.runbookId, source);
      if (value === null || value === "") {
        throw new InputError(
          `secret ${name} is not there: it was never captured, it expired or it was deleted`,
          409,
          { code: "secret-missing", secret: name },
        );
      }
      text = `${value}\n`;
      secret = { name, value };
    } else {
      throw new InputError("this step has no input", 409, {
        code: "stdin-missing",
      });
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_OUTPUT_BYTES) {
      throw new InputError(
        `the input is ${Math.ceil(bytes.length / 1024)} KB; at most ${MAX_OUTPUT_BYTES / 1024} KB`,
        409,
        { code: "stdin-missing" },
      );
    }
    return { bytes, record: { ...source, bytes: bytes.length }, secret };
  }

  /**
   * The values the runbook's secret steps made or saved (1.4.2), read back
   * as the person, so every later output hides them as it hides a secret a
   * step reads. A value the person cannot read, or an app field (never read
   * back), is not hidden this way.
   */
  async function madeSecretTexts(
    step: StepRow,
    bundle: RunbookBundle,
  ): Promise<SecretText[]> {
    const out: SecretText[] = [];
    if (!secrets.available()) return out;
    for (const other of bundle.steps) {
      const spec = secretSpec(other);
      if (!spec || other.id === step.id || spec.store.to === "app") continue;
      const made = (bundle.runsByStep.get(other.id) ?? []).some(
        (run) => run.mode === "secret" && run.status === "done",
      );
      if (!made) continue;
      try {
        const value = await secrets.read(
          step.runbookId,
          spec.store.to === "runbook"
            ? { name: spec.name }
            : { library: spec.store.library },
        );
        if (value) out.push({ name: spec.name, value });
      } catch {
        // Not readable for this person now: nothing to hide it with.
      }
    }
    return out;
  }

  /**
   * Finishes a run: tests the step's checks against the full output when
   * `checked` is given, sets the step's status and stores the captures. A
   * failed check fails the run and the step even on exit code 0; captures
   * are kept only from a run that ends done. Returns the outcome.
   */
  async function finishRun(
    runId: number,
    step: StepRow,
    outcome: "done" | "failed",
    output: string | null,
    patch: Partial<RunRow>,
    options: {
      checked?: CheckedRun;
      /** Secrets the step read: replaced in everything the run keeps. */
      used?: SecretText[];
      /** Secrets earlier secret steps made (1.4.2): replaced, not "read". */
      hidden?: SecretText[];
      /** Who ended it, for the events. */
      by?: string;
      /** Why it failed, when `outcome` is failed. */
      reason?: FailReason;
    } = {},
  ): Promise<{ final: "done" | "failed"; stored: string[] }> {
    const used = options.used ?? [];
    // Secret values found in the output are replaced whatever the outcome;
    // they are stored only from a run that ends done. They are found first,
    // so the checks see the output with its secrets hidden (1.4.1).
    const judged = judgeOutput(step, outcome, options.checked ?? null, output, [
      ...used,
      ...(options.hidden ?? []),
    ]);
    const { found, hide, results } = judged;
    let final = judged.final;
    const problems: string[] = [];
    const stored: Array<{ name: string; expiresAt: string }> = [];
    if (final === "done" && step.secretCaptures.length > 0) {
      if (found.missing.length > 0) {
        final = "failed";
        problems.push(
          ...found.missing.map((name) => `secret ${name}: no match`),
        );
      } else {
        const expiresAt = new Date(Date.now() + SECRET_TTL_MS).toISOString();
        for (const capture of step.secretCaptures) {
          try {
            await secrets.putCaptured(
              step.runbookId,
              capture.name,
              found.values[capture.name],
              expiresAt,
            );
            stored.push({ name: capture.name, expiresAt });
          } catch (error) {
            final = "failed";
            problems.push(
              `secret ${capture.name}: could not be stored: ${
                error instanceof Error ? error.message : "failed"
              }`,
            );
            break;
          }
        }
        if (final === "failed") {
          // A step that failed leaves no secret for a later step.
          for (const secret of stored.splice(0)) {
            await secrets
              .removeCaptured(step.runbookId, secret.name)
              .catch(() => false);
          }
        }
      }
    }
    const errors = [
      patch.error,
      ...problems,
      ...(final === "done" ? judged.captureErrors : []),
    ]
      .filter(Boolean)
      .join("; ");
    const at = now();
    const kept = (text: string | null | undefined) =>
      text === undefined ? undefined : redact(text, hide);
    const usedNames = used.map((secret) => secret.name);
    const reason: FailReason | null =
      final === "done"
        ? null
        : outcome === "failed"
          ? (options.reason ?? "exit")
          : results && !results.every((check) => check.ok)
            ? "check"
            : "secret";
    const by = options.by ?? ctx.currentActor() ?? SYSTEM;
    await events.endStep(step, {
      status: final,
      reason,
      by,
      at,
      run: () =>
        store.updateRun(runId, {
          ...patch,
          stdout: kept(patch.stdout),
          stderr: kept(patch.stderr),
          pastedOutput: kept(patch.pastedOutput),
          status: final,
          finishedAt: at,
          captured: final === "done" ? judged.captured : {},
          checks: results,
          error: errors ? redact(errors, hide) : null,
          ...(usedNames.length || stored.length
            ? { secrets: { used: usedNames, captured: stored } }
            : {}),
        }),
      // A step replaced while its run was being written keeps "replaced".
      keepReplaced: true,
      touch: stored.length ? { secretsStoredAt: at } : {},
    });
    return { final, stored: stored.map((secret) => secret.name) };
  }

  /**
   * Runs the command over a connection of its own, through core's connect
   * pipeline (access check, stored login, host key check, audit), hands the
   * output to the live buffer as it arrives, and finishes the run.
   */
  async function execute(
    req: Request,
    runId: number,
    step: StepRow,
    target: {
      /** The person who pressed Run. */
      by: string;
      hostId: number;
      command: string;
      /** Written to the command's standard input, then ended. */
      stdin?: Buffer;
      /** Secrets the step reads: replaced in its output. */
      used: SecretText[];
      /** Secrets earlier secret steps made (1.4.2): replaced in its output. */
      hidden?: SecretText[];
    },
    release: () => void,
  ): Promise<void> {
    const record = live.get(runId)!;
    const where = `runbook ${step.runbookId} step ${stepLabel(step)} on host ${target.hostId}${
      target.used.length
        ? `, read secret ${target.used.map((secret) => secret.name).join(", ")}`
        : ""
    }`;
    // A value split across two pieces of output is still replaced.
    const hide = [...target.used, ...(target.hidden ?? [])];
    const redactors = {
      stdout: createRedactor(hide),
      stderr: createRedactor(hide),
    };
    // A secret this step captures is known only once the output is
    // complete, so its output is not shown or written before the end.
    const held = step.secretCaptures.length > 0;
    record.held = held;
    const raw = { stdout: "", stderr: "" };
    let connection: { client: ExecClient; dispose: () => void } | null = null;
    try {
      let result: Awaited<ReturnType<typeof streamExec>["result"]>;
      try {
        connection = await ctx.ssh.connect<ExecClient>(target.hostId, {
          purpose: "runbooks",
        });
        if (record.stoppedBy) {
          result = {
            stdout: "",
            stderr: "",
            code: null,
            truncated: false,
            timedOut: false,
            stopped: true,
          };
        } else {
          const handle = streamExec(connection.client, target.command, {
            timeoutMs: step.timeoutMs ?? LIMITS.timeoutDefault,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            onOutput: (stream, text) => {
              if (held) {
                raw[stream] += text;
                live.heard(runId);
              } else {
                live.output(runId, stream, redactors[stream].push(text));
              }
            },
            onTruncate: () => live.truncated(runId),
            stdin: target.stdin,
          });
          record.stop = handle.stop;
          result = await handle.result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await live.settle(runId);
        const partial = live.get(runId)!;
        await finishRun(
          runId,
          step,
          "failed",
          held ? raw.stdout : null,
          {
            stdout: held ? raw.stdout : partial.stdout,
            stderr: held ? raw.stderr : partial.stderr,
            truncated: partial.truncated,
            error: record.stoppedBy
              ? `stopped by ${record.stoppedBy}`
              : (record.interrupted ?? message),
          },
          {
            used: target.used,
            hidden: target.hidden,
            by: target.by,
            reason: record.stoppedBy
              ? "stopped"
              : record.interrupted
                ? "interrupted"
                : "exit",
          },
        );
        await audit(req, "runbooks_step_run", step, where, false, message);
        return;
      }
      await live.settle(runId);
      const stopped = result.stopped || Boolean(record.stoppedBy);
      const exited =
        result.code === 0 &&
        !result.timedOut &&
        !stopped &&
        !record.interrupted;
      const outcome = await finishRun(
        runId,
        step,
        exited ? "done" : "failed",
        result.stdout,
        {
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          timedOut: result.timedOut,
          error: stopped
            ? `stopped by ${record.stoppedBy ?? "a person"}`
            : record.interrupted,
        },
        {
          checked: {
            mode: "exec",
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            pastedOutput: null,
          },
          used: target.used,
          hidden: target.hidden,
          by: target.by,
          reason: stopped
            ? "stopped"
            : record.interrupted
              ? "interrupted"
              : "exit",
        },
      );
      const ok = outcome.final === "done";
      await audit(
        req,
        "runbooks_step_run",
        step,
        `${where}: ${
          stopped
            ? "stopped"
            : result.timedOut
              ? "timed out"
              : `exit ${result.code ?? "none"}${
                  exited && !ok ? ", checks failed" : ""
                }`
        }${storedNote(outcome.stored)}`,
        ok,
      );
    } catch (error) {
      // Most likely the database went away because Termix is stopping; the
      // sweep on the next start finishes the run.
      ctx.log.error(
        `run ${runId} could not be finished`,
        error instanceof Error ? error : undefined,
      );
    } finally {
      connection?.dispose();
      live.remove(runId);
      release();
    }
  }

  return { readStdin, madeSecretTexts, finishRun, execute };
}
