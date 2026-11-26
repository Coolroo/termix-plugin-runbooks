/**
 * One check of a wait event (1.4.10, phase 3), on a connection the runner
 * opened as the person who pressed Run: a TCP channel from the host to its
 * own loopback (forwardOut), an HTTP request over that channel or from
 * Termix, an SFTP stat, or one fixed read-only command. The readers
 * (readers.ts) decide; this file only does the I/O, within the check's time
 * limit, and ends at once on Stop.
 *
 * Nothing here runs text an author wrote, except a job's command, which
 * goes into systemd-run quoted, as the person approved it.
 */

import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import {
  EVENT_LIMITS,
  channelHost,
  containerCommand,
  dockerLogsCommand,
  isLoopbackUrl,
  jobCleanupCommand,
  jobStartCommand,
  jobUnit,
  journalCommand,
  linuxOnly,
  sudoStatCommand,
  unitCommand,
  type EventItemSpec,
  type HttpItemSpec,
  type JobItemSpec,
  type LogItemSpec,
} from "../../shared/events.js";
import { streamExec, type ExecClient } from "../running/stream-exec.js";
import { addressKind } from "./addresses.js";
import { MAX_OUTPUT_BYTES } from "../running/runner.js";
import {
  matchLog,
  readContainer,
  readDockerLogs,
  readForward,
  readHttp,
  readJournal,
  readLogError,
  readPlatform,
  readSftpStat,
  readSudoStat,
  readUnit,
  type ChannelFailure,
  type CommandOutput,
  type HttpAnswer,
  type Reading,
  type SftpFailure,
} from "./readers.js";

/** The SFTP session ssh2 hands over: stat and end are all a check uses. */
export interface SftpSession {
  stat: (
    path: string,
    callback: (
      error: SftpFailure | undefined,
      stats: { mode: number; size: number },
    ) => void,
  ) => unknown;
  end: () => unknown;
}

/** ssh2's client as an event uses it. */
export interface ProbeClient extends ExecClient {
  forwardOut?: (
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (
      error: (Error & ChannelFailure) | undefined,
      stream: Duplex,
    ) => void,
  ) => unknown;
  sftp?: (
    callback: (error: Error | undefined, sftp: SftpSession) => void,
  ) => unknown;
  /** The SSH server's version string, from the handshake (ssh2). */
  _remoteVer?: unknown;
}

/** What one item's checks keep from one check to the next. */
export interface EventMemory {
  /** container: the restart count at the first check that found it. */
  restarts: number | null;
  /** log of a unit, job: the journal cursor of the last line read. */
  cursor: string | null;
  /** log of a container: the time of the last line read. */
  lastLogTime: string | null;
  /** log: how many new lines were read so far. */
  lines: number;
  /** job: its unit started (Unix seconds), or null before. */
  jobStarted: number | null;
  /**
   * job: systemd-run was sent, and did not answer that it refused. A Stop
   * or a time limit during systemd-run leaves jobStarted null while the
   * unit may be running: the unit is stopped on this flag (BUG-022 L5).
   */
  jobStartSent: boolean;
  /** job: the journal so far, capped. */
  journal: string;
}

export function newMemory(): EventMemory {
  return {
    restarts: null,
    cursor: null,
    lastLogTime: null,
    lines: 0,
    jobStarted: null,
    jobStartSent: false,
    journal: "",
  };
}

export interface ProbeInput {
  client: ProbeClient;
  /** The item with its values filled in. */
  item: EventItemSpec;
  /** The step's workdir (a job starts in it). */
  workdir: string | null;
  /** Unix seconds the step started: log lines and unit ends after it. */
  since: number;
  runId: number;
  position: number;
  timeoutMs: number;
  signal: AbortSignal;
  memory: EventMemory;
  /** The CAs an http check trusts (trust.ts). */
  cas: () => Promise<string[]>;
  /** Termix's outbound HTTP (ctx.fetch), for an http item off the host. */
  fetch: (url: string, init: Record<string, unknown>) => Promise<Response>;
  /** Resolves a name, for the check on an address Termix itself reaches. */
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
  /** A job's journal, as it comes, for the page. */
  onOutput?: (text: string) => void;
}

