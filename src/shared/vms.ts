/**
 * VM steps (1.4.7): a person presses one button and Runbooks asks HAW VM
 * Manager (its service haw.vms) to start, shut down, restart, show or open
 * the console of one VM, as that person. The step's shape, its checks, the
 * VM as HAW answers it and what the step makes of the answer: the summary
 * line and the values. Shared by the server and the page; no React and no
 * Node here.
 */

import { isOneLine, NAME } from "./names.js";

export const VM_ACTIONS = [
  "start",
  "stop",
  "restart",
  "show",
  "console",
] as const;
export type VmAction = (typeof VM_ACTIONS)[number];

/** A VM's state, as HAW's protocol has it. */
export const VM_STATES = [
  "running",
  "off",
  "starting",
  "stopping",
  "saved",
  "paused",
  "other",
] as const;
export type VmState = (typeof VM_STATES)[number];

/** A VM's name, as HAW takes it: no wildcards, no control characters. */
export const VM_NAME = /^[^*?[\]\u0000-\u001f]{1,100}$/;
/** How long a step waits for the state at most, and by default (H4). */
export const MAX_WAIT_SECONDS = 600;
export const DEFAULT_WAIT_SECONDS = 300;
/** How often a waiting step reads the VM's state. */
export const VM_POLL_MS = 2000;
/** A value prefix: the step sets <value>.state, .ip, .addresses and .id. */
export const MAX_VM_VALUE = 40;

/** The VM step's field, as stored: every default filled in. */
export interface VmSpec {
  /** The Termix host id that HAW manages as a VM host. */
  host: number;
  name: string;
  action: VmAction;
  /** stop or restart only: turn off or hard reset (H5). */
  force: boolean;
  /** The state to wait for; null: no wait. */
  waitFor: VmState | null;
  waitSeconds: number;
  /** The prefix of the values the step sets; null: none. */
  value: string | null;
}

/** A VM as HAW answers it (its protocol's VM). */
export interface Vm {
  name: string;
  id: string;
  state: VmState;
  cpus: number;
  memoryMB: number;
  uptimeSeconds: number;
  addresses: string[];
  /** Inside the host's name pattern. */
  allowed: boolean;
  /** On the host's protect list: never stopped from HAW. */
  protected: boolean;
}

/** A VM's details, from `show`. */
export interface VmDetail extends Vm {
  generation?: number | null;
  disks?: Array<{ sizeGB: number | null; usedGB: number | null }>;
  networks?: Array<{ switch: string; mac: string; addresses: string[] }>;
  checkpoints?: number;
  notes?: string;
}

/**
 * What the card of a VM step reads when it opens (GET /steps/{id}/vm):
 * whether HAW can do it now, the VM's state now, and what the host's own
 * limits say before anything is pressed.
 */
export interface VmStepState {
  /** HAW is there, lets Runbooks act for people, and answered. */
  ready: boolean;
  /** Why the step cannot run now, when it cannot; null otherwise. */
  reason: string | null;
  /** HAW's or Runbooks' code for `reason`. */
  code: string | null;
  /** The VM's details now; null when HAW could not read them. */
  vm: VmDetail | null;
  /** "The host refuses this", and why, before anything is pressed. */
  refused: string | null;
  /** The person's role in HAW: owner, operator, viewer or null. */
  role: string | null;
  /** The host's name in HAW, when it lists the host. */
  hostName: string | null;
  /** When this was read. */
  at: string;
}

/** The verb HAW's host offers for an action (`vmctl info`'s verbs). */
export function vmVerb(action: VmAction): string {
  return action === "console" ? "console-info" : action;
}

/** The state an action leads to: what a step waits for by default (H4). */
export function defaultWaitFor(action: VmAction): VmState | null {
  if (action === "start" || action === "restart") return "running";
  if (action === "stop") return "off";
  return null;
}

/** Whether the action changes the VM: HAW records it (not show). */
export function isVmPower(action: VmAction): boolean {
  return action === "start" || action === "stop" || action === "restart";
}

