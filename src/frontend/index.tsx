import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { createRunbooksTab, RunbooksIcon } from "./RunbooksTab";

export const TAB_ID = "runbooks";

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
  });
}
