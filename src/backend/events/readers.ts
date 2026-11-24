/**
 * The readers of the wait events (1.4.10, phase 3): pure functions that
 * turn what a check got (a fixed command's output, an SFTP stat, a channel
 * that opened or was refused, an HTTP answer) into a verdict and the state
 * in words. Apart from the I/O (probes.ts), so each is tested against real
 * output captured from our hosts (tests/backend/fixtures/event-readers.json).
 *
 * A verdict is "pass" (the state holds), "wait" (not yet: check again on
 * the schedule) or "fail" (a state that fails the item at once: the
 * container exited, the unit failed, forwarding refused).
 *
 * The words (`result`) are built from fixed words and numbers only: a
 * Docker or systemd state word is kept only when it is a plain word. They
 * stay visible on a step whose output is hidden from agents, as an exit
 * code does, so free text from the host never goes into them.
 */

import vm from "node:vm";
import type {
  ContainerItemSpec,
  FileItemSpec,
  HttpItemSpec,
  PortItemSpec,
  UnitItemSpec,
} from "../../shared/events.js";
import { EVENT_LIMITS } from "../../shared/events.js";

export type Verdict = "pass" | "wait" | "fail";

export interface Reading {
  verdict: Verdict;
  /** The state in fixed words, such as "healthy" or "HTTP 503". */
  result: string;
  /** Why the item fails, in words; only with verdict "fail". */
  error?: string;
}

/** What a fixed command gave back. */
export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** A state word as the host wrote it, kept only when it is a plain word. */
export function word(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && /^[a-z][a-z-]{0,23}$/.test(value)
    ? value
    : fallback;
}

/** A whole number, or null. */
function int(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) ? number : null;
}

const SUDO_REFUSED = /^sudo: /m;

/** The words of a sudo -n that was refused: no password, or not allowed. */
function sudoRefused(output: CommandOutput): Reading | null {
  if (output.code === 0 || !SUDO_REFUSED.test(output.stderr)) return null;
  return {
    verdict: "fail",
    result: "sudo refused",
    error:
      "sudo -n refused: the SSH user may not run this with sudo without a password",
  };
}

// --- container --------------------------------------------------------------

/** What a container check keeps between two checks of one item. */
export interface ContainerMemory {
  /** RestartCount at the first check that found the container. */
  restarts: number | null;
}

/**
 * One `docker container inspect --format '{"State":...,"RestartCount":n}'`.
 * Missing: "gone" passes, the others wait (a deploy may not have made it
 * yet). While it waits for healthy or running, a container that exited, or
 * whose restart count grew since the first check, fails the item at once.
 */
export function readContainer(
  output: CommandOutput,
  state: ContainerItemSpec["state"],
  memory: ContainerMemory,
): Reading {
  if (output.code !== 0) {
    if (/No such (?:container|object)/i.test(output.stderr)) {
      return {
        verdict: state === "gone" ? "pass" : "wait",
        result: "not found",
      };
    }
    if (/permission denied/i.test(output.stderr)) {
      return {
        verdict: "fail",
        result: "docker refused",
        error:
          "the SSH user may not use Docker (permission denied on the Docker socket): add it to the docker group",
      };
    }
    if (
      output.code === 127 ||
      /not found|not recognized/i.test(output.stderr)
    ) {
      return {
        verdict: "fail",
        result: "no docker",
        error: "the host has no docker command",
      };
    }
    return {
      verdict: "wait",
      result: `docker inspect failed (exit ${output.code ?? "none"})`,
    };
  }
  let parsed: { State?: Record<string, unknown>; RestartCount?: unknown };
  try {
    parsed = JSON.parse(output.stdout.trim());
  } catch {
    return { verdict: "wait", result: "unreadable answer" };
  }
  const st = parsed.State ?? {};
  const status = word(st.Status);
  const exit = int(st.ExitCode);
  const restarts = int(parsed.RestartCount);
  const health =
    st.Health && typeof st.Health === "object"
      ? word((st.Health as Record<string, unknown>).Status)
      : null;
  const ended = status === "exited" || status === "dead";
  const result = ended
    ? `${status} (${exit ?? "?"})`
    : status === "restarting"
      ? `restarting (restart ${restarts ?? "?"})`
      : status === "running" && health
        ? health
        : status;
  const first = memory.restarts;
  if (memory.restarts === null) memory.restarts = restarts;
  switch (state) {
    case "gone":
      return { verdict: "wait", result };
    case "exited":
      return { verdict: ended ? "pass" : "wait", result };
    case "running":
    case "healthy": {
      if (ended) {
        return {
          verdict: "fail",
          result,
          error: `the container ${status === "dead" ? "is dead" : `exited with code ${exit ?? "?"}`} while the item waited for it to be ${state}`,
        };
      }
      if (first !== null && restarts !== null && restarts > first) {
        return {
          verdict: "fail",
          result,
          error: `the container restarted while the item waited for it to be ${state} (restart count ${first} → ${restarts})`,
        };
      }
      if (st.Restarting === true || status !== "running") {
        return { verdict: "wait", result };
      }
      if (state === "running") return { verdict: "pass", result };
      if (health === null) {
        return {
          verdict: "fail",
          result: "running, no health check",
          error:
            'the container has no health check, so it never reads healthy: wait for state "running" instead',
        };
      }
      return { verdict: health === "healthy" ? "pass" : "wait", result };
    }
  }
}

