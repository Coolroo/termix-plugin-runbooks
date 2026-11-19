import { createHmac, randomBytes } from "node:crypto";
import type { MockPluginContext } from "@termix-ssh/plugin-sdk/testing";

/**
 * A stand-in for HAW VM Manager's service haw.vms 1.0.0 that follows its
 * contract (docs/service.md in HAW): a caller's key comes only through the
 * plugin's own receiver in ctx.registry, the plugin must be on the admin's
 * list, caller.user must be the acting user, an agent caller may only use
 * hosts and list, the person's HAW role decides reads and actions, and the
 * host's own limits (name pattern, protect list, state) refuse actions. A
 * VM that starts or stops passes through starting or stopping, and reaches
 * its state after `settleAfter` reads.
 */

interface FakeVm {
  name: string;
  id: string;
  state: string;
  cpus: number;
  memoryMB: number;
  uptimeSeconds: number;
  addresses: string[];
  allowed: boolean;
  protected: boolean;
}

export interface FakeHawCall {
  method: string;
  user: string | undefined;
  ref: string | null;
  agent: boolean;
  host?: number;
  name?: string;
  force?: boolean;
}

class VmServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VmServiceError";
  }
}

const AGENT_VERBS = new Set(["hosts", "list"]);
const VERBS = [
  "info",
  "list",
  "show",
  "start",
  "stop",
  "restart",
  "console-info",
];

export type FakeHawService = ReturnType<typeof createFakeHaw>;

