/**
 * What a runbook looks like to a person: the bundle of its steps, runs and
 * values, its summary and progress, and the whole view the Runbooks tab
 * shows.
 */

import type { EventRow, RunbookRow, StepRow } from "./store/types.js";
import type { Store } from "./store/store.js";
import {
  agentCommand,
  effectiveValues,
  resolveStep,
  resolveText,
  valuesObject,
} from "../values/effective.js";
import { storedRun, type LiveRuns, type ShownRun } from "../running/live.js";
import {
  STDIN_PREVIEW_CHARS,
  stdinText,
  stepStdin,
  type StdinSource,
} from "../running/stdin.js";
import { waitState } from "../running/wait.js";
import { showAsk, showGenerate } from "../../shared/secret-steps.js";
import { isAgentStep, isOutsideStep, stepLabel } from "../../shared/steps.js";
import type {
  AmendmentView,
  EffectiveValue,
  Progress,
  Runbook,
  RunbookSummary,
  StdinView,
} from "../../shared/api.js";
import {
  secretStates,
  secretStepView,
  stdinByHand,
} from "../secrets/secret-view.js";
import { ranOnChoice, stepChoice } from "../decisions/decisions.js";
import {
  evaluateConditions,
  notNeededIds,
  RuleCache,
  showWhen,
  type StepCondition,
} from "../conditions/conditions.js";
import type { PatternBudget } from "../values/values.js";

export interface RunbookBundle {
  runbook: RunbookRow;
  steps: StepRow[];
  runs: ShownRun[];
  runsByStep: Map<number, ShownRun[]>;
  values: Map<string, EffectiveValue>;
  /** 1.4.6: each when rule's state now, by step id; never stored. */
  conditions: Map<number, StepCondition>;
}

/** What when rules said of finished runs, for each store (BUG-008). */
const ruleCaches = new WeakMap<Store, RuleCache>();

function ruleCache(store: Store): RuleCache {
  let cache = ruleCaches.get(store);
  if (!cache) {
    cache = new RuleCache();
    ruleCaches.set(store, cache);
  }
  return cache;
}

/**
 * A runbook with its steps and runs. With `live`, running runs carry the
 * output that has arrived so far. `budget` is the time its rules' patterns
 * may take, shared when a list reads many runbooks; a new one otherwise.
 */
export async function loadBundle(
  store: Store,
  runbookId: number,
  live?: LiveRuns,
  budget?: PatternBudget,
): Promise<RunbookBundle | null> {
  const runbook = await store.getRunbook(runbookId);
  if (!runbook) return null;
  const steps = await store.listSteps(runbookId);
  const rows = await store.listRuns({ runbookId });
  const runs = live ? live.show(rows) : rows.map(storedRun);
  const runsByStep = new Map<number, ShownRun[]>();
  for (const run of runs) {
    const list = runsByStep.get(run.stepId) ?? [];
    list.push(run);
    runsByStep.set(run.stepId, list);
  }
  const values = effectiveValues(runbook, steps, runsByStep);
  return {
    runbook,
    steps,
    runs,
    runsByStep,
    values,
    conditions: evaluateConditions(steps, runsByStep, runbook.values, {
      budget,
      cache: ruleCache(store),
    }),
  };
}

/**
 * The steps not needed now (1.4.6), for a reader that has only the steps:
 * the runs are read only when a step has a when rule. A list passes one
 * `budget` for all its runbooks (BUG-008).
 */
export async function loadNotNeeded(
  store: Store,
  runbookId: number,
  steps: StepRow[],
  budget?: PatternBudget,
): Promise<Set<number>> {
  if (!steps.some((step) => step.when)) return new Set();
  const bundle = await loadBundle(store, runbookId, undefined, budget);
  return bundle ? notNeededIds(bundle.conditions) : new Set();
}

/** The first pending step that is needed: the next one. */
export function nextStep(
  steps: StepRow[],
  notNeeded: ReadonlySet<number>,
): StepRow | undefined {
  return steps.find(
    (step) => step.status === "pending" && !notNeeded.has(step.id),
  );
}

