import { useId, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, cn } from "@termix-ssh/plugin-sdk/ui";
import { CopyButton } from "./CopyButton";
import { SecretValueField } from "./SecretValueField";
import type { ByHand, SecretStoreField, Step } from "./types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "the runbook's secrets for 7 days", "your library: mine/db", ... */
export function describeStore(t: Translate, store: SecretStoreField): string {
  if (store === "runbook") return t("secretStep.store.runbook");
  if ("library" in store) {
    const shared = store.library.startsWith("shared/");
    const path = store.library.replace(/^(mine|shared)\//, "");
    const base = t(
      shared ? "secretStep.store.shared" : "secretStep.store.mine",
      { path },
    );
    return store.expires
      ? `${base} ${t("secretStep.store.expires", { count: store.expires })}`
      : base;
  }
  return t("secretStep.store.app", { app: store.app, field: store.field });
}

/** Engine, path and field, each with a Copy button. */
export function ByHandPlace({ place }: { place: ByHand }) {
  const { t } = useTranslation();
  const rows: Array<[string, string]> = [
    [t("secretStep.byHand.engine"), place.engine],
    [t("secretStep.byHand.path"), place.path],
    [t("secretStep.byHand.field"), place.field],
  ];
  return (
    <dl
      className="mt-1 grid max-w-2xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5"
      data-by-hand-place
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all font-mono">{value}</dd>
          <dd>
            <CopyButton text={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The body of a Make a secret or Ask for a secret step (1.4.2). Ready: what
 * the step makes or asks for, where it goes, and Make it or Save. By hand
 * (OpenBao Secrets not there or not connected, or an app path it cannot
 * write): the steps to do it in OpenBao or Vault, then Done or Failed. The
 * value never comes back from the server.
 */
export function SecretStepBody({
  step,
  runbookOpen,
  busy,
  onSecret,
  onManual,
}: {
  step: Step;
  runbookOpen: boolean;
  busy: boolean;
  /** Make it (no value) or Save (the value): true when it was stored. */
  onSecret: (step: Step, value?: string) => Promise<boolean>;
  onManual: (step: Step, outcome: "done" | "failed") => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [value, setValue] = useState("");
  const view = step.secretStep;
  const spec = step.generate ?? step.ask;
  if (!view || !spec) return null;
  const pending = runbookOpen && step.status === "pending";
  const make = view.kind === "generate" && step.generate;
  const what = make
    ? t(`secretStep.format.${step.generate!.format}`, {
        count: step.generate!.length,
      })
    : step.ask!.label;

  const heading = make ? (
    <p data-secret-what>
      {t("secretStep.makeWhat", { name: spec.name, what })}
    </p>
  ) : (
    <p data-secret-what>
      {t("secretStep.askWhat", { name: spec.name, label: step.ask!.label })}
    </p>
  );
  const where = (
    <p className="text-muted-foreground" data-secret-store>
      {t("secretStep.goesTo", { where: describeStore(t, spec.store) })}
    </p>
  );

  // A step that ended needs no instructions: later steps say where it is.
  if (view.mode === "by-hand" && step.status === "pending") {
    return (
      <div
        className="mt-2 flex flex-col gap-1.5 border border-border bg-muted/30 p-2.5 text-xs"
        data-secret-step={view.kind}
        data-secret-mode="by-hand"
      >
        {heading}
        <p className="font-medium" data-by-hand-title>
          {t("secretStep.byHand.title")}
        </p>
        {view.reason && (
          <p className="text-muted-foreground" data-by-hand-reason>
            {view.reason}
          </p>
        )}
        <ol className="ml-4 flex list-decimal flex-col gap-1">
          <li>
            {make
              ? t("secretStep.byHand.generate", { what })
              : t("secretStep.byHand.get", { label: step.ask!.label })}
          </li>
          <li>
            {t("secretStep.byHand.save")}
            <ByHandPlace place={view.byHand} />
          </li>
          <li>{t("secretStep.byHand.done")}</li>
        </ol>
        {pending && (
          <div className="mt-1 flex flex-wrap gap-2">
            <Button
              size="sm"
              data-manual="done"
              disabled={busy}
              onClick={() => onManual(step, "done")}
            >
              {t("step.done")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-manual="failed"
              disabled={busy}
              onClick={() => onManual(step, "failed")}
            >
              {t("step.failed")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="mt-2 flex flex-col gap-1.5 border border-border bg-muted/30 p-2.5 text-xs"
      data-secret-step={view.kind}
      data-secret-mode="ready"
    >
      {heading}
      {where}
      {step.status !== "pending" && spec.store === "runbook" && (
        <p
          className={cn(!view.set && "text-muted-foreground")}
          data-secret-set={view.set}
        >
          {view.set && view.expiresAt
            ? t("secretStep.storedUntil", {
                name: spec.name,
                time: new Date(view.expiresAt).toLocaleString(),
              })
            : t("secretStep.notStored", { name: spec.name })}
        </p>
      )}
      {pending && make && (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground">{t("secretStep.makeHint")}</p>
          <Button
            size="sm"
            className="self-start"
            data-make-secret
            disabled={busy}
            onClick={() => void onSecret(step)}
          >
            {t("secretStep.make")}
          </Button>
        </div>
      )}
      {pending && !make && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId} className="font-medium">
            {step.ask!.label}
          </label>
          <SecretValueField
            id={fieldId}
            value={value}
            onChange={setValue}
            disabled={busy}
            ariaLabel={step.ask!.label}
          />
          {step.ask!.pattern && (
            <p className="text-muted-foreground" data-ask-pattern>
              {t("secretStep.pattern", { pattern: step.ask!.pattern })}
            </p>
          )}
          <p className="text-muted-foreground">{t("secretStep.askHint")}</p>
          <Button
            size="sm"
            className="self-start"
            data-save-secret
            disabled={busy || value.trim() === ""}
            onClick={() =>
              void onSecret(step, value).then((saved) => {
                if (saved) setValue("");
              })
            }
          >
            {t("secretStep.save")}
          </Button>
        </div>
      )}
    </div>
  );
}
