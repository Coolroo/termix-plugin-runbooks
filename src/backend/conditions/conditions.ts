/**
 * Conditional steps (1.4.6): a step's `when` rule reads earlier steps'
 * results, and the step is needed only when the rule holds. A step whose
 * rule does not hold reads as "not needed" and counts as ended.
 *
 * A rule is a tree: `all`, `any` and `not` over leaves. Each kind of leaf
 * (a step's status, a step's output, a value) is one entry in LEAF_KINDS
 * with everything it needs: its fields, how it is checked as written, how
 * it names steps by id when stored, how it shows, what it tests and how it
 * reads in words. A new kind of leaf is one more entry.
 *
 * The state of a rule is worked out each time a runbook is read and never
 * stored, so reopening an earlier step changes it at once. What a pattern
 * says of a finished run's output is kept (RuleCache), and the patterns of
 * one read share a time limit (BUG-008).
 *
 * Pure functions, shared by the routes, the agent side and the tests.
 */

import crypto from "node:crypto";
import type { RunRow, StepRow } from "../runbooks/store/types.js";
import type { Capture, Values } from "../values/values.js";
import {
  MAX_CAPTURE_PATTERN,
  MAX_VALUE_LENGTH,
  PatternBudget,
  placeholders,
} from "../values/values.js";
import {
  checksProblem,
  evaluateChecks,
  normalizeCheck,
  type CheckedRun,
} from "../checks/checks.js";
import { isObject, unknownKey } from "../core/parse.js";
import {
  describeCheck,
  fillChecks,
  quote,
  type Check,
} from "../../shared/checks.js";
import { NAME, regexProblem } from "../../shared/names.js";
import {
  choiceLabels,
  OPTION_ID,
  type DecisionSpec,
} from "../../shared/decisions.js";
import { stepChoice } from "../decisions/decisions.js";
import { agentMask, HIDDEN, type AgentMask } from "../agents/agent-mask.js";
import {
  compareSteps,
  isBefore,
  parseStepRef,
  stepLabel,
  stepRef,
  type StepNumber,
} from "../../shared/steps.js";
import type {
  ConditionState,
  StepCondition,
  WhenRule,
  WhenStatus,
} from "../../shared/conditions.js";

export type { StepCondition, WhenRule } from "../../shared/conditions.js";

/** How deep `all`, `any` and `not` may nest. */
export const MAX_DEPTH = 4;
/** Rules in one step's `when`, combinators included. */
export const MAX_RULES = 20;
/**
 * The time the patterns of one read may take together (BUG-008). Each
 * still stops at its own limit (250 ms); one that the total stops before
 * then is not known yet, and its rule waits until a later read.
 */
export const RULE_TIME_BUDGET_MS = 500;
/**
 * How many answers a RuleCache keeps for one runbook (BUG-010): more than
 * one read of the largest runbook needs, so a read never drops its own.
 */
export const CACHE_PER_RUNBOOK = 1000;
/** How many runbooks a RuleCache keeps answers for. */
export const CACHE_RUNBOOKS = 50;

/** A map that drops the entry used least recently when it is full. */
class Lru<V> {
  private readonly entries = new Map<string | number, V>();

  constructor(private readonly size: number) {}

  get(key: string | number): V | undefined {
    const found = this.entries.get(key);
    if (found === undefined) return found;
    // Used now: it moves to the end, the last to go.
    this.entries.delete(key);
    this.entries.set(key, found);
    return found;
  }

  set(key: string | number, value: V): void {
    this.entries.delete(key);
    if (this.entries.size >= this.size) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, value);
  }
}

/**
 * The answers of output and value rules, kept across reads (BUG-008): a
 * finished run's output never changes, so the answer of one check on one
 * run stays true, and a value is text. One per store (loadBundle). Each
 * runbook has its own share, and the answers used least recently go first
 * (BUG-010): rules of one runbook cannot push out another's.
 */
export class RuleCache {
  private readonly runbooks: Lru<Lru<unknown>>;

  constructor(
    private readonly perRunbook = CACHE_PER_RUNBOOK,
    runbooks = CACHE_RUNBOOKS,
  ) {
    this.runbooks = new Lru(runbooks);
  }

  /** The answer kept for `key`, or work()'s, kept unless undefined. */
  answer<T>(
    runbookId: number,
    key: string,
    work: () => T | undefined,
  ): T | undefined {
    let answers = this.runbooks.get(runbookId);
    if (!answers) {
      answers = new Lru(this.perRunbook);
      this.runbooks.set(runbookId, answers);
    }
    const kept = answers.get(key);
    if (kept !== undefined) return kept as T;
    const found = work();
    if (found !== undefined) answers.set(key, found);
    return found;
  }
}

