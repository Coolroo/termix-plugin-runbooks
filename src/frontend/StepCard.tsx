import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Input,
  ListBadge,
  Textarea,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import { describeCheck } from "../shared/checks";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import type {
  Check,
  CheckResult,
  Run,
  StdinSource,
  Step,
  SecretState,
  StepWait,
} from "./types";

export interface StepActions {
  /** `waitLeftMs`: the step's wait timer still runs, this long. */
  run: (step: Step, waitLeftMs?: number) => void;
  stop: (step: Step) => void;
  send: (step: Step, waitLeftMs?: number) => void;
  skip: (step: Step, reason: string) => void;
  reopen: (step: Step) => void;
  saveNote: (step: Step, note: string) => void;
  setHidden: (step: Step, hidden: boolean) => void;
  /** Records a step with no command as done or failed, with a note. */
  /**
   * Marks a step with no command done or failed; for a step run outside
   * Termix (1.4.0), with the output the person pasted.
   */
  manual: (
    step: Step,
    outcome: "done" | "failed",
    note: string,
    output?: string,
  ) => void;
  /** Asks for a note and sends the step to the runbook's agent (1.4.0). */
  sendToAgent: (step: Step) => void;
  complete: (
    run: Run,
    pasted: string,
    outcome: "done" | "failed",
    exitCode: number | null,
  ) => void;
}

const CHECK_MARK = { pending: "○", ok: "✓", failed: "✗" } as const;

/** The words ChecksList shows, from the caller's translations. */
export interface ChecksWords {
  title: string;
  pending: string;
  ok: string;
  failed: string;
}

export function checksWords(t: (key: string) => string): ChecksWords {
  return {
    title: t("checks.title"),
    pending: t("checks.state.pending"),
    ok: t("checks.state.ok"),
    failed: t("checks.state.failed"),
  };
}

/**
 * A step's checks: pending before a run (and while it runs), then a tick or
 * a cross with what was found. It uses no hooks, so a confirm dialog, which
 * renders outside the plugin, can show it too.
 */
