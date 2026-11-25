/** A run of a step: its status, command, output, and Mark done or failed. */

import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Input,
  ListBadge,
  PluginIcon,
  Textarea,
} from "@termix-ssh/plugin-sdk/ui";
import {
  describeStdin,
  formatDuration,
  formatTime,
  formatWait,
  runSummaryKey,
} from "../ui/format";
import { useFetchedAt, useTick } from "../ui/timers";
import { CodeBlock, PasteFirstHint, SectionLabel } from "../ui/ui";
import { RunInput } from "../running/RunInput";
import { useCapturedOutput } from "../running/use-captured-output";
import type { CaptureRead } from "../running/terminal-capture";
import type { StepActions } from "./StepButtons";
import type { Run, Step } from "../api-types";

/** What typing into a running command needs (1.4.6). */
interface InputProps {
  step?: Pick<Step, "interactive" | "timeoutMs">;
  onInput?: StepActions["input"];
}

/** A silence this long is shown as a warning: the command may be stuck. */
const SILENCE_WARN_MS = 30_000;

/**
 * Output that grows while the command runs. It follows the end, unless the
 * person scrolled up to read something.
 */
function LiveOutput({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <div className="mt-1">
      <SectionLabel>{label}</SectionLabel>
      <CodeBlock
        ref={ref}
        data-live-output={label}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 16;
        }}
        className="mt-1 max-h-80 overflow-auto"
      >
        {text}
      </CodeBlock>
    </div>
  );
}

/**
 * The running command: elapsed time, silence, its output so far, and the
 * line to type into it.
 */
function LiveRun({ run, step, onInput }: { run: Run } & InputProps) {
  const { t } = useTranslation();
  useTick();
  // The server's counts were true when this run was fetched; time moves on
  // from there on this clock, so a clock that is off does not matter.
  const fetchedAt = useFetchedAt(run);
  const since = Date.now() - fetchedAt;
  const startedAt = Date.parse(run.startedAt);
  const elapsed =
    (run.elapsedMs ?? (Number.isNaN(startedAt) ? 0 : fetchedAt - startedAt)) +
    since;
  const silent = (run.silentMs ?? elapsed - since) + since;
  const warn = silent >= SILENCE_WARN_MS;
  return (
    <div className="mt-1" data-live-run={run.id}>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span data-elapsed>
          {t("run.elapsed", { time: formatDuration(elapsed) })}
        </span>
        {silent >= 1000 && (
          <span data-silence={warn ? "warn" : "ok"}>
            <ListBadge tone={warn ? "warning" : "muted"}>
              {t("run.silent", { seconds: Math.floor(silent / 1000) })}
            </ListBadge>
          </span>
        )}
      </div>
      {run.outputHeld && (
        <p className="mt-1 text-muted-foreground" data-output-held>
          {t("secrets.held")}
        </p>
      )}
      {!run.outputHeld && !run.stdout && !run.stderr && (
        <p className="mt-1 text-muted-foreground">{t("run.noOutputYet")}</p>
      )}
      <LiveOutput label={t("run.stdout")} text={run.stdout ?? ""} />
      <LiveOutput label={t("run.stderr")} text={run.stderr ?? ""} />
      {step && onInput && (
        <RunInput run={run} step={step} elapsedMs={elapsed} onInput={onInput} />
      )}
    </div>
  );
}

function Output({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <details className="mt-1" open={text.length < 2000}>
      <SectionLabel as="summary" className="cursor-pointer">
        {label}
      </SectionLabel>
      <CodeBlock className="mt-1 max-h-80 overflow-auto">{text}</CodeBlock>
    </details>
  );
}

/**
 * Above a paste box that Send to terminal filled (1.4.9): where the text is
 * from, and Read again. It only fills the box, so it always asks the person
 * to check the text, and never says the command finished (BUG-021).
 */