/** What a pattern's answer is kept by: its run, or its text. */
const digest = (...parts: string[]) =>
  crypto.createHash("sha256").update(parts.join("\0")).digest("base64");

/**
 * D1 (owner's choice, recommended answer): a rule that names a step an
 * amendment replaced reads the latest replacement that is still before the
 * step with the rule. False: it reads the step it names, as stdin does.
 */
const FOLLOW_REPLACEMENTS = true;

const STATUSES: WhenStatus[] = [
  "done",
  "failed",
  "skipped",
  "ran",
  "not-needed",
];

/** A leaf as stored: steps by id (`stepId`), never by number. */
export type StoredLeaf = Record<string, unknown>;

/** A rule as stored in the step's when_json column. */
export type StoredRule =
  | { all: StoredRule[] }
  | { any: StoredRule[] }
  | { not: StoredRule }
  | StoredLeaf;

/** What is wrong with a rule; the caller says where. */
export class RuleError extends Error {}

/** A step a stored rule may name: one before the step with the rule. */
export interface KnownStep extends StepNumber {
  id: number;
  captures?: Capture[];
  decision?: DecisionSpec | null;
  hideOutputFromAgents?: boolean;
  interactive?: boolean;
}

/** Where a rule is stored: the step with the rule and the steps there. */
export interface StoreContext {
  own: StepNumber;
  known: KnownStep[];
  /**
   * BUG-008: the values that steps hidden from agents capture (from
   * hiddenValueNames). Agents write every rule, so a rule may read neither
   * a hidden step's output nor these values: an agent could read them one
   * bit at a time through the rule's state.
   */
  hiddenValues?: ReadonlySet<string>;
}

/** What a rule's test reads: the runbook as it is now. */
export interface EvalContext {
  /** The step with the rule. */
  reader: StepRow;
  steps: StepRow[];
  byId: Map<number, StepRow>;
  runsByStep: Map<number, readonly RunRow[]>;
  /** The values so far, as agents read them (BUG-010). */
  values: Values;
  /** The values so far that steps hidden from agents captured. */
  hiddenValues: ReadonlySet<string>;
  /** What agents see of output and values: all a rule reads (BUG-010). */
  mask: AgentMask;
  /** The conditions of the steps before the reader, worked out first. */
  conditions: Map<number, StepCondition>;
  /** The time the patterns of this read may still take. */
  budget: PatternBudget;
  cache: RuleCache;
  /** Set when the rule reads output or values hidden from agents. */
  readsHidden: boolean;
}

/** What one rule says now, and why, in words that never quote output. */
interface Outcome {
  state: ConditionState;
  why: string;
  /** Waiting only because the time limit stopped a pattern (BUG-010). */
  cut?: boolean;
}

/** Shows a step id as the API names steps: 3, or "3a". */
type Ref = (stepId: number) => number | string;

/** One kind of leaf. */
interface LeafKind {
  /** The field that tells this kind of leaf from the others. */
  key: string;
  /** Every field it may have. */
  fields: readonly string[];
  /** Checks the leaf as written, without the runbook; returns it clean. */
  normalize(raw: Record<string, unknown>): WhenRule;
  /** The leaf as stored: steps by id, checked against the steps there. */
  store(rule: WhenRule, ctx: StoreContext): StoredLeaf;
  /** The leaf as the API shows it. */
  show(leaf: StoredLeaf, ref: Ref): WhenRule;
  /** The steps it names, by id. */
  stepIds(leaf: StoredLeaf): number[];
  evaluate(leaf: StoredLeaf, ctx: EvalContext): Outcome;
  /** What it asks, in words: "step 8 failed". */
  describe(leaf: StoredLeaf, ctx: EvalContext): string;
}

// --- Steps a rule names -----------------------------------------------------

/** The step a written reference names: an earlier step, by number. */
function namedStep(ref: unknown, ctx: StoreContext): KnownStep {
  const wanted = parseStepRef(ref);
  if (!wanted) throw new RuleError(`step ${String(ref)} is not a step`);
  if (!isBefore(wanted, ctx.own)) {
    throw new RuleError(
      `step ${String(ref)} is not before this step (step ${stepLabel(ctx.own)}): a rule reads earlier steps only`,
    );
  }
  const found = ctx.known.find(
    (other) =>
      other.position === wanted.position &&
      (other.suffix ?? null) === wanted.suffix,
  );
  if (!found) throw new RuleError(`step ${String(ref)} is not a step`);
  return found;
}

