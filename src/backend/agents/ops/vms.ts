/**
 * What an agent may read of HAW's VMs (1.4.7, H3): the token's hosts that
 * HAW manages, and the VMs on one of them, so it can write a correct VM
 * step. An agent never acts on a VM.
 *
 * An agent request has no acting user, and Termix core refuses a service
 * call without one (EPLUGINSVCACTOR), so Runbooks never asks HAW during an
 * agent request. It reads HAW when a person saves a token's hosts, as that
 * person and marked `agent` (HAW answers its hosts and list verbs only),
 * and keeps a copy in the token's host list. Agents read the copy.
 */

import { InputError } from "../../core/errors.js";
import { NO_HAW, type Haw } from "../../vms/haw.js";
import type { TokenHost, TokenHostVm } from "../../runbooks/store/types.js";
import type { AgentCaller } from "./access.js";

const NO_COPY = `this token has no copy of HAW's VM hosts (HAW was not there when its hosts were saved, or they were saved before 1.4.7). ${NO_HAW}, then a person saves the token's hosts again in Runbooks`;

/**
 * HAW's view of each chosen host, read now as the acting person (the one
 * saving the token's hosts). Never fails: without HAW the hosts stay as
 * they are, and when HAW refuses, each host says why; the token saves
 * either way.
 */
export async function readTokenVms(
  haw: Haw,
  hosts: TokenHost[],
  ref: string,
): Promise<TokenHost[]> {
  const readAt = new Date().toISOString();
  const unknown = (reason: string): TokenHostVm => ({
    readAt,
    managed: null,
    reason,
  });
  const why = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  if (!(await haw.available())) return hosts;
  let managed: Awaited<ReturnType<Haw["hosts"]>>;
  try {
    managed = await haw.hosts({ agent: true, ref });
  } catch (error) {
    return hosts.map((host) => ({ ...host, vm: unknown(why(error)) }));
  }
  const byId = new Map(managed.map((host) => [host.hostId, host]));
  return Promise.all(
    hosts.map(async (host): Promise<TokenHost> => {
      const found = byId.get(host.id);
      if (!found) return { ...host, vm: { readAt, managed: false } };
      const vm: TokenHostVm = {
        readAt,
        managed: true,
        verbs: found.verbs,
        lastCheckedAt: found.lastCheckedAt,
      };
      try {
        const vms = await haw.list(host.id, { agent: true, ref });
        vm.vms = vms.map((one) => ({
          name: one.name,
          cpus: one.cpus,
          memoryMB: one.memoryMB,
          allowed: one.allowed,
          protected: one.protected,
        }));
      } catch (error) {
        vm.vms = null;
        vm.reason = why(error);
      }
      return { ...host, vm };
    }),
  );
}

/** The token's SSH hosts, each with HAW's copy when it has one. */
const sshHosts = (caller: AgentCaller) =>
  caller.token.hosts.filter((host) => host.ssh !== false);

/**
 * The HAW host ids this token may name in a VM step, from the copy, or
 * null when the copy cannot say (HAW was not there, refused, or the hosts
 * were saved before 1.4.7): the step is then checked when a person opens it.
 */
export async function vmHostIds(
  caller: AgentCaller,
): Promise<Set<number> | null> {
  const hosts = sshHosts(caller);
  if (hosts.some((host) => typeof host.vm?.managed !== "boolean")) {
    return null;
  }
  return new Set(
    hosts.filter((host) => host.vm!.managed).map((host) => host.id),
  );
}

/**
 * GET /vms: without `host`, the token's VM hosts; with it, that host's VMs
 * (name, CPUs, memory, whether the host's limits allow actions on it). From
 * the copy, with the time it was read; no VM state. Read only.
 */
export async function listVms(caller: AgentCaller, query: { host?: unknown }) {
  const all = sshHosts(caller);
  const managed = all.filter((host) => host.vm?.managed === true);
  if (managed.length === 0) {
    const unread = all.find((host) => host.vm?.managed === null);
    if (unread) {
      throw new InputError(
        `HAW could not say when this token's hosts were saved: ${unread.vm!.reason}`,
        409,
        { code: "no-vm-copy" },
      );
    }
    if (all.some((host) => !host.vm)) {
      throw new InputError(NO_COPY, 409, { code: "no-vm-copy" });
    }
  }
  const hosts = managed.map((host) => ({
    hostId: host.id,
    name: host.name ?? host.address,
    verbs: host.vm!.verbs ?? [],
    lastCheckedAt: host.vm!.lastCheckedAt ?? null,
    readAt: host.vm!.readAt,
  }));
  if (query.host === undefined || query.host === "") return { hosts };
  const hostId = Number(query.host);
  const index = hosts.findIndex((h) => h.hostId === hostId);
  if (!Number.isInteger(hostId) || index < 0) {
    throw new InputError(
      `host ${String(query.host)} is not a VM host this token may use; call list_vms without host`,
      404,
    );
  }
  const copy = managed[index].vm!;
  if (!copy.vms) {
    throw new InputError(
      `HAW could not list this host's VMs when the token's hosts were saved: ${copy.reason ?? "no answer"}`,
      409,
      { code: "no-vm-copy" },
    );
  }
  return { host: hosts[index], vms: copy.vms };
}
