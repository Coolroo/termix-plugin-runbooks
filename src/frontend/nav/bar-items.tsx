/**
 * What the bar under a runbook shows (1.4.4): one registry of items, drawn
 * left to right by `order`. The bar and its keys read only the registry, so
 * a new button is one entry here and nothing else.
 *
 * Adding a button: call registerBarItem with `type: "button"`, an id, an
 * order, a label, an onClick and, if it needs them, an icon (a Lucide name),
 * a key and a `when`. Its words go in locales/en.json. The bar draws it like
 * the others and its key works while the focus is in the runbook.
 *
 * Adding anything else (a chip, a counter, a link): `type: "custom"` with a
 * `render` that returns the element. The bar puts it in the row as it is.
 */

import type { ReactNode } from "react";
import { Button, PluginIcon, cn } from "@termix-ssh/plugin-sdk/ui";
import type { Translate } from "../../shared/step-kinds";
import { KindChip, kindStyle } from "../kinds/kinds";
import { SectionLabel } from "../ui/ui";
import type { NavStep, StepsInView } from "./StepNav";
import type { Runbook } from "../api-types";

/** What every bar item gets: the runbook, its next step, the view, actions. */
export interface BarContext {
  runbook: Runbook;
  /** The next step, or null when every step ended or the runbook is closed. */
  next: NavStep | null;
  /** Every step, as the rail sees them. */
  steps: NavStep[];
  /** The steps on screen, or null before the first layout. */
  view: StepsInView | null;
  /** The next step's card is on screen. */
  onScreen: boolean;
  /** The pane is wide enough for the rail; false on a phone. */
  wide: boolean;
  t: Translate;
  /** Puts a step's card in the middle of the view; `focus` moves the focus there. */
  goTo: (stepId: number, focus?: boolean) => void;
  /** Scrolls back to the top of the runbook. */
  toTop: () => void;
}

interface BarItemBase {
  /** Stable id, lower case: the bar marks the item with data-bar-item. */
  id: string;
  /** Left to right; the built-ins use 100, 200, 300 and 310. */
  order: number;
  /** Shown only when this answers true. Default: always. */
  when?: (ctx: BarContext) => boolean;
}

/** A button: the bar draws it, its icon and its key. */
export interface BarButton extends BarItemBase {
  type: "button";
  label: (ctx: BarContext) => string;
  /** A Lucide icon name, such as "ArrowDown". */
  icon?: string;
  /** "default" stands out; "outline" and "ghost" are quieter. */
  variant?: (ctx: BarContext) => "default" | "outline" | "ghost";
  /**
   * One letter or digit that presses the button while the focus is in the
   * runbook, never in a field. Shown on the button in a wide pane.
   */
  key?: string;
  onClick: (ctx: BarContext) => void;
}

/** Anything else: the bar puts what `render` returns in its row. */
export interface BarCustom extends BarItemBase {
  type: "custom";
  render: (ctx: BarContext) => ReactNode;
}

export type BarItem = BarButton | BarCustom;

const BAR_ID = /^[a-z][a-z0-9-]{0,39}$/;
const KEY = /^[a-z0-9]$/;
const items = new Map<string, BarItem>();

/** Adds an item, or replaces the item with that id. Returns a remover. */
export function registerBarItem(item: BarItem): () => void {
  if (!BAR_ID.test(item.id)) throw new Error(`bad bar item id ${item.id}`);
  if (item.type === "button" && item.key !== undefined && !KEY.test(item.key)) {
    throw new Error(`bad bar item key ${item.key}`);
  }
  items.set(item.id, item);
  return () => {
    if (items.get(item.id) === item) items.delete(item.id);
  };
}

/** Every item, left to right. */
export function barItems(): BarItem[] {
  return [...items.values()].sort((a, b) => a.order - b.order);
}

/** The items the bar shows now. */
export function shownBarItems(ctx: BarContext): BarItem[] {
  return barItems().filter((item) => item.when?.(ctx) ?? true);
}