/** The values a VM step sets, by name, from its prefix. */
export function vmValueNames(spec: Pick<VmSpec, "value"> | null): string[] {
  if (!spec?.value) return [];
  return ["state", "ip", "addresses", "id"].map(
    (part) => `${spec.value}.${part}`,
  );
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The address a step gives as `ip`: the first IPv4 one, else the first. */
export function vmAddress(vm: Pick<Vm, "addresses">): string | null {
  const addresses = vm.addresses ?? [];
  return addresses.find((a) => IPV4.test(a)) ?? addresses[0] ?? null;
}

/**
 * The values a VM step sets from the VM: <value>.state and .id always,
 * .ip and .addresses (joined with commas) only when the VM has an address,
 * so a later step that needs one waits for it as for any value not set.
 */
export function vmValues(
  spec: Pick<VmSpec, "value">,
  vm: Pick<Vm, "state" | "id" | "addresses">,
): Record<string, string> {
  if (!spec.value) return {};
  const out: Record<string, string> = {
    [`${spec.value}.state`]: vm.state,
    [`${spec.value}.id`]: vm.id,
  };
  const ip = vmAddress(vm);
  if (ip) {
    out[`${spec.value}.ip`] = ip;
    out[`${spec.value}.addresses`] = vm.addresses.join(",");
  }
  return out;
}

/** "wyatt-pc-builder is running, 192.0.2.10": the run's last line. */
export function vmSummary(
  vm: Pick<Vm, "name" | "state" | "addresses">,
): string {
  const ip = vmAddress(vm);
  return `${vm.name} is ${vm.state}${ip ? `, ${ip}` : ""}`;
}

/**
 * A VM step's output: the VM as JSON, then the summary line. Checks and
 * when rules read it as they read a command's output.
 */
export function vmOutput(vm: VmDetail): string {
  return `${JSON.stringify(vm, null, 2)}\n${vmSummary(vm)}\n`;
}

/**
 * Why the host's own limits refuse the action, from the VM's details, or
 * null: outside the name pattern, every action but show (a console is
 * control of the VM); on the protect list, stop and restart.
 */
export function hostRefusal(
  action: VmAction,
  vm: Pick<Vm, "name" | "allowed" | "protected">,
): string | null {
  if (action === "show") return null;
  if (!vm.allowed) {
    return `The host refuses this: ${vm.name} is outside the host's name pattern`;
  }
  if (vm.protected && (action === "stop" || action === "restart")) {
    return `The host refuses this: ${vm.name} is on the host's protect list`;
  }
  return null;
}

function fail(message: string): never {
  throw new Error(message);
}

const FIELDS = [
  "host",
  "name",
  "action",
  "force",
  "waitFor",
  "waitSeconds",
  "value",
];

/**
 * A vm field as an author wrote it, checked, with its defaults: waitFor
 * the state the action leads to (null to end without waiting), waitSeconds
 * 300. Throws a message.
 */
export function parseVm(raw: unknown): VmSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      "vm must be an object { host, name, action, force?, waitFor?, waitSeconds?, value? }",
    );
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !FIELDS.includes(key));
  if (unknown !== undefined) fail(`vm has an unknown field "${unknown}"`);
  const { host, name, action, force, waitFor, waitSeconds, value } = input;
  if (!Number.isInteger(host) || (host as number) <= 0) {
    fail("vm.host must be the id of a Termix host that HAW manages");
  }
  if (typeof name !== "string" || !VM_NAME.test(name) || name.trim() !== name) {
    fail(
      "vm.name must be a VM's name: 1 to 100 characters, no * ? [ ] or control characters, no spaces at the ends",
    );
  }
  if (!VM_ACTIONS.includes(action as VmAction)) {
    fail(`vm.action must be one of ${VM_ACTIONS.join(", ")}`);
  }
  const act = action as VmAction;
  if (force !== undefined && force !== null && typeof force !== "boolean") {
    fail("vm.force must be true or false");
  }
  if (force === true && act !== "stop" && act !== "restart") {
    fail("vm.force is for stop and restart only: turn off or hard reset");
  }
  let wait: VmState | null;
  if (waitFor === undefined) wait = defaultWaitFor(act);
  else if (waitFor === null) wait = null;
  else if (VM_STATES.includes(waitFor as VmState)) wait = waitFor as VmState;
  else fail(`vm.waitFor must be one of ${VM_STATES.join(", ")}, or null`);
  if (wait && act === "console") {
    fail("vm.waitFor is not for console: the console waits for nothing");
  }
  if (
    waitSeconds !== undefined &&
    waitSeconds !== null &&
    (!Number.isInteger(waitSeconds) ||
      (waitSeconds as number) < 1 ||
      (waitSeconds as number) > MAX_WAIT_SECONDS)
  ) {
    fail(`vm.waitSeconds must be an integer from 1 to ${MAX_WAIT_SECONDS}`);
  }
  if (typeof waitSeconds === "number" && !wait) {
    fail("vm.waitSeconds needs a state to wait for (waitFor)");
  }
  let prefix: string | null = null;
  if (value !== undefined && value !== null && value !== "") {
    if (
      typeof value !== "string" ||
      !NAME.test(value) ||
      value.length > MAX_VM_VALUE ||
      !isOneLine(value)
    ) {
      fail(
        `vm.value must match ${NAME.source} and have at most ${MAX_VM_VALUE} characters`,
      );
    }
    if (act === "console") {
      fail("vm.value is not for console: it reads no VM state");
    }
    prefix = value;
  }
  return {
    host: host as number,
    name: name as string,
    action: act,
    force: force === true,
    waitFor: wait,
    waitSeconds: (waitSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS,
    value: prefix,
  };
}
