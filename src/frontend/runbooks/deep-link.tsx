/**
 * Links that open a runbook: `<Termix address>/?view=runbook&id=<id>`.
 *
 * Termix renders a `?view=` link full screen, and keeps it across a sign-in
 * when the person was signed out. A runbook needs the app around it (Send to
 * terminal opens terminal tabs), so the full-screen view only notes the id
 * and goes on to the app, where the Runbooks tab opens on that runbook.
 */

import { useEffect } from "react";
import type {
  StandaloneViewProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";

/** The `?view=` name of a runbook link. */
export const RUNBOOK_VIEW = "runbook";

const PENDING_KEY = "termix-runbooks:open-runbook";

/** A positive integer id, or null. */
export function parseRunbookId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** Notes a runbook to open once the app is up. */
function rememberRunbook(id: number): void {
  try {
    sessionStorage.setItem(PENDING_KEY, String(id));
  } catch {
    // Without storage the person lands on the app without the runbook open.
  }
}

/** The runbook a link asked for, cleared whether or not it is valid. */
export function takePendingRunbook(): number | null {
  try {
    const stored = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return parseRunbookId(stored);
  } catch {
    return null;
  }
}

/** Page navigation, replaceable in tests (jsdom cannot navigate). */
export const navigation = {
  replace: (path: string) => window.location.replace(path),
};

/**
 * The app itself: the link's own path with no query, so a Termix served under
 * a base path stays under it.
 */
function appPath(): string {
  return window.location.pathname || "/";
}

/** The full-screen `?view=runbook` page: hands the id to the app. */
export function createRunbookLink(app: Pick<TermixApp, "t">) {
  return function RunbookLink({ params }: StandaloneViewProps) {
    useEffect(() => {
      const id = parseRunbookId(params.get("id"));
      if (id !== null) rememberRunbook(id);
      navigation.replace(appPath());
    }, [params]);
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {app.t("link.opening")}
      </p>
    );
  };
}
