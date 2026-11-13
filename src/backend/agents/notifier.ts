/**
 * Agent notifications (1.4.0, off by default): each event a runbook's
 * `notify` lists, and every "sent", is POSTed once to the admin's https
 * webhook, signed with an HMAC of a secret only the admin saw.
 *
 * The body holds ids and labels only: never output, a command, or the text
 * of a note. A receiver reads details through the agent API.
 *
 * Delivery runs without an acting user and reads only the plugin's own
 * settings and tables. Requests go through ctx.fetch (core's SSRF guard),
 * with the webhook's host as the one private host allowed, the admin's CA
 * when set, no redirects and a 10 s limit. Certificates are always checked.
 */

import crypto from "node:crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { EventRow } from "../runbooks/store/types.js";
import { now, type Store } from "../runbooks/store/store.js";
import { openPath } from "../runbooks/view.js";
import { stepLabel } from "../../shared/steps.js";
import type { StateStore } from "../core/state.js";

/** Minutes to wait after each failed attempt; then it is given up. */
const RETRY_MINUTES = [1, 5, 30, 120];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
/** How often due deliveries are looked for. */
const TICK_MS = 30_000;
/** Deliveries tried in one go. */
const BATCH = 20;
const MAX_ERROR = 200;

export const SETTINGS = {
  enabled: "notifyEnabled",
  url: "notifyUrl",
  caPem: "notifyCaPem",
} as const;
export const SIGNING_SECRET = "signing-secret";

/** Why a webhook address is refused, or null. https only. */
function urlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "Enter the receiver's https address";
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "This is not a valid address";
  }
  if (url.protocol !== "https:") return "The address must start with https://";
  if (url.username || url.password) {
    return "The address must not contain a user name or password";
  }
  if (url.hash) return "The address must not contain #";
  return null;
}

function caProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "The CA must be PEM text";
  if (!value.trim()) return null;
  if (!value.includes("-----BEGIN CERTIFICATE-----")) {
    return "Paste one or more PEM certificates (-----BEGIN CERTIFICATE-----)";
  }
  return null;
}

/** Field errors for a save of the admin settings. */
export function validateSettings(
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const url = values[SETTINGS.url];
  if (url !== undefined && url !== null && url !== "") {
    const problem = urlProblem(url);
    if (problem) errors[SETTINGS.url] = problem;
  } else if (values[SETTINGS.enabled] === true && SETTINGS.url in values) {
    errors[SETTINGS.url] = "Enter the receiver's https address";
  }
  const ca = caProblem(values[SETTINGS.caPem]);
  if (ca) errors[SETTINGS.caPem] = ca;
  return errors;
}