/**
 * The step a rule reads for a step id: the step itself, or (D1) its latest
 * replacement that is still before the step with the rule.
 */
function target(stepId: number, ctx: EvalContext): StepRow | null {
  let step = ctx.byId.get(stepId) ?? null;
  if (!FOLLOW_REPLACEMENTS) return step;
  const seen = new Set<number>();
  while (step && step.status === "replaced" && !seen.has(step.id)) {
    seen.add(step.id);
    const from = step;
    const replacement = [...ctx.steps]
      .reverse()
      .find(
        (other) =>
          other.amendsStepId === from.id && other.amendKind === "replace",
      );
    if (!replacement || !isBefore(replacement, ctx.reader)) break;
    step = replacement;
  }
  return step;
}

/** Pending, never run, and its rule does not hold. */
function notNeeded(step: StepRow, ctx: EvalContext): boolean {
  return ctx.conditions.get(step.id)?.notNeeded ?? false;
}

/** Still to do: pending and needed. */
function open(step: StepRow, ctx: EvalContext): boolean {
  return step.status === "pending" && !notNeeded(step, ctx);
}

/** Runs that ended with output a rule can read, newest first. */
function finishedRuns(step: StepRow, ctx: EvalContext): RunRow[] {
  return [...(ctx.runsByStep.get(step.id) ?? [])]
    .filter(
      (run) =>
        (run.status === "done" || run.status === "failed") &&
        run.mode !== "manual" &&
        run.mode !== "secret",
    )
    .sort((a, b) => b.id - a.id);
}

/** A finished run as the checks read it: the pasted output for a terminal. */
function checkedRun(run: RunRow): CheckedRun {
  if (run.mode === "exec") {
    return {
      mode: "exec",
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      pastedOutput: null,
    };
  }
  return {
    mode: "terminal",
    exitCode: run.exitCode,
    stdout: null,
    stderr: null,
    // An agent's step keeps what the agent handed in as stdout, and a
    // decision the chosen ids, one per line.
    pastedOutput:
      run.mode === "agent" || run.mode === "decision"
        ? run.stdout
        : run.pastedOutput,
  };
}

const label = (step: StepRow | null, stepId: number) =>
  step ? `step ${stepLabel(step)}` : `step ${stepId} (removed)`;

const waitingFor = (step: StepRow): Outcome => ({
  state: "waiting",
  why: `waiting for step ${stepLabel(step)}`,
});

/** A pattern the time limit of this read stopped (BUG-008). */
const notYet = (what: string): Outcome => ({
  state: "waiting",
  why: `${what}: not worked out yet; read the runbook again`,
  cut: true,
});

/**
 * Whether value `name` is hidden from agents, so a rule reads it masked
 * (BUG-010): a hidden step sets it, or it holds a hidden value.
 */
function readsHiddenValue(name: string, ctx: EvalContext): boolean {
  return (
    ctx.hiddenValues.has(name) ||
    (Object.prototype.hasOwnProperty.call(ctx.values, name) &&
      ctx.values[name].includes(HIDDEN))
  );
}

/** The first of `names` that a step hidden from agents captures, or null. */
function hiddenNameIn(names: string[], ctx: StoreContext): string | null {
  return names.find((name) => ctx.hiddenValues?.has(name)) ?? null;
}

/**
 * The values that steps hidden from agents capture, or that their decision
 * holds (BUG-008): no rule may read them.
 */
export function hiddenValueNames(
  steps: ReadonlyArray<
    Pick<KnownStep, "captures" | "decision" | "hideOutputFromAgents">
  >,
): Set<string> {
  const names = new Set<string>();
  for (const step of steps) {
    if (!step.hideOutputFromAgents) continue;
    for (const capture of step.captures ?? []) names.add(capture.name);
    if (step.decision?.value) names.add(step.decision.value);
  }
  return names;
}

// --- Kinds of leaf ----------------------------------------------------------

const STATUS_WORDS: Record<WhenStatus | "replaced" | "pending", string> = {
  done: "is done",
  failed: "failed",
  skipped: "was skipped",
  ran: "ran",
  "not-needed": "was not needed",
  replaced: "was replaced",
  pending: "is pending",
};

