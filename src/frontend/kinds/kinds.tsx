/**
 * Kinds of step in the UI (1.4.1). Everything here reads the registry in
 * src/shared/step-kinds.ts: a new kind needs no change in this file, the
 * step cards, the list or the settings (StepColorsSetting.tsx).
 *
 * Colors come from one resolver, colorFor(kind id): the person's color,
 * else the admin's, else the kind's default for the theme. Styles come from
 * one helper per element, which takes that color, so every kind is drawn
 * the same way. Color is never the only sign: every kind has an icon and a
 * label too.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  usePluginApi,
  useTheme,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { PluginIcon, cn } from "@termix-ssh/plugin-sdk/ui";
import {
  cleanColor,
  cleanColors,
  getStepKind,
  type KindColors,
  type KindRunbook,
  type KindStep,
  type StepKind,
  type StepMark,
} from "../../shared/step-kinds";
import { isAgentStep } from "../../shared/steps";
import type { Step } from "../api-types";

type Mode = "light" | "dark";

const FAILED = "var(--destructive)";

const GREY = "color-mix(in oklab, var(--muted-foreground) 45%, transparent)";

const KindColorContext = createContext<KindColors>({});

/** The theme mode, light when the host cannot say. */
export function useMode(): Mode {
  try {
    return useTheme().theme === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * A kind's color: the one set in the settings (the person's over the
 * admin's, already merged by the server), else the kind's default.
 */
export function resolveColor(
  kindId: string,
  colors: KindColors,
  mode: Mode,
): string {
  return (
    cleanColor(colors[kindId]) ??
    getStepKind(kindId)?.defaultColor[mode] ??
    "var(--muted-foreground)"
  );
}

/** colorFor(kind id), for this person and theme. */
export function useColorFor(): (kindId: string) => string {
  const colors = useContext(KindColorContext);
  const mode = useMode();
  return (kindId) => resolveColor(kindId, colors, mode);
}

/**
 * Reads the step colors this person sees (GET /colors) once, and hands them
 * to every step and list row below. Only valid hex colors of registered
 * kinds are kept: the server sends values, never CSS.
 */
export function KindColorsProvider({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const api = usePluginApi();
  const [colors, setColors] = useState<KindColors>({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api
      .get<unknown>("/colors")
      .then(({ data }) => {
        if (!cancelled) setColors(cleanColors(data));
      })
      .catch(() => {
        // The default colors.
      });
    return () => {
      cancelled = true;
    };
  }, [api, active]);
  return (
    <KindColorContext.Provider value={colors}>
      {children}
    </KindColorContext.Provider>
  );
}

/** How a step card shows its state. */
export type CardState = "current" | "pending" | "done" | "failed" | "grey";

export function cardState(
  step: Pick<Step, "status">,
  isNext: boolean,
): CardState {
  if (step.status === "failed") return "failed";
  if (step.status === "replaced" || step.status === "skipped") return "grey";
  if (isNext) return "current";
  return step.status === "done" ? "done" : "pending";
}

/**
 * The styles of one color, the same for every kind: the card (the current
 * step gets a 2 px border and a soft glow; the others a thin left stripe,
 * dimmed once done, red when failed, grey when replaced or skipped), the
 * chip, the icon and the list dot. The glow does not move, so there is
 * nothing to stop for reduced motion.
 */
export const kindStyle = {
  card(state: CardState, color: string): CSSProperties {
    const stripe = (value: string): CSSProperties => ({
      borderLeftWidth: 3,
      borderLeftColor: value,
    });
    switch (state) {
      case "current":
        return {
          borderWidth: 2,
          borderColor: color,
          boxShadow: `0 0 0 3px color-mix(in oklab, ${color} 18%, transparent), 0 0 14px color-mix(in oklab, ${color} 28%, transparent)`,
        };
      case "pending":
        return stripe(color);
      case "done":
        return stripe(`color-mix(in oklab, ${color} 40%, transparent)`);
      case "failed":
        return stripe(FAILED);
      case "grey":
        return stripe(GREY);
    }
  },
  chip(color: string, strong: boolean): CSSProperties {
    return {
      borderColor: color,
      background: strong
        ? `color-mix(in oklab, ${color} 14%, transparent)`
        : undefined,
    };
  },
  icon(color: string): CSSProperties {
    return { color };
  },
  dot(color: string): CSSProperties {
    return { background: color };
  },
  /** The color a card's state shows: red when failed, grey when replaced or skipped. */
  stateColor(state: CardState, color: string): string {
    if (state === "failed") return FAILED;
    if (state === "grey") return GREY;
    return color;
  },
  /** The next step's dot: filled, with the current card's glow (1.4.4). */
  glow(color: string): CSSProperties {
    return {
      background: color,
      boxShadow: `0 0 0 4px color-mix(in oklab, ${color} 22%, transparent), 0 0 12px color-mix(in oklab, ${color} 50%, transparent)`,
    };
  },
  /**
   * A step on the rail (1.4.4), drawn like its card: the current step big
   * and glowing, pending ones a ring, done ones a dimmed dot, failed ones
   * red, replaced and skipped ones grey.
   */
  railDot(state: CardState, color: string): CSSProperties {
    const size = (px: number): CSSProperties => ({ width: px, height: px });
    switch (state) {
      case "current":
        return { ...size(14), ...kindStyle.glow(color) };
      case "pending":
        return {
          ...size(10),
          boxSizing: "border-box",
          border: `2px solid ${color}`,
          background: "var(--background)",
        };
      case "done":
        return {
          ...size(8),
          background: `color-mix(in oklab, ${color} 55%, transparent)`,
        };
      case "failed":
        return { ...size(10), background: FAILED };
      case "grey":
        return { ...size(8), background: GREY };
    }
  },
};

/** What a kind reads of the runbook around step `index`. */
export function kindRunbookOf(
  runbook: { steps: readonly unknown[]; agentLabel?: string },
  index: number,
): KindRunbook {
  return {
    last: index === runbook.steps.length - 1,
    agentLabel: runbook.agentLabel,
  };
}

/** The icon and label of a step's kind, in the step's header. */
export function KindChip({
  kind,
  step,
  runbook,
  color,
  state,
}: {
  kind: StepKind;
  step: KindStep;
  runbook: KindRunbook;
  color: string;
  state: CardState;
}) {
  const { t } = useTranslation();
  return (
    <span
      data-kind={kind.id}
      // The lead's steps keep their 1.4.0 mark.
      data-agent-step={isAgentStep(step) || undefined}
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 py-px text-[11px] font-medium text-foreground",
        (state === "done" || state === "grey") && "opacity-70",
      )}
      style={kindStyle.chip(color, state === "current")}
    >
      <PluginIcon
        name={kind.icon}
        className="size-3 shrink-0"
        style={kindStyle.icon(color)}
        aria-hidden="true"
      />
      {kind.label(t, step, runbook)}
    </span>
  );
}

/** A mark such as Secret or Wait: a small neutral chip, never a color. */
export function MarkChip({ mark }: { mark: StepMark }) {
  const { t } = useTranslation();
  return (
    <span
      data-mark={mark.id}
      className="inline-flex items-center gap-1 border border-border px-1.5 py-px text-[11px] text-muted-foreground"
    >
      <PluginIcon
        name={mark.icon}
        className="size-3 shrink-0"
        aria-hidden="true"
      />
      {t(mark.labelKey)}
    </span>
  );
}

/** The kind of a runbook's next step in the list: a dot, an icon, a name. */
export function NextKindDot({ kindId }: { kindId: string }) {
  const { t } = useTranslation();
  const color = useColorFor()(kindId);
  const kind = getStepKind(kindId);
  if (!kind) return null;
  const name = t(kind.nameKey);
  return (
    <span
      data-next-kind={kind.id}
      title={t("list.next", { kind: name })}
      aria-label={t("list.next", { kind: name })}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="inline-block size-2 shrink-0 rounded-full"
        style={kindStyle.dot(color)}
      />
      <PluginIcon
        name={kind.icon}
        className="size-3 shrink-0"
        style={kindStyle.icon(color)}
        aria-hidden="true"
      />
      {/* The kind by name: color is never the only sign. */}
      <span aria-hidden="true">{name}</span>
    </span>
  );
}
