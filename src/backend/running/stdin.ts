/**
 * Standard input for a step (1.2.0): the bytes a Run writes to the command's
 * standard input, from one source. An earlier step's output, a value, or a
 * secret; never typed into the command line.
 *
 * Authors name an earlier step by its position, or an amendment by its
 * label ("3a", 1.4.0). Runbooks keeps the step's id instead, so moving or
 * inserting steps never points the input at another step, and shows the
 * number again in every view.
 */

import {
  LIBRARY_REF,
  NAME,
  secretLabel,
  secretNameProblem,
} from "../../shared/names.js";
import {
  isBefore,
  parseStepRef,
  stepLabel,
  stepRef,
  type StepNumber,
} from "../../shared/steps.js";
import type { StdinSource, StdinStream } from "../../shared/api.js";
import { isObject, unknownKey } from "../core/parse.js";
import type { RunRow, StepRow } from "../runbooks/store/types.js";
import type { Values } from "../values/values.js";

const MAX_STDIN_BYTES = 256 * 1024;
/** The Run confirm shows this much of a step or value input. */
export const STDIN_PREVIEW_CHARS = 200;

export type { RunStdin, StdinSource, StdinStream } from "../../shared/api.js";
export { secretLabel };

/** What the steps table keeps: an earlier step by id. */
export type StoredStdin =
  | {
      from: "step";
      stepId: number;
      stream: StdinStream;
      allowFailed?: boolean;
    }
  | { from: "value"; name: string }
  | { from: "secret"; name: string }
  | { from: "secret"; library: string };

/** The OpenBao Secrets area and name of a library reference. */
export function libraryRef(library: string): {
  area: "user" | "shared";
  name: string;
} {
  const match = LIBRARY_REF.exec(library);
  if (!match) throw new Error("not a library secret");
  return { area: match[1] === "mine" ? "user" : "shared", name: match[2] };
}

/** Checks a stdin source as an author wrote it. Returns the problem or null. */
export function stdinProblem(raw: unknown): string | null {
  if (!isObject(raw)) {
    return 'stdin must be an object with "from": step, value or secret';
  }
  const source = raw;
  const allowed = (keys: string[]) => {
    const key = unknownKey(source, keys);
    return key === undefined ? null : `stdin has an unknown field "${key}"`;
  };
  switch (source.from) {
    case "step": {
      const unknown = allowed(["from", "step", "stream", "allowFailed"]);
      if (unknown) return unknown;
      if (!parseStepRef(source.step)) {
        return 'stdin.step must be the number of an earlier step, such as 2 or "3a"';
      }
      if (source.stream !== "stdout" && source.stream !== "stderr") {
        return "stdin.stream must be stdout or stderr";
      }
      if (
        source.allowFailed !== undefined &&
        typeof source.allowFailed !== "boolean"
      ) {
        return "stdin.allowFailed must be true or false";
      }
      return null;
    }
    case "value": {
      const unknown = allowed(["from", "name"]);
      if (unknown) return unknown;
      if (typeof source.name !== "string" || !NAME.test(source.name)) {
        return `stdin.name must match ${NAME.source}`;
      }
      return null;
    }
    case "secret": {
      const unknown = allowed(["from", "name", "library"]);
      if (unknown) return unknown;
      if ((source.name === undefined) === (source.library === undefined)) {
        return "a secret stdin has either name (a secret this runbook captures) or library";
      }
      if (source.name !== undefined) {
        return secretNameProblem(source.name, "stdin.name");
      }
      if (
        typeof source.library !== "string" ||
        !LIBRARY_REF.test(source.library)
      ) {
        return 'stdin.library must be "mine/<name>" or "shared/<name>"';
      }
      return null;
    }
    default:
      return 'stdin.from must be "step", "value" or "secret"';
  }
}

/** A checked source with only its known fields, in a fixed order. */
export function normalizeStdin(raw: unknown): StdinSource {
  const source = raw as Record<string, unknown>;
  if (source.from === "step") {
    // "3" and 3 are the same step: kept as a number, as before 1.4.0.
    const ref = parseStepRef(source.step)!;
    return {
      from: "step",
      step: ref.suffix ? stepLabel(ref) : ref.position,
      stream: source.stream as StdinStream,
      ...(source.allowFailed === true ? { allowFailed: true } : {}),
    };
  }
  if (source.from === "value") {
    return { from: "value", name: source.name as string };
  }
  return source.name !== undefined
    ? { from: "secret", name: source.name as string }
    : { from: "secret", library: source.library as string };
}

