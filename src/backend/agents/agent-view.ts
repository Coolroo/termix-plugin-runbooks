/**
 * The runbook as an agent sees it: the output of steps hidden from agents,
 * and values captured from them, are replaced.
 */

import { resolve, type Values } from "../values/values.js";
import { agentCommand, resolveItem, resolveText } from "../values/effective.js";
import { checkDetail, checkWhy } from "../checks/checks.js";
import { describeCheck, fillChecks } from "../../shared/checks.js";
import type { RunRow, StepRow } from "../runbooks/store/types.js";
import type { ShownRun } from "../running/live.js";
import { stepStdin } from "../running/stdin.js";
import { errorText } from "../running/run-error.js";
import { waitState } from "../running/wait.js";
import { showAsk, showGenerate } from "../../shared/secret-steps.js";
import type {
  EffectiveValue,
  RunStdin,
  StdinSource,
  StepWait,
} from "../../shared/api.js";
import {
  amendmentView,
  openPath,
  runbookSummary,
  type HostNames,
  type RunbookBundle,
} from "../runbooks/view.js";
import { secretStates } from "../secrets/secret-view.js";
import { agentMask, HIDDEN, type AgentMask } from "./agent-mask.js";
import {
  notNeededIds,
  showWhen,
  type StepCondition,
} from "../conditions/conditions.js";
import { stepChoice } from "../decisions/decisions.js";
import { nextStep } from "../runbooks/view.js";
import {
  isCommandItem,
  isEventItem,
  itemPlan,
  itemScheduleWords,
  sequenceText,
  withWorkdir,
  type AttemptState,
  type CommandItemSpec,
  type RunAttempt,
  type RunItem,
  type SequenceItem,
} from "../../shared/sequence.js";
import { eventWhat, type EventItemSpec } from "../../shared/events.js";
import type { Check, CheckResult } from "../../shared/checks.js";

/**
 * The runbook as an agent sees it: hidden steps' output, and values captured
 * from them, are replaced. The when rules read the same (agentMask,
 * BUG-010). A run's command and check words are built again from the step
 * with the values agents see (BUG-011), never masked after the fact.
 */
export function agentView(bundle: RunbookBundle, hostName: HostNames) {
  const { runbook, steps, runsByStep } = bundle;
  const masked = agentMask(steps, bundle.runs);
  const values = agentValues(bundle, masked);
  const notNeeded = notNeededIds(bundle.conditions);
  const next = nextStep(steps, notNeeded);
  const valueMap = valuesOf(values);
  return {
    ...runbookSummary(runbook, steps, notNeeded),
    openPath: openPath(runbook.id),
    owner: runbook.owner,
    summary: runbook.summary,
    values: runbook.values,
    effectiveValues: values,
    secrets: secretStates(bundle),
    nextStepId: next?.id ?? null,
    steps: steps.map((step) => {
      const stepRuns = runsByStep.get(step.id) ?? [];
      // 1.4.3: the text as the person sees it, with values from hidden
      // steps replaced, as in the runs.
      const text = resolveText(step, valueMap);
      return {
        id: step.id,
        position: step.position,
        suffix: step.suffix,
        ...amendmentView(step, steps),
        title: step.title,
        owner: step.owner,
        where: step.where,
        body: step.body,
        hostId: step.hostId,
        hostName: step.hostId === null ? null : hostName(step.hostId),
        command: step.command,
        // 1.4.10: a sequence's items as written, and its workdir.
        sequence: step.sequence,
        workdir: step.workdir,
        // Phase 2: each wait or retried item's planned attempts, before Run.
        schedules: agentSchedules(step),
        // Phase 2: where the attempts of the item that runs now are.
        attempt: attemptState(stepRuns[0]),
        missing: agentMissing(step, valueMap),
        expect: step.expect,
        // Filled with masked values already. Masked again, the agent's own
        // text would show whether it equals a hidden value (BUG-010).
        resolvedBody: text.resolvedBody,
        resolvedExpect: text.resolvedExpect,
        resolvedWhere: text.resolvedWhere,
        textMissing: text.textMissing,
        captures: step.captures,
        secretCaptures: step.secretCaptures,
        // A secret step's field (1.4.2): never a value, which no agent gets.
        generate: step.generate ? showGenerate(step.generate) : null,
        ask: step.ask ? showAsk(step.ask) : null,
        checks: step.checks,
        hideOutputFromAgents: step.hideOutputFromAgents,
        status: step.status,
        skipReason: step.skipReason,
        ownerNote: step.ownerNote,
        timeoutMs: step.timeoutMs,
        waitAfterPreviousSeconds: step.waitAfterPreviousSeconds,
        waitReason: step.waitReason,
        runIn: step.runIn,
        runInReason: step.runInReason,
        interactive: step.interactive,
        // 1.4.6: the rule by step numbers, and what it says now.
        when: step.when ? showWhen(step.when, steps) : null,
        condition: agentCondition(bundle.conditions.get(step.id)),
        // 1.4.6: a Decision step's options and what the person chose.
        decision: step.decision,
        choice: stepChoice(step, runsByStep),
        // 1.4.7: a VM step's action through HAW, as the agent wrote it.
        vm: step.vm,
        waitUntil: agentWaitUntil(
          waitState(step, steps, runsByStep, notNeeded),
        ),
        stdin: stepStdin(step, steps),
        revision: step.revision,
        editable: stepRuns.length === 0,
        runs: stepRuns.map((run) => agentRun(run, step, bundle, masked)),
      };
    }),
  };
}