// --- unit -------------------------------------------------------------------

/** `systemctl show`'s key=value lines as an object. */
export function parseUnitShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

/** "@1795471893" (--timestamp=unix) as seconds, or null. */
function unixTime(value: string | undefined): number | null {
  const match = /^@(\d+)$/.exec(value ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * One `systemctl show --timestamp=unix -p ...`. `since`: Unix seconds the
 * step started; an end before it is an earlier run of the unit and does
 * not count. A unit that is not loaded fails at once: the name is wrong, or
 * it was a transient unit that ended and systemd removed (a job item keeps
 * its unit until it read the end).
 */
export function readUnit(
  output: CommandOutput,
  state: UnitItemSpec["state"],
  since: number,
): Reading {
  if (output.code !== 0) {
    if (
      /unrecognized option|unknown option|invalid option/i.test(output.stderr)
    ) {
      return {
        verdict: "fail",
        result: "systemctl too old",
        error:
          "systemctl show refused --timestamp=unix: the host's systemd is older than version 248",
      };
    }
    return {
      verdict: "wait",
      result: `systemctl failed (exit ${output.code ?? "none"})`,
    };
  }
  const props = parseUnitShow(output.stdout);
  if (props.LoadState === "not-found" || props.LoadState === undefined) {
    return {
      verdict: "fail",
      result: "not found",
      error:
        "the unit is not loaded: its name is wrong, or it ended and systemd removed it (a transient unit; use a job item to start and follow one)",
    };
  }
  const active = word(props.ActiveState);
  const sub = word(props.SubState);
  const outcome = word(props.Result);
  const status = int(props.ExecMainStatus);
  const exitedAt = unixTime(props.ExecMainExitTimestamp);
  const fresh = exitedAt !== null && exitedAt >= since;
  const failedWords = `failed (${outcome}${status ? `, status ${status}` : ""})`;
  const result = active === "failed" ? failedWords : `${active} (${sub})`;
  const failed =
    active === "failed" || (outcome !== "success" && sub === "dead");
  if (failed && fresh) {
    return {
      verdict: "fail",
      result: failedWords,
      error: `the unit failed: Result=${outcome}${status !== null ? `, exit status ${status}` : ""}`,
    };
  }
  if (state === "active") {
    return { verdict: active === "active" ? "pass" : "wait", result };
  }
  // finished: it ran to its end (ExecMainCode set) since the step started,
  // with success; RemainAfterExit units stay active (exited).
  const ended =
    (active === "inactive" && sub === "dead") ||
    (active === "active" && sub === "exited");
  if (ended && outcome === "success" && props.ExecMainCode !== "0" && fresh) {
    return { verdict: "pass", result: `finished (${outcome})` };
  }
  return {
    verdict: "wait",
    result:
      ended && !fresh ? `${result}, not run since the step started` : result,
  };
}

// --- logs -------------------------------------------------------------------

/** One journal entry's MESSAGE: text, bytes (a list of numbers), or none. */
function message(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((each) => Number.isInteger(each))) {
    return Buffer.from(value as number[]).toString("utf8");
  }
  return null;
}

/**
 * `journalctl -o json --output-fields=MESSAGE`: one JSON object a line.
 * Returns the messages, and the cursor of the last entry to read after.
 */
export function readJournal(stdout: string): {
  lines: string[];
  cursor: string | null;
} {
  const lines: string[] = [];
  let cursor: string | null = null;
  for (const raw of stdout.split("\n")) {
    if (!raw.trim().startsWith("{")) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof entry.__CURSOR === "string") cursor = entry.__CURSOR;
    const text = message(entry.MESSAGE);
    if (text !== null) lines.push(...text.split("\n"));
  }
  return { lines, cursor };
}

