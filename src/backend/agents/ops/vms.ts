/**
 * What an agent may read of HAW's VMs (1.4.7, H3): the token's hosts that
 * HAW manages, and the VMs on one of them, so it can write a correct VM
 * step. Read as the person who made the token, marked `agent`, so HAW
 * answers its hosts and list verbs only; an agent never acts on a VM.
 */

import { InputError } from "../../core/errors.js";
import { NO_HAW, type Haw } from "../../vms/haw.js";
import { tokenHosts, type AgentCaller } from "./access.js";

/** Refusals that mean HAW cannot say, not that the host is wrong. */
const UNKNOWN = new Set(["no-haw", "plugin-not-allowed", "haw-permission"]);

export type AgentVms = ReturnType<typeof createAgentVms>;

export function createAgentVms(haw?: Haw) {
  /** HAW, read as the person who made the token, marked for an agent. */
  async function asMaker<T>(caller: AgentCaller, fn: (haw: Haw) => Promise<T>) {
    if (!haw) throw new InputError(NO_HAW, 409, { code: "no-haw" });
    return haw.asUser(caller.token.createdBy, () => fn(haw));
  }

  /** The token's hosts that HAW manages, with the verbs each offers. */
  async function vmHosts(caller: AgentCaller) {
    const mine = new Map(
      (await tokenHosts(caller)).map((host) => [host.id, host]),
    );
    const managed = await asMaker(caller, (h) => h.hosts({ agent: true }));
    return managed
      .filter((host) => mine.has(host.hostId))
      .map((host) => ({
        hostId: host.hostId,
        name: mine.get(host.hostId)!.name,
        verbs: host.verbs,
        lastCheckedAt: host.lastCheckedAt,
      }));
  }

  return {
    /**
     * The HAW host ids this token may name in a VM step, or null when HAW
     * cannot say: the step is then checked when a person opens it.
     */
    async vmHostIds(caller: AgentCaller): Promise<Set<number> | null> {
      if (!haw || !(await haw.available())) return null;
      try {
        return new Set((await vmHosts(caller)).map((host) => host.hostId));
      } catch (error) {
        if (
          error instanceof InputError &&
          UNKNOWN.has(String(error.extra.code ?? ""))
        ) {
          return null;
        }
        throw error;
      }
    },

    /**
     * GET /vms: without `host`, the token's VM hosts; with it, that host's
     * VMs (name, state, CPUs, memory, addresses, whether the host's limits
     * allow actions on it). Read only.
     */
    async listVms(caller: AgentCaller, query: { host?: unknown }) {
      const hosts = await vmHosts(caller);
      if (query.host === undefined || query.host === "") return { hosts };
      const hostId = Number(query.host);
      const host = hosts.find((h) => h.hostId === hostId);
      if (!Number.isInteger(hostId) || !host) {
        throw new InputError(
          `host ${String(query.host)} is not a VM host this token may use; call list_vms without host`,
          404,
        );
      }
      const vms = await asMaker(caller, (h) => h.list(hostId, { agent: true }));
      return {
        host,
        vms: vms.map((vm) => ({
          name: vm.name,
          state: vm.state,
          cpus: vm.cpus,
          memoryMB: vm.memoryMB,
          addresses: vm.addresses,
          allowed: vm.allowed,
          protected: vm.protected,
        })),
      };
    },
  };
}