/** A check's verdict with what it read, as the attempt keeps it. */
export interface ProbeOutcome extends Reading {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

function outcome(
  reading: Reading,
  parts: Partial<Omit<ProbeOutcome, keyof Reading>> = {},
): ProbeOutcome {
  return {
    ...reading,
    stdout: parts.stdout ?? "",
    stderr: parts.stderr ?? "",
    exitCode: parts.exitCode ?? null,
    truncated: parts.truncated ?? false,
    timedOut: parts.timedOut ?? false,
  };
}

/** Thrown when Stop ended the check; the runner reads the stop itself. */
export class Stopped extends Error {
  constructor() {
    super("stopped");
  }
}

/** Rejects at the check's time limit or on Stop; `cleanup` runs either way. */
function bounded<T>(
  input: ProbeInput,
  work: (settle: { cleanup: (fn: () => void) => void }) => Promise<T>,
): Promise<T> {
  const cleanups: Array<() => void> = [];
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onStop);
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // The channel is gone already.
        }
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(
        Object.assign(new Error("no answer in time"), { code: "timeout" }),
      );
    }, input.timeoutMs);
    const onStop = () => {
      done();
      reject(new Stopped());
    };
    if (input.signal.aborted) return onStop();
    input.signal.addEventListener("abort", onStop, { once: true });
    work({ cleanup: (fn) => cleanups.push(fn) }).then(
      (value) => {
        done();
        resolve(value);
      },
      (error) => {
        done();
        reject(error);
      },
    );
  });
}

/** One fixed command, stdin closed, within the check's time limit. */
async function exec(
  input: ProbeInput,
  command: string,
): Promise<CommandOutput & { truncated: boolean; timedOut: boolean }> {
  const handle = streamExec(input.client, command, {
    timeoutMs: input.timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    stdin: Buffer.alloc(0),
  });
  const stop = () => handle.stop();
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    const result = await handle.result;
    if (result.stopped || input.signal.aborted) throw new Stopped();
    return result;
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
}

/** A command's output as the attempt keeps it, with the reading. */
function fromCommand(
  reading: Reading,
  output: CommandOutput & { truncated: boolean; timedOut: boolean },
): ProbeOutcome {
  return outcome(
    output.timedOut ? { verdict: "wait", result: "timed out" } : reading,
    {
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.code,
      truncated: output.truncated,
      timedOut: output.timedOut,
    },
  );
}

/** A TCP channel from the host to its loopback, through SSH. */
function openChannel(
  input: ProbeInput,
  host: string,
  port: number,
): Promise<Duplex> {
  const forwardOut = input.client.forwardOut;
  if (!forwardOut) {
    return Promise.reject(
      new Error("this connection cannot open TCP channels"),
    );
  }
  return bounded(
    input,
    () =>
      new Promise<Duplex>((resolve, reject) => {
        forwardOut.call(
          input.client,
          "127.0.0.1",
          0,
          channelHost(host),
          port,
          (error, stream) => {
            if (error) return reject(error);
            resolve(stream);
          },
        );
      }),
  );
}

function closeStream(stream: Duplex): void {
  const channel = stream as Duplex & { close?: () => void };
  if (typeof channel.close === "function") channel.close();
  else stream.destroy();
}

async function checkPort(
  input: ProbeInput,
  item: Extract<EventItemSpec, { type: "port" }>,
): Promise<ProbeOutcome> {
  try {
    const stream = await openChannel(input, item.host, item.port);
    closeStream(stream);
    return outcome(readForward(null, item.state));
  } catch (error) {
    if (error instanceof Stopped) throw error;
    const failure = error as ChannelFailure & { code?: unknown };
    if (failure.code === "timeout") {
      return outcome(
        { verdict: "wait", result: "no answer in time" },
        {
          timedOut: true,
        },
      );
    }
    return outcome(readForward(failure, item.state), {
      stderr: `${failure.message ?? String(error)}\n`,
    });
  }
}

/** The name the certificate must hold: servername, or the URL's host. */
function certName(url: URL, item: HttpItemSpec): string {
  return item.servername ?? url.hostname.replace(/^\[|\]$/g, "");
}

/** Reads the answer's status and up to 64 KB of its body. */
function readAnswer(
  response: http.IncomingMessage,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = () =>
      resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    response.on("data", (chunk: Buffer) => {
      if (size >= EVENT_LIMITS.body) return;
      chunks.push(chunk.subarray(0, EVENT_LIMITS.body - size));
      size += chunk.length;
      if (size >= EVENT_LIMITS.body) {
        finish();
        response.destroy();
      }
    });
    response.on("end", finish);
    response.on("error", reject);
  });
}

