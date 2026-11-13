/**
 * The bar under a runbook (1.4.4): a progress line and the items of the bar
 * registry (bar-items.tsx), with the context every item gets.
 */

import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { BarItemView, shownBarItems, type BarContext } from "./bar-items";
import { kindStyle } from "../kinds/kinds";
import type { NavSteps, StepsInView } from "./StepNav";
import type { Runbook } from "../api-types";

/**
 * What the bar's items get (see bar-items.tsx): the runbook, its next step
 * and the view. Null until the runbook has loaded.
 */
export function useBarContext(
  runbook: Runbook | null,
  nav: NavSteps,
  view: StepsInView | null,
  wide: boolean,
  goTo: (id: number, focus?: boolean) => void,
  toTop: () => void,
): BarContext | null {
  const { t } = useTranslation();
  if (!runbook) return null;
  const { steps, nextIndex } = nav;
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
