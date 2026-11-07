/**
 * The person side: /plugin-api/runbooks/..., behind core's login.
 *
 * Only a signed-in person runs a step, marks one done or skipped, or writes
 * the notes. A request that came in on a core API key (tmx_...) is refused on
 * those routes: core marks it with req.apiKeyId, so a script holding a key
 * cannot approve its own commands.
 */

import type { NextFunction, Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  InputError,
  LIMITS,
  loadBundle,
  parseStatus,
  personView,
  resolveStep,
  runbookSummary,
  waitState,
  valuesObject,
  type RunbookBundle,
} from "./service.js";
import type { RunRow, StepRow, Store, TokenHost, TokenRow } from "./store.js";
import { now } from "./store.js";
import { newToken } from "./tokens.js";
import { applyCaptures } from "./values.js";
import { isSshHost } from "../shared/hosts.js";
import type { LiveRuns } from "./live.js";
import { streamExec, type ExecClient } from "./stream-exec.js";
import { evaluateChecks, type CheckedRun } from "./checks.js";

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 262_144;
export const MAX_TOKEN_HOSTS = 500;
/** How long Stop waits for the run to be written before it answers. */
export const STOP_WAIT_MS = 5000;
const NO_HOST_KEY =
  "open a Terminal to this host once to store its host key, then run the step again";

type Handler = (req: Request, res: Response) => Promise<void>;