/**
 * A rule's state for agents (BUG-008). Its words carry filled values, as a
 * check's do, and a rule reads values as agents do (BUG-010), so they are
 * masked already. Masked again, a rule's own text would show whether it
 * equals a hidden value: the words go as they are.
 */
function agentCondition(
  condition: StepCondition | undefined,
): StepCondition | null {
  if (!condition) return null;
  return {
    state: condition.state,
    rule: condition.rule,
    reason: condition.reason,
    notNeeded: condition.notNeeded,
  };
}

/** The end of a wait that is running now, for agents; null otherwise. */
function agentWaitUntil(wait: StepWait | null): string | null {
  return wait && wait.remainingMs > 0 ? wait.until : null;
}

function agentRun(
  run: ShownRun,
  step: StepRow,
  bundle: RunbookBundle,
  masked: AgentMask,
) {
  const hidden = masked.hiddenSteps.has(run.stepId);
  const output = masked.run(run);
  const built = builtRun(run, step, bundle, masked, hidden);
  return {
    id: run.id,
    stepId: run.stepId,
    mode: run.mode,
    status: run.status,
    hostId: run.hostId,
    command: built.command,
    userId: run.userId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    pastedOutput: output.pastedOutput,
    // Where the person said the text came from (1.4.9): pasted, or read
    // from the terminal. The page says so; it proves nothing. On a hidden
    // step it would tell whether the command printed anything, and whether
    // the person changed it: that is its output too (BUG-019).
    outputSource: hidden ? null : run.outputSource,
    // How much a hidden step printed, and when, is its output too (BUG-011).
    truncated: hidden ? false : run.truncated,
    timedOut: run.timedOut,
    error: agentError(run, masked, hidden),
    running: run.running,
    lastOutputAt: hidden ? null : run.lastOutputAt,
    checks: built.checks,
    // Where its standard input came from and its size, never the input.
    stdin: agentStdin(run.stdin, hidden),
    // Secret names it read or stored, never a value.
    secrets: run.secrets,
    // A manual run's note (a step with no command marked by hand).
    note: run.note,
    // Seconds of the wait timer left when the person started it anyway.
    startedEarlySeconds: run.startedEarlySeconds,
    // How many times a person typed into it (1.4.6): never what, or how much.
    inputCount: run.inputs.length,
    // BUG-010: a visible step's capture that holds a hidden value too.
    captured: output.captured,
    // 1.4.10: a sequence's items, each hidden as the run is.
    ...(run.items
      ? { items: agentItems(run, step, bundle, masked, hidden) }
      : {}),
  };
}

