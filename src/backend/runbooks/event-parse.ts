/**
 * The wait events as an author writes them (1.4.10, phase 3): port, http,
 * file, container, unit, log and job, with errors that name the field
 * ("sequence[2].port"). Each has the wait item's schedule and a required
 * `within`. Names, paths, units and ports are checked here, when the step
 * is written, so a bad one is a clear 400 and never reaches a host; the
 * runner quotes them again when it builds the fixed commands.
 *
 * A text field may hold {{name}} values (EVENT_TEXT_FIELDS): it is checked
 * here with each value as a plain word, and again with the values filled
 * in before it runs.
 */

import { InputError } from "../core/errors.js";
import { strictObject } from "../core/parse.js";
import { isOneLine, PLACEHOLDER } from "../../shared/names.js";
import { SCHEDULE_LIMITS } from "../../shared/schedule.js";
import type { OnFail } from "../../shared/sequence.js";
import {
  CONTAINER_NAME,
  EVENT_LIMITS,
  isLoopbackUrl,
  linuxOnly,
  LOOPBACK_HOSTS,
  SERVER_NAME,
  UNIT_NAME,
  type ContainerItemSpec,
  type EventItemSpec,
  type EventType,
  type FileItemSpec,
  type HttpItemSpec,
  type JobItemSpec,
  type LogItemSpec,
  type PortItemSpec,
  type UnitItemSpec,
} from "../../shared/events.js";
import { sleepProblem } from "./no-sleep.js";
import {
  parseSchedule,
  SCHEDULE_FIELDS,
  shortText,
  wholeNumber,
} from "./item-fields.js";
import type { SequenceRules } from "./sequence-parse.js";

const BASE_FIELDS = [
  "type",
  "label",
  "onFail",
  "within",
  "attempts",
  "timeoutMs",
  ...SCHEDULE_FIELDS,
];

const FIELDS: Record<EventType, string[]> = {
  port: ["port", "state", "host"],
  http: ["url", "status", "contains", "servername"],
  file: ["path", "state", "sudo"],
  container: ["name", "state"],
  unit: ["name", "state"],
  log: ["container", "unit", "pattern", "failPattern", "sudo"],
  job: ["command", "unit"],
};

/** What each event's state may be; the first is the default, if any. */
const STATES: Partial<
  Record<EventType, { list: string[]; required: boolean }>
> = {
  port: { list: ["open", "closed"], required: false },
  file: { list: ["exists", "nonEmpty", "gone"], required: false },
  container: {
    list: ["healthy", "running", "exited", "gone"],
    required: true,
  },
  unit: { list: ["active", "finished"], required: true },
};

/**
 * A pattern a log line is tested on: a JavaScript regular expression of up
 * to 200 characters, with no quantified group that holds a quantifier (such
 * as (a+)+), which can take very long on a long line. Lines are cut to 4096
 * characters before the test too.
 */
export function logPatternProblem(
  pattern: unknown,
  field: string,
): string | null {
  if (typeof pattern !== "string" || pattern === "") {
    return `${field} must be a regular expression, such as "listening on"`;
  }
  if (pattern.length > EVENT_LIMITS.pattern) {
    return `${field} is longer than ${EVENT_LIMITS.pattern} characters`;
  }
  if (!isOneLine(pattern)) return `${field} must be one line`;
  try {
    new RegExp(pattern);
  } catch {
    return `${field} is not a valid regular expression`;
  }
  if (
    /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(
      pattern,
    )
  ) {
    return `${field} has a repeated group that holds a repeat, such as (a+)+, which can make a match take very long; write it without the nesting`;
  }
  return null;
}

/** The text with each {{name}} as a plain word, for the checks below. */
function plain(text: string): string {
  return text.replace(PLACEHOLDER, "value");
}

