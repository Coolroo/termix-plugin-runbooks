/**
 * The two folder questions (1.4.11), in the pane like every prompt: Move
 * to folder (an existing folder, a new name, or No folder) and Rename
 * folder. Each checks the name as the server does before it is sent.
 */

import { useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input, PanePrompt } from "@termix-ssh/plugin-sdk/ui";
import { folderKey, folderProblemCode, MAX_FOLDER } from "../../shared/folders";
import { usePaneEscape, type PromptRequest } from "./prompts";

/** Move to folder: the runbook, where it is, and the folders there are. */
export type MoveRequest = PromptRequest<
  { title: string; folder: string | null; folders: string[] },
  { folder: string | null } | null
>;

/** Rename folder: the folder, and the others (a rename may join one). */
export type RenameRequest = PromptRequest<
  { folder: string; folders: string[] },
  string | null
>;

/**
 * A folder name box: its label, what is wrong with the name, and a note
 * when the name is another folder in other letters, which it then joins.
 */
function FolderNameField({
  name,
  setName,
  others,
  inputRef,
  onSubmit,
}: {
  name: string;
  setName: (name: string) => void;
  /** The folders a name may join. */
  others: string[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const trimmed = name.trim();
  const code = folderProblemCode(trimmed);
  const joins = others.find(
    (other) => other !== trimmed && folderKey(other) === folderKey(trimmed),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className="flex flex-col gap-1" onSubmit={submit}>
      <label htmlFor={id} className="text-xs font-medium">
        {t("folder.name")}
      </label>
      <Input
        id={id}
        ref={inputRef}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t("folder.placeholder")}
        aria-invalid={code !== null && code !== "empty"}
        aria-describedby={`${id}-note`}
        className="h-8 text-xs"
        data-folder-name
      />
      <span
        id={`${id}-note`}
        className={
          code !== null && code !== "empty"
            ? "text-[11px] text-destructive"
            : "text-[11px] text-muted-foreground"
        }
        data-folder-note
      >
        {code !== null && code !== "empty"
          ? t(`folder.problem.${code}`, { max: MAX_FOLDER })
          : joins
            ? t("folder.joins", { folder: joins })
            : t("folder.rules", { max: MAX_FOLDER })}
      </span>
    </form>
  );
}

export function MoveFolderPrompt({ request }: { request: MoveRequest }) {
  const { t } = useTranslation();
  const [name, setName] = useState(request.folder ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  usePaneEscape(() => request.resolve(null), {
    focus: inputRef,
    restoreFocus: true,
  });
  const trimmed = name.trim();
  const ok = folderProblemCode(trimmed) === null;
  const move = () => {
    if (ok) request.resolve({ folder: trimmed });
  };
  return (
    <PanePrompt
      open
      role="dialog"
      title={t("folder.moveTitle", { title: request.title })}
      description={
        request.folder === null
          ? t("folder.inNone")
          : t("folder.inFolder", { folder: request.folder })
      }
      onCancel={() => request.resolve(null)}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            data-move-cancel
            onClick={() => request.resolve(null)}
          >
            {t("common.cancel")}
          </Button>
          {request.folder !== null && (
            <Button
              size="sm"
              variant="ghost"
              data-move-none
              onClick={() => request.resolve({ folder: null })}
            >
              {t("folder.toNone")}
            </Button>
          )}
          <Button size="sm" data-move-confirm disabled={!ok} onClick={move}>
            {t("folder.move")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-move-prompt>
        {request.folders.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium" id="runbooks-folder-pick">
              {t("folder.existing")}
            </span>
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-labelledby="runbooks-folder-pick"
            >
              {request.folders.map((folder) => {
                const chosen = folderKey(folder) === folderKey(trimmed);
                return (
                  <Button
                    key={folder}
                    size="xs"
                    variant={chosen ? "secondary" : "outline"}
                    aria-pressed={chosen}
                    data-folder-choice={folder}
                    onClick={() => setName(folder)}
                  >
                    {folder}
                  </Button>
                );
              })}
            </div>
          </div>
        )}
        <FolderNameField
          name={name}
          setName={setName}
          others={request.folders}
          inputRef={inputRef}
          onSubmit={move}
        />
      </div>
    </PanePrompt>
  );
}

export function RenameFolderPrompt({ request }: { request: RenameRequest }) {
  const { t } = useTranslation();
  const [name, setName] = useState(request.folder);
  const inputRef = useRef<HTMLInputElement>(null);
  usePaneEscape(() => request.resolve(null), {
    focus: inputRef,
    restoreFocus: true,
  });
  const trimmed = name.trim();
  const ok = folderProblemCode(trimmed) === null && trimmed !== request.folder;
  const rename = () => {
    if (ok) request.resolve(trimmed);
  };
  const others = request.folders.filter(
    (folder) => folderKey(folder) !== folderKey(request.folder),
  );
  return (
    <PanePrompt
      open
      role="dialog"
      title={t("folder.renameTitle", { folder: request.folder })}
      description={t("folder.renameHint")}
      onCancel={() => request.resolve(null)}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            data-rename-cancel
            onClick={() => request.resolve(null)}
          >
            {t("common.cancel")}
          </Button>
          <Button size="sm" data-rename-confirm disabled={!ok} onClick={rename}>
            {t("folder.rename")}
          </Button>
        </>
      }
    >
      <div data-rename-prompt>
        <FolderNameField
          name={name}
          setName={setName}
          others={others}
          inputRef={inputRef}
          onSubmit={rename}
        />
      </div>
    </PanePrompt>
  );
}
