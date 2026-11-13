/**
 * Checks on a step's output, as the server stores them and the Termix UI
 * shows them. The server tests them (src/backend/checks/checks.ts); this file holds
 * the shapes and the words, which both sides use.
 */

export type CheckStream = "stdout" | "stderr" | "any";

export type Check =
  | { type: "exitCode"; equals: number; label?: string }
  | {
      type: "contains" | "notContains";
      text: string;
      stream?: CheckStream;
      label?: string;
    }
  | {
      type: "matches" | "notMatches";
      pattern: string;
      stream?: CheckStream;
      label?: string;
    }
  | {
      type: "value";
      name: string;
      equals?: string;
      matches?: string;
      label?: string;
    };

export interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

/** Text for a detail: quoted and cut short. */
export function quote(text: string): string {
  const short = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `'${short.replace(/\n/g, "\\n")}'`;
}

export function streamName(stream: CheckStream, terminal: boolean): string {
  if (terminal) return "the pasted output";
  return stream === "any" ? "the output" : stream;
}

/** What a check tests, in a few words, for a check without a label. */
export function describeCheck(check: Check): string {
  const where = streamName(
    "stream" in check ? (check.stream ?? "any") : "any",
    false,
  );
  switch (check.type) {
    case "exitCode":
      return `exit code is ${check.equals}`;
    case "contains":
      return `${where} contains ${quote(check.text)}`;
    case "notContains":
      return `${where} does not contain ${quote(check.text)}`;
    case "matches":
      return `${where} matches /${check.pattern}/`;
    case "notMatches":
      return `${where} does not match /${check.pattern}/`;
    case "value":
      if (check.equals !== undefined) {
        return `value ${check.name} is ${quote(check.equals)}`;
      }
      if (check.matches !== undefined) {
        return `value ${check.name} matches /${check.matches}/`;
      }
      return `value ${check.name} is captured`;
  }
}