export function progress(
  steps: StepRow[],
  notNeeded: ReadonlySet<number> = new Set(),
): Progress {
  // A replaced step ended: its replacement does its work.
  const finished = steps.filter(
    (step) =>
      step.status === "done" ||
      step.status === "skipped" ||
      step.status === "replaced",
  ).length;
  return {
    done: finished,
    failed: steps.filter((step) => step.status === "failed").length,
    total: steps.length,
    // Pending steps whose rule does not hold: ended, but not done.
    notNeeded: steps.filter(
      (step) => step.status === "pending" && notNeeded.has(step.id),
    ).length,
  };
}

/**
 * The link that opens a runbook in the Runbooks tab, relative to the Termix
 * address: the plugin does not know the address people use. Termix keeps a
 * `?view=` link across a sign-in, so it works signed out too.
 */
export function openPath(runbookId: number): string {
  return `/?view=runbook&id=${runbookId}`;
}

export function runbookSummary(
  runbook: RunbookRow,
  steps: StepRow[],
  notNeeded: ReadonlySet<number> = new Set(),
): RunbookSummary {
  return {
    id: runbook.id,
    title: runbook.title,
    status: runbook.status,
    createdBy: runbook.createdBy,
    createdAt: runbook.createdAt,
    updatedAt: runbook.updatedAt,
    revision: runbook.revision,
    progress: progress(steps, notNeeded),
    // Amendments that have not run yet (1.4.0): the list shows "amended".
    amendedPending: steps.filter(
      (step) => step.amendKind !== null && step.status === "pending",
    ).length,
  };
}

/**
 * What a step shows of amendments (1.4.0): its label, the step it amends
 * (with that step's command, for a fixed version), and the step that
 * replaced it.
 */
export function amendmentView(step: StepRow, steps: StepRow[]): AmendmentView {
  const parent =
    step.amendsStepId === null
      ? null
      : (steps.find((other) => other.id === step.amendsStepId) ?? null);
  const replacement =
    step.status === "replaced"
      ? ([...steps]
          .reverse()
          .find(
            (other) =>
              other.amendsStepId === step.id && other.amendKind === "replace",
          ) ?? null)
      : null;
  return {
    label: stepLabel(step),
    amendment:
      step.amendKind === null
        ? null
        : {
            kind: step.amendKind,
            reason: step.amendReason ?? "",
            by: step.amendedBy ?? "",
            stepId: step.amendsStepId,
            stepLabel: parent ? stepLabel(parent) : null,
            // A fixed version shows the command it replaces, struck through.
            oldCommand:
              step.amendKind === "replace" ? (parent?.command ?? null) : null,
          },
    replacedBy: replacement
      ? { id: replacement.id, label: stepLabel(replacement) }
      : null,
  };
}

export type HostNames = (hostId: number) => string | null;

export interface ViewOptions {
  /** Whether the OpenBao Secrets service is there now. */
  secretsAvailable?: boolean;
  /** Why a step that uses secrets cannot run without it. */
  noSecrets?: string;
  /**
   * 1.4.2: whether OpenBao Secrets is there and connected now, for secret
   * steps. Left out: as secretsAvailable.
   */
  secretsReady?: boolean;
  /** 1.4.2: why secret steps are done by hand now, when they are. */
  secretsReason?: string | null;
  /** 1.4.2: whether the service can create app secrets (createAppField). */
  appSecrets?: boolean;
  /** 1.4.2: the person who reads the view, for by-hand library paths. */
  userId?: string | null;
  /** Whether agent notifications are on (1.4.0). */
  notifyEnabled?: boolean;
  /** The runbook's "sent" events, newest first (1.4.0). */
  sent?: EventRow[];
}

/**
 * What the person sees of who a runbook belongs to: the owner's label, or
 * the name of the token that made it.
 */
export function agentLabel(runbook: RunbookRow): string {
  return runbook.owner?.label ?? runbook.createdBy;
}

/**
 * A run as `userId` sees it: how much was typed into it shows only to the
 * person who typed, the one who started it (BUG-010). A password's length
 * is for nobody else.
 */
