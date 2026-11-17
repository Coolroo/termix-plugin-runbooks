/**
 * Decision steps (1.4.6): the person chooses from options the author wrote,
 * with radio buttons or check boxes and no free text, and later steps' when
 * rules read the choice (`{ "step": 5, "chose": "rollback" }`). The shape,
 * its checks and the rules on a choice, shared by the server and the page.
 */

import { isOneLine, NAME } from "./names.js";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const MAX_OPTION_LABEL = 120;
export const MAX_OPTION_DESCRIPTION = 1000;
/** An option's id: what rules, the run's output and the value hold. */
export const OPTION_ID = /^[a-z0-9-]{1,40}$/;

export interface DecisionOption {
  id: string;
  label: string;
  /** Short Markdown under the label; null when there is none. */
  description: string | null;
}

export interface DecisionSpec {
  options: DecisionOption[];
  /** Check boxes (true) or radio buttons (false, one choice). */
  multiple: boolean;
  /** How many options a multiple choice takes: from min to max. */
  min: number;
  max: number;
  /** The runbook value that holds the chosen ids, joined with commas. */
  value: string | null;
}

/** The choice a decision step ended with, as the views show it. */
export interface DecisionChoice {
  /** The chosen ids, in the author's order. */
  chosen: string[];
  by: string;
  at: string;
}

function fail(message: string): never {
  throw new Error(message);
}

/** A decision field as an author wrote it, checked. Throws a message. */
export function parseDecision(raw: unknown): DecisionSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      "decision must be an object { options, multiple?, min?, max?, value? }",
    );
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["options", "multiple", "min", "max", "value"].includes(key)) {
      fail(`decision has an unknown field "${key}"`);
    }
  }
  const list = input.options;
  if (
    !Array.isArray(list) ||
    list.length < MIN_OPTIONS ||
    list.length > MAX_OPTIONS
  ) {
    fail(
      `decision.options must be a list of ${MIN_OPTIONS} to ${MAX_OPTIONS} options`,
    );
  }
  const options = list.map((option, index): DecisionOption => {
    const at = `decision.options[${index}]`;
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      fail(`${at} must be an object { id, label, description? }`);
    }
    const { id, label, description, ...rest } = option as Record<
      string,
      unknown
    >;
    const unknown = Object.keys(rest)[0];
    if (unknown !== undefined) fail(`${at} has an unknown field "${unknown}"`);
    if (typeof id !== "string" || !OPTION_ID.test(id)) {
      fail(`${at}.id must be 1 to 40 of a-z, 0-9 and -`);
    }
    if (typeof label !== "string" || label.trim() === "") {
      fail(`${at}.label is required`);
    }
    const shown = label.trim();
    if (shown.length > MAX_OPTION_LABEL) {
      fail(`${at}.label is longer than ${MAX_OPTION_LABEL} characters`);
    }
    if (!isOneLine(shown)) fail(`${at}.label must be one line`);
    if (
      description !== undefined &&
      description !== null &&
      (typeof description !== "string" ||
        description.length > MAX_OPTION_DESCRIPTION)
    ) {
      fail(
        `${at}.description must be text of at most ${MAX_OPTION_DESCRIPTION} characters`,
      );
    }
    const text = typeof description === "string" ? description.trim() : "";
    return { id, label: shown, description: text === "" ? null : text };
  });
  const ids = options.map((option) => option.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) fail(`decision.options has the id "${twice}" twice`);
  const multiple = input.multiple ?? false;
  if (typeof multiple !== "boolean") {
    fail("decision.multiple must be true or false");
  }
  if (!multiple && (input.min !== undefined || input.max !== undefined)) {
    fail("decision.min and decision.max need multiple: true");
  }
  const count = (raw: unknown, field: string, fallback: number) => {
    if (raw === undefined || raw === null) return fallback;
    if (!Number.isInteger(raw) || (raw as number) < 1) {
      fail(`decision.${field} must be a whole number from 1`);
    }
    if ((raw as number) > options.length) {
      fail(`decision.${field} is more than the ${options.length} options`);
    }
    return raw as number;
  };
  const min = multiple ? count(input.min, "min", 1) : 1;
  const max = multiple ? count(input.max, "max", options.length) : 1;
  if (min > max) fail("decision.min is more than decision.max");
  let value: string | null = null;
  if (input.value !== undefined && input.value !== null) {
    if (typeof input.value !== "string" || !NAME.test(input.value)) {
      fail(`decision.value must match ${NAME.source}`);
    }
    value = input.value;
  }
  return { options, multiple, min, max, value };
}

/**
 * What is wrong with a choice, or null: known ids, each once, as many as
 * the step takes. The page asks it to grey out Confirm; the server refuses
 * with it.
 */
export function choiceProblem(
  spec: DecisionSpec,
  chosen: unknown,
): string | null {
  if (!Array.isArray(chosen) || chosen.some((id) => typeof id !== "string")) {
    return "chosen must be a list of option ids";
  }
  const unknown = chosen.find(
    (id) => !spec.options.some((option) => option.id === id),
  );
  if (unknown !== undefined) return `"${unknown}" is not an option`;
  if (new Set(chosen).size !== chosen.length) {
    return "choose each option at most once";
  }
  if (!spec.multiple) {
    return chosen.length === 1 ? null : "choose exactly one option";
  }
  if (chosen.length < spec.min || chosen.length > spec.max) {
    return spec.min === spec.max
      ? `choose ${spec.min} options`
      : `choose ${spec.min} to ${spec.max} options`;
  }
  return null;
}

/** The chosen ids in the author's order. */
export function inOrder(spec: DecisionSpec, chosen: string[]): string[] {
  return spec.options
    .map((option) => option.id)
    .filter((id) => chosen.includes(id));
}

/** The labels of the chosen ids, joined: "Go back, Stop here". */
export function choiceLabels(spec: DecisionSpec, chosen: string[]): string {
  return inOrder(spec, chosen)
    .map((id) => spec.options.find((option) => option.id === id)!.label)
    .join(", ");
}
