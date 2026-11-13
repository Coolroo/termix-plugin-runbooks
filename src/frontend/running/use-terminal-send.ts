import type { RefObject } from "react";
import {
  useTranslation,
  type TermixApp,
  type useShell,
} from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import { hostLabel } from "../ui/format";
import { openSessionFor } from "./terminal";
import type { Flags, RunbookKit } from "../runbooks/use-runbook";
import type { Run, Step } from "../api-types";

/**
 * Send to terminal, in one click: find or open a terminal to the step's
 * host, then type the command there without pressing Enter. The run is
 * recorded only once a terminal is ready, so a terminal that never
 * connects leaves no run waiting for output.
 */
export function useTerminalSend(
  app: TermixApp,
  /** The shell, kept in a ref: a send outlives the render that started it. */
  shellRef: RefObject<ReturnType<typeof useShell>>,
  { withBusy, load }: Pick<RunbookKit, "withBusy" | "load">,
  /** Posts the send, asking about a repeat, a wait or the order. */
  attempt: (mode: "terminal", step: Step, flags: Flags) => Promise<Run | null>,
  /** Asks before a start while the step's wait timer runs. */
  askEarly: (
    step: Step,
    leftMs: number,
    withDetails: boolean,
  ) => Promise<boolean>,
) {
  const { t } = useTranslation();

  /** Brings a terminal tab to the front, or its split when it sits in one. */
  const showTab = (tabId: string) => {
    const tabs = shellRef.current?.tabs;
    const tab = tabs?.list.find((entry) => entry.id === tabId);
    if (!tabs || !tab) return;
    try {
      tabs.setActive(tab.parentSplitTabId ?? tab.id);
    } catch {
      // The command is typed already; the tab just stays where it is.
    }
  };

  return (step: Step, waitLeftMs = 0) =>
    void withBusy(async () => {
      let flags: Flags = {};
      if (waitLeftMs > 0) {
        if (!(await askEarly(step, waitLeftMs, false))) return;
        flags = { waitAnyway: true };
      }
      const session = await openSessionFor(app, step, t);
      if (!session) return;
      const run = await attempt("terminal", step, flags);
      if (!run) return;
      let sent = false;
      try {
        sent =
          (await app.invokeAction(
            "terminal.sendToSession",
            session.id,
            run.command,
            { run: false },
          )) === true;
      } catch {
        sent = false;
      }
      if (sent) {
        showTab(session.id);
        toast.success(t("terminal.sent", { host: hostLabel(t, step) }));
      } else {
        toast.error(t("terminal.sendFailed"));
      }
      await load();
    });
}
