/**
 * The line under a running command's output where the person who started
 * it types into it (1.4.6): Send (Enter) and End input, an eye to hide what
 * they type, and the time left of the step's limit. It lights up and hides
 * what is typed when the output's last line looks like a password prompt.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  useCurrentUser,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Input,
  ListBadge,
  PluginIcon,
} from "@termix-ssh/plugin-sdk/ui";
import { DEFAULT_TIMEOUT_MS, MIN_HIDDEN_CHARS } from "../../shared/limits";
import { formatDuration } from "../ui/format";
import { SectionLabel } from "../ui/ui";
import type { StepActions } from "../steps/StepButtons";
import type { Run, Step } from "../api-types";

/** A last line such as "[sudo] password for alice: " or "Token:". */
const PROMPT = /\b(pass(word|phrase|code)|token|pin)\b.*:\s*$/i;

/**
 * The output's last line asks for a secret: the line after the last line
 * end of stdout or of stderr (sudo -S asks on stderr).
 */
export function looksLikePrompt(run: Pick<Run, "stdout" | "stderr">): boolean {
  return [run.stdout, run.stderr].some((text) => {
    if (!text) return false;
    return PROMPT.test(text.slice(text.lastIndexOf("\n") + 1));
  });
}

export function RunInput({
  run,
  step,
  elapsedMs,
  onInput,
}: {
  run: Run;
  step: Pick<Step, "interactive" | "timeoutMs">;
  /** How long the command has run, on this page's clock. */
  elapsedMs: number;
  onInput: StepActions["input"];
}) {
  const { t } = useTranslation();
  const me = useCurrentUser();
  const prompt = looksLikePrompt(run);
  const [text, setText] = useState("");
  const [hidden, setHidden] = useState(step.interactive || prompt);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // A new prompt hides what is typed; the person can show it again.
  const wasPrompt = useRef(prompt);
  useEffect(() => {
    if (prompt && !wasPrompt.current) setHidden(true);
    wasPrompt.current = prompt;
  }, [prompt]);

  if (run.mode !== "exec" || run.stdin) return null;
  const ended = run.inputs?.some((input) => input.ended) ?? false;
  if (!run.acceptsInput) {
    return ended ? (
      <p className="mt-2 text-muted-foreground" data-run-input="ended">
        {t("run.input.ended")}
      </p>
    ) : null;
  }
  // D6: only the person who started it types (the server checks too). Until
  // the page knows who is signed in, the line shows.
  if (me && me.userId !== run.userId) {
    return (
      <p className="mt-2 text-muted-foreground" data-run-input="not-yours">
        {t("run.input.notYours", { user: run.userId })}
      </p>
    );
  }

  const left = Math.max(
    0,
    (step.timeoutMs ?? DEFAULT_TIMEOUT_MS) - Math.max(0, elapsedMs),
  );
  const typed = [...text].length;

  async function send(end: boolean) {
    if (sending) return;
    setSending(true);
    // Send ends the line, as Enter in a terminal does: CR under a pty,
    // which is what a terminal sends (PowerShell's Read-Host takes no LF
    // there, BUG-010), LF to plain standard input. End input sends what is
    // in the box as it is.
    const enter = step.interactive ? "\r" : "\n";
    const ok = await onInput(run, end ? text : `${text}${enter}`, hidden, end);
    setSending(false);
    if (ok) setText("");
    field.current?.focus();
  }

  return (
    <div
      className="mt-2 flex flex-col gap-1"
      data-run-input="open"
      data-prompt={prompt || undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>{t("run.input.label")}</SectionLabel>
        {prompt && (
          <span data-prompt-badge>
            <ListBadge tone="warning">{t("run.input.prompt")}</ListBadge>
          </span>
        )}
      </div>
      <div
        className={
          prompt
            ? "flex flex-wrap items-center gap-2 border border-primary p-1"
            : "flex flex-wrap items-center gap-2"
        }
      >
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-pressed={hidden}
          aria-label={hidden ? t("run.input.show") : t("run.input.hide")}
          title={hidden ? t("run.input.show") : t("run.input.hide")}
          data-input-eye={hidden ? "closed" : "open"}
          onClick={() => setHidden((now) => !now)}
        >
          <PluginIcon
            name={hidden ? "EyeOff" : "Eye"}
            className="size-4"
            aria-hidden="true"
          />
        </button>
        <Input
          ref={field}
          value={text}
          aria-label={t("run.input.label")}
          placeholder={
            hidden
              ? t("run.input.placeholderHidden")
              : t("run.input.placeholder")
          }
          data-input-text
          data-hidden={hidden ? "true" : "false"}
          // On a phone, Send and End input go under the field.
          className="h-8 min-w-48 flex-1 font-mono text-xs"
          // Dots without type=password, so no password manager offers to
          // save what a command asked for.
          style={
            hidden
              ? ({ WebkitTextSecurity: "disc" } as CSSProperties)
              : undefined
          }
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          data-form-type="other"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void send(false);
            }
          }}
        />
        <Button size="sm" disabled={sending} onClick={() => void send(false)}>
          {t("run.input.send")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={sending}
          title={t("run.input.endHint")}
          onClick={() => void send(true)}
        >
          {t("run.input.end")}
        </Button>
      </div>
      <p className="text-muted-foreground" data-input-hint>
        <span data-time-left>
          {t("run.input.left", { time: formatDuration(left) })}
        </span>
        {" · "}
        {hidden
          ? typed > 0 && typed < MIN_HIDDEN_CHARS
            ? t("run.input.hiddenShort")
            : t("run.input.hiddenHint")
          : t("run.input.echoHint")}
      </p>
    </div>
  );
}