/**
 * The key a key press means for the bar: a lower-case letter or digit, or
 * null when it has a modifier or the person types in a field.
 */
export function pressedKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}): string | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (!KEY.test(key)) return null;
  const target = event.target as HTMLElement | null;
  if (target && typeof target.closest === "function") {
    const typing = target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true']",
    );
    if (typing) return null;
  }
  return key;
}

/** The shown button that a key press presses, if any. */
export function buttonForKey(
  ctx: BarContext,
  key: string | null,
): BarButton | null {
  if (key === null) return null;
  return (
    shownBarItems(ctx).find(
      (item): item is BarButton => item.type === "button" && item.key === key,
    ) ?? null
  );
}

/** Draws one item of the bar. */
export function BarItemView({ item, ctx }: { item: BarItem; ctx: BarContext }) {
  if (item.type === "custom") return <>{item.render(ctx)}</>;
  return (
    <Button
      size="sm"
      variant={item.variant?.(ctx) ?? "outline"}
      data-bar-item={item.id}
      className={cn("h-10 shrink-0 gap-2", !ctx.wide && "h-11 px-4")}
      onClick={() => item.onClick(ctx)}
    >
      {item.icon && (
        <PluginIcon
          name={item.icon}
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
      )}
      {item.label(ctx)}
      {item.key && ctx.wide && (
        <kbd
          className="border border-current/40 px-1 font-mono text-[11px] font-medium uppercase opacity-80"
          aria-hidden="true"
        >
          {item.key}
        </kbd>
      )}
    </Button>
  );
}

/** "Next · step 46 of 80 · 45 done", or what the runbook says instead. */
function caption(ctx: BarContext): string {
  const { runbook, next, onScreen, t } = ctx;
  const { done, total } = runbook.progress;
  if (!next) {
    return runbook.status === "open"
      ? t("nav.allDone", { total })
      : t("nav.closed", { status: t(`runbook.status.${runbook.status}`) });
  }
  const where =
    next.state === "failed"
      ? "nav.failed"
      : onScreen
        ? "nav.onScreen"
        : "nav.next";
  return `${t(where, { label: next.label, total })} · ${t("nav.done", { done })}`;
}

/** The items the bar starts with. */
export const BUILT_IN_BAR_ITEMS: BarItem[] = [
  {
    type: "custom",
    id: "next-step",
    order: 100,
    render: (ctx) => (
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={
            ctx.next
              ? kindStyle.glow(ctx.next.mark)
              : { background: "var(--muted-foreground)" }
          }
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <SectionLabel as="span" data-bar-caption>
            {caption(ctx)}
          </SectionLabel>
          {ctx.next && (
            <span
              data-bar-title
              className="truncate text-sm font-medium"
              title={ctx.next.step.title}
            >
              {ctx.next.step.title}
            </span>
          )}
        </div>
      </div>
    ),
  },
  {
    type: "custom",
    id: "next-kind",
    order: 200,
    when: (ctx) => ctx.next !== null && ctx.wide,
    render: ({ next }) =>
      next && (
        <KindChip
          kind={next.kind}
          step={next.step}
          runbook={next.kindRunbook}
          color={next.color}
          state="current"
        />
      ),
  },
  {
    type: "button",
    id: "go-to-step",
    order: 300,
    when: (ctx) => ctx.next !== null,
    label: (ctx) => ctx.t("nav.go"),
    icon: "ArrowDown",
    key: "n",
    variant: (ctx) => (ctx.onScreen ? "outline" : "default"),
    onClick: (ctx) => {
      if (ctx.next) ctx.goTo(ctx.next.step.id, true);
    },
  },
  {
    type: "button",
    id: "go-to-top",
    order: 310,
    when: (ctx) => ctx.next === null,
    label: (ctx) => ctx.t("nav.top"),
    icon: "ArrowUpToLine",
    onClick: (ctx) => ctx.toTop(),
  },
];

for (const item of BUILT_IN_BAR_ITEMS) registerBarItem(item);
