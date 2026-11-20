import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ListBadge,
  PluginIcon,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import { formatDuration, formatTime, formatWait } from "../ui/format";
import { useTick } from "../ui/timers";
import { OutcomeButtons } from "../ui/ui";
import { errorMessage } from "../api-types";
import {
  vmAddress,
  vmValueNames,
  type VmSpec,
  type VmStepState,
} from "../../shared/vms";
import type { Translate } from "../../shared/step-kinds";
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

/** A read this old is read again when the page shows again (BUG-017). */
export const VM_STALE_MS = 60_000;

/** "read just now", "read 3 min ago", "read 1 h 5 min ago". */
function readAge(t: Translate, ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1
    ? t("vm.readJustNow")
    : t("vm.readAgo", { time: formatWait(minutes * 60) });
}

/** An ISO time from this clock's milliseconds, for formatTime. */
const isoOf = (ms: number) => new Date(ms).toISOString();

/**
 * The body of a VM step (1.4.7): the host, the VM, what the action does,
 * the VM's state now (HAW's show) and how old that read is, "the host
 * refuses this" before anything is pressed, one button named for the
 * action (red for force), the live state while it waits, and Done or
 * Failed after a console.
 *
 * BUG-017: the card reads the VM when it opens, when a run of any step of
 * the runbook ends (an earlier step may make or change the VM), and when
 * the page shows again after a minute or more. One read at a time: a read
 * asked for during a read is done once, after it. A failed read, or a VM
 * HAW cannot act on now, shows in a box with its time and Read again.
 */
export function VmStepBody({
  step,
  runbookOpen,
  busy,
  lastRunEnd = null,
  isVisible = true,
  onPress,
  onEnd,
}: {
  step: Step;
  runbookOpen: boolean;
  busy: boolean;
  /** When the newest run of any step of the runbook ended (BUG-017). */
  lastRunEnd?: string | null;
  /** The runbook's tab shows (BUG-017). */
  isVisible?: boolean;
  onPress: (step: Step, state: VmStepState | null) => void;
  onEnd: (step: Step, outcome: "done" | "failed") => void;
}) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const spec = step.vm!;
  const host = step.vmHostName ?? `#${spec.host}`;
  const [state, setState] = useState<VmStepState | null>(null);
  /** When `state` came, on this clock. */
  const [stateAt, setStateAt] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<{
    message: string;
    at: number;
  } | null>(null);
  const latest = step.runs[0];
  const running = Boolean(latest?.running);
  const consoleOpen =
    latest?.mode === "vm" && latest.status === "awaiting-output";
  // Read again once a run of this step ends, or opens a console.
  const ended = latest && !latest.running ? latest.id : 0;
  /** A read is in flight; another was asked for during it. */
  const inFlight = useRef(false);
  const again = useRef(false);
  /** When the last read started; 0 before the first. */
  const lastTry = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (step.vmProblem) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    setReading(true);
    try {
      do {
        again.current = false;
        lastTry.current = Date.now();
        try {
          const { data } = await api.get<VmStepState>(`/steps/${step.id}/vm`);
          if (!mounted.current) return;
          setState(data);
          setStateAt(Date.now());
          setReadError(null);
        } catch (error) {
          if (!mounted.current) return;
          setReadError({
            message: errorMessage(error, t("vm.readFailed")),
            at: Date.now(),
          });
        }
      } while (again.current);
    } finally {
      inFlight.current = false;
      if (mounted.current) setReading(false);
    }
  }, [api, step.id, step.vmProblem, t]);

  useEffect(() => {
    void read();
  }, [read, ended, lastRunEnd]);

  // The page shows again (the browser's tab, or the runbook's own tab)
  // after a minute or more: the VM may have changed meanwhile. A read in
  // flight is new enough.
  const readIfStale = useCallback(() => {
    if (inFlight.current || !lastTry.current) return;
    if (Date.now() - lastTry.current >= VM_STALE_MS) {
      void read();
    }
  }, [read]);
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "visible") readIfStale();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [readIfStale]);
  const wasVisible = useRef(isVisible);
  useEffect(() => {
    if (isVisible && !wasVisible.current) readIfStale();
    wasVisible.current = isVisible;
  }, [isVisible, readIfStale]);

  // "read 3 min ago" moves on while the card shows.
  useTick(stateAt !== null, 15_000);

  const vm = state?.vm ?? null;
  const notReady = state && !state.ready ? state.reason : null;
  const problem = step.vmProblem ?? notReady;
  /** What the box says: a read that failed, or why HAW cannot act now. */
  const alert = step.vmProblem
    ? null
    : readError
      ? { title: readError.message, at: readError.at, code: "read-error" }
      : notReady && stateAt !== null
        ? { title: notReady, at: stateAt, code: state?.code ?? "not-ready" }
        : null;
  const readButton = (
    <Button
      size="xs"
      variant="outline"
      className="gap-1"
      disabled={reading}
      onClick={() => void read()}
      data-vm-read
    >
      <PluginIcon
        name="RefreshCw"
        className={cn("size-3.5 shrink-0", reading && "animate-spin")}
        aria-hidden="true"
      />
      {state || readError ? t("vm.readAgain") : t("vm.read")}
    </Button>
  );
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
          {vm && (
            <span data-vm-state={vm.state}>
              <ListBadge tone={STATE_TONE[vm.state] ?? "muted"}>
                {t(`vm.state.${vm.state}`)}
              </ListBadge>
            </span>
          )}
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
          {reading ? (
            <span className="text-xs text-muted-foreground" data-vm-reading>
              {t("vm.reading")}
            </span>
          ) : (
            stateAt !== null &&
            !alert && (
              <span
                className="text-xs text-muted-foreground"
                title={formatTime(isoOf(stateAt))}
                data-vm-age
              >
                {readAge(t, Date.now() - stateAt)}
              </span>
            )
          )}
          {!step.vmProblem && !alert && readButton}
        </p>
      </div>

      {alert && (
        <Alert
          variant="destructive"
          className="py-2"
          data-vm-alert={alert.code}
          data-vm-problem={readError ? undefined : alert.code}
          data-vm-read-error={readError ? "" : undefined}
        >
          <PluginIcon name="TriangleAlert" aria-hidden="true" />
          <AlertTitle data-vm-alert-title>{alert.title}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2 text-xs">
            <span data-vm-alert-time>
              {t("vm.readAt", { time: formatTime(isoOf(alert.at)) })}{" "}
              {t("vm.mayHaveChanged")}
            </span>
            {readButton}
          </AlertDescription>
        </Alert>
      )}

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

      {step.vmProblem && (
        <p className="text-xs text-destructive" data-vm-problem="no-haw">
          {step.vmProblem}
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