/**
 * Names a step's command, checks or run items use that have no value, with
 * the values agents see. A name an earlier item of the sequence captures
 * is filled by the run, so it is not missing (1.4.10).
 */
function agentMissing(step: StepRow, values: Values): string[] {
  if (!step.sequence) return agentCommand(step, values).missing;
  const earlier = new Set<string>();
  const missing = new Set<string>();
  for (const [index, item] of step.sequence.entries()) {
    for (const name of resolveItem(item, index + 1, values, earlier).missing) {
      missing.add(name);
    }
    if (isCommandItem(item)) {
      for (const capture of item.captures) earlier.add(capture.name);
    }
  }
  return [...missing];
}

/**
 * Check results as agents read them (BUG-011): the words built again from
 * the checks as written, filled with the values agents saw; a result that
 * does not fit the checks shows no words. A hidden step's failed check
 * says only that it failed.
 */
function agentChecks(
  results: CheckResult[] | null,
  checks: readonly Check[],
  values: Values,
  shown: { terminal: boolean; exitCode: number | null },
  hidden: boolean,
): CheckResult[] | null {
  if (!results) return null;
  if (results.length !== checks.length) {
    return results.map((result) => ({
      label: HIDDEN,
      ok: result.ok,
      detail: HIDDEN,
    }));
  }
  const filled = fillChecks(checks, values).checks;
  return results.map((result, index) => {
    const check = filled[index];
    const why = hidden ? null : checkWhy(checks[index], result);
    return {
      label: check.label ?? describeCheck(check),
      ok: result.ok,
      detail: checkDetail(check, result.ok, shown, why),
    };
  });
}

/**
 * A sequence run's items as agents read them (1.4.10), hidden as the run
 * is (BUG-011): a hidden step's output, captures, error and size read
 * "[hidden by owner]" or nothing. Each run item's command and check words
 * are built again from the item as written, with the values agents saw
 * when the run started and the earlier items' captures as agents read
 * them, never masked after the fact.
 */
function agentItems(
  run: ShownRun,
  step: StepRow,
  bundle: RunbookBundle,
  masked: AgentMask,
  hidden: boolean,
) {
  const values = valuesOf(agentValues(bundle, masked, run.id));
  const sequence: ReadonlyArray<SequenceItem | undefined> = step.sequence ?? [];
  return (run.items ?? []).map((item: RunItem) => {
    const spec = sequence[item.position - 1];
    // A run or a wait item (phase 2): both run a command.
    const runSpec = spec && isCommandItem(spec) ? spec : null;
    // Phase 3: an event says what it checks, built again from the item.
    const eventSpec = spec && isEventItem(spec) ? spec : null;
    const command =
      item.command === null
        ? null
        : runSpec
          ? resolve(runSpec.command, values).text
          : eventSpec
            ? eventWhat(
                resolveItem(
                  eventSpec,
                  item.position,
                  values,
                  new Set(),
                ) as EventItemSpec,
                null,
                item.fromRunId ?? run.id,
                item.position,
              )
            : HIDDEN;
    const checks = agentChecks(
      item.checks,
      runSpec?.checks ?? [],
      values,
      { terminal: false, exitCode: item.exitCode },
      hidden,
    );
    const attempts = item.attempts
      ? item.attempts.map((attempt) =>
          agentAttempt(attempt, runSpec, values, masked, hidden),
        )
      : undefined;
    const captured = hidden
      ? item.status === "passed"
        ? Object.fromEntries(
            (runSpec?.captures ?? []).map((capture) => [capture.name, HIDDEN]),
          )
        : {}
      : Object.fromEntries(
          Object.entries(item.captured).map(([name, value]) => [
            name,
            masked.text(value)!,
          ]),
        );
    // Later items read this item's captures as agents read them.
    if (item.status === "passed") Object.assign(values, captured);
    const output = (text: string | null) =>
      text === null ? null : hidden ? HIDDEN : masked.text(text);
    return {
      id: item.id,
      position: item.position,
      type: item.type,
      label: item.label,
      command,
      seconds: item.seconds,
      reason: item.reason,
      onFail: item.onFail,
      status: item.status,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      plannedEndAt: item.plannedEndAt,
      exitCode: item.exitCode,
      stdout: output(item.stdout),
      stderr: output(item.stderr),
      truncated: hidden ? false : item.truncated,
      timedOut: item.timedOut,
      error: hidden
        ? item.status === "failed"
          ? HIDDEN
          : null
        : masked.text(item.error),
      checks,
      captured,
      skippedBy: item.skippedBy,
      fromRunId: item.fromRunId,
      lastOutputAt: hidden ? null : (item.lastOutputAt ?? null),
      // Phase 2: how many attempts and when are visible on a hidden step
      // too: the agent's own checks tell pass or fail already.
      maxAttempts: item.maxAttempts,
      endsBy: item.endsBy,
      nextAttemptAt: item.nextAttemptAt,
      // Phase 3: the state an event read, in fixed words ("healthy",
      // "HTTP 503"), visible on a hidden step as an exit code is.
      result: item.result,
      ...(attempts ? { attempts } : {}),
    };
  });
}

