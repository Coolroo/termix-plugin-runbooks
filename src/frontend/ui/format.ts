/**
 * How the page writes times, sizes, a step's host, its input and a run's
 * summary. Plain functions, no hooks: a confirm dialog, which renders
 * outside the plugin, can use them too.
 */

import { secretLabel } from "../../shared/names";
import type { Translate } from "../../shared/step-kinds";
import type { Run, StdinSource, Step, StepName } from "../api-types";

/** An ISO time in the person's locale; the text itself when it is not one. */
export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** 65000 -> "1:05", 3723000 -> "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** 7 -> "7 B", 1229 -> "1.2 KB", 3 MB -> "3.0 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 45 -> "45 s", 120 -> "2 min", 90 -> "1 min 30 s", 3900 -> "1 h 5 min". */
export function formatWait(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (rest || parts.length === 0) parts.push(`${rest} s`);
  return parts.join(" ");
}

/**
 * "output of step 3 (stdout, 1.2 KB)", "value build_id", "secret api_token
 * (hidden)": where a step's standard input comes from, never what it is.
 */
export function describeStdin(
  t: Translate,
  source: StdinSource,
  bytes: number | null = null,
): string {
  if (source.from === "step") {
    return bytes === null
      ? t("stdin.fromStep", { position: source.step, stream: source.stream })
      : t("stdin.fromStepSize", {
          position: source.step,
          stream: source.stream,
          size: formatBytes(bytes),
        });
  }
  if (source.from === "value") return t("stdin.value", { name: source.name });
  return t("stdin.secret", {
    name: secretLabel(source),
  });
}

/** The step's host by name, or "host 4 (not available to you)". */
export function hostLabel(
  t: Translate,
  step: Pick<Step, "hostId" | "hostName">,
): string {
  return step.hostName ?? t("step.unknownHost", { id: step.hostId });
}

/** The key of a run's "Run by alice at ..." line, by how it ran and ended. */
export function runSummaryKey(
  run: Pick<Run, "mode" | "status" | "secrets">,
): string {
  const done = run.status === "done";
  switch (run.mode) {
    case "secret":
      return run.secrets?.made?.how === "saved"
        ? "run.secretSaved"
        : "run.secretMade";
    case "manual":
      return done ? "run.manualDone" : "run.manualFailed";
    case "outside":
      return done ? "run.outsideDone" : "run.outsideFailed";
    case "agent":
      return done ? "run.agentDone" : "run.agentFailed";
    case "exec":
      return "run.byExec";
    default:
      return "run.byTerminal";
  }
}

/** "2. Restart, 3a. Check": the earlier steps a 409 order answer names. */
export function blockingText(steps: StepName[]): string {
  return steps.map((step) => `${step.label}. ${step.title}`).join(", ");
}

/**
 * "The wait is not over: 1:15 left (let it settle)": the question before a
 * start while a step's wait runs, with `leftMs` up to whole seconds.
 */
export function earlyTitle(
  t: Translate,
  leftMs: number,
  reason: string,
): string {
  const time = formatDuration(Math.ceil(leftMs / 1000) * 1000);
  return t(reason ? "wait.earlyReason" : "wait.early", { time, reason });
}
