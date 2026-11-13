/** The list of runbooks, open ones first, read again every few seconds. */

import { useCallback, useState } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  ListBadge,
  ListRow,
  PanelList,
} from "@termix-ssh/plugin-sdk/ui";
import { NextKindDot } from "../kinds/kinds";
import { usePolling } from "../ui/timers";
import { LoadError, RunbookStatusBadge, runbookMeta } from "../ui/ui";
import { POLL_MS } from "./use-runbook";
import type { RunbookListEntry } from "../api-types";

export function RunbookList({
  onOpen,
  isVisible,
}: {
  onOpen: (id: number) => void;
  isVisible: boolean;
}) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const [rows, setRows] = useState<RunbookListEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<RunbookListEntry[]>("/runbooks");
      setRows(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  usePolling(load, { active: isVisible, intervalMs: POLL_MS });

  if (failed && !rows) return <LoadError />;
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
              <RunbookStatusBadge status={row.status} />
              {row.progress.failed > 0 && (
                <ListBadge tone="destructive">
                  {t("list.failed", { count: row.progress.failed })}
                </ListBadge>
              )}
              {row.amendedPending > 0 && (
                <span data-amended-badge>
                  <ListBadge tone="warning">{t("list.amended")}</ListBadge>
                </span>
              )}
              {row.status === "open" && row.nextKind && (
                <NextKindDot kindId={row.nextKind} />
              )}
            </>
          }
          meta={runbookMeta(t, row)}
        />
      ))}
    </PanelList>
  );
}
