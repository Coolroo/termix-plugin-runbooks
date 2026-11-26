/**
 * What this person collapsed or opened in the list (1.4.10), kept on the
 * server as their own setting (GET and PUT /list-state), so it follows
 * them to every browser. Until it is read, and when it cannot be, the
 * defaults hold: Open expanded, Done and Abandoned collapsed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import {
  cleanListState,
  MAX_LIST_STATE,
  type ListState,
} from "../../shared/folders";

export function useListState(api: PluginApiClient) {
  const [state, setState] = useState<ListState>({});
  const current = useRef<ListState>({});
  // Choices made before the stored ones arrived win over them.
  const early = useRef<ListState>({});
  const read = useRef(false);

  useEffect(() => {
    let live = true;
    api
      .get<unknown>("/list-state")
      .then(({ data }) => {
        if (!live) return;
        const next = { ...cleanListState(data), ...early.current };
        current.current = next;
        setState(next);
      })
      .catch(() => {
        // Not read: the defaults hold, and a choice is still saved.
      })
      .finally(() => {
        read.current = true;
      });
    return () => {
      live = false;
    };
  }, [api]);

  /** Collapses (true) or opens (false) `key`, and keeps the choice. */
  const choose = useCallback(
    (key: string, collapsed: boolean) => {
      if (!read.current) early.current = { ...early.current, [key]: collapsed };
      // The newest choice goes last; the oldest go first past the limit.
      const { [key]: _old, ...rest } = current.current;
      const entries = Object.entries({ ...rest, [key]: collapsed });
      const next = Object.fromEntries(entries.slice(-MAX_LIST_STATE));
      current.current = next;
      setState(next);
      void api.put("/list-state", next).catch(() => {
        // Not kept: the list still shows the choice until it is read again.
      });
    },
    [api],
  );

  return [state, choose] as const;
}
