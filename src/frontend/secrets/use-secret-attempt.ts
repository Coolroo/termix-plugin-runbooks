import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useConfirm } from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { blockingText, earlyTitle } from "../ui/format";
import type { RunbookKit } from "../runbooks/use-runbook";
import { errorBody, type Runbook, type Step } from "../api-types";

/**
 * Make it or Save on a secret step (1.4.2): asks about a repeat, the
 * order and a wait as Run does, in plain confirms, and sends again only
 * on an explicit yes. The value goes once, in this request, and never
 * comes back. Resolves true when the server stored it.
 */
export function useSecretAttempt({
  sendAsking,
  load,
  setRunbook,
}: Pick<RunbookKit, "sendAsking" | "load" | "setRunbook">) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  return async (step: Step, value: string | undefined): Promise<boolean> => {
    const name = (step.generate ?? step.ask)?.name ?? "";
    const again = (title: string, label: string, description?: string) =>
      confirm({
        title,
        ...(description ? { description } : {}),
        confirmLabel: label,
        destructive: false,
      });
    const data = await sendAsking(
      async (flags) =>
        (
          await api.post<Runbook>(`/steps/${step.id}/secret`, {
            revision: step.revision,
            ...(value !== undefined ? { value } : {}),
            ...flags,
          })
        ).data,
      {
        question: (conflict) => {
          switch (conflict.code) {
            case "repeat":
              return again(
                t(
                  step.generate
                    ? "secretStep.repeatMake"
                    : "secretStep.repeatSave",
                  { name },
                ),
                t(
                  step.generate
                    ? "secretStep.makeAgain"
                    : "secretStep.saveAgain",
                ),
              );
            case "wait":
              return again(
                earlyTitle(
                  t,
                  conflict.remainingSeconds * 1000,
                  conflict.reason ?? "",
                ),
                t("wait.anyway"),
              );
            case "order":
              return again(
                t("order.title"),
                t("secretStep.orderAnyway"),
                t("secretStep.orderHint", {
                  steps: blockingText(conflict.blocking),
                }),
              );
          }
        },
        // The page may now show the steps to do it by hand.
        refused: async (error) => {
          if (errorBody(error).status === 409) await load();
        },
      },
    );
    if (data === null) return false;
    setRunbook(data);
    toast.success(
      t(step.generate ? "secretStep.made" : "secretStep.saved", { name }),
    );
    return true;
  };
}
