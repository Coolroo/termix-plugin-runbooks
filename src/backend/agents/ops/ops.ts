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
import { listVms, vmHostIds } from "./vms.js";
import type { Platforms } from "../../events/platforms.js";

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
  options: {
    audit?: AgentAudit;
    events?: Events;
    /**
     * 1.4.10: whether commands that wait a fixed time are refused (the
     * admin setting banSleep). Left out: refused.
     */
    banSleep?: () => Promise<boolean>;
    /** 1.4.10, phase 3: hosts runs found to be Windows hosts. */
    platforms?: Platforms;
  } = {},
) {
  const events = options.events ?? createEvents(store);
  // VM steps (1.4.7): HAW's hosts, from the copy the token keeps (H3).
  const access = createAccess(store, vmHostIds, options.platforms);
  const reads = createReads(store, live, access);
  const banSleep = options.banSleep ?? (async () => true);
  const authoring = createAuthoring(
    store,
    events,
    access,
    reads,
    banSleep,
    options.audit,
  );
  const complete = createComplete(
    store,
    events,
    { ...options, banSleep },
    access,
    reads,
  );

  return {
    listHosts: access.listHosts,
    listVms,
    listRunbooks: reads.listRunbooks,
    getRunbook: reads.getRunbook,
    createRunbook: authoring.createRunbook,
    updateRunbook: authoring.updateRunbook,
    addSteps: authoring.addSteps,
    updateStep: authoring.updateStep,
    removeStep: authoring.removeStep,
    reorderSteps: authoring.reorderSteps,
    getValues: reads.getValues,
    getAttempt: reads.getAttempt,
    completeAgentStep: complete.completeAgentStep,
    amendStep: complete.amendStep,
    listEvents: reads.listEvents,
  };
}
