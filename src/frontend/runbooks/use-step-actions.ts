/**
 * What every step button does (StepActions): the confirms and questions
 * before a run, then the request. Built on the runbook's one kit
 * (useRunbook), so every action shares its busy flag and its errors.
 */

import type { ReactNode, RefObject } from "react";
import {
  usePluginApi,
  useTranslation,
  type TermixApp,
  type useShell,
} from "@termix-ssh/plugin-sdk/frontend";
import { useConfirm } from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { isOutsideStep, stepLabel } from "../../shared/steps";
import type { StepActions } from "../steps/StepButtons";
import { blockingText, earlyTitle } from "../ui/format";
import { useTerminalSend } from "../running/use-terminal-send";
import { useSecretAttempt } from "../secrets/use-secret-attempt";
import {
  commandDetails,
  repeatDetails,
  runDetails,
  usePromptRequest,
} from "./prompts";
import type { Flags, RunbookKit } from "./use-runbook";
import type { Run, Step } from "../api-types";

export function useStepActions(
  app: TermixApp,
  kit: RunbookKit,
  /** The shell, kept in a ref: a send outlives the render that started it. */
  shellRef: RefObject<ReturnType<typeof useShell>>,
) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  const {
    runbook,
    watched,
    load,
    withBusy,
    postAndShow,
    postRunbook,
    postThenLoad,
    sendAsking,
  } = kit;

  /** The open early-start question, if any. */
  const [early, askEarlyPrompt] = usePromptRequest<
    { title: string; details: ReactNode },
    boolean
  >();
  /** The open Send to agent dialog, if any. */
  const [sending, askSend] = usePromptRequest<
    { step: Step; label: string },
    string | null
  >();

  /**
   * Asks before a start while the step's wait timer runs: one question,
   * Cancel first. Resolves true for Start anyway.
   */
  const askEarly = (
    step: Step,
    leftMs: number,
    withDetails: boolean,
    reason: string = step.wait?.reason ?? "",
  ) =>
    askEarlyPrompt({
      title: earlyTitle(t, leftMs, reason),
      details: withDetails ? runDetails(t, step) : commandDetails(t, step),
    });

  /** Posts a run or a send, asking about a repeat, a wait or the order. */
  const attempt = (
    mode: "run" | "terminal",
    step: Step,
    flags: Flags = {},
  ): Promise<Run | null> =>
    sendAsking(
      async (more) =>
        (
          await api.post<Run>(`/steps/${step.id}/${mode}`, {
            revision: step.revision,
            commandHash: step.commandHash,
            ...more,
          })
        ).data,
      {
        question: (conflict) => {
          switch (conflict.code) {
            case "repeat": {
              // A Run's repeat always names the run before.
              const repeat = conflict.repeat;
              if (!repeat) return null;
              return confirm({
                title: t(
                  repeat.sameStep ? "repeat.titleStep" : "repeat.titleHash",
                ),
                description: repeatDetails(t, repeat, step),
                confirmLabel: t("repeat.again"),
                destructive: false,
              });
            }
            case "wait":
              return askEarly(
                step,
                conflict.remainingSeconds * 1000,
                mode === "run",
                conflict.reason ?? "",
              );
            case "order":
              return confirm({
                title: t("order.title"),
                description: t("order.hint", {
                  steps: blockingText(conflict.blocking),
                }),
                confirmLabel: t("order.anyway"),
                destructive: false,
              });
          }
        },
      },
      flags,
    );

  const secretAttempt = useSecretAttempt(kit);
  const send = useTerminalSend(app, shellRef, kit, attempt, askEarly);

  const actions: StepActions = {
    secret: (step, value) => withBusy(() => secretAttempt(step, value)),

    run: (step, waitLeftMs = 0) =>
      void withBusy(async () => {
        // Early on a wait timer: one question, and it is about the wait.
        let flags: Flags = {};
        if (waitLeftMs > 0) {
          if (!(await askEarly(step, waitLeftMs, true))) return;
          flags = { waitAnyway: true };
        } else {
          const ok = await confirm({
            title: t("run.confirmTitle", { position: stepLabel(step) }),
            description: runDetails(t, step),
            confirmLabel: t("run.confirm"),
            destructive: false,
          });
          if (!ok) return;
        }
        const run = await attempt("run", step, flags);
        if (run) {
          if (run.running || run.status === "running") {
            watched.current.add(run.id);
          } else if (run.status === "done") toast.success(t("run.ok"));
          else toast.error(t("run.notOk"));
        }
        await load();
      }),

    stop: (step) =>
      void withBusy(async () => {
        const ok = await confirm({
          title: t("stop.title", { position: stepLabel(step) }),
          description: t("stop.hint"),
          confirmLabel: t("stop.confirm"),
          destructive: true,
        });
        if (!ok) return;
        await postThenLoad(`/steps/${step.id}/stop`);
      }),

    send,

    skip: (step, reason) => postRunbook(`/steps/${step.id}/skip`, { reason }),

    manual: (step, outcome, note, output) =>
      postRunbook(`/steps/${step.id}/manual`, {
        outcome,
        note,
        // A step run outside Termix: bound to the revision shown.
        ...(isOutsideStep(step)
          ? { output: output ?? "", revision: step.revision }
          : {}),
      }),

    reopen: (step) => postRunbook(`/steps/${step.id}/reopen`),

    sendToAgent: (step) =>
      void withBusy(async () => {
        const label = runbook?.agentLabel ?? "";
        const note = await askSend({ step, label });
        if (note === null) return;
        await postAndShow(`/steps/${step.id}/send-to-agent`, { note }, () =>
          toast.success(t("sendAgent.sent", { label })),
        );
      }),

    // Not busy: the note saves while the person goes on.
    saveNote: (step, note) =>
      void postThenLoad(`/steps/${step.id}/note`, { ownerNote: note }),

    setHidden: (step, hidden) =>
      postRunbook(`/steps/${step.id}/hide`, { hidden }),

    complete: (run, pasted, outcome, exitCode) =>
      void withBusy(() =>
        postThenLoad<Run>(
          `/runs/${run.id}/complete`,
          {
            pastedOutput: pasted,
            outcome,
            ...(exitCode !== null ? { exitCode } : {}),
          },
          (data) => {
            if (outcome === "done" && data?.status === "failed") {
              toast.error(t("checks.failedToast"));
            }
          },
        ),
      ),
  };

  return { actions, early, sending };
}
