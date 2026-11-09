/**
 * The admin's side of agent notifications (1.3.0), for the custom section in
 * the plugin's settings: whether it is set up, a new signing secret (shown
 * once, in the answer that makes it), and a test delivery.
 *
 * Admins only (admin.plugins.manage), signed in, never a Termix API key.
 */

import type { NextFunction, Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  newSigningSecret,
  SETTINGS,
  SIGNING_SECRET,
  type Notifier,
} from "./notifier.js";
import type { StateStore } from "./state.js";

export const ADMIN_PERMISSION = "admin.plugins.manage";

export function registerAdminRoutes(
  router: Router,
  ctx: PluginContext,
  notifier: Notifier,
  state: StateStore,
): void {
  const admin = async (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.currentActor()) {
      res.status(401).json({ error: "sign in to Termix first" });
      return;
    }
    if ((req as Request & { apiKeyId?: unknown }).apiKeyId) {
      res
        .status(403)
        .json({ error: "a Termix API key cannot do this; use the Termix app" });
      return;
    }
    if (!(await ctx.rbac.has(ADMIN_PERMISSION))) {
      res
        .status(403)
        .json({ error: "only an admin can manage Runbooks notifications" });
      return;
    }
    next();
  };

  async function status() {
    const cfg = await notifier.config();
    const secret = await state.info(SIGNING_SECRET);
    return {
      enabled: await notifier.enabled(),
      url: (await ctx.settings.get<string>(SETTINGS.url)) ?? "",
      problem: "problem" in cfg ? cfg.problem : null,
      secret: secret
        ? { set: true, madeAt: secret.updatedAt, madeBy: secret.updatedBy }
        : { set: false, madeAt: null, madeBy: null },
    };
  }

  /**
   * @openapi
   * /plugin-api/runbooks/admin/notify:
   *   get:
   *     summary: Whether agent notifications are on and set up
   *     description: >
   *       enabled, url, problem (what is missing, or null) and whether a
   *       signing secret is set, with when and by whom. Never the secret.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The state }
   *       403: { description: Not an admin, or an API key }
   */
  router.get("/admin/notify", admin, async (_req, res) => {
    res.json(await status());
  });

  /**
   * @openapi
   * /plugin-api/runbooks/admin/notify/secret:
   *   post:
   *     summary: Make a new signing secret; it is in this answer only
   *     description: >
   *       The old secret stops working at once. The secret is sealed with
   *       the installation key and never shown again.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: "{ secret, madeAt, madeBy }" }
   */
  router.post("/admin/notify/secret", admin, async (req, res) => {
    const secret = newSigningSecret();
    const by = ctx.currentActor() as string;
    const madeAt = await state.set(SIGNING_SECRET, secret, by);
    await ctx.audit.record({
      action: "runbooks_notify_secret",
      resourceType: "runbooks_settings",
      resourceId: "notify",
      details: "made a new signing secret for agent notifications",
      success: true,
      request: req,
    });
    res.json({ secret, madeAt, madeBy: by });
  });

  /**
   * @openapi
   * /plugin-api/runbooks/admin/notify/test:
   *   post:
   *     summary: Send a test event with the saved settings
   *     description: >
   *       POSTs { id 0, type test } to the webhook, signed like any event,
   *       and answers { ok, status, error }.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: What the receiver answered }
   */
  router.post("/admin/notify/test", admin, async (req, res) => {
    const result = await notifier.test();
    await ctx.audit.record({
      action: "runbooks_notify_test",
      resourceType: "runbooks_settings",
      resourceId: "notify",
      details: result.status
        ? `test notification: HTTP ${result.status}`
        : "test notification: no answer",
      success: result.ok,
      errorMessage: result.error ?? undefined,
      request: req,
    });
    res.json(result);
  });
}
