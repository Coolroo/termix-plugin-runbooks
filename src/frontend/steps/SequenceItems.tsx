/**
 * A sequence step's items (1.4.10), top to bottom: each with its number,
 * label, type, exact command (or "Wait 30 s: reason" for a delay), state
 * and the time it took. The item that runs streams its output as a run
 * does; a delay counts down with Skip. Before a run the list is the plan,
 * with values filled in; after one, the latest run's records.
 */

import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, ListBadge, cn } from "@termix-ssh/plugin-sdk/ui";
import { formatDuration, formatWait } from "../ui/format";
import { useFetchedAt, useTick } from "../ui/timers";
import { CodeBlock, SectionLabel } from "../ui/ui";
import { RunInput } from "../running/RunInput";
import { ChecksList, checksWords } from "./ChecksList";
import { LiveOutput, Output } from "./output";
import type { StepActions } from "./StepButtons";
import type {
  ItemStatus,
  ResolvedItem,
  Run,
  RunItem,
  Step,
} from "../api-types";

const STATUS_TONE: Record<
  ItemStatus | "not-run",
  "muted" | "warning" | "success" | "destructive" | "brand"
> = {
  waiting: "muted",
  "not-run": "muted",
  running: "brand",
  passed: "success",
  failed: "destructive",
  skipped: "warning",
};

/** What the item list shows of each item: its plan and its record. */
interface Row {
  position: number;
  plan: ResolvedItem | null;
  record: RunItem | null;
}

/** The plan with the latest run's records, matched by position. */
function rows(step: Step, run: Run | null): Row[] {
  const plan = step.resolvedSequence ?? [];
  const records = run?.items ?? [];
  const count = Math.max(plan.length, records.length);
  return Array.from({ length: count }, (_, index) => ({
    position: index + 1,
    plan: plan[index] ?? null,
    record: records.find((item) => item.position === index + 1) ?? null,
  }));
}

/** "1:05" from start to end, or to now for an item that runs. */
function took(record: RunItem, now: number): string | null {
  if (!record.startedAt) return null;
  const start = Date.parse(record.startedAt);
  const end = record.finishedAt ? Date.parse(record.finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return formatDuration(end - start);
}

/**
 * Time left of a running delay, on this page's clock: the server's time
 * when the run was read is its start plus elapsedMs.
 */
function delayLeft(run: Run, record: RunItem, fetchedAt: number): number {
  if (!record.plannedEndAt) return 0;
  const serverNow =
    run.elapsedMs !== null
      ? Date.parse(run.startedAt) + run.elapsedMs
      : fetchedAt;
  const left = Date.parse(record.plannedEndAt) - serverNow;
  return Math.max(0, left - (Date.now() - fetchedAt));
}

function ItemRow({
  row,
  run,
  step,
  busy,
  runbookOpen,
  fetchedAt,
  onSkipDelay,
  onInput,
}: {
  row: Row;
  run: Run | null;
  step: Step;
  busy: boolean;
  runbookOpen: boolean;
  fetchedAt: number;
  onSkipDelay?: () => void;
  onInput?: StepActions["input"];
}) {
  const { t } = useTranslation();
  const { plan, record } = row;
  const type = record?.type ?? plan?.type ?? "run";
  const runEnded = Boolean(run && !run.running);
  const status: ItemStatus | "not-run" = record
    ? record.status === "waiting" && runEnded
      ? "not-run"
      : record.status
    : "waiting";
  const running = status === "running";
  const label = record?.label ?? plan?.label ?? null;
  const onFail =
    record?.onFail ?? (plan?.type === "run" ? plan.onFail : "stop");
  const seconds =
    record?.seconds ?? (plan?.type === "delay" ? plan.seconds : 0);
  const reason =
    record?.reason ?? (plan?.type === "delay" ? plan.reason : null);
  const command =
    record?.command ?? (plan?.type === "run" ? plan.command : null);
  const checks = plan?.type === "run" ? plan.checks : [];
  const interactive = plan?.type === "run" ? plan.interactive : false;
  const time = record ? took(record, Date.now()) : null;
  const left =
    run && record && running && type === "delay"
      ? delayLeft(run, record, fetchedAt)
      : 0;
  return (
    <li
      className={cn(
        "border-l-2 py-1 pl-3",
        running ? "border-primary" : "border-border",
      )}
      data-item={row.position}
      data-item-type={type}
      data-item-status={status}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{row.position}.</span>
        <span className="font-medium" data-item-label>
          {label ?? t(`item.type.${type}`)}
        </span>
        {label && <ListBadge tone="muted">{t(`item.type.${type}`)}</ListBadge>}
        <ListBadge tone={STATUS_TONE[status]}>
          {t(`item.status.${status}`)}
        </ListBadge>
        {time && (
          <span className="text-muted-foreground" data-item-time>
            {time}
          </span>
        )}
        {onFail === "continue" && (
          <span className="text-muted-foreground" data-item-on-fail>
            {t("item.onFailContinue")}
          </span>
        )}
      </div>
      {type === "delay" ? (
        <p className="mt-1 text-xs" data-item-delay>
          {reason
            ? t("item.delayReason", { time: formatWait(seconds), reason })
            : t("item.delay", { time: formatWait(seconds) })}
        </p>
      ) : (
        <CodeBlock className="mt-1 overflow-x-auto" data-item-command>
          {command}
        </CodeBlock>
      )}
      {plan?.type === "run" && plan.later.length > 0 && !record?.startedAt && (
        <p className="mt-1 text-xs text-muted-foreground" data-item-later>
          {t("item.later", { names: plan.later.join(", ") })}
        </p>
      )}
      {record?.fromRunId !== null && record?.fromRunId !== undefined && (
        <p className="mt-1 text-xs text-muted-foreground" data-item-carried>
          {t("item.carried", { run: record.fromRunId })}
        </p>
      )}
      {running && type === "delay" && (
        <div
          className="mt-1 flex flex-wrap items-center gap-2 text-xs"
          data-item-countdown
        >
          <span className="text-warning">
            {t("item.left", { time: formatDuration(left + 999) })}
          </span>
          {runbookOpen && onSkipDelay && (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={onSkipDelay}
              data-skip-delay
            >
              {t("item.skip")}
            </Button>
          )}
        </div>
      )}
      {record?.skippedBy && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("item.skippedBy", { user: record.skippedBy })}
        </p>
      )}
      {record && type === "run" && running && (
        <div className="text-xs" data-item-live>
          {!record.stdout && !record.stderr && (
            <p className="mt-1 text-muted-foreground">{t("run.noOutputYet")}</p>
          )}
          <LiveOutput label={t("run.stdout")} text={record.stdout ?? ""} />
          <LiveOutput label={t("run.stderr")} text={record.stderr ?? ""} />
          {run && onInput && (
            <RunInput
              run={{ ...run, stdout: record.stdout, stderr: record.stderr }}
              step={{
                interactive,
                timeoutMs: plan?.type === "run" ? plan.timeoutMs : null,
              }}
              elapsedMs={
                record.startedAt ? Date.now() - Date.parse(record.startedAt) : 0
              }
              onInput={onInput}
            />
          )}
        </div>
      )}
      {record && !running && record.startedAt && (
        <div className="text-xs">
          <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
            {record.exitCode !== null && (
              <span>{t("run.exit", { code: record.exitCode })}</span>
            )}
            {record.truncated && (
              <ListBadge tone="warning">{t("run.truncated")}</ListBadge>
            )}
            {record.timedOut && (
              <ListBadge tone="destructive">{t("run.timedOut")}</ListBadge>
            )}
          </div>
          {record.error && (
            <p className="mt-1 text-destructive" data-item-error>
              {record.error}
            </p>
          )}
          <Output label={t("run.stdout")} text={record.stdout} />
          <Output label={t("run.stderr")} text={record.stderr} />
          {Object.keys(record.captured ?? {}).length > 0 && (
            <p className="mt-1 text-muted-foreground">
              {t("run.captured")}{" "}
              {Object.entries(record.captured)
                .map(([name, value]) => `${name}=${value}`)
                .join(", ")}
            </p>
          )}
        </div>
      )}
      <ChecksList
        checks={checks}
        results={running ? null : record?.checks}
        words={checksWords(t)}
      />
    </li>
  );
}

