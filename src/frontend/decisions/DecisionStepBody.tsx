import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, cn } from "@termix-ssh/plugin-sdk/ui";
import { Markdown } from "../ui/Markdown";
import { formatTime } from "../ui/format";
import { choiceLabels, choiceProblem, inOrder } from "../../shared/decisions";
import type { Step } from "../api-types";

/**
 * The body of a Decision step (1.4.6): the author's options as radio cards
 * (or check boxes for a multiple choice) and Confirm, greyed out until the
 * choice is one the step takes. Once done, what the person chose, by whom
 * and when.
 */
export function DecisionStepBody({
  step,
  runbookOpen,
  busy,
  onDecide,
}: {
  step: Step;
  runbookOpen: boolean;
  busy: boolean;
  onDecide: (step: Step, chosen: string[]) => void;
}) {
  const { t } = useTranslation();
  const spec = step.decision!;
  const [picked, setPicked] = useState<string[]>([]);
  const choice = step.choice;

  if (choice) {
    return (
      <p className="mt-2 text-sm" data-choice={choice.chosen.join(",")}>
        <span className="font-medium">
          {t("decision.chose", { labels: choiceLabels(spec, choice.chosen) })}
        </span>{" "}
        <span className="text-xs text-muted-foreground">
          {t("decision.by", { by: choice.by, time: formatTime(choice.at) })}
        </span>
      </p>
    );
  }

  const open = runbookOpen && step.status === "pending";
  const toggle = (id: string) =>
    setPicked((now) =>
      spec.multiple
        ? now.includes(id)
          ? now.filter((other) => other !== id)
          : [...now, id]
        : [id],
    );
  const valid = choiceProblem(spec, picked) === null;
  const hint = !spec.multiple
    ? t("decision.pickOne")
    : spec.min === spec.max
      ? t("decision.pickCount", { count: spec.min })
      : t("decision.pickRange", { min: spec.min, max: spec.max });

  return (
    <fieldset className="mt-2 flex flex-col gap-2" data-decision>
      <legend className="text-xs text-muted-foreground">{hint}</legend>
      {spec.options.map((option) => {
        const checked = picked.includes(option.id);
        return (
          <label
            key={option.id}
            data-option={option.id}
            className={cn(
              "flex cursor-pointer items-start gap-2 border border-border p-2 text-sm",
              checked && "border-primary bg-primary/10",
              !open && "cursor-default opacity-70",
            )}
          >
            <input
              type={spec.multiple ? "checkbox" : "radio"}
              name={`decision-${step.id}`}
              className="mt-1"
              checked={checked}
              disabled={!open || busy}
              onChange={() => toggle(option.id)}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{option.label}</span>
              {option.description && (
                <Markdown
                  source={option.description}
                  className="text-xs text-muted-foreground"
                />
              )}
            </span>
          </label>
        );
      })}
      {open && (
        <div>
          <Button
            size="sm"
            data-decide
            disabled={!valid || busy}
            onClick={() => onDecide(step, inOrder(spec, picked))}
          >
            {t("decision.confirm")}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
