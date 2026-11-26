/**
 * The list's sections and folders (1.4.10): Open, Done and Abandoned, and
 * inside each the runbooks grouped by folder, A to Z, No folder last. Two
 * spellings of one folder are one group, named as the first one read.
 */

import {
  folderKey,
  LIST_SECTIONS,
  uniqueFolders,
  type ListSection,
} from "../../shared/folders";
import type { RunbookListEntry } from "../api-types";

export interface FolderGroup {
  /** The folder's name; null: No folder. */
  folder: string | null;
  rows: RunbookListEntry[];
}

export interface SectionGroup {
  status: ListSection;
  /** Every runbook in the section, for its count. */
  count: number;
  folders: FolderGroup[];
}

/** Whether a title matches a search: every word, in any letters. */
export function titleMatches(title: string, query: string): boolean {
  const words = query.toLocaleLowerCase("en").split(/\s+/).filter(Boolean);
  const text = title.toLocaleLowerCase("en");
  return words.every((word) => text.includes(word));
}

/**
 * The sections that have runbooks, in order, with their folders. The rows
 * keep the order the server sent (newest change first). `query` keeps
 * only the titles that match it.
 */
export function groupRunbooks(
  rows: RunbookListEntry[],
  query = "",
): SectionGroup[] {
  const shown = query.trim()
    ? rows.filter((row) => titleMatches(row.title, query))
    : rows;
  const out: SectionGroup[] = [];
  for (const status of LIST_SECTIONS) {
    const inSection = shown.filter((row) => row.status === status);
    if (inSection.length === 0) continue;
    const byKey = new Map<string, FolderGroup>();
    const loose: RunbookListEntry[] = [];
    for (const row of inSection) {
      if (row.folder === null) {
        loose.push(row);
        continue;
      }
      const key = folderKey(row.folder);
      const group = byKey.get(key);
      if (group) group.rows.push(row);
      else byKey.set(key, { folder: row.folder, rows: [row] });
    }
    const folders = [...byKey.values()].sort((a, b) =>
      a.folder!.localeCompare(b.folder!, "en", { sensitivity: "base" }),
    );
    if (loose.length) folders.push({ folder: null, rows: loose });
    out.push({ status, count: inSection.length, folders });
  }
  return out;
}

/** Every folder name in the list, each folder once, A to Z. */
export function listFolders(rows: RunbookListEntry[]): string[] {
  return uniqueFolders(rows.flatMap((row) => (row.folder ? [row.folder] : [])));
}