/** A required one-line text of at most `max` characters, no NUL. */
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${field} is required`);
  }
  if (value.length > max) {
    throw new InputError(`${field} is longer than ${max} characters`);
  }
  if (!isOneLine(value)) throw new InputError(`${field} must be one line`);
  return value.trim();
}

/** Why a container name is refused, or null. Values are words here. */
export function containerNameProblem(
  name: string,
  field: string,
): string | null {
  return CONTAINER_NAME.test(plain(name))
    ? null
    : `${field} must be a container name or id: letters, digits, _ . -, starting with a letter or digit, up to 128 characters`;
}

/** Why a unit name is refused, or null. */
export function unitNameProblem(name: string, field: string): string | null {
  return UNIT_NAME.test(plain(name))
    ? null
    : `${field} must be a systemd unit name, such as "nginx.service": letters, digits and : _ . \\ @ -, not starting with -`;
}

/** Why a path is refused, or null: absolute, one line. */
export function pathProblem(path: string, field: string): string | null {
  if (!path.startsWith("/") && !path.startsWith("{{")) {
    return `${field} must be an absolute path on the host, such as "/srv/app/ready" (on Windows OpenSSH, "/C:/path")`;
  }
  return null;
}

/**
 * Why a URL is refused, or null. https anywhere; plain http only to the
 * host's own loopback, through the SSH connection (the bytes never leave
 * the host unencrypted). No user or password in it. `servername` only for
 * a loopback URL: any other is checked against its own host name.
 */
export function urlProblem(
  url: string,
  field: string,
  servername: string | null,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(plain(url));
  } catch {
    return `${field} must be a full address, such as "https://127.0.0.1:8443/health"`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `${field} must start with https:// (or http:// to the host's own 127.0.0.1)`;
  }
  if (parsed.username || parsed.password) {
    return `${field} must not hold a user name or password`;
  }
  const loopback = isLoopbackUrl(plain(url));
  if (parsed.protocol === "http:" && !loopback) {
    return `${field}: plain http:// is allowed only to the host's own loopback (127.0.0.1, localhost or [::1]), through the SSH connection; use https:// for any other address`;
  }
  if (servername && !loopback) {
    return `${field}: servername is for a loopback URL only; any other address is checked against its own host name`;
  }
  if (servername && parsed.protocol === "http:") {
    return `${field}: servername is for an https:// URL only`;
  }
  return null;
}

function parseState(
  type: EventType,
  value: unknown,
  field: string,
): string | null {
  const states = STATES[type];
  if (!states) return null;
  if (value === undefined || value === null) {
    if (states.required) {
      throw new InputError(
        `${field}.state is required: ${states.list.map((each) => `"${each}"`).join(", ")}`,
      );
    }
    return states.list[0];
  }
  if (typeof value !== "string" || !states.list.includes(value)) {
    throw new InputError(
      `${field}.state must be ${states.list.map((each) => `"${each}"`).join(", ")}`,
    );
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new InputError(`${field} must be true or false`);
  }
  return value;
}

/** What every event has: label, onFail, within, attempts, the schedule. */
function parseBase(
  raw: Record<string, unknown>,
  field: string,
  rules: SequenceRules,
) {
  const onFail = (raw.onFail ?? "stop") as OnFail;
  if (onFail !== "stop" && onFail !== "continue") {
    throw new InputError(`${field}.onFail must be "stop" or "continue"`);
  }
  if (raw.within === undefined || raw.within === null) {
    throw new InputError(
      `${field}.within is required: the most seconds the item may wait, 1 to ${SCHEDULE_LIMITS.within}`,
    );
  }
  const within = wholeNumber(
    raw.within,
    `${field}.within`,
    1,
    SCHEDULE_LIMITS.within,
  )!;
  const attempts = wholeNumber(
    raw.attempts,
    `${field}.attempts`,
    1,
    SCHEDULE_LIMITS.attempts,
  );
  const timeoutMs = wholeNumber(
    raw.timeoutMs,
    `${field}.timeoutMs`,
    rules.timeoutMin,
    rules.timeoutMax,
  );
  return {
    label: shortText(raw.label, `${field}.label`, 120),
    onFail,
    within,
    attempts,
    timeoutMs,
    ...parseSchedule(raw, field),
  };
}

