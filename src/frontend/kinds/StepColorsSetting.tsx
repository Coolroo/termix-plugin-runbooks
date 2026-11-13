/**
 * The step colors in the plugin's settings (1.4.1): the admin's colors and
 * a person's own, one row per registered kind.
 */

import {
  useTranslation,
  type SettingsComponentProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input, PluginIcon } from "@termix-ssh/plugin-sdk/ui";
import {
  cleanColor,
  COLORS_SETTING,
  colorProblem,
  stepKinds,
} from "../../shared/step-kinds";
import { kindStyle, useMode } from "./kinds";

/** #abc as #aabbcc, for a color input. */
function sixDigits(hex: string): string {
  return hex.length === 4
    ? `#${[...hex.slice(1)].map((c) => c + c).join("")}`
    : hex;
}

/** The stored setting as an object of kind ids and texts. */
function storedColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * The step colors in the plugin's settings: one row per registered kind,
 * as #rrggbb, empty for the default. All of them live in one setting,
 * stepColors, keyed by kind id. `scope` user: a person's own colors, which
 * override the admin's.
 */
function StepColors({
  values,
  setValue,
  running,
  scope,
}: SettingsComponentProps & { scope: "admin" | "user" }) {
  const { t } = useTranslation();
  const mode = useMode();
  const stored = storedColors(values[COLORS_SETTING]);
  const set = (id: string, text: string) => {
    const next = { ...stored, [id]: text };
    if (text === "") delete next[id];
    setValue(COLORS_SETTING, next);
  };
  return (
    <div
      className="flex flex-col gap-2 border-b border-border py-3 last:border-0"
      data-step-colors={scope}
    >
      <span className="text-sm font-medium leading-snug">
        {t(
          scope === "admin"
            ? "settings.colors.title"
            : "settings.colors.userTitle",
        )}
      </span>
      <span className="text-xs leading-snug text-muted-foreground">
        {t(
          scope === "admin"
            ? "settings.colors.description"
            : "settings.colors.userDescription",
        )}
      </span>
      <div className="flex flex-col gap-1.5">
        {stepKinds().map((kind) => {
          const text = stored[kind.id] ?? "";
          const problem = colorProblem(text);
          const chosen = cleanColor(text);
          const shown = chosen ?? kind.defaultColor[mode];
          const name = t(kind.nameKey);
          return (
            <div
              key={kind.id}
              className="flex flex-wrap items-center gap-2"
              data-color-row={kind.id}
            >
              <span className="flex w-36 shrink-0 items-center gap-1.5 text-xs">
                <span
                  aria-hidden="true"
                  className="inline-block size-3 shrink-0 border border-border"
                  style={kindStyle.dot(shown)}
                />
                <PluginIcon
                  name={kind.icon}
                  className="size-3.5 shrink-0"
                  style={kindStyle.icon(shown)}
                  aria-hidden="true"
                />
                {name}
              </span>
              <input
                type="color"
                aria-label={t("settings.colors.pick", { kind: name })}
                disabled={!running}
                value={chosen ? sixDigits(chosen) : "#808080"}
                onChange={(event) => set(kind.id, event.target.value)}
                className="h-7 w-9 shrink-0 cursor-pointer rounded-none border border-input bg-transparent p-0.5"
              />
              <Input
                value={text}
                disabled={!running}
                maxLength={7}
                placeholder={t("settings.colors.default")}
                aria-label={t("settings.colors.hex", { kind: name })}
                aria-invalid={problem ? true : undefined}
                onChange={(event) => set(kind.id, event.target.value.trim())}
                className="h-7 w-28 font-mono text-xs"
              />
              <Button
                size="xs"
                variant="ghost"
                disabled={!running || text === ""}
                onClick={() => set(kind.id, "")}
              >
                {t("settings.colors.reset")}
              </Button>
              {problem && (
                <span className="text-xs text-destructive" data-color-problem>
                  {problem}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AdminStepColors(props: SettingsComponentProps) {
  return <StepColors {...props} scope="admin" />;
}

export function UserStepColors(props: SettingsComponentProps) {
  return <StepColors {...props} scope="user" />;
}
