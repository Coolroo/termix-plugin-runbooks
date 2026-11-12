/**
 * Finding the next step in a long runbook (1.4.4): a rail of the steps near
 * the part of the runbook on screen, and a bar under it that names the next
 * step and puts it in the middle of the view.
 *
 * The rail shows a window of at most RAIL_MAX steps around the steps on
 * screen, never all of them: a runbook can have 80. Counts above and below
 * the window say how many steps it leaves out, and the next step, when it
 * is outside the window, stays pinned at the window's edge. The rail hides
 * in a narrow pane; the bar then shows a progress strip instead.
 */

import { useCallback, useEffect, useState, type RefObject } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { kindOf } from "../shared/step-kinds";
import { BarItemView, shownBarItems, type BarContext } from "./bar-items";
import { cardState, kindStyle, useColorFor } from "./kinds";
import { stepLabel } from "./StepCard";
import type { Runbook, Step } from "./types";

/** The most steps the rail shows at once. */
export const RAIL_MAX = 11;
/** The fewest, in a short pane. */
export const RAIL_MIN = 3;
/** The height of one step on the rail, in px. */
export const RAIL_ROW = 32;
/** The rail's counts and pinned marker take this much of its height. */
const RAIL_RESERVED = 112;
/** Below this width (px) the pane has no rail. */
export const RAIL_MIN_WIDTH = 560;

/** The steps on screen, as indexes into the runbook's steps. */
export interface StepsInView {
  first: number;
  last: number;
}

/**
 * The window of `size` steps around `center`, kept inside the runbook:
 * `start` included, `end` not.
 */
export function railWindow(
  count: number,
  center: number,
  size: number,
): { start: number; end: number } {
  if (count <= size) return { start: 0, end: count };
  const start = Math.min(
    Math.max(0, center - Math.floor(size / 2)),
    count - size,
  );
  return { start, end: start + size };
}

/** How many steps fit on a rail this tall. */
export function railSize(height: number): number {
  if (height <= 0) return RAIL_MAX;
  const rows = Math.floor((height - RAIL_RESERVED) / RAIL_ROW);
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, rows));
}

/**
 * The steps whose cards overlap the view from `top` to `bottom`, or null
 * when none does (no layout yet, or no cards).
 */
export function stepsInView(
  cards: ReadonlyArray<{ top: number; bottom: number } | null>,
  top: number,
  bottom: number,
): StepsInView | null {
  let first = -1;
  let last = -1;
  cards.forEach((card, index) => {
    if (!card || card.bottom <= card.top) return;
    if (card.bottom > top && card.top < bottom) {
      if (first < 0) first = index;
      last = index;
    }
  });
  return first < 0 ? null : { first, last };
}

const sameView = (a: StepsInView | null, b: StepsInView | null) =>
  a === b ||
  (a !== null && b !== null && a.first === b.first && a.last === b.last);

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Follows which steps are on screen in `scroller`, and how big the pane is.
 * `goTo` puts a step's card in the middle of the view; with `focus`, it
 * moves the focus to the card too, without scrolling again.
 */
export function useStepNav(
  scroller: RefObject<HTMLElement | null>,
  steps: ReadonlyArray<Pick<Step, "id">>,
) {
  const [view, setView] = useState<StepsInView | null>(null);
  const [wide, setWide] = useState(true);
  const [height, setHeight] = useState(0);
  const ids = steps.map((step) => step.id).join(",");

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const list = ids === "" ? [] : ids.split(",");
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      // The pane: the scroller and the rail beside it.
      const pane = element.parentElement?.getBoundingClientRect().width ?? 0;
      // No width yet (or no layout at all): keep the rail.
      setWide(pane <= 0 || pane >= RAIL_MIN_WIDTH);
      setHeight(Math.round(box.height));
      const cards = list.map((id) => {
        const card = element.querySelector(`[data-step="${id}"]`);
        if (!card) return null;
        const rect = card.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      });
      const next = stepsInView(cards, box.top, box.bottom);
      setView((previous) => (sameView(previous, next) ? previous : next));
    };
    const schedule = () => {
      if (frame) return;
      frame =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(measure)
          : (setTimeout(measure, 16) as unknown as number);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(schedule)
        : null;
    observer?.observe(element);
    if (element.parentElement) observer?.observe(element.parentElement);
    // Cards grow while output streams in.
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frame);
      }
    };
  }, [scroller, ids]);

  const goTo = useCallback(
    (id: number, focus = false) => {
      const card = scroller.current?.querySelector<HTMLElement>(
        `[data-step="${id}"]`,
      );
      if (!card) return;
      card.scrollIntoView?.({
        block: "center",
        behavior: reducedMotion() ? "auto" : "smooth",
      });
      if (focus) card.focus({ preventScroll: true });
    },
    [scroller],
  );

  const toTop = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({
        top: 0,
        behavior: reducedMotion() ? "auto" : "smooth",
      });
    } else {
      element.scrollTop = 0;
    }
  }, [scroller]);

  return { view, wide, height, goTo, toTop };
}

