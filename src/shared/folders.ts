/**
 * Folders (1.4.11): an optional name on a runbook that the list groups by.
 * One level: a folder holds runbooks only, so a name has no "/". A folder
 * exists only while a runbook is in it. Shared by the server, which checks
 * every name, and the page, which checks it before it sends one.
 */

/** The longest folder name. */
export const MAX_FOLDER = 60;

/** Why `name` (already trimmed) is not a folder name; null when it is. */
export function folderProblem(name: string): string | null {
  if (name === "") return "a folder name must not be empty";
  if (name.length > MAX_FOLDER) {
    return `a folder name is at most ${MAX_FOLDER} characters`;
  }
  if (name.includes("/")) {
    return 'a folder name has no "/": folders hold runbooks, not folders';
  }
  // Control characters (a newline, a tab) never show as text in the list.
  if (/\p{Cc}/u.test(name)) {
    return "a folder name has no control characters";
  }
  return null;
}

/** The key two spellings of one folder share: "Termix" and "termix". */
export const folderKey = (name: string) => name.toLocaleLowerCase("en");

/**
 * The spelling to store for `name`: an existing folder's when it is the
 * same folder in other letters, so "termix" joins "Termix".
 */
export function reuseSpelling(name: string, existing: Iterable<string>) {
  const key = folderKey(name);
  for (const other of existing) {
    if (folderKey(other) === key) return other;
  }
  return name;
}

/** The sections of the list, in their order (1.4.11). */
export const LIST_SECTIONS = ["open", "done", "abandoned"] as const;
export type ListSection = (typeof LIST_SECTIONS)[number];

/**
 * What a person collapsed or opened in the list, remembered for them: a
 * section by "section:<status>", a folder in a section by
 * "folder:<status>:<folder key>" ("" for No folder). true: collapsed.
 * Only choices are kept; the rest follow the defaults.
 */
export type ListState = Record<string, boolean>;

/** The setting that holds a person's ListState. */
export const LIST_STATE_SETTING = "listCollapsed";

/** The most choices a ListState keeps, and the longest key. */
export const MAX_LIST_STATE = 500;
const MAX_LIST_KEY = 20 + MAX_FOLDER;

export const sectionKey = (status: ListSection) => `section:${status}`;
export const folderStateKey = (status: ListSection, folder: string | null) =>
  `folder:${status}:${folder === null ? "" : folderKey(folder)}`;

/** Open starts expanded; Done and Abandoned start collapsed. */
export function sectionCollapsed(state: ListState, status: ListSection) {
  return state[sectionKey(status)] ?? status !== "open";
}

/** A folder starts expanded. */
export function folderCollapsed(
  state: ListState,
  status: ListSection,
  folder: string | null,
) {
  return state[folderStateKey(status, folder)] ?? false;
}

/** Why `value` is not a ListState; null when it is. */
export function listStateProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "the list state must be an object of true or false";
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_LIST_STATE) {
    return `the list state keeps at most ${MAX_LIST_STATE} choices`;
  }
  for (const [key, collapsed] of entries) {
    if (typeof collapsed !== "boolean") {
      return `the list state: "${key.slice(0, MAX_LIST_KEY)}" must be true or false`;
    }
    if (key.length > MAX_LIST_KEY || !/^(section|folder):/.test(key)) {
      return `the list state: "${key.slice(0, MAX_LIST_KEY)}" is not a section or a folder`;
    }
  }
  return null;
}

/** A stored ListState with what is not one dropped, whatever wrote it. */
export function cleanListState(value: unknown): ListState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: ListState = {};
  for (const [key, collapsed] of Object.entries(value).slice(
    0,
    MAX_LIST_STATE,
  )) {
    if (
      typeof collapsed === "boolean" &&
      key.length <= MAX_LIST_KEY &&
      /^(section|folder):/.test(key)
    ) {
      out[key] = collapsed;
    }
  }
  return out;
}
