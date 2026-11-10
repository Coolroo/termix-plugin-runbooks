/**
 * Kinds of step (1.4.1): who does a step and how, read from the fields a
 * step already has. Each kind has an icon, a label, a short name and a
 * default color for light and dark themes; the UI draws every kind the same
 * way from these, so a kind is one entry in the registry below and nothing
 * else. Marks (Secret, Wait) are chips on top of any kind, registered the
 * same way.
 *
 * Adding a kind: add one StepKind to BUILT_IN_KINDS (or call
 * registerStepKind), with its translation keys in locales/en.json. The step
 * cards, the list, the color settings and the GET /colors answer all read
 * the registry.
 *
 * Shared by the server and the UI. No React here.
 */

/** Translates a key, as i18next's `t`. */
export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/** The fields of a step a kind or a mark may read. */
export interface KindStep {
  title: string;
  owner?: "person" | "agent" | null;
  command: string | null;
  hostId: number | null;
  hostName?: string | null;
  where?: string | null;
  secretCaptures?: unknown[] | null;
  /** The server's StdinSource, or the UI's StdinView with its source. */
  stdin?: { from?: string; source?: { from?: string } } | null;
  waitAfterPreviousSeconds?: number | null;
  wait?: unknown;
}

/** What a kind may know about the runbook around a step. */
export interface KindRunbook {
  /** The step is the runbook's last one. */
  last: boolean;
  /** Who the runbook belongs to, as the person sees it. */
  agentLabel?: string;
}

export interface StepKind {
  /** Stable id: the settings and the API key colors by it. */
  id: string;
  /** What the step's chip says, such as "Run on web-1". */
  label: (t: Translate, step: KindStep, runbook: KindRunbook) => string;
  /** The kind's short name for the list and the settings: a locale key. */
  nameKey: string;
  /** A Lucide icon name. */
  icon: string;
  /**
   * CSS colors for light and dark themes. Prefer Termix tokens
   * (var(--warning)); a color of the plugin's own keeps at least 4.5:1 on
   * Termix's light and dark cards (tests check every hex default).
   */
  defaultColor: { light: string; dark: string };
  matches: (step: KindStep, runbook: KindRunbook) => boolean;
  /** Higher wins when more than one kind matches. */
  priority: number;
}

export interface StepMark {
  id: string;
  icon: string;
  /** A locale key. */
  labelKey: string;
  matches: (step: KindStep, runbook: KindRunbook) => boolean;
}

/** Termix's success green (Tailwind green-500, as its ListBadge uses). */
const SUCCESS = "oklch(72.3% 0.219 149.579)";

/** The kind a step gets when no other kind matches. */
export const FALLBACK_KIND = "app";

export const BUILT_IN_KINDS: StepKind[] = [
  {
    id: "lead",
    nameKey: "kind.name.lead",
    icon: "Bot",
    label: (t, _step, runbook) =>
      t("kind.lead", { label: runbook.agentLabel || t("kind.agent") }),
    // The plugin's own blue.
    defaultColor: { light: "#1d4ed8", dark: "#60a5fa" },
    matches: (step) => step.owner === "agent",
    priority: 50,
  },
  {
    id: "run",
    nameKey: "kind.name.run",
    icon: "Play",
    label: (t, step) =>
      t("kind.run", {
        host:
          step.hostName ??
          (step.hostId === null
            ? "?"
            : t("step.unknownHost", { id: step.hostId })),
      }),
    // Mixed with the text color on light themes for 4.5:1.
    defaultColor: {
      light: `color-mix(in oklab, ${SUCCESS} 60%, var(--foreground))`,
      dark: SUCCESS,
    },
    matches: (step) => step.command !== null && step.hostId !== null,
    priority: 40,
  },
  {
    id: "outside",
    nameKey: "kind.name.outside",
    icon: "ExternalLink",
    label: (t) => t("kind.outside"),
    defaultColor: {
      light: "color-mix(in oklab, var(--warning) 55%, var(--foreground))",
      dark: "var(--warning)",
    },
    matches: (step) => step.command !== null && Boolean(step.where),
    priority: 30,
  },
  {
    id: "finish",
    nameKey: "kind.name.finish",
    icon: "Flag",
    label: (t) => t("kind.finish"),
    defaultColor: {
      light: "var(--muted-foreground)",
      dark: "var(--muted-foreground)",
    },
    // The last step, with no command, that tells the person to finish.
    matches: (step, runbook) =>
      runbook.last && step.command === null && /^\s*finish\b/i.test(step.title),
    priority: 20,
  },
  {
    id: FALLBACK_KIND,
    nameKey: "kind.name.app",
    icon: "MousePointerClick",
    label: (t) => t("kind.app"),
    // The plugin's own violet.
    defaultColor: { light: "#6d28d9", dark: "#a78bfa" },
    matches: (step) => step.command === null,
    priority: 0,
  },
];

