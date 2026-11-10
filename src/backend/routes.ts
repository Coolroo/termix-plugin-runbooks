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
  amendmentView,
  loadBundle,
  parseStatus,
  personView,
  resolveStep,
  runbookSummary,
  secretsPending,
  stdinText,
  stepStdin,
  waitState,
  valuesObject,
  type RunbookBundle,
} from "./service.js";
import type {
  RunbookRow,
  RunRow,
  StepRow,
  Store,
  TokenHost,
  TokenRow,
} from "./store.js";
import { now } from "./store.js";
import { newToken } from "./tokens.js";
import { applyCaptures, findSecrets, resolve } from "./values.js";
import { isSshHost } from "../shared/hosts.js";
import { isBefore, stepLabel } from "../shared/steps.js";
import {
  COLORS_SETTING,
  effectiveColors,
  nextKind,
} from "../shared/step-kinds.js";
import type { LiveRuns } from "./live.js";
import { streamExec, type ExecClient } from "./stream-exec.js";
import { checkHidden, type CheckedRun, type CheckResult } from "./checks.js";
import { createRedactor, redact, type SecretText } from "./redact.js";
import { NO_SECRETS, SECRET_TTL_MS, type Secrets } from "./secrets.js";
import {
  MAX_SENT_NOTE,
  SYSTEM,
  type Events,
  type FailReason,
} from "./events.js";
import {
  describeStdin,
  libraryRef,
  secretLabel,
  type RunStdin,
  type StdinSource,
} from "./stdin.js";

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 262_144;
export const MAX_TOKEN_HOSTS = 500;
/** How long Stop waits for the run to be written before it answers. */
export const STOP_WAIT_MS = 5000;
/** How long a failed delete of a closed runbook's secrets waits to retry. */
export const REMOVE_RETRY_MS = 5 * 60 * 1000;
/** Why a person cannot run, send or mark an agent step. */
const AGENT_STEP =
  "this step is for the agent: it completes it itself; you can Skip or Reopen it";