export function createFakeHaw(mock: () => MockPluginContext) {
  let master = randomBytes(32);
  const keyFor = (plugin: string) =>
    createHmac("sha256", master).update(`haw.vms:${plugin}`).digest("hex");

  const fake = {
    /** "Plugins that may act for a person". */
    allowed: new Set(["runbooks"]),
    /** HAW roles; a user not here has none. */
    roles: new Map<string, string>([
      ["alice", "operator"],
      ["bob", "viewer"],
    ]),
    /** VM hosts by Termix host id: host 1 is a Hyper-V host. */
    hostMap: new Map<number, { name: string; verbs: string[] }>([
      [1, { name: "host-1", verbs: [...VERBS] }],
    ]),
    vms: new Map<string, FakeVm>(),
    /** Reads after which a starting or stopping VM reaches its state. */
    settleAfter: 1,
    /** A VM that never settles stays starting or stopping. */
    stuck: false,
    /** The next `show` calls fail with code unreachable. */
    unreachableShows: 0,
    /** Every call, refused ones too. */
    calls: [] as FakeHawCall[],
    binds: 0,
    /** HAW restarted: every key it gave is refused (bad-key). */
    rotateKeys() {
      master = randomBytes(32);
    },
    seed(host: number, vm: Partial<FakeVm> & { name: string }) {
      fake.vms.set(`${host}/${vm.name}`, {
        id: `id-${vm.name}`,
        state: "off",
        cpus: 2,
        memoryMB: 4096,
        uptimeSeconds: 0,
        addresses: [],
        allowed: true,
        protected: false,
        ...vm,
      });
    },
  };
  /** Pending state changes: key -> [target, reads left]. */
  const settling = new Map<string, [string, number]>();

  function actor(): string | undefined {
    return mock().ctx.currentActor();
  }

  function refuse(message: string, code: string, status: number): never {
    throw new VmServiceError(message, code, status);
  }

  function admit(
    method: string,
    caller: unknown,
    extra: Partial<FakeHawCall> = {},
  ) {
    const given = (caller ?? {}) as {
      plugin?: string;
      key?: string;
      user?: string;
      ref?: string;
      agent?: boolean;
    };
    fake.calls.push({
      method,
      user: actor(),
      ref: given.ref ?? null,
      agent: given.agent === true,
      ...extra,
    });
    const user = actor();
    if (!user) refuse("haw.vms needs an acting user", "no-actor", 401);
    if (typeof given.plugin !== "string" || typeof given.key !== "string") {
      refuse("a caller is { plugin, key, user }", "bad-request", 400);
    }
    if (given.key !== keyFor(given.plugin!)) {
      refuse(
        `the key is not ${given.plugin}'s: call bindPlugin again`,
        "bad-key",
        403,
      );
    }
    if (!fake.allowed.has(given.plugin!)) {
      refuse(
        `plugin ${given.plugin} may not act for people in HAW: an admin adds it to "Plugins that may act for a person" in HAW's settings`,
        "plugin-not-allowed",
        403,
      );
    }
    if (given.user !== user) {
      refuse(
        "caller.user is not the user this call runs as",
        "not-acting-user",
        403,
      );
    }
    if (given.agent && !AGENT_VERBS.has(method)) {
      refuse(
        `a call for an agent token may only list hosts and VMs, not ${method}`,
        "agent-read-only",
        403,
      );
    }
    return user!;
  }

  function role(user: string, operate: boolean): void {
    const held = fake.roles.get(user) ?? null;
    const ok = operate
      ? held === "owner" || held === "operator"
      : held !== null;
    if (!ok)
      refuse(
        `you may not ${operate ? "start or stop VMs" : "see VMs"}`,
        "role",
        403,
      );
  }

  function vmHost(host: unknown) {
    const found = fake.hostMap.get(host as number);
    if (!found) refuse("no such VM host", "not-a-vm-host", 404);
    return found!;
  }

  function vmOf(host: number, name: string): FakeVm {
    const vm = fake.vms.get(`${host}/${name}`);
    if (!vm) refuse(`no VM named ${name}`, "not-found", 404);
    return vm!;
  }

  const listed = (vm: FakeVm) => ({ ...vm, addresses: [...vm.addresses] });

  function settle(host: number, vm: FakeVm): void {
    const key = `${host}/${vm.name}`;
    const pending = settling.get(key);
    if (!pending || fake.stuck) return;
    if (pending[1] <= 1) {
      vm.state = pending[0];
      if (vm.state === "running") vm.addresses = ["fe80::1", "192.0.2.10"];
      if (vm.state === "off") vm.addresses = [];
      settling.delete(key);
    } else pending[1]--;
  }

  function power(
    verb: "start" | "stop" | "restart",
    caller: unknown,
    host: number,
    name: string,
    force?: boolean,
  ) {
    const user = admit(verb, caller, { host, name, force: force === true });
    role(user, true);
    vmHost(host);
    const vm = vmOf(host, name);
    if (!vm.allowed) {
      refuse(
        `${name} does not match this host's name pattern`,
        "name-not-allowed",
        403,
      );
    }
    if (vm.protected && verb !== "start") {
      refuse(`${name} is on this host's protect list`, "protected", 403);
    }
    if (verb === "start" && vm.state === "running") {
      refuse(`${name} is running already`, "wrong-state", 409);
    }
    if (verb === "stop" && vm.state === "off") {
      refuse(`${name} is off already`, "wrong-state", 409);
    }
    const key = `${host}/${name}`;
    if (verb === "stop" && force) {
      vm.state = "off";
      vm.addresses = [];
    } else {
      vm.state = verb === "stop" ? "stopping" : "starting";
      settling.set(key, [
        verb === "stop" ? "off" : "running",
        fake.settleAfter,
      ]);
    }
    return listed(vm);
  }

  return Object.assign(fake, {
    keyFor,
    async bindPlugin(pluginId: string) {
      fake.binds++;
      if (!fake.allowed.has(pluginId)) {
        refuse(
          `plugin ${pluginId} may not act for people in HAW: an admin adds it to "Plugins that may act for a person" in HAW's settings`,
          "plugin-not-allowed",
          403,
        );
      }
      const receiver = mock().ctx.registry.consume<unknown>(
        `${pluginId}.hawVmsKey`,
      );
      if (typeof receiver !== "function") {
        refuse(`plugin ${pluginId} has no receiver`, "no-receiver", 409);
      }
      await (receiver as (key: string) => unknown)(keyFor(pluginId));
    },
    async me(caller: unknown) {
      const user = admit("me", caller);
      return { role: fake.roles.get(user) ?? null, version: "1.0.3" };
    },
    async hosts(caller: unknown) {
      const user = admit("hosts", caller);
      role(user, false);
      return [...fake.hostMap].map(([hostId, host]) => ({
        hostId,
        name: host.name,
        address: `10.0.0.${hostId}`,
        interface: "hyperv",
        verbs: host.verbs,
        lastCheckedAt: "2026-11-18T00:00:00.000Z",
      }));
    },
    async list(caller: unknown, host: number) {
      const user = admit("list", caller, { host });
      role(user, false);
      vmHost(host);
      return [...fake.vms]
        .filter(([key]) => key.startsWith(`${host}/`))
        .map(([, vm]) => ({ ...listed(vm), consoleHostId: 3 }));
    },
    async show(caller: unknown, host: number, name: string) {
      const user = admit("show", caller, { host, name });
      role(user, false);
      vmHost(host);
      if (fake.unreachableShows > 0) {
        fake.unreachableShows--;
        refuse("the SSH login failed", "unreachable", 502);
      }
      const vm = vmOf(host, name);
      settle(host, vm);
      return {
        ...listed(vm),
        generation: 2,
        disks: [{ sizeGB: 64, usedGB: 20 }],
        networks: [
          {
            switch: "lan",
            mac: "00:15:5d:00:00:01",
            addresses: [...vm.addresses],
          },
        ],
        checkpoints: 0,
        notes: "",
      };
    },
    start: (caller: unknown, host: number, name: string) =>
      Promise.resolve().then(() => power("start", caller, host, name)),
    stop: (
      caller: unknown,
      host: number,
      name: string,
      options?: { force?: boolean },
    ) =>
      Promise.resolve().then(() =>
        power("stop", caller, host, name, options?.force),
      ),
    restart: (
      caller: unknown,
      host: number,
      name: string,
      options?: { force?: boolean },
    ) =>
      Promise.resolve().then(() =>
        power("restart", caller, host, name, options?.force),
      ),
    async consoleInfo(caller: unknown, host: number, name: string) {
      const user = admit("consoleInfo", caller, { host, name });
      role(user, true);
      vmHost(host);
      const vm = vmOf(host, name);
      if (!vm.allowed) {
        refuse(
          `${name} does not match this host's name pattern`,
          "name-not-allowed",
          403,
        );
      }
      return {
        console: {
          kind: "vmconnect",
          host: "hv1.example.lan",
          port: 2179,
          vmId: vm.id,
        },
        consoleHost: { id: 3, name: "host-3" },
      };
    },
  });
}