function CaptureNote({
  read,
  edited,
  onReadAgain,
}: {
  read: CaptureRead;
  edited: boolean;
  onReadAgain: () => void;
}) {
  const { t } = useTranslation();
  const state = read.passwordPrompt ? "password" : "check";
  return (
    <div className="flex flex-col gap-1" data-capture>
      <p className="text-muted-foreground">{t("capture.from")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span data-capture-state={state}>
          <ListBadge tone="warning">{t(`capture.${state}`)}</ListBadge>
        </span>
        <Button
          size="xs"
          variant="outline"
          className="gap-1"
          onClick={onReadAgain}
          data-capture-read
        >
          <PluginIcon
            name="RefreshCw"
            className="size-3.5 shrink-0"
            aria-hidden="true"
          />
          {t("capture.readAgain")}
        </Button>
      </div>
      {read.drawn && (
        <p className="text-warning" data-capture-warning="drawn">
          {t("capture.drawn")}
        </p>
      )}
      {edited && (
        <p className="text-muted-foreground" data-capture-edited>
          {t("capture.edited")}
        </p>
      )}
      {read.truncated && (
        <p className="text-muted-foreground" data-capture-cut>
          {t("capture.cut")}
        </p>
      )}
    </div>
  );
}

export function RunDetails({
  run,
  onComplete,
  step,
  onInput,
}: {
  run: Run;
  onComplete?: StepActions["complete"];
} & InputProps) {
  const { t } = useTranslation();
  const awaiting =
    !!onComplete && run.status === "awaiting-output" && run.mode !== "vm";
  const box = useCapturedOutput(run.id, awaiting && run.mode === "terminal");
  const pasted = box.text;
  const [exitCode, setExitCode] = useState("");
  const enteredExit =
    exitCode.trim() !== "" && Number.isInteger(Number(exitCode))
      ? Number(exitCode)
      : null;
  const tone =
    run.status === "done"
      ? "success"
      : run.status === "failed"
        ? "destructive"
        : "warning";
  return (
    <div className="border-l-2 border-border pl-3 text-xs" data-run={run.id}>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <ListBadge tone={tone}>{t(`run.status.${run.status}`)}</ListBadge>
        <span>
          {t(runSummaryKey(run), {
            user: run.userId,
            time: formatTime(run.startedAt),
            name: run.secrets?.made?.name ?? "",
          })}
        </span>
        {run.exitCode !== null && (
          <span>{t("run.exit", { code: run.exitCode })}</span>
        )}
        {run.truncated && (
          <ListBadge tone="warning">{t("run.truncated")}</ListBadge>
        )}
        {run.timedOut && (
          <ListBadge tone="destructive">{t("run.timedOut")}</ListBadge>
        )}
        {run.startedEarlySeconds ? (
          <span data-started-early>
            <ListBadge tone="warning">
              {t("run.startedEarly", {
                time: formatWait(run.startedEarlySeconds),
              })}
            </ListBadge>
          </span>
        ) : null}
      </div>
      {run.mode !== "manual" &&
        run.mode !== "agent" &&
        run.mode !== "secret" &&
        run.mode !== "decision" &&
        run.mode !== "vm" && (
          <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-muted-foreground">
            $ {run.command}
          </pre>
        )}
      {run.mode === "vm" && (
        <p
          className="mt-1 font-mono text-[11px] text-muted-foreground"
          data-run-vm
        >
          {t("run.vmAction", { action: run.command })}
        </p>
      )}
      {run.note && (
        <p className="mt-1 whitespace-pre-wrap" data-run-note>
          {t("run.note", { note: run.note })}
        </p>
      )}
      {run.stdin && (
        <p className="mt-1 text-muted-foreground" data-run-stdin>
          {t("stdin.label", {
            source: describeStdin(t, run.stdin, run.stdin.bytes),
          })}
        </p>
      )}
      {run.error && <p className="mt-1 text-destructive">{run.error}</p>}
      {run.running ? (
        <LiveRun run={run} step={step} onInput={onInput} />
      ) : (
        <>
          <Output label={t("run.stdout")} text={run.stdout} />
          <Output label={t("run.stderr")} text={run.stderr} />
        </>
      )}
      <Output
        label={
          run.outputSource === "captured"
            ? t("run.source.captured")
            : run.outputSource === "captured-edited"
              ? t("run.source.capturedEdited")
              : t("run.pasted")
        }
        text={run.pastedOutput}
      />
      {(run.inputs?.length ?? 0) > 0 && (
        <p className="mt-1 text-muted-foreground" data-run-inputs>
          {t("run.input.count", { count: run.inputs.length })}
        </p>
      )}
      {(run.secrets?.used.length ?? 0) > 0 && (
        <p className="mt-1 text-muted-foreground" data-run-secrets-used>
          {t("secrets.runUsed", { names: run.secrets!.used.join(", ") })}
        </p>
      )}
      {(run.secrets?.captured.length ?? 0) > 0 && (
        <p className="mt-1 text-muted-foreground" data-run-secrets-stored>
          {t("secrets.runStored", {
            names: run.secrets!.captured.map((entry) => entry.name).join(", "),
          })}
        </p>
      )}
      {Object.keys(run.captured ?? {}).length > 0 && (
        <p className="mt-1 text-muted-foreground">
          {t("run.captured")}{" "}
          {Object.entries(run.captured)
            .map(([name, value]) => `${name}=${value}`)
            .join(", ")}
        </p>
      )}
      {/* A VM step's console ends with its own Done or Failed (1.4.7). */}
      {awaiting && (
        <div className="mt-2 flex flex-col gap-2">
          {box.read && (
            <CaptureNote
              read={box.read}
              edited={box.edited}
              onReadAgain={box.readAgain}
            />
          )}
          <Textarea
            value={pasted}
            onChange={(event) => box.change(event.target.value)}
            onFocus={box.open}
            placeholder={t("run.pastePlaceholder")}
            className="min-h-24 font-mono text-xs"
            data-paste-box={box.read ? box.source : "pasted"}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              value={exitCode}
              onChange={(event) => setExitCode(event.target.value)}
              placeholder={t("run.exitPlaceholder")}
              aria-label={t("run.exitPlaceholder")}
              className="h-8 w-36 text-xs"
            />
            <Button
              size="sm"
              // Done needs what the terminal printed: one line at least.
              disabled={pasted.trim() === ""}
              title={pasted.trim() === "" ? t("run.pasteFirst") : undefined}
              onClick={() =>
                onComplete!(run, pasted, "done", enteredExit, box.source)
              }
            >
              {t("run.markDone")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              // The read text goes with a failure only once the person
              // opened or changed the box (BUG-019); otherwise none.
              onClick={() =>
                onComplete!(
                  run,
                  box.failed.text,
                  "failed",
                  enteredExit,
                  box.failed.source,
                )
              }
              data-mark-failed
            >
              {t("run.markFailed")}
            </Button>
          </div>
          {box.read && box.failed.text === "" && pasted.trim() !== "" && (
            <p className="text-muted-foreground" data-capture-failed-hint>
              {t("capture.failedEmpty")}
            </p>
          )}
          {pasted.trim() === "" && <PasteFirstHint />}
        </div>
      )}
    </div>
  );
}
