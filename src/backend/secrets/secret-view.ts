/**
 * Secrets in a runbook, by name and never by value: which steps capture,
 * make or ask for which secret, whether each is set now, and how a secret
 * step shows when the service can or cannot take its value.
 */

import type { RunbookRow, StepRow } from "../runbooks/store/types.js";
import { checkCaptures, type Capture } from "../values/values.js";
import type { StdinSource } from "../running/stdin.js";
import {
  byHandPlace,
  secretStepKind,
  type AskSpec,
  type ByHand,
  type GenerateSpec,
  type SecretStore,
} from "../../shared/secret-steps.js";
import { isBefore, stepLabel, stepRef } from "../../shared/steps.js";
import type { SecretState, SecretStepView } from "../../shared/api.js";
import { secretNameProblem } from "../../shared/names.js";
import type { RunbookBundle, ViewOptions } from "../runbooks/view.js";

const MAX_SECRET_CAPTURES = 10;

/** Checks secret capture rules: as captures, at most 10, distinct names. */
export function secretCapturesProblem(input: unknown): string | null {
  if (!Array.isArray(input)) return "secretCaptures must be an array";
  if (input.length > MAX_SECRET_CAPTURES) {
    return `a step may have at most ${MAX_SECRET_CAPTURES} secretCaptures`;
  }
  const problem = checkCaptures(input);
  if (problem)
    return `secretCaptures: ${problem.replace(/^capture/, "secret")}`;
  const names = new Set<string>();
  for (const entry of input as Capture[]) {
    const nameProblem = secretNameProblem(entry.name, "secret name");
    if (nameProblem) return `secretCaptures: ${nameProblem}`;
    if (names.has(entry.name)) {
      return `secretCaptures: secret "${entry.name}" is named twice`;
    }
    names.add(entry.name);
  }
  return null;
}

/**
 * A secret a step reads by name must be captured by an earlier step of the
 * same runbook. Returns the problem, or null.
 */
export function secretReadsProblem(
  steps: Array<{
    position: number;
    suffix?: string | null;
    title?: string;
    stdin: { from: string; name?: string } | null;
    secretCaptures: Capture[];
    generate?: GenerateSpec | null;
    ask?: AskSpec | null;
  }>,
): string | null {
  for (const step of steps) {
    const stdin = step.stdin;
    if (!stdin || stdin.from !== "secret" || stdin.name === undefined) continue;
    const captured = steps.some(
      (other) =>
        isBefore(other, step) &&
        runbookSecretNames(other).includes(stdin.name!),
    );
    if (!captured) {
      const elsewhere = steps.find(
        (other) =>
          isBefore(other, step) &&
          secretSpec(other)?.name === stdin.name &&
          secretSpec(other)?.store.to !== "runbook",
      );
      if (elsewhere) {
        const store = secretSpec(elsewhere)!.store;
        return store.to === "library"
          ? `step ${stepLabel(step)} reads secret ${stdin.name}, which step ${stepLabel(elsewhere)} keeps in the library: read it with {"from":"secret","library":"${store.library}"}`
          : `step ${stepLabel(step)} reads secret ${stdin.name}, which step ${stepLabel(elsewhere)} saves to an app path: Runbooks cannot read it back`;
      }
      return `step ${stepLabel(step)} reads secret ${stdin.name}, which no earlier step captures (secretCaptures), makes (generate) or asks for (ask)`;
    }
  }
  return null;
}

/** A step's generate or ask field, whichever it has. */
export function secretSpec(step: {
  generate?: GenerateSpec | null;
  ask?: AskSpec | null;
}): GenerateSpec | AskSpec | null {
  return step.generate ?? step.ask ?? null;
}

/**
 * The secrets a step puts in the runbook's own secrets, by name: what its
 * secretCaptures take, and what a Make a secret or Ask for a secret step
 * with store "runbook" makes (1.4.2).
 */
function runbookSecretNames(step: {
  secretCaptures: Capture[];
  generate?: GenerateSpec | null;
  ask?: AskSpec | null;
}): string[] {
  const names = step.secretCaptures.map((capture) => capture.name);
  const spec = secretSpec(step);
  if (spec && spec.store.to === "runbook") names.push(spec.name);
  return names;
}

/**
 * Every secret the runbook's steps capture, or make or ask for into the
 * runbook's own secrets (1.4.2), by name: never a value.
 */
