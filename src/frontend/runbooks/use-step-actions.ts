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
import type { Run, Runbook, Step, VmPressed } from "../api-types";
import { vmButtonKey } from "../vms/VmStepBody";
import { consoleOpener, vmDetails } from "../vms/vm-prompts";

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
    setRunbook,
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

  /**
   * Asks before starting a step its rule says is not needed (1.4.6, D3):
   * Cancel first. Resolves true for Run anyway.
   */
  const askNotNeeded = (conflict: { rule: string; reason: string }) =>
    confirm({
      title: t("notNeeded.title"),
      description: t("notNeeded.hint", { ...conflict }),
      confirmLabel: t("notNeeded.anyway"),
      destructive: false,
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
            case "not-needed":
              return askNotNeeded(conflict);
            case "force":
              // Only a VM step asks about force (1.4.7).
              return null;
          }
        },
      },
      flags,
    );

  const secretAttempt = useSecretAttempt(kit);
  const openConsole = consoleOpener(app, t);
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
      void withBusy(async () => {
        // A step that is not needed asks "Run anyway?" first (1.4.6).
        const data = await sendAsking(
          async (flags) =>
            (
              await api.post<Runbook>(`/steps/${step.id}/manual`, {
                outcome,
                note,
                // A step run outside Termix: bound to the revision shown.
                ...(isOutsideStep(step)
                  ? { output: output ?? "", revision: step.revision }
                  : {}),
                ...flags,
              })
            ).data,
          {
            question: (conflict) =>
              conflict.code === "not-needed" ? askNotNeeded(conflict) : null,
          },
        );
        if (data) setRunbook(data);
      }),

    reopen: (step) => {
      // D8 (1.4.6): a new choice leaves the steps that ran on the old one.
      if (step.decisionRan.length === 0) {
        postRunbook(`/steps/${step.id}/reopen`);
        return;
      }
      void withBusy(async () => {
        const ok = await confirm({
          title: t("decision.reopenTitle"),
          description: t("decision.reopenHint", {
            steps: blockingText(step.decisionRan),
          }),
          confirmLabel: t("decision.reopen"),
          destructive: false,
        });
        if (ok) await postAndShow(`/steps/${step.id}/reopen`);
      });
    },

    decide: (step, chosen) =>
      void withBusy(async () => {
        const data = await sendAsking(
          async (flags) =>
            (
              await api.post<Runbook>(`/steps/${step.id}/decide`, {
                revision: step.revision,
                chosen,
                ...flags,
              })
            ).data,
          {
            question: (conflict) => {
              switch (conflict.code) {
                case "not-needed":
                  return askNotNeeded(conflict);
                case "order":
                  return confirm({
                    title: t("order.title"),
                    description: t("order.hint", {
                      steps: blockingText(conflict.blocking),
                    }),
                    confirmLabel: t("order.anyway"),
                    destructive: false,
                  });
                default:
                  return null;
              }
            },
          },
        );
        if (data) setRunbook(data);
      }),

    vm: (step, state) =>
      void withBusy(async () => {
        const spec = step.vm!;
        const button = t(vmButtonKey(spec));
        const ok = await confirm({
          title: t("vm.confirmTitle", { button, name: spec.name }),
          description: vmDetails(t, step, state),
          confirmLabel: button,
          destructive: spec.force,
        });
        if (!ok) return;
        const data = await sendAsking(
          async (flags) =>
            (
              await api.post<VmPressed>(`/steps/${step.id}/vm`, {
                revision: step.revision,
                ...flags,
              })
            ).data,
          {
            question: (conflict) => {
              switch (conflict.code) {
                case "force":
                  // H5: its own question, in red, after the first one.
                  return confirm({
                    title: t(`vm.forceTitle.${conflict.action}`, {
                      name: conflict.name,
                    }),
                    description: t("vm.forceHint"),
                    confirmLabel: button,
                    destructive: true,
                  });
                case "repeat": {
                  const repeat = conflict.repeat;
                  if (!repeat) return null;
                  return confirm({
                    title: t(
                      repeat.sameStep ? "repeat.titleStep" : "vm.repeatTitle",
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
                    false,
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
                case "not-needed":
                  return askNotNeeded(conflict);
              }
            },
          },
        );
        if (!data) {
          await load();
          return;
        }
        if (data.run.running || data.run.status === "running") {
          watched.current.add(data.run.id);
        }
        if (data.consoleHost) await openConsole(data.consoleHost, spec.name);
        await load();
      }),

    vmEnd: (step, outcome) =>
      postRunbook(`/steps/${step.id}/vm/end`, { outcome }),

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

    // Not behind the busy flag: Stop stays at hand while a prompt waits.
    input: async (run, text, hidden, end) => {
      let ok = false;
      await postThenLoad<Run>(
        `/runs/${run.id}/input`,
        { text, hidden, ...(end ? { end: true } : {}) },
        () => {
          ok = true;
        },
      );
      return ok;
    },
  };

  return { actions, early, sending };
}