/** One event item, checked. */
export function parseEventItem(
  raw: Record<string, unknown>,
  field: string,
  rules: SequenceRules,
): EventItemSpec {
  const type = raw.type as EventType;
  strictObject(raw, [...BASE_FIELDS, ...FIELDS[type]], {
    notObject: `${field} must be an object`,
    field,
  });
  const base = parseBase(raw, field, rules);
  const state = parseState(type, raw.state, field);
  let item: EventItemSpec;
  switch (type) {
    case "port": {
      const port = wholeNumber(raw.port, `${field}.port`, 1, 65535);
      if (port === null) {
        throw new InputError(`${field}.port is required: 1 to 65535`);
      }
      const host = raw.host ?? "127.0.0.1";
      if (
        typeof host !== "string" ||
        !(LOOPBACK_HOSTS as readonly string[]).includes(host.toLowerCase())
      ) {
        throw new InputError(
          `${field}.host must be the host's own loopback: "127.0.0.1" (the default), "localhost" or "::1". A port item checks a port as the host sees it, through the SSH connection; it never reaches another address`,
        );
      }
      item = {
        type,
        ...base,
        port,
        state: state as PortItemSpec["state"],
        host: host.toLowerCase(),
      };
      break;
    }
    case "http": {
      const url = requiredText(raw.url, `${field}.url`, EVENT_LIMITS.url);
      const servername =
        raw.servername === undefined || raw.servername === null
          ? null
          : requiredText(raw.servername, `${field}.servername`, 253);
      if (servername && !SERVER_NAME.test(plain(servername))) {
        throw new InputError(
          `${field}.servername must be a host name, such as "termix.example.com"`,
        );
      }
      const problem = urlProblem(url, `${field}.url`, servername);
      if (problem) throw new InputError(problem);
      const status =
        wholeNumber(raw.status, `${field}.status`, 100, 599) ?? 200;
      const contains = shortText(
        raw.contains,
        `${field}.contains`,
        EVENT_LIMITS.contains,
      );
      item = { type, ...base, url, status, contains, servername };
      break;
    }
    case "file": {
      const path = requiredText(raw.path, `${field}.path`, EVENT_LIMITS.path);
      const problem = pathProblem(path, `${field}.path`);
      if (problem) throw new InputError(problem);
      item = {
        type,
        ...base,
        path,
        state: state as FileItemSpec["state"],
        sudo: parseBoolean(raw.sudo, `${field}.sudo`),
      };
      break;
    }
    case "container": {
      const name = requiredText(raw.name, `${field}.name`, 128);
      const problem = containerNameProblem(name, `${field}.name`);
      if (problem) throw new InputError(problem);
      item = {
        type,
        ...base,
        name,
        state: state as ContainerItemSpec["state"],
      };
      break;
    }
    case "unit": {
      const name = requiredText(raw.name, `${field}.name`, 255);
      const problem = unitNameProblem(name, `${field}.name`);
      if (problem) throw new InputError(problem);
      item = { type, ...base, name, state: state as UnitItemSpec["state"] };
      break;
    }
    case "log": {
      const has = (key: string) => raw[key] !== undefined && raw[key] !== null;
      if (has("container") === has("unit")) {
        throw new InputError(
          `${field} needs either container or unit: whose log to read`,
        );
      }
      const container = has("container")
        ? requiredText(raw.container, `${field}.container`, 128)
        : null;
      const unit = has("unit")
        ? requiredText(raw.unit, `${field}.unit`, 255)
        : null;
      const nameProblem = container
        ? containerNameProblem(container, `${field}.container`)
        : unitNameProblem(unit!, `${field}.unit`);
      if (nameProblem) throw new InputError(nameProblem);
      const patternProblem = logPatternProblem(raw.pattern, `${field}.pattern`);
      if (patternProblem) throw new InputError(patternProblem);
      const failPattern = has("failPattern") ? raw.failPattern : null;
      if (failPattern !== null) {
        const problem = logPatternProblem(failPattern, `${field}.failPattern`);
        if (problem) throw new InputError(problem);
      }
      const sudo = parseBoolean(raw.sudo, `${field}.sudo`);
      if (sudo && container) {
        throw new InputError(
          `${field}.sudo is for a unit's journal only: docker logs runs as the SSH user`,
        );
      }
      item = {
        type,
        ...base,
        container,
        unit,
        pattern: raw.pattern as string,
        failPattern: failPattern as string | null,
        sudo,
      };
      break;
    }
    case "job": {
      const command = raw.command;
      if (typeof command !== "string" || command.trim() === "") {
        throw new InputError(`${field}.command is required for a job item`);
      }
      if (command.length > rules.commandMax) {
        throw new InputError(
          `${field}.command is longer than ${rules.commandMax} characters`,
        );
      }
      if (command.includes("\0")) {
        throw new InputError(
          `${field}.command must not contain NUL characters`,
        );
      }
      if (rules.banSleep) {
        const problem = sleepProblem(command, `${field}.command`);
        if (problem) throw new InputError(problem, 400, { code: "sleep" });
      }
      const unit =
        raw.unit === undefined || raw.unit === null
          ? null
          : requiredText(raw.unit, `${field}.unit`, 200);
      if (unit) {
        const problem = unitNameProblem(unit, `${field}.unit`);
        if (problem) throw new InputError(problem);
        if (!/\.service$/.test(unit) && /\.[a-z]+$/.test(unit)) {
          throw new InputError(
            `${field}.unit must be a service: leave the suffix out or end it with .service`,
          );
        }
      }
      item = { type, ...base, command, unit };
      break;
    }
  }
  return item;
}