/**
 * GET over a channel to the host's own loopback. https is checked against
 * the URL's host name or `servername`, with the public roots and the extra
 * CAs; never skipped. Plain http only reaches loopback (parse refuses it
 * elsewhere), and the bytes travel inside the SSH connection.
 */
async function httpOverSsh(
  input: ProbeInput,
  item: HttpItemSpec,
  url: URL,
): Promise<{ status: number; body: string }> {
  const secure = url.protocol === "https:";
  const port = Number(url.port) || (secure ? 443 : 80);
  const stream = await openChannel(input, url.hostname, port);
  const cas = secure ? await input.cas() : [];
  return bounded(input, ({ cleanup }) => {
    cleanup(() => stream.destroy());
    return new Promise((resolve, reject) => {
      const request = (socket: Duplex) => {
        const req = http.request({
          createConnection: () => socket as net.Socket,
          method: "GET",
          path: `${url.pathname}${url.search}`,
          headers: {
            Host: url.host,
            "User-Agent": "termix-runbooks",
            Accept: "*/*",
            Connection: "close",
          },
        });
        req.on("response", (response) =>
          readAnswer(response).then(resolve, reject),
        );
        req.on("error", reject);
        req.end();
      };
      if (!secure) return request(stream);
      const name = certName(url, item);
      const socket = tls.connect({
        socket: stream,
        servername: net.isIP(name) ? undefined : name,
        ca: cas,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, cert) =>
          tls.checkServerIdentity(name, cert),
      });
      cleanup(() => socket.destroy());
      socket.once("secureConnect", () => request(socket));
      socket.once("error", reject);
    });
  });
}

/**
 * GET from Termix itself, through core's ctx.fetch: redirects are not
 * followed (a 301 is a status like any other), and the name must not lead
 * to Termix's own loopback, a link-local or unspecified address, or one of
 * Termix's own addresses, in any spelling (addresses.ts). The same CAs.
 *
 * Only a private address gets core's allowPrivateHosts; for a public one,
 * core's own check refuses any private answer when it connects. An address
 * in the URL is the one core connects to. A name with a private address
 * is resolved again by core, and ctx.fetch has no way to pin the address
 * read here: docs/security.md says what that leaves (BUG-022 M4).
 */
