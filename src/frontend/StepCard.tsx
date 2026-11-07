import { useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, ListBadge, Textarea, cn } from "@termix-ssh/plugin-sdk/ui";
import { Markdown } from "./Markdown";
import type { Run, Step } from "./types";

export interface StepActions {
  run: (step: Step) => void;
  send: (step: Step) => void;
  skip: (step: Step, reason: string) => void;
  reopen: (step: Step) => void;
  saveNote: (step: Step, note: string) => void;
  setHidden: (step: Step, hidden: boolean) => void;
  complete: (run: Run, pasted: string, outcome: "done" | "failed") => void;
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
      <Output label={t("run.stdout")} text={run.stdout} />
      <Output label={t("run.stderr")} text={run.stderr} />
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
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onComplete(run, pasted, "done")}>
              {t("run.markDone")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onComplete(run, pasted, "failed")}
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
  const runnable =
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

      {step.skipReason && step.status === "skipped" && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("step.skippedBecause", { reason: step.skipReason })}
        </p>
      )}

      {runbookOpen && (
        <div className="mt-3 flex flex-wrap gap-2">
          {step.hostId !== null && step.command !== null && (
            <>
              <Button
                size="sm"
                disabled={!runnable || busy}
                onClick={() => actions.run(step)}
              >
                {t("step.run")}
              </Button>
              <Button
                size="sm"
                variant="outline"
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