/** The host part of an https address, as ctx.fetch compares it. */
function hostOf(address: string): string {
  return new URL(address).hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** A new signing secret: 32 random bytes, base64url. */
export function newSigningSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * X-Runbooks-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<body>">, keyed with the secret's text.
 */
function signature(secret: string, body: string, t: number): string {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${mac}`;
}

export interface NotifyConfig {
  url: string;
  host: string;
  caPem: string | null;
  secret: string;
}

/** What the webhook gets. Ids and labels only. */
export interface Payload {
  id: number;
  type: string;
  reason?: string;
  runbookId: number | null;
  stepId: number | null;
  stepPosition?: number;
  /** "3a" for an amendment (1.4.0), "3" otherwise. */
  stepLabel?: string;
  owner: { task: string | null; agent: string | null; label: string | null };
  openPath: string;
  at: string;
  hasNote?: true;
}

export type Notifier = ReturnType<typeof createNotifier>;

export function createNotifier(
  ctx: PluginContext,
  store: Store,
  state: StateStore,
) {
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;

  async function enabled(): Promise<boolean> {
    return (await ctx.settings.get<boolean>(SETTINGS.enabled)) === true;
  }

  /** The settings and secret, or what is missing. */
  async function config(): Promise<NotifyConfig | { problem: string }> {
    const url = await ctx.settings.get<string>(SETTINGS.url);
    const problem = urlProblem(url);
    if (problem) return { problem: `webhook address: ${problem}` };
    const caPem = (await ctx.settings.get<string>(SETTINGS.caPem)) ?? "";
    if (caProblem(caPem)) return { problem: "the CA is not PEM" };
    const secret = await state.get(SIGNING_SECRET);
    if (!secret) {
      return { problem: "no signing secret: make one in the settings" };
    }
    const trimmed = (url as string).trim();
    return {
      url: trimmed,
      host: hostOf(trimmed),
      caPem: caPem.trim() ? caPem : null,
      secret,
    };
  }

  async function payloadOf(event: EventRow): Promise<Payload> {
    const runbook = await store.getRunbook(event.runbookId);
    const step =
      event.stepId === null ? null : await store.getStep(event.stepId);
    const out: Payload = {
      id: event.id,
      type: event.type,
      ...(event.reason ? { reason: event.reason } : {}),
      runbookId: event.runbookId,
      stepId: event.stepId,
      ...(step
        ? { stepPosition: step.position, stepLabel: stepLabel(step) }
        : {}),
      owner: {
        task: runbook?.owner?.task ?? null,
        agent: runbook?.owner?.agent ?? null,
        label: runbook?.owner?.label ?? null,
      },
      openPath: openPath(event.runbookId),
      at: event.createdAt,
    };
    // The note itself is read through the agent API.
    if (event.note) out.hasNote = true;
    return out;
  }

  /** One POST. Answers the HTTP status; throws when there was none. */
  async function post(
    cfg: NotifyConfig,
    payload: Payload,
    eventId: string,
  ): Promise<number> {
    const body = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    const response = await ctx.fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runbooks-Event": eventId,
        "X-Runbooks-Signature": signature(cfg.secret, body, t),
      },
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
      redirect: "error",
      allowPrivateHosts: [cfg.host],
      ...(cfg.caPem ? { tls: { ca: cfg.caPem } } : {}),
    });
    // The answer's body is not read: only the status counts.
    await response.body?.cancel().catch(() => {});
    return response.status;
  }

  /**
   * A short reason. The address's query, which may carry a key, is left
   * out of it.
   */
  function shortError(error: unknown, cfg: NotifyConfig): string {
    const message = error instanceof Error ? error.message : String(error);
    const url = new URL(cfg.url);
    const shown = message.split(cfg.url).join(`${url.origin}${url.pathname}`);
    return `could not reach the receiver: ${shown}`.slice(0, MAX_ERROR);
  }

  async function failed(event: EventRow, error: string): Promise<void> {
    const attempts = event.attempts + 1;
    const wait = RETRY_MINUTES[attempts - 1];
    await store.updateEvent(event.id, {
      attempts,
      lastError: error.slice(0, MAX_ERROR),
      // After the last retry it is given up: nothing is due any more.
      nextAttemptAt:
        attempts >= MAX_ATTEMPTS || wait === undefined
          ? null
          : new Date(Date.now() + wait * 60_000).toISOString(),
    });
  }

  async function attempt(event: EventRow): Promise<void> {
    const cfg = await config();
    if ("problem" in cfg) {
      await failed(event, `not set up: ${cfg.problem}`);
      return;
    }
    let status: number;
    try {
      status = await post(cfg, await payloadOf(event), String(event.id));
    } catch (error) {
      await failed(event, shortError(error, cfg));
      return;
    }
    if (status >= 200 && status < 300) {
      await store.updateEvent(event.id, {
        attempts: event.attempts + 1,
        deliveredAt: now(),
        nextAttemptAt: null,
        lastError: null,
      });
    } else {
      await failed(event, `the receiver answered HTTP ${status}`);
    }
  }

  async function runDue(): Promise<void> {
    if (stopped || !(await enabled())) return;
    for (;;) {
      const due = await store.dueEvents(now(), BATCH);
      for (const event of due) {
        if (stopped) return;
        await attempt(event);
      }
      await store.persist(true);
      if (due.length < BATCH || stopped) return;
    }
  }

  /** Delivers what is due, one run at a time. */
  function deliverDue(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await runDue();
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    enabled,
    config,
    deliverDue,

    /** Tries what is due now, without waiting for it. */
    kick(): void {
      if (stopped) return;
      deliverDue().catch((error) =>
        ctx.log.error(
          "Runbooks could not deliver notifications",
          error instanceof Error ? error : undefined,
        ),
      );
    },

    /** Looks for due deliveries every TICK_MS; core clears it on stop. */
    start(): void {
      ctx.schedule.every(TICK_MS, () => deliverDue());
    },

    stop(): void {
      stopped = true;
    },

    /** Waits for a delivery in progress (tests, and a clean stop). */
    idle(): Promise<void> {
      return running ?? Promise.resolve();
    },

    /**
     * Sends a "test" event (id 0) with the saved settings and secret, even
     * while notifications are off, and says what the receiver answered.
     */
    async test(): Promise<{
      ok: boolean;
      status: number | null;
      error: string | null;
    }> {
      const cfg = await config();
      if ("problem" in cfg) {
        return { ok: false, status: null, error: `Not set up: ${cfg.problem}` };
      }
      const payload: Payload = {
        id: 0,
        type: "test",
        runbookId: null,
        stepId: null,
        owner: { task: null, agent: null, label: null },
        openPath: "/",
        at: now(),
      };
      try {
        const status = await post(cfg, payload, "0");
        return { ok: status >= 200 && status < 300, status, error: null };
      } catch (error) {
        return { ok: false, status: null, error: shortError(error, cfg) };
      }
    },
  };
}
