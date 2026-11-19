/**
 * What the questions before a VM step's action show (1.4.7), and opening
 * a VM's console in the Remote Desktop plugin, as HAW's own tab does.
 */

import type { ReactNode } from "react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import type { Translate } from "../../shared/step-kinds";
import type { VmStepState } from "../../shared/vms";
import { formatWait } from "../ui/format";
import type { Step } from "../api-types";

/** The Remote Desktop plugin's tab type, as HAW opens a console in it. */
const RDP_TAB = "rdp";

/** The confirm's details: host, VM, state now, and what will happen. */
export function vmDetails(
  t: Translate,
  step: Step,
  state: VmStepState | null,
): ReactNode {
  const spec = step.vm!;
  const host = step.vmHostName ?? `#${spec.host}`;
  return (
    <div className="flex flex-col gap-1 text-xs" data-vm-confirm>
      <span>{t("vm.target", { host })}</span>
      <span className="font-mono font-semibold">{spec.name}</span>
      {state?.vm && (
        <span>
          {t("vm.stateNow", { state: t(`vm.state.${state.vm.state}`) })}
        </span>
      )}
      <span className={spec.force ? "font-medium text-destructive" : undefined}>
        {t(
          spec.force ? `vm.does.${spec.action}Force` : `vm.does.${spec.action}`,
          {
            name: spec.name,
            host,
          },
        )}
        {spec.waitFor &&
          ` ${t("vm.waits", {
            state: t(`vm.state.${spec.waitFor}`),
            time: formatWait(spec.waitSeconds),
          })}`}
      </span>
      <span className="text-muted-foreground">{t("vm.asYou")}</span>
    </div>
  );
}

/**
 * Opens a VM's console host in a Remote Desktop tab. The host comes from
 * the app's list; without it, the Remote Desktop plugin or the host is
 * missing here, and a toast says so.
 */
export function consoleOpener(app: TermixApp, t: Translate) {
  return async (consoleHost: { id: number; name: string }, label: string) => {
    const record =
      app.getHost(consoleHost.id) ??
      (await app.listHosts()).find(
        (host) => String(host.id) === String(consoleHost.id),
      );
    if (!record) {
      toast.error(t("vm.noRd", { name: consoleHost.name }));
      return;
    }
    app.tabs.openTab(record, RDP_TAB, { label });
  };
}
