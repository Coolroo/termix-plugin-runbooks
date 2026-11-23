/**
 * The runbook as an agent sees it: the output of steps hidden from agents,
 * and values captured from them, are replaced.
 */

import { resolve, type Values } from "../values/values.js";
import { agentCommand, resolveText } from "../values/effective.js";
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
        missing: agentCommand(step, valueMap).missing,
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
  const command =
    run.command === "" || run.mode === "agent" || step.command === null
      ? run.command
      : resolve(step.command, values).text;
  if (!run.checks) return { command, checks: null };
  // One result per check of the step, in order; a run whose results do
  // not fit the step (none known) shows no words of them.
  if (run.checks.length !== step.checks.length) {
    return {
      command,
      checks: run.checks.map((result) => ({
        label: HIDDEN,
        ok: result.ok,
        detail: HIDDEN,
      })),
    };
  }
  const filled = fillChecks(step.checks, values).checks;
  const shown = { terminal: run.mode !== "exec", exitCode: run.exitCode };
  return {
    command,
    checks: run.checks.map((result, index) => {
      const check = filled[index];
      // A hidden step's failed check says only that it failed: why it
      // failed (a value not captured, a slow pattern) reads its output.
      const why = hidden ? null : checkWhy(step.checks[index], result);
      return {
        label: check.label ?? describeCheck(check),
        ok: result.ok,
        detail: checkDetail(check, result.ok, shown, why),
      };
    }),
  };
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
