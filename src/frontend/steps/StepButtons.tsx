/**
 * A step's buttons: Stop, Run, Send to terminal, Done or Failed for a step
 * with no command, Skip (with its reason) or Reopen, hide from agents and
 * Send to agent. The card works out what the step allows and passes it in.
 */

import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, Textarea, cn } from "@termix-ssh/plugin-sdk/ui";
import { isAgentStep } from "../../shared/steps";
import { OutcomeButtons } from "../ui/ui";
import type { Run, Step } from "../api-types";

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
  /**
   * Make it (no value) or Save (the value a person pasted) on a secret
   * step (1.4.2). Resolves true when the server stored it.
   */
  secret: (step: Step, value?: string) => Promise<boolean>;
  complete: (
    run: Run,
    pasted: string,
    outcome: "done" | "failed",
    exitCode: number | null,
  ) => void;
}

export function StepButtons({
  step,
  runbookOpen,
  busy,
  actions,
  canSendToAgent,
  agentLabel,
  note,
  running,
  runnable,
  blocked,
  sendRefused,
  notYet,
  waitLeft,
}: {
  step: Step;
  runbookOpen: boolean;
  busy: boolean;
  actions: StepActions;
  canSendToAgent: boolean;
  /** Who the runbook belongs to, for an agent step. */
  agentLabel: string;
  /** The note being typed: Done or Failed by hand keeps it. */
  note: string;
  /** A run of the step is running now. */
  running: boolean;
  /** Run and Send to terminal may run the command now. */
  runnable: boolean;
  /** Its standard input or its secrets are not there. */
  blocked: boolean;
  /** Why Send to terminal cannot give the command its input; null if it can. */
  sendRefused: string | null;
  /** The step's wait timer still runs. */
  notYet: boolean;
  waitLeft: number;
}) {
  const { t } = useTranslation();
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const agentStep = isAgentStep(step);
  const replaced = step.status === "replaced";
  return (
    <>
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
            !step.secretStep &&
            step.hostId === null &&
            step.command === null &&
            step.status === "pending" && (
              <OutcomeButtons
                attr="data-manual"
                disabled={busy}
                onOutcome={(outcome) => actions.manual(step, outcome, note)}
              />
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
    </>
  );
}