/**
 * One attempt of a wait or retried item as agents read it (phase 2),
 * hidden as its item is: on a hidden step its output and error read
 * "[hidden by owner]" or nothing, and it shows no size. Its number, times,
 * exit code, whether each check passed or each stopIf check matched, and
 * why it did not pass stay visible, as an item's status and exit code do.
 */
function agentAttempt(
  attempt: RunAttempt,
  spec: CommandItemSpec | null,
  values: Values,
  masked: AgentMask,
  hidden: boolean,
) {
  const shown = { terminal: false, exitCode: attempt.exitCode };
  const output = (text: string | null) =>
    text === null ? null : hidden ? HIDDEN : masked.text(text);
  return {
    attempt: attempt.attempt,
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    exitCode: attempt.exitCode,
    stdout: output(attempt.stdout),
    stderr: output(attempt.stderr),
    truncated: hidden ? false : attempt.truncated,
    timedOut: attempt.timedOut,
    error: hidden
      ? attempt.status === "failed"
        ? HIDDEN
        : null
      : masked.text(attempt.error),
    checks: agentChecks(
      attempt.checks,
      spec?.checks ?? [],
      values,
      shown,
      hidden,
    ),
    stopIf: agentChecks(
      attempt.stopIf,
      spec?.type === "wait" ? spec.stopIf : [],
      values,
      shown,
      hidden,
    ),
    why: attempt.why,
    result: attempt.result,
  };
}

/**
 * The planned attempts of each wait or retried item (phase 2), before Run:
 * {item, attempts, maxSeconds, text}, such as "up to 120 attempts, every
 * 30 s, at most 1 h". Empty for a step with none.
 */
function agentSchedules(step: StepRow) {
  return (step.sequence ?? []).flatMap((item, index) => {
    const plan = itemPlan(item);
    const text = itemScheduleWords(item);
    return plan && text
      ? [
          {
            item: index + 1,
            attempts: plan.attempts,
            maxSeconds: plan.maxSeconds,
            text,
          },
        ]
      : [];
  });
}

/**
 * Where the attempts of the item that runs now are (phase 2): {item,
 * attempt, of, nextAt, endsBy}, from the step's latest run while it runs;
 * null otherwise.
 */
export function attemptState(run: ShownRun | undefined): AttemptState | null {
  if (!run?.running || !run.items) return null;
  const item = run.items.find(
    (each) => each.status === "running" && each.maxAttempts !== null,
  );
  if (!item) return null;
  return {
    item: item.position,
    attempt: item.attempts?.length ?? 0,
    of: item.maxAttempts!,
    nextAt: item.nextAttemptAt,
    endsBy: item.endsBy,
  };
}

/**
 * A run's command and check results as agents read them (BUG-011): the
 * step's command and checks filled with the values agents saw when the run
 * started. Never the resolved text with hidden values masked: a mask there
 * would show whether text an agent wrote equals a hidden value. An agent
 * run keeps the step's command as written; Termix filled nothing in it.
 */
