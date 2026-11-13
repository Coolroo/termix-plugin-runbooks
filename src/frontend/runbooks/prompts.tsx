/**
 * Questions the runbook asks inside its own pane (PanePrompt): a request
 * held in state that resolves a promise, and Esc to cancel. Also the two
 * questions themselves (Start anyway, Send to agent) and what a confirm
 * shows of a step.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, PanePrompt, Textarea } from "@termix-ssh/plugin-sdk/ui";
import { MAX_SENT_NOTE } from "../../shared/limits";
import { stepLabel } from "../../shared/steps";
import type { Translate } from "../../shared/step-kinds";
import { CodeBlock } from "../ui/ui";
import { describeStdin, formatTime, hostLabel } from "../ui/format";
import { ChecksList, checksWords } from "../steps/ChecksList";
import type { ConflictBody, Step } from "../api-types";

/** A question on screen: what it asks, and how it answers. */
export type PromptRequest<Req, Res> = Req & { resolve: (answer: Res) => void };

/**
 * One question at a time, as state. `ask(request)` shows it and resolves
 * with the answer; the question goes away when it is answered.
 */
export function usePromptRequest<Req, Res>(): [
  PromptRequest<Req, Res> | null,
  (request: Req) => Promise<Res>,
] {
  const [open, setOpen] = useState<PromptRequest<Req, Res> | null>(null);
  const ask = useCallback(
    (request: Req) =>
      new Promise<Res>((resolve) =>
        setOpen({
          ...request,
          resolve: (answer: Res) => {
            setOpen(null);
            resolve(answer);
          },
        }),
      ),
    [],
  );
  return [open, ask];
}

/**
 * While mounted: moves the focus to `focus`, and Esc anywhere calls
 * `onEscape` before anything else sees the key. With `restoreFocus`, the
 * focus goes back where it was when the prompt closes.
 */
function usePaneEscape(
  onEscape: () => void,
  {
    focus,
    restoreFocus = false,
  }: { focus?: RefObject<HTMLElement | null>; restoreFocus?: boolean } = {},
): void {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const restoreRef = useRef(restoreFocus);
  const focusRef = useRef(focus);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    focusRef.current?.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      escapeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (restoreRef.current && previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, []);
}

function CommandPreview({
  host,
  command,
  stdin,
}: {
  host: string;
  command: string;
  /** The step's input: where from, and the start of a step or value. */
  stdin?: { label: string; preview: string | null } | null;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span>{host}</span>
      <CodeBlock className="max-h-60 overflow-auto" small={false}>
        {command}
      </CodeBlock>
      {stdin && (
        <>
          <span data-confirm-stdin>{stdin.label}</span>
          {stdin.preview !== null && (
            <CodeBlock
              data-confirm-stdin-preview
              className="max-h-40 overflow-auto"
              small={false}
            >
              {stdin.preview}
            </CodeBlock>
          )}
        </>
      )}
    </div>
  );
}

type EarlyRequest = PromptRequest<
  { title: string; details: ReactNode },
  boolean
>;

/**
 * "The wait is not over": Cancel is focused, so Enter cancels, and Start
 * anyway is a warning. Esc cancels too.
 */
export function EarlyStartPrompt({ request }: { request: EarlyRequest }) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  usePaneEscape(() => request.resolve(false), {
    focus: cancelRef,
    restoreFocus: true,
  });
  return (
    <PanePrompt
      open
      role="alertdialog"
      title={request.title}
      description={request.details}
      onCancel={() => request.resolve(false)}
      className="border-warning/60"
      actions={
        <>
          <button
            ref={cancelRef}
            type="button"
            data-early-cancel
            onClick={() => request.resolve(false)}
            className="inline-flex h-7 items-center justify-center border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-early-start
            onClick={() => request.resolve(true)}
            className="inline-flex h-7 items-center justify-center border border-warning/60 bg-warning/15 px-3 text-xs font-medium text-warning transition-colors hover:bg-warning/25 focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("wait.anyway")}
          </button>
        </>
      }
    />
  );
}

type SendRequest = PromptRequest<{ step: Step; label: string }, string | null>;

/**
 * "Send step N to <agent>?": an optional note with a counter, Send and
 * Cancel. Resolves the note ("" for none), or null for Cancel.
 */
export function SendToAgentPrompt({ request }: { request: SendRequest }) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  usePaneEscape(() => request.resolve(null), { focus: boxRef });
  const tooLong = note.length > MAX_SENT_NOTE;
  return (
    <PanePrompt
      open
      role="dialog"
      title={t("sendAgent.title", {
        position: stepLabel(request.step),
        label: request.label,
      })}
      description={t("sendAgent.hint")}
      onCancel={() => request.resolve(null)}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            data-send-cancel
            onClick={() => request.resolve(null)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            data-send-confirm
            disabled={tooLong}
            onClick={() => request.resolve(note)}
          >
            {t("sendAgent.send")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1" data-send-prompt>
        <Textarea
          ref={boxRef}
          value={note}
          maxLength={MAX_SENT_NOTE}
          onChange={(event) =>
            setNote(event.target.value.slice(0, MAX_SENT_NOTE))
          }
          placeholder={t("sendAgent.notePlaceholder")}
          aria-label={t("sendAgent.notePlaceholder")}
          className="min-h-20 text-xs"
        />
        <span
          className="self-end text-[11px] text-muted-foreground"
          data-send-count
        >
          {t("sendAgent.count", { count: note.length, max: MAX_SENT_NOTE })}
        </span>
      </div>
    </PanePrompt>
  );
}

/** What a confirm says of the step's input, if it has one. */
function stdinPreview(t: Translate, step: Step) {
  return step.stdin
    ? {
        label:
          t("stdin.label", {
            source: describeStdin(t, step.stdin.source, step.stdin.bytes),
          }) +
          // Whoever wrote the command decides what happens to the secret.
          (step.stdin.source.from === "secret"
            ? ` ${t("stdin.secretWarning")}`
            : ""),
        preview: step.stdin.preview,
      }
    : null;
}

/**
 * The host, the command, its input, checks and secrets, for a confirm. No
 * hooks: a confirm renders outside the plugin.
 */
export function runDetails(t: Translate, step: Step) {
  return (
    <div className="flex flex-col gap-2">
      <CommandPreview
        host={hostLabel(t, step)}
        command={step.resolvedCommand ?? ""}
        stdin={stdinPreview(t, step)}
      />
      <ChecksList checks={step.checks ?? []} words={checksWords(t)} />
      {(step.secretCaptures ?? []).length > 0 && (
        <span className="text-xs" data-confirm-secrets>
          {t("secrets.confirm", {
            names: (step.secretCaptures ?? [])
              .map((capture) => capture.name)
              .join(", "),
          })}
        </span>
      )}
    </div>
  );
}

/** The host and the command only, for a question. */
export function commandDetails(t: Translate, step: Step) {
  return (
    <CommandPreview
      host={hostLabel(t, step)}
      command={step.resolvedCommand ?? ""}
    />
  );
}

/** "Run it again?": the run before, and the command. */
export function repeatDetails(
  t: Translate,
  repeat: NonNullable<Extract<ConflictBody, { code: "repeat" }>["repeat"]>,
  step: Step,
) {
  return (
    <div className="flex flex-col gap-2 text-xs">
      <span>
        {t("repeat.last", {
          user: repeat.userId,
          time: formatTime(repeat.startedAt),
          exit: repeat.exitCode ?? "-",
        })}
      </span>
      {commandDetails(t, step)}
    </div>
  );
}
