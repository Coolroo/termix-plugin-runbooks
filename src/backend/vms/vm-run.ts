/**
 * A VM step's run (1.4.7): HAW does the action as the person who pressed
 * the button, then the run reads the VM every 2 seconds until it reaches
 * the step's waitFor or the time is up (H4). While it waits, its live
 * output says each state the VM passes through; when it ends, its output is
 * the VM's details as JSON and one summary line, which the step's checks
 * and later when rules read, and the step's value prefix gets the state,
 * the address and the id.
 */

import type { Request } from "express";
import { InputError } from "../core/errors.js";
import { now } from "../runbooks/store/store.js";
import type { PersonKit } from "../runbooks/person-kit.js";
import type { StepRow } from "../runbooks/store/types.js";
import { valuesObject } from "../values/effective.js";
import { createRunner } from "../running/runner.js";
import { fillChecks } from "../../shared/checks.js";
import {
  VM_POLL_MS,
  vmOutput,
  vmSummary,
  vmValues,
  type Vm,
  type VmDetail,
  type VmSpec,
} from "../../shared/vms.js";
import { commandHash } from "../values/values.js";
import { stepLabel } from "../../shared/steps.js";
import { passing, type Haw } from "./haw.js";

/**
 * How long the waits are. Tests make them short; nothing else changes
 * them.
 */
export const vmTiming = { pollMs: VM_POLL_MS, secondMs: 1000 };

/** A step's reference in HAW's record: "runbook 12 step 3". */
export const vmRef = (step: StepRow) =>
  `runbook ${step.runbookId} step ${stepLabel(step)}`;

/** The run's identity for the repeat guard: this action on this VM. */
export function vmHash(spec: VmSpec): string {
  return commandHash(spec.host, `\0vm ${spec.action} ${spec.name}`);
}

/** What a VM run's command says, for the record. */
export function vmCommand(spec: VmSpec): string {
  return `${spec.action}${spec.force ? " (force)" : ""} ${spec.name}`;
}

const PRESENT: Record<VmSpec["action"], string> = {
  start: "Starting",
  stop: "Shutting down",
  restart: "Restarting",
  show: "Reading",
  console: "Opening the console of",
};

