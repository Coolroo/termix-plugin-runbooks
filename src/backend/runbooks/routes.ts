/**
 * The person side: /plugin-api/runbooks/..., behind core's login.
 *
 * Only a signed-in person runs a step, marks one done or skipped, or writes
 * the notes. A request that came in on a core API key (tmx_...) is refused on
 * those routes: core marks it with req.apiKeyId, so a script holding a key
 * cannot approve its own commands.
 */

import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Store } from "./store/store.js";
import type { LiveRuns } from "../running/live.js";
import type { Secrets } from "../secrets/secrets.js";
import type { Events } from "../agents/events.js";
import { createPersonKit } from "./person-kit.js";
import {
  registerRunbookList,
  registerRunbookRoutes,
} from "./runbook-routes.js";
import { registerColorsRoute } from "../kinds/colors-route.js";
import { registerRunRoutes } from "../running/run-routes.js";
import { registerSecretRoutes } from "../secrets/secret-routes.js";
import { registerStepRoutes } from "./step-routes.js";
import { registerSendRoutes } from "../agents/send-route.js";
import { registerTokenRoutes } from "../agents/token-routes.js";

export function registerPersonRoutes(
  router: Router,
  ctx: PluginContext,
  store: Store,
  live: LiveRuns,
  secrets: Secrets,
  events: Events,
  notify: { enabled: () => Promise<boolean> },
): void {
  // One kit for every route: one inFlight set, one removeRetryAt map.
  const kit = createPersonKit(ctx, store, live, secrets, events, notify);
  // Registered in the order they always were.
  registerRunbookList(router, kit);
  registerColorsRoute(router, kit);
  registerRunbookRoutes(router, kit);
  registerRunRoutes(router, kit);
  registerSecretRoutes(router, kit);
  registerStepRoutes(router, kit);
  registerSendRoutes(router, kit);
  registerTokenRoutes(router, kit);
}
