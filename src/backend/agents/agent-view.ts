/**
 * The runbook as an agent sees it: the output of steps hidden from agents,
 * and values captured from them, are replaced.
 */

import type { Values } from "../values/values.js";
import { agentCommand, resolveText } from "../values/effective.js";
import type { ShownRun } from "../running/live.js";
import { stepStdin } from "../running/stdin.js";
import { waitState } from "../running/wait.js";
import { showAsk, showGenerate } from "../../shared/secret-steps.js";
import type { EffectiveValue, StepWait } from "../../shared/api.js";
import {
  amendmentView,
  openPath,
  runbookSummary,
  type HostNames,
  type RunbookBundle,
} from "../runbooks/view.js";
import { secretStates } from "../secrets/secret-view.js";

const HIDDEN = "[hidden by owner]";

/**
 * The runbook as an agent sees it: hidden steps' output, and values captured
 * from them, are replaced, also where such a value shows up in a command that
 * ran.
 */
export function agentView(bundle: RunbookBundle, hostName: HostNames) {
  const { runbook, steps, runsByStep } = bundle;
  const hiddenSteps = new Set(
    steps.filter((step) => step.hideOutputFromAgents).map((step) => step.id),
  );
  const values = agentValues(bundle, hiddenSteps);
  const secrets = hiddenCapturedTexts(bundle, hiddenSteps);
  const mask = (value: string | null) => {
    if (value === null) return value;
    let out = value;
    for (const secret of secrets) out = out.split(secret).join(HIDDEN);
    return out;
  };
  const next = steps.find((step) => step.status === "pending");
  const valueMap: Values = Object.fromEntries(
    values.map((entry) => [entry.name, entry.value]),
  );
  return {
    ...runbookSummary(runbook, steps),
    openPath: openPath(runbook.id),
    owner: runbook.owner,
    summary: runbook.summary,
    values: runbook.values,
    effectiveValues: values,
    secrets: secretStates(bundle),
    nextStepId: next?.id ?? null,
    steps: steps.map((step) => {
      const hidden = hiddenSteps.has(step.id);
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
        resolvedBody: mask(text.resolvedBody)!,
        resolvedExpect: mask(text.resolvedExpect)!,
        resolvedWhere: mask(text.resolvedWhere),
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
        waitUntil: agentWaitUntil(waitState(step, steps, runsByStep)),
        stdin: stepStdin(step, steps),
        revision: step.revision,
        editable: stepRuns.length === 0,
        runs: stepRuns.map((run) => agentRun(run, hidden, mask)),
      };
    }),
  };
}

/** The end of a wait that is running now, for agents; null otherwise. */
function agentWaitUntil(wait: StepWait | null): string | null {
  return wait && wait.remainingMs > 0 ? wait.until : null;
}

function agentRun(
  run: ShownRun,
  hidden: boolean,
  mask: (value: string | null) => string | null,
) {
  const hide = (value: string | null) =>
    hidden && value !== null ? HIDDEN : mask(value);
  return {
    id: run.id,
    stepId: run.stepId,
    mode: run.mode,
    status: run.status,
    hostId: run.hostId,
    command: mask(run.command),
    userId: run.userId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    stdout: hide(run.stdout),
    stderr: hide(run.stderr),
    pastedOutput: hide(run.pastedOutput),
    truncated: run.truncated,
    timedOut: run.timedOut,
    error: mask(run.error),
    running: run.running,
    lastOutputAt: run.lastOutputAt,
    checks: run.checks,
    // Where its standard input came from and its size, never the input.
    stdin: run.stdin,
    // Secret names it read or stored, never a value.
    secrets: run.secrets,
    // A manual run's note (a step with no command marked by hand).
    note: run.note,
    // Seconds of the wait timer left when the person started it anyway.
    startedEarlySeconds: run.startedEarlySeconds,
    captured: hidden
      ? Object.fromEntries(Object.keys(run.captured).map((k) => [k, HIDDEN]))
      : run.captured,
  };
}

function hiddenCapturedTexts(
  bundle: RunbookBundle,
  hiddenSteps: Set<number>,
): string[] {
  const texts = new Set<string>();
  for (const run of bundle.runs) {
    if (!hiddenSteps.has(run.stepId)) continue;
    for (const value of Object.values(run.captured)) {
      // Very short values would mask unrelated text and say little anyway.
      if (value.length >= 4) texts.add(value);
    }
  }
  return [...texts].sort((a, b) => b.length - a.length);
}

/** Effective values with those captured from hidden steps replaced. */
export function agentValues(
  bundle: RunbookBundle,
  hiddenSteps?: Set<number>,
): EffectiveValue[] {
  const hidden =
    hiddenSteps ??
    new Set(
      bundle.steps
        .filter((step) => step.hideOutputFromAgents)
        .map((step) => step.id),
    );
  return [...bundle.values.values()].map((entry) =>
    entry.source === "capture" && entry.stepId && hidden.has(entry.stepId)
      ? { ...entry, value: HIDDEN }
      : entry,
  );
}