export const BUILT_IN_MARKS: StepMark[] = [
  {
    id: "secret",
    icon: "Lock",
    labelKey: "kind.mark.secret",
    matches: (step) =>
      (step.secretCaptures?.length ?? 0) > 0 ||
      step.stdin?.from === "secret" ||
      step.stdin?.source?.from === "secret",
  },
  {
    id: "wait",
    icon: "Clock",
    labelKey: "kind.mark.wait",
    matches: (step) =>
      (step.waitAfterPreviousSeconds ?? 0) > 0 || Boolean(step.wait),
  },
];

/** A kind id: what the settings key a color by. */
export const KIND_ID = /^[a-z][a-z0-9-]{0,31}$/;

const kinds = new Map<string, StepKind>();
const marks = new Map<string, StepMark>();

/** Adds a kind, or replaces the kind with that id. Returns a remover. */
export function registerStepKind(kind: StepKind): () => void {
  if (!KIND_ID.test(kind.id)) throw new Error(`bad step kind id ${kind.id}`);
  kinds.set(kind.id, kind);
  return () => {
    if (kinds.get(kind.id) === kind) kinds.delete(kind.id);
  };
}

/** Adds a mark, or replaces the mark with that id. Returns a remover. */
export function registerStepMark(mark: StepMark): () => void {
  marks.set(mark.id, mark);
  return () => {
    if (marks.get(mark.id) === mark) marks.delete(mark.id);
  };
}

for (const kind of BUILT_IN_KINDS) registerStepKind(kind);
for (const mark of BUILT_IN_MARKS) registerStepMark(mark);

/** Every kind, highest priority first. */
export function stepKinds(): StepKind[] {
  return [...kinds.values()].sort((a, b) => b.priority - a.priority);
}

export function stepMarks(): StepMark[] {
  return [...marks.values()];
}

export function getStepKind(id: string): StepKind | undefined {
  return kinds.get(id);
}

/** The highest-priority kind that matches, else the fallback kind. */
export function kindOf(step: KindStep, runbook: KindRunbook): StepKind {
  return (
    stepKinds().find((kind) => kind.matches(step, runbook)) ??
    kinds.get(FALLBACK_KIND) ??
    BUILT_IN_KINDS[BUILT_IN_KINDS.length - 1]
  );
}

/** The marks that apply to a step. */
export function marksOf(step: KindStep, runbook: KindRunbook): StepMark[] {
  return stepMarks().filter((mark) => mark.matches(step, runbook));
}

/**
 * The kind of a runbook's next step: the first pending one, as the UI marks
 * it Next. Null when no step is pending.
 */
export function nextKind(
  steps: Array<KindStep & { status: string }>,
): string | null {
  const index = steps.findIndex((step) => step.status === "pending");
  if (index === -1) return null;
  return kindOf(steps[index], { last: index === steps.length - 1 }).id;
}

// --- Colors ---------------------------------------------------------------

/**
 * The setting that holds the step colors, in the admin and the user scope:
 * an object { [kind id]: "#rrggbb" }. A person's colors win over the
 * admin's; a kind with neither keeps its default.
 */
export const COLORS_SETTING = "stepColors";

/** #rgb or #rrggbb, and nothing else: the value goes into a style. */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const MAX_COLORS = 50;

/** What is wrong with one color, or null. Empty means the default. */
export function colorProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && HEX_COLOR.test(value)) return null;
  return "Enter a color as #rgb or #rrggbb, or leave it empty for the default";
}

/** A valid hex color, lower case, or null. */
export function cleanColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR.test(value)
    ? value.toLowerCase()
    : null;
}

/** Colors by kind id; a kind that is not there keeps its default. */
export type KindColors = Record<string, string>;

/**
 * Only valid colors of registered kinds, whatever the input holds: a stored
 * setting, an API answer.
 */
export function cleanColors(input: unknown): KindColors {
  const out: KindColors = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    const color = cleanColor(value);
    if (color && kinds.has(id)) out[id] = color;
  }
  return out;
}

/** What is wrong with a stepColors value, or null. */
export function colorsProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return "Step colors must be an object of kind ids and colors";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_COLORS) {
    return `At most ${MAX_COLORS} step colors`;
  }
  for (const [id, color] of entries) {
    if (!KIND_ID.test(id)) return `"${id.slice(0, 40)}" is not a step kind`;
    const problem = colorProblem(color);
    if (problem) return `${id}: ${problem}`;
  }
  return null;
}

/** Field errors for a save of the color settings, in either scope. */
export function validateColors(
  values: Record<string, unknown>,
): Record<string, string> {
  if (!(COLORS_SETTING in values)) return {};
  const problem = colorsProblem(values[COLORS_SETTING]);
  return problem ? { [COLORS_SETTING]: problem } : {};
}

/** The colors a person sees: theirs over the admin's, both cleaned. */
export function effectiveColors(admin: unknown, user: unknown): KindColors {
  return { ...cleanColors(admin), ...cleanColors(user) };
}
