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
import type { Check, CheckResult, Run, Step, StepWait } from "./types";

export interface StepActions {
  run: (step: Step) => void;
  stop: (step: Step) => void;
  send: (step: Step) => void;
  skip: (step: Step, reason: string) => void;
  reopen: (step: Step) => void;
  saveNote: (step: Step, note: string) => void;
  setHidden: (step: Step, hidden: boolean) => void;
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
} as const;

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
      {!run.stdout && !run.stderr && (
        <p className="mt-1 text-muted-foreground">{t("run.noOutputYet")}</p>
      )}
      <LiveOutput label={t("run.stdout")} text={run.stdout ?? ""} />
      <LiveOutput label={t("run.stderr")} text={run.stderr ?? ""} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? t("step.copied") : t("step.copy")}
    </Button>
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
          {t(run.mode === "exec" ? "run.byExec" : "run.byTerminal", {
            user: run.userId,
            time: formatTime(run.startedAt),
          })}
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
      </div>
      <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-muted-foreground">
        $ {run.command}
      </pre>
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
}: {
  step: Step;
  isNext: boolean;
  runbookOpen: boolean;
  busy: boolean;
  actions: StepActions;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(step.ownerNote);
  const [editingNote, setEditingNote] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const [showEarlier, setShowEarlier] = useState(false);

  // Agent edits and polls must not wipe a note being typed.
  useEffect(() => {
    if (!editingNote) setNote(step.ownerNote);
  }, [step.ownerNote, editingNote]);

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
    runbookOpen &&
    step.hostId !== null &&
    step.resolvedCommand !== null &&
    step.missing.length === 0 &&
    step.commandHash !== null;

  return (
    <section
      className={cn(
        "border border-border p-3",
        isNext && "border-accent-brand",
      )}
      data-step={step.id}
      aria-current={isNext ? "step" : undefined}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {step.position}.
        </span>
        <h3 className="text-sm font-semibold">{step.title}</h3>
        <ListBadge tone={STATUS_TONE[step.status]}>
          {t(`step.status.${step.status}`)}
        </ListBadge>
        {isNext && <ListBadge tone="brand">{t("step.next")}</ListBadge>}
        {step.hideOutputFromAgents && (
          <ListBadge tone="muted">{t("step.hidden")}</ListBadge>
        )}
      </header>

      <Markdown source={step.body} className="mt-2" />

      {step.hostId !== null && (
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
        </div>
      )}

      {step.expect.trim() && (
        <div className="mt-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("step.expect")}
          </div>
          <Markdown source={step.expect} />
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
                position: wait.previous.position,
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

      {runbookOpen && (
        <div className="mt-3 flex flex-wrap gap-2">
          {running && (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => actions.stop(step)}
            >
              {t("step.stop")}
            </Button>
          )}
          {step.hostId !== null && step.command !== null && (
            <>
              <Button
                size="sm"
                variant={notYet ? "outline" : "default"}
                className={cn(notYet && "opacity-60")}
                data-not-yet={notYet || undefined}
                disabled={!runnable || busy}
                onClick={() => actions.run(step)}
              >
                {t("step.run")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={cn(notYet && "opacity-60")}
                data-not-yet={notYet || undefined}
                disabled={!runnable || busy}
                onClick={() => actions.send(step)}
              >
                {t("step.send")}
              </Button>
            </>
          )}
          {step.status === "pending" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSkipping(true)}
            >
              {step.hostId === null ? t("step.markRead") : t("step.skip")}
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
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => actions.setHidden(step, !step.hideOutputFromAgents)}
          >
            {step.hideOutputFromAgents
              ? t("step.showToAgents")
              : t("step.hideFromAgents")}
          </Button>
        </div>
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
              {step.hostId === null ? t("step.markRead") : t("step.skip")}
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