function wrap(fn: (req: Request, res: Response) => Promise<unknown>): Handler {
  return async (req, res) => {
    try {
      const body = await fn(req, res);
      if (!res.headersSent) res.json(body);
    } catch (error) {
      if (error instanceof InputError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      throw error;
    }
  };
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new InputError("not found", 404);
  return id;
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

export function registerPersonRoutes(
  router: Router,
  ctx: PluginContext,
  store: Store,
  live: LiveRuns,
): void {
  const actor = () => ctx.currentActor() as string;

  /** A signed-in person: an acting user is set (core does this after login). */
  const signedIn = (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.currentActor()) {
      res.status(401).json({ error: "sign in to Termix to use Runbooks" });
      return;
    }
    next();
  };
  /** Not a core API key: approving a command takes a person in the UI. */
  const notApiKey = (req: Request, res: Response, next: NextFunction) => {
    if ((req as Request & { apiKeyId?: unknown }).apiKeyId) {
      res.status(403).json({
        error:
          "a Termix API key cannot run, approve or change steps; use the Runbooks tab",
      });
      return;
    }
    next();
  };
  const use = [signedIn, ctx.rbac.require("use") as never];
  const act = [...use, notApiKey];
  const tokensRole = [
    signedIn,
    ctx.rbac.require("manage-tokens") as never,
    notApiKey,
  ];

  /**
   * Steps a run or a send is working on. Claimed before the step and its runs
   * are read, so a second click waits for nothing and cannot pass the repeat
   * guard while the first run is still being written. A Run keeps its claim
   * until the command ends, after the route has answered.
   */
  const inFlight = new Set<number>();

  /** Claims a step and returns the function that lets it go. */
  function claim(stepId: number): () => void {
    if (inFlight.has(stepId)) {
      throw new InputError("this step is already running", 409, {
        code: "running",
      });
    }
    inFlight.add(stepId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight.delete(stepId);
    };
  }

  async function claimed<T>(
    stepId: number,
    fn: (stepId: number) => Promise<T>,
  ): Promise<T> {
    const release = claim(stepId);
    try {
      return await fn(stepId);
    } finally {
      release();
    }
  }

  /** One run as the person view shows it, live output included. */
  async function shownRun(runId: number) {
    const run = await store.getRun(runId);
    return run ? live.show([run])[0] : null;
  }

  async function hostNamer() {
    const names = new Map<number, string>();
    for (const host of await ctx.hosts.list()) {
      names.set(host.id, host.name || host.ip);
    }
    return (hostId: number) => names.get(hostId) ?? null;
  }

  /**
   * The host as the acting person may connect to it, refused unless it takes
   * SSH. Runbooks runs and types commands over SSH only, so a remote desktop
   * host (RDP, VNC, a console) is never a step's host.
   */
  async function sshHostFor(hostId: number, refused: string, why = "") {
    const host = await ctx.ssh.resolveHost(hostId);
    if (!host) throw new InputError(refused, 403);
    if (!isSshHost(host)) {
      throw new InputError(`host ${hostId} is not an SSH host${why}`, 400, {
        code: "not-ssh",
      });
    }
    return host;
  }

  /**
   * The hosts a token may use, as chosen by the person making or editing it:
   * each one must be an SSH host they see and can connect to. Stored as a
   * snapshot, without anything secret.
   */
  async function chooseHosts(input: unknown): Promise<TokenHost[]> {
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.length > MAX_TOKEN_HOSTS ||
      !input.every((id) => Number.isInteger(id) && id > 0)
    ) {
      throw new InputError(
        `hostIds must list 1 to ${MAX_TOKEN_HOSTS} hosts the token may use`,
      );
    }
    const visible = new Map(
      (await ctx.hosts.list()).map((host) => [host.id, host]),
    );
    const chosen: TokenHost[] = [];
    for (const id of [...new Set(input as number[])]) {
      const host = visible.get(id);
      const access = host
        ? await ctx.hosts.checkAccess(id, "connect")
        : { hasAccess: false };
      if (!host || !access.hasAccess) {
        throw new InputError(`you cannot connect to host ${id}`, 403);
      }
      await sshHostFor(id, `you cannot connect to host ${id}`);
      chosen.push({
        id: host.id,
        name: host.name,
        address: host.ip,
        folder: host.folder,
        ssh: true,
      });
    }
    return chosen;
  }

  /**
   * Marks the hosts of tokens made before 1.0.1, which carry no SSH flag,
   * once the person reading the tokens can see them. A remote desktop host
   * found this way is marked false, so agents no longer get it.
   */
  async function flagTokenHosts(tokens: TokenRow[]): Promise<TokenRow[]> {
    const unflagged = tokens.filter(
      (token) =>
        !token.revokedAt &&
        token.hosts.some((host) => typeof host.ssh !== "boolean"),
    );
    if (unflagged.length === 0) return tokens;
    const visible = new Set((await ctx.hosts.list()).map((host) => host.id));
    const known = new Map<number, boolean>();
    let changed = false;
    for (const token of unflagged) {
      let tokenChanged = false;
      const hosts: TokenHost[] = [];
      for (const host of token.hosts) {
        if (typeof host.ssh === "boolean" || !visible.has(host.id)) {
          hosts.push(host);
          continue;
        }
        if (!known.has(host.id)) {
          const full = await ctx.ssh.resolveHost(host.id);
          if (full) known.set(host.id, isSshHost(full));
        }
        const ssh = known.get(host.id);
        if (ssh === undefined) {
          hosts.push(host);
        } else {
          hosts.push({ ...host, ssh });
          tokenChanged = true;
        }
      }
      if (tokenChanged) {
        await store.setTokenHosts(token.id, hosts);
        token.hosts = hosts;
        changed = true;
      }
    }
    if (changed) await store.persist();
    return tokens;
  }

  async function bundleFor(runbookId: number): Promise<RunbookBundle> {
    const bundle = await loadBundle(store, runbookId, live);
    if (!bundle) throw new InputError("runbook not found", 404);
    return bundle;
  }

  async function stepContext(stepId: number) {
    const step = await store.getStep(stepId);
    if (!step) throw new InputError("step not found", 404);
    const bundle = await bundleFor(step.runbookId);
    return { step: bundle.steps.find((s) => s.id === step.id)!, bundle };
  }

  function runSummary(run: RunRow, sameStep: boolean) {
    return {
      runId: run.id,
      stepId: run.stepId,
      runbookId: run.runbookId,
      sameStep,
      mode: run.mode,
      status: run.status,
      userId: run.userId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      exitCode: run.exitCode,
    };
  }

  /**
   * The checks every run and every send to a terminal goes through: the
   * person saw this revision and this exact command, earlier steps are done,
   * and a repeat was confirmed.
   */
  async function checkRunnable(
    step: StepRow,
    bundle: RunbookBundle,
    input: Record<string, unknown>,
  ) {
    if (bundle.runbook.status !== "open") {
      throw new InputError(`this runbook is ${bundle.runbook.status}`, 409);
    }
    if (step.hostId === null || step.command === null) {
      throw new InputError("this step has no command to run", 400);
    }
    const resolved = resolveStep(step, valuesObject(bundle.values));
    if (input.revision !== step.revision) {
      throw new InputError("the step changed; reload", 409, { code: "stale" });
    }
    if (resolved.missing.length > 0) {
      throw new InputError(
        `values missing: ${resolved.missing.join(", ")}`,
        409,
        { code: "missing-values", missing: resolved.missing },
      );
    }
    if (input.commandHash !== resolved.hash) {
      throw new InputError("the step changed; reload", 409, { code: "stale" });
    }
    // Before the questions about order and repeats: no answer to them makes
    // a remote desktop host run a shell command.
    const host = await sshHostFor(
      step.hostId,
      "you cannot connect to this host",
      "; Runbooks runs commands over SSH only",
    );
    if (input.outOfOrder !== true) {
      const blocking = bundle.steps.filter(
        (other) => other.position < step.position && other.status === "pending",
      );
      if (blocking.length > 0) {
        throw new InputError(
          `step ${blocking[0].position} (${blocking[0].title}) is still pending`,
          409,
          {
            code: "order",
            blocking: blocking.map((other) => ({
              id: other.id,
              position: other.position,
              title: other.title,
            })),
          },
        );
      }
    }
    // The author asked to wait after the previous step ended.
    const wait = waitState(step, bundle.steps, bundle.runsByStep);
    const waiting = wait && wait.remainingMs > 0 ? wait : null;
    if (waiting && input.waitAnyway !== true) {
      const remainingSeconds = Math.ceil(waiting.remainingMs / 1000);
      throw new InputError(
        `the runbook says to wait ${remainingSeconds} s more after step ${waiting.previous.position}${
          waiting.reason ? ` (${waiting.reason})` : ""
        }`,
        409,
        {
          code: "wait",
          remainingSeconds,
          reason: waiting.reason,
          waitUntil: waiting.until,
          previous: waiting.previous,
        },
      );
    }
    if (input.confirmRepeat !== true) {
      const sameStep = bundle.runsByStep.get(step.id)?.[0];
      const since = new Date(Date.now() - REPEAT_WINDOW_MS).toISOString();
      const recent =
        sameStep ?? (await store.lastRunOfHash(resolved.hash!, since));
      if (recent) {
        throw new InputError(
          sameStep
            ? "this step already ran"
            : "the same command ran on this host in the last 24 hours",
          409,
          { code: "repeat", repeat: runSummary(recent, Boolean(sameStep)) },
        );
      }
    }
    const access = await ctx.hosts.checkAccess(step.hostId, "connect");
    if (!access.hasAccess) {
      throw new InputError("you cannot connect to this host", 403);
    }
    return {
      hostId: step.hostId,
      host,
      command: resolved.command!,
      hash: resolved.hash!,
      /** Seconds of the wait the person chose to skip, if any. */
      skippedWait: waiting ? Math.ceil(waiting.remainingMs / 1000) : null,
    };
  }

  /** Audits a start before the runbook's wait was over. */
  async function auditSkippedWait(
    req: Request,
    step: StepRow,
    seconds: number | null,
  ) {
    if (seconds === null) return;
    await audit(
      req,
      "runbooks_step_wait_skipped",
      step,
      `runbook ${step.runbookId} step ${step.position} started ${seconds} s before its wait was over`,
      true,
    );
  }

  /**
   * Finishes a run: tests the step's checks against the full output when
   * `checked` is given, sets the step's status and stores the captures. A
   * failed check fails the run and the step even on exit code 0; captures
   * are kept only from a run that ends done. Returns the outcome.
   */
  async function finishRun(
    runId: number,
    step: StepRow,
    outcome: "done" | "failed",
    output: string | null,
    patch: Partial<RunRow>,
    checked?: CheckedRun,
  ): Promise<"done" | "failed"> {
    const captures = applyCaptures(step.captures, output);
    const results =
      checked && step.checks.length > 0
        ? evaluateChecks(step.checks, checked, captures.values)
        : null;
    const final =
      outcome === "done" && (results ?? []).every((check) => check.ok)
        ? "done"
        : "failed";
    const errors = [patch.error, ...(final === "done" ? captures.errors : [])]
      .filter(Boolean)
      .join("; ");
    const at = now();
    await store.updateRun(runId, {
      ...patch,
      status: final,
      finishedAt: at,
      captured: final === "done" ? captures.values : {},
      checks: results,
      error: errors || null,
    });
    await store.updateStep(step.id, {
      status: final,
      skipReason: null,
      endedAt: at,
    });
    await store.touchRunbook(step.runbookId);
    await store.persist();
    return final;
  }

  async function audit(
    req: Request,
    action: string,
    step: StepRow,
    details: string,
    success: boolean,
    errorMessage?: string,
  ) {
    await ctx.audit.record({
      action,
      resourceType: "runbooks_step",
      resourceId: String(step.id),
      resourceName: step.title.slice(0, 200),
      details,
      success,
      errorMessage,
      request: req,
    });
  }

  /**
   * @openapi
   * /plugin-api/runbooks/runbooks:
   *   get:
   *     summary: List runbooks, open ones first, with progress
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbooks }
   */
  router.get(
    "/runbooks",
    ...use,
    wrap(async () => {
      const rows = await store.listRunbooks({});
      const out: ReturnType<typeof runbookSummary>[] = [];
      for (const runbook of rows) {
        out.push(runbookSummary(runbook, await store.listSteps(runbook.id)));
      }
      const order = { open: 0, done: 1, abandoned: 2 } as const;
      return out.sort((a, b) => order[a.status] - order[b.status]);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/runbooks/{id}:
   *   get:
   *     summary: One runbook with resolved commands, values and every run
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       404: { description: Not found }
   */
  router.get(
    "/runbooks/:id",
    ...use,
    wrap(async (req) =>
      personView(await bundleFor(idParam(req)), await hostNamer()),
    ),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/runbooks/{id}/status:
   *   post:
   *     summary: Mark a runbook open, done or abandoned
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/runbooks/:id/status",
    ...act,
    wrap(async (req) => {
      const id = idParam(req);
      await bundleFor(id);
      await store.touchRunbook(id, { status: parseStatus(body(req).status) });
      await store.persist();
      return personView(await bundleFor(id), await hostNamer());
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/run:
   *   post:
   *     summary: Start a step's command over SSH, as the signed-in person
   *     description: >
   *       Body { revision, commandHash, confirmRepeat?, outOfOrder?,
   *       waitAnyway? }. Answers
   *       at once with the run in status running; read the runbook for its
   *       output as it arrives. Refused
   *       with 409 when the step changed since it was shown, an earlier step is
   *       still pending, or the command already ran (until confirmed).
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run, still running }
   *       400: { description: The step's host is not an SSH host }
   *       409: { description: Stale, out of order, wait, repeat or no stored host key }
   */
  router.post(
    "/steps/:id/run",
    ...act,
    wrap(async (req) => {
      const stepId = idParam(req);
      const release = claim(stepId);
      let handedOff = false;
      try {
        const { step, bundle } = await stepContext(stepId);
        const target = await checkRunnable(step, bundle, body(req));
        // Without a stored key, a connection with no person to ask accepts
        // whatever key the server shows. Refuse rather than trust it.
        if (!target.host.hostKeyFingerprint) {
          throw new InputError(NO_HOST_KEY, 409, { code: "no-host-key" });
        }
        await auditSkippedWait(req, step, target.skippedWait);
        const startedAt = now();
        const runId = await store.insertRun({
          stepId: step.id,
          runbookId: step.runbookId,
          mode: "exec",
          status: "running",
          hostId: target.hostId,
          command: target.command,
          commandHash: target.hash,
          userId: actor(),
          startedAt,
          finishedAt: null,
          exitCode: null,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
          pastedOutput: null,
          error: null,
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
        const record = live.start({
          runId,
          stepId: step.id,
          runbookId: step.runbookId,
          startedAt,
        });
        // Started inside the request, so it keeps acting as this person
        // after the answer is sent.
        record.done = execute(req, runId, step, target, release);
        handedOff = true;
        return shownRun(runId);
      } finally {
        if (!handedOff) release();
      }
    }),
  );

  /**
   * Runs the command over a connection of its own, through core's connect
   * pipeline (access check, stored login, host key check, audit), hands the
   * output to the live buffer as it arrives, and finishes the run.
   */
  async function execute(
    req: Request,
    runId: number,
    step: StepRow,
    target: { hostId: number; command: string },
    release: () => void,
  ): Promise<void> {
    const record = live.get(runId)!;
    const where = `runbook ${step.runbookId} step ${step.position} on host ${target.hostId}`;
    let connection: { client: ExecClient; dispose: () => void } | null = null;
    try {
      let result: Awaited<ReturnType<typeof streamExec>["result"]>;
      try {
        connection = await ctx.ssh.connect<ExecClient>(target.hostId, {
          purpose: "runbooks",
        });
        if (record.stoppedBy) {
          result = {
            stdout: "",
            stderr: "",
            code: null,
            truncated: false,
            timedOut: false,
            stopped: true,
          };
        } else {
          const handle = streamExec(connection.client, target.command, {
            timeoutMs: step.timeoutMs ?? LIMITS.timeoutDefault,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            onOutput: (stream, text) => live.output(runId, stream, text),
            onTruncate: () => live.truncated(runId),
          });
          record.stop = handle.stop;
          result = await handle.result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await live.settle(runId);
        const partial = live.get(runId)!;
        await finishRun(runId, step, "failed", null, {
          stdout: partial.stdout,
          stderr: partial.stderr,
          truncated: partial.truncated,
          error: record.stoppedBy
            ? `stopped by ${record.stoppedBy}`
            : (record.interrupted ?? message),
        });
        await audit(req, "runbooks_step_run", step, where, false, message);
        return;
      }
      await live.settle(runId);
      const stopped = result.stopped || Boolean(record.stoppedBy);
      const exited =
        result.code === 0 &&
        !result.timedOut &&
        !stopped &&
        !record.interrupted;
      const outcome = await finishRun(
        runId,
        step,
        exited ? "done" : "failed",
        result.stdout,
        {
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          timedOut: result.timedOut,
          error: stopped
            ? `stopped by ${record.stoppedBy ?? "a person"}`
            : record.interrupted,
        },
        {
          mode: "exec",
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          pastedOutput: null,
        },
      );
      const ok = outcome === "done";
      await audit(
        req,
        "runbooks_step_run",
        step,
        `${where}: ${
          stopped
            ? "stopped"
            : result.timedOut
              ? "timed out"
              : `exit ${result.code ?? "none"}${
                  exited && !ok ? ", checks failed" : ""
                }`
        }`,
        ok,
      );
    } catch (error) {
      // Most likely the database went away because Termix is stopping; the
      // sweep on the next start finishes the run.
      ctx.log.error(
        `run ${runId} could not be finished`,
        error instanceof Error ? error : undefined,
      );
    } finally {
      connection?.dispose();
      live.remove(runId);
      release();
    }
  }

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/stop:
   *   post:
   *     summary: Stop the step's running command
   *     description: >
   *       Sends TERM where the server takes signals, then closes the
   *       command's channel. The run ends failed with "stopped by <user>".
   *       A person only; refused for a Termix API key.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   *       409: { description: The step is not running }
   */
  router.post(
    "/steps/:id/stop",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(idParam(req));
      const record = live.byStep(step.id);
      if (!record) {
        throw new InputError("this step is not running", 409, {
          code: "not-running",
        });
      }
      if (!record.stoppedBy) {
        record.stoppedBy = actor();
        record.stop?.();
        await audit(
          req,
          "runbooks_step_stop",
          step,
          `runbook ${step.runbookId} step ${step.position} run ${record.runId} stopped`,
          true,
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        record.done,
        new Promise((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS))),
      ]);
      clearTimeout(timer);
      return shownRun(record.runId);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/terminal:
   *   post:
   *     summary: Record that the person sent the command to a terminal
   *     description: >
   *       Same checks as run. Makes a run in mode terminal that waits for the
   *       person to paste the output (runs/{id}/complete).
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   */
  router.post(
    "/steps/:id/terminal",
    ...act,
    wrap(async (req) =>
      claimed(idParam(req), async (stepId) => {
        const { step, bundle } = await stepContext(stepId);
        const target = await checkRunnable(step, bundle, body(req));
        await auditSkippedWait(req, step, target.skippedWait);
        const runId = await store.insertRun({
          stepId: step.id,
          runbookId: step.runbookId,
          mode: "terminal",
          status: "awaiting-output",
          hostId: target.hostId,
          command: target.command,
          commandHash: target.hash,
          userId: actor(),
          startedAt: now(),
          finishedAt: null,
          exitCode: null,
          stdout: null,
          stderr: null,
          truncated: false,
          timedOut: false,
          pastedOutput: null,
          error: null,
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
        await audit(
          req,
          "runbooks_step_terminal",
          step,
          `runbook ${step.runbookId} step ${step.position} sent to a terminal on host ${target.hostId}`,
          true,
        );
        return store.getRun(runId);
      }),
    ),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/runs/{id}/complete:
   *   post:
   *     summary: Finish a terminal run with the pasted output
   *     description: Body { pastedOutput, exitCode?, outcome done|failed }.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   */
  router.post(
    "/runs/:id/complete",
    ...act,
    wrap(async (req) => {
      const run = await store.getRun(idParam(req));
      if (!run) throw new InputError("run not found", 404);
      if (run.mode !== "terminal" || run.status !== "awaiting-output") {
        throw new InputError("this run is not waiting for output", 409);
      }
      const input = body(req);
      const outcome = input.outcome;
      if (outcome !== "done" && outcome !== "failed") {
        throw new InputError("outcome must be done or failed");
      }
      const pasted = input.pastedOutput ?? "";
      if (typeof pasted !== "string" || pasted.length > MAX_OUTPUT_BYTES) {
        throw new InputError(
          `pastedOutput must be text of at most ${MAX_OUTPUT_BYTES} characters`,
        );
      }
      const exitCode = input.exitCode ?? null;
      if (exitCode !== null && !Number.isInteger(exitCode)) {
        throw new InputError("exitCode must be an integer or null");
      }
      const step = await store.getStep(run.stepId);
      if (!step) throw new InputError("step not found", 404);
      const final = await finishRun(
        run.id,
        step,
        outcome,
        pasted,
        { pastedOutput: pasted, exitCode: exitCode as number | null },
        // Mark done tests the checks on what was pasted; Mark failed does not.
        outcome === "done"
          ? {
              mode: "terminal",
              exitCode: exitCode as number | null,
              stdout: null,
              stderr: null,
              pastedOutput: pasted,
            }
          : undefined,
      );
      await audit(
        req,
        "runbooks_step_complete",
        step,
        `runbook ${step.runbookId} step ${step.position} marked ${outcome}${
          final !== outcome ? ", checks failed" : ""
        }`,
        true,
      );
      return store.getRun(run.id);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/skip:
   *   post:
   *     summary: Skip a step, with a reason
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/steps/:id/skip",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(idParam(req));
      const reason = body(req).reason ?? "";
      if (typeof reason !== "string" || reason.length > LIMITS.ownerNote) {
        throw new InputError("reason must be short text");
      }
      await store.updateStep(step.id, {
        status: "skipped",
        skipReason: reason,
        endedAt: now(),
      });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      await audit(req, "runbooks_step_skip", step, reason.slice(0, 500), true);
      return personView(await bundleFor(step.runbookId), await hostNamer());
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/reopen:
   *   post:
   *     summary: Put a step back to pending; its runs are kept
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/steps/:id/reopen",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(idParam(req));
      await store.updateStep(step.id, {
        status: "pending",
        skipReason: null,
        endedAt: null,
      });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      return personView(await bundleFor(step.runbookId), await hostNamer());
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/note:
   *   post:
   *     summary: Save the owner's note on a step
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: Saved }
   */
  router.post(
    "/steps/:id/note",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(idParam(req));
      const note = body(req).ownerNote ?? "";
      if (typeof note !== "string" || note.length > LIMITS.ownerNote) {
        throw new InputError(
          `ownerNote must be text of at most ${LIMITS.ownerNote} characters`,
        );
      }
      await store.updateStep(step.id, { ownerNote: note });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      return { ok: true };
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/hide:
   *   post:
   *     summary: Hide or show a step's output to agents
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/steps/:id/hide",
    ...act,
    wrap(async (req) => {
      const { step } = await stepContext(idParam(req));
      const hidden = body(req).hidden;
      if (typeof hidden !== "boolean") {
        throw new InputError("hidden must be true or false");
      }
      await store.updateStep(step.id, { hideOutputFromAgents: hidden });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      return personView(await bundleFor(step.runbookId), await hostNamer());
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/tokens:
   *   get:
   *     summary: List Runbooks tokens (never the secret)
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The tokens }
   *   post:
   *     summary: Make a token; the secret is in this answer only
   *     tags: [Runbooks]
   *     responses:
   *       201: { description: The token, once }
   */
  router.get(
    "/tokens",
    ...tokensRole,
    wrap(async () =>
      (await flagTokenHosts(await store.listTokens())).map(
        ({ tokenHash: _hash, ...rest }) => rest,
      ),
    ),
  );
  router.post(
    "/tokens",
    ...tokensRole,
    wrap(async (req, res) => {
      const name = body(req).name;
      if (typeof name !== "string" || !name.trim() || name.length > 100) {
        throw new InputError("name is required (at most 100 characters)");
      }
      const hosts = await chooseHosts(body(req).hostIds);
      const made = newToken();
      const id = await store.createToken({
        name: name.trim(),
        tokenHash: made.hash,
        prefix: made.prefix,
        createdBy: actor(),
        hosts,
      });
      await store.persist();
      await ctx.audit.record({
        action: "runbooks_token_create",
        resourceType: "runbooks_token",
        resourceId: String(id),
        resourceName: name.trim(),
        success: true,
        request: req,
      });
      res.status(201);
      return {
        id,
        name: name.trim(),
        prefix: made.prefix,
        hosts,
        token: made.token,
      };
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/tokens/{id}/hosts:
   *   post:
   *     summary: Replace the hosts a token may name in steps
   *     description: >
   *       Body { hostIds }. Each host must be an SSH host you can connect to;
   *       a remote desktop host is refused with 400.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The token }
   */
  router.post(
    "/tokens/:id/hosts",
    ...tokensRole,
    wrap(async (req) => {
      const id = idParam(req);
      const token = await store.getToken(id);
      if (!token) throw new InputError("token not found", 404);
      if (token.revokedAt) {
        throw new InputError("this token was revoked", 409);
      }
      const hosts = await chooseHosts(body(req).hostIds);
      await store.setTokenHosts(id, hosts);
      await store.persist();
      await ctx.audit.record({
        action: "runbooks_token_hosts",
        resourceType: "runbooks_token",
        resourceId: String(id),
        resourceName: token.name,
        details: `hosts: ${hosts.map((host) => host.id).join(", ")}`,
        success: true,
        request: req,
      });
      const { tokenHash: _hash, ...rest } = (await store.getToken(id))!;
      return rest;
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/tokens/{id}/revoke:
   *   post:
   *     summary: Revoke a token
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: Revoked }
   */
  router.post(
    "/tokens/:id/revoke",
    ...tokensRole,
    wrap(async (req) => {
      const id = idParam(req);
      if (!(await store.revokeToken(id))) {
        throw new InputError("token not found", 404);
      }
      await store.persist();
      await ctx.audit.record({
        action: "runbooks_token_revoke",
        resourceType: "runbooks_token",
        resourceId: String(id),
        success: true,
        request: req,
      });
      return { ok: true };
    }),
  );
}
