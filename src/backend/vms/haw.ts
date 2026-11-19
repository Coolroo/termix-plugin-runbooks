/**
 * VM steps (1.4.7) through HAW VM Manager's service, haw.vms (an optional
 * requirement in the manifest; HAW's docs/service.md). Runbooks keeps no VM
 * state of its own: every read and every action is HAW's, as the person who
 * pressed the button, with HAW's roles and the host's own limits.
 *
 * A service cannot tell which plugin calls it, so HAW hands Runbooks a key
 * through the receiver this plugin provides in ctx.registry, as OpenBao
 * Secrets does (secrets.ts). The key stays in memory, the receiver takes one
 * only while this plugin's own bindPlugin call runs, and a key HAW refuses
 * (it makes new ones when it starts) is bound again once.
 *
 * Every service and registry call is awaited, also where plugin API 1
 * answers at once, so the same code works under plugin API 2.
 */

import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { InputError } from "../core/errors.js";
import type { Vm, VmDetail, VmAction } from "../../shared/vms.js";

const SERVICE = "haw.vms";
export const NO_HAW =
  "Install HAW VM Manager 1.0.3 or later, with its VM service, to use VM steps";
const NOT_ALLOWED =
  'Runbooks may not act for people in HAW yet: an admin adds "runbooks" to "Plugins that may act for a person" in HAW\'s settings';
const KEY = /^[0-9a-f]{64}$/;

/** Who calls, as HAW's service takes it. */
export interface Caller {
  plugin: string;
  key: string;
  /** The acting user's id: HAW refuses any other. */
  user: string;
  /** For HAW's record: "runbook 12 step 3". */
  ref?: string;
  /** A read for an agent token: hosts and list only. */
  agent?: boolean;
}

export interface VmHost {
  hostId: number;
  name: string;
  address: string;
  interface: string;
  /** The verbs `vmctl info` listed when HAW last read the host. */
  verbs: string[];
  lastCheckedAt: string | null;
}

/** The part of HAW's service contract (haw.vms 1.0.0) Runbooks uses. */
export interface VmService {
  bindPlugin(pluginId: string): Promise<void>;
  me(caller: Caller): Promise<{ role: string | null; version: string }>;
  hosts(caller: Caller): Promise<VmHost[]>;
  list(
    caller: Caller,
    host: number,
  ): Promise<Array<Vm & { consoleHostId: number | null }>>;
  show(caller: Caller, host: number, name: string): Promise<VmDetail>;
  start(caller: Caller, host: number, name: string): Promise<Vm>;
  stop(
    caller: Caller,
    host: number,
    name: string,
    options?: { force?: boolean },
  ): Promise<Vm>;
  restart(
    caller: Caller,
    host: number,
    name: string,
    options?: { force?: boolean },
  ): Promise<Vm>;
  consoleInfo(
    caller: Caller,
    host: number,
    name: string,
  ): Promise<{
    console: { kind: string; host: string; port: number; vmId: string };
    consoleHost: { id: number; name: string } | null;
  }>;
}

/** The methods a VM step needs: an older HAW without one cannot run it. */
const METHODS: Array<keyof VmService> = [
  "bindPlugin",
  "me",
  "hosts",
  "list",
  "show",
  "start",
  "stop",
  "restart",
  "consoleInfo",
];

/** HAW's codes that say the host or the VM refused, not HAW or the call. */
const HOST_CODES = new Set([
  "not-found",
  "protected",
  "name-not-allowed",
  "ceiling",
  "wrong-state",
  "config",
  "backend",
]);

/** A read that may work if asked again: the host or vmctl did not answer. */
const PASSING_CODES = new Set(["unreachable", "timeout", "no-reply"]);

/** Whether a refusal may pass if the call is made again a little later. */
export function passing(error: unknown): boolean {
  return (
    error instanceof InputError &&
    PASSING_CODES.has(String(error.extra.code ?? ""))
  );
}

/** Whether the host itself refused (its limits, or the VM's state). */
export function byHost(error: unknown): boolean {
  return (
    error instanceof InputError &&
    HOST_CODES.has(String(error.extra.code ?? ""))
  );
}

export type Haw = Awaited<ReturnType<typeof createHaw>>;

