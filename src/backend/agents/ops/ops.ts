/**
 * Everything an agent may do, shared by the REST routes and the MCP tools.
 *
 * An agent proposes: it writes runbooks and steps and reads what happened. It
 * never runs a step, never skips or reopens one and never writes the owner's
 * notes; those routes do not exist on this side at all. The one step it may
 * end is its own: a step with owner "agent", once it is its turn (1.4.0).
 */

import type { Store } from "../../runbooks/store/store.js";
import type { LiveRuns } from "../../running/live.js";
import { createEvents, type Events } from "../events.js";
import { createAccess } from "./access.js";
import { createReads } from "./reads.js";
import { createAuthoring } from "./authoring.js";
import { createComplete } from "./complete.js";

export type AgentOps = ReturnType<typeof createAgentOps>;

/** An audit line an agent's action writes, without a request. */
export type AgentAudit = (line: {
  action: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  details: string;
  success: boolean;
}) => Promise<void>;

export function createAgentOps(
  store: Store,
  live?: LiveRuns,
  options: { audit?: AgentAudit; events?: Events } = {},
) {
  const events = options.events ?? createEvents(store);
  const access = createAccess(store);
  const reads = createReads(store, live, access);
  const authoring = createAuthoring(store, events, access, reads);
  const complete = createComplete(store, events, options, access, reads);

  return {
    listHosts: access.listHosts,
    listRunbooks: reads.listRunbooks,
    getRunbook: reads.getRunbook,
    createRunbook: authoring.createRunbook,
    updateRunbook: authoring.updateRunbook,
    addSteps: authoring.addSteps,
    updateStep: authoring.updateStep,
    removeStep: authoring.removeStep,
    reorderSteps: authoring.reorderSteps,
    getValues: reads.getValues,
    completeAgentStep: complete.completeAgentStep,
    amendStep: complete.amendStep,
    listEvents: reads.listEvents,
  };
}
