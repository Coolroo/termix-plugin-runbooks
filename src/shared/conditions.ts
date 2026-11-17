/**
 * Conditional steps (1.4.6): a step's `when` rule names earlier steps'
 * results, and the step is needed only when the rule holds. The shapes as
 * the API sends them; the server parses and tests the rules
 * (src/backend/conditions/conditions.ts).
 */

import type { Check } from "./checks.js";

/** How a step a status rule names ended. */
export type WhenStatus = "done" | "failed" | "skipped" | "ran" | "not-needed";

/**
 * A rule as an author writes it and the API shows it: a step by its number
 * (3, or "3a" for an amendment), as `stdin` names one.
 */
export type WhenRule =
  | { all: WhenRule[] }
  | { any: WhenRule[] }
  | { not: WhenRule }
  | { step: number | string; status: WhenStatus }
  | { step: number | string; output: Check }
  | { value: string; equals?: string; matches?: string }
  | { step: number | string; chose: string };

/**
 * waiting: a step the rule names has not ended (or a value it reads is not
 * set while an earlier step is still pending); met; not-met.
 */
export type ConditionState = "waiting" | "met" | "not-met";

/** What a step's rule says now, worked out each time the runbook is read. */
export interface StepCondition {
  state: ConditionState;
  /** The rule in words: "step 8 failed or step 9 failed". */
  rule: string;
  /** Why it has this state, never quoting output: "step 8 is done". */
  reason: string;
  /**
   * Pending, never run and not met: the step is not needed. It counts as
   * ended for the order, the next step and the progress.
   */
  notNeeded: boolean;
  /**
   * BUG-010: the rule reads output or values hidden from agents. A rule
   * reads what agents see, so it reads "[hidden by owner]" there; the page
   * warns. Agents do not get it.
   */
  readsHidden?: boolean;
  /**
   * BUG-010: waiting only because the time limit stopped a pattern; a
   * later read works it out. Agents do not get it.
   */
  cutOff?: boolean;
}
