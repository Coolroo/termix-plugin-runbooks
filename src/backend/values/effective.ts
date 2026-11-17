/**
 * The values a step gets now (the author's, then captures) and a step's
 * command and text with them filled in.
 */

import type { RunRow, RunbookRow, StepRow } from "../runbooks/store/types.js";
import { approvalHash, commandHash, resolve, type Values } from "./values.js";
import { stdinKey, type StdinSource } from "../running/stdin.js";
import { fillStepText, uniqueNames } from "../../shared/fill.js";
import { fillChecks, type Check } from "../../shared/checks.js";
import type { EffectiveValue } from "../../shared/api.js";

/**
 * Author values, then captured values in step order (each step's runs oldest
 * first). A later value wins.
 */
export function effectiveValues(
  runbook: RunbookRow,
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
): Map<string, EffectiveValue> {
  const out = new Map<string, EffectiveValue>();
  for (const [name, value] of Object.entries(runbook.values)) {
    out.set(name, { name, value, source: "author" });
  }
  for (const step of steps) {
    for (const { name, value, runId } of stepCaptures(step, runsByStep)) {
      out.set(name, { name, value, source: "capture", stepId: step.id, runId });
    }
  }
  return out;
}

/**
 * The values a step's runs captured, oldest run first. A decision's value
 * counts only while the step is done (BUG-008): a decision reopened, or
 * skipped after that, has no choice, as stepChoice says.
 */
export function stepCaptures(
  step: Pick<StepRow, "id" | "status">,
  runsByStep: Map<number, readonly RunRow[]>,
): Array<{ name: string; value: string; runId: number }> {
  return [...(runsByStep.get(step.id) ?? [])]
    .sort((a, b) => a.id - b.id)
    .filter((run) => run.mode !== "decision" || step.status === "done")
    .flatMap((run) =>
      Object.entries(run.captured ?? {}).map(([name, value]) => ({
        name,
        value,
        runId: run.id,
      })),
    );
}

export function valuesObject(map: Map<string, EffectiveValue>): Values {
  const values: Values = {};
  for (const [name, entry] of map) values[name] = entry.value;
  return values;
}

export interface ResolvedStep {
  command: string | null;
  /** What the person approves: the command and the filled checks. */
  hash: string | null;
  /**
   * The run's identity, kept with the run: the host, the command and the
   * input's source. A repeat is the same command, whatever its checks.
   */
  runHash: string | null;
  /** Names the command and the checks use that have no value. */
  missing: string[];
  /** The checks with their values filled in (BUG-007). */
  checks: Check[];
}

/**
 * The command as it runs, and the hash a person approves: the host, the
 * command and, for a step with standard input, the input's source (never
 * the input itself), with the checks when they use values (BUG-008).
 */
export function resolveStep(
  step: StepRow,
  values: Values,
  stdin: StdinSource | null = null,
): ResolvedStep {
  if (step.command === null || step.hostId === null) {
    return {
      command: null,
      hash: null,
      runHash: null,
      missing: [],
      checks: step.checks,
    };
  }
  const resolved = resolve(step.command, values);
  const checks = fillChecks(step.checks, values);
  const missing = uniqueNames(resolved.missing, checks.missing);
  const runHash = missing.length
    ? null
    : commandHash(step.hostId, resolved.text, stdin ? stdinKey(stdin) : null);
  return {
    command: resolved.text,
    hash: runHash && approvalHash(runHash, step.checks, checks.checks),
    runHash,
    missing,
    checks: checks.checks,
  };
}

/** A step's text with its values filled in (1.4.3). */
export interface ResolvedText {
  /** `body` with values: escaped outside code, raw inside it. */
  resolvedBody: string;
  /** `expect`, as `body`. */
  resolvedExpect: string;
  /** `where`, plain text, values as they are; null when it has none. */
  resolvedWhere: string | null;
  /** Names body, expect and where use that have no value. */
  textMissing: string[];
}

/**
 * Fills {{name}} in a step's body, expect and where with the values the
 * command gets (the author's, then captures). A value not set stays as
 * written, as in resolvedCommand. Values are never secrets: secrets are
 * kept apart and never become values, and captured values have secrets
 * removed before they are stored. The page fills the same text with the
 * same function (fillStepText), with a marker for a value not set.
 */
export function resolveText(
  step: Pick<StepRow, "body" | "expect" | "where">,
  values: Values,
): ResolvedText {
  const text = fillStepText(step, values);
  return {
    resolvedBody: text.body,
    resolvedExpect: text.expect,
    resolvedWhere: text.where,
    textMissing: text.missing,
  };
}

/**
 * An agent step's command with its values filled in, to show what the agent
 * will run. Never a hash: nothing in Termix runs it.
 */
export function agentCommand(step: StepRow, values: Values): ResolvedStep {
  if (step.command === null) {
    return {
      command: null,
      hash: null,
      runHash: null,
      missing: [],
      checks: step.checks,
    };
  }
  const resolved = resolve(step.command, values);
  const checks = fillChecks(step.checks, values);
  return {
    command: resolved.text,
    hash: null,
    runHash: null,
    missing: uniqueNames(resolved.missing, checks.missing),
    checks: checks.checks,
  };
}
