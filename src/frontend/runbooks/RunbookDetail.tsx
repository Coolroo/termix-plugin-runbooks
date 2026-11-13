/**
 * One runbook: its title and status, values, the step cards with every
 * step action, the rail and the bar. Its data and requests come from
 * useRunbook, the step actions from useStepActions.
 */

import {
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  useShell,
  useTranslation,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, EmptyState } from "@termix-ssh/plugin-sdk/ui";
import { stepLabel, stepRef } from "../../shared/steps";
import { Markdown } from "../ui/Markdown";
import { StepCard } from "../steps/StepCard";
import { buttonForKey, pressedKey } from "../nav/bar-items";
import { StepRail, useNavSteps, useStepNav } from "../nav/StepNav";
import { NextStepBar, useBarContext } from "../nav/NextStepBar";
import { EarlyStartPrompt, SendToAgentPrompt } from "./prompts";
import { useRunbook } from "./use-runbook";
import { useStepActions } from "./use-step-actions";
import {
  LoadError,
  RunbookStatusBadge,
  runbookMeta,
  SectionLabel,
} from "../ui/ui";
import type { Runbook } from "../api-types";

export function RunbookDetail({
  app,
  id,
  isVisible,
  onMissing,
}: {
  app: TermixApp;
  id: number;
  isVisible: boolean;
  /** The runbook does not exist or this person may not see it. */
  onMissing: () => void;
}) {
  const { t } = useTranslation();
  // Made once here and shared by every action: one busy flag, one load.
  const kit = useRunbook(id, isVisible, onMissing);
  const { runbook, failed, busy, postRunbook } = kit;

  // The shell, kept in a ref: a send outlives the render that started it.
  const shell = useShell();
  const shellRef = useRef(shell);
  shellRef.current = shell;

  const { actions, early, sending } = useStepActions(app, kit, shellRef);

  const setStatus = (status: Runbook["status"]) =>
    postRunbook(`/runbooks/${id}/status`, { status });

  // The values the server fills commands with fill the steps' text too.
  const effective = runbook?.effectiveValues;
  const values = useMemo(
    () =>
      Object.fromEntries(
        (effective ?? []).map((entry) => [entry.name, entry.value]),
      ),
    [effective],
  );

  // The rail and the bar follow the steps on screen (1.4.4).
  const scroller = useRef<HTMLDivElement>(null);
  const nav = useStepNav(scroller, runbook?.steps ?? []);
  // Each step's kind, color and state, once for the cards, rail and bar.
  const navSteps = useNavSteps(runbook);
  const bar = useBarContext(
    runbook,
    navSteps,
    nav.view,
    nav.wide,
    nav.goTo,
    nav.toTop,
  );
  // A key of a button on the bar presses it (N: Go to step).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!bar) return;
    const button = buttonForKey(bar, pressedKey(event));
    if (!button) return;
    event.preventDefault();
    button.onClick(bar);
  };

  if (failed && !runbook) return <LoadError />;
  if (!runbook) return null;
  const open = runbook.status === "open";
  const hasSteps = runbook.steps.length > 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
      data-runbook-view
    >
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scroller}
          className="thin-scrollbar min-w-0 flex-1 overflow-y-auto"
          data-runbook-scroll
        >
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{runbook.title}</h2>
              <RunbookStatusBadge status={runbook.status} />
              <span className="text-xs text-muted-foreground">
                {runbookMeta(t, runbook)}
              </span>
              <span className="ml-auto flex gap-2">
                {open ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setStatus("done")}
                    >
                      {t("runbook.markDone")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setStatus("abandoned")}
                    >
                      {t("runbook.abandon")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setStatus("open")}
                  >
                    {t("runbook.reopen")}
                  </Button>
                )}
              </span>
            </div>

            {runbook.owner && (
              <p
                className="-mt-2 text-xs text-muted-foreground"
                data-runbook-owner
              >
                {runbook.owner.task
                  ? t("runbook.agentTask", {
                      label: runbook.agentLabel,
                      task: runbook.owner.task,
                    })
                  : t("runbook.agent", {
                      label: runbook.agentLabel,
                    })}
              </p>
            )}

            {early && <EarlyStartPrompt request={early} />}
            {sending && <SendToAgentPrompt request={sending} />}

            <Markdown source={runbook.summary} />

            {runbook.effectiveValues.length > 0 && (
              <div>
                <SectionLabel>{t("values.title")}</SectionLabel>
                <table className="mt-1 w-full border-collapse text-xs">
                  <tbody>
                    {runbook.effectiveValues.map((value) => (
                      <tr key={value.name} className="border-t border-border">
                        <td className="py-1 pr-2 font-mono">{value.name}</td>
                        <td className="py-1 pr-2 font-mono break-all">
                          {value.value}
                        </td>
                        <td className="py-1 text-muted-foreground">
                          {value.source === "author"
                            ? t("values.author")
                            : t("values.captured", {
                                position: (() => {
                                  const from = runbook.steps.find(
                                    (s) => s.id === value.stepId,
                                  );
                                  return from ? stepLabel(from) : "?";
                                })(),
                              })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {runbook.steps.length === 0 && (
              <EmptyState title={t("runbook.noSteps")} />
            )}
            <div className="flex flex-col gap-3">
              {navSteps.steps.map((item) => (
                <StepCard
                  key={item.step.id}
                  nav={item}
                  isNext={item.step.id === runbook.nextStepId}
                  runbookOpen={open}
                  busy={busy}
                  actions={actions}
                  secrets={(runbook.secrets ?? []).filter(
                    (secret) => secret.step === stepRef(item.step),
                  )}
                  canSendToAgent={Boolean(runbook.canSendToAgent)}
                  values={values}
                />
              ))}
            </div>
          </div>
        </div>
        {hasSteps && nav.wide && (
          <StepRail
            nav={navSteps}
            view={nav.view}
            height={nav.height}
            onGo={nav.goTo}
          />
        )}
      </div>
      {hasSteps && bar && <NextStepBar ctx={bar} />}
    </div>
  );
}