export function typedSizes(
  run: ShownRun,
  userId: string | null | undefined,
): ShownRun {
  if (run.inputs.length === 0 || run.userId === userId) return run;
  return {
    ...run,
    inputs: run.inputs.map((input) => ({ ...input, chars: null })),
  };
}

/** The whole runbook as the Termix UI shows it. */
export function personView(
  bundle: RunbookBundle,
  hostName: HostNames,
  options: ViewOptions = {},
): Runbook {
  const { runbook, steps, runsByStep } = bundle;
  const values = valuesObject(bundle.values);
  const notNeeded = notNeededIds(bundle.conditions);
  const next = nextStep(steps, notNeeded);
  const states = secretStates(bundle);
  const stdinView = (step: StepRow, source: StdinSource): StdinView => {
    const found = stdinText(source, step, steps, runsByStep, values);
    if (!found) {
      const byHand = stdinByHand(step, steps, source, options);
      return {
        source,
        bytes: null,
        preview: null,
        problem: options.secretsAvailable
          ? null
          : (options.noSecrets ?? "no secrets"),
        ...(byHand ? { byHand } : {}),
      };
    }
    if ("problem" in found) {
      return { source, bytes: null, preview: null, problem: found.problem };
    }
    return {
      source,
      bytes: Buffer.byteLength(found.text),
      preview: found.text.slice(0, STDIN_PREVIEW_CHARS),
      problem: null,
    };
  };
  return {
    ...runbookSummary(runbook, steps, notNeeded),
    summary: runbook.summary,
    values: runbook.values,
    effectiveValues: [...bundle.values.values()],
    nextStepId: next?.id ?? null,
    owner: runbook.owner,
    agentLabel: agentLabel(runbook),
    notifyEnabled: Boolean(options.notifyEnabled),
    // Send to agent needs notifications on and an agent to send to.
    canSendToAgent: Boolean(options.notifyEnabled && runbook.owner),
    secretsAvailable: Boolean(options.secretsAvailable),
    secrets: states,
    steps: steps.map((step) => {
      const source = stepStdin(step, steps);
      // Termix runs neither an agent step nor a step run outside Termix:
      // their command is shown resolved, without a hash.
      const resolved =
        isAgentStep(step) || isOutsideStep(step)
          ? agentCommand(step, values)
          : resolveStep(step, values, source);
      return {
        ...step,
        ...amendmentView(step, steps),
        generate: step.generate ? showGenerate(step.generate) : null,
        ask: step.ask ? showAsk(step.ask) : null,
        // 1.4.6: the rule by step numbers, and what it says now.
        when: step.when ? showWhen(step.when, steps) : null,
        condition: bundle.conditions.get(step.id) ?? null,
        // 1.4.6: a Decision step's choice, and the steps that ran on it.
        choice: stepChoice(step, runsByStep),
        decisionRan: ranOnChoice(step, steps, runsByStep),
        secretStep: secretStepView(step, options, states),
        stdin: source ? stdinView(step, source) : null,
        // A step that captures secrets cannot run without the service.
        secretsProblem:
          step.secretCaptures.length > 0 && !options.secretsAvailable
            ? (options.noSecrets ?? "no secrets")
            : null,
        hostName: step.hostId === null ? null : hostName(step.hostId),
        resolvedCommand: resolved.command,
        commandHash: resolved.hash,
        missing: resolved.missing,
        resolvedChecks: resolved.checks,
        // 1.4.3: values in the step's text, as in its command.
        ...resolveText(step, values),
        wait: waitState(step, steps, runsByStep, notNeeded),
        runs: (runsByStep.get(step.id) ?? []).map((run) =>
          typedSizes(run, options.userId),
        ),
        // Each time a person sent this step to the agent, with the note.
        sent: (options.sent ?? [])
          .filter((event) => event.stepId === step.id)
          .map((event) => ({
            id: event.id,
            createdBy: event.createdBy,
            createdAt: event.createdAt,
            note: event.note,
          })),
      };
    }),
  };
}
