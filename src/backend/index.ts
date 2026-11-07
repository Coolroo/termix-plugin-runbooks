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
import { createStore } from "./store.js";

/** Requests a minute one address may make to the agent routes (core's limit). */
const PUBLIC_RATE_LIMIT = 600;

let active: LiveRuns | null = null;

export async function activate(ctx: PluginContext) {
  const store = await createStore(ctx.db);
  // Runs a stopped Termix left running never finish: fail them first.
  await sweepInterrupted(store);
  const live = createLiveRuns(store);
  active = live;
  const ops = createAgentOps(store, live);

  const router = ctx.http.router<Router>({
    // Agents call these with a Runbooks token instead of a Termix login; the
    // agent router checks the token on every request.
    public: ["/agent/*"],
    publicRateLimit: PUBLIC_RATE_LIMIT,
  });

  const agent = createAgentRouter(ctx, store, ops, ctx.manifest.version);
  router.use("/agent", agent.router);
  registerPersonRoutes(router, ctx, store, live);
}

export async function deactivate() {
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
