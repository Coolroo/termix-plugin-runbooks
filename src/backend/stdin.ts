/**
 * Standard input for a step (1.2.0): the bytes a Run writes to the command's
 * standard input, from one source. An earlier step's output, a value, or a
 * secret; never typed into the command line.
 *
 * Authors name an earlier step by its position. Runbooks keeps the step's id
 * instead, so moving or inserting steps never points the input at another
 * step, and shows the position again in every view.
 */

import { VALUE_NAME } from "./values.js";

export const MAX_STDIN_BYTES = 256 * 1024;
/** The Run confirm shows this much of a step or value input. */
export const STDIN_PREVIEW_CHARS = 200;
export const MAX_SECRET_NAME = 64;

export type StdinStream = "stdout" | "stderr";

/** What an author writes, and what every view shows. */
export type StdinSource =
  | { from: "step"; step: number; stream: StdinStream; allowFailed?: boolean }
  | { from: "value"; name: string }
  | { from: "secret"; name: string }
  | { from: "secret"; library: string };

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

/** What a run keeps of its input: where it came from and its size only. */
export type RunStdin = StdinSource & { bytes: number };

/** A library secret: "mine/<name>" or "shared/<name>". */
const LIBRARY =
  /^(mine|shared)\/([A-Za-z0-9._-]{1,200}(?:\/[A-Za-z0-9._-]{1,200}){0,3})$/;

/** A secret name a step captures or reads: a value name, short. */
export function secretNameProblem(name: unknown, field: string): string | null {
  if (typeof name !== "string" || !VALUE_NAME.test(name)) {
    return `${field} must match ${VALUE_NAME.source}`;
  }
  if (name.length > MAX_SECRET_NAME) {
    return `${field} is longer than ${MAX_SECRET_NAME} characters`;
  }
  return null;
}

/** The OpenBao Secrets area and name of a library reference. */
export function libraryRef(library: string): {
  area: "user" | "shared";
  name: string;
} {
  const match = LIBRARY.exec(library);
  if (!match) throw new Error("not a library secret");
  return { area: match[1] === "mine" ? "user" : "shared", name: match[2] };
}

/** Checks a stdin source as an author wrote it. Returns the problem or null. */
export function stdinProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return 'stdin must be an object with "from": step, value or secret';
  }
  const source = raw as Record<string, unknown>;
  const allowed = (keys: string[]) => {
    for (const key of Object.keys(source)) {
      if (!keys.includes(key)) return `stdin has an unknown field "${key}"`;
    }
    return null;
  };
  switch (source.from) {
    case "step": {
      const unknown = allowed(["from", "step", "stream", "allowFailed"]);
      if (unknown) return unknown;
      if (!Number.isInteger(source.step) || (source.step as number) < 1) {
        return "stdin.step must be the position of an earlier step";
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
      if (typeof source.name !== "string" || !VALUE_NAME.test(source.name)) {
        return `stdin.name must match ${VALUE_NAME.source}`;
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
      if (typeof source.library !== "string" || !LIBRARY.test(source.library)) {
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
    return {
      from: "step",
      step: source.step as number,
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

/** The stored form shown with positions, or null when the step is gone. */
export function showStdin(
  stored: StoredStdin | null,
  positionOf: (stepId: number) => number | null,
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

/** The input with step positions turned into ids, or a problem. */
export function storeStdin(
  source: StdinSource | null,
  ownPosition: number,
  idAt: (position: number) => number | null,
): StoredStdin | null {
  if (!source) return null;
  if (source.from !== "step") return source;
  if (source.step >= ownPosition) {
    throw new StdinPositionError(
      `stdin.step ${source.step} is not before this step (position ${ownPosition})`,
    );
  }
  const stepId = idAt(source.step);
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

/** Whether the source is a secret, and its name as runs and audits say it. */
export function secretLabel(source: StdinSource | null): string | null {
  if (!source || source.from !== "secret") return null;
  return "name" in source ? source.name : source.library;
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