/** `{ step, status }`: how an earlier step ended. */
const statusLeaf: LeafKind = {
  key: "status",
  fields: ["step", "status"],
  normalize(raw) {
    if (!STATUSES.includes(raw.status as WhenStatus)) {
      throw new RuleError(`status must be one of ${STATUSES.join(", ")}`);
    }
    if (!parseStepRef(raw.step)) {
      throw new RuleError('step must be a step number such as 3 or "3a"');
    }
    return {
      step: raw.step as number | string,
      status: raw.status as WhenStatus,
    };
  },
  store(rule, ctx) {
    const leaf = rule as { step: number | string; status: WhenStatus };
    return { stepId: namedStep(leaf.step, ctx).id, status: leaf.status };
  },
  show: (leaf, ref) => ({
    step: ref(leaf.stepId as number),
    status: leaf.status as WhenStatus,
  }),
  stepIds: (leaf) => [leaf.stepId as number],
  evaluate(leaf, ctx) {
    const want = leaf.status as WhenStatus;
    const step = target(leaf.stepId as number, ctx);
    if (!step) {
      return {
        state: "not-met",
        why: `${label(step, leaf.stepId as number)} is gone`,
      };
    }
    if (open(step, ctx)) return waitingFor(step);
    const name = `step ${stepLabel(step)}`;
    if (want === "ran") {
      const ran = finishedRuns(step, ctx).length > 0;
      return ran
        ? { state: "met", why: `${name} ran` }
        : { state: "not-met", why: `${name} did not run` };
    }
    const actual = notNeeded(step, ctx) ? "not-needed" : step.status;
    return {
      state: actual === want ? "met" : "not-met",
      why: `${name} ${STATUS_WORDS[actual]}`,
    };
  },
  describe: (leaf, ctx) => {
    const id = leaf.stepId as number;
    return `${label(target(id, ctx), id)} ${STATUS_WORDS[leaf.status as WhenStatus]}`;
  },
};

/** `{ step, output: <check> }`: what an earlier step's latest run printed. */
const outputLeaf: LeafKind = {
  key: "output",
  fields: ["step", "output"],
  normalize(raw) {
    if (!parseStepRef(raw.step)) {
      throw new RuleError('step must be a step number such as 3 or "3a"');
    }
    // Value checks are checked against the named step's captures on store.
    const problem = checksProblem([raw.output]);
    if (problem) {
      throw new RuleError(`output: ${problem.replace(/^checks\[0\]: /, "")}`);
    }
    return {
      step: raw.step as number | string,
      output: normalizeCheck(raw.output as Check),
    };
  },
  store(rule, ctx) {
    const leaf = rule as { step: number | string; output: Check };
    const step = namedStep(leaf.step, ctx);
    const check = leaf.output;
    if (step.hideOutputFromAgents) {
      throw new RuleError(
        `output: step ${String(leaf.step)} hides its output from agents, so a rule cannot read it; test its status instead`,
      );
    }
    const hidden = hiddenNameIn(placeholders(JSON.stringify(check)), ctx);
    if (hidden) {
      throw new RuleError(
        `output: {{${hidden}}} is captured by a step that hides its output from agents, so a rule cannot use it`,
      );
    }
    // A terminal has one stream (1.4.6): an interactive step has no stderr.
    if (step.interactive && "stream" in check && check.stream === "stderr") {
      throw new RuleError(
        `output: step ${String(leaf.step)} is interactive, so its stdout and stderr are one stream; leave out stream or use "stdout"`,
      );
    }
    if (
      check.type === "value" &&
      !(step.captures ?? []).some((capture) => capture.name === check.name)
    ) {
      throw new RuleError(
        `output: "${check.name}" is not a capture of step ${String(leaf.step)}`,
      );
    }
    return { stepId: step.id, output: leaf.output };
  },
  show: (leaf, ref) => ({
    step: ref(leaf.stepId as number),
    output: leaf.output as Check,
  }),
  stepIds: (leaf) => [leaf.stepId as number],
  evaluate(leaf, ctx) {
    const step = target(leaf.stepId as number, ctx);
    if (!step) {
      return {
        state: "not-met",
        why: `${label(step, leaf.stepId as number)} is gone`,
      };
    }
    const written = leaf.output as Check;
    const hidden = ctx.mask.hiddenSteps.has(step.id);
    // An exit code is not output: agents see it.
    if (
      (hidden && written.type !== "exitCode") ||
      placeholders(JSON.stringify(written)).some((v) =>
        readsHiddenValue(v, ctx),
      )
    ) {
      ctx.readsHidden = true;
    }
    if (open(step, ctx)) return waitingFor(step);
    const name = `step ${stepLabel(step)}`;
    // A decision that is not done has no choice, so no output (BUG-010).
    const latest =
      step.decision && step.status !== "done"
        ? undefined
        : finishedRuns(step, ctx)[0];
    if (!latest) return { state: "not-met", why: `${name} has no output` };
    // The check takes values as a step's checks do (BUG-007), as agents
    // read them (BUG-010).
    const filled = fillChecks([written], ctx.values);
    if (filled.missing.length > 0) {
      return {
        state: "not-met",
        why: `value ${filled.missing.join(", ")} is not set`,
      };
    }
    // The run keeps its output with secrets hidden, and the check reads it
    // as agents do (BUG-010): hidden values replaced.
    const check = filled.checks[0];
    const key = digest(
      "output",
      String(latest.id),
      latest.startedAt,
      latest.finishedAt ?? "",
      latest.status,
      String(latest.exitCode),
      hidden ? "hidden" : "shown",
      ctx.mask.key,
      JSON.stringify(check),
    );
    const answer = ctx.cache.answer(ctx.reader.runbookId, key, () => {
      const shown = ctx.mask.run(latest);
      const cuts = ctx.budget.cuts;
      const found = evaluateChecks(
        [check],
        checkedRun(shown),
        shown.captured ?? {},
        ctx.budget.test,
      )[0];
      if (ctx.budget.cuts > cuts) return undefined;
      const masked =
        shown.stdout !== latest.stdout ||
        shown.stderr !== latest.stderr ||
        shown.pastedOutput !== latest.pastedOutput ||
        JSON.stringify(shown.captured) !== JSON.stringify(latest.captured);
      return { found, masked };
    });
    if (!answer) return notYet(name);
    if (answer.masked && check.type !== "exitCode") ctx.readsHidden = true;
    const result = answer.found;
    return {
      state: result.ok ? "met" : "not-met",
      why: `${name}: ${result.detail}`,
    };
  },
  describe(leaf, ctx) {
    const id = leaf.stepId as number;
    const check = fillChecks([leaf.output as Check], ctx.values).checks[0];
    return `${label(target(id, ctx), id)}: ${check.label ?? describeCheck(check)}`;
  },
};