export function secretStates(
  bundle: Pick<RunbookBundle, "runbook" | "steps" | "runsByStep">,
  at = Date.now(),
): SecretState[] {
  const removedAt = bundle.runbook.secretsRemovedAt;
  const out: SecretState[] = [];
  for (const step of bundle.steps) {
    const runs = [...(bundle.runsByStep.get(step.id) ?? [])].sort(
      (a, b) => b.id - a.id,
    );
    for (const name of runbookSecretNames(step)) {
      let entry: { name: string; expiresAt: string } | undefined;
      const run = runs.find((candidate) => {
        entry = candidate.secrets?.captured.find(
          (stored) => stored.name === name,
        );
        return Boolean(entry);
      });
      const removed = Boolean(
        run && removedAt && run.finishedAt && run.finishedAt <= removedAt,
      );
      const set = Boolean(
        entry && !removed && Date.parse(entry.expiresAt) > at,
      );
      out.push({
        name,
        step: stepRef(step),
        set,
        expiresAt: set ? entry!.expiresAt : null,
      });
    }
  }
  return out;
}

/**
 * Whether a closed runbook still has secrets to delete: it has steps that
 * capture secrets, and none were deleted since the last one was stored.
 */
export function secretsPending(runbook: RunbookRow, steps: StepRow[]): boolean {
  if (!steps.some((step) => runbookSecretNames(step).length > 0)) return false;
  if (!runbook.secretsRemovedAt) return true;
  return Boolean(
    runbook.secretsStoredAt &&
    runbook.secretsStoredAt > runbook.secretsRemovedAt,
  );
}

/** Why an app path store is done by hand on an older OpenBao Secrets. */
export const APP_STORE_NEEDS =
  "Saving to an app path needs OpenBao Secrets 1.0.5 or later, with the allowed app paths an admin sets there";

/** Whether a store takes a value now, or the person does it by hand. */
function secretMode(
  store: SecretStore,
  options: ViewOptions,
): { mode: "ready" | "by-hand"; reason: string | null } {
  const ready = options.secretsReady ?? Boolean(options.secretsAvailable);
  if (!ready) {
    return {
      mode: "by-hand",
      reason: options.secretsReason ?? options.noSecrets ?? "no secrets",
    };
  }
  if (store.to === "app" && !options.appSecrets) {
    return { mode: "by-hand", reason: APP_STORE_NEEDS };
  }
  return { mode: "ready", reason: null };
}

/** A secret step's view, or null for any other step. */
export function secretStepView(
  step: StepRow,
  options: ViewOptions,
  states: SecretState[],
): SecretStepView | null {
  const kind = secretStepKind(step);
  const spec = secretSpec(step);
  if (!kind || !spec) return null;
  const state = states.find(
    (entry) => entry.name === spec.name && entry.step === stepRef(step),
  );
  return {
    kind,
    name: spec.name,
    ...secretMode(spec.store, options),
    byHand: byHandPlace(spec.store, spec.name, step.runbookId, options.userId),
    set: Boolean(state?.set),
    expiresAt: state?.expiresAt ?? null,
  };
}

/**
 * Where to get a secret a step reads by hand (1.4.2): when the secret step
 * that makes it, or the library, is done by hand now. Null otherwise.
 */
export function stdinByHand(
  step: StepRow,
  steps: StepRow[],
  source: StdinSource,
  options: ViewOptions,
): (ByHand & { step: string | null }) | null {
  if (source.from !== "secret") return null;
  if ("library" in source) {
    const store: SecretStore = {
      to: "library",
      library: source.library,
      expires: null,
    };
    if (secretMode(store, options).mode === "ready") return null;
    return {
      ...byHandPlace(store, source.library, step.runbookId, options.userId),
      step: null,
    };
  }
  const maker = [...steps]
    .reverse()
    .find(
      (other) =>
        isBefore(other, step) &&
        secretSpec(other)?.name === source.name &&
        secretSpec(other)?.store.to === "runbook",
    );
  const spec = maker ? secretSpec(maker) : null;
  if (!maker || !spec || secretMode(spec.store, options).mode === "ready") {
    return null;
  }
  return {
    ...byHandPlace(spec.store, spec.name, step.runbookId, options.userId),
    step: stepLabel(maker),
  };
}
