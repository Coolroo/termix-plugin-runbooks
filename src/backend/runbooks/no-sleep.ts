/**
 * The ban on sleep in commands (1.4.10; the owner, 2026-11-19): a wait in a
 * command hides what the step waits for, and the person sees one long run.
 * Runbooks refuses a command that waits a fixed time, and points to the
 * `delay` item of a sequence, when a step is written: on create, add-steps,
 * update-step and amend, through the API and MCP. Steps already stored keep
 * running. An admin setting (banSleep, on by default) turns the ban off.
 *
 * What counts as a wait, so ordinary text does not:
 *
 * - `sleep` as a word, followed by a duration, a variable, a quote or a
 *   parenthesis: `sleep 5`, `/usr/bin/sleep 0.5`, `sleep "$DELAY"`,
 *   `sleep infinity`, `time.sleep(5)`, `bash -c 'sleep 5'`. Not part of a
 *   longer word (`sleeping`, `--no-sleep`, `usleep`) and not followed by
 *   other text (`sleep.target`, `echo "time to sleep now"`).
 * - `Start-Sleep` (PowerShell), with any arguments.
 * - `timeout /t <n>` (cmd). Not `timeout 30 curl ...`, which limits a
 *   command instead of waiting.
 * - `ping -n <n>` to the host itself (127.0.0.1, localhost, ::1) or with its
 *   output thrown away (`>nul`, `> $null`, `>/dev/null`): the old cmd
 *   delay. A ping that tests a network address is not a wait.
 *
 * The check reads the command as text, also inside quotes, so `bash -c
 * "sleep 5"` is refused; an `echo "sleep 5 more minutes"` is refused too,
 * a rare false positive that costs one reworded echo.
 */

/** The admin setting that turns the ban off when false. */
export const BAN_SLEEP_SETTING = "banSleep";

/** A duration, a variable, a quote, a parenthesis or infinity after it. */
const SLEEP =
  /(?<![A-Za-z0-9_-])sleep(?:\s+(?:-[A-Za-z]+\s+)*(?=["'$({\d.]|infinity\b)|\s*\()/i;
const START_SLEEP = /(?<![A-Za-z0-9_-])Start-Sleep(?![A-Za-z0-9_-])/i;
const TIMEOUT_T = /(?<![A-Za-z0-9_-])timeout(?:\.exe)?\s+\/t\b/i;
const PING_N = /(?<![A-Za-z0-9_-])ping(?:\.exe)?\s[^\n;&|]*?-n\s+\d+[^\n;&|]*/i;
const PING_SELF =
  /(?<![\w.:-])(?:127\.\d+\.\d+\.\d+|localhost|::1)(?![\w.:-])|>\s*(?:nul|\$null|\/dev\/null)\b/i;

/** The wait a command holds, as the person wrote it, or null for none. */
export function findSleep(command: string): string | null {
  const sleep = SLEEP.exec(command);
  if (sleep) return clip(command, sleep.index, "sleep".length + 12);
  const start = START_SLEEP.exec(command);
  if (start) return clip(command, start.index, "Start-Sleep".length + 12);
  const timeout = TIMEOUT_T.exec(command);
  if (timeout) return clip(command, timeout.index, timeout[0].length + 6);
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
  return `${field} waits with "${found}": Runbooks does not run fixed waits in commands. Make the step a sequence and put a delay item where the wait was, such as {"type":"delay","seconds":30,"reason":"let the service start"}, with the commands before and after it as run items`;
}