/** `{ value, equals?, matches? }`: a runbook value (the author's or a capture). */
const valueLeaf: LeafKind = {
  key: "value",
  fields: ["value", "equals", "matches"],
  normalize(raw) {
    if (typeof raw.value !== "string" || !NAME.test(raw.value)) {
      throw new RuleError(`value must match ${NAME.source}`);
    }
    if (
      raw.equals !== undefined &&
      (typeof raw.equals !== "string" || raw.equals.length > MAX_VALUE_LENGTH)
    ) {
      throw new RuleError(
        `equals must be text of at most ${MAX_VALUE_LENGTH} characters`,
      );
    }
    if (raw.matches !== undefined) {
      const problem = regexProblem(raw.matches, "matches", MAX_CAPTURE_PATTERN);
      if (problem) throw new RuleError(problem);
    }
    return {
      value: raw.value,
      ...(raw.equals !== undefined ? { equals: raw.equals as string } : {}),
      ...(raw.matches !== undefined ? { matches: raw.matches as string } : {}),
    };
  },
  store(rule, ctx) {
    const leaf = rule as { value: string };
    if (hiddenNameIn([leaf.value], ctx)) {
      throw new RuleError(
        `value ${leaf.value} is captured by a step that hides its output from agents, so a rule cannot read it`,
      );
    }
    return { ...(rule as StoredLeaf) };
  },
  show: (leaf) => ({ ...(leaf as { value: string }) }),
  stepIds: () => [],
  evaluate(leaf, ctx) {
    const name = leaf.value as string;
    if (readsHiddenValue(name, ctx)) ctx.readsHidden = true;
    if (!Object.prototype.hasOwnProperty.call(ctx.values, name)) {
      // An earlier step may still capture it.
      const pending = ctx.steps.find(
        (step) => isBefore(step, ctx.reader) && open(step, ctx),
      );
      return pending
        ? { state: "waiting", why: `waiting for value ${name}` }
        : { state: "not-met", why: `value ${name} is not set` };
    }
    const value = ctx.values[name];
    if (leaf.equals !== undefined && value !== leaf.equals) {
      return {
        state: "not-met",
        why: `value ${name} is not ${quote(leaf.equals as string)}`,
      };
    }
    if (leaf.matches !== undefined) {
      const pattern = leaf.matches as string;
      const key = digest("value", pattern, value);
      const hit = ctx.cache.answer(ctx.reader.runbookId, key, () => {
        const cuts = ctx.budget.cuts;
        const found = ctx.budget.test(pattern, value);
        return ctx.budget.cuts > cuts ? undefined : found;
      });
      if (hit === undefined) return notYet(`value ${name}`);
      if (!hit) {
        return {
          state: "not-met",
          why:
            hit === null
              ? `/${String(leaf.matches)}/ did not finish in time`
              : `value ${name} does not match /${String(leaf.matches)}/`,
        };
      }
    }
    return { state: "met", why: valueWords(leaf) };
  },
  describe: (leaf) => valueWords(leaf),
};

