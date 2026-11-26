import { cn } from "@termix-ssh/plugin-sdk/ui";
import { describeCheck } from "../../shared/checks";
import { SectionLabel } from "../ui/ui";
import type { Check, CheckResult } from "../api-types";

const CHECK_MARK = { pending: "○", ok: "✓", failed: "✗" } as const;

/** The words ChecksList shows, from the caller's translations. */
export interface ChecksWords {
  title: string;
  pending: string;
  ok: string;
  failed: string;
}

export function checksWords(t: (key: string) => string): ChecksWords {
  return {
    title: t("checks.title"),
    pending: t("checks.state.pending"),
    ok: t("checks.state.ok"),
    failed: t("checks.state.failed"),
  };
}

/**
 * A step's checks: pending before a run (and while it runs), then a tick or
 * a cross with what was found. It uses no hooks, so a confirm dialog, which
 * renders outside the plugin, can show it too.
 */
export function ChecksList({
  checks,
  results,
  words,
}: {
  checks: Check[];
  results?: CheckResult[] | null;
  words: ChecksWords;
}) {
  if (checks.length === 0) return null;
  return (
    <div className="mt-2" data-checks>
      <SectionLabel>{words.title}</SectionLabel>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {checks.map((check, index) => {
          const result = results?.[index];
          const state = !result ? "pending" : result.ok ? "ok" : "failed";
          return (
            <li
              key={index}
              data-check-state={state}
              className="flex items-baseline gap-2"
            >
              <span
                aria-label={words[state]}
                className={cn(
                  "w-3 shrink-0 font-mono",
                  state === "ok" && "text-emerald-500",
                  state === "failed" && "text-destructive",
                  state === "pending" && "text-muted-foreground",
                )}
              >
                {CHECK_MARK[state]}
              </span>
              <span>
                {result?.label ?? check.label ?? describeCheck(check)}
                {result && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {result.detail}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The patterns a run applies to the output (BUG-014): each capture and
 * secret capture with its pattern, so the person sees what reads the
 * output before it runs; for a step, and for each item of a sequence
 * (BUG-022 L3). No hooks, as ChecksList.
 */
export function CapturesList({
  t,
  captures,
  secretCaptures = [],
}: {
  t: (key: string, options?: Record<string, unknown>) => string;
  captures: ReadonlyArray<{ name: string; pattern: string }>;
  secretCaptures?: ReadonlyArray<{ name: string; pattern: string }>;
}) {
  const rows = [
    ...captures.map((capture) => ({
      kind: "value",
      label: t("captures.value", { name: capture.name }),
      pattern: capture.pattern,
    })),
    ...secretCaptures.map((capture) => ({
      kind: "secret",
      label: t("captures.secret", { name: capture.name }),
      pattern: capture.pattern,
    })),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="mt-2" data-confirm-captures>
      <SectionLabel>{t("captures.title")}</SectionLabel>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {rows.map((row, index) => (
          <li
            key={index}
            data-confirm-capture={row.kind}
            className="flex items-baseline gap-2"
          >
            <span className="shrink-0">{row.label}</span>
            <code className="font-mono break-all text-muted-foreground">
              {row.pattern}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}
