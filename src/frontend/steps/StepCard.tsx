/**
 * One step of a runbook: its kind and status, text, command, checks, wait,
 * buttons (StepButtons.tsx), runs (RunDetails.tsx) and the owner's note.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { ListBadge, Textarea, cn } from "@termix-ssh/plugin-sdk/ui";
import { secretLabel } from "../../shared/names";
import { isAgentStep, isOutsideStep, stepLabel } from "../../shared/steps";
import { uniqueNames, type TextValues } from "../../shared/fill";
import { Markdown } from "../ui/Markdown";
import { CopyButton } from "../ui/CopyButton";
import { KindChip, kindStyle, MarkChip } from "../kinds/kinds";
import type { NavStep } from "../nav/StepNav";
import { ByHandPlace, SecretStepBody } from "../secrets/SecretStepBody";
import {
  describeStdin,
  formatDuration,
  formatTime,
  formatWait,
  hostLabel,
} from "../ui/format";
import { useWaitRemaining } from "../ui/timers";
import {
  CommandBlock,
  OutcomeButtons,
  PasteFirstHint,
  SectionLabel,
} from "../ui/ui";
import { ChecksList, checksWords } from "./ChecksList";
import { RunDetails } from "./RunDetails";
import { StepButtons, type StepActions } from "./StepButtons";
import { useStepText } from "./step-text";
import type { Step, SecretState } from "../api-types";

const STATUS_TONE = {
  pending: "muted",
  done: "success",
  failed: "destructive",
  skipped: "warning",
  replaced: "muted",
} as const;

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

const NO_VALUES: TextValues = {};

export function StepCard({
  nav,
  isNext,
  runbookOpen,
  busy,
  actions,
  secrets = [],
  canSendToAgent = false,
  values = NO_VALUES,
}: {
  /**
   * The step with its kind, marks, color and state, as the rail and the
   * bar see it (1.4.1, 1.4.4).
   */
  nav: NavStep;
  /**
   * The runbook's values (author values, then captures), as the server
   * fills the command with: they fill the step's text too (1.4.3).
   */
  values?: TextValues;
  isNext: boolean;
  runbookOpen: boolean;
  busy: boolean;
  actions: StepActions;
  /** The secrets this step captures, and whether each is stored now. */
  secrets?: SecretState[];
  /** Agent notifications are on and the runbook has an owner. */
  canSendToAgent?: boolean;
}) {
  const { step, kind, marks, color: kindColor, state, kindRunbook } = nav;
  /** Who the runbook belongs to, for an agent step. */
  const agentLabel = kindRunbook.agentLabel ?? "";
  const { t } = useTranslation();
  const [note, setNote] = useState(step.ownerNote);
  const [editingNote, setEditingNote] = useState(false);
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

  const text = useStepText(step, values);
  // One line names every value not set: the command's (it cannot run) and
  // the text's (it shows a marker; a step with no command can still end).
  const allMissing = uniqueNames(step.missing, text.missing);
  const missingLine = allMissing.length > 0 && (
    <p
      className={cn(
        "mt-1 text-xs",
        step.missing.length > 0 ? "text-destructive" : "text-warning",
      )}
      data-missing={allMissing.join(",")}
    >
      {t(step.missing.length > 0 ? "step.missing" : "step.missingText", {
        names: allMissing.join(", "),
      })}
    </p>
  );

  const agentStep = isAgentStep(step);
  // The command blocks below carry the line; other steps show it after
  // the expected result.
  const missingInBlock =
    !agentStep && (isOutsideStep(step) || step.hostId !== null);
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
      <KindChip
        kind={kind}
        step={step}
        runbook={kindRunbook}
        color={kindColor}
        state={state}
      />
      <ListBadge tone={STATUS_TONE[step.status] ?? "muted"}>
        {t(`step.status.${step.status}`)}
      </ListBadge>
      {marks.map((mark) => (
        <MarkChip key={mark.id} mark={mark} />
      ))}
      {step.amendment && (
        <ListBadge tone="warning">{t("amend.badge")}</ListBadge>
      )}
      {isNext && <ListBadge tone="brand">{t("step.next")}</ListBadge>}
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
        style={kindStyle.card(state, kindColor)}
        data-step={step.id}
        data-kind={kind.id}
        data-state={state}
        data-collapsed
        tabIndex={-1}
      >
        {header}
        {replacedLine}
      </section>
    );
  }

  return (
    <section
      className={cn(
        "border border-border p-3 outline-none focus-visible:ring-1 focus-visible:ring-ring",
        replaced && "border-dashed",
      )}
      style={kindStyle.card(state, kindColor)}
      data-step={step.id}
      data-kind={kind.id}
      data-state={state}
      aria-current={isNext ? "step" : undefined}
      // The bar and the rail move the focus here (1.4.4).
      tabIndex={-1}
    >
      {header}
      {replacedLine}
      <AmendmentNote step={step} />

      <Markdown source={text.body} className="mt-2" copyCode />

      {step.secretStep && (
        <SecretStepBody
          step={step}
          runbookOpen={runbookOpen && !replaced}
          busy={busy}
          onSecret={actions.secret}
          onManual={(target, outcome) => actions.manual(target, outcome, note)}
        />
      )}

      {agentStep && step.command !== null && (
        <CommandBlock
          data-agent-command
          label={
            step.hostName
              ? t("step.agentCommandOn", { host: step.hostName })
              : t("step.agentCommand")
          }
          command={step.resolvedCommand ?? step.command}
        />
      )}

      {!agentStep && isOutsideStep(step) && (
        <CommandBlock
          data-outside
          label={
            <span data-outside-where>
              {t("outside.where", { where: text.where })}
            </span>
          }
          copy={
            <CopyButton
              text={step.resolvedCommand ?? step.command}
              disabled={step.missing.length > 0}
              title={
                step.missing.length > 0
                  ? t("step.missing", { names: step.missing.join(", ") })
                  : undefined
              }
            />
          }
          command={step.resolvedCommand ?? step.command}
        >
          {missingLine}
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
                <OutcomeButtons
                  attr="data-outside-mark"
                  disabled={busy || step.missing.length > 0}
                  doneHint={pasteFirst ? t("run.pasteFirst") : null}
                  onOutcome={(outcome) =>
                    actions.manual(step, outcome, note, outsideOutput)
                  }
                />
              </div>
              {pasteFirst && <PasteFirstHint />}
            </div>
          )}
        </CommandBlock>
      )}

      {!agentStep && step.hostId !== null && (
        <CommandBlock
          label={<span>{t("step.on", { host: hostLabel(t, step) })}</span>}
          copy={
            step.resolvedCommand ? (
              <CopyButton text={step.resolvedCommand} />
            ) : null
          }
          command={step.resolvedCommand ?? step.command}
        >
          {missingLine}
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
          {stdin?.byHand && stdin.source.from === "secret" && (
            <div className="mt-1 text-xs" data-stdin-by-hand>
              <p>
                {t(
                  stdin.byHand.step
                    ? "secretStep.readByHandStep"
                    : "secretStep.readByHand",
                  {
                    name: secretLabel(stdin.source),
                    step: stdin.byHand.step,
                  },
                )}
              </p>
              <ByHandPlace place={stdin.byHand} />
            </div>
          )}
        </CommandBlock>
      )}

      {step.expect.trim() && (
        <div className="mt-2">
          <SectionLabel>{t("step.expect")}</SectionLabel>
          <Markdown source={text.expect} copyCode />
        </div>
      )}

      {!missingInBlock && missingLine}

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
                position: wait.previous.label,
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

      <StepButtons
        step={step}
        runbookOpen={runbookOpen}
        busy={busy}
        actions={actions}
        canSendToAgent={canSendToAgent}
        agentLabel={agentLabel}
        note={note}
        running={running}
        runnable={runnable}
        blocked={blocked}
        sendRefused={sendRefused}
        notYet={notYet}
        waitLeft={waitLeft}
      />

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
          <SectionLabel>{t("run.latest")}</SectionLabel>
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
        <SectionLabel>{t("step.notes")}</SectionLabel>
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