function builtRun(
  run: ShownRun,
  step: StepRow,
  bundle: RunbookBundle,
  masked: AgentMask,
  hidden: boolean,
): { command: string; checks: ShownRun["checks"] } {
  const values = valuesOf(agentValues(bundle, masked, run.id));
  const command = builtCommand(run, step, values);
  // One result per check of the step, in order; a run whose results do
  // not fit the step (none known) shows no words of them. A hidden step's
  // failed check says only that it failed: why it failed (a value not
  // captured, a slow pattern) reads its output.
  const shown = { terminal: run.mode !== "exec", exitCode: run.exitCode };
  return {
    command,
    checks: agentChecks(run.checks, step.checks, values, shown, hidden),
  };
}

/**
 * A run's command built again with the values agents saw: the step's
 * command in its workdir, or a sequence's whole text (1.4.10), whose items
 * that an earlier item fills keep {{name}} as written.
 */
function builtCommand(run: ShownRun, step: StepRow, values: Values): string {
  if (run.command === "" || run.mode === "agent") return run.command;
  if (step.sequence && run.items) {
    const earlier = new Set<string>();
    const items = step.sequence.map((item, index) => {
      const {
        missing: _missing,
        later: _later,
        position: _position,
        ...built
      } = resolveItem(item, index + 1, values, earlier);
      if (isCommandItem(item)) {
        for (const capture of item.captures) earlier.add(capture.name);
      }
      return built as SequenceItem;
    });
    return sequenceText(items, step.workdir);
  }
  if (step.command === null) return run.command;
  const filled = resolve(step.command, values).text;
  // Only a step Termix runs on a host has a workdir (Run and Send).
  return withWorkdir(filled, step.workdir);
}

/**
 * A run's error for agents (BUG-014). A hidden step's run says only that
 * it failed: a slow capture or a secret with no match reads its output. A
 * visible step's error is built from its parts, with Termix's words masked
 * and the names the author wrote as they are. A run from before 1.4.6 has
 * no parts and keeps its masked text.
 */
function agentError(
  run: ShownRun,
  masked: AgentMask,
  hidden: boolean,
): string | null {
  if (hidden) return run.status === "failed" ? HIDDEN : null;
  const parts = run.errorParts;
  if (!parts) return masked.text(run.error);
  return errorText({
    ...parts,
    message: masked.text(parts.message),
    secretNotStored: parts.secretNotStored && {
      name: parts.secretNotStored.name,
      why: masked.text(parts.secretNotStored.why)!,
    },
  });
}

/**
 * A run's standard input for agents: its source, and its size only when
 * the size says nothing hidden. A hidden step's input, or a secret, shows
 * no size (BUG-011): a size is a changed form of the input.
 */
function agentStdin(
  stdin: RunStdin | null,
  hidden: boolean,
): RunStdin | StdinSource | null {
  if (!stdin) return null;
  if (!hidden && stdin.from !== "secret") return stdin;
  const { bytes, ...source } = stdin;
  return source;
}

function valuesOf(entries: EffectiveValue[]): Values {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

/**
 * Effective values as agents read them: those captured from hidden steps
 * replaced, and hidden values replaced in other captures (BUG-010). Each
 * capture of a hidden step that ended done shows, hidden, whether it
 * matched or not (BUG-011). With `before`, only runs started before that
 * run count: the values that run got.
 */
export function agentValues(
  bundle: RunbookBundle,
  masked: AgentMask = agentMask(bundle.steps, bundle.runs),
  before?: number,
): EffectiveValue[] {
  const out = new Map<string, EffectiveValue>();
  for (const [name, value] of Object.entries(bundle.runbook.values)) {
    out.set(name, { name, value, source: "author" });
  }
  let runsByStep: Map<number, readonly RunRow[]> = bundle.runsByStep;
  if (before !== undefined) {
    runsByStep = new Map(
      [...bundle.runsByStep].map(([id, runs]) => [
        id,
        runs.filter((run) => run.id < before),
      ]),
    );
  }
  for (const step of bundle.steps) {
    for (const entry of masked.stepValues(step, runsByStep)) {
      out.set(entry.name, entry);
    }
  }
  return [...out.values()];
}
