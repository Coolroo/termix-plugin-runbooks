/**
 * The ban on sleep in commands (1.4.10; the owner, 2026-11-19): a wait in a
 * command hides what the step waits for, and the person sees one long run.
 * Runbooks refuses a command that waits a fixed time, and points to the
 * `delay` item of a sequence, when a step is written: on create, add-steps,
 * update-step and amend, through the API and MCP. Steps already stored keep
 * running. An admin setting (banSleep, on by default) turns the ban off.
 * Values are checked too once filled in (filledSleep): at Run, and for a
 * value an earlier item of a sequence captured, before the item runs.
 *
 * What counts as a wait, so ordinary text does not:
 *
 * - `sleep` as a word, followed by a duration, a variable, a quote or a
 *   parenthesis: `sleep 5`, `/usr/bin/sleep 0.5`, `sleep "$DELAY"`,
 *   `sleep infinity`, `time.sleep(5)`, `bash -c 'sleep 5'`, `sleep -- 5`,
 *   `sleep${IFS}5`. Not part of a longer word (`sleeping`, `--no-sleep`,
 *   `usleep`) and not followed by other text (`sleep.target`, `echo "time
 *   to sleep now"`). The word is read as the shell reads it, with quotes
 *   and backslashes inside it removed: `s''leep 5`, `s\leep 5`, `"sl"eep 5`.
 * - `Start-Sleep` (PowerShell), with any arguments.
 * - `timeout /t <n>` (cmd). Not `timeout 30 curl ...`, which limits a
 *   command instead of waiting.
 * - `timeout <n>` around a command that never ends by itself (BUG-022 L6):
 *   `timeout 5 tail -f /dev/null`, `timeout 5 cat`, `timeout 5 read`,
 *   `timeout 5 yes`, a `-f` journalctl or docker logs, a ping with no count.
 * - `read -t <n>`: a read with a time limit, used as a delay.
 * - `ping -n <n>` or `ping -c <n>` to the host itself (127.0.0.1,
 *   localhost, ::1) or with its output thrown away (`>nul`, `> $null`,
 *   `>/dev/null`): the old delay. A ping that tests a network address is
 *   not a wait.
 *
 * The check reads the command as text, also inside quotes, so `bash -c
 * "sleep 5"` is refused; an `echo "sleep 5 more minutes"` is refused too,
 * a rare false positive that costs one reworded echo.
 */

import type { SequenceItem } from "../../shared/sequence.js";

/** The admin setting that turns the ban off when false. */
export const BAN_SLEEP_SETTING = "banSleep";

/**
 * A duration, a variable, a quote, a parenthesis or infinity after it,
 * past options and `--`; or a variable right after it (`sleep${IFS}5`).
 */
const SLEEP =
  /(?<![A-Za-z0-9_-])sleep(?:\$|\s+(?:--?[A-Za-z-]*\s+)*(?=["'$({\d.]|infinity\b)|\s*\()/i;
const START_SLEEP = /(?<![A-Za-z0-9_-])Start-Sleep(?![A-Za-z0-9_-])/i;
const TIMEOUT_T = /(?<![A-Za-z0-9_-])timeout(?:\.exe)?\s+\/t\b/i;
/** timeout with a duration, right before a command that never ends. */
const TIMEOUT_FOREVER =
  /(?<![A-Za-z0-9_-])timeout\s[^\n;&|]*?(?<![\w.-])[\d.]+[smhd]?\s+(?:\S*\/)?(?:tail\s[^\n;&|]*?(?:-[A-Za-z]*[fF]\b|--follow)|(?:journalctl|docker\s+(?:compose\s+)?logs)(?:\s[^\n;&|]*?)?\s(?:-f[A-Za-z]*\b|--follow)|cat\s*(?:$|[;&|)<]|\/dev\/(?:zero|u?random|stdin|tty)\b)|(?:read|yes|wait)(?![\w.-])|ping\b(?![^\n;&|]*?\s-[cnw]\s*\d))/im;
const READ_T =
  /(?<![A-Za-z0-9_.-])read\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*t\s*["'$\d]/;
const PING_N =
  /(?<![A-Za-z0-9_-])ping(?:\.exe)?\s[^\n;&|]*?-[nc]\s+\d+[^\n;&|]*/i;
const PING_SELF =
  /(?<![\w.:-])(?:127\.\d+\.\d+\.\d+|localhost|::1)(?![\w.:-])|>\s*(?:nul|\$null|\/dev\/null)\b/i;

/**
 * The command as the shell reads its words: quotes and backslashes inside
 * a word are gone, so `s''leep`, `s\leep` and `"sl"eep` read `sleep`.
 */
function shellWords(command: string): string {
  return command.replace(/\\(?=[A-Za-z])|['"]/g, "");
}

/** The wait a command holds, as the person wrote it, or null for none. */
export function findSleep(command: string): string | null {
  for (const text of [command, shellWords(command)]) {
    const sleep = SLEEP.exec(text);
    if (sleep) return clip(text, sleep.index, "sleep".length + 12);
  }
  const start = START_SLEEP.exec(command);
  if (start) return clip(command, start.index, "Start-Sleep".length + 12);
  const timeout = TIMEOUT_T.exec(command);
  if (timeout) return clip(command, timeout.index, timeout[0].length + 6);
  const forever = TIMEOUT_FOREVER.exec(command);
  if (forever) {
    return clip(command, forever.index, Math.min(forever[0].length, 40));
  }
  const read = READ_T.exec(command);
  if (read) return clip(command, read.index, read[0].length + 4);
  const ping = PING_N.exec(command);
  if (ping && PING_SELF.test(ping[0])) {
    return clip(command, ping.index, Math.min(ping[0].length, 40));
  }
  return null;
}

/** Up to `length` characters from `index`, on one line, trimmed. */
function clip(text: string, index: number, length: number): string {
  return text
    .slice(index, index + length)
    .split("\n")[0]
    .trim();
}

/**
 * Why a command is refused under the ban, or null. `field` names it as the
 * author wrote it: "command" or "sequence[2].command".
 */
export function sleepProblem(command: string, field: string): string | null {
  const found = findSleep(command);
  if (found === null) return null;
  return `${field} waits with "${found}": Runbooks does not run fixed waits in commands. Make the step a sequence and put a delay item where the wait was, such as {"type":"delay","seconds":30,"reason":"let the service start"}, with the commands before and after it as run items. To wait until something is ready (a loop with sleep), use a wait item, which runs a check command until its checks pass, such as {"type":"wait","command":"curl -fsS https://127.0.0.1:8443/health","checks":[{"type":"contains","text":"ok"}],"within":180,"every":5}`;
}

/**
 * A wait that values brought into a command (BUG-022 L6): the command as
 * written holds none, the command with its values does. Null for none, or
 * when the command as written waits already (a step stored before the ban,
 * or with the ban off, keeps running).
 */
export function filledSleep(written: string, filled: string): string | null {
  if (written === filled || findSleep(written) !== null) return null;
  const found = findSleep(filled);
  return found === null
    ? null
    : `a value filled into this command makes it wait with "${found}": Runbooks does not run fixed waits in commands; use a delay item`;
}

/** filledSleep for a sequence item's command (run, wait, job). */
export function itemFilledSleep(
  written: SequenceItem,
  filled: SequenceItem,
): string | null {
  if (
    (written.type === "run" ||
      written.type === "wait" ||
      written.type === "job") &&
    filled.type === written.type
  ) {
    return filledSleep(written.command, filled.command);
  }
  return null;
}