export function SequenceItems({
  step,
  run,
  busy,
  runbookOpen,
  onSkipDelay,
  onInput,
}: {
  step: Step;
  /** The latest run, when it is a sequence run; null before any. */
  run: Run | null;
  busy: boolean;
  runbookOpen: boolean;
  onSkipDelay?: () => void;
  onInput?: StepActions["input"];
}) {
  const { t } = useTranslation();
  const fetchedAt = useFetchedAt(run);
  useTick(Boolean(run?.running));
  const list = rows(step, run?.items ? run : null);
  return (
    <div className="mt-2" data-sequence>
      <SectionLabel>{t("item.title", { count: list.length })}</SectionLabel>
      <ol className="mt-1 flex flex-col gap-2">
        {list.map((row) => (
          <ItemRow
            key={row.position}
            row={row}
            run={run?.items ? run : null}
            step={step}
            busy={busy}
            runbookOpen={runbookOpen}
            fetchedAt={fetchedAt}
            onSkipDelay={onSkipDelay}
            onInput={onInput}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * An earlier sequence run's items in one line each: number, label, state
 * and time. The step card shows the latest run's items in full above.
 */
export function ItemSummary({ items }: { items: RunItem[] }) {
  const { t } = useTranslation();
  return (
    <ol className="mt-1 flex flex-col gap-0.5 text-[11px]" data-item-summary>
      {items.map((item) => (
        <li
          key={item.position}
          className="flex flex-wrap items-center gap-2 text-muted-foreground"
          data-item={item.position}
          data-item-status={item.status}
        >
          <span className="font-mono">{item.position}.</span>
          <span>{item.label ?? t(`item.type.${item.type}`)}</span>
          <span>· {t(`item.status.${item.status}`)}</span>
          {took(item, Date.now()) && <span>· {took(item, Date.now())}</span>}
          {item.exitCode !== null && (
            <span>· {t("run.exit", { code: item.exitCode })}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
