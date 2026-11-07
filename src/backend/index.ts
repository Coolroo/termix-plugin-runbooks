import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAgentOps } from "./agent-ops.js";
import { createAgentRouter } from "./agent-routes.js";
import { registerPersonRoutes } from "./routes.js";
import { createStore } from "./store.js";

/** Requests a minute one address may make to the agent routes (core's limit). */
const PUBLIC_RATE_LIMIT = 600;

export async function activate(ctx: PluginContext) {
  const store = await createStore(ctx.db);
  const ops = createAgentOps(ctx, store);

  const router = ctx.http.router<Router>({
    // Agents call these with a Runbooks token instead of a Termix login; the
    // agent router checks the token on every request.
    public: ["/agent/*"],
    publicRateLimit: PUBLIC_RATE_LIMIT,
  });

  const agent = createAgentRouter(ctx, store, ops, ctx.manifest.version);
  router.use("/agent", agent.router);
  registerPersonRoutes(router, ctx, store);
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core.
}
