/**
 * What every person route shares, made once in registerPersonRoutes: the
 * guards, the one set of steps being run (inFlight) and the one map of
 * secret deletes to retry (removeRetryAt), and the checks before a run.
 * Two of these would let a step run twice, so nothing else makes one.
 */

import type { Request } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { InputError } from "../core/errors.js";
import { runbookResource, stepResource } from "../core/audit.js";
import { idParam, refuseApiKey, requireSignedIn } from "../core/http.js";
import type { RunbookRow, RunRow, StepRow } from "./store/types.js";
import { now, type Store } from "./store/store.js";
import { loadBundle, personView, type RunbookBundle } from "./view.js";
import {
  blockingProblem,
  requireActionable,
  requireRevision,
  requireValues,
  staleProblem,
  waitProblem,
} from "./gates.js";
import { secretsPending } from "../secrets/secret-view.js";
import { NO_SECRETS, type Secrets } from "../secrets/secrets.js";
import { resolveStep, valuesObject } from "../values/effective.js";
import type { LiveRuns } from "../running/live.js";
import { stepStdin } from "../running/stdin.js";
import type { Events } from "../agents/events.js";
import { isSshHost } from "../../shared/hosts.js";
import { isOutsideStep, stepLabel } from "../../shared/steps.js";
import type { RepeatConflict, RunSummary } from "../../shared/api.js";

const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a failed delete of a closed runbook's secrets waits to retry. */
const REMOVE_RETRY_MS = 5 * 60 * 1000;
/** Why a step run outside Termix has no Run or Send (1.4.0). */
const OUTSIDE_STEP =
  "this step runs outside Termix: copy the command, run it there, then mark it Done or Failed with the output";

/** The id in the path; a bad one is "not found" here. */
export const pathId = (req: Request) => idParam(req, "not found");

export type PersonKit = ReturnType<typeof createPersonKit>;

export function createPersonKit(
  ctx: PluginContext,
  store: Store,
  live: LiveRuns,
  secrets: Secrets,
  events: Events,
  notify: { enabled: () => Promise<boolean> },
) {
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
    // Secret steps (1.4.2) need the service connected, not only there.
    const secretSteps = bundle.steps.some((step) => step.generate || step.ask);
    const readiness = secretSteps ? await secrets.readiness() : null;
    return personView(bundle, await hostNamer(), {
      secretsAvailable: secrets.available(),
      noSecrets: NO_SECRETS,
      notifyEnabled: await notify.enabled(),
      sent,
      ...(readiness
        ? {
            secretsReady: readiness.ready,
            secretsReason: readiness.reason,
            appSecrets: secrets.appSecrets(),
          }
        : {}),
      userId: actor(),
    });
  }

  /** A signed-in person: an acting user is set (core does this after login). */
  const signedIn = requireSignedIn(ctx, "sign in to Termix to use Runbooks");
  /** Not a core API key: approving a command takes a person in the UI. */
  const notApiKey = refuseApiKey(
    "a Termix API key cannot run, approve or change steps; use the Runbooks tab",
  );
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

  function runSummary(run: RunRow, sameStep: boolean): RunSummary {
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
    options: { agentChecked?: boolean } = {},
  ) {
    requireActionable(step, bundle, { agentOk: options.agentChecked });
    if (isOutsideStep(step)) {
      throw new InputError(OUTSIDE_STEP, 409, { code: "outside" });
    }
    if (step.hostId === null || step.command === null) {
      throw new InputError("this step has no command to run", 400);
    }
    const stdin = stepStdin(step, bundle.steps);
    const resolved = resolveStep(step, valuesObject(bundle.values), stdin);
    requireRevision(step, input);
    requireValues(resolved.missing);
    if (input.commandHash !== resolved.hash) throw staleProblem();
    // Before the questions about order and repeats: no answer to them makes
    // a remote desktop host run a shell command.
    const host = await sshHostFor(
      step.hostId,
      "you cannot connect to this host",
      "; Runbooks runs commands over SSH only",
    );
    if (input.outOfOrder !== true) {
      const blocking = blockingProblem(step, bundle.steps);
      if (blocking) throw blocking;
    }
    // The author asked to wait after the previous step ended.
    const wait = waitProblem(step, bundle, input.waitAnyway === true);
    if (wait.problem) throw wait.problem;
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
          {
            code: "repeat",
            repeat: runSummary(recent, Boolean(sameStep)),
          } satisfies RepeatConflict,
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
      skippedWait: wait.skippedSeconds,
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
      `runbook ${step.runbookId} step ${stepLabel(step)} started ${seconds} s before its wait was over`,
      true,
    );
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
      ...runbookResource(runbook),
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
      ...stepResource(step),
      details,
      success,
      errorMessage,
      request: req,
    });
  }

  return {
    ctx,
    store,
    live,
    secrets,
    events,
    notify,
    actor,
    use,
    act,
    tokensRole,
    claim,
    claimed,
    showRunbook,
    shownRun,
    sshHostFor,
    bundleFor,
    stepContext,
    runSummary,
    checkRunnable,
    auditSkippedWait,
    removeSecrets,
    storedNote,
    audit,
  };
}
