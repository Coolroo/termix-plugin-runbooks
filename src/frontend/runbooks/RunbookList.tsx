/**
 * The list of runbooks, read again every few seconds. 1.4.10: in sections
 * by state (Open, Done, Abandoned), and inside each by folder, each one
 * collapsible with a count; what a person collapses is kept for them. A
 * search over the titles opens what matches. Each row moves its runbook
 * to a folder; a folder row renames the folder.
 */

import { useCallback, useState, type ReactNode } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  ListBadge,
  ListRow,
  ListRowAction,
  ListRowFolder,
  PanelList,
  PanelSearch,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { NextKindDot } from "../kinds/kinds";
import { usePolling } from "../ui/timers";
import { LoadError, RunbookStatusBadge, runbookMeta } from "../ui/ui";
import { POLL_MS } from "./use-runbook";
import { usePromptRequest } from "./prompts";
import { useListState } from "./use-list-state";
import { groupRunbooks, listFolders, type SectionGroup } from "./list-groups";
import {
  MoveFolderPrompt,
  RenameFolderPrompt,
  type MoveRequest,
  type RenameRequest,
} from "./folder-prompts";
import { FolderIcon, PencilIcon } from "./folder-icons";
import {
  folderCollapsed,
  folderStateKey,
  sectionCollapsed,
  sectionKey,
  type ListState,
} from "../../shared/folders";
import type { RunbookListEntry } from "../api-types";

/** The server's words for a refusal, else `fallback`. */
export function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data;
  return typeof data?.error === "string" ? data.error : fallback;
}

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
  const [saved, choose] = useListState(api);
  const [query, setQuery] = useState("");
  // While searching, what matches is open; toggles then are not kept.
  const [searchState, setSearchState] = useState<ListState>({});
  const [moving, askMove] = usePromptRequest<
    Omit<MoveRequest, "resolve">,
    { folder: string | null } | null
  >();
  const [renaming, askRename] = usePromptRequest<
    Omit<RenameRequest, "resolve">,
    string | null
  >();

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

  const searching = query.trim() !== "";
  const sections = groupRunbooks(rows, query);
  const folders = listFolders(rows);
  // Searching: everything with a match starts open.
  const state = searching ? searchState : saved;
  const isSectionCollapsed = (section: SectionGroup) =>
    searching
      ? (state[sectionKey(section.status)] ?? false)
      : sectionCollapsed(state, section.status);
  const toggle = (key: string, collapsed: boolean) => {
    if (searching) setSearchState((prev) => ({ ...prev, [key]: collapsed }));
    else choose(key, collapsed);
  };

  const move = async (row: RunbookListEntry) => {
    const answer = await askMove({
      title: row.title,
      folder: row.folder,
      folders,
    });
    if (!answer) return;
    try {
      await api.post(`/runbooks/${row.id}/folder`, answer);
    } catch (error) {
      toast.error(errorText(error, t("folder.moveFailed")));
    }
    await load();
  };

  const rename = async (folder: string) => {
    const to = await askRename({ folder, folders });
    if (to === null) return;
    try {
      await api.post("/folders/rename", { from: folder, to });
    } catch (error) {
      toast.error(errorText(error, t("folder.renameFailed")));
    }
    await load();
  };

  const runbookRow = (row: RunbookListEntry, stripe: number) => (
    <ListRow
      key={row.id}
      title={row.title}
      stripe={stripe}
      dimmed={row.status !== "open"}
      onClick={() => onOpen(row.id)}
      data-runbook-row={row.id}
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
      actions={
        <ListRowAction
          label={t("folder.moveTo")}
          data-move-folder={row.id}
          onClick={() => void move(row)}
        >
          <FolderIcon />
        </ListRowAction>
      }
    />
  );

  let body: ReactNode = null;
  if (rows.length > 0 && sections.length === 0) {
    body = (
      <EmptyState
        title={t("list.noMatch", { query: query.trim() })}
        hint={t("list.noMatchHint")}
      />
    );
  } else if (rows.length > 0) {
    body = sections.map((section) => {
      const collapsed = isSectionCollapsed(section);
      const panel = `runbooks-section-${section.status}`;
      return (
        <section
          key={section.status}
          aria-labelledby={`${panel}-heading`}
          data-list-section={section.status}
          data-collapsed={collapsed || undefined}
        >
          <h3 className="m-0" id={`${panel}-heading`}>
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls={panel}
              onClick={() => toggle(sectionKey(section.status), !collapsed)}
              className="flex w-full items-center gap-2 border-b border-border bg-muted/20 px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              data-section-toggle={section.status}
            >
              <Chevron open={!collapsed} />
              <span className="min-w-0 flex-1 truncate">
                {t(`list.section.${section.status}`)}
              </span>
              <span
                className="shrink-0 bg-muted/70 px-1.5 py-[1px] text-[10px] tabular-nums tracking-normal"
                data-section-count
              >
                {section.count}
              </span>
            </button>
          </h3>
          {!collapsed && (
            <div id={panel}>
              {section.folders.map((group, index) => {
                const key = folderStateKey(section.status, group.folder);
                const shut = searching
                  ? (state[key] ?? false)
                  : folderCollapsed(state, section.status, group.folder);
                return (
                  <div
                    key={key}
                    data-list-folder={group.folder ?? ""}
                    data-collapsed={shut || undefined}
                  >
                    <ListRowFolder
                      name={
                        group.folder ?? (
                          <span className="font-normal italic text-muted-foreground">
                            {t("folder.none")}
                          </span>
                        )
                      }
                      icon={<FolderIcon />}
                      count={group.rows.length}
                      open={!shut}
                      stripe={index}
                      onToggle={() => toggle(key, !shut)}
                      actions={
                        group.folder !== null && (
                          <ListRowAction
                            label={t("folder.renameNamed", {
                              folder: group.folder,
                            })}
                            data-rename-folder={group.folder}
                            onClick={() => void rename(group.folder!)}
                          >
                            <PencilIcon />
                          </ListRowAction>
                        )
                      }
                    >
                      {group.rows.map(runbookRow)}
                    </ListRowFolder>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      );
    });
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-runbook-list>
      {rows.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
          <PanelSearch
            value={query}
            onChange={(next) => {
              setQuery(next);
              setSearchState({});
            }}
            placeholder={t("list.search")}
            title={t("list.search")}
            fill
          />
        </div>
      )}
      <PanelList
        empty={
          <EmptyState title={t("list.empty")} hint={t("list.emptyHint")} />
        }
      >
        {body}
      </PanelList>
      {moving && <MoveFolderPrompt request={moving} />}
      {renaming && <RenameFolderPrompt request={renaming} />}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`size-3.5 shrink-0 transition-transform${open ? " rotate-90" : ""}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
