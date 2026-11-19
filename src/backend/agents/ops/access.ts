/**
 * Whose runbooks and hosts an agent token may touch: its own runbooks only,
 * and the hosts a person chose for it.
 */

import type {
  RunbookRow,
  StepRow,
  TokenHost,
  TokenRow,
} from "../../runbooks/store/types.js";
import type { Store } from "../../runbooks/store/store.js";
import { InputError } from "../../core/errors.js";

export interface AgentCaller {
  token: TokenRow;
}

export type AgentHost = TokenHost;

export type Access = ReturnType<typeof createAccess>;

/**
 * HAW's VM hosts in the copy a token keeps (1.4.7, H3), read as the person
 * who saved its hosts, or null when the copy cannot say (HAW was not there,
 * or it did not let Runbooks act): then a VM step's card says why it cannot
 * run.
 */
export type VmHostIds = (caller: AgentCaller) => Promise<Set<number> | null>;

/**
 * The hosts this token may name in steps: the list a person chose when they
 * made or last edited the token, without the hosts found not to take SSH.
 * Nothing secret is in it.
 */
export async function tokenHosts(caller: AgentCaller): Promise<AgentHost[]> {
  return caller.token.hosts
    .filter((host) => host.ssh !== false)
    .map(({ id, name, address, folder }) => ({
      id,
      name,
      address,
      folder,
    }));
}

export function createAccess(store: Store, vmHostIds?: VmHostIds) {
  const owner = (caller: AgentCaller) => caller.token.createdBy;
  const listHosts = tokenHosts;

  async function hostNamer(caller: AgentCaller) {
    const names = new Map<number, string>();
    for (const host of caller.token.hosts) {
      names.set(host.id, host.name || host.address);
    }
    return (hostId: number) => names.get(hostId) ?? null;
  }

  async function checkHosts(
    caller: AgentCaller,
    stepList: Array<{
      hostId?: number | null;
      vm?: { host: number } | null;
    }>,
  ): Promise<void> {
    // A VM step's host (1.4.7) is a host the token may name, too.
    const vmHosts = [
      ...new Set(
        stepList
          .map((step) => step.vm?.host)
          .filter((id): id is number => typeof id === "number"),
      ),
    ];
    const wanted = [
      ...new Set(
        stepList
          .map((step) => step.hostId)
          .filter((id): id is number => typeof id === "number")
          .concat(vmHosts),
      ),
    ];
    if (wanted.length === 0) return;
    const known = new Set((await listHosts(caller)).map((host) => host.id));
    const notSsh = new Set(
      caller.token.hosts
        .filter((host) => host.ssh === false)
        .map((host) => host.id),
    );
    for (const hostId of wanted) {
      if (notSsh.has(hostId)) {
        throw new InputError(
          `host ${hostId} is not an SSH host; Runbooks runs commands over SSH only`,
        );
      }
      if (!known.has(hostId)) {
        throw new InputError(
          `host ${hostId} is not a host this token may use; call list_hosts`,
        );
      }
    }
    if (vmHosts.length === 0 || !vmHostIds) return;
    const managed = await vmHostIds(caller);
    if (!managed) return;
    const outside = vmHosts.find((hostId) => !managed.has(hostId));
    if (outside !== undefined) {
      throw new InputError(
        `host ${outside} is not a VM host in HAW: vm.host must be one HAW manages; call list_vms`,
      );
    }
  }

  async function ownRunbook(
    caller: AgentCaller,
    runbookId: number,
  ): Promise<RunbookRow> {
    const runbook = await store.getRunbook(runbookId);
    if (!runbook || runbook.createdByUserId !== owner(caller)) {
      throw new InputError("runbook not found", 404);
    }
    return runbook;
  }

  async function ownStep(
    caller: AgentCaller,
    stepId: number,
  ): Promise<{ step: StepRow; runbook: RunbookRow }> {
    const step = await store.getStep(stepId);
    if (!step) throw new InputError("step not found", 404);
    const runbook = await store.getRunbook(step.runbookId);
    if (!runbook || runbook.createdByUserId !== owner(caller)) {
      throw new InputError("step not found", 404);
    }
    return { step, runbook };
  }

  function requireOpen(runbook: RunbookRow): void {
    if (runbook.status !== "open") {
      throw new InputError(
        `runbook is ${runbook.status}; set status to open before changing steps`,
        409,
      );
    }
  }

  return {
    owner,
    listHosts,
    hostNamer,
    checkHosts,
    ownRunbook,
    ownStep,
    requireOpen,
  };
}
