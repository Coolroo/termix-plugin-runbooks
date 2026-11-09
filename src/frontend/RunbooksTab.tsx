import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useDocsUrl,
  usePermission,
  usePluginApi,
  useShell,
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  Button,
  EmptyState,
  ListBadge,
  ListRow,
  PanelList,
  PanelShell,
  PanePrompt,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { isSshHost } from "../shared/hosts";
import { parseRunbookId } from "./deep-link";
import { Markdown } from "./Markdown";
import {
  ChecksList,
  checksWords,
  describeStdin,
  formatDuration,
  formatTime,
  StepCard,
  type StepActions,
} from "./StepCard";
import {
  pickSession,
  PROMPT_SETTLE_MS,
  sameHost,
  sleep,
  waitForNewSession,
} from "./terminal";
import { TokensView } from "./TokensView";
import {
  errorBody,
  type Run,
  type Runbook,
  type RunbookSummary,
  type Step,
  type TerminalSession,
} from "./types";

export const POLL_MS = 5000;
/** While a command of the open runbook runs, its output is read this often. */
export const LIVE_POLL_MS = 1000;

export function RunbooksIcon(props: { className?: string }) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  );
}

type View =
  { kind: "list" } | { kind: "runbook"; id: number } | { kind: "tokens" };

function CommandPreview({
  host,
  command,
  stdin,
}: {
  host: string;
  command: string;
  /** The step's input: where from, and the start of a step or value. */
  stdin?: { label: string; preview: string | null } | null;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span>{host}</span>
      <pre className="max-h-60 overflow-auto border border-border bg-muted/40 p-2 font-mono whitespace-pre-wrap break-all">
        {command}
      </pre>
      {stdin && (
        <>
          <span data-confirm-stdin>{stdin.label}</span>
          {stdin.preview !== null && (
            <pre
              data-confirm-stdin-preview
              className="max-h-40 overflow-auto border border-border bg-muted/40 p-2 font-mono whitespace-pre-wrap break-all"
            >
              {stdin.preview}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

interface EarlyRequest {
  title: string;
  details: ReactNode;
  resolve: (ok: boolean) => void;
}

/**
 * "The wait is not over": Cancel is focused, so Enter cancels, and Start
 * anyway is a warning. Esc cancels too.
 */
function EarlyStartPrompt({ request }: { request: EarlyRequest }) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const resolveRef = useRef(request.resolve);
  resolveRef.current = request.resolve;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      resolveRef.current(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);
  return (
    <PanePrompt
      open
      role="alertdialog"
      title={request.title}
      description={request.details}
      onCancel={() => request.resolve(false)}
      className="border-warning/60"
      actions={
        <>
          <button
            ref={cancelRef}
            type="button"
            data-early-cancel
            onClick={() => request.resolve(false)}
            className="inline-flex h-7 items-center justify-center border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-early-start
            onClick={() => request.resolve(true)}
            className="inline-flex h-7 items-center justify-center border border-warning/60 bg-warning/15 px-3 text-xs font-medium text-warning transition-colors hover:bg-warning/25 focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("wait.anyway")}
          </button>
        </>
      }
    />
  );
}

function RunbookList({
  onOpen,
  isVisible,
}: {
  onOpen: (id: number) => void;
  isVisible: boolean;
}) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const [rows, setRows] = useState<RunbookSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<RunbookSummary[]>("/runbooks");
      setRows(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (!isVisible) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, load]);

  if (failed && !rows) {
    return <p className="p-4 text-sm text-destructive">{t("error.load")}</p>;
  }
  if (!rows) return null;
  return (
    <PanelList
      empty={<EmptyState title={t("list.empty")} hint={t("list.emptyHint")} />}
    >
      {rows.map((row) => (
        <ListRow
          key={row.id}
          title={row.title}
          dimmed={row.status !== "open"}
          onClick={() => onOpen(row.id)}
          badges={
            <>
              <ListBadge tone={row.status === "open" ? "brand" : "muted"}>
                {t(`runbook.status.${row.status}`)}
              </ListBadge>
              {row.progress.failed > 0 && (
                <ListBadge tone="destructive">
                  {t("list.failed", { count: row.progress.failed })}
                </ListBadge>
              )}
            </>
          }
          meta={t("list.meta", {
            done: row.progress.done,
            total: row.progress.total,
            author: row.createdBy,
            time: formatTime(row.updatedAt),
          })}
        />
      ))}
    </PanelList>
  );
}

function RunbookDetail({
  app,
  id,
  isVisible,
  onMissing,
}: {
  app: TermixApp;
  id: number;
  isVisible: boolean;
  /** The runbook does not exist or this person may not see it. */
  onMissing: () => void;
}) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  const [runbook, setRunbook] = useState<Runbook | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;
  /** Runs this person started here, to say how they ended. */
  const watched = useRef(new Set<number>());

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<Runbook>(`/runbooks/${id}`);
      setRunbook(data);
      setFailed(false);
      for (const step of data.steps ?? []) {
        for (const run of step.runs) {
          if (!watched.current.has(run.id) || run.running) continue;
          watched.current.delete(run.id);
          if (run.status === "done") toast.success(t("run.ok"));
          else toast.error(t("run.notOk"));
        }
      }
    } catch (error) {
      const { status } = errorBody(error);
      if (status === 404 || status === 403) {
        onMissingRef.current();
        return;
      }
      setFailed(true);
    }
  }, [api, id, t]);

  const anyRunning = Boolean(
    runbook?.steps.some((step) => step.runs.some((run) => run.running)),
  );

  useEffect(() => {
    if (!isVisible) return;
    void load();
    // Agents edit runbooks while the person reads them, and a running
    // command's output is read every second.
    const timer = window.setInterval(
      () => {
        if (!busyRef.current) void load();
      },
      anyRunning ? LIVE_POLL_MS : POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [isVisible, load, anyRunning]);

  const withBusy = async <T,>(fn: () => Promise<T>): Promise<T> => {
    busyRef.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const fail = (error: unknown) => {
    const { data } = errorBody(error);
    toast.error(
      typeof data.error === "string" ? data.error : t("error.generic"),
    );
  };

  const hostLabel = (step: Step) =>
    step.hostName ?? t("step.unknownHost", { id: step.hostId });

  /** The host, the command, its input, checks and secrets, for a confirm. */
  const runDetails = (step: Step) => (
    <div className="flex flex-col gap-2">
      <CommandPreview
        host={hostLabel(step)}
        command={step.resolvedCommand ?? ""}
        stdin={stdinPreview(step)}
      />
      <ChecksList checks={step.checks ?? []} words={checksWords(t)} />
      {(step.secretCaptures ?? []).length > 0 && (
        <span className="text-xs" data-confirm-secrets>
          {t("secrets.confirm", {
            names: (step.secretCaptures ?? [])
              .map((capture) => capture.name)
              .join(", "),
          })}
        </span>
      )}
    </div>
  );

  /** The open early-start question, if any. */
  const [early, setEarly] = useState<EarlyRequest | null>(null);

  /**
   * Asks before a start while the step's wait timer runs: one question,
   * Cancel first. Resolves true for Start anyway.
   */
  const askEarly = (
    step: Step,
    leftMs: number,
    withDetails: boolean,
    reason: string = step.wait?.reason ?? "",
  ) =>
    new Promise<boolean>((resolve) => {
      const time = formatDuration(Math.ceil(leftMs / 1000) * 1000);
      setEarly({
        title: t(reason ? "wait.earlyReason" : "wait.early", { time, reason }),
        details: withDetails ? (
          runDetails(step)
        ) : (
          <CommandPreview
            host={hostLabel(step)}
            command={step.resolvedCommand ?? ""}
          />
        ),
        resolve: (ok) => {
          setEarly(null);
          resolve(ok);
        },
      });
    });

  /** What a confirm says of the step's input, if it has one. */
  const stdinPreview = (step: Step) =>
    step.stdin
      ? {
          label:
            t("stdin.label", {
              source: describeStdin(t, step.stdin.source, step.stdin.bytes),
            }) +
            // Whoever wrote the command decides what happens to the secret.
            (step.stdin.source.from === "secret"
              ? ` ${t("stdin.secretWarning")}`
              : ""),
          preview: step.stdin.preview,
        }
      : null;

  // The shell, kept in a ref: a send outlives the render that started it.
  const shell = useShell();
  const shellRef = useRef(shell);
  shellRef.current = shell;

  /** The terminal sessions, or null when no terminal plugin answers. */
  const listSessions = async (): Promise<TerminalSession[] | null> => {
    try {
      const sessions = await app.invokeAction("terminal.listSessions");
      return Array.isArray(sessions) ? (sessions as TerminalSession[]) : null;
    } catch {
      return null;
    }
  };

  /** Brings a terminal tab to the front, or its split when it sits in one. */
  const showTab = (tabId: string) => {
    const tabs = shellRef.current?.tabs;
    const tab = tabs?.list.find((entry) => entry.id === tabId);
    if (!tabs || !tab) return;
    try {
      tabs.setActive(tab.parentSplitTabId ?? tab.id);
    } catch {
      // The command is typed already; the tab just stays where it is.
    }
  };

  /**
   * Posts a run or a send, and walks the person through what the server
   * refuses: a repeat or an order problem is asked about and sent again only
   * on an explicit yes.
   */
  const attempt = async (
    mode: "run" | "terminal",
    step: Step,
    flags: Record<string, boolean> = {},
  ): Promise<Run | null> => {
    try {
      const { data } = await api.post<Run>(`/steps/${step.id}/${mode}`, {
        revision: step.revision,
        commandHash: step.commandHash,
        ...flags,
      });
      return data;
    } catch (error) {
      const { status, data } = errorBody(error);
      if (status === 409 && data.code === "repeat") {
        const repeat = data.repeat as {
          userId: string;
          startedAt: string;
          exitCode: number | null;
          sameStep: boolean;
          runbookId: number;
        };
        const again = await confirm({
          title: t(repeat.sameStep ? "repeat.titleStep" : "repeat.titleHash"),
          description: (
            <div className="flex flex-col gap-2 text-xs">
              <span>
                {t("repeat.last", {
                  user: repeat.userId,
                  time: formatTime(repeat.startedAt),
                  exit: repeat.exitCode ?? "-",
                })}
              </span>
              <CommandPreview
                host={hostLabel(step)}
                command={step.resolvedCommand ?? ""}
              />
            </div>
          ),
          confirmLabel: t("repeat.again"),
          destructive: false,
        });
        return again
          ? attempt(mode, step, { ...flags, confirmRepeat: true })
          : null;
      }
      if (status === 409 && data.code === "wait") {
        const seconds = Number(data.remainingSeconds) || 0;
        const reason = typeof data.reason === "string" ? data.reason : "";
        const anyway = await askEarly(
          step,
          seconds * 1000,
          mode === "run",
          reason,
        );
        return anyway
          ? attempt(mode, step, { ...flags, waitAnyway: true })
          : null;
      }
      if (status === 409 && data.code === "order") {
        const blocking =
          (data.blocking as Array<{ position: number; title: string }>) ?? [];
        const anyway = await confirm({
          title: t("order.title"),
          description: t("order.hint", {
            steps: blocking.map((b) => `${b.position}. ${b.title}`).join(", "),
          }),
          confirmLabel: t("order.anyway"),
          destructive: false,
        });
        return anyway
          ? attempt(mode, step, { ...flags, outOfOrder: true })
          : null;
      }
      if (status === 409 && data.code === "stale") {
        toast.error(t("error.stale"));
        await load();
        return null;
      }
      fail(error);
      return null;
    }
  };

  const actions: StepActions = {
    run: (step, waitLeftMs = 0) =>
      void withBusy(async () => {
        // Early on a wait timer: one question, and it is about the wait.
        let flags: Record<string, boolean> = {};
        if (waitLeftMs > 0) {
          if (!(await askEarly(step, waitLeftMs, true))) return;
          flags = { waitAnyway: true };
        } else {
          const ok = await confirm({
            title: t("run.confirmTitle", { position: step.position }),
            description: runDetails(step),
            confirmLabel: t("run.confirm"),
            destructive: false,
          });
          if (!ok) return;
        }
        const run = await attempt("run", step, flags);
        if (run) {
          if (run.running || run.status === "running") {
            watched.current.add(run.id);
          } else if (run.status === "done") toast.success(t("run.ok"));
          else toast.error(t("run.notOk"));
        }
        await load();
      }),

    stop: (step) =>
      void withBusy(async () => {
        const ok = await confirm({
          title: t("stop.title", { position: step.position }),
          description: t("stop.hint"),
          confirmLabel: t("stop.confirm"),
          destructive: true,
        });
        if (!ok) return;
        try {
          await api.post(`/steps/${step.id}/stop`);
        } catch (error) {
          fail(error);
        }
        await load();
      }),

    // One click: find or open a terminal to the step's host, then type the
    // command there without pressing Enter. The run is recorded only once a
    // terminal is ready, so a terminal that never connects leaves no run
    // waiting for output.
    send: (step, waitLeftMs = 0) =>
      void withBusy(async () => {
        let flags: Record<string, boolean> = {};
        if (waitLeftMs > 0) {
          if (!(await askEarly(step, waitLeftMs, false))) return;
          flags = { waitAnyway: true };
        }
        const host = hostLabel(step);
        const sessions = await listSessions();
        if (!sessions) {
          toast.error(t("terminal.missing"));
          return;
        }
        let session = pickSession(sessions, step.hostId);
        if (!session) {
          const record =
            app.getHost(step.hostId!) ??
            (await app.listHosts().catch(() => [])).find((h) =>
              sameHost(h.id, step.hostId),
            );
          if (!record) {
            toast.error(t("terminal.noHost"));
            return;
          }
          if (!isSshHost(record)) {
            toast.error(t("terminal.notSsh", { host }));
            return;
          }
          const before = new Set(sessions.map((s) => s.id));
          const waiting = toast.loading(t("terminal.opening", { host }));
          try {
            await app.invokeAction("terminal.open", record);
          } catch {
            toast.error(t("terminal.openFailed"), { id: waiting });
            return;
          }
          session = await waitForNewSession(
            async () => (await listSessions()) ?? [],
            before,
            step.hostId,
          );
          if (!session) {
            toast.error(t("terminal.timeout", { host }), { id: waiting });
            return;
          }
          await sleep(PROMPT_SETTLE_MS);
          toast.dismiss(waiting);
        }
        const run = await attempt("terminal", step, flags);
        if (!run) return;
        let sent = false;
        try {
          sent =
            (await app.invokeAction(
              "terminal.sendToSession",
              session.id,
              run.command,
              { run: false },
            )) === true;
        } catch {
          sent = false;
        }
        if (sent) {
          showTab(session.id);
          toast.success(t("terminal.sent", { host }));
        } else {
          toast.error(t("terminal.sendFailed"));
        }
        await load();
      }),

    skip: (step, reason) =>
      void withBusy(async () => {
        try {
          const { data } = await api.post<Runbook>(`/steps/${step.id}/skip`, {
            reason,
          });
          setRunbook(data);
        } catch (error) {
          fail(error);
        }
      }),

    manual: (step, outcome, note) =>
      void withBusy(async () => {
        try {
          const { data } = await api.post<Runbook>(`/steps/${step.id}/manual`, {
            outcome,
            note,
          });
          setRunbook(data);
        } catch (error) {
          fail(error);
        }
      }),

    reopen: (step) =>
      void withBusy(async () => {
        try {
          const { data } = await api.post<Runbook>(`/steps/${step.id}/reopen`);
          setRunbook(data);
        } catch (error) {
          fail(error);
        }
      }),

    saveNote: (step, note) =>
      void (async () => {
        try {
          await api.post(`/steps/${step.id}/note`, { ownerNote: note });
          await load();
        } catch (error) {
          fail(error);
        }
      })(),

    setHidden: (step, hidden) =>
      void withBusy(async () => {
        try {
          const { data } = await api.post<Runbook>(`/steps/${step.id}/hide`, {
            hidden,
          });
          setRunbook(data);
        } catch (error) {
          fail(error);
        }
      }),

    complete: (run, pasted, outcome, exitCode) =>
      void withBusy(async () => {
        try {
          const { data } = await api.post<Run>(`/runs/${run.id}/complete`, {
            pastedOutput: pasted,
            outcome,
            ...(exitCode !== null ? { exitCode } : {}),
          });
          if (outcome === "done" && data?.status === "failed") {
            toast.error(t("checks.failedToast"));
          }
          await load();
        } catch (error) {
          fail(error);
        }
      }),
  };

  const setStatus = (status: Runbook["status"]) =>
    void withBusy(async () => {
      try {
        const { data } = await api.post<Runbook>(`/runbooks/${id}/status`, {
          status,
        });
        setRunbook(data);
      } catch (error) {
        fail(error);
      }
    });

  if (failed && !runbook) {
    return <p className="p-4 text-sm text-destructive">{t("error.load")}</p>;
  }
  if (!runbook) return null;
  const open = runbook.status === "open";

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{runbook.title}</h2>
        <ListBadge tone={open ? "brand" : "muted"}>
          {t(`runbook.status.${runbook.status}`)}
        </ListBadge>
        <span className="text-xs text-muted-foreground">
          {t("list.meta", {
            done: runbook.progress.done,
            total: runbook.progress.total,
            author: runbook.createdBy,
            time: formatTime(runbook.updatedAt),
          })}
        </span>
        <span className="ml-auto flex gap-2">
          {open ? (
            <>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setStatus("done")}
              >
                {t("runbook.markDone")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setStatus("abandoned")}
              >
                {t("runbook.abandon")}
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setStatus("open")}
            >
              {t("runbook.reopen")}
            </Button>
          )}
        </span>
      </div>

      {runbook.owner && (
        <p className="-mt-2 text-xs text-muted-foreground" data-runbook-owner>
          {runbook.owner.task
            ? t("runbook.agentTask", {
                label: runbook.agentLabel ?? runbook.createdBy,
                task: runbook.owner.task,
              })
            : t("runbook.agent", {
                label: runbook.agentLabel ?? runbook.createdBy,
              })}
        </p>
      )}

      {early && <EarlyStartPrompt request={early} />}

      <Markdown source={runbook.summary} />

      {runbook.effectiveValues.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("values.title")}
          </div>
          <table className="mt-1 w-full border-collapse text-xs">
            <tbody>
              {runbook.effectiveValues.map((value) => (
                <tr key={value.name} className="border-t border-border">
                  <td className="py-1 pr-2 font-mono">{value.name}</td>
                  <td className="py-1 pr-2 font-mono break-all">
                    {value.value}
                  </td>
                  <td className="py-1 text-muted-foreground">
                    {value.source === "author"
                      ? t("values.author")
                      : t("values.captured", {
                          position:
                            runbook.steps.find((s) => s.id === value.stepId)
                              ?.position ?? "?",
                        })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {runbook.steps.length === 0 && (
        <EmptyState title={t("runbook.noSteps")} />
      )}
      <div className="flex flex-col gap-3">
        {runbook.steps.map((step) => (
          <StepCard
            key={step.id}
            step={step}
            isNext={step.id === runbook.nextStepId}
            runbookOpen={open}
            busy={busy}
            actions={actions}
            secrets={(runbook.secrets ?? []).filter(
              (secret) => secret.step === step.position,
            )}
            agentLabel={runbook.agentLabel ?? runbook.createdBy}
          />
        ))}
      </div>
    </div>
  );
}

/** Runbook links the tab has acted on, as "<id>:<requestedAt>". */
const openedLinks = new Set<string>();

export function createRunbooksTab(app: TermixApp) {
  return function RunbooksTab({ isVisible, tab }: TabProps) {
    const { t } = useTranslation();
    const canManageTokens = usePermission("manage-tokens");
    const docs = useDocsUrl();
    const [view, setView] = useState<View>({ kind: "list" });

    // A runbook link opens the tab with { runbookId, requestedAt } as its
    // data; requestedAt tells a second link to the same runbook apart.
    const linked = parseRunbookId(tab?.data?.runbookId);
    const requestedAt = tab?.data?.requestedAt;
    useEffect(() => {
      if (linked === null) return;
      // Once per link, so a tab that mounts again stays where the person is.
      const request = `${linked}:${String(requestedAt)}`;
      if (openedLinks.has(request)) return;
      openedLinks.add(request);
      setView({ kind: "runbook", id: linked });
    }, [linked, requestedAt]);

    let body: ReactNode;
    let leading: ReactNode = null;
    if (view.kind === "runbook") {
      const id = view.id;
      body = (
        <RunbookDetail
          key={id}
          app={app}
          id={id}
          isVisible={isVisible}
          onMissing={() => {
            toast.error(t("link.notFound", { id }));
            setView({ kind: "list" });
          }}
        />
      );
      leading = <BackButton onClick={() => setView({ kind: "list" })} />;
    } else if (view.kind === "tokens") {
      body = (
        <TokensView baseUrl={`${window.location.origin}/plugin-api/runbooks`} />
      );
      leading = <BackButton onClick={() => setView({ kind: "list" })} />;
    } else {
      body = (
        <RunbookList
          isVisible={isVisible}
          onOpen={(id) => setView({ kind: "runbook", id })}
        />
      );
    }

    return (
      <PanelShell
        icon={<RunbooksIcon className="size-4" />}
        title={view.kind === "tokens" ? t("tokens.title") : t("tab.title")}
        leading={leading}
        docs={docs ?? undefined}
        scroll
        actions={
          canManageTokens && view.kind === "list" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setView({ kind: "tokens" })}
            >
              {t("tokens.title")}
            </Button>
          ) : null
        }
      >
        {body}
      </PanelShell>
    );
  };
}
