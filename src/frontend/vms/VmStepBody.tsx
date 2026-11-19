import { useCallback, useEffect, useState } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, ListBadge, cn } from "@termix-ssh/plugin-sdk/ui";
import { formatDuration, formatTime, formatWait } from "../ui/format";
import { OutcomeButtons } from "../ui/ui";
import { errorMessage } from "../api-types";
import {
  vmAddress,
  vmValueNames,
  type VmSpec,
  type VmStepState,
} from "../../shared/vms";
import type { Step } from "../api-types";

/** The button's words: the action, and force for stop and restart (H5). */
export function vmButtonKey(spec: VmSpec): string {
  return spec.force
    ? `vm.button.${spec.action}Force`
    : `vm.button.${spec.action}`;
}

/** What the action does, in a line: the force words for force. */
function doesKey(spec: VmSpec): string {
  return spec.force ? `vm.does.${spec.action}Force` : `vm.does.${spec.action}`;
}

const STATE_TONE: Record<string, "success" | "muted" | "warning"> = {
  running: "success",
  off: "muted",
  starting: "warning",
  stopping: "warning",
};

/**
 * The body of a VM step (1.4.7): the host, the VM, what the action does,
 * the VM's state now (HAW's show, read when the card opens), "the host
 * refuses this" before anything is pressed, one button named for the
 * action (red for force), the live state while it waits, and Done or
 * Failed after a console.
 */
export function VmStepBody({
  step,
  runbookOpen,
  busy,
  onPress,
  onEnd,
}: {
  step: Step;
  runbookOpen: boolean;
  busy: boolean;
  onPress: (step: Step, state: VmStepState | null) => void;
  onEnd: (step: Step, outcome: "done" | "failed") => void;
}) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const spec = step.vm!;
  const host = step.vmHostName ?? `#${spec.host}`;
  const [state, setState] = useState<VmStepState | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const latest = step.runs[0];
  const running = Boolean(latest?.running);
  const consoleOpen =
    latest?.mode === "vm" && latest.status === "awaiting-output";
  // Read again once a run ends: the state changed.
  const ended = latest && !latest.running ? latest.id : 0;

  const read = useCallback(async () => {
    if (step.vmProblem) return;
    setReading(true);
    try {
      setState((await api.get<VmStepState>(`/steps/${step.id}/vm`)).data);
      setReadError(null);
    } catch (error) {
      setReadError(errorMessage(error, t("vm.readFailed")));
    } finally {
      setReading(false);
    }
  }, [api, step.id, step.vmProblem, t]);

  useEffect(() => {
    void read();
  }, [read, ended]);

  const vm = state?.vm ?? null;
  const problem =
    step.vmProblem ?? (state && !state.ready ? state.reason : null);
  const refused = state?.refused ?? null;
  const open = runbookOpen && step.status !== "replaced";
  const blocked =
    !open ||
    busy ||
    running ||
    Boolean(problem) ||
    Boolean(refused) ||
    step.missing.length > 0;
  const names = vmValueNames(spec);
  /** The last line of a VM run's output: the state now, or the summary. */
  const lastLine = () =>
    (latest?.stdout ?? "").trimEnd().split("\n").at(-1) ?? "";
  const progress = running ? lastLine() : "";
  // The latest run's outcome, once it ended (the console ends by hand).
  const result =
    latest &&
    latest.mode === "vm" &&
    !running &&
    (latest.status === "done" || latest.status === "failed") &&
    spec.action !== "console"
      ? lastLine()
      : "";

  return (
    <div className="mt-2 flex flex-col gap-2 text-sm" data-vm={spec.action}>
      <div className="border border-border bg-muted/20 p-2" data-vm-target>
        <p className="text-xs text-muted-foreground">
          {t("vm.target", { host })}
        </p>
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-semibold" data-vm-name>
            {spec.name}
          </span>
          {vm ? (
            <span data-vm-state={vm.state}>
              <ListBadge tone={STATE_TONE[vm.state] ?? "muted"}>
                {t(`vm.state.${vm.state}`)}
              </ListBadge>
            </span>
          ) : reading ? (
            <span className="text-xs text-muted-foreground" data-vm-reading>
              {t("vm.reading")}
            </span>
          ) : null}
          {vm && (
            <span className="text-xs text-muted-foreground" data-vm-facts>
              {[
                t("vm.cpus", { count: vm.cpus }),
                t("vm.memory", { size: (vm.memoryMB / 1024).toFixed(1) }),
                vmAddress(vm),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          {!step.vmProblem && (
            <button
              type="button"
              className="ml-auto text-xs text-muted-foreground underline"
              disabled={reading}
              onClick={() => void read()}
              data-vm-read
            >
              {state
                ? t("vm.readAgain", { time: formatTime(state.at) })
                : t("vm.read")}
            </button>
          )}
        </p>
      </div>

      <p
        className={cn(spec.force && "font-medium text-destructive")}
        data-vm-does
      >
        {t(doesKey(spec), { name: spec.name, host })}
        {spec.waitFor && (
          <>
            {" "}
            {t("vm.waits", {
              state: t(`vm.state.${spec.waitFor}`),
              time: formatWait(spec.waitSeconds),
            })}
          </>
        )}
      </p>
      {names.length > 0 && (
        <p className="text-xs text-muted-foreground" data-vm-values>
          {t("vm.sets", { names: names.map((n) => `{{${n}}}`).join(", ") })}
        </p>
      )}

      {problem && (
        <p
          className="text-xs text-destructive"
          data-vm-problem={state?.code ?? "no-haw"}
        >
          {problem}
        </p>
      )}
      {readError && (
        <p className="text-xs text-destructive" data-vm-read-error>
          {readError}
        </p>
      )}
      {refused && (
        <p className="text-xs font-medium text-destructive" data-vm-refused>
          {refused}
        </p>
      )}

      {running && (
        <p className="text-xs" role="status" data-vm-waiting>
          <span className="font-medium">
            {spec.waitFor
              ? t("vm.waiting", { state: t(`vm.state.${spec.waitFor}`) })
              : t("vm.working")}
          </span>{" "}
          <span className="font-mono">{progress}</span>{" "}
          <span className="text-muted-foreground">
            {formatDuration(latest.elapsedMs ?? 0)}
          </span>
        </p>
      )}

      {result && (
        <p
          className={cn(
            "text-xs font-medium",
            latest.status === "failed" && "text-destructive",
          )}
          data-vm-result={latest.status}
        >
          {latest.status === "failed" && latest.error
            ? latest.error
            : t("vm.result", { summary: result })}
        </p>
      )}

      {consoleOpen ? (
        <div className="flex flex-col gap-2" data-vm-console-open>
          <p className="text-xs">{t("vm.consoleOpen")}</p>
          {open && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || Boolean(problem)}
                onClick={() => onPress(step, state)}
                data-vm-button
              >
                {t("vm.button.consoleAgain")}
              </Button>
              <OutcomeButtons
                attr="data-vm-end"
                disabled={busy}
                onOutcome={(outcome) => onEnd(step, outcome)}
              />
            </div>
          )}
        </div>
      ) : (
        open && (
          <div>
            <Button
              size="sm"
              variant={spec.force ? "destructive" : "default"}
              disabled={blocked}
              onClick={() => onPress(step, state)}
              data-vm-button
              data-force={spec.force || undefined}
            >
              {t(vmButtonKey(spec))}
            </Button>
          </div>
        )
      )}
    </div>
  );
}