function valueWords(leaf: StoredLeaf): string {
  const name = leaf.value as string;
  if (leaf.equals !== undefined) {
    return `value ${name} is ${quote(leaf.equals as string)}`;
  }
  if (leaf.matches !== undefined) {
    return `value ${name} matches /${String(leaf.matches)}/`;
  }
  return `value ${name} is set`;
}

/** `{ step, chose }`: an option the person chose in a Decision step. */
const choseLeaf: LeafKind = {
  key: "chose",
  fields: ["step", "chose"],
  normalize(raw) {
    if (!parseStepRef(raw.step)) {
      throw new RuleError('step must be a step number such as 3 or "3a"');
    }
    if (typeof raw.chose !== "string" || !OPTION_ID.test(raw.chose)) {
      throw new RuleError(
        "chose must be an option id: 1 to 40 of a-z, 0-9 and -",
      );
    }
    return { step: raw.step as number | string, chose: raw.chose };
  },
  store(rule, ctx) {
    const leaf = rule as { step: number | string; chose: string };
    const step = namedStep(leaf.step, ctx);
    if (!step.decision) {
      throw new RuleError(`step ${String(leaf.step)} is not a decision step`);
    }
    if (!step.decision.options.some((option) => option.id === leaf.chose)) {
      throw new RuleError(
        `"${leaf.chose}" is not an option of step ${String(leaf.step)}`,
      );
    }
    return { stepId: step.id, chose: leaf.chose };
  },
  show: (leaf, ref) => ({
    step: ref(leaf.stepId as number),
    chose: leaf.chose as string,
  }),
  stepIds: (leaf) => [leaf.stepId as number],
  evaluate(leaf, ctx) {
    const step = target(leaf.stepId as number, ctx);
    if (!step) {
      return {
        state: "not-met",
        why: `${label(step, leaf.stepId as number)} is gone`,
      };
    }
    if (open(step, ctx)) return waitingFor(step);
    const name = `step ${stepLabel(step)}`;
    const choice = step.decision ? stepChoice(step, ctx.runsByStep) : null;
    if (!step.decision || !choice) {
      return { state: "not-met", why: `${name} has no choice` };
    }
    return {
      state: choice.chosen.includes(leaf.chose as string) ? "met" : "not-met",
      why: `${name}: you chose ${quote(choiceLabels(step.decision, choice.chosen))}`,
    };
  },
  describe(leaf, ctx) {
    const id = leaf.stepId as number;
    const step = target(id, ctx);
    const option = step?.decision?.options.find((o) => o.id === leaf.chose);
    return `${label(step, id)}: you chose ${quote(option?.label ?? String(leaf.chose))}`;
  },
};

/** Every kind of leaf. A new kind is one more entry. */
const LEAF_KINDS: LeafKind[] = [statusLeaf, outputLeaf, valueLeaf, choseLeaf];

const COMBINATORS = ["all", "any", "not"] as const;
type Combinator = (typeof COMBINATORS)[number];

function combinatorOf(rule: object): Combinator | null {
  return COMBINATORS.find((key) => key in rule) ?? null;
}

function leafKindOf(rule: object): LeafKind | null {
  return LEAF_KINDS.find((kind) => kind.key in rule) ?? null;
}

const LEAF_KEYS = () => LEAF_KINDS.map((kind) => kind.key);

// --- Checking and storing a rule ------------------------------------------

/**
 * Checks a rule as written, without the runbook: its shape, depth and size.
 * Returns it clean. Throws RuleError, naming where in the rule.
 */