const DOCKER_TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/;

/**
 * `docker logs --timestamps`: each line starts with its RFC 3339 time.
 * Lines at or before `after` (the last one read) are dropped, so a check
 * reads each line once. Returns the lines without their times, and the
 * last time, for the next --since.
 */
export function readDockerLogs(
  output: CommandOutput,
  after: string | null,
): { lines: string[]; last: string | null } {
  const lines: string[] = [];
  let last = after;
  const rows = [
    ...output.stdout.split("\n"),
    ...output.stderr.split("\n"),
  ].filter((row) => row !== "");
  const timed: Array<[string, string]> = [];
  for (const row of rows) {
    const match = DOCKER_TIME.exec(row);
    if (match) timed.push([match[1], match[2]]);
  }
  // stdout and stderr come apart: put them in time order again.
  timed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [time, text] of timed) {
    if (after !== null && time <= after) continue;
    lines.push(text);
    if (last === null || time > last) last = time;
  }
  return { lines, last };
}

/**
 * How long the patterns of one check may take on all its new lines. They
 * run in a separate context with this limit, as captures and step checks
 * do (BUG-022 H1): a pattern that backtracks without end on a line stops
 * there, and Termix goes on.
 */
export const LOG_MATCH_TIME_LIMIT_MS = 250;

/** The loop below, as it runs in the separate context. */
const MATCH_LINES = `(() => {
  const p = new RegExp(pattern, flags);
  const f = fail === null ? null : new RegExp(fail, failFlags);
  for (let i = 0; i < lines.length; i++) {
    if (f !== null && f.test(lines[i])) return "fail";
    if (p.test(lines[i])) return "pass";
  }
  return null;
})()`;

/**
 * Tests the new lines in order: the first that matches failPattern fails
 * the item, the first that matches pattern passes it. Each line is cut to
 * 4096 characters first. The patterns run in a separate context with a
 * time limit: when they do not finish in time, the item fails.
 */
export function matchLog(
  lines: string[],
  pattern: RegExp,
  failPattern: RegExp | null,
  seen: number,
  timeLimitMs = LOG_MATCH_TIME_LIMIT_MS,
): Reading {
  const sandbox = vm.createContext({
    lines: lines.map((line) => line.slice(0, EVENT_LIMITS.logLine)),
    pattern: pattern.source,
    flags: pattern.flags.replace(/[gy]/g, ""),
    fail: failPattern?.source ?? null,
    failFlags: failPattern?.flags.replace(/[gy]/g, "") ?? "",
  });
  let found: "pass" | "fail" | null;
  try {
    found = vm.runInContext(MATCH_LINES, sandbox, {
      timeout: timeLimitMs,
    }) as "pass" | "fail" | null;
  } catch {
    return {
      verdict: "fail",
      result: "pattern too slow",
      error: `the log patterns took longer than ${timeLimitMs} ms on the new lines and were stopped: write pattern and failPattern so they cannot backtrack for long (no repeated group that holds a repeat or alternatives that match the same text)`,
    };
  }
  if (found === "fail") {
    return {
      verdict: "fail",
      result: "failPattern matched",
      error: `a new log line matched failPattern /${failPattern!.source}/`,
    };
  }
  if (found === "pass") return { verdict: "pass", result: "matched" };
  const total = seen + lines.length;
  return {
    verdict: "wait",
    result: `no match yet (${total} new line${total === 1 ? "" : "s"})`,
  };
}

