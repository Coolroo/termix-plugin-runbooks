/**
 * The Runbooks tab: the list, one runbook, or the agent tokens, and a
 * runbook link that opens the tab on its runbook.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  useDocsUrl,
  usePermission,
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { BackButton, Button, PanelShell } from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { parseRunbookId } from "./deep-link";
import { TokensView } from "../agents/TokensView";
import { KindColorsProvider } from "../kinds/kinds";
import { RunbookList } from "./RunbookList";
import { RunbookDetail } from "./RunbookDetail";

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
        // A runbook scrolls itself, beside its rail and above its bar.
        scroll={view.kind !== "runbook"}
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
        <KindColorsProvider active={isVisible}>{body}</KindColorsProvider>
      </PanelShell>
    );
  };
}