export function normalizeWhen(raw: unknown): WhenRule {
  let count = 0;
  const walk = (node: unknown, depth: number, at: string): WhenRule => {
    count += 1;
    if (count > MAX_RULES) {
      throw new RuleError(`a step's when may have at most ${MAX_RULES} rules`);
    }
    const where = (message: string) => new RuleError(`${at}: ${message}`);
    if (!isObject(node)) {
      throw where(
        `a rule must be an object with all, any, not, or one of ${LEAF_KEYS().join(", ")}`,
      );
    }
    const combinator = combinatorOf(node);
    if (combinator) {
      if (Object.keys(node).length !== 1) {
        throw where(`${combinator} must be the rule's only field`);
      }
      if (depth >= MAX_DEPTH) {
        throw where(`rules may nest at most ${MAX_DEPTH} levels deep`);
      }
      if (combinator === "not") {
        return { not: walk(node.not, depth + 1, `${at}.not`) };
      }
      const list = node[combinator];
      if (!Array.isArray(list) || list.length === 0) {
        throw where(`${combinator} must be a list of at least one rule`);
      }
      const rules = list.map((child, index) =>
        walk(child, depth + 1, `${at}.${combinator}[${index}]`),
      );
      return combinator === "all" ? { all: rules } : { any: rules };
    }
    const kind = leafKindOf(node);
    if (!kind) {
      throw where(
        `a rule must have all, any, not, or one of ${LEAF_KEYS().join(", ")}`,
      );
    }
    const unknown = unknownKey(node, kind.fields);
    if (unknown !== undefined) {
      throw where(`unknown field "${unknown}" in a ${kind.key} rule`);
    }
    try {
      return kind.normalize(node);
    } catch (error) {
      if (error instanceof RuleError) throw where(error.message);
      throw error;
    }
  };
  return walk(raw, 1, "when");
}

/**
 * The rule as stored: each step it names by id. It may name only steps
 * before `own`, and an output value check only one of that step's captures.
 */
export function storeWhen(rule: WhenRule, ctx: StoreContext): StoredRule {
  const walk = (node: WhenRule): StoredRule => {
    if ("all" in node) return { all: node.all.map(walk) };
    if ("any" in node) return { any: node.any.map(walk) };
    if ("not" in node) return { not: walk(node.not) };
    const kind = leafKindOf(node)!;
    try {
      return kind.store(node, ctx);
    } catch (error) {
      if (error instanceof RuleError) {
        throw new RuleError(`when: ${error.message}`);
      }
      throw error;
    }
  };
  return walk(rule);
}

/** The rule as the API shows it: steps by number, 3 or "3a". */
export function showWhen(rule: StoredRule, steps: StepRow[]): WhenRule {
  const refs = new Map(steps.map((step) => [step.id, stepRef(step)]));
  const ref: Ref = (id) => refs.get(id) ?? id;
  const walk = (node: StoredRule): WhenRule => {
    if ("all" in node) return { all: (node.all as StoredRule[]).map(walk) };
    if ("any" in node) return { any: (node.any as StoredRule[]).map(walk) };
    if ("not" in node) return { not: walk(node.not as StoredRule) };
    return leafKindOf(node)!.show(node, ref);
  };
  return walk(rule);
}

/** Every step a rule names, by id. */
export function ruleStepIds(rule: StoredRule | null): number[] {
  if (!rule) return [];
  if ("all" in rule) return (rule.all as StoredRule[]).flatMap(ruleStepIds);
  if ("any" in rule) return (rule.any as StoredRule[]).flatMap(ruleStepIds);
  if ("not" in rule) return ruleStepIds(rule.not as StoredRule);
  return leafKindOf(rule)?.stepIds(rule) ?? [];
}

/** Every value a rule reads: value rules, and {{name}} in output rules. */
export function ruleValueNames(rule: StoredRule | null): string[] {
  if (!rule) return [];
  if ("all" in rule) return (rule.all as StoredRule[]).flatMap(ruleValueNames);
  if ("any" in rule) return (rule.any as StoredRule[]).flatMap(ruleValueNames);
  if ("not" in rule) return ruleValueNames(rule.not as StoredRule);
  if ("value" in rule) return [rule.value as string];
  if ("output" in rule) return placeholders(JSON.stringify(rule.output));
  return [];
}

// --- Testing a rule ---------------------------------------------------------

const NEGATE: Record<ConditionState, ConditionState> = {
  met: "not-met",
  "not-met": "met",
  waiting: "waiting",
};