/**
 * Why a sequence cannot run on a Windows host, or null (the owner: Linux
 * events are refused when the runbook is written). container, unit, log
 * and job read Docker or systemd, and a file item with sudo runs sudo
 * stat: a Windows host has none of them.
 */
export function windowsProblem(
  sequence: ReadonlyArray<{ type: string }> | null,
  host: string,
): string | null {
  const index = (sequence ?? []).findIndex(
    (item) =>
      (item.type !== "run" &&
        item.type !== "wait" &&
        item.type !== "delay" &&
        linuxOnly(item as EventItemSpec)) ||
      false,
  );
  if (index === -1) return null;
  const item = sequence![index] as EventItemSpec;
  const what =
    item.type === "file"
      ? "a file item with sudo runs sudo stat"
      : item.type === "container" || (item.type === "log" && item.container)
        ? `a ${item.type} item reads Docker`
        : `a ${item.type} item reads systemd`;
  return `sequence[${index}]: ${host} is a Windows host, and ${what}, which only a Linux host has. On a Windows host use port, http, file (without sudo), run, wait and delay items`;
}

/**
 * Why an event cannot run with its values filled in, or null: the same
 * checks as when it was written, now on the real names, paths and URL (a
 * value an earlier item captured may be anything).
 */
export function filledEventProblem(item: EventItemSpec): string | null {
  switch (item.type) {
    case "http":
      return (
        urlProblem(item.url, "url", item.servername) ??
        (item.servername && !SERVER_NAME.test(item.servername)
          ? "servername must be a host name"
          : null)
      );
    case "file":
      return (
        pathProblem(item.path, "path") ??
        (isOneLine(item.path) ? null : "path must be one line")
      );
    case "container":
      return containerNameProblem(item.name, "name");
    case "unit":
      return unitNameProblem(item.name, "name");
    case "log":
      return item.container
        ? containerNameProblem(item.container, "container")
        : unitNameProblem(item.unit ?? "", "unit");
    case "job":
      return item.unit ? unitNameProblem(item.unit, "unit") : null;
    default:
      return null;
  }
}
