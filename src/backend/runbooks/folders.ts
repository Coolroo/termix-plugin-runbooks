/**
 * Folders (1.4.11): the name a runbook is filed under, checked and spelled
 * the same way for people and agents. A folder is only a name on runbooks:
 * moving the last runbook out of one is all it takes to remove it.
 */

import { InputError } from "../core/errors.js";
import {
  folderKey,
  folderProblem,
  reuseSpelling,
} from "../../shared/folders.js";
import type { Store } from "./store/store.js";
import type { RunbookRow } from "./store/types.js";

/** A folder as written: a name (trimmed), or null for No folder. */
export function parseFolder(value: unknown, field = "folder"): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new InputError(`${field} must be a string, or null for no folder`);
  }
  const name = value.trim();
  const problem = folderProblem(name);
  if (problem) throw new InputError(`${field}: ${problem}`, 400);
  return name;
}

/**
 * The folder to store: an existing one's spelling when the name is the
 * same folder in other letters. `ownerUserId` limits the folders it looks
 * at to that person's runbooks (an agent's), so a token learns no other
 * person's folder names.
 */
export async function spellFolder(
  store: Store,
  name: string | null,
  ownerUserId?: string,
): Promise<string | null> {
  if (name === null) return null;
  return reuseSpelling(name, await store.listFolders(ownerUserId));
}

/** `"name"`, or "no folder", for an audit line. */
export const folderText = (folder: string | null) =>
  folder === null ? "no folder" : `"${folder}"`;

/** The runbooks in `folder`, any spelling of it. */
export function inFolder(rows: RunbookRow[], folder: string): RunbookRow[] {
  const key = folderKey(folder);
  return rows.filter((row) => row.folder && folderKey(row.folder) === key);
}
