/**
 * The wait events built into the plugin (1.4.10, phase 3 of the sequences
 * plan): port, http, file, container, unit, log and job. Each is a sequence
 * item that polls on the phase 2 schedule (schedule.ts) until the state it
 * names holds, within its time limit. The plugin does the checking itself
 * (the owner, 2026-11-19): it opens a TCP channel from the host through the
 * SSH connection, reads a file's attributes over SFTP, or runs one fixed
 * read-only command and reads its structured output in JavaScript. The host
 * never runs a loop, grep or a test.
 *
 * Every item says exactly what it does (eventWhat): the fixed command it
 * runs, or "TCP 127.0.0.1:8443 on home-server, through the SSH connection".
 * Every name, path and unit goes into a fixed command shell-quoted, after
 * `--`, so it is never read as an option or as shell text.
 *
 * container, unit, log and job read Docker or systemd: Linux only, refused
 * on a Windows host. port, http and file (without sudo) use SSH channels
 * and SFTP, which Windows OpenSSH has too.
 *
 * Shared by the server and the UI. No React and no Node here.
 */

import type { Schedule } from "./schedule.js";
import { shellQuote, type OnFail } from "./sequence.js";

export const EVENT_TYPES = [
  "port",
  "http",
  "file",
  "container",
  "unit",
  "log",
  "job",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Events that read Docker or systemd: refused on a Windows host. */
export const LINUX_ONLY_EVENTS: readonly EventType[] = [
  "container",
  "unit",
  "log",
  "job",
];

/** The limits of the events, in one place. */
export const EVENT_LIMITS = {
  /** One check's time limit when the item gives none, in ms. */
  timeoutMs: 30_000,
  url: 2000,
  path: 1000,
  contains: 500,
  pattern: 200,
  /** The longest log line a pattern is tested on; the rest is cut. */
  logLine: 4096,
  /** The most of an HTTP answer's body the plugin reads and keeps. */
  body: 65_536,
  bodyShown: 2048,
} as const;

/** The loopback names a port or http item may reach through SSH. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

/** What every event item has: its schedule and time limit, as a wait has. */
interface EventBase extends Schedule {
  label: string | null;
  onFail: OnFail;
  /** Most seconds for all checks and delays: 1 to 7200. */
  within: number;
  /** Most checks; null: the top limit (500). */
  attempts: number | null;
  /** One check's time limit; null: 30 s. */
  timeoutMs: number | null;
}

/** A TCP port on the host's loopback is open or closed, as the host sees it. */
export interface PortItemSpec extends EventBase {
  type: "port";
  port: number;
  state: "open" | "closed";
  /** 127.0.0.1 (the default), localhost or ::1. */
  host: string;
}

/**
 * An address answers with a status (and text). A loopback URL goes through
 * the SSH connection to the host's own loopback; any other from Termix.
 */
export interface HttpItemSpec extends EventBase {
  type: "http";
  url: string;
  status: number;
  contains: string | null;
  /** The name the certificate must hold, for a loopback https URL. */
  servername: string | null;
}

/** A path exists, has content, or is gone. */
export interface FileItemSpec extends EventBase {
  type: "file";
  path: string;
  state: "exists" | "nonEmpty" | "gone";
  /** Read it with one fixed `sudo -n stat` (Linux) instead of SFTP. */
  sudo: boolean;
}

/** A container is healthy, running, exited or gone. */
export interface ContainerItemSpec extends EventBase {
  type: "container";
  name: string;
  state: "healthy" | "running" | "exited" | "gone";
}

/** A systemd unit is active, or finished with success. */
export interface UnitItemSpec extends EventBase {
  type: "unit";
  name: string;
  state: "active" | "finished";
}

/** A container's or unit's log shows a line written after the step started. */
export interface LogItemSpec extends EventBase {
  type: "log";
  container: string | null;
  unit: string | null;
  pattern: string;
  /** A line that matches it fails the item at once. */
  failPattern: string | null;
  /** A unit's journal read with `sudo -n journalctl`. */
  sudo: boolean;
}

/**
 * A long command started as a transient systemd unit, followed to its end:
 * it passes when the unit finished with Result=success.
 */
export interface JobItemSpec extends EventBase {
  type: "job";
  command: string;
  /** The unit's name; null: runbooks-job-<run>-<item>.service. */
  unit: string | null;
}

export type EventItemSpec =
  | PortItemSpec
  | HttpItemSpec
  | FileItemSpec
  | ContainerItemSpec
  | UnitItemSpec
  | LogItemSpec
  | JobItemSpec;

/** Whether an item type is one of the events. */
export function isEventType(type: string): type is EventType {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

/** Whether the event needs a Linux host (Docker, systemd, sudo stat). */
export function linuxOnly(item: EventItemSpec): boolean {
  return (
    LINUX_ONLY_EVENTS.includes(item.type) || (item.type === "file" && item.sudo)
  );
}

/** The text fields of each event that may hold {{name}} values. */
export const EVENT_TEXT_FIELDS: Record<EventType, readonly string[]> = {
  port: [],
  http: ["url", "contains", "servername"],
  file: ["path"],
  container: ["name"],
  unit: ["name"],
  log: ["container", "unit"],
  job: ["command", "unit"],
};

// --- Names, as the server checks them when a step is written -------------

/** A container's name or id, as Docker allows it. */
export const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A systemd unit's name: letters, digits and :-_.\@, no leading dash. */
export const UNIT_NAME = /^[A-Za-z0-9:_.\\@][A-Za-z0-9:_.\\@-]{0,254}$/;

/** A host name a certificate may hold (servername). */
export const SERVER_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** A job's unit with ".service" when it has no suffix. */
export function serviceName(unit: string): string {
  return /\.[a-z]+$/.test(unit) ? unit : `${unit}.service`;
}

/** The unit a job runs as: its own name, or one made from the run. */
export function jobUnit(
  item: Pick<JobItemSpec, "unit">,
  runId: number | null,
  position: number,
): string {
  if (item.unit) return serviceName(item.unit);
  return `runbooks-job-${runId ?? "<run>"}-${position}.service`;
}

/** Whether a URL's host is the loopback (127.0.0.1, localhost, [::1]). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (LOOPBACK_HOSTS as readonly string[]).includes(host);
  } catch {
    return false;
  }
}

/** The host to open a channel to: localhost is 127.0.0.1. */
export function channelHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" ? "127.0.0.1" : bare;
}

// --- The fixed commands ---------------------------------------------------

/** docker inspect's format: the state and the restart count, as JSON. */
export const INSPECT_FORMAT =
  '{"State":{{json .State}},"RestartCount":{{.RestartCount}}}';

/** The properties a unit check reads. */
export const UNIT_PROPERTIES = [
  "LoadState",
  "ActiveState",
  "SubState",
  "Result",
  "ExecMainCode",
  "ExecMainStatus",
  "ExecMainExitTimestamp",
  "NRestarts",
];

export function containerCommand(name: string): string {
  return `docker container inspect --format ${shellQuote(INSPECT_FORMAT)} -- ${shellQuote(name)}`;
}

export function unitCommand(name: string): string {
  return `systemctl show --timestamp=unix -p ${UNIT_PROPERTIES.join(",")} -- ${shellQuote(name)}`;
}

/** `since`: Unix seconds, or an RFC 3339 time of the last line read. */
export function dockerLogsCommand(name: string, since: string): string {
  return `docker logs --timestamps --since ${shellQuote(since)} -- ${shellQuote(name)}`;
}

/** From `since` (Unix seconds), or after the cursor of the last line read. */
export function journalCommand(
  unit: string,
  from: { since: string } | { cursor: string },
  sudo: boolean,
): string {
  const where =
    "cursor" in from
      ? `--after-cursor=${shellQuote(from.cursor)}`
      : `--since ${shellQuote(`@${from.since}`)}`;
  return `${sudo ? "sudo -n " : ""}journalctl -u ${shellQuote(unit)} ${where} -o json --output-fields=MESSAGE --no-pager`;
}

export function sudoStatCommand(path: string): string {
  return `sudo -n stat -L -c '%s %F' -- ${shellQuote(path)}`;
}

/**
 * The command that starts a job: a transient system unit, run as root with
 * `sudo -n` (the jobs our runbooks ran used `sudo systemd-run`). It stays
 * loaded after it ends (RemainAfterExit), so the plugin reads its Result;
 * jobCleanupCommand unloads it after.
 */
export function jobStartCommand(
  unit: string,
  command: string,
  workdir: string | null,
): string {
  const dir = workdir ? ` --working-directory=${shellQuote(workdir)}` : "";
  return `sudo -n systemd-run --unit=${shellQuote(unit)} --description='Runbooks job' --property=RemainAfterExit=yes${dir} -- /bin/sh -c ${shellQuote(command)}`;
}

/** Stops the job's unit (Stop, or out of time), and unloads it. */
export function jobCleanupCommand(unit: string): string {
  return `sudo -n systemctl stop -- ${shellQuote(unit)}; sudo -n systemctl reset-failed -- ${shellQuote(unit)} 2>/dev/null; true`;
}

// --- What each item does, in words ----------------------------------------

/** "home-server", or "the host" when the name is not known. */
function on(host: string | null): string {
  return host ? `on ${host}` : "on the host";
}

/**
 * What the item checks, exactly, in one or a few lines: the person reads it
 * on the card and approves it; agents read it as the item's command. The
 * fixed commands are shown as they run, with <step start> for the time
 * the run fills in.
 */
export function eventWhat(
  item: EventItemSpec,
  host: string | null = null,
  runId: number | null = null,
  position = 1,
): string {
  switch (item.type) {
    case "port": {
      const address = item.host.includes(":")
        ? `[${item.host}]:${item.port}`
        : `${item.host}:${item.port}`;
      return `TCP ${address} ${on(host)}, through the SSH connection: until ${item.state}`;
    }
    case "http": {
      const via = isLoopbackUrl(item.url)
        ? `${on(host)}, through the SSH connection`
        : "from Termix";
      const name = item.servername
        ? `, certificate for ${item.servername}`
        : "";
      const text = item.contains ? ` with "${item.contains}"` : "";
      return `GET ${item.url} ${via}${name}: until HTTP ${item.status}${text}`;
    }
    case "file":
      return item.sudo
        ? `${sudoStatCommand(item.path)}\n# until ${fileStateWords(item.state)}`
        : `SFTP stat ${item.path} ${on(host)}: until ${fileStateWords(item.state)}`;
    case "container":
      return `${containerCommand(item.name)}\n# until ${item.state}`;
    case "unit":
      return `${unitCommand(item.name)}\n# until ${item.state === "finished" ? "finished with Result=success" : "active"}`;
    case "log": {
      const read = item.container
        ? dockerLogsCommand(item.container, "<step start>")
        : journalCommand(item.unit ?? "", { since: "<step start>" }, item.sudo);
      const fail = item.failPattern ? `, fails on /${item.failPattern}/` : "";
      return `${read}\n# until a new line matches /${item.pattern}/${fail}`;
    }
    case "job": {
      const unit = jobUnit(item, runId, position);
      return [
        jobStartCommand(unit, item.command, null),
        `# then until it ends: ${unitCommand(unit)}`,
        `# its journal: ${journalCommand(unit, { since: "<step start>" }, true)}`,
        `# at the end: ${jobCleanupCommand(unit)}`,
      ].join("\n");
    }
  }
}

function fileStateWords(state: FileItemSpec["state"]): string {
  return state === "nonEmpty" ? "it has content" : state;
}
