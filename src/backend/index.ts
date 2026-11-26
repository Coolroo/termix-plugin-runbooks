import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAgentOps } from "./agents/ops/ops.js";
import { createAgentRouter } from "./agents/agent-routes.js";
import {
  createLiveRuns,
  PLUGIN_STOPPED,
  sweepInterrupted,
  type LiveRuns,
} from "./running/live.js";
import { registerPersonRoutes } from "./runbooks/routes.js";
import { createSecrets } from "./secrets/secrets.js";
import { createHaw } from "./vms/haw.js";
import { createEvents } from "./agents/events.js";
import { createStore } from "./runbooks/store/store.js";
import { createStateStore } from "./core/state.js";
import {
  createNotifier,
  validateSettings,
  type Notifier,
} from "./agents/notifier.js";
import { registerAdminRoutes } from "./agents/admin-routes.js";
import { validateColors } from "../shared/step-kinds.js";
import { LIST_STATE_SETTING, listStateProblem } from "../shared/folders.js";
import { BAN_SLEEP_SETTING } from "./runbooks/no-sleep.js";
import { createPlatforms } from "./events/platforms.js";
import { caBundleProblem, HTTP_CA_SETTING } from "./events/trust.js";

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
  ctx.settings.onValidate("admin", (values) => {
    // 1.4.10, phase 3: the extra CAs an http item trusts.
    const ca = caBundleProblem(values[HTTP_CA_SETTING]);
    return {
      ...validateSettings(values),
      ...validateColors(values),
      ...(ca ? { [HTTP_CA_SETTING]: ca } : {}),
    };
  });
  // Step colors (1.4.1): a person's own colors override the admin's.
  // 1.4.11: what a person collapsed in the list.
  ctx.settings.onValidate("user", (values) => {
    const list =
      LIST_STATE_SETTING in values
        ? listStateProblem(values[LIST_STATE_SETTING])
        : null;
    return {
      ...validateColors(values),
      ...(list ? { [LIST_STATE_SETTING]: list } : {}),
    };
  });
  // Runs a stopped Termix left running never finish: fail them first.
  await sweepInterrupted(store, events);
  const live = createLiveRuns(store);
  active = live;
  // OpenBao Secrets is optional: without it, steps that use secrets are
  // refused and everything else works.
  const secrets = createSecrets(ctx);
  // HAW VM Manager is optional too (1.4.7): without it, VM steps say why
  // they cannot run and everything else works.
  const haw = await createHaw(ctx);
  // 1.4.10, phase 3: which hosts runs found to be Windows hosts, shared by
  // the runner (which learns it) and the agent side (which refuses).
  const platforms = createPlatforms();
  const ops = createAgentOps(store, live, {
    audit: (line) => ctx.audit.record(line),
    events,
    // 1.4.10: commands that wait a fixed time are refused unless the admin
    // turned the ban off (on when never set).
    banSleep: async () =>
      (await ctx.settings.get<boolean>(BAN_SLEEP_SETTING)) !== false,
    platforms,
  });

  const router = ctx.http.router<Router>({
    // Agents call these with a Runbooks token instead of a Termix login; the
    // agent router checks the token on every request.
    public: ["/agent/*"],
    publicRateLimit: PUBLIC_RATE_LIMIT,
  });

  const agent = createAgentRouter(ctx, store, ops, ctx.manifest.version);
  router.use("/agent", agent.router);
  registerPersonRoutes(
    router,
    ctx,
    store,
    live,
    secrets,
    events,
    notifier,
    haw,
    platforms,
  );
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
  for (const run of live.all()) {
    run.interrupted = PLUGIN_STOPPED;
    // A sequence's delay is a timer of its own (1.4.10): end it too.
    if (run.sequence) run.stop?.();
  }
  await Promise.all(live.all().map((run) => live.flushNow(run.runId)));
}
