/** The step colors a person sees (1.4.1). */

import type { Router } from "express";
import { wrap } from "../core/http.js";
import type { PersonKit } from "../runbooks/person-kit.js";
import { COLORS_SETTING, effectiveColors } from "../../shared/step-kinds.js";

export function registerColorsRoute(router: Router, kit: PersonKit): void {
  const { ctx, actor, use } = kit;

  /**
   * @openapi
   * /plugin-api/runbooks/colors:
   *   get:
   *     summary: The step colors this person sees, by kind of step
   *     description: >
   *       { [kind id]: "#rrggbb" }: the person's own color, else the
   *       admin's. A kind that is not there keeps its built-in color.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The colors }
   */
  router.get(
    "/colors",
    ...use,
    wrap(async () => {
      // Checked again on read: only a color ever reaches a style.
      return effectiveColors(
        await ctx.settings.get(COLORS_SETTING),
        await ctx.settings.getUser(actor(), COLORS_SETTING),
      );
    }),
  );
}
