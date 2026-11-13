/**
 * The values a step gets now (the author's, then captures) and a step's
 * command and text with them filled in.
 */

import type { RunRow, RunbookRow, StepRow } from "../runbooks/store/types.js";
import { commandHash, resolve, type Values } from "./values.js";
import { stdinKey, type StdinSource } from "../running/stdin.js";
import { fillStepText } from "../../shared/fill.js";
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
    const stepRuns = [...(runsByStep.get(step.id) ?? [])].sort(
      (a, b) => a.id - b.id,
    );
    for (const run of stepRuns) {
      for (const [name, value] of Object.entries(run.captured ?? {})) {
        out.set(name, {
          name,
          value,
          source: "capture",
          stepId: step.id,
          runId: run.id,
        });
      }
    }
  }
  return out;
}

export function valuesObject(map: Map<string, EffectiveValue>): Values {
  const values: Values = {};
  for (const [name, entry] of map) values[name] = entry.value;
  return values;
}

export interface ResolvedStep {
  command: string | null;
  hash: string | null;
  missing: string[];
}

/**
 * The command as it runs, and the hash a person approves: the host, the
 * command and, for a step with standard input, the input's source (never
 * the input itself).
 */
export function resolveStep(
  step: StepRow,
  values: Values,
  stdin: StdinSource | null = null,
): ResolvedStep {
  if (step.command === null || step.hostId === null) {
    return { command: null, hash: null, missing: [] };
  }
  const resolved = resolve(step.command, values);
  return {
    command: resolved.text,
    hash: resolved.missing.length
      ? null
      : commandHash(step.hostId, resolved.text, stdin ? stdinKey(stdin) : null),
    missing: resolved.missing,
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
  if (step.command === null) return { command: null, hash: null, missing: [] };
  const resolved = resolve(step.command, values);
  return { command: resolved.text, hash: null, missing: resolved.missing };
}
