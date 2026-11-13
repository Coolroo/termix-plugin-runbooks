import { useMemo } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  fillStepText,
  type StepText,
  type TextValues,
} from "../../shared/fill";
import type { Step } from "../api-types";

/**
 * Fills a step's body, expect and where with the runbook's values (1.4.3)
 * with the function the server fills resolvedBody, resolvedExpect and
 * resolvedWhere with (fillStepText), and with a marker where a value is not
 * set yet, which the server leaves as {{name}}.
 */
export function useStepText(step: Step, values: TextValues): StepText {
  const { t } = useTranslation();
  const { body, expect, where } = step;
  return useMemo(
    () =>
      fillStepText({ body, expect, where }, values, (name) =>
        t("values.notSet", { name }),
      ),
    [body, expect, where, values, t],
  );
}