/** A log command that did not run to an end: why, or null when it did. */
export function readLogError(
  output: CommandOutput,
  source: "container" | "unit",
): Reading | null {
  if (output.code === 0) return null;
  const sudo = sudoRefused(output);
  if (sudo) return sudo;
  if (source === "container") {
    if (/No such container/i.test(output.stderr)) {
      return { verdict: "wait", result: "not found" };
    }
    if (/permission denied/i.test(output.stderr)) {
      return {
        verdict: "fail",
        result: "docker refused",
        error:
          "the SSH user may not use Docker (permission denied on the Docker socket): add it to the docker group",
      };
    }
  }
  return {
    verdict: "wait",
    result: `${source === "container" ? "docker logs" : "journalctl"} failed (exit ${output.code ?? "none"})`,
  };
}

// --- file -------------------------------------------------------------------

/** What a path is, from its mode bits (as SFTP and stat give them). */
function kind(mode: number): "file" | "directory" | "other" {
  const type = mode & 0o170000;
  return type === 0o100000 ? "file" : type === 0o040000 ? "directory" : "other";
}

/** The verdict of a path that is there, with its kind and size. */
function present(
  state: FileItemSpec["state"],
  what: "file" | "directory" | "other",
  size: number,
): Reading {
  const result =
    what === "directory"
      ? "directory exists"
      : `${what === "file" ? "file" : "path"} exists, ${size} byte${size === 1 ? "" : "s"}`;
  if (state === "gone") return { verdict: "wait", result };
  if (state === "exists") return { verdict: "pass", result };
  if (what === "directory") {
    return {
      verdict: "fail",
      result,
      error: 'the path is a directory: state "nonEmpty" is for a file',
    };
  }
  return { verdict: size > 0 ? "pass" : "wait", result };
}

/** An SFTP error: code 2 is "no such file", code 3 "permission denied". */
export interface SftpFailure {
  code?: unknown;
  message?: string;
}

/** An SFTP stat: its attributes, or its error. */
export function readSftpStat(
  answer: { mode: number; size: number } | { error: SftpFailure },
  state: FileItemSpec["state"],
): Reading {
  if ("error" in answer) {
    if (answer.error.code === 2) {
      return {
        verdict: state === "gone" ? "pass" : "wait",
        result: "not there",
      };
    }
    if (answer.error.code === 3) {
      return {
        verdict: "fail",
        result: "permission denied",
        error:
          "the SSH user may not read this path: on a Linux host, set sudo: true to read it with sudo stat",
      };
    }
    return { verdict: "wait", result: "SFTP error" };
  }
  return present(state, kind(answer.mode), answer.size);
}

/** `sudo -n stat -L -c '%s %F' -- PATH`: "6 regular file". */
export function readSudoStat(
  output: CommandOutput,
  state: FileItemSpec["state"],
): Reading {
  const sudo = sudoRefused(output);
  if (sudo) return sudo;
  if (output.code !== 0) {
    if (/No such file or directory/.test(output.stderr)) {
      return {
        verdict: state === "gone" ? "pass" : "wait",
        result: "not there",
      };
    }
    if (/Permission denied/.test(output.stderr)) {
      return {
        verdict: "fail",
        result: "permission denied",
        error: "stat was refused even with sudo",
      };
    }
    return {
      verdict: "wait",
      result: `stat failed (exit ${output.code ?? "none"})`,
    };
  }
  const match = /^(\d+) (.+)$/.exec(output.stdout.trim());
  if (!match) return { verdict: "wait", result: "unreadable answer" };
  const type = match[2];
  const what = /regular/.test(type)
    ? "file"
    : type === "directory"
      ? "directory"
      : "other";
  return present(state, what, Number(match[1]));
}