async function httpFromTermix(
  input: ProbeInput,
  url: URL,
): Promise<{ status: number; body: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lookup =
    input.lookup ??
    ((name: string) => dns.lookup(name, { all: true, verbatim: true }));
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host);
  const kinds = addresses.map((each) => addressKind(each.address));
  if (kinds.length === 0 || kinds.includes("refused")) {
    throw Object.assign(
      new Error(
        `${host} leads to a loopback, link-local or unspecified address, or to Termix's own address, which Termix does not reach for a runbook`,
      ),
      { code: "local-address" },
    );
  }
  const privateHost = kinds.includes("private");
  const cas = await input.cas();
  const controller = new AbortController();
  return bounded(input, async ({ cleanup }) => {
    cleanup(() => controller.abort());
    const response = await input.fetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": "termix-runbooks", Accept: "*/*" },
      redirect: "manual",
      timeoutMs: input.timeoutMs,
      ...(privateHost ? { allowPrivateHosts: [host] } : {}),
      signal: controller.signal,
      tls: { ca: cas.join("\n") },
    });
    let body = "";
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (body.length < EVENT_LIMITS.body) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => {});
    }
    return { status: response.status, body: body.slice(0, EVENT_LIMITS.body) };
  });
}

/** Node puts a TLS failure's code on the error, or on its cause. */
function errorCode(error: unknown): unknown {
  const found = error as { code?: unknown; cause?: { code?: unknown } };
  return found?.code ?? found?.cause?.code;
}

async function checkHttp(
  input: ProbeInput,
  item: HttpItemSpec,
): Promise<ProbeOutcome> {
  const url = new URL(item.url);
  let answer: HttpAnswer;
  let stderr = "";
  try {
    answer = isLoopbackUrl(item.url)
      ? { ...(await httpOverSsh(input, item, url)) }
      : { ...(await httpFromTermix(input, url)) };
  } catch (error) {
    if (error instanceof Stopped) throw error;
    const failure = error as ChannelFailure & { message?: string };
    stderr = `${failure.message ?? String(error)}\n`;
    if (errorCode(error) === "local-address") {
      return outcome(
        {
          verdict: "fail",
          result: "address refused",
          error: failure.message ?? "address refused",
        },
        { stderr },
      );
    }
    answer = {
      error: {
        code: errorCode(error),
        reason: failure.reason,
        message: failure.message,
      },
    };
  }
  const reading = readHttp(answer, item);
  const stdout =
    "status" in answer
      ? `HTTP ${answer.status}\n${answer.body.slice(0, EVENT_LIMITS.bodyShown)}`
      : "";
  return outcome(reading, {
    stdout,
    stderr,
    timedOut: reading.result === "no answer in time",
  });
}

async function checkFile(
  input: ProbeInput,
  item: Extract<EventItemSpec, { type: "file" }>,
): Promise<ProbeOutcome> {
  if (item.sudo) {
    const output = await exec(input, sudoStatCommand(item.path));
    return fromCommand(readSudoStat(output, item.state), output);
  }
  const sftp = input.client.sftp;
  if (!sftp) throw new Error("this connection cannot open SFTP");
  try {
    const answer = await bounded(
      input,
      ({ cleanup }) =>
        new Promise<{ mode: number; size: number } | { error: SftpFailure }>(
          (resolve, reject) => {
            sftp.call(input.client, (error, session) => {
              if (error) return reject(error);
              cleanup(() => session.end());
              session.stat(item.path, (statError, stats) =>
                resolve(
                  statError
                    ? { error: statError }
                    : { mode: stats.mode, size: stats.size },
                ),
              );
            });
          },
        ),
    );
    const reading = readSftpStat(answer, item.state);
    return outcome(reading, {
      stdout:
        "error" in answer
          ? ""
          : `mode ${(answer.mode & 0o177777).toString(8)}, ${answer.size} bytes\n`,
      stderr:
        "error" in answer ? `${answer.error.message ?? "SFTP error"}\n` : "",
    });
  } catch (error) {
    if (error instanceof Stopped) throw error;
    if ((error as { code?: unknown }).code === "timeout") {
      return outcome(
        { verdict: "wait", result: "no answer in time" },
        {
          timedOut: true,
        },
      );
    }
    throw error;
  }
}

function compile(pattern: string): RegExp {
  return new RegExp(pattern);
}

async function checkLog(
  input: ProbeInput,
  item: LogItemSpec,
): Promise<ProbeOutcome> {
  const { memory } = input;
  const fail = item.failPattern ? compile(item.failPattern) : null;
  const pattern = compile(item.pattern);
  if (item.container) {
    const output = await exec(
      input,
      dockerLogsCommand(
        item.container,
        memory.lastLogTime ?? String(input.since),
      ),
    );
    const error = readLogError(output, "container");
    if (error) return fromCommand(error, output);
    const read = readDockerLogs(output, memory.lastLogTime);
    const reading = matchLog(read.lines, pattern, fail, memory.lines);
    memory.lines += read.lines.length;
    memory.lastLogTime = read.last;
    return fromCommand(reading, output);
  }
  const output = await exec(
    input,
    journalCommand(
      item.unit!,
      memory.cursor
        ? { cursor: memory.cursor }
        : { since: String(input.since) },
      item.sudo,
    ),
  );
  const error = readLogError(output, "unit");
  if (error) return fromCommand(error, output);
  const read = readJournal(output.stdout);
  const reading = matchLog(read.lines, pattern, fail, memory.lines);
  memory.lines += read.lines.length;
  memory.cursor = read.cursor ?? memory.cursor;
  return fromCommand(reading, {
    ...output,
    // The messages, not the JSON around them.
    stdout: read.lines.length ? `${read.lines.join("\n")}\n` : "",
  });
}

/**
 * A job: the first check starts its unit; every check reads the unit's
 * state and the journal lines since the last check. The journal comes into
 * the item as it comes. When the unit ended (or failed), its unit is
 * stopped and unloaded.
 */
async function checkJob(
  input: ProbeInput,
  item: JobItemSpec,
): Promise<ProbeOutcome> {
  const { memory } = input;
  const unit = jobUnit(item, input.runId, input.position);
  let started = "";
  if (memory.jobStarted === null) {
    // Before the call: a Stop during it throws, and the unit may run.
    memory.jobStartSent = true;
    const start = await exec(
      input,
      jobStartCommand(unit, item.command, input.workdir),
    );
    if (start.timedOut) {
      // systemd-run may have started it: stop it, as Stop would.
      await exec(input, jobCleanupCommand(unit)).catch(() => {});
      memory.jobStartSent = false;
      return outcome(
        {
          verdict: "fail",
          result: "not started in time",
          error: `systemd-run did not answer in time; the unit ${unit} was stopped in case it started`,
        },
        {
          stdout: start.stdout,
          stderr: start.stderr,
          exitCode: start.code,
          truncated: start.truncated,
          timedOut: true,
        },
      );
    }
    if (start.code !== 0) {
      // systemd-run refused it: no unit of this item runs (a loaded unit
      // of that name is someone else's, and is not stopped).
      memory.jobStartSent = false;
      const exists = /already loaded|already exists/i.test(start.stderr);
      const sudo = /^sudo: /m.test(start.stderr);
      return fromCommand(
        {
          verdict: "fail",
          result: sudo ? "sudo refused" : "not started",
          error: exists
            ? `a unit named ${unit} is loaded already: stop it, or give the job another unit name`
            : sudo
              ? "sudo -n refused: the SSH user may not run systemd-run with sudo without a password"
              : `systemd-run could not start the job (exit ${start.code ?? "none"})`,
        },
        start,
      );
    }
    memory.jobStarted = Math.floor(Date.now() / 1000);
    started = start.stdout + start.stderr;
  }
  // The state first, then the journal: when it ended, every line it wrote
  // is in the journal by then.
  const state = await exec(input, unitCommand(unit));
  const journal = await exec(
    input,
    journalCommand(
      unit,
      memory.cursor
        ? { cursor: memory.cursor }
        : { since: String(memory.jobStarted - 5) },
      true,
    ),
  );
  const read = readJournal(journal.code === 0 ? journal.stdout : "");
  memory.cursor = read.cursor ?? memory.cursor;
  const text = read.lines.length ? `${read.lines.join("\n")}\n` : "";
  if (text) {
    input.onOutput?.(text);
    memory.journal = capText(memory.journal + text);
  }
  // A unit this item started is new, so any end it shows is this run's.
  const reading = readUnit(state, "finished", 0);
  const ended = reading.verdict !== "wait";
  if (ended) await exec(input, jobCleanupCommand(unit)).catch(() => {});
  return fromCommand(
    reading.result === "not found"
      ? {
          verdict: "fail",
          result: "unit gone",
          error: `the job's unit ${unit} is gone: something stopped and removed it`,
        }
      : reading,
    {
      ...state,
      stdout: started + text,
      stderr: state.stderr + journal.stderr,
    },
  );
}

/** Text cut to the output limit, as a run keeps it. */
function capText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= MAX_OUTPUT_BYTES
    ? text
    : bytes.subarray(bytes.length - MAX_OUTPUT_BYTES).toString("utf8");
}

/** Stops and unloads a job's unit: Stop, or out of time. */
export async function stopJob(
  client: ExecClient,
  item: JobItemSpec,
  runId: number,
  position: number,
): Promise<void> {
  const handle = streamExec(
    client,
    jobCleanupCommand(jobUnit(item, runId, position)),
    { timeoutMs: 30_000, maxOutputBytes: 4096, stdin: Buffer.alloc(0) },
  );
  await handle.result;
}

/** The words of a Linux-only event on a Windows host. */
export function windowsText(item: EventItemSpec, remoteVer: string): string {
  return `this host's SSH server is a Windows one (${remoteVer.slice(0, 60)}), and a ${item.type}${item.type === "file" ? " item with sudo" : " item"} needs a Linux host (Docker, systemd or sudo)`;
}

/**
 * One check. Never resolves for a Stop: it throws Stopped, and the runner
 * reads the stop. An error the readers do not know (no connection, a
 * channel that broke) is thrown too: the runner keeps it as "connect".
 */
export async function probe(input: ProbeInput): Promise<ProbeOutcome> {
  const { item, client } = input;
  if (linuxOnly(item) && readPlatform(client._remoteVer) === "windows") {
    return outcome({
      verdict: "fail",
      result: "Windows host",
      error: windowsText(item, String(client._remoteVer)),
    });
  }
  switch (item.type) {
    case "port":
      return checkPort(input, item);
    case "http":
      return checkHttp(input, item);
    case "file":
      return checkFile(input, item);
    case "container": {
      const output = await exec(input, containerCommand(item.name));
      return fromCommand(
        readContainer(output, item.state, input.memory),
        output,
      );
    }
    case "unit": {
      const output = await exec(input, unitCommand(item.name));
      return fromCommand(readUnit(output, item.state, input.since), output);
    }
    case "log":
      return checkLog(input, item);
    case "job":
      return checkJob(input, item);
  }
}
