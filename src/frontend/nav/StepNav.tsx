/**
 * Finding the next step in a long runbook (1.4.4): a rail of the steps near
 * the part of the runbook on screen, and a bar under it that names the next
 * step and puts it in the middle of the view (NextStepBar.tsx).
 *
 * The rail shows a window of at most RAIL_MAX steps around the steps on
 * screen, never all of them: a runbook can have 80. Counts above and below
 * the window say how many steps it leaves out, and the next step, when it
 * is outside the window, stays pinned at the window's edge. The rail hides
 * in a narrow pane; the bar then shows a progress strip instead.
 */

import { useCallback, useEffect, useState, type RefObject } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  kindOf,
  marksOf,
  type KindRunbook,
  type StepKind,
  type StepMark,
} from "../../shared/step-kinds";
import {
  cardState,
  kindRunbookOf,
  kindStyle,
  useColorFor,
} from "../kinds/kinds";
import { stepLabel } from "../../shared/steps";
import type { Runbook, Step } from "../api-types";

/** The most steps the rail shows at once. */
export const RAIL_MAX = 11;

/** The fewest, in a short pane. */
export const RAIL_MIN = 3;

/** The height of one step on the rail, in px. */
const RAIL_ROW = 32;

/** The rail's counts and pinned marker take this much of its height. */
const RAIL_RESERVED = 112;

/** Below this width (px) the pane has no rail. */
const RAIL_MIN_WIDTH = 560;

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

/**
 * One step as the card, the rail and the bar show it: its kind, marks and
 * color, and its card's state.
 */
export interface NavStep {
  step: Step;
  index: number;
  label: string;
  kind: StepKind;
  marks: StepMark[];
  /** What the kind read of the runbook around the step. */
  kindRunbook: KindRunbook;
  color: string;
  state: ReturnType<typeof cardState>;
  /** The color its marks show: the kind's, red when it failed. */
  mark: string;
}

/** Every step of the runbook as a NavStep, and where the next one is. */
export interface NavSteps {
  steps: NavStep[];
  /** The next step's index, or -1 when there is none. */
  nextIndex: number;
}

/** The runbook's steps, worked out once per render for the whole page. */
export function useNavSteps(runbook: Runbook | null): NavSteps {
  const colorFor = useColorFor();
  if (!runbook) return { steps: [], nextIndex: -1 };
  const steps = runbook.steps.map((step, index): NavStep => {
    const kindRunbook = kindRunbookOf(runbook, index);
    const kind = kindOf(step, kindRunbook);
    const color = colorFor(kind.id);
    const state = cardState(step, step.id === runbook.nextStepId);
    return {
      step,
      index,
      label: stepLabel(step),
      kind,
      marks: marksOf(step, kindRunbook),
      kindRunbook,
      color,
      state,
      mark: kindStyle.stateColor(state, color),
    };
  });
  const nextIndex = steps.findIndex(
    (item) => item.step.id === runbook.nextStepId,
  );
  return { steps, nextIndex };
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
  nav,
  view,
  height,
  onGo,
}: {
  nav: NavSteps;
  view: StepsInView | null;
  height: number;
  onGo: (id: number, focus?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { steps: items, nextIndex } = nav;
  const [hover, setHover] = useState<number | null>(null);
  const count = items.length;
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
