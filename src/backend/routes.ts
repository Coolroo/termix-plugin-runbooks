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
  valuesObject,
  type RunbookBundle,
} from "./service.js";
import type { RunRow, StepRow, Store } from "./store.js";
import { now } from "./store.js";
import { newToken } from "./tokens.js";
import { applyCaptures } from "./values.js";

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 262_144;
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

  /** Steps currently running, so a double click does not run twice. */
  const inFlight = new Set<number>();

  async function hostNamer() {
    const names = new Map<number, string>();
    for (const host of await ctx.hosts.list()) {
      names.set(host.id, host.name || host.ip);
    }
    return (hostId: number) => names.get(hostId) ?? null;
  }

  async function bundleFor(runbookId: number): Promise<RunbookBundle> {
    const bundle = await loadBundle(store, runbookId);
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
      command: resolved.command!,
      hash: resolved.hash!,
    };
  }

  /** Sets a step's status from a finished run and stores its captures. */
  async function finishRun(
    run: RunRow,
    step: StepRow,
    outcome: "done" | "failed",
    output: string | null,
    patch: Partial<RunRow>,
  ) {
    const captures = applyCaptures(
      step.captures,
      outcome === "done" ? output : null,
    );
    const errors = [patch.error, ...captures.errors].filter(Boolean).join("; ");
    await store.updateRun(run.id, {
      ...patch,
      status: outcome,
      finishedAt: now(),
      captured: captures.values,
      error: errors || null,
    });
    await store.updateStep(step.id, { status: outcome, skipReason: null });
    await store.touchRunbook(step.runbookId);
    await store.persist();
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
   *     summary: Run a step's command over SSH, as the signed-in person
   *     description: >
   *       Body { revision, commandHash, confirmRepeat?, outOfOrder? }. Refused
   *       with 409 when the step changed since it was shown, an earlier step is
   *       still pending, or the command already ran (until confirmed).
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The run }
   *       409: { description: Stale, out of order, repeat or no stored host key }
   */
  router.post(
    "/steps/:id/run",
    ...act,
    wrap(async (req) => {
      const { step, bundle } = await stepContext(idParam(req));
      const target = await checkRunnable(step, bundle, body(req));
      const host = await ctx.ssh.resolveHost(target.hostId);
      if (!host) throw new InputError("you cannot connect to this host", 403);
      // Without a stored key, a connection with no person to ask accepts
      // whatever key the server shows. Refuse rather than trust it.
      if (!host.hostKeyFingerprint) {
        throw new InputError(NO_HOST_KEY, 409, { code: "no-host-key" });
      }
      if (inFlight.has(step.id)) {
        throw new InputError("this step is already running", 409, {
          code: "running",
        });
      }
      inFlight.add(step.id);
      try {
        const runId = await store.insertRun({
          stepId: step.id,
          runbookId: step.runbookId,
          mode: "exec",
          status: "running",
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
        await store.persist();
        const run = (await store.getRun(runId))!;
        try {
          const result = await ctx.ssh.exec(target.hostId, target.command, {
            timeoutMs: step.timeoutMs ?? LIMITS.timeoutDefault,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            purpose: "runbooks",
          });
          const ok = result.code === 0 && !result.timedOut;
          await finishRun(run, step, ok ? "done" : "failed", result.stdout, {
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            timedOut: result.timedOut,
          });
          await audit(
            req,
            "runbooks_step_run",
            step,
            `runbook ${step.runbookId} step ${step.position} on host ${target.hostId}: exit ${result.code ?? "none"}`,
            ok,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await finishRun(run, step, "failed", null, { error: message });
          await audit(
            req,
            "runbooks_step_run",
            step,
            `runbook ${step.runbookId} step ${step.position} on host ${target.hostId}`,
            false,
            message,
          );
        }
        return store.getRun(runId);
      } finally {
        inFlight.delete(step.id);
      }
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
    wrap(async (req) => {
      const { step, bundle } = await stepContext(idParam(req));
      const target = await checkRunnable(step, bundle, body(req));
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
      await finishRun(run, step, outcome, pasted, {
        pastedOutput: pasted,
        exitCode: exitCode as number | null,
      });
      await audit(
        req,
        "runbooks_step_complete",
        step,
        `runbook ${step.runbookId} step ${step.position} marked ${outcome}`,
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
      await store.updateStep(step.id, { status: "pending", skipReason: null });
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
      (await store.listTokens()).map(({ tokenHash: _hash, ...rest }) => rest),
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
      const made = newToken();
      const id = await store.createToken({
        name: name.trim(),
        tokenHash: made.hash,
        prefix: made.prefix,
        createdBy: actor(),
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
      return { id, name: name.trim(), prefix: made.prefix, token: made.token };
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
