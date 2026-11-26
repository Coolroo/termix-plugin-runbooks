/**
 * Folders and the list's sections (1.4.11): move a runbook to a folder,
 * rename a folder, and what each person collapsed in the list.
 *
 * Moving and renaming take what changing a runbook's status takes: a
 * signed-in person with Use, not a core API key. Both work on any runbook
 * the list shows, open, done or abandoned, and change nothing but folders.
 */

import type { Router } from "express";
import { body, wrap } from "../core/http.js";
import { InputError } from "../core/errors.js";
import { runbookResource } from "../core/audit.js";
import { pathId, type PersonKit } from "./person-kit.js";
import { folderText, inFolder, parseFolder, spellFolder } from "./folders.js";
import {
  cleanListState,
  folderKey,
  LIST_STATE_SETTING,
  listStateProblem,
  reuseSpelling,
  uniqueFolders,
} from "../../shared/folders.js";

/** A folder name a rename needs: null (No folder) is not one. */
function folderName(value: unknown, field: string): string {
  const name = parseFolder(value ?? "", field);
  if (name === null) throw new InputError(`${field} must be a folder name`);
  return name;
}

export function registerFolderRoutes(router: Router, kit: PersonKit): void {
  const { ctx, store, actor, use, act, showRunbook, bundleFor } = kit;

  /**
   * @openapi
   * /plugin-api/runbooks/folders:
   *   get:
   *     summary: The folders runbooks are in, A to Z
   *     description: >
   *       A folder exists only while a runbook is in it, so this is every
   *       folder name on a runbook, each folder once in its first spelling.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The folder names }
   */
  router.get(
    "/folders",
    ...use,
    wrap(async () => uniqueFolders(await store.listFolders())),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/runbooks/{id}/folder:
   *   post:
   *     summary: Move a runbook to a folder, or to no folder
   *     description: >
   *       { folder: "name" } or { folder: null }. A name is trimmed, 1 to 60
   *       characters, with no "/"; the same folder in other letters keeps
   *       its spelling. Any status; nothing else on the runbook changes.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The runbook }
   *       400: { description: Not a folder name }
   *       404: { description: Not found }
   */
  router.post(
    "/runbooks/:id/folder",
    ...act,
    wrap(async (req) => {
      const id = pathId(req);
      const before = (await bundleFor(id)).runbook;
      const raw = body(req);
      if (!("folder" in raw)) {
        throw new InputError("folder is required: a name, or null");
      }
      const folder = await spellFolder(store, parseFolder(raw.folder));
      if (folder !== before.folder) {
        await store.setFolder([id], folder);
        await store.persist();
        await ctx.audit.record({
          action: "runbooks_runbook_folder",
          ...runbookResource(before),
          details: `runbook ${id} moved from ${folderText(before.folder)} to ${folderText(folder)}`,
          success: true,
          request: req,
        });
      }
      return showRunbook(await bundleFor(id));
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/folders/rename:
   *   post:
   *     summary: Rename a folder; every runbook in it moves
   *     description: >
   *       { from, to }. `from` matches any spelling of the folder. When `to`
   *       is another folder in other letters, the runbooks join it. Answers
   *       { folder, moved }: the name they are in now and how many moved.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The folder and the count }
   *       400: { description: Not a folder name }
   *       404: { description: No runbook is in that folder }
   */
  router.post(
    "/folders/rename",
    ...act,
    wrap(async (req) => {
      const raw = body(req);
      const from = folderName(raw.from, "from");
      const to = folderName(raw.to, "to");
      const moving = inFolder(await store.listRunbooks({}), from);
      if (moving.length === 0) {
        throw new InputError(`no runbook is in folder "${from}"`, 404);
      }
      // Another folder with this name in other letters: join it. The
      // folder itself may change only its letters ("termix" to "Termix").
      const others = (await store.listFolders()).filter(
        (name) => folderKey(name) !== folderKey(from),
      );
      const folder = reuseSpelling(to, others);
      const ids = moving
        .filter((runbook) => runbook.folder !== folder)
        .map((runbook) => runbook.id);
      await store.setFolder(ids, folder);
      await store.persist();
      await ctx.audit.record({
        action: "runbooks_folder_rename",
        resourceType: "runbooks_folder",
        resourceId: folder.slice(0, 200),
        resourceName: folder,
        details: `folder ${folderText(from)} renamed to ${folderText(folder)} by ${actor()}: runbooks ${moving.map((runbook) => runbook.id).join(", ")}`,
        success: true,
        request: req,
      });
      return { folder, moved: moving.length };
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/list-state:
   *   get:
   *     summary: What this person collapsed or opened in the list
   *     description: >
   *       { "section:done": false, "folder:open:termix": true, ... }: true
   *       is collapsed. Only choices are kept; Open starts expanded, Done
   *       and Abandoned collapsed, every folder expanded.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The choices }
   *   put:
   *     summary: Keep this person's choices in the list
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The choices kept }
   *       400: { description: Not a list state }
   */
  router.get(
    "/list-state",
    ...use,
    wrap(async () =>
      cleanListState(await ctx.settings.getUser(actor(), LIST_STATE_SETTING)),
    ),
  );
  router.put(
    "/list-state",
    ...act,
    wrap(async (req) => {
      const problem = listStateProblem(req.body);
      if (problem) throw new InputError(problem);
      const state = cleanListState(req.body);
      await ctx.settings.setUser(actor(), LIST_STATE_SETTING, state);
      return state;
    }),
  );
}