/** The stored form shown with step numbers, or null when the step is gone. */
function showStdin(
  stored: StoredStdin | null,
  positionOf: (stepId: number) => number | string | null,
): StdinSource | null {
  if (!stored) return null;
  if (stored.from !== "step") return stored;
  const step = positionOf(stored.stepId);
  if (step === null) return null;
  return {
    from: "step",
    step,
    stream: stored.stream,
    ...(stored.allowFailed ? { allowFailed: true } : {}),
  };
}

/**
 * The input with step numbers turned into ids, or a problem. `own` is the
 * number of the step that reads it; `idOf` finds a step by its number.
 */
export function storeStdin(
  source: StdinSource | null,
  own: StepNumber,
  idOf: (ref: { position: number; suffix: string | null }) => number | null,
): StoredStdin | null {
  if (!source) return null;
  if (source.from !== "step") return source;
  const ref = parseStepRef(source.step);
  if (!ref) {
    throw new StdinPositionError(`stdin.step ${source.step} is not a step`);
  }
  if (!isBefore(ref, own)) {
    throw new StdinPositionError(
      `stdin.step ${source.step} is not before this step (${
        own.suffix ? `step ${stepLabel(own)}` : `position ${own.position}`
      })`,
    );
  }
  const stepId = idOf(ref);
  if (stepId === null) {
    throw new StdinPositionError(`stdin.step ${source.step} is not a step`);
  }
  return {
    from: "step",
    stepId,
    stream: source.stream,
    ...(source.allowFailed ? { allowFailed: true } : {}),
  };
}

export class StdinPositionError extends Error {}

/** The source in a fixed text form, for the hash a person approves. */
export function stdinKey(source: StdinSource): string {
  switch (source.from) {
    case "step":
      return `step:${source.step}:${source.stream}${source.allowFailed ? ":allow-failed" : ""}`;
    case "value":
      return `value:${source.name}`;
    case "secret":
      return "name" in source
        ? `secret:${source.name}`
        : `library:${source.library}`;
  }
}

/** "output of step 3 (stdout)", "value build_id", "secret api_token". */
export function describeStdin(source: StdinSource): string {
  switch (source.from) {
    case "step":
      return `output of step ${source.step} (${source.stream})`;
    case "value":
      return `value ${source.name}`;
    case "secret":
      return `secret ${secretLabel(source)}`;
  }
}

/**
 * A step's stdin source as views show it: an earlier step by its position,
 * or by its label ("3a") when it is an amendment.
 */
export function stepStdin(step: StepRow, steps: StepRow[]): StdinSource | null {
  const refs = new Map(steps.map((other) => [other.id, stepRef(other)]));
  return showStdin(step.stdin, (id) => refs.get(id) ?? null);
}

/** The step a reference such as 3 or "3a" names, if there is one. */
function findStep<T extends StepNumber>(steps: T[], ref: unknown): T | null {
  const wanted = parseStepRef(ref);
  if (!wanted) return null;
  return (
    steps.find(
      (other) =>
        other.position === wanted.position &&
        (other.suffix ?? null) === wanted.suffix,
    ) ?? null
  );
}

export type StdinText = { text: string } | { problem: string };

/**
 * The input of a step or value source as it stands now, or why there is
 * none. Null for a secret: only a Run reads a secret, as the person.
 */
export function stdinText(
  source: StdinSource,
  step: StepRow,
  steps: StepRow[],
  runsByStep: Map<number, readonly RunRow[]>,
  values: Values,
): StdinText | null {
  let text: string;
  if (source.from === "step") {
    const from = findStep(steps, source.step);
    if (!from || !isBefore(from, step)) {
      return { problem: `step ${source.step} is not an earlier step` };
    }
    const latest = [...(runsByStep.get(from.id) ?? [])]
      .sort((a, b) => b.id - a.id)
      .find((run) => run.status === "done" || run.status === "failed");
    if (!latest) {
      return { problem: `step ${source.step} has no finished run yet` };
    }
    if (latest.mode === "manual") {
      return { problem: `step ${source.step} has no command output` };
    }
    if (latest.status === "failed" && !source.allowFailed) {
      return { problem: `the last run of step ${source.step} failed` };
    }
    text =
      latest.mode === "terminal"
        ? (latest.pastedOutput ?? "")
        : (latest[source.stream] ?? "");
  } else if (source.from === "value") {
    if (!Object.prototype.hasOwnProperty.call(values, source.name)) {
      return { problem: `value ${source.name} has no value yet` };
    }
    text = `${values[source.name]}\n`;
  } else {
    return null;
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_STDIN_BYTES) {
    return {
      problem: `the input is ${Math.ceil(bytes / 1024)} KB; at most ${MAX_STDIN_BYTES / 1024} KB`,
    };
  }
  return { text };
}
