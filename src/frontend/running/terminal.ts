/**
 * Finding a terminal session to type a step's command into, through the SSH
 * Terminal plugin's actions (terminal.listSessions, terminal.open).
 */

import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import { isSshHost } from "../../shared/hosts";
import type { Translate } from "../../shared/step-kinds";
import { hostLabel } from "../ui/format";
import type { Step, TerminalSession } from "../api-types";

/** How often the session list is read while a new terminal connects. */
export const OPEN_POLL_MS = 250;
/** How long a new terminal may take to connect. */
export const OPEN_TIMEOUT_MS = 30_000;
/**
 * The wait after a new terminal reports connected, so its shell prompt is up
 * before the command is typed.
 */
export const PROMPT_SETTLE_MS = 1000;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Host ids compared as numbers: the terminal and core may use strings. */
function sameHost(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || a === "") return false;
  if (b === null || b === undefined || b === "") return false;
  const left = Number(a);
  return Number.isFinite(left) && left === Number(b);
}

const usable = (session: TerminalSession) => session.connected !== false;

/**
 * A connected session on the host: a visible one first, then the most
 * recent (the terminal lists sessions oldest first).
 */
export function pickSession(
  sessions: TerminalSession[],
  hostId: unknown,
): TerminalSession | null {
  const mine = sessions.filter(
    (session) => sameHost(session.hostId, hostId) && usable(session),
  );
  return (
    [...mine].reverse().find((session) => session.visible) ??
    mine[mine.length - 1] ??
    null
  );
}

/**
 * The session a terminal.open made: new since `before`, on the host, and
 * connected. When no new session names the host but exactly one new session
 * appeared, that one is it.
 */
export function pickNewSession(
  sessions: TerminalSession[],
  before: ReadonlySet<string>,
  hostId: unknown,
): TerminalSession | null {
  const fresh = sessions.filter((session) => !before.has(session.id));
  const mine = fresh.filter((session) => sameHost(session.hostId, hostId));
  const candidates = mine.length > 0 ? mine : fresh.length === 1 ? fresh : [];
  return candidates.filter(usable).pop() ?? null;
}

/**
 * Reads the session list until the new session is connected, or null after
 * the timeout.
 */
async function waitForNewSession(
  list: () => Promise<TerminalSession[]>,
  before: ReadonlySet<string>,
  hostId: unknown,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<TerminalSession | null> {
  const pollMs = options.pollMs ?? OPEN_POLL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? OPEN_TIMEOUT_MS);
  for (;;) {
    const found = pickNewSession(await list(), before, hostId);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/** The terminal sessions, or null when no terminal plugin answers. */
export async function listSessions(
  app: TermixApp,
): Promise<TerminalSession[] | null> {
  try {
    const sessions = await app.invokeAction("terminal.listSessions");
    return Array.isArray(sessions) ? (sessions as TerminalSession[]) : null;
  } catch {
    return null;
  }
}

/**
 * A connected terminal to the step's host: one that is open already, else
 * a new one, once its prompt is up. Null after it told the person why
 * there is none (no terminal plugin, no such host, not SSH, or it did not
 * open or connect in time).
 */
export async function openSessionFor(
  app: TermixApp,
  step: Pick<Step, "hostId" | "hostName">,
  t: Translate,
): Promise<TerminalSession | null> {
  const host = hostLabel(t, step);
  const sessions = await listSessions(app);
  if (!sessions) {
    toast.error(t("terminal.missing"));
    return null;
  }
  const open = pickSession(sessions, step.hostId);
  if (open) return open;
  const record =
    app.getHost(step.hostId!) ??
    (await app.listHosts().catch(() => [])).find((h) =>
      sameHost(h.id, step.hostId),
    );
  if (!record) {
    toast.error(t("terminal.noHost"));
    return null;
  }
  if (!isSshHost(record)) {
    toast.error(t("terminal.notSsh", { host }));
    return null;
  }
  const before = new Set(sessions.map((s) => s.id));
  const waiting = toast.loading(t("terminal.opening", { host }));
  try {
    await app.invokeAction("terminal.open", record);
  } catch {
    toast.error(t("terminal.openFailed"), { id: waiting });
    return null;
  }
  const session = await waitForNewSession(
    async () => (await listSessions(app)) ?? [],
    before,
    step.hostId,
  );
  if (!session) {
    toast.error(t("terminal.timeout", { host }), { id: waiting });
    return null;
  }
  await sleep(PROMPT_SETTLE_MS);
  toast.dismiss(waiting);
  return session;
}