export async function createHaw(ctx: PluginContext) {
  const pluginId = ctx.manifest.id;
  let key: string | null = null;
  let binding = false;
  let bound: Promise<void> | null = null;

  await ctx.registry.provide(`${pluginId}.hawVmsKey`, (given: unknown) => {
    // Anyone may call this; only a key given during our own bind counts.
    if (!binding) throw new Error("Runbooks is not binding");
    if (typeof given !== "string" || !KEY.test(given)) {
      throw new Error("not a HAW key");
    }
    key = given;
  });

  /** The service, or null when HAW is not there or too old for VM steps. */
  async function handle(): Promise<VmService | null> {
    const service = await ctx.services.get<Partial<VmService>>(SERVICE);
    if (!service || typeof service !== "object") return null;
    return METHODS.every((method) => typeof service[method] === "function")
      ? (service as VmService)
      : null;
  }

  /** HAW's error as a refusal the routes answer. Never a secret in it. */
  function refusal(error: unknown): InputError {
    if (error instanceof InputError) return error;
    const raw = error as { code?: unknown; status?: unknown; detail?: unknown };
    const code = typeof raw?.code === "string" ? raw.code : null;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "EPLUGINSVCGONE") {
      return new InputError(NO_HAW, 409, { code: "no-haw" });
    }
    if (code === "EPLUGINSVCPERM") {
      return new InputError(
        "you need HAW's See VMs permission to use VM steps",
        403,
        { code: "haw-permission" },
      );
    }
    if (code === "plugin-not-allowed") {
      return new InputError(NOT_ALLOWED, 403, { code });
    }
    if (code === "role") {
      return new InputError(`HAW: ${message}`, 403, { code });
    }
    const status =
      typeof raw?.status === "number" && raw.status >= 400 && raw.status < 600
        ? raw.status
        : 502;
    return new InputError(`HAW: ${message}`, status, {
      code: code ?? "haw-error",
      ...(typeof raw?.detail === "string" ? { detail: raw.detail } : {}),
    });
  }

  function isBadKey(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    if (code === "bad-key") return true;
    const message = error instanceof Error ? error.message : "";
    return /call bindPlugin again/i.test(message);
  }

  async function bind(service: VmService): Promise<void> {
    if (!bound) {
      bound = (async () => {
        binding = true;
        try {
          await service.bindPlugin(pluginId);
        } finally {
          binding = false;
        }
        if (!key) throw new Error("HAW gave no key");
      })().finally(() => {
        bound = null;
      });
    }
    await bound;
  }

  /**
   * Runs `fn` with HAW's service and a caller for the acting person,
   * binding again once when HAW refuses the key. Every error leaves as an
   * InputError with HAW's code.
   */
  async function call<T>(
    fn: (service: VmService, caller: Caller) => Promise<T>,
    options: { ref?: string; agent?: boolean } = {},
  ): Promise<T> {
    const service = await handle();
    if (!service) throw new InputError(NO_HAW, 409, { code: "no-haw" });
    const user = await ctx.currentActor();
    if (!user) {
      throw new InputError("VM steps need a signed-in person", 401, {
        code: "no-actor",
      });
    }
    const caller = (): Caller => ({
      plugin: pluginId,
      key: key!,
      user,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.agent ? { agent: true } : {}),
    });
    try {
      if (!key) await bind(service);
      try {
        return await fn(service, caller());
      } catch (error) {
        if (!isBadKey(error)) throw error;
        key = null;
        await bind(service);
        return await fn(service, caller());
      }
    } catch (error) {
      throw refusal(error);
    }
  }

  return {
    /** Whether HAW's service is there now, new enough (no call, no audit). */
    available: async () => (await handle()) !== null,

    /** The person's HAW role, and HAW's version. */
    me: () => call((service, caller) => service.me(caller)),

    /** The VM hosts the person can see. For an agent token: `agent`. */
    hosts: (options: { agent?: boolean } = {}) =>
      call((service, caller) => service.hosts(caller), options),

    /** The VMs on a host. For an agent token: `agent` (H3). */
    list: (host: number, options: { agent?: boolean } = {}) =>
      call((service, caller) => service.list(caller, host), options),

    /** One VM's details now. A read: not in HAW's record. */
    show: (host: number, name: string, ref?: string) =>
      call((service, caller) => service.show(caller, host, name), { ref }),

    /**
     * A power action as the person, recorded by HAW with `ref`. `force`
     * turns off or resets without asking the guest.
     */
    power: (
      action: Extract<VmAction, "start" | "stop" | "restart">,
      host: number,
      name: string,
      force: boolean,
      ref: string,
    ) =>
      call(
        (service, caller) =>
          action === "start"
            ? service.start(caller, host, name)
            : service[action](caller, host, name, { force }),
        { ref },
      ),

    /** The VM's console and the Termix host to open it in (recorded). */
    console: (host: number, name: string, ref: string) =>
      call((service, caller) => service.consoleInfo(caller, host, name), {
        ref,
      }),

    /** Runs `fn` as `userId` (the person who made an agent token). */
    asUser: <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
      ctx.asUser(userId, fn),
  };
}