// --- port -------------------------------------------------------------------

/** ssh2's error when the server refused a channel: reason 1 to 4. */
export interface ChannelFailure {
  reason?: unknown;
  message?: string;
}

/** The words of a refused forward: the key does not allow it. */
export const FORWARD_REFUSED =
  'the host\'s SSH server refused the TCP channel (administratively prohibited): the SSH key Termix uses on this host does not allow port forwarding. It needs permitopen="127.0.0.1:*" (and permitlisten="127.0.0.1:1") instead of no-port-forwarding';

/**
 * A forwardOut to the host's loopback: it opened (null), or the server
 * refused it. Reason 2 (connect failed) is a closed port; reason 1
 * (administratively prohibited) is the key's no-port-forwarding, which
 * fails the item at once and is never read as "closed".
 */
export function readForward(
  failure: ChannelFailure | null,
  state: PortItemSpec["state"],
): Reading {
  if (failure === null) {
    return { verdict: state === "open" ? "pass" : "wait", result: "port open" };
  }
  if (failure.reason === 1) {
    return {
      verdict: "fail",
      result: "forwarding refused",
      error: FORWARD_REFUSED,
    };
  }
  if (failure.reason === 2) {
    return {
      verdict: state === "closed" ? "pass" : "wait",
      result: "port closed",
    };
  }
  return { verdict: "wait", result: "no answer" };
}

// --- http -------------------------------------------------------------------

/** Node's codes for a certificate that failed the check. */
const CERT_CODES =
  /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_)/;

/** An HTTP check's answer, or what stopped it. */
export type HttpAnswer =
  | { status: number; body: string }
  | { error: { code?: unknown; reason?: unknown; message?: string } };

/**
 * The status, and `contains` in the body. A certificate that fails the
 * check waits, with words that say so (a proxy may show its default
 * certificate while it starts); the item fails with them when time runs
 * out. A refused forward fails at once, as for a port.
 */
export function readHttp(
  answer: HttpAnswer,
  item: Pick<HttpItemSpec, "status" | "contains">,
): Reading {
  if ("error" in answer) {
    const { code, reason } = answer.error;
    if (reason === 1) {
      return {
        verdict: "fail",
        result: "forwarding refused",
        error: FORWARD_REFUSED,
      };
    }
    if (reason === 2 || code === "ECONNREFUSED") {
      return { verdict: "wait", result: "port closed" };
    }
    if (typeof code === "string" && CERT_CODES.test(code)) {
      return {
        verdict: "wait",
        result:
          code === "ERR_TLS_CERT_ALTNAME_INVALID"
            ? "certificate name mismatch"
            : code === "CERT_HAS_EXPIRED"
              ? "certificate expired"
              : "certificate not trusted",
      };
    }
    if (code === "ETIMEDOUT" || code === "timeout") {
      return { verdict: "wait", result: "no answer in time" };
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { verdict: "wait", result: "name not found" };
    }
    return { verdict: "wait", result: "no answer" };
  }
  if (answer.status !== item.status) {
    return { verdict: "wait", result: `HTTP ${answer.status}` };
  }
  if (item.contains !== null && !answer.body.includes(item.contains)) {
    return { verdict: "wait", result: `HTTP ${answer.status}, text not found` };
  }
  return { verdict: "pass", result: `HTTP ${answer.status}` };
}

// --- platform ---------------------------------------------------------------

/**
 * The host's platform from its SSH server's version string (ssh2 keeps it
 * as the client's _remoteVer, read at the handshake: no command runs).
 * Windows OpenSSH says "OpenSSH_for_Windows_9.5", Bitvise "WinSSHD". Null
 * when the client does not tell.
 */
export function readPlatform(remoteVer: unknown): "windows" | "other" | null {
  if (typeof remoteVer !== "string" || remoteVer === "") return null;
  return /windows|winsshd/i.test(remoteVer) ? "windows" : "other";
}
