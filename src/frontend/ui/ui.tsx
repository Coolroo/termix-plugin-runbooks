/**
 * Small pieces the screens share: a section's label, a code box, a
 * command with its label, the Done and Failed pair, the shown-once box and
 * a runbook's status. SectionLabel and CodeBlock use no hooks, so a
 * confirm dialog, which renders outside the plugin, can show them too.
 */

import type { HTMLAttributes, ReactNode, Ref } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, ListBadge } from "@termix-ssh/plugin-sdk/ui";
import type { Translate } from "../../shared/step-kinds";
import { CopyButton } from "./CopyButton";
import { formatTime } from "./format";
import type { RunbookStatus, RunbookSummary } from "../api-types";

const SECTION_LABEL =
  "text-[11px] uppercase tracking-wider text-muted-foreground";

/** Classes before the label's own, such as a row's layout. */
const withClasses = (base: string, before?: string) =>
  before ? `${before} ${base}` : base;

/** "YOU SHOULD SEE", "NOTES": the small capitals over a part of a card. */
export function SectionLabel({
  as: Tag = "div",
  className,
  children,
  ...rest
}: {
  as?: "div" | "span" | "summary" | "legend";
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={withClasses(SECTION_LABEL, className)} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * Text in a monospace box with a border, wrapped. `className` sets its
 * place and scrolling; `small` (the default) makes the text extra small.
 */
export function CodeBlock({
  className,
  small = true,
  ref,
  children,
  ...rest
}: {
  className: string;
  small?: boolean;
  ref?: Ref<HTMLPreElement>;
  children: ReactNode;
} & HTMLAttributes<HTMLPreElement>) {
  return (
    <pre
      ref={ref}
      className={`${className} border border-border bg-muted/40 p-2 font-mono${small ? " text-xs" : ""} whitespace-pre-wrap break-all`}
      {...rest}
    >
      {children}
    </pre>
  );
}

/**
 * A step's command under its label. With `copy` (a Copy button, or null
 * for none now), the label and the button share one row. `children` come
 * after the command.
 */
export function CommandBlock({
  label,
  copy,
  command,
  children,
  ...rest
}: {
  label: ReactNode;
  copy?: ReactNode;
  command: string | null;
  children?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="mt-2" {...rest}>
      {copy === undefined ? (
        <SectionLabel>{label}</SectionLabel>
      ) : (
        <SectionLabel className="flex items-center justify-between gap-2">
          {label}
          {copy}
        </SectionLabel>
      )}
      <CodeBlock className="mt-1 overflow-x-auto">{command}</CodeBlock>
      {children}
    </div>
  );
}

/**
 * Done and Failed for a step the person did by hand, each marked with
 * `attr` (data-manual or data-outside-mark) set to its outcome.
 * `doneHint`: why Done is off, as its title.
 */
export function OutcomeButtons({
  attr,
  disabled,
  doneHint = null,
  onOutcome,
}: {
  attr: "data-manual" | "data-outside-mark";
  disabled: boolean;
  doneHint?: string | null;
  onOutcome: (outcome: "done" | "failed") => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        size="sm"
        {...{ [attr]: "done" }}
        disabled={disabled || doneHint !== null}
        title={doneHint ?? undefined}
        onClick={() => onOutcome("done")}
      >
        {t("step.done")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        {...{ [attr]: "failed" }}
        disabled={disabled}
        onClick={() => onOutcome("failed")}
      >
        {t("step.failed")}
      </Button>
    </>
  );
}

/** "Paste the output first", said in words for a phone, where no title shows. */
export function PasteFirstHint() {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground" data-paste-first>
      {t("run.pasteFirst")}
    </p>
  );
}

/**
 * A value the server shows once (a token, a signing secret): what it is,
 * the value, Copy and Hide.
 */
export function ShownOnce({
  message,
  value,
  copyLabel,
  hideLabel,
  onHide,
  ...rest
}: {
  message: string;
  value: string;
  copyLabel?: string;
  hideLabel: string;
  onHide: () => void;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="border border-accent-brand p-3" {...rest}>
      <p className="text-xs">{message}</p>
      <pre className="mt-2 overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap">
        {value}
      </pre>
      <div className="mt-2 flex gap-2">
        <CopyButton
          text={value}
          label={copyLabel}
          size="sm"
          variant="default"
        />
        <Button size="sm" variant="ghost" onClick={onHide}>
          {hideLabel}
        </Button>
      </div>
    </div>
  );
}

/** Open, Done or Abandoned; open stands out. */
export function RunbookStatusBadge({ status }: { status: RunbookStatus }) {
  const { t } = useTranslation();
  return (
    <ListBadge tone={status === "open" ? "brand" : "muted"}>
      {t(`runbook.status.${status}`)}
    </ListBadge>
  );
}

/** "3/8 done · by lead · <time>". */
export function runbookMeta(
  t: Translate,
  runbook: Pick<RunbookSummary, "progress" | "createdBy" | "updatedAt">,
): string {
  return t("list.meta", {
    done: runbook.progress.done,
    total: runbook.progress.total,
    author: runbook.createdBy,
    time: formatTime(runbook.updatedAt),
  });
}

/** The runbooks could not be read, and nothing was read before. */
export function LoadError() {
  const { t } = useTranslation();
  return <p className="p-4 text-sm text-destructive">{t("error.load")}</p>;
}