export function ChecksList({
  checks,
  results,
  words,
}: {
  checks: Check[];
  results?: CheckResult[] | null;
  words: ChecksWords;
}) {
  if (checks.length === 0) return null;
  return (
    <div className="mt-2" data-checks>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {words.title}
      </div>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {checks.map((check, index) => {
          const result = results?.[index];
          const state = !result ? "pending" : result.ok ? "ok" : "failed";
          return (
            <li
              key={index}
              data-check-state={state}
              className="flex items-baseline gap-2"
            >
              <span
                aria-label={words[state]}
                className={cn(
                  "w-3 shrink-0 font-mono",
                  state === "ok" && "text-emerald-500",
                  state === "failed" && "text-destructive",
                  state === "pending" && "text-muted-foreground",
                )}
              >
                {CHECK_MARK[state]}
              </span>
              <span>
                {result?.label ?? check.label ?? describeCheck(check)}
                {result && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {result.detail}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const STATUS_TONE = {
  pending: "muted",
  done: "success",
  failed: "destructive",
  skipped: "warning",
  replaced: "muted",
} as const;

/** "3", or "3a" for an amendment (1.4.0). */
export function stepLabel(step: { position: number; label?: string }): string {
  return step.label ?? String(step.position);
}

/**
 * How an agent amended this step: "Amended by <agent>: <reason>", and for
 * a fixed version, the command it replaces, struck through.
 */
function AmendmentNote({ step }: { step: Step }) {
  const { t } = useTranslation();
  const amendment = step.amendment;
  if (!amendment) return null;
  return (
    <div className="mt-2 text-xs" data-amendment={amendment.kind}>
      <p className="text-muted-foreground">
        {t(
          amendment.kind === "replace" ? "amend.replaces" : "amend.substepOf",
          { label: amendment.stepLabel ?? "?" },
        )}
      </p>
      <p className="mt-0.5" data-amend-reason>
        {t("amend.by", { agent: amendment.by, reason: amendment.reason })}
      </p>
      {amendment.kind === "replace" && amendment.oldCommand !== null && (
        <pre
          className="mt-1 overflow-x-auto border border-border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground"
          aria-label={t("amend.oldCommand")}
          data-old-command
        >
          <del>{amendment.oldCommand}</del>
        </pre>
      )}
    </div>
  );
}

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** A silence this long is shown as a warning: the command may be stuck. */
export const SILENCE_WARN_MS = 30_000;

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

/**
 * "output of step 3 (stdout, 1.2 KB)", "value build_id", "secret api_token
 * (hidden)": where a step's standard input comes from, never what it is.
 */
export function describeStdin(
  t: (key: string, options?: Record<string, unknown>) => string,
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
    name: "name" in source ? source.name : source.library,
  });
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
 * Milliseconds left of a step's wait, counted down on this clock from what
 * the server said when the step was fetched. Ticks every second while the
 * wait runs.
 */
export function useWaitRemaining(wait: StepWait | null | undefined): number {
  const fetchedAt = useMemo(() => Date.now(), [wait]);
  const [, setTick] = useState(0);
  const remaining = wait
    ? Math.max(0, wait.remainingMs - (Date.now() - fetchedAt))
    : 0;
  const counting = Boolean(wait && wait.remainingMs > 0);
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);
  return remaining;
}

/** Re-renders every second while mounted. */
function useTick(ms = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
}

/**
 * Output that grows while the command runs. It follows the end, unless the
 * person scrolled up to read something.
 */
function LiveOutput({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <div className="mt-1">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <pre
        ref={ref}
        data-live-output={label}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 16;
        }}
        className="mt-1 max-h-80 overflow-auto border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all"
      >
        {text}
      </pre>
    </div>
  );
}

/** The running command: elapsed time, silence, and its output so far. */
function LiveRun({ run }: { run: Run }) {
  const { t } = useTranslation();
  useTick();
  // The server's counts were true when this run was fetched; time moves on
  // from there on this clock, so a clock that is off does not matter.
  const fetchedAt = useMemo(() => Date.now(), [run]);
  const since = Date.now() - fetchedAt;
  const startedAt = Date.parse(run.startedAt);
  const elapsed =
    (run.elapsedMs ?? (Number.isNaN(startedAt) ? 0 : fetchedAt - startedAt)) +
    since;
  const silent = (run.silentMs ?? elapsed - since) + since;
  const warn = silent >= SILENCE_WARN_MS;
  return (
    <div className="mt-1" data-live-run={run.id}>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span data-elapsed>
          {t("run.elapsed", { time: formatDuration(elapsed) })}
        </span>
        {silent >= 1000 && (
          <span data-silence={warn ? "warn" : "ok"}>
            <ListBadge tone={warn ? "warning" : "muted"}>
              {t("run.silent", { seconds: Math.floor(silent / 1000) })}
            </ListBadge>
          </span>
        )}
      </div>
      {run.outputHeld && (
        <p className="mt-1 text-muted-foreground" data-output-held>
          {t("secrets.held")}
        </p>
      )}
      {!run.outputHeld && !run.stdout && !run.stderr && (
        <p className="mt-1 text-muted-foreground">{t("run.noOutputYet")}</p>
      )}
      <LiveOutput label={t("run.stdout")} text={run.stdout ?? ""} />
      <LiveOutput label={t("run.stderr")} text={run.stderr ?? ""} />
    </div>
  );
}

function Output({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <details className="mt-1" open={text.length < 2000}>
      <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </summary>
      <pre className="mt-1 max-h-80 overflow-auto border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
        {text}
      </pre>
    </details>
  );
}

function RunDetails({
  run,
  onComplete,
}: {
  run: Run;
  onComplete?: StepActions["complete"];
}) {
  const { t } = useTranslation();
  const [pasted, setPasted] = useState("");
  const [exitCode, setExitCode] = useState("");
  const enteredExit =
    exitCode.trim() !== "" && Number.isInteger(Number(exitCode))
      ? Number(exitCode)
      : null;
  const tone =
    run.status === "done"
      ? "success"
      : run.status === "failed"
        ? "destructive"
        : "warning";
  return (
    <div className="border-l-2 border-border pl-3 text-xs" data-run={run.id}>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <ListBadge tone={tone}>{t(`run.status.${run.status}`)}</ListBadge>
        <span>
          {t(
            run.mode === "manual"
              ? run.status === "done"
                ? "run.manualDone"
                : "run.manualFailed"
              : run.mode === "outside"
                ? run.status === "done"
                  ? "run.outsideDone"
                  : "run.outsideFailed"
                : run.mode === "agent"
                  ? run.status === "done"
                    ? "run.agentDone"
                    : "run.agentFailed"
                  : run.mode === "exec"
                    ? "run.byExec"
                    : "run.byTerminal",
            {
              user: run.userId,
              time: formatTime(run.startedAt),
            },
          )}
        </span>
        {run.exitCode !== null && (
          <span>{t("run.exit", { code: run.exitCode })}</span>
        )}
        {run.truncated && (
          <ListBadge tone="warning">{t("run.truncated")}</ListBadge>
        )}
        {run.timedOut && (
          <ListBadge tone="destructive">{t("run.timedOut")}</ListBadge>
        )}
        {run.startedEarlySeconds ? (
          <span data-started-early>
            <ListBadge tone="warning">
              {t("run.startedEarly", {
                time: formatWait(run.startedEarlySeconds),
              })}
            </ListBadge>
          </span>
        ) : null}
      </div>
      {run.mode !== "manual" && run.mode !== "agent" && (
        <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-muted-foreground">
          $ {run.command}
        </pre>
      )}
      {run.note && (
        <p className="mt-1 whitespace-pre-wrap" data-run-note>
          {t("run.note", { note: run.note })}
        </p>
      )}
      {run.stdin && (
        <p className="mt-1 text-muted-foreground" data-run-stdin>
          {t("stdin.label", {
            source: describeStdin(t, run.stdin, run.stdin.bytes),
          })}
        </p>
      )}
      {run.error && <p className="mt-1 text-destructive">{run.error}</p>}
      {run.running ? (
        <LiveRun run={run} />
      ) : (
        <>
          <Output label={t("run.stdout")} text={run.stdout} />
          <Output label={t("run.stderr")} text={run.stderr} />
        </>
      )}
      <Output label={t("run.pasted")} text={run.pastedOutput} />
      {(run.secrets?.used.length ?? 0) > 0 && (
        <p className="mt-1 text-muted-foreground" data-run-secrets-used>
          {t("secrets.runUsed", { names: run.secrets!.used.join(", ") })}
        </p>
      )}
      {(run.secrets?.captured.length ?? 0) > 0 && (
        <p className="mt-1 text-muted-foreground" data-run-secrets-stored>
          {t("secrets.runStored", {
            names: run.secrets!.captured.map((entry) => entry.name).join(", "),
          })}
        </p>
      )}
      {Object.keys(run.captured ?? {}).length > 0 && (
        <p className="mt-1 text-muted-foreground">
          {t("run.captured")}{" "}
          {Object.entries(run.captured)
            .map(([name, value]) => `${name}=${value}`)
            .join(", ")}
        </p>
      )}
      {onComplete && run.status === "awaiting-output" && (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder={t("run.pastePlaceholder")}
            className="min-h-24 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              value={exitCode}
              onChange={(event) => setExitCode(event.target.value)}
              placeholder={t("run.exitPlaceholder")}
              aria-label={t("run.exitPlaceholder")}
              className="h-8 w-36 text-xs"
            />
            <Button
              size="sm"
              // Done needs what the terminal printed: one line at least.
              disabled={pasted.trim() === ""}
              title={pasted.trim() === "" ? t("run.pasteFirst") : undefined}
              onClick={() => onComplete(run, pasted, "done", enteredExit)}
            >
              {t("run.markDone")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onComplete(run, pasted, "failed", enteredExit)}
            >
              {t("run.markFailed")}
            </Button>
          </div>
          {pasted.trim() === "" && (
            <p className="text-xs text-muted-foreground" data-paste-first>
              {t("run.pasteFirst")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function StepCard({
  step,
  isNext,
  runbookOpen,
  busy,
  actions,
  secrets = [],
  agentLabel = "",
  canSendToAgent = false,
}: {
  step: Step;
  isNext: boolean;
  runbookOpen: boolean;
  busy: boolean;
  actions: StepActions;
  /** The secrets this step captures, and whether each is stored now. */
  secrets?: SecretState[];
  /** Who the runbook belongs to, for an agent step. */
  agentLabel?: string;
  /** Agent notifications are on and the runbook has an owner. */
  canSendToAgent?: boolean;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(step.ownerNote);
  const [editingNote, setEditingNote] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const [showEarlier, setShowEarlier] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [outsideOutput, setOutsideOutput] = useState("");
  const replaced = step.status === "replaced";
  // Done on a step with checks needs the output they read (1.4.1).
  const pasteFirst =
    (step.checks ?? []).length > 0 && outsideOutput.trim() === "";

  // Agent edits and polls must not wipe a note being typed.
  useEffect(() => {
    if (!editingNote) setNote(step.ownerNote);
  }, [step.ownerNote, editingNote]);

  const agentStep = step.owner === "agent";
  const [latest, ...earlier] = step.runs;
  const running = step.runs.some((run) => run.running);
  const waitLeft = useWaitRemaining(step.wait);
  const notYet = waitLeft > 0 && step.status === "pending";
  const wait = step.status === "pending" ? step.wait : null;
  const failedChecks =
    latest && !latest.running && step.status === "failed"
      ? (latest.checks ?? []).filter((check) => !check.ok)
      : [];
  const runnable =
    !running &&
    !replaced &&
    runbookOpen &&
    step.hostId !== null &&
    step.resolvedCommand !== null &&
    step.missing.length === 0 &&
    step.commandHash !== null;
  const stdin = step.stdin ?? null;
  const stdinSource = stdin
    ? describeStdin(t, stdin.source, stdin.bytes)
    : null;
  /** Send to terminal cannot give a command its standard input. */
  const blocked = Boolean(stdin?.problem || step.secretsProblem);
  const sendRefused = stdin
    ? t("stdin.useRun", { source: describeStdin(t, stdin.source) })
    : null;

  const header = (
    <header className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-muted-foreground" data-label>
        {stepLabel(step)}.
      </span>
      <h3
        className={cn(
          "text-sm font-semibold",
          replaced && "text-muted-foreground",
        )}
      >
        {step.title}
      </h3>
      <ListBadge tone={STATUS_TONE[step.status] ?? "muted"}>
        {t(`step.status.${step.status}`)}
      </ListBadge>
      {step.amendment && (
        <ListBadge tone="warning">{t("amend.badge")}</ListBadge>
      )}
      {isNext && <ListBadge tone="brand">{t("step.next")}</ListBadge>}
      {agentStep && (
        <span data-agent-step>
          <ListBadge tone="muted">{t("step.agentBadge")}</ListBadge>
        </span>
      )}
      {step.hideOutputFromAgents && (
        <ListBadge tone="muted">{t("step.hidden")}</ListBadge>
      )}
    </header>
  );

  const replacedLine = replaced && (
    <div
      className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      data-replaced-by={step.replacedBy?.label ?? ""}
    >
      <span>
        {step.replacedBy
          ? t("amend.replacedBy", { label: step.replacedBy.label })
          : t("amend.replaced")}
      </span>
      <button
        type="button"
        className="underline"
        aria-expanded={expanded}
        data-replaced-toggle
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? t("amend.hide") : t("amend.show")}
      </button>
    </div>
  );

  // A replaced step stays in the history, folded until the person opens it.
  if (replaced && !expanded) {
    return (
      <section
        className="border border-dashed border-border p-3 opacity-80"
        data-step={step.id}
        data-collapsed
      >
        {header}
        {replacedLine}
      </section>
    );
  }

  return (
    <section
      className={cn(
        "border border-border p-3",
        isNext && "border-accent-brand",
        replaced && "border-dashed",
      )}
      data-step={step.id}
      aria-current={isNext ? "step" : undefined}
    >
      {header}
      {replacedLine}
      <AmendmentNote step={step} />

      <Markdown source={step.body} className="mt-2" copyCode />

      {agentStep && step.command !== null && (
        <div className="mt-2" data-agent-command>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {step.hostName
              ? t("step.agentCommandOn", { host: step.hostName })
              : t("step.agentCommand")}
          </div>
          <pre className="mt-1 overflow-x-auto border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
            {step.resolvedCommand ?? step.command}
          </pre>
        </div>
      )}

      {!agentStep && step.where && step.command !== null && (
        <div className="mt-2" data-outside>
          <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span data-outside-where>
              {t("outside.where", { where: step.where })}
            </span>
            <CopyButton
              text={step.resolvedCommand ?? step.command}
              disabled={step.missing.length > 0}
              title={
                step.missing.length > 0
                  ? t("step.missing", { names: step.missing.join(", ") })
                  : undefined
              }
            />
          </div>
          <pre className="mt-1 overflow-x-auto border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
            {step.resolvedCommand ?? step.command}
          </pre>
          {step.missing.length > 0 && (
            <p className="mt-1 text-xs text-destructive">
              {t("step.missing", { names: step.missing.join(", ") })}
            </p>
          )}
          {runbookOpen && !replaced && step.status === "pending" && (
            <div className="mt-2 flex flex-col gap-2" data-outside-paste>
              <Textarea
                value={outsideOutput}
                onChange={(event) => setOutsideOutput(event.target.value)}
                placeholder={t("outside.pastePlaceholder")}
                aria-label={t("outside.pastePlaceholder")}
                className="min-h-20 font-mono text-xs"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-outside-mark="done"
                  disabled={busy || step.missing.length > 0 || pasteFirst}
                  title={pasteFirst ? t("run.pasteFirst") : undefined}
                  onClick={() =>
                    actions.manual(step, "done", note, outsideOutput)
                  }
                >
                  {t("step.done")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-outside-mark="failed"
                  disabled={busy || step.missing.length > 0}
                  onClick={() =>
                    actions.manual(step, "failed", note, outsideOutput)
                  }
                >
                  {t("step.failed")}
                </Button>
              </div>
              {pasteFirst && (
                <p className="text-xs text-muted-foreground" data-paste-first>
                  {t("run.pasteFirst")}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!agentStep && step.hostId !== null && (
        <div className="mt-2">
          <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span>
              {t("step.on", {
                host:
                  step.hostName ?? t("step.unknownHost", { id: step.hostId }),
              })}
            </span>
            {step.resolvedCommand && <CopyButton text={step.resolvedCommand} />}
          </div>
          <pre className="mt-1 overflow-x-auto border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
            {step.resolvedCommand ?? step.command}
          </pre>
          {step.missing.length > 0 && (
            <p className="mt-1 text-xs text-destructive">
              {t("step.missing", { names: step.missing.join(", ") })}
            </p>
          )}
          {stdin && (
            <p className="mt-1 text-xs text-muted-foreground" data-stdin>
              {t("stdin.label", { source: stdinSource })}
            </p>
          )}
          {secrets.map((secret) => (
            <p
              key={secret.name}
              className="mt-1 text-xs text-muted-foreground"
              data-secret={secret.name}
              data-secret-set={secret.set}
            >
              {t("secrets.captures", { name: secret.name })}
              {" · "}
              {secret.set && secret.expiresAt
                ? t("secrets.stored", { time: formatTime(secret.expiresAt) })
                : t("secrets.notStored")}
            </p>
          ))}
          {step.secretsProblem && (
            <p className="mt-1 text-xs text-destructive" data-secrets-problem>
              {step.secretsProblem}
            </p>
          )}
          {stdin?.problem && (
            <p className="mt-1 text-xs text-destructive" data-stdin-problem>
              {stdin.problem}
            </p>
          )}
        </div>
      )}

      {step.expect.trim() && (
        <div className="mt-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("step.expect")}
          </div>
          <Markdown source={step.expect} copyCode />
        </div>
      )}

      <ChecksList
        checks={step.checks ?? []}
        results={latest && !latest.running ? latest.checks : null}
        words={checksWords(t)}
      />

      {failedChecks.length > 0 && (
        <div
          role="alert"
          className="mt-2 border border-destructive/60 bg-destructive/10 p-2 text-xs"
          data-checks-failed
        >
          <p className="font-semibold text-destructive">
            {t("checks.failedTitle", { count: failedChecks.length })}
          </p>
          <ul className="mt-1 list-disc pl-4">
            {failedChecks.map((check, index) => (
              <li key={index}>
                {check.label}: {check.detail}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">{t("checks.failedHint")}</p>
        </div>
      )}

      {wait && (
        <div
          className={cn(
            "mt-2 text-xs",
            notYet ? "text-warning" : "text-muted-foreground",
          )}
          data-wait={
            !wait.previousEnded ? "later" : notYet ? "running" : "over"
          }
        >
          {!wait.previousEnded
            ? t("wait.later", {
                time: formatWait(wait.seconds),
                position: wait.previous.label ?? wait.previous.position,
              })
            : notYet
              ? t("wait.running", { time: formatDuration(waitLeft + 999) })
              : t("wait.over")}
          {wait.reason && (!wait.previousEnded || notYet) && (
            <span className="text-muted-foreground"> · {wait.reason}</span>
          )}
        </div>
      )}

      {step.skipReason && step.status === "skipped" && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("step.skippedBecause", { reason: step.skipReason })}
        </p>
      )}

      {(runbookOpen || canSendToAgent) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {runbookOpen && running && (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => actions.stop(step)}
            >
              {t("step.stop")}
            </Button>
          )}
          {runbookOpen && agentStep && step.status === "pending" && (
            <span
              className="self-center text-xs text-muted-foreground"
              data-agent-waiting
            >
              {t("step.agentWaiting", { label: agentLabel })}
            </span>
          )}
          {runbookOpen &&
            !agentStep &&
            !replaced &&
            step.hostId !== null &&
            step.command !== null && (
              <>
                <Button
                  size="sm"
                  variant={notYet ? "outline" : "default"}
                  className={cn(notYet && "opacity-60")}
                  data-not-yet={notYet || undefined}
                  disabled={!runnable || busy || blocked}
                  onClick={() => actions.run(step, notYet ? waitLeft : 0)}
                >
                  {t("step.run")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className={cn(notYet && "opacity-60")}
                  data-not-yet={notYet || undefined}
                  disabled={
                    !runnable || busy || blocked || Boolean(sendRefused)
                  }
                  title={sendRefused ?? undefined}
                  onClick={() => actions.send(step, notYet ? waitLeft : 0)}
                >
                  {t("step.send")}
                </Button>
              </>
            )}
          {runbookOpen &&
            !agentStep &&
            step.hostId === null &&
            step.command === null &&
            step.status === "pending" && (
              <>
                <Button
                  size="sm"
                  data-manual="done"
                  disabled={busy}
                  onClick={() => actions.manual(step, "done", note)}
                >
                  {t("step.done")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-manual="failed"
                  disabled={busy}
                  onClick={() => actions.manual(step, "failed", note)}
                >
                  {t("step.failed")}
                </Button>
              </>
            )}
          {runbookOpen &&
            (step.status === "pending" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setSkipping(true)}
              >
                {t("step.skip")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => actions.reopen(step)}
              >
                {t("step.reopen")}
              </Button>
            ))}
          {runbookOpen && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                actions.setHidden(step, !step.hideOutputFromAgents)
              }
            >
              {step.hideOutputFromAgents
                ? t("step.showToAgents")
                : t("step.hideFromAgents")}
            </Button>
          )}
          {canSendToAgent && (
            <Button
              size="sm"
              variant="ghost"
              data-send-to-agent
              disabled={busy}
              onClick={() => actions.sendToAgent(step)}
            >
              {t("step.sendToAgent")}
            </Button>
          )}
        </div>
      )}

      {runbookOpen && sendRefused && step.status === "pending" && (
        <p className="mt-1 text-xs text-muted-foreground" data-send-refused>
          {sendRefused}
        </p>
      )}

      {skipping && (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("step.skipReason")}
            className="min-h-12 text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                actions.skip(step, reason);
                setSkipping(false);
                setReason("");
              }}
            >
              {t("step.skip")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSkipping(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      {(step.sent ?? []).length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-xs" data-sent-history>
          {(step.sent ?? []).map((sent) => (
            <li
              key={sent.id}
              className="border-l-2 border-border pl-3 text-muted-foreground"
              data-sent={sent.id}
            >
              {t(sent.note ? "sendAgent.historyNote" : "sendAgent.history", {
                user: sent.createdBy,
                time: formatTime(sent.createdAt),
              })}
              {sent.note && (
                <p className="mt-0.5 whitespace-pre-wrap text-foreground">
                  {sent.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {latest && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("run.latest")}
          </div>
          <RunDetails run={latest} onComplete={actions.complete} />
          {earlier.length > 0 && (
            <div>
              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                onClick={() => setShowEarlier((open) => !open)}
              >
                {t("run.earlier", { count: earlier.length })}
              </button>
              {showEarlier && (
                <div className="mt-2 flex flex-col gap-2">
                  {earlier.map((run) => (
                    <RunDetails
                      key={run.id}
                      run={run}
                      onComplete={actions.complete}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("step.notes")}
        </div>
        <Textarea
          value={note}
          onFocus={() => setEditingNote(true)}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            setEditingNote(false);
            if (note !== step.ownerNote) actions.saveNote(step, note);
          }}
          placeholder={t("step.notesPlaceholder")}
          className="mt-1 min-h-12 text-xs"
        />
      </div>
    </section>
  );
}