/** One step on the rail: its kind's color and how its card shows it. */
export interface NavStep {
  step: Step;
  index: number;
  label: string;
  color: string;
  state: ReturnType<typeof cardState>;
  /** The color its marks show: the kind's, red when it failed. */
  mark: string;
}

export function useNavSteps(runbook: Runbook | null): NavStep[] {
  const colorFor = useColorFor();
  if (!runbook) return [];
  const agentLabel = runbook.agentLabel ?? runbook.createdBy;
  return runbook.steps.map((step, index) => {
    const color = colorFor(
      kindOf(step, { last: index === runbook.steps.length - 1, agentLabel }).id,
    );
    const state = cardState(step, step.id === runbook.nextStepId);
    return {
      step,
      index,
      label: stepLabel(step),
      color,
      state,
      mark: kindStyle.stateColor(state, color),
    };
  });
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-2.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}

/** "↑ 34": the steps the window leaves out above or below. */
function RailCount({
  count,
  up,
  onClick,
}: {
  count: number;
  up: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (count === 0) return <span aria-hidden="true" className="h-6 w-8" />;
  return (
    <button
      type="button"
      data-rail-count={up ? "earlier" : "later"}
      aria-label={t(up ? "nav.earlier" : "nav.later", { count })}
      title={t(up ? "nav.earlier" : "nav.later", { count })}
      onClick={onClick}
      className="flex h-6 w-8 items-center justify-center gap-0.5 border border-border font-mono text-[10px] text-muted-foreground hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Chevron up={up} />
      {count}
    </button>
  );
}

/** The next step, pinned at the rail's edge when it is outside the window. */
function PinnedNext({
  item,
  above,
  onGo,
}: {
  item: NavStep;
  above: boolean;
  onGo: () => void;
}) {
  const { t } = useTranslation();
  const name = t("nav.pinned", { label: item.label, title: item.step.title });
  const marker = (
    <button
      type="button"
      data-rail-pinned={item.step.id}
      aria-label={name}
      title={name}
      onClick={onGo}
      className="flex size-7 items-center justify-center rounded-full font-mono text-[10px] font-semibold text-background focus-visible:ring-1 focus-visible:ring-ring"
      style={kindStyle.glow(item.mark)}
    >
      {item.label}
    </button>
  );
  const gap = (
    <span
      aria-hidden="true"
      className="h-3 border-l-2 border-dotted"
      style={{ borderColor: item.mark }}
    />
  );
  return (
    <div className="flex flex-col items-center gap-1">
      {above ? (
        <>
          {marker}
          {gap}
        </>
      ) : (
        <>
          {gap}
          {marker}
        </>
      )}
    </div>
  );
}

/** The rail of the steps near the view, on the pane's right edge. */
export function StepRail({
  runbook,
  view,
  height,
  onGo,
}: {
  runbook: Runbook;
  view: StepsInView | null;
  height: number;
  onGo: (id: number, focus?: boolean) => void;
}) {
  const { t } = useTranslation();
  const items = useNavSteps(runbook);
  const [hover, setHover] = useState<number | null>(null);
  const count = items.length;
  const nextIndex = items.findIndex(
    (item) => item.step.id === runbook.nextStepId,
  );
  const size = railSize(height);
  // Before the first layout, the window starts at the next step.
  const center = view
    ? Math.floor((view.first + view.last) / 2)
    : Math.max(0, nextIndex);
  const { start, end } = railWindow(count, center, size);
  const shown = items.slice(start, end);
  const pinned =
    nextIndex >= 0 && (nextIndex < start || nextIndex >= end)
      ? items[nextIndex]
      : null;
  // The box over the steps on screen, inside the window.
  const boxFirst = view ? Math.max(view.first, start) : -1;
  const boxLast = view ? Math.min(view.last, end - 1) : -1;
  const box = boxFirst >= 0 && boxLast >= boxFirst;
  // The progress line runs to the last done step in the window.
  const lastDone = shown.reduce(
    (found, item, offset) => (item.step.status === "done" ? offset : found),
    -1,
  );
  const jump = (offset: number) => {
    const target = Math.min(count - 1, Math.max(0, center + offset));
    onGo(items[target].step.id);
  };
  const hovered = hover !== null ? items[hover] : null;

  return (
    <nav
      aria-label={t("nav.rail")}
      data-step-rail
      className="relative flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border py-2"
    >
      <RailCount count={start} up onClick={() => jump(-size)} />
      {pinned && nextIndex < start && (
        <PinnedNext
          item={pinned}
          above
          onGo={() => onGo(pinned.step.id, true)}
        />
      )}
      <ol
        className="relative w-full"
        style={{ height: shown.length * RAIL_ROW }}
        onMouseLeave={() => setHover(null)}
      >
        <span
          aria-hidden="true"
          className="absolute left-1/2 w-0.5 -translate-x-1/2 bg-border"
          style={{
            top: RAIL_ROW / 2,
            height: Math.max(0, (shown.length - 1) * RAIL_ROW),
          }}
        />
        {lastDone > 0 && (
          <span
            aria-hidden="true"
            data-rail-progress
            className="absolute left-1/2 w-0.5 -translate-x-1/2"
            style={{
              top: RAIL_ROW / 2,
              height: lastDone * RAIL_ROW,
              background:
                "color-mix(in oklab, var(--foreground) 30%, transparent)",
            }}
          />
        )}
        {box && (
          <span
            aria-hidden="true"
            data-rail-view={`${boxFirst}-${boxLast}`}
            className="absolute inset-x-1 border border-foreground/25 bg-foreground/5"
            style={{
              top: (boxFirst - start) * RAIL_ROW + 2,
              height: (boxLast - boxFirst + 1) * RAIL_ROW - 4,
            }}
          />
        )}
        {shown.map((item) => {
          const name = t("nav.goTo", {
            label: item.label,
            title: item.step.title,
          });
          return (
            <li
              key={item.step.id}
              className="relative flex items-center justify-center"
              style={{ height: RAIL_ROW }}
            >
              <button
                type="button"
                data-rail-step={item.step.id}
                data-state={item.state}
                aria-label={name}
                aria-current={item.state === "current" ? "step" : undefined}
                onClick={() => onGo(item.step.id, item.state === "current")}
                onMouseEnter={() => setHover(item.index)}
                onFocus={() => setHover(item.index)}
                onBlur={() => setHover(null)}
                className="flex h-full w-full items-center justify-center focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className="block rounded-full"
                  style={kindStyle.railDot(item.state, item.color)}
                />
              </button>
            </li>
          );
        })}
        {hovered && hovered.index >= start && hovered.index < end && (
          <span
            role="tooltip"
            data-rail-tip={hovered.step.id}
            className="pointer-events-none absolute right-full z-10 mr-1.5 flex h-6 max-w-72 items-center gap-1.5 border bg-card px-2 text-xs whitespace-nowrap shadow-md"
            style={{
              top: (hovered.index - start) * RAIL_ROW + (RAIL_ROW - 24) / 2,
              borderColor: hovered.mark,
            }}
          >
            <span className="font-semibold">{hovered.label}</span>
            <span className="truncate text-muted-foreground">
              {hovered.step.title}
            </span>
          </span>
        )}
      </ol>
      {pinned && nextIndex >= end && (
        <PinnedNext
          item={pinned}
          above={false}
          onGo={() => onGo(pinned.step.id, true)}
        />
      )}
      <RailCount count={count - end} up={false} onClick={() => jump(size)} />
    </nav>
  );
}

/**
 * What the bar's items get (see bar-items.tsx): the runbook, its next step
 * and the view. Null until the runbook has loaded.
 */
export function useBarContext(
  runbook: Runbook | null,
  view: StepsInView | null,
  wide: boolean,
  goTo: (id: number, focus?: boolean) => void,
  toTop: () => void,
): BarContext | null {
  const { t } = useTranslation();
  const steps = useNavSteps(runbook);
  if (!runbook) return null;
  const nextIndex = steps.findIndex(
    (item) => item.step.id === runbook.nextStepId,
  );
  const next = nextIndex >= 0 ? steps[nextIndex] : null;
  const onScreen =
    next !== null &&
    view !== null &&
    nextIndex >= view.first &&
    nextIndex <= view.last;
  return { runbook, next, steps, view, onScreen, wide, t, goTo, toTop };
}

/**
 * The bar under the runbook: a progress line (a strip on a phone) and the
 * items of the bar registry, left to right.
 */
export function NextStepBar({ ctx }: { ctx: BarContext }) {
  const { next, steps, view, wide } = ctx;
  const { done, total } = ctx.runbook.progress;
  const share = (part: number) =>
    `${Math.min(100, Math.max(0, total > 0 ? (part / total) * 100 : 0))}%`;
  const count = steps.length;
  const tone = next?.mark ?? "var(--muted-foreground)";

  return (
    <div
      data-next-bar={next ? next.step.id : "none"}
      data-on-screen={ctx.onScreen || undefined}
      className="relative shrink-0 border-t border-border bg-card"
    >
      {wide ? (
        <span
          aria-hidden="true"
          data-bar-progress
          className="absolute -top-px left-0 h-0.5"
          style={{ width: share(done), background: tone }}
        />
      ) : (
        <span
          aria-hidden="true"
          data-bar-strip
          className="relative mx-3 mt-2 block h-1 bg-muted"
        >
          <span
            className="absolute inset-y-0 left-0"
            style={{
              width: share(done),
              background: `color-mix(in oklab, ${tone} 55%, transparent)`,
            }}
          />
          {view && count > 0 && (
            <span
              className="absolute -top-1 h-3 border border-foreground/35 bg-foreground/5"
              style={{
                left: `${(view.first / count) * 100}%`,
                width: `${((view.last - view.first + 1) / count) * 100}%`,
              }}
            />
          )}
          {next && (
            <span
              className="absolute -top-1 size-3 -translate-x-1/2 rounded-full"
              style={{
                left: `${((next.index + 0.5) / count) * 100}%`,
                ...kindStyle.glow(next.mark),
              }}
            />
          )}
        </span>
      )}
      <div className="flex min-h-14 items-center gap-3 px-3 py-2">
        {shownBarItems(ctx).map((item) => (
          <BarItemView key={item.id} item={item} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}
