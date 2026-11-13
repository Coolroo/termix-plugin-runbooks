import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import {
  createRunbookLink,
  RUNBOOK_VIEW,
  takePendingRunbook,
} from "./runbooks/deep-link";
import { createRunbooksTab, RunbooksIcon } from "./runbooks/tab";
import { NotifySetting } from "./agents/NotifySetting";
import { AdminStepColors, UserStepColors } from "./kinds/StepColorsSetting";

const TAB_ID = "runbooks";

export function activate(app: TermixApp): void {
  app.registerRailItem({
    id: TAB_ID,
    icon: RunbooksIcon,
    titleKey: "tab.title",
    kind: "tab",
    permission: "use",
  });
  app.registerTab(TAB_ID, createRunbooksTab(app), {
    icon: RunbooksIcon,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
    // `?view=runbook&id=<id>` links, which agents hand to people.
    standalone: createRunbookLink(app),
    standaloneViews: [RUNBOOK_VIEW],
  });
  // The signing secret and Test button of agent notifications (1.4.0).
  app.registerSettingsComponent("notify-secret", NotifySetting);
  // A color per kind of step (1.4.1), for everyone and for each person.
  app.registerSettingsComponent("step-colors", AdminStepColors);
  app.registerSettingsComponent("step-colors-user", UserStepColors);
  // A runbook link went through the full-screen view to the app: open the
  // Runbooks tab on it once the shell has its tabs back.
  app.tabs.onReady(() => {
    const runbookId = takePendingRunbook();
    if (runbookId === null) return;
    app.tabs.openTab(null, TAB_ID, {
      data: { runbookId, requestedAt: Date.now() },
    });
  });
}
