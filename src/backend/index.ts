import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAgentOps } from "./agent-ops.js";
import { createAgentRouter } from "./agent-routes.js";
import {
  createLiveRuns,
  PLUGIN_STOPPED,
  sweepInterrupted,
  type LiveRuns,
} from "./live.js";
import { registerPersonRoutes } from "./routes.js";
import { createSecrets } from "./secrets.js";
import { createEvents } from "./events.js";
import { createStore } from "./store.js";
import { createStateStore } from "./state.js";
import { createNotifier, validateSettings, type Notifier } from "./notifier.js";
import { registerAdminRoutes } from "./admin-routes.js";

/** Requests a minute one address may make to the agent routes (core's limit). */
const PUBLIC_RATE_LIMIT = 600;

let active: LiveRuns | null = null;
let activeNotifier: Notifier | null = null;

export async function activate(ctx: PluginContext) {
  const store = await createStore(ctx.db);
  const state = await createStateStore(ctx.db, ctx.secrets);
  const events = createEvents(store);
  // Agent notifications: off until an admin turns them on.
  const notifier = createNotifier(ctx, store, state);
  activeNotifier = notifier;
  events.setDelivery(notifier);
  ctx.settings.onValidate("admin", (values) => validateSettings(values));
  // Runs a stopped Termix left running never finish: fail them first.
  await sweepInterrupted(store, events);
  const live = createLiveRuns(store);
  active = live;
  // OpenBao Secrets is optional: without it, steps that use secrets are
  // refused and everything else works.
  const secrets = createSecrets(ctx);
  const ops = createAgentOps(store, live, {
    audit: (line) => ctx.audit.record(line),
    events,
  });

  const router = ctx.http.router<Router>({
    // Agents call these with a Runbooks token instead of a Termix login; the
    // agent router checks the token on every request.
    public: ["/agent/*"],
    publicRateLimit: PUBLIC_RATE_LIMIT,
  });

  const agent = createAgentRouter(ctx, store, ops, ctx.manifest.version);
  router.use("/agent", agent.router);
  registerPersonRoutes(router, ctx, store, live, secrets, events, notifier);
  registerAdminRoutes(router, ctx, notifier, state);
  // Retries, and anything that was due while Termix was down.
  notifier.start();
  notifier.kick();
}

export async function deactivate() {
  // Core clears the delivery timer; nothing new starts from here on.
  activeNotifier?.stop();
  activeNotifier = null;
  // Everything registered through ctx is disposed by core, SSH connections
  // included, which ends running commands. Say why on those runs, and write
  // what they printed so far; the sweep on the next activate fails any run
  // that could not be finished.
  const live = active;
  active = null;
  if (!live) return;
  for (const run of live.all()) run.interrupted = PLUGIN_STOPPED;
  await Promise.all(live.all().map((run) => live.flushNow(run.runId)));
}
