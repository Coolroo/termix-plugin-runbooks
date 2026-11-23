/**
 * The attempts of a wait item, or of a run item with retry (1.4.10, phase
 * 2), on the step card: the planned schedule before Run; while it runs, a
 * dot per attempt, "Attempt 7 of 120, 34 s of 3 min", a countdown to the
 * next attempt with Try now; and the attempts before the last one folded,
 * each opening to its output and check results. The last attempt's output
 * is the item's own (SequenceItems shows it).
 */

import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, cn } from "@termix-ssh/plugin-sdk/ui";
import type { Translate } from "../../shared/step-kinds";
import type { Schedule, SchedulePlan } from "../../shared/schedule";
import { formatDuration, formatWait } from "../ui/format";
import { ChecksList, checksWords } from "./ChecksList";
import { Output } from "./output";
import type { Check, RunAttempt, RunItem } from "../api-types";

/** How a dot looks: passed, not yet (a wait), failed (a retry), running. */
type DotState = "passed" | "not-yet" | "failed" | "running";

const DOT_CLASS: Record<DotState, string> = {
  passed: "bg-emerald-500",
  "not-yet": "bg-muted-foreground/40",
  failed: "bg-destructive",
  running: "bg-primary animate-pulse",
};

/**
 * A failed attempt of a wait means "not yet" (grey), unless it ended the
 * item (a stopIf match, a stop): that one, and every failed attempt of a
 * retried run item, is a failure (red).
 */
function dotState(attempt: RunAttempt, kind: RunItem["type"]): DotState {
  if (attempt.status === "running") return "running";
  if (attempt.status === "passed") return "passed";
  if (kind === "wait" && attempt.why !== "stop-if" && attempt.why !== "stopped")
    return "not-yet";
  return "failed";
}

/** "Up to 120 attempts, every 30 s, at most 1 h", in the page's words. */
export function scheduleText(
  t: Translate,
  schedule: Schedule,
  plan: SchedulePlan,
): string {
  const time = formatWait(schedule.every);
  const cap = formatWait(schedule.maxDelay);
  const delays =
    schedule.backoff === "linear"
      ? t("attempts.linear", { time, cap })
      : schedule.backoff === "exponential"
        ? t("attempts.exponential", { time, factor: schedule.factor, cap })
        : t("attempts.every", { time });
  const jitter =
    schedule.jitter === "none" ? "" : t(`attempts.jitter.${schedule.jitter}`);
  return t("attempts.schedule", {
    attempts: plan.attempts,
    delays: `${delays}${jitter}`,
    total: formatWait(plan.maxSeconds),
  });
}

/** Why an attempt did not pass, in words; null when it passed or runs. */
function whyText(t: Translate, attempt: RunAttempt): string | null {
  if (!attempt.why) return null;
  return attempt.why === "exit"
    ? t("attempts.why.exit", { code: attempt.exitCode ?? "-" })
    : t(`attempts.why.${attempt.why}`);
}