export function createVmRunner(kit: PersonKit, haw: Haw) {
  const { store, live, actor, audit } = kit;
  const { finishRun, madeSecretTexts } = createRunner(kit);

  /** Ends a VM run: done with the VM's output and values, or failed. */
  async function finish(
    runId: number,
    step: StepRow,
    spec: VmSpec,
    end:
      | { ok: true; vm: Vm | VmDetail }
      | {
          ok: false;
          error: string;
          vm: Vm | VmDetail | null;
          stopped?: boolean;
          interrupted?: boolean;
        },
    by: string,
  ) {
    const bundle = await kit.bundleFor(step.runbookId);
    const checks = fillChecks(step.checks, valuesObject(bundle.values)).checks;
    const hidden = await madeSecretTexts(step, bundle);
    await live.settle(runId);
    const output = end.vm ? vmOutput(end.vm) : null;
    if (!end.ok) {
      return finishRun(
        runId,
        step,
        "failed",
        output,
        { stdout: output ?? live.get(runId)?.stdout ?? "", error: end.error },
        {
          hidden,
          by,
          reason: end.stopped
            ? "stopped"
            : end.interrupted
              ? "interrupted"
              : "exit",
        },
      );
    }
    return finishRun(
      runId,
      step,
      "done",
      output,
      { stdout: output },
      {
        checks,
        checked: {
          mode: "terminal",
          exitCode: null,
          stdout: null,
          stderr: null,
          pastedOutput: output,
        },
        hidden,
        by,
        values: vmValues(spec, end.vm),
      },
    );
  }

  /** Waits `ms`, or less when the run is stopped. */
  function pause(ms: number, stopped: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (stopped() || Date.now() - started >= ms) resolve();
        else setTimeout(tick, Math.min(50, ms));
      };
      setTimeout(tick, Math.min(50, ms));
    });
  }

  /**
   * The action, then the wait, as the person. Started inside the request,
   * so it keeps acting as this person after the answer is sent.
   */
  async function drive(
    req: Request,
    runId: number,
    step: StepRow,
    spec: VmSpec,
    by: string,
    release: () => void,
  ): Promise<void> {
    const record = live.get(runId)!;
    let stopped = false;
    record.stop = () => {
      stopped = true;
    };
    const halted = () => stopped || Boolean(record.interrupted);
    const say = (line: string) => live.output(runId, "stdout", `${line}\n`);
    const ref = vmRef(step);
    let vm: Vm | VmDetail | null = null;
    let outcome = "";
    try {
      say(`${PRESENT[spec.action]} ${spec.name}…`);
      try {
        vm =
          spec.action === "show"
            ? await haw.show(spec.host, spec.name, ref)
            : await haw.power(
                spec.action as "start" | "stop" | "restart",
                spec.host,
                spec.name,
                spec.force,
                ref,
              );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        say(message);
        await finish(
          runId,
          step,
          spec,
          { ok: false, error: message, vm: null },
          by,
        );
        await audit(
          req,
          "runbooks_step_vm",
          step,
          `${ref}: ${vmCommand(spec)} refused`,
          false,
          message,
        );
        return;
      }
      say(vmSummary(vm));
      const target = spec.waitFor;
      const deadline = Date.now() + spec.waitSeconds * vmTiming.secondMs;
      let lastError: string | null = null;
      while (target && vm.state !== target && !halted()) {
        if (Date.now() >= deadline) break;
        await pause(
          Math.min(vmTiming.pollMs, Math.max(0, deadline - Date.now())),
          halted,
        );
        if (halted()) break;
        try {
          const read = await haw.show(spec.host, spec.name, ref);
          if (read.state !== vm.state) say(vmSummary(read));
          vm = read;
          lastError = null;
        } catch (error) {
          // The host may not answer for a moment while a VM starts.
          if (!passing(error)) throw error;
          const message = (error as Error).message;
          if (message !== lastError) say(message);
          lastError = message;
        }
      }
      if (halted()) {
        const error = stopped
          ? `stopped by ${record.stoppedBy ?? "a person"} while waiting for ${target}`
          : (record.interrupted ?? "interrupted");
        await finish(
          runId,
          step,
          spec,
          { ok: false, error, vm, stopped, interrupted: !stopped },
          by,
        );
        outcome = stopped ? "stopped" : "interrupted";
      } else if (target && vm.state !== target) {
        const error = `${spec.name} did not reach ${target} in ${spec.waitSeconds} s; its state is ${vm.state}${lastError ? ` (${lastError})` : ""}`;
        await finish(runId, step, spec, { ok: false, error, vm }, by);
        outcome = `waited ${spec.waitSeconds} s, state ${vm.state}`;
      } else {
        const result = await finish(runId, step, spec, { ok: true, vm }, by);
        outcome = `${vm.state}${result.final === "done" ? "" : ", checks failed"}`;
      }
      await audit(
        req,
        "runbooks_step_vm",
        step,
        `${ref}: ${vmCommand(spec)}: ${outcome}`,
        outcome === vm.state,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await finish(runId, step, spec, { ok: false, error: message, vm }, by);
        await audit(
          req,
          "runbooks_step_vm",
          step,
          `${ref}: ${vmCommand(spec)} failed`,
          false,
          message,
        );
      } catch (inner) {
        // Most likely the database went away because Termix is stopping;
        // the sweep on the next start finishes the run.
        kit.ctx.log.error(
          `run ${runId} could not be finished`,
          inner instanceof Error ? inner : undefined,
        );
      }
    } finally {
      live.remove(runId);
      release();
    }
  }

  return {
    /** Starts the action: a run in status running, ended by `drive`. */
    async start(
      req: Request,
      step: StepRow,
      spec: VmSpec,
      options: {
        hash: string;
        startedEarlySeconds: number | null;
        release: () => void;
      },
    ): Promise<number> {
      const startedAt = now();
      const runId = await store.insertRun({
        stepId: step.id,
        runbookId: step.runbookId,
        mode: "vm",
        status: "running",
        hostId: spec.host,
        command: vmCommand(spec),
        commandHash: options.hash,
        userId: actor(),
        startedAt,
        stdout: "",
        stderr: "",
        startedEarlySeconds: options.startedEarlySeconds,
      });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      const record = live.start({
        runId,
        stepId: step.id,
        runbookId: step.runbookId,
        startedAt,
      });
      record.done = drive(req, runId, step, spec, actor(), options.release);
      return runId;
    },

    /**
     * Asks HAW for the VM's console (recorded by HAW) and keeps a run that
     * waits for the person's Done or Failed. Refused when HAW has no Remote
     * Desktop host linked for the console: there is nothing to open.
     */
    async openConsole(
      req: Request,
      step: StepRow,
      spec: VmSpec,
      options: { hash: string; startedEarlySeconds: number | null },
    ) {
      const ref = vmRef(step);
      const answer = await haw.console(spec.host, spec.name, ref);
      if (!answer.consoleHost) {
        throw new InputError(
          `HAW has no Remote Desktop host linked to the console of ${spec.name}: link one in HAW's tab (Console), then open it again`,
          409,
          { code: "no-console-host" },
        );
      }
      const at = now();
      const runId = await store.insertRun({
        stepId: step.id,
        runbookId: step.runbookId,
        mode: "vm",
        status: "awaiting-output",
        hostId: spec.host,
        command: vmCommand(spec),
        commandHash: options.hash,
        userId: actor(),
        startedAt: at,
        stdout: `${JSON.stringify(answer, null, 2)}\nThe console of ${spec.name} opens in Remote Desktop on ${answer.consoleHost.name}\n`,
        startedEarlySeconds: options.startedEarlySeconds,
      });
      await store.touchRunbook(step.runbookId);
      await store.persist();
      await audit(
        req,
        "runbooks_step_vm",
        step,
        `${ref}: console opened on host ${answer.consoleHost.id}`,
        true,
      );
      return { runId, consoleHost: answer.consoleHost };
    },

    /** Done or Failed after the console: ends its run and the step. */
    async endConsole(
      step: StepRow,
      runId: number,
      outcome: "done" | "failed",
      note: string | null,
    ): Promise<void> {
      await finishRun(
        runId,
        step,
        outcome,
        null,
        { note },
        { by: actor(), reason: "manual" },
      );
    },
  };
}