function evaluate(node: StoredRule, ctx: EvalContext): Outcome {
  if ("not" in node) {
    const inner = evaluate(node.not as StoredRule, ctx);
    return { ...inner, state: NEGATE[inner.state] };
  }
  if ("all" in node || "any" in node) {
    const all = "all" in node;
    const results = ((all ? node.all : node.any) as StoredRule[]).map((child) =>
      evaluate(child, ctx),
    );
    // all: one failed rule decides; any: one rule that holds decides.
    const decides: ConditionState = all ? "not-met" : "met";
    const decided = results.find((result) => result.state === decides);
    if (decided) return decided;
    // A rule that waits for a step says more than one the time limit cut.
    const waiting =
      results.find((result) => result.state === "waiting" && !result.cut) ??
      results.find((result) => result.state === "waiting");
    if (waiting) return waiting;
    return {
      state: all ? "met" : "not-met",
      why: results.map((result) => result.why).join(" and "),
    };
  }
  const kind = leafKindOf(node);
  if (!kind) return { state: "not-met", why: "the rule is not known" };
  return kind.evaluate(node, ctx);
}

/** The rule in words: "step 8 failed or step 9 failed". */
function describe(node: StoredRule, ctx: EvalContext, top = true): string {
  if ("not" in node) {
    return `not ${describe(node.not as StoredRule, ctx, false)}`;
  }
  if ("all" in node || "any" in node) {
    const all = "all" in node;
    const parts = ((all ? node.all : node.any) as StoredRule[]).map((child) =>
      describe(child, ctx, false),
    );
    if (parts.length === 1) return parts[0];
    const text = parts.join(all ? " and " : " or ");
    return top ? text : `(${text})`;
  }
  return leafKindOf(node)?.describe(node, ctx) ?? "an unknown rule";
}

/**
 * Every step's condition now, by step id: null for a step without a rule.
 * Steps are worked out in order, so a rule can read whether an earlier
 * step was needed. A rule reads the author's `values` and what earlier
 * steps captured, never a later step's capture (BUG-008).
 *
 * Every rule reads only what the agent view shows (BUG-010): output and
 * values with what steps hidden from agents captured replaced, as
 * agentMask replaces it. Whoever wrote the rule, and whenever the person
 * hid a step, its state then tells an agent nothing it cannot see.
 */
export function evaluateConditions(
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
  authorValues: Values,
  options: { budget?: PatternBudget; cache?: RuleCache } = {},
): Map<number, StepCondition> {
  const budget = options.budget ?? new PatternBudget(RULE_TIME_BUDGET_MS);
  const cache = options.cache ?? new RuleCache();
  const conditions = new Map<number, StepCondition>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ordered = [...steps].sort(compareSteps);
  const mask = agentMask(steps, [...runsByStep.values()].flat());
  // The values so far: the author's, then each step's captures in order,
  // as agents read them.
  const values: Values = { ...authorValues };
  const hiddenValues = new Set<string>();
  for (const reader of ordered) {
    if (reader.when) setCondition(reader, { ...values }, new Set(hiddenValues));
    const hidden = mask.hiddenSteps.has(reader.id);
    for (const { name, value } of mask.stepValues(reader, runsByStep)) {
      values[name] = value;
      if (hidden) hiddenValues.add(name);
      else hiddenValues.delete(name);
    }
    // A hidden step's value is hidden before it is captured, too.
    if (hidden) {
      for (const name of hiddenValueNames([reader])) hiddenValues.add(name);
    }
  }
  return conditions;

  function setCondition(
    reader: StepRow,
    values: Values,
    hiddenValues: ReadonlySet<string>,
  ): void {
    const ctx: EvalContext = {
      reader,
      steps: ordered,
      byId,
      runsByStep,
      values,
      hiddenValues,
      mask,
      conditions,
      budget,
      cache,
      readsHidden: false,
    };
    const outcome = evaluate(reader.when!, ctx);
    // A step that ran is history: its rule no longer changes it.
    const ran = (runsByStep.get(reader.id) ?? []).length > 0;
    conditions.set(reader.id, {
      state: outcome.state,
      rule: describe(reader.when!, ctx),
      reason: outcome.why,
      notNeeded:
        outcome.state === "not-met" && reader.status === "pending" && !ran,
      ...(ctx.readsHidden ? { readsHidden: true } : {}),
      ...(outcome.state === "waiting" && outcome.cut ? { cutOff: true } : {}),
    });
  }
}

/**
 * Whether a pattern the time limit stopped leaves a rule waiting now: the
 * steps not needed may then change on a later read (BUG-010).
 */
export function anyCutOff(conditions: Map<number, StepCondition>): boolean {
  return [...conditions.values()].some((condition) => condition.cutOff);
}

/** The ids of the steps not needed now. */
export function notNeededIds(
  conditions: Map<number, StepCondition>,
): Set<number> {
  return new Set(
    [...conditions].filter(([, c]) => c.notNeeded).map(([id]) => id),
  );
}