/** The plan before Run: the schedule, and a wait's stopIf checks. */
export function AttemptPlan({
  schedule,
  plan,
  stopIf,
}: {
  schedule: Schedule;
  plan: SchedulePlan;
  stopIf: Check[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="mt-1 text-xs text-muted-foreground" data-item-schedule>
        {scheduleText(t, schedule, plan)}
      </p>
      {stopIf.length > 0 && (
        <div data-stop-if>
          <ChecksList
            checks={stopIf}
            words={{ ...checksWords(t), title: t("attempts.stopIfTitle") }}
          />
        </div>
      )}
    </>
  );
}

/**
 * Time left until the next attempt, on this page's clock: the server's
 * time when the run was read is its start plus elapsedMs.
 */
export function nextLeft(
  serverNow: number,
  nextAttemptAt: string | null,
  fetchedAt: number,
): number {
  if (!nextAttemptAt) return 0;
  const left = Date.parse(nextAttemptAt) - serverNow;
  return Math.max(0, left - (Date.now() - fetchedAt));
}

/** The dots, the counter, the countdown and Try now, while it runs. */
export function AttemptProgress({
  record,
  serverNow,
  fetchedAt,
  busy,
  onTryNow,
}: {
  record: RunItem;
  /** The server's time when the run was read. */
  serverNow: number;
  fetchedAt: number;
  busy: boolean;
  onTryNow?: () => void;
}) {
  const { t } = useTranslation();
  const attempts = record.attempts ?? [];
  const running = record.status === "running";
  const now = serverNow + (Date.now() - fetchedAt);
  const started = record.startedAt ? Date.parse(record.startedAt) : now;
  const ends = record.endsBy ? Date.parse(record.endsBy) : null;
  const end = record.finishedAt ? Date.parse(record.finishedAt) : now;
  const elapsed = Math.max(0, Math.round((end - started) / 1000));
  const within = ends === null ? null : Math.round((ends - started) / 1000);
  const left = running
    ? nextLeft(serverNow, record.nextAttemptAt, fetchedAt)
    : 0;
  return (
    <div className="mt-1 text-xs" data-attempts>
      <div className="flex flex-wrap items-center gap-1" data-attempt-dots>
        {attempts.map((attempt) => {
          const state = dotState(attempt, record.type);
          return (
            <span
              key={attempt.attempt}
              title={[
                t("attempts.attempt", { attempt: attempt.attempt }),
                whyText(t, attempt) ?? t(`attempts.dot.${state}`),
              ].join(" · ")}
              aria-label={t(`attempts.dot.${state}`)}
              className={cn(
                "inline-block size-2 rounded-full",
                DOT_CLASS[state],
              )}
              data-attempt-dot={attempt.attempt}
              data-dot={state}
            />
          );
        })}
      </div>
      <p className="mt-1 text-muted-foreground" data-attempt-counter>
        {within === null
          ? t("attempts.counterNoLimit", {
              attempt: attempts.length,
              of: record.maxAttempts ?? attempts.length,
              elapsed: formatWait(elapsed),
            })
          : t("attempts.counter", {
              attempt: attempts.length,
              of: record.maxAttempts ?? attempts.length,
              elapsed: formatWait(elapsed),
              within: formatWait(within),
            })}
      </p>
      {running && record.nextAttemptAt && (
        <div
          className="mt-1 flex flex-wrap items-center gap-2"
          data-attempt-countdown
        >
          <span className="text-warning">
            {t("attempts.next", { time: formatDuration(left + 999) })}
          </span>
          {onTryNow && (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={onTryNow}
              data-try-now
            >
              {t("attempts.tryNow")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The attempts before the last one, folded: each opens to its output, its
 * check results and a stopIf match. The last attempt is the item's own
 * output and checks.
 */
export function EarlierAttempts({
  record,
  checks,
}: {
  record: RunItem;
  checks: Check[];
}) {
  const { t } = useTranslation();
  const earlier = (record.attempts ?? []).slice(0, -1);
  if (earlier.length === 0) return null;
  return (
    <details className="mt-1 text-xs" data-attempts-earlier>
      <summary className="cursor-pointer text-muted-foreground">
        {t("attempts.earlier", { count: earlier.length })}
      </summary>
      <ol className="mt-1 flex flex-col gap-1 border-l border-border pl-2">
        {[...earlier].reverse().map((attempt) => {
          const state = dotState(attempt, record.type);
          const took =
            attempt.finishedAt &&
            formatDuration(
              Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt),
            );
          const matched = (attempt.stopIf ?? []).filter((each) => each.ok);
          return (
            <li key={attempt.attempt} data-attempt={attempt.attempt}>
              <details>
                <summary className="cursor-pointer">
                  <span
                    className={cn(
                      "mr-1 inline-block size-2 rounded-full",
                      DOT_CLASS[state],
                    )}
                  />
                  {t("attempts.attempt", { attempt: attempt.attempt })}
                  <span className="text-muted-foreground">
                    {" · "}
                    {whyText(t, attempt) ?? t(`attempts.dot.${state}`)}
                    {took ? ` · ${took}` : ""}
                  </span>
                </summary>
                {attempt.error && (
                  <p className="mt-1 text-destructive">{attempt.error}</p>
                )}
                {matched.map((each, index) => (
                  <p
                    key={index}
                    className="mt-1 text-destructive"
                    data-stop-if-matched
                  >
                    {t("attempts.stopIfMatched", { label: each.label })}
                  </p>
                ))}
                <Output label={t("run.stdout")} text={attempt.stdout} />
                <Output label={t("run.stderr")} text={attempt.stderr} />
                <ChecksList
                  checks={checks}
                  results={attempt.checks}
                  words={checksWords(t)}
                />
              </details>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