/** Why a replaced step does not run (1.4.0). */
function replacedProblem(step: StepRow, steps: StepRow[]): InputError {
  const by = amendmentView(step, steps).replacedBy;
  return new InputError(
    `step ${stepLabel(step)} was replaced${by ? ` by ${by.label}` : ""}; run the new step instead`,
    409,
    { code: "replaced", replacedBy: by },
  );
}
/** Why a step run outside Termix has no Run or Send (1.4.0). */
const OUTSIDE_STEP =
  "this step runs outside Termix: copy the command, run it there, then mark it Done or Failed with the output";
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
  secrets: Secrets,
  events: Events,
  notify: { enabled: () => Promise<boolean> },
): void {
  const actor = () => ctx.currentActor() as string;

  /** The runbook as the page shows it. */
  async function showRunbook(bundle: RunbookBundle) {
    const sent = (
      await store.listEvents({
        runbookId: bundle.runbook.id,
        limit: 1000,
        order: "newest",
      })
    ).filter((event) => event.type === "sent");
    return personView(bundle, await hostNamer(), {
      secretsAvailable: secrets.available(),
      noSecrets: NO_SECRETS,
      notifyEnabled: await notify.enabled(),
      sent,
    });
  }

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
    if (step.owner === "agent") {
      throw new InputError(AGENT_STEP, 409, { code: "agent-step" });
    }
    if (bundle.runbook.status !== "open") {
      throw new InputError(`this runbook is ${bundle.runbook.status}`, 409);
    }
    if (step.status === "replaced") throw replacedProblem(step, bundle.steps);
    if (step.where) {
      throw new InputError(OUTSIDE_STEP, 409, { code: "outside" });
    }
    if (step.hostId === null || step.command === null) {
      throw new InputError("this step has no command to run", 400);
    }
    const stdin = stepStdin(step, bundle.steps);
    const resolved = resolveStep(step, valuesObject(bundle.values), stdin);
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
      // A replaced step counts as ended: its status is not pending.
      const blocking = bundle.steps.filter(
        (other) => isBefore(other, step) && other.status === "pending",
      );
      if (blocking.length > 0) {
        throw new InputError(
          `step ${stepLabel(blocking[0])} (${blocking[0].title}) is still pending`,
          409,
          {
            code: "order",
            blocking: blocking.map((other) => ({
              id: other.id,
              position: other.position,
              label: stepLabel(other),
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
        `the runbook says to wait ${remainingSeconds} s more after step ${waiting.previous.label}${
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
    // A secret this step captures has nowhere to go without the service.
    if (step.secretCaptures.length > 0) await secrets.require();
    return {
      hostId: step.hostId,
      host,
      command: resolved.command!,
      hash: resolved.hash!,
      stdin,
      /** Seconds of the wait the person chose to skip, if any. */
      skippedWait: waiting ? Math.ceil(waiting.remainingMs / 1000) : null,
    };
  }

  /**
   * The bytes a Run writes to the command's standard input, read as the
   * person who runs it, with what the run keeps of them (the source and the
   * size) and the secret it read, if any. Refused with 409 when there is
   * nothing to give.
   */
  async function readStdin(
    step: StepRow,
    bundle: RunbookBundle,
    source: StdinSource,
  ): Promise<{ bytes: Buffer; record: RunStdin; secret: SecretText | null }> {
    const found = stdinText(
      source,
      step,
      bundle.steps,
      bundle.runsByStep,
      valuesObject(bundle.values),
    );
    if (found && "problem" in found) {
      throw new InputError(found.problem, 409, { code: "stdin-missing" });
    }
    let text: string;
    let secret: SecretText | null = null;
    if (found) {
      text = found.text;
    } else if (source.from === "secret") {
      const name = secretLabel(source)!;
      let value: string | null;
      if ("name" in source) {
        value = await secrets.getCaptured(step.runbookId, source.name);
      } else {
        const ref = libraryRef(source.library);
        value = await secrets.getLibrary(ref.area, ref.name);
      }
      if (value === null || value === "") {
        throw new InputError(
          `secret ${name} is not there: it was never captured, it expired or it was deleted`,
          409,
          { code: "secret-missing", secret: name },
        );
      }
      text = `${value}\n`;
      secret = { name, value };
    } else {
      throw new InputError("this step has no input", 409, {
        code: "stdin-missing",
      });
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_OUTPUT_BYTES) {
      throw new InputError(
        `the input is ${Math.ceil(bytes.length / 1024)} KB; at most ${MAX_OUTPUT_BYTES / 1024} KB`,
        409,
        { code: "stdin-missing" },
      );
    }
    return { bytes, record: { ...source, bytes: bytes.length }, secret };
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
      `runbook ${step.runbookId} step ${stepLabel(step)} started ${seconds} s before its wait was over`,
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
    options: {
      checked?: CheckedRun;
      /** Secrets the step read: replaced in everything the run keeps. */
      used?: SecretText[];
      /** Who ended it, for the events. */
      by?: string;
      /** Why it failed, when `outcome` is failed. */
      reason?: FailReason;
    } = {},
  ): Promise<{ final: "done" | "failed"; stored: string[] }> {
    const used = options.used ?? [];
    // Secret values found in the output are replaced whatever the outcome;
    // they are stored only from a run that ends done. They are found first,
    // so the checks see the output with its secrets hidden (1.4.1).
    const found = findSecrets(step.secretCaptures, output);
    const hide: SecretText[] = [
      ...used,
      ...Object.entries(found.values).map(([name, value]) => ({ name, value })),
    ];
    const captures = applyCaptures(step.captures, output);
    const results =
      options.checked && step.checks.length > 0
        ? checkHidden(step.checks, options.checked, captures.values, hide)
        : null;
    let final: "done" | "failed" =
      outcome === "done" && (results ?? []).every((check) => check.ok)
        ? "done"
        : "failed";
    const problems: string[] = [];
    const stored: Array<{ name: string; expiresAt: string }> = [];
    if (final === "done" && step.secretCaptures.length > 0) {
      if (found.missing.length > 0) {
        final = "failed";
        problems.push(
          ...found.missing.map((name) => `secret ${name}: no match`),
        );
      } else {
        const expiresAt = new Date(Date.now() + SECRET_TTL_MS).toISOString();
        for (const capture of step.secretCaptures) {
          try {
            await secrets.putCaptured(
              step.runbookId,
              capture.name,
              found.values[capture.name],
              expiresAt,
            );
            stored.push({ name: capture.name, expiresAt });
          } catch (error) {
            final = "failed";
            problems.push(
              `secret ${capture.name}: could not be stored: ${
                error instanceof Error ? error.message : "failed"
              }`,
            );
            break;
          }
        }
        if (final === "failed") {
          // A step that failed leaves no secret for a later step.
          for (const secret of stored.splice(0)) {
            await secrets
              .removeCaptured(step.runbookId, secret.name)
              .catch(() => false);
          }
        }
      }
    }
    const errors = [
      patch.error,
      ...problems,
      ...(final === "done" ? captures.errors : []),
    ]
      .filter(Boolean)
      .join("; ");
    const at = now();
    const kept = (text: string | null | undefined) =>
      text === undefined ? undefined : redact(text, hide);
    const usedNames = used.map((secret) => secret.name);
    const reason: FailReason | null =
      final === "done"
        ? null
        : outcome === "failed"
          ? (options.reason ?? "exit")
          : results && !results.every((check) => check.ok)
            ? "check"
            : "secret";
    const by = options.by ?? ctx.currentActor() ?? SYSTEM;
    await events.around(step.runbookId, by, async () => {
      await store.updateRun(runId, {
        ...patch,
        stdout: kept(patch.stdout),
        stderr: kept(patch.stderr),
        pastedOutput: kept(patch.pastedOutput),
        status: final,
        finishedAt: at,
        captured:
          final === "done"
            ? Object.fromEntries(
                Object.entries(captures.values).map(([name, value]) => [
                  name,
                  redact(value, hide),
                ]),
              )
            : {},
        checks: results,
        error: errors ? redact(errors, hide) : null,
        ...(usedNames.length || stored.length
          ? { secrets: { used: usedNames, captured: stored } }
          : {}),
      });
      // A step replaced while its run was being written keeps "replaced".
      const replaced = (await store.getStep(step.id))?.status === "replaced";
      await store.updateStep(
        step.id,
        replaced
          ? { endedAt: at }
          : { status: final, skipReason: null, endedAt: at },
      );
      await events.stepEnded(step, final, reason, by);
      await store.touchRunbook(
        step.runbookId,
        stored.length ? { secretsStoredAt: at } : {},
      );
      await store.persist();
    });
    return { final, stored: stored.map((secret) => secret.name) };
  }

  /** When to try again to delete a closed runbook's secrets. */
  const removeRetryAt = new Map<number, number>();

  /**
   * Deletes the secrets a done or abandoned runbook captured, as the person
   * of this request (who needs Use secrets). Tried again on later reads
   * when it fails, at most every 5 minutes; OpenBao Secrets deletes what is
   * left when it expires. Returns whether it deleted them.
   */
  async function removeSecrets(
    req: Request,
    runbook: RunbookRow,
    steps: StepRow[],
    force = false,
  ): Promise<boolean> {
    if (runbook.status === "open" || !secretsPending(runbook, steps)) {
      return false;
    }
    if (!secrets.available()) return false;
    if (!force && (removeRetryAt.get(runbook.id) ?? 0) > Date.now()) {
      return false;
    }
    const line = {
      action: "runbooks_secrets_remove",
      resourceType: "runbooks_runbook",
      resourceId: String(runbook.id),
      resourceName: runbook.title.slice(0, 200),
      request: req,
    };
    try {
      const count = await secrets.removeRunbook(runbook.id);
      await store.touchRunbook(runbook.id, { secretsRemovedAt: now() });
      await store.persist();
      removeRetryAt.delete(runbook.id);
      await ctx.audit.record({
        ...line,
        details: `runbook ${runbook.id} is ${runbook.status}: deleted ${count} captured secrets`,
        success: true,
      });
      return true;
    } catch (error) {
      removeRetryAt.set(runbook.id, Date.now() + REMOVE_RETRY_MS);
      await ctx.audit.record({
        ...line,
        details: `runbook ${runbook.id} is ${runbook.status}: could not delete its captured secrets`,
        success: false,
        errorMessage: error instanceof Error ? error.message : "failed",
      });
      return false;
    }
  }

  /** ", stored secret a, b" for an audit line: names only. */
  const storedNote = (names: string[]) =>
    names.length ? `, stored secret ${names.join(", ")}` : "";

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
    wrap(async (req) => {
      const rows = await store.listRunbooks({});
      const out: Array<
        ReturnType<typeof runbookSummary> & { nextKind: string | null }
      > = [];
      for (const runbook of rows) {
        const steps = await store.listSteps(runbook.id);
        // A runbook an agent closed still has its secrets: delete them now.
        await removeSecrets(req, runbook, steps);
        // The kind of the next step (1.4.1): the list shows its color.
        out.push({
          ...runbookSummary(runbook, steps),
          nextKind: nextKind(steps),
        });
      }
      const order = { open: 0, done: 1, abandoned: 2 } as const;
      return out.sort((a, b) => order[a.status] - order[b.status]);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/colors:
   *   get:
   *     summary: The step colors this person sees, by kind of step
   *     description: >
   *       { [kind id]: "#rrggbb" }: the person's own color, else the
   *       admin's. A kind that is not there keeps its built-in color.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The colors }
   */
  router.get(
    "/colors",
    ...use,
    wrap(async () => {
      // Checked again on read: only a color ever reaches a style.
      return effectiveColors(
        await ctx.settings.get(COLORS_SETTING),
        await ctx.settings.getUser(actor(), COLORS_SETTING),
      );
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
    wrap(async (req) => {
      const id = idParam(req);
      const bundle = await bundleFor(id);
      return (await removeSecrets(req, bundle.runbook, bundle.steps))
        ? showRunbook(await bundleFor(id))
        : showRunbook(bundle);
    }),
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
      const before = (await bundleFor(id)).runbook;
      const status = parseStatus(body(req).status);
      await events.around(id, actor(), async () => {
        await store.touchRunbook(id, { status });
        const after = (await store.getRunbook(id))!;
        await events.statusChanged(after, before.status, actor());
        await store.persist();
      });
      const closed = await bundleFor(id);
      // Done or abandoned: the secrets it captured are deleted now.
      await removeSecrets(req, closed.runbook, closed.steps, true);
      return showRunbook(await bundleFor(id));
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
        const input = target.stdin
          ? await readStdin(step, bundle, target.stdin)
          : null;
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
          stdin: input?.record ?? null,
          startedEarlySeconds: target.skippedWait,
          secrets: input?.secret
            ? { used: [input.secret.name], captured: [] }
            : null,
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
        record.done = execute(
          req,
          runId,
          step,
          {
            by: actor(),
            hostId: target.hostId,
            command: target.command,
            stdin: input?.bytes,
            used: input?.secret ? [input.secret] : [],
          },
          release,
        );
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
    target: {
      /** The person who pressed Run. */
      by: string;
      hostId: number;
      command: string;
      /** Written to the command's standard input, then ended. */
      stdin?: Buffer;
      /** Secrets the step reads: replaced in its output. */
      used: SecretText[];
    },
    release: () => void,
  ): Promise<void> {
    const record = live.get(runId)!;
    const where = `runbook ${step.runbookId} step ${stepLabel(step)} on host ${target.hostId}${
      target.used.length
        ? `, read secret ${target.used.map((secret) => secret.name).join(", ")}`
        : ""
    }`;
    // A value split across two pieces of output is still replaced.
    const redactors = {
      stdout: createRedactor(target.used),
      stderr: createRedactor(target.used),
    };
    // A secret this step captures is known only once the output is
    // complete, so its output is not shown or written before the end.
    const held = step.secretCaptures.length > 0;
    record.held = held;
    const raw = { stdout: "", stderr: "" };
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
            onOutput: (stream, text) => {
              if (held) {
                raw[stream] += text;
                live.heard(runId);
              } else {
                live.output(runId, stream, redactors[stream].push(text));
              }
            },
            onTruncate: () => live.truncated(runId),
            stdin: target.stdin,
          });
          record.stop = handle.stop;
          result = await handle.result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await live.settle(runId);
        const partial = live.get(runId)!;
        await finishRun(
          runId,
          step,
          "failed",
          held ? raw.stdout : null,
          {
            stdout: held ? raw.stdout : partial.stdout,
            stderr: held ? raw.stderr : partial.stderr,
            truncated: partial.truncated,
            error: record.stoppedBy
              ? `stopped by ${record.stoppedBy}`
              : (record.interrupted ?? message),
          },
          {
            used: target.used,
            by: target.by,
            reason: record.stoppedBy
              ? "stopped"
              : record.interrupted
                ? "interrupted"
                : "exit",
          },
        );
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
          checked: {
            mode: "exec",
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            pastedOutput: null,
          },
          used: target.used,
          by: target.by,
          reason: stopped
            ? "stopped"
            : record.interrupted
              ? "interrupted"
              : "exit",
        },
      );
      const ok = outcome.final === "done";
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
        }${storedNote(outcome.stored)}`,
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
          `runbook ${step.runbookId} step ${stepLabel(step)} run ${record.runId} stopped`,
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
        if (step.owner === "agent") {
          throw new InputError(AGENT_STEP, 409, { code: "agent-step" });
        }
        const stdin = stepStdin(step, bundle.steps);
        if (stdin) {
          throw new InputError(
            `This step gets input from ${describeStdin(stdin)}: use Run`,
            409,
            { code: "stdin-run-only" },
          );
        }
        const target = await checkRunnable(step, bundle, body(req));
        await auditSkippedWait(req, step, target.skippedWait);
        const runId = await store.insertRun({
          stepId: step.id,
          runbookId: step.runbookId,
          mode: "terminal",
          status: "awaiting-output",
          startedEarlySeconds: target.skippedWait,
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
          `runbook ${step.runbookId} step ${stepLabel(step)} sent to a terminal on host ${target.hostId}`,
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
      if (outcome === "done" && pasted.trim() === "") {
        throw new InputError(
          "paste at least one line of the output to mark the run done",
        );
      }
      const exitCode = input.exitCode ?? null;
      if (exitCode !== null && !Number.isInteger(exitCode)) {
        throw new InputError("exitCode must be an integer or null");
      }
      const step = await store.getStep(run.stepId);
      if (!step) throw new InputError("step not found", 404);
      const { final, stored } = await finishRun(
        run.id,
        step,
        outcome,
        pasted,
        { pastedOutput: pasted, exitCode: exitCode as number | null },
        {
          // Mark done tests the checks on what was pasted; Mark failed
          // does not.
          checked:
            outcome === "done"
              ? {
                  mode: "terminal",
                  exitCode: exitCode as number | null,
                  stdout: null,
                  stderr: null,
                  pastedOutput: pasted,
                }
              : undefined,
          by: actor(),
          reason: "manual",
        },
      );
      await audit(
        req,
        "runbooks_step_complete",
        step,
        `runbook ${step.runbookId} step ${stepLabel(step)} marked ${outcome}${
          final !== outcome ? ", checks failed" : ""
        }${storedNote(stored)}`,
        true,
      );
      return store.getRun(run.id);
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/manual:
   *   post:
   *     summary: Mark a step with no command, or one run outside Termix, done or failed
   *     description: >
   *       Body { outcome: done|failed, note? }. Records a run in mode manual
   *       with who, when, the outcome and the note. Refused with 400 for a
   *       step that Termix runs. A step run outside Termix (1.4.0) also
   *       takes { revision, output? }: the revision the person saw (409
   *       stale otherwise) and the pasted output, which its checks test
   *       and its captures read; it records a run in mode outside with the
   *       resolved command. A person only.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: Stale, missing values, or a closed runbook }
   */
  router.post(
    "/steps/:id/manual",
    ...act,
    wrap(async (req) =>
      claimed(idParam(req), async (stepId) => {
        const { step, bundle } = await stepContext(stepId);
        if (step.owner === "agent") {
          throw new InputError(AGENT_STEP, 409, { code: "agent-step" });
        }
        if (bundle.runbook.status !== "open") {
          throw new InputError(`this runbook is ${bundle.runbook.status}`, 409);
        }
        if (step.status === "replaced") {
          throw replacedProblem(step, bundle.steps);
        }
        const outside = Boolean(step.where);
        if (!outside && (step.hostId !== null || step.command !== null)) {
          throw new InputError(
            "this step has a command: use Run or Send to terminal",
          );
        }
        const input = body(req);
        const outcome = input.outcome;
        if (outcome !== "done" && outcome !== "failed") {
          throw new InputError("outcome must be done or failed");
        }
        const note = input.note ?? "";
        if (typeof note !== "string" || note.length > LIMITS.ownerNote) {
          throw new InputError(
            `note must be text of at most ${LIMITS.ownerNote} characters`,
          );
        }
        // A step run outside Termix: the command the person copied, the
        // output they pasted, and the revision they saw.
        let command = "";
        let pasted: string | null = null;
        let results: CheckResult[] | null = null;
        let captured: Record<string, string> = {};
        let final: "done" | "failed" = outcome;
        if (outside) {
          if (input.revision !== step.revision) {
            throw new InputError("the step changed; reload", 409, {
              code: "stale",
            });
          }
          const resolved = resolve(step.command!, valuesObject(bundle.values));
          if (resolved.missing.length > 0) {
            throw new InputError(
              `values missing: ${resolved.missing.join(", ")}`,
              409,
              { code: "missing-values", missing: resolved.missing },
            );
          }
          command = resolved.text;
          const output = input.output ?? "";
          if (
            typeof output !== "string" ||
            Buffer.byteLength(output) > MAX_OUTPUT_BYTES
          ) {
            throw new InputError(
              `output must be text of at most ${MAX_OUTPUT_BYTES / 1024} KB`,
            );
          }
          // Done on a step with checks needs the output they read (1.4.1),
          // as a terminal run's Mark done does. Failed needs nothing.
          if (
            outcome === "done" &&
            step.checks.length > 0 &&
            output.trim() === ""
          ) {
            throw new InputError(
              "paste at least one line of the output to mark the step done",
            );
          }
          // An outside step cannot capture or read secrets today; the order
          // is finishRun's anyway: find the secrets, then check the output
          // with them hidden (1.4.1).
          const found = findSecrets(step.secretCaptures, output);
          const hide: SecretText[] = Object.entries(found.values).map(
            ([name, value]) => ({ name, value }),
          );
          pasted = output === "" ? null : redact(output, hide);
          const captures = applyCaptures(step.captures, output);
          results =
            step.checks.length > 0
              ? checkHidden(
                  step.checks,
                  {
                    mode: "terminal",
                    exitCode: null,
                    stdout: null,
                    stderr: null,
                    pastedOutput: output,
                  },
                  captures.values,
                  hide,
                )
              : null;
          if ((results ?? []).some((check) => !check.ok)) final = "failed";
          if (final === "done") {
            captured = Object.fromEntries(
              Object.entries(captures.values).map(([name, value]) => [
                name,
                redact(value, hide),
              ]),
            );
          }
        }
        const at = now();
        await events.around(step.runbookId, actor(), async () => {
          await store.insertRun({
            stepId: step.id,
            runbookId: step.runbookId,
            mode: outside ? "outside" : "manual",
            status: final,
            hostId: null,
            command,
            commandHash: "",
            userId: actor(),
            startedAt: at,
            finishedAt: at,
            exitCode: null,
            stdout: null,
            stderr: null,
            truncated: false,
            timedOut: false,
            pastedOutput: pasted,
            error: null,
            note: note.trim() === "" ? null : note,
            checks: results,
            captured,
          });
          await store.updateStep(step.id, {
            status: final,
            skipReason: null,
            endedAt: at,
          });
          await events.stepEnded(
            step,
            final,
            outcome === "done" ? "check" : "manual",
            actor(),
          );
          await store.touchRunbook(step.runbookId);
          await store.persist();
        });
        await audit(
          req,
          "runbooks_step_manual",
          step,
          `runbook ${step.runbookId} step ${stepLabel(step)} marked ${final} by hand${
            outside ? " (run outside Termix)" : ""
          }`,
          true,
        );
        return showRunbook(await bundleFor(step.runbookId));
      }),
    ),
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
      const { step, bundle } = await stepContext(idParam(req));
      // Skip the replacement instead: a replaced step already ended.
      if (step.status === "replaced") {
        throw replacedProblem(step, bundle.steps);
      }
      const reason = body(req).reason ?? "";
      if (typeof reason !== "string" || reason.length > LIMITS.ownerNote) {
        throw new InputError("reason must be short text");
      }
      await events.around(step.runbookId, actor(), async () => {
        await store.updateStep(step.id, {
          status: "skipped",
          skipReason: reason,
          endedAt: now(),
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
      });
      await audit(req, "runbooks_step_skip", step, reason.slice(0, 500), true);
      return showRunbook(await bundleFor(step.runbookId));
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/steps/{id}/reopen:
   *   post:
   *     summary: Put a step back to pending; its runs are kept
   *     description: >
   *       A replaced step (1.4.0) reopens only when its replacement was
   *       skipped and never ran; otherwise 409 with code replaced.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: A replaced step whose replacement is live }
   */
  router.post(
    "/steps/:id/reopen",
    ...act,
    wrap(async (req) => {
      const { step, bundle } = await stepContext(idParam(req));
      if (step.status === "replaced") {
        const by = amendmentView(step, bundle.steps).replacedBy;
        const replacement = by
          ? bundle.steps.find((other) => other.id === by.id)
          : undefined;
        const ran = Boolean(
          replacement && bundle.runsByStep.get(replacement.id)?.length,
        );
        if (replacement && (replacement.status !== "skipped" || ran)) {
          throw new InputError(
            `step ${stepLabel(step)} was replaced by ${by!.label}${
              ran
                ? ", which already ran"
                : "; skip it first to go back to this step"
            }`,
            409,
            { code: "replaced", replacedBy: by },
          );
        }
      }
      await events.around(step.runbookId, actor(), async () => {
        await store.updateStep(step.id, {
          status: "pending",
          skipReason: null,
          endedAt: null,
        });
        await store.touchRunbook(step.runbookId);
        await store.persist();
      });
      return showRunbook(await bundleFor(step.runbookId));
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
   * /plugin-api/runbooks/steps/{id}/send-to-agent:
   *   post:
   *     summary: Send a step to the runbook's agent, with an optional note
   *     description: >
   *       Body { note? } (up to 500 characters). Records a "sent" event,
   *       which the notification webhook always delivers. Needs agent
   *       notifications on and a runbook with an owner. A person only.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: Notifications are off, or the runbook has no owner }
   */
  router.post(
    "/steps/:id/send-to-agent",
    ...act,
    wrap(async (req) => {
      const { step, bundle } = await stepContext(idParam(req));
      const raw = body(req).note ?? "";
      if (typeof raw !== "string" || raw.length > MAX_SENT_NOTE) {
        throw new InputError(
          `note must be text of at most ${MAX_SENT_NOTE} characters`,
        );
      }
      if (!(await notify.enabled())) {
        throw new InputError(
          "agent notifications are off; an admin turns them on in the plugin's settings",
          409,
          { code: "notify-off" },
        );
      }
      if (!bundle.runbook.owner) {
        throw new InputError(
          "this runbook does not say which agent it belongs to",
          409,
          { code: "no-owner" },
        );
      }
      const note = raw.trim() ? raw : null;
      await events.record({
        runbook: bundle.runbook,
        stepId: step.id,
        type: "sent",
        note,
        by: actor(),
      });
      await store.persist();
      await audit(
        req,
        "runbooks_step_sent",
        step,
        `runbook ${step.runbookId} step ${stepLabel(step)} sent to the agent${
          note ? ", with a note" : ""
        }`,
        true,
      );
      return showRunbook(await bundleFor(step.runbookId));
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
      return showRunbook(await bundleFor(step.runbookId));
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
