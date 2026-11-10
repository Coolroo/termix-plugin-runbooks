import { useCallback, useEffect, useState } from "react";
import {
  useCurrentUser,
  usePluginApi,
  useTranslation,
  type SettingsComponentProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, useConfirm } from "@termix-ssh/plugin-sdk/ui";
import { formatTime } from "./StepCard";
import { errorBody } from "./types";

/** What GET /admin/notify answers. Never the secret. */
export interface NotifyStatus {
  enabled: boolean;
  url: string;
  problem: string | null;
  secret: { set: boolean; madeAt: string | null; madeBy: string | null };
}

interface TestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/**
 * The admin's signing secret section in the plugin's settings: when it was
 * made and by whom, Make a new signing secret (shown once, like a token),
 * and Test, which sends a test event with the saved settings.
 */
export function NotifySetting({ running }: SettingsComponentProps) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const me = useCurrentUser();
  const confirm = useConfirm();
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<NotifyStatus>("/admin/notify");
      setStatus(data);
      setError(null);
    } catch (failure) {
      const { data } = errorBody(failure);
      setError(typeof data.error === "string" ? data.error : t("notify.error"));
    }
  }, [api, t]);

  useEffect(() => {
    if (running) void load();
  }, [load, running]);

  async function make() {
    if (status?.secret.set) {
      const ok = await confirm({
        title: t("notify.replaceTitle"),
        description: t("notify.replaceHint"),
        confirmLabel: t("notify.replace"),
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const { data } = await api.post<{ secret: string }>(
        "/admin/notify/secret",
      );
      setShown(data.secret);
      await load();
    } catch (failure) {
      const { data } = errorBody(failure);
      setError(typeof data.error === "string" ? data.error : t("notify.error"));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setTest(null);
    try {
      const { data } = await api.post<TestResult>("/admin/notify/test");
      setTest(data);
    } catch (failure) {
      const { data } = errorBody(failure);
      setTest({
        ok: false,
        status: null,
        error: typeof data.error === "string" ? data.error : t("notify.error"),
      });
    } finally {
      setBusy(false);
    }
  }

  const who = !status?.secret.madeBy
    ? ""
    : status.secret.madeBy === me?.userId
      ? (me?.username ?? status.secret.madeBy)
      : status.secret.madeBy;

  return (
    <div className="flex flex-col gap-3 py-3" data-notify-setting>
      <div>
        <div className="text-sm font-medium">{t("notify.title")}</div>
        <p className="text-xs text-muted-foreground">
          {t("notify.description")}
        </p>
      </div>
      {!running ? (
        <p className="text-xs text-muted-foreground">
          {t("notify.notRunning")}
        </p>
      ) : (
        <>
          {status && (
            <p className="text-xs" data-notify-secret={status.secret.set}>
              {status.secret.set
                ? t("notify.set", {
                    time: formatTime(status.secret.madeAt),
                    who,
                  })
                : t("notify.none")}
            </p>
          )}
          {status?.enabled && status.problem && (
            <p className="text-xs text-warning" data-notify-problem>
              {t("notify.problem", { problem: status.problem })}
            </p>
          )}
          {shown && (
            <div className="border border-accent-brand p-3" data-notify-shown>
              <p className="text-xs">{t("notify.once")}</p>
              <pre className="mt-2 overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap">
                {shown}
              </pre>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void navigator.clipboard?.writeText(shown)}
                >
                  {t("notify.copy")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShown(null)}
                >
                  {t("notify.hide")}
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void make()}
            >
              {t("notify.make")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void sendTest()}
            >
              {t("notify.test")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("notify.saveFirst")}
          </p>
          {test && (
            <p
              className={test.ok ? "text-xs" : "text-xs text-destructive"}
              data-notify-test={test.ok ? "ok" : "failed"}
            >
              {test.ok
                ? t("notify.testOk", { status: test.status })
                : test.status !== null
                  ? t("notify.testStatus", { status: test.status })
                  : t("notify.testFailed", { error: test.error ?? "" })}
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}
