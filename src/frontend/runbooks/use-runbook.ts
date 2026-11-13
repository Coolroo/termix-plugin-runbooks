/**
 * One runbook's data, read again every few seconds, and the one way the
 * page sends a request about it: the busy flag, the error toast, a POST
 * that shows the answer, and the questions a refused request asks.
 */

import { useCallback, useRef, useState } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import { usePolling } from "../ui/timers";
import {
  errorBody,
  errorMessage,
  parseConflict,
  type ConflictBody,
  type Runbook,
} from "../api-types";

export const POLL_MS = 5000;
/** While a command of the open runbook runs, its output is read this often. */
const LIVE_POLL_MS = 1000;

/** Flags that send a refused request again, past a question. */
export type Flags = Record<string, boolean>;

/** The 409 answers the person is asked about; a stale step is not. */
export type AskedConflict = Exclude<ConflictBody, { code: "stale" }>;

/** The flag that sends a request again past each question. */
const PAST_FLAG: Record<AskedConflict["code"], string> = {
  repeat: "confirmRepeat",
  wait: "waitAnyway",
  order: "outOfOrder",
};

/** What the hooks of one runbook view share: made once, in useRunbook. */
export type RunbookKit = ReturnType<typeof useRunbook>;

export function useRunbook(
  id: number,
  isVisible: boolean,
  /** The runbook does not exist or this person may not see it. */
  onMissing: () => void,
) {
  const { t } = useTranslation();
  const api = usePluginApi();
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

  // Agents edit runbooks while the person reads them, and a running
  // command's output is read every second.
  usePolling(load, {
    active: isVisible,
    intervalMs: anyRunning ? LIVE_POLL_MS : POLL_MS,
    skip: () => busyRef.current,
  });

  /** Runs `fn` with the buttons disabled and the polling paused. */
  const withBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
    busyRef.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const fail = (error: unknown) =>
    toast.error(errorMessage(error, t("error.generic")));

  /** A POST, with a body only when there is one. */
  const post = <T>(path: string, body?: unknown) =>
    body === undefined ? api.post<T>(path) : api.post<T>(path, body);

  /** Posts to `path` and shows the runbook the server answers. */
  const postAndShow = async (
    path: string,
    body?: unknown,
    onOk?: () => void,
  ) => {
    try {
      const { data } = await post<Runbook>(path, body);
      setRunbook(data);
      onOk?.();
    } catch (error) {
      fail(error);
    }
  };

  /** postAndShow, with the buttons waiting until it is done. */
  const postRunbook = (path: string, body?: unknown, onOk?: () => void) =>
    void withBusy(() => postAndShow(path, body, onOk));

  /**
   * Posts to `path`, hands the answer to `onOk`, then reads the runbook
   * again, refused or not.
   */
  const postThenLoad = async <T>(
    path: string,
    body?: unknown,
    onOk?: (answer: T) => void,
  ) => {
    try {
      const { data } = await post<T>(path, body);
      onOk?.(data);
    } catch (error) {
      fail(error);
    }
    await load();
  };

  /**
   * Sends `request` and walks the person through what the server refuses:
   * `question` asks about a repeat, a wait or the order (null: nothing to
   * ask), and the request goes again with its flag only on an explicit
   * yes. A step that changed says so and reads the runbook again. Anything
   * else shows the server's words, then `refused`. Resolves the answer, or
   * null when it did not go through.
   */
  const sendAsking = async <T>(
    request: (flags: Flags) => Promise<T>,
    ask: {
      question: (conflict: AskedConflict) => Promise<boolean> | null;
      refused?: (error: unknown) => Promise<void>;
    },
    flags: Flags = {},
  ): Promise<T | null> => {
    try {
      return await request(flags);
    } catch (error) {
      const conflict = parseConflict(error);
      if (conflict?.code === "stale") {
        toast.error(t("error.stale"));
        await load();
        return null;
      }
      const question = conflict ? ask.question(conflict) : null;
      if (conflict && question) {
        return (await question)
          ? sendAsking(request, ask, {
              ...flags,
              [PAST_FLAG[conflict.code]]: true,
            })
          : null;
      }
      fail(error);
      await ask.refused?.(error);
      return null;
    }
  };

  return {
    runbook,
    setRunbook,
    failed,
    busy,
    watched,
    load,
    withBusy,
    postAndShow,
    postRunbook,
    postThenLoad,
    sendAsking,
  };
}
